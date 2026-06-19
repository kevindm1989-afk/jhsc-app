-- ===========================================================================
-- M6.1 / T16.1 — SECURITY DEFINER retention sweep functions
--
--   This migration ships the SECURITY DEFINER function set the
--   T16 retention sweep library (apps/web/src/lib/retention/)
--   consumes from production. Each function maps to one of the
--   methods on `RetentionStore`:
--
--     deleteForEventType        → retention_delete_for_event_type
--     deleteOperationalTable    → retention_delete_operational_table
--     countCandidatesPerEventType → retention_count_for_event_type
--     countCandidatesInOperationalTable → retention_count_in_operational_table
--     emitRetentionDeletedAndRegisterRun → retention_emit_deleted_and_register_run
--
--   Each function is SECURITY DEFINER + owned by the migration role,
--   with EXECUTE granted ONLY to retention_service_role. No
--   caller-supplied predicate / WHERE / pivot path; the only
--   parameters are typed values (event_type text, cutoff_ms bigint,
--   max_rows int, table_name text from a closed allowlist).
--
--   The library's `deleteForUnderlyingRecordCeiling` /
--   `countCandidatesForCeiling` rule (ADR-0015 §3.5) is DEFERRED to
--   M6.1.B — that rule requires per-event-type target-table mapping
--   which warrants its own design pass.
--
-- Authoritative ADRs: ADR-0017 (T16 retention library + Memory store);
--   ADR-0015 / Amendment I (per-event-type retention classes);
--   ADR-0016 (operational table retention).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. retention_delete_for_event_type
--
--    DELETE rows from audit_log where event_type = $1 AND ts is older
--    than cutoff_ms, up to max_rows. Returns the deleted count.
--
--    Implementation note: ts is timestamptz; cutoff is ms-epoch. The
--    convert at call boundary uses the `audit_log_ts_idx` btree index.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retention_delete_for_event_type(
  p_event_type text,
  p_cutoff_ms  bigint,
  p_max_rows   integer
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_deleted_count integer;
BEGIN
  IF p_max_rows IS NULL OR p_max_rows <= 0 THEN
    RAISE EXCEPTION 'p_max_rows must be > 0' USING ERRCODE = '22023';
  END IF;
  IF p_event_type IS NULL OR length(p_event_type) = 0 THEN
    RAISE EXCEPTION 'p_event_type must be non-empty' USING ERRCODE = '22023';
  END IF;

  WITH victims AS (
    SELECT id FROM public.audit_log
     WHERE event_type = p_event_type
       AND ts < to_timestamp(p_cutoff_ms / 1000.0)
     ORDER BY ts
     LIMIT p_max_rows
  ),
  deleted AS (
    DELETE FROM public.audit_log
     WHERE id IN (SELECT id FROM victims)
     RETURNING 1
  )
  SELECT count(*)::int INTO v_deleted_count FROM deleted;

  RETURN COALESCE(v_deleted_count, 0);
END
$$;

REVOKE EXECUTE ON FUNCTION public.retention_delete_for_event_type(text, bigint, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retention_delete_for_event_type(text, bigint, integer)
  TO retention_service_role;

COMMENT ON FUNCTION public.retention_delete_for_event_type(text, bigint, integer) IS
  'ADR-0017 §3 / library RetentionStore.deleteForEventType: DELETE up to max_rows from audit_log where event_type = $1 AND ts < to_timestamp($2/1000). No caller-supplied predicate. retention_service_role only.';

-- ---------------------------------------------------------------------------
-- 2. retention_count_for_event_type
--
--    Count candidates the corresponding delete would target. The library
--    runs this BEFORE the delete pass (F-57 over-delete alarm).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retention_count_for_event_type(
  p_event_type text,
  p_cutoff_ms  bigint
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT count(*)::bigint
    FROM public.audit_log
   WHERE event_type = p_event_type
     AND ts < to_timestamp(p_cutoff_ms / 1000.0);
$$;

REVOKE EXECUTE ON FUNCTION public.retention_count_for_event_type(text, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retention_count_for_event_type(text, bigint)
  TO retention_service_role;

COMMENT ON FUNCTION public.retention_count_for_event_type(text, bigint) IS
  'ADR-0017 §3 / library countCandidatesPerEventType: count the audit_log rows the same-shape delete would target. STABLE. retention_service_role only.';

-- ---------------------------------------------------------------------------
-- 3. retention_delete_operational_table
--
--    DELETE rows from an operational table older than cutoff_ms.
--    The table name is validated against a closed allowlist; only
--    the named entries in OPERATIONAL_TABLE_SCHEDULE are accepted.
--    Each branch hard-codes the ts column for that table.
--
--    Current allowlist (mirror apps/web/src/lib/retention/schedule.ts):
--      - auth_totp_consumed_log (ts column: consumed_at)
--
--    Adding a new operational table requires:
--      (a) adding a row to apps/web/src/lib/retention/schedule.ts
--      (b) adding a WHEN branch here AND
--      (c) extending the pgTAP test
--    All three mirror; CI drift catches a missing mirror.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retention_delete_operational_table(
  p_table_name text,
  p_cutoff_ms  bigint,
  p_max_rows   integer
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_deleted_count integer;
BEGIN
  IF p_max_rows IS NULL OR p_max_rows <= 0 THEN
    RAISE EXCEPTION 'p_max_rows must be > 0' USING ERRCODE = '22023';
  END IF;

  CASE p_table_name
    WHEN 'auth_totp_consumed_log' THEN
      WITH victims AS (
        SELECT id FROM public.auth_totp_consumed_log
         WHERE consumed_at < to_timestamp(p_cutoff_ms / 1000.0)
         ORDER BY consumed_at
         LIMIT p_max_rows
      ),
      deleted AS (
        DELETE FROM public.auth_totp_consumed_log
         WHERE id IN (SELECT id FROM victims)
         RETURNING 1
      )
      SELECT count(*)::int INTO v_deleted_count FROM deleted;
    ELSE
      RAISE EXCEPTION 'p_table_name % is not in the closed allowlist', p_table_name
        USING ERRCODE = '22023';
  END CASE;

  RETURN COALESCE(v_deleted_count, 0);
END
$$;

REVOKE EXECUTE ON FUNCTION public.retention_delete_operational_table(text, bigint, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retention_delete_operational_table(text, bigint, integer)
  TO retention_service_role;

COMMENT ON FUNCTION public.retention_delete_operational_table(text, bigint, integer) IS
  'ADR-0016 / library deleteOperationalTable: DELETE up to max_rows from a closed allowlist of operational tables. Each branch hard-codes the ts column. retention_service_role only.';

-- ---------------------------------------------------------------------------
-- 4. retention_count_in_operational_table
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retention_count_in_operational_table(
  p_table_name text,
  p_cutoff_ms  bigint
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_count bigint;
BEGIN
  CASE p_table_name
    WHEN 'auth_totp_consumed_log' THEN
      SELECT count(*)::bigint INTO v_count
        FROM public.auth_totp_consumed_log
       WHERE consumed_at < to_timestamp(p_cutoff_ms / 1000.0);
    ELSE
      RAISE EXCEPTION 'p_table_name % is not in the closed allowlist', p_table_name
        USING ERRCODE = '22023';
  END CASE;
  RETURN COALESCE(v_count, 0);
END
$$;

REVOKE EXECUTE ON FUNCTION public.retention_count_in_operational_table(text, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retention_count_in_operational_table(text, bigint)
  TO retention_service_role;

COMMENT ON FUNCTION public.retention_count_in_operational_table(text, bigint) IS
  'ADR-0016 / library countCandidatesInOperationalTable: count rows in a closed-allowlist table older than cutoff_ms. STABLE. retention_service_role only.';

-- ---------------------------------------------------------------------------
-- 5. retention_emit_deleted_and_register_run
--
--    Write two rows in one transaction:
--      (a) INSERT a row into retention_sweep_runs (the checkpoint).
--      (b) PERFORM audit_emit('retention.deleted', ...) — LAST in tx
--          per F-24 inversion; if either INSERT or audit_emit fails,
--          the whole transaction rolls back and the library treats
--          the pass as aborted.
--
--    Inputs are typed (no jsonb-as-payload). All counts come from the
--    library after the deletes complete; this function does not itself
--    delete anything.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retention_emit_deleted_and_register_run(
  p_run_id               uuid,
  p_started_at_ms        bigint,
  p_completed_at_ms      bigint,
  p_schedule_hash        text,
  p_per_event_counts     jsonb,
  p_per_table_counts     jsonb,
  p_truncated_to_row_cap boolean,
  p_alarm_fired          boolean,
  p_status               text
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_audit_id bigint;
  v_actor_pseudonym varchar(16);
BEGIN
  IF p_status NOT IN ('completed', 'capped') THEN
    RAISE EXCEPTION 'p_status must be completed | capped' USING ERRCODE = '22023';
  END IF;

  -- Checkpoint row FIRST. If this throws (e.g., duplicate run_id),
  -- nothing has been written.
  INSERT INTO public.retention_sweep_runs (
    run_id, started_at_ms, completed_at_ms, schedule_hash,
    per_event_counts, per_table_counts,
    truncated_to_row_cap, alarm_fired, status
  )
  VALUES (
    p_run_id, p_started_at_ms, p_completed_at_ms, p_schedule_hash,
    p_per_event_counts, p_per_table_counts,
    p_truncated_to_row_cap, p_alarm_fired, p_status
  );

  -- Synthetic actor pseudonym for the system sweep. Mirrors the
  -- mint_emit_revoked_during_mint pattern from migration 17:
  -- HMAC(constant, app.hmac_pseudonym_key) — 16 hex chars.
  v_actor_pseudonym := LEFT(
    encode(
      hmac('system:retention'::bytea,
           private._hmac_pseudonym_key()::bytea,
           'sha256'),
      'hex'
    ),
    16
  );

  -- Audit row LAST in the transaction. F-24 inversion:
  -- the retention.deleted row is the durable trace that the pass ran.
  -- target_id is NULL (per ADR-0015 Amendment I and schedule.ts
  -- `no_target_id: true`), so audit_emit's ceiling-rewrite leaves
  -- retention_class as '7y'.
  SELECT public.audit_emit(
    p_event_type      => 'retention.deleted',
    p_actor_pseudonym => v_actor_pseudonym,
    p_target_class    => 'C0',
    p_severity        => 'info',
    p_request_id      => NULL,
    p_target_id       => NULL,
    p_rotation_id     => NULL,
    p_meta            => jsonb_build_object(
      'run_id', p_run_id::text,
      'started_at_ms', p_started_at_ms,
      'completed_at_ms', p_completed_at_ms,
      'schedule_hash', p_schedule_hash,
      'per_event_counts', p_per_event_counts,
      'per_table_counts', p_per_table_counts,
      'truncated_to_row_cap', p_truncated_to_row_cap,
      'alarm_fired', p_alarm_fired,
      'status', p_status
    )
  ) INTO v_audit_id;

  RETURN v_audit_id;
END
$$;

REVOKE EXECUTE ON FUNCTION public.retention_emit_deleted_and_register_run(
  uuid, bigint, bigint, text, jsonb, jsonb, boolean, boolean, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retention_emit_deleted_and_register_run(
  uuid, bigint, bigint, text, jsonb, jsonb, boolean, boolean, text
) TO retention_service_role;

COMMENT ON FUNCTION public.retention_emit_deleted_and_register_run(
  uuid, bigint, bigint, text, jsonb, jsonb, boolean, boolean, text
) IS
  'ADR-0017 §3 / library emitRetentionDeletedAndRegisterRun: atomic checkpoint + retention.deleted audit row. F-24 inversion (audit LAST in tx). target_id NULL → no_target_id carve-out → retention_class stays at 7y. retention_service_role only.';
