-- ===========================================================================
-- M6.3 / T16.1 — retention_sweep_runner orchestrator
--
--   Closes M6 by wiring an in-DB orchestrator on top of the M6.1 +
--   M6.1.B SECURITY DEFINER function set. The runner is what a pg_cron
--   job (or, in tests, a direct call) invokes for one nightly pass:
--
--     1. Acquire pg_try_advisory_xact_lock(hashtext('retention_sweep')).
--        Return NULL on contention so a second cron tick is a no-op
--        instead of a double-sweep. (G-T16-1)
--     2. SET LOCAL statement_timeout='60s', lock_timeout='5s' so the
--        pass cannot hold a row-level lock indefinitely against an
--        application writer. (G-T16-2)
--     3. Compute the schedule_hash over audit_log_retention_schedule.
--     4. For each INTERVAL retention_class: discover the distinct
--        event_types present in audit_log under that class, then call
--        retention_delete_for_event_type with cutoff = now_ms -
--        interval_ms.
--     5. Operational table (auth_totp_consumed_log, 24h): call
--        retention_delete_operational_table.
--     6. Ceiling rule (ADR-0015 §3.5): call retention_delete_for_ceiling
--        with cutoff = now_ms - 30d.
--     7. Emit + register via retention_emit_deleted_and_register_run.
--
--   The actual pg_cron `cron.schedule(...)` row is provisioned at
--   deploy time (it requires the `pg_cron` extension, which isn't
--   present in the bare-Postgres pgTAP CI image). The deploy script
--   pins it to '30 7 * * *' UTC = 03:30 ET DST-fold-aware.
--
-- Authoritative ADRs: ADR-0017 (T16 retention library); ADR-0015 +
--   Amendment I (per-event-type retention + §3.5 ceiling rule).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.retention_sweep_runner(
  p_now_ms           bigint,
  p_max_rows_per_arm integer
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_run_id            uuid := gen_random_uuid();
  v_started_at_ms     bigint := p_now_ms;
  v_completed_at_ms   bigint;
  v_class_row         record;
  v_event_row         record;
  v_cutoff_ms         bigint;
  v_deleted           integer;
  v_per_event_counts  jsonb := '{}'::jsonb;
  v_per_table_counts  jsonb := '{}'::jsonb;
  v_truncated         boolean := false;
  v_schedule_hash     text;
  v_status            text;
BEGIN
  IF p_max_rows_per_arm IS NULL OR p_max_rows_per_arm <= 0 THEN
    RAISE EXCEPTION 'p_max_rows_per_arm must be > 0' USING ERRCODE = '22023';
  END IF;
  IF p_now_ms IS NULL OR p_now_ms <= 0 THEN
    RAISE EXCEPTION 'p_now_ms must be > 0' USING ERRCODE = '22023';
  END IF;

  -- (1) Advisory lock — auto-released at transaction end. If another
  -- runner is mid-pass, this tick is a no-op. The library / cron treats
  -- NULL as "skipped; try next window."
  IF NOT pg_try_advisory_xact_lock(hashtext('retention_sweep')) THEN
    RETURN NULL;
  END IF;

  -- (2) Timeouts at session scope (SET LOCAL is bound to the implicit
  -- transaction wrapping the function call).
  SET LOCAL statement_timeout = '60s';
  SET LOCAL lock_timeout = '5s';

  -- (3) Schedule hash — deterministic over audit_log_retention_schedule
  -- rows. Adjacent runs with diverging hashes flag a schedule mutation
  -- between passes; the on-call surface treats that as a structured
  -- alert input (G-T16-4 adjacent).
  SELECT encode(
    digest(
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'retention_class', retention_class,
            'semantics', semantics,
            'interval_ms', interval_ms,
            'no_target_id', no_target_id
          )
          ORDER BY retention_class
        )::text,
        '[]'
      ),
      'sha256'
    ),
    'hex'
  )
  INTO v_schedule_hash
  FROM public.audit_log_retention_schedule;

  -- (4) Per-INTERVAL-class loop. For each retention_class with
  -- semantics='interval', the runner discovers every event_type that
  -- has rows under that class and delegates to the M6.1 arm function.
  -- 'match_underlying' and 'membership_relative' classes are handled
  -- elsewhere (step 6 / out-of-scope respectively).
  FOR v_class_row IN
    SELECT retention_class, interval_ms
      FROM public.audit_log_retention_schedule
     WHERE semantics = 'interval'
     ORDER BY retention_class
  LOOP
    v_cutoff_ms := p_now_ms - v_class_row.interval_ms;
    FOR v_event_row IN
      SELECT DISTINCT event_type
        FROM public.audit_log
       WHERE retention_class = v_class_row.retention_class
         AND ts < to_timestamp(v_cutoff_ms / 1000.0)
       ORDER BY event_type
    LOOP
      v_deleted := public.retention_delete_for_event_type(
        v_event_row.event_type, v_cutoff_ms, p_max_rows_per_arm
      );
      IF v_deleted > 0 THEN
        v_per_event_counts := v_per_event_counts
          || jsonb_build_object(v_event_row.event_type, v_deleted);
        IF v_deleted >= p_max_rows_per_arm THEN
          v_truncated := true;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  -- (5) Operational table — auth_totp_consumed_log, fixed 24h window.
  v_deleted := public.retention_delete_operational_table(
    'auth_totp_consumed_log',
    p_now_ms - (24::bigint * 60 * 60 * 1000),
    p_max_rows_per_arm
  );
  IF v_deleted > 0 THEN
    v_per_table_counts := v_per_table_counts
      || jsonb_build_object('auth_totp_consumed_log', v_deleted);
    IF v_deleted >= p_max_rows_per_arm THEN
      v_truncated := true;
    END IF;
  END IF;

  -- (6) Ceiling rule (ADR-0015 §3.5): audit rows whose underlying
  -- record was deleted ≥30d ago.
  v_deleted := public.retention_delete_for_ceiling(
    p_now_ms - (30::bigint * 24 * 60 * 60 * 1000),
    p_max_rows_per_arm
  );
  IF v_deleted > 0 THEN
    -- The synthetic key collects ceiling-rule deletes in the same
    -- per_event_counts jsonb as the per-event arms; the leading
    -- underscores keep it from colliding with any real event_type.
    v_per_event_counts := v_per_event_counts
      || jsonb_build_object('__match_underlying_ceiling__', v_deleted);
    IF v_deleted >= p_max_rows_per_arm THEN
      v_truncated := true;
    END IF;
  END IF;

  v_status := CASE WHEN v_truncated THEN 'capped' ELSE 'completed' END;
  v_completed_at_ms := (extract(epoch from clock_timestamp()) * 1000)::bigint;

  -- (7) Emit retention.deleted audit row + INSERT the checkpoint row.
  -- F-24 inversion: the audit row is LAST in the txn. If audit_emit
  -- throws, the whole pass rolls back; no half-state.
  PERFORM public.retention_emit_deleted_and_register_run(
    v_run_id,
    v_started_at_ms,
    v_completed_at_ms,
    v_schedule_hash,
    v_per_event_counts,
    v_per_table_counts,
    v_truncated,
    false,
    v_status
  );

  RETURN v_run_id;
END
$$;

REVOKE EXECUTE ON FUNCTION public.retention_sweep_runner(bigint, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retention_sweep_runner(bigint, integer)
  TO retention_service_role;

COMMENT ON FUNCTION public.retention_sweep_runner(bigint, integer) IS
  'ADR-0017 / M6 runner: orchestrates one retention pass. Acquires pg_try_advisory_xact_lock(hashtext(''retention_sweep'')); returns NULL on contention. SET LOCAL statement_timeout=60s, lock_timeout=5s. Iterates audit_log_retention_schedule INTERVAL arms, then auth_totp_consumed_log (24h), then the ADR-0015 §3.5 ceiling rule, then emits retention.deleted + registers the run. retention_service_role only.';
