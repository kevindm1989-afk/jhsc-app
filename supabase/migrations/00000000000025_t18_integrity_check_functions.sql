-- ===========================================================================
-- M8.B.1 / T18.1 — SECURITY DEFINER integrity-check functions
--
--   Ships the SECURITY DEFINER surface the T18 integrity-check library
--   (apps/web/src/lib/audit-integrity/) consumes from production.
--   Migration 25 of ADR-0019's sibling task spec. Each function is
--   owned by the migration role with EXECUTE granted ONLY to
--   integrity_check_role (B6.2 trust boundary; #215).
--
--   What this PR ships (5 of the 9 functions ADR-0019 §3 names):
--     - integrity_check_has_open_run_within_window — lease check
--     - integrity_check_record_run_started — INSERT runs row
--     - integrity_check_read_latest_backup_manifest — SELECT for
--       the RA-2 reconcile join
--     - integrity_check_list_sweep_runs_through — paged SELECT of
--       retention_sweep_runs through a cursor
--     - integrity_check_extract_chain_head — head of audit_log
--
--   Deferred to M8.B.2 (carry the ADR-0003 Amendment A six-mirror
--   enum-extension dance):
--     - integrity_check_walk_audit_chain_segment (needs prev_hash chain)
--     - integrity_check_read_chain_rows_by_ids (needs prev_hash chain)
--     - integrity_check_emit_run_and_mismatches (new audit event_types
--       audit.integrity_check.ran + audit.integrity_check.mismatch)
--     - integrity_check_emit_chain_anchor_weekly (audit.chain_anchor.weekly)
--
-- Authoritative ADRs: ADR-0019 (T18 integrity-check library +
--   MemoryIntegrityStore; §3 the function set). Threat-model.md §6
--   B6.2 (integrity_check_role).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. integrity_check_has_open_run_within_window
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.integrity_check_has_open_run_within_window(
  p_now_ms          bigint,
  p_lease_window_ms bigint
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.integrity_check_runs
     WHERE started_at_ms > p_now_ms - p_lease_window_ms
  );
$$;

REVOKE EXECUTE ON FUNCTION public.integrity_check_has_open_run_within_window(bigint, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integrity_check_has_open_run_within_window(bigint, bigint)
  TO integrity_check_role;

COMMENT ON FUNCTION public.integrity_check_has_open_run_within_window(bigint, bigint) IS
  'ADR-0019 §3 / T18.1 lease check — true if any integrity_check_runs row started in the window. STABLE. integrity_check_role only.';

-- ---------------------------------------------------------------------------
-- 2. integrity_check_record_run_started
--
--    INSERTs an integrity_check_runs row in status='running'. The
--    library calls this once per pass right after the lease check.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.integrity_check_record_run_started(
  p_run_id          uuid,
  p_trigger         text,
  p_started_at_ms   bigint,
  p_node_runtime_pin text,
  p_schedule_hash   text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  -- The CHECK on `trigger` is enforced by the table; redundant assert
  -- here lets the caller pre-flight before its bigger transaction.
  IF p_trigger NOT IN ('scheduled','post_rotation','post_export','weekly_anchor') THEN
    RAISE EXCEPTION 'p_trigger % is not on the closed set', p_trigger
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.integrity_check_runs (
    run_id, trigger, started_at_ms, status,
    node_runtime_pin, schedule_hash
  ) VALUES (
    p_run_id, p_trigger, p_started_at_ms, 'running',
    p_node_runtime_pin, p_schedule_hash
  );
END
$$;

REVOKE EXECUTE ON FUNCTION public.integrity_check_record_run_started(uuid, text, bigint, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integrity_check_record_run_started(uuid, text, bigint, text, text)
  TO integrity_check_role;

COMMENT ON FUNCTION public.integrity_check_record_run_started(uuid, text, bigint, text, text) IS
  'ADR-0019 §3 / T18.1: INSERTs an integrity_check_runs row in status=running. Closed-set trigger validation pre-flight. integrity_check_role only.';

-- ---------------------------------------------------------------------------
-- 3. integrity_check_read_latest_backup_manifest
--
--    Returns the latest committed backup_manifests row's
--    head-pointer triple + manifest_id, for the T18 reconcile join.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.integrity_check_read_latest_backup_manifest(
  OUT manifest_run_id           uuid,
  OUT manifest_committed_at_ms  bigint,
  OUT audit_log_head_id         bigint,
  OUT audit_log_head_ts_ms      bigint,
  OUT audit_log_head_hash       bytea
)
RETURNS record
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    m.run_id,
    m.committed_at_ms,
    m.audit_log_head_id,
    m.audit_log_head_ts_ms,
    m.audit_log_head_hash
  FROM public.backup_manifests m
  WHERE m.manifest_status = 'committed'
    AND m.committed_at_ms IS NOT NULL
  ORDER BY m.committed_at_ms DESC
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.integrity_check_read_latest_backup_manifest()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integrity_check_read_latest_backup_manifest()
  TO integrity_check_role;

COMMENT ON FUNCTION public.integrity_check_read_latest_backup_manifest() IS
  'ADR-0019 §3 / T18.1: returns the latest committed backup_manifests row''s head-pointer triple for the RA-2 reconcile join. STABLE. integrity_check_role only.';

-- ---------------------------------------------------------------------------
-- 4. integrity_check_list_sweep_runs_through
--
--    Returns retention_sweep_runs rows whose completed_at_ms is <=
--    p_through_ms, ordered by started_at_ms ASC. Used for the
--    "attributed divergence" join (G-T16-8).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.integrity_check_list_sweep_runs_through(
  p_through_ms bigint,
  p_max_rows   integer
)
RETURNS TABLE (
  run_id           uuid,
  started_at_ms    bigint,
  completed_at_ms  bigint,
  schedule_hash    text,
  per_event_counts jsonb,
  per_table_counts jsonb,
  status           text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT r.run_id, r.started_at_ms, r.completed_at_ms,
         r.schedule_hash, r.per_event_counts, r.per_table_counts, r.status
    FROM public.retention_sweep_runs r
   WHERE r.completed_at_ms <= p_through_ms
   ORDER BY r.started_at_ms
   LIMIT GREATEST(p_max_rows, 0);
$$;

REVOKE EXECUTE ON FUNCTION public.integrity_check_list_sweep_runs_through(bigint, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integrity_check_list_sweep_runs_through(bigint, integer)
  TO integrity_check_role;

COMMENT ON FUNCTION public.integrity_check_list_sweep_runs_through(bigint, integer) IS
  'ADR-0019 §3 / T18.1: paged SELECT of retention_sweep_runs through a completed-at cursor. STABLE. integrity_check_role only.';

-- ---------------------------------------------------------------------------
-- 5. integrity_check_extract_chain_head
--
--    Returns the live (id, ts_ms, hash) head of audit_log. The
--    library compares this against the manifest's head-pointer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.integrity_check_extract_chain_head(
  OUT head_id    bigint,
  OUT head_ts_ms bigint,
  OUT head_hash  bytea
)
RETURNS record
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    a.id,
    (extract(epoch from a.ts) * 1000)::bigint,
    digest(a.id::text || a.ts::text, 'sha256')
  FROM public.audit_log a
  ORDER BY a.id DESC
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.integrity_check_extract_chain_head()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integrity_check_extract_chain_head()
  TO integrity_check_role;

COMMENT ON FUNCTION public.integrity_check_extract_chain_head() IS
  'ADR-0019 §3 / T18.1: returns the live audit_log head (id, ts_ms, hash). The hash is a deterministic synthetic until the T18 prev_hash chain lands. STABLE. integrity_check_role only.';
