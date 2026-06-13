-- ===========================================================================
-- M8.B.3 / T18.1 — integrity_check_runner orchestrator
--
--   Closes the bulk of M8.B by wiring an in-DB orchestrator on top
--   of the M8.B.1 + M8.B.2 SECURITY DEFINER function set. The runner
--   is what a pg_cron job (or, in tests, a direct call) invokes for
--   one pass:
--
--     1. pg_try_advisory_xact_lock(hashtext('integrity_check')).
--        Return NULL on contention so a duplicate cron tick is a
--        no-op instead of a double-check pass.
--     2. SET LOCAL statement_timeout='60s', lock_timeout='5s'.
--     3. Lease check: integrity_check_has_open_run_within_window —
--        if a recent pass sits in the window, skip this tick.
--     4. record_run_started writes a 'running' row.
--     5. extract_chain_head        → live (head_id, head_ts_ms, head_hash)
--     6. read_latest_backup_manifest → manifest head triple
--     7. Compare. Mismatch kinds emitted:
--          - head_pointer_drift   if live head_hash != manifest hash
--          - row_unexpected       if manifest head_id > live head_id
--            (manifest points past the live chain — bad)
--          - row_missing          if live head_id > manifest head_id
--            AND no retention_sweep_run completed between manifest's
--            committed_at_ms and live head ts (unattributable gap)
--          - hash_mismatch reserved for the prev_hash chain when it
--            lands; not emitted by THIS runner.
--     8. emit_run_and_mismatches finalizes the run row + emits
--        audit.integrity_check.ran + per-mismatch audit rows.
--
--   The actual pg_cron schedule pin is provisioned at deploy time
--   (pg_cron isn't present in the bare-Postgres pgTAP CI image). The
--   deploy pins it to '30 8 * * *' UTC = 04:30 ET (ADR-0019 §3
--   "scheduled daily integrity check").
--
-- Authoritative ADRs: ADR-0019 §3 (T18 function set + scheduled
--   trigger), ADR-0018 §7 (manifest head-pointer surface),
--   threat-model.md §6 B6.2 (integrity_check_role).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.integrity_check_runner(
  p_trigger           text,
  p_now_ms            bigint,
  p_lease_window_ms   bigint,
  p_node_runtime_pin  text,
  p_schedule_hash     text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_run_id              uuid := gen_random_uuid();
  v_completed_at_ms     bigint;
  v_status              text;
  v_live_head           record;
  v_manifest_head       record;
  v_mismatches          jsonb := '[]'::jsonb;
  v_attributable        bigint := 0;
  v_unattributable      bigint := 0;
  v_backup_diff_done    boolean := false;
  v_attribution_run_id  uuid;
BEGIN
  -- Mirror the M8.B.1 record_run_started closed-set trigger validation
  -- here so the runner aborts cleanly BEFORE acquiring the lock if the
  -- caller passes a bad trigger.
  IF p_trigger NOT IN ('scheduled','post_rotation','post_export','weekly_anchor') THEN
    RAISE EXCEPTION 'p_trigger % is not on the closed set', p_trigger
      USING ERRCODE = '22023';
  END IF;
  IF p_now_ms IS NULL OR p_now_ms <= 0 THEN
    RAISE EXCEPTION 'p_now_ms must be > 0' USING ERRCODE = '22023';
  END IF;
  IF p_lease_window_ms IS NULL OR p_lease_window_ms < 0 THEN
    RAISE EXCEPTION 'p_lease_window_ms must be >= 0' USING ERRCODE = '22023';
  END IF;

  -- (1) Advisory xact lock; auto-released at txn end. NULL signals
  -- "another runner mid-pass — skipped."
  IF NOT pg_try_advisory_xact_lock(hashtext('integrity_check')) THEN
    RETURN NULL;
  END IF;

  -- (2) Timeouts at session scope.
  SET LOCAL statement_timeout = '60s';
  SET LOCAL lock_timeout = '5s';

  -- (3) Lease check.
  IF public.integrity_check_has_open_run_within_window(p_now_ms, p_lease_window_ms) THEN
    RETURN NULL;
  END IF;

  -- (4) Record the run as 'running'.
  PERFORM public.integrity_check_record_run_started(
    v_run_id, p_trigger, p_now_ms, p_node_runtime_pin, p_schedule_hash
  );

  -- (5) Live head + (6) manifest head — both queries are tolerant of
  -- empty chains / no committed manifest (both can return NULL fields).
  SELECT * INTO v_live_head FROM public.integrity_check_extract_chain_head();
  SELECT * INTO v_manifest_head FROM public.integrity_check_read_latest_backup_manifest();
  v_backup_diff_done := (v_manifest_head.audit_log_head_id IS NOT NULL);

  -- (7) Build the mismatch list. The arithmetic is deliberately
  -- conservative — only emit a mismatch when the comparison can be
  -- made unambiguously.
  IF v_manifest_head.audit_log_head_id IS NOT NULL
     AND v_live_head.head_id IS NOT NULL THEN
    -- (a) Manifest points past live chain — bad.
    IF v_manifest_head.audit_log_head_id > v_live_head.head_id THEN
      v_mismatches := v_mismatches || jsonb_build_array(
        jsonb_build_object(
          'audit_log_id', v_manifest_head.audit_log_head_id,
          'mismatch_kind', 'row_unexpected',
          'attributable', false
        )
      );
      v_unattributable := v_unattributable + 1;
    ELSIF v_live_head.head_id > v_manifest_head.audit_log_head_id THEN
      -- (b) Live is ahead — try to attribute the delta to a retention
      -- sweep that ran between the manifest's snapshot and live now.
      v_attribution_run_id := NULL;
      SELECT run_id INTO v_attribution_run_id
        FROM public.integrity_check_list_sweep_runs_through(p_now_ms, 1)
       LIMIT 1;
      IF v_attribution_run_id IS NOT NULL THEN
        v_attributable := v_attributable + 1;
        v_mismatches := v_mismatches || jsonb_build_array(
          jsonb_build_object(
            'audit_log_id', v_live_head.head_id,
            'mismatch_kind', 'row_missing',
            'attributable', true,
            'attribution_run_id', v_attribution_run_id::text
          )
        );
      ELSE
        v_unattributable := v_unattributable + 1;
        v_mismatches := v_mismatches || jsonb_build_array(
          jsonb_build_object(
            'audit_log_id', v_live_head.head_id,
            'mismatch_kind', 'row_missing',
            'attributable', false
          )
        );
      END IF;
    -- (c) head_id matches; compare hashes.
    ELSIF v_live_head.head_hash IS DISTINCT FROM v_manifest_head.audit_log_head_hash THEN
      v_unattributable := v_unattributable + 1;
      v_mismatches := v_mismatches || jsonb_build_array(
        jsonb_build_object(
          'audit_log_id', v_live_head.head_id,
          'mismatch_kind', 'head_pointer_drift',
          'attributable', false
        )
      );
    END IF;
  END IF;

  -- Derive status. If no manifest yet (first pass before any backup
  -- runs), status='ok' (nothing to diff against).
  v_status := CASE
    WHEN jsonb_array_length(v_mismatches) > 0 THEN 'mismatch_found'
    ELSE 'ok'
  END;
  v_completed_at_ms := (extract(epoch from clock_timestamp()) * 1000)::bigint;

  -- (8) Finalize the run row + emit audit.integrity_check.ran +
  -- per-mismatch rows.
  PERFORM public.integrity_check_emit_run_and_mismatches(
    v_run_id,
    v_completed_at_ms,
    v_status,
    1::bigint, -- rows_walked: today the runner only inspects the head,
               -- so it walked one row. The prev_hash chain landing
               -- will replace this with the chain-segment length.
    v_attributable,
    v_unattributable,
    v_backup_diff_done,
    NULL::bigint, -- resume_after_id: not used today (no batch ceiling)
    v_mismatches
  );

  RETURN v_run_id;
END
$$;

REVOKE EXECUTE ON FUNCTION public.integrity_check_runner(text, bigint, bigint, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integrity_check_runner(text, bigint, bigint, text, text)
  TO integrity_check_role;

COMMENT ON FUNCTION public.integrity_check_runner(text, bigint, bigint, text, text) IS
  'ADR-0019 §3 / M8.B.3: orchestrates one integrity-check pass. Acquires pg_try_advisory_xact_lock(hashtext(''integrity_check'')); returns NULL on contention or lease-window hit. SET LOCAL statement_timeout=60s, lock_timeout=5s. Reconciles live audit head against the latest committed backup_manifests head; emits audit.integrity_check.ran + per-mismatch rows via emit_run_and_mismatches. integrity_check_role only.';
