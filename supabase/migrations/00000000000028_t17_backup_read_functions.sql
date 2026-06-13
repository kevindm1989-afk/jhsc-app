-- ===========================================================================
-- M8.A.3a / T17.1 — additional SECURITY DEFINER read functions for the
--                   T17 backup library.
--
--   M8.A.1 (#220) shipped the core write surface: extract_head_pointer,
--   count_rows_in_allowlist, write_manifest_pending,
--   transition_manifest_status, list_manifests_older_than_ms,
--   has_open_run_within_window.
--
--   M8.A.2 (#223) wired the SupabaseBackupStore TS adapter against
--   those RPCs, throwing `not_implemented_until_m8_a_3` for the read
--   methods that needed surface not yet shipped.
--
--   This migration ships those four read functions:
--     1. backup_get_current_kid                — active committee_data_key kid
--     2. backup_count_rows_by_event_type       — per-event-type histogram
--     3. backup_snapshot_retention_sweep_runs_ts — F-83 join anchor ts_ms
--     4. backup_read_manifest                  — single-row SELECT by run_id
--
--   The TS adapter follow-on (M8.A.3a-store) unblocks the
--   corresponding throws-on-call methods in SupabaseBackupStore.
--   `hardDeleteManifestRow` is NOT a new function — the existing
--   M8.A.1 `backup_transition_manifest_status(run_id, 'hard_deleted',
--   ts)` covers it (the row stays as a hard_deleted tombstone per
--   the M8.A.1 DELETE-revoked-from-every-role posture).
--
-- Authoritative ADRs: ADR-0018 §4 (T17 function set), §7 (manifest
--   field set); ADR-0007 (committee_data_keys); threat-model.md
--   §6 B6.1 (backup_writer_role).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. backup_get_current_kid
--
--    Returns the text-cast of the currently-active committee_data_key
--    key_id (rotated_at IS NULL). Empty chain (no active key) returns
--    NULL — the library translates to `kid_lookup_failed`.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_get_current_kid()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT k.key_id::text
    FROM public.committee_data_keys k
   WHERE k.rotated_at IS NULL
   ORDER BY k.epoch DESC
   LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.backup_get_current_kid()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backup_get_current_kid()
  TO backup_writer_role;

COMMENT ON FUNCTION public.backup_get_current_kid() IS
  'ADR-0018 §4 / T17.1 / M8.A.3a: returns the active committee_data_key.key_id (text). NULL on empty chain. STABLE. backup_writer_role only.';

-- ---------------------------------------------------------------------------
-- 2. backup_count_rows_by_event_type
--
--    Per-event-type histogram of public.audit_log at snapshot time.
--    Returns jsonb of `{event_type: count}`. G-T16-RECONCILE-CEILING:
--    NEVER aggregates to a synthetic key; one entry per event_type
--    present. Empty audit_log returns `{}`.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_count_rows_by_event_type()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT COALESCE(
    jsonb_object_agg(event_type, n),
    '{}'::jsonb
  )
  FROM (
    SELECT event_type, count(*)::bigint AS n
      FROM public.audit_log
     GROUP BY event_type
  ) g;
$$;

REVOKE EXECUTE ON FUNCTION public.backup_count_rows_by_event_type()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backup_count_rows_by_event_type()
  TO backup_writer_role;

COMMENT ON FUNCTION public.backup_count_rows_by_event_type() IS
  'ADR-0018 §7 / T17.1 / M8.A.3a: per-event-type histogram of audit_log. Returns jsonb {event_type: count}. STABLE. backup_writer_role only.';

-- ---------------------------------------------------------------------------
-- 3. backup_snapshot_retention_sweep_runs_ts
--
--    Returns the highest completed_at_ms in retention_sweep_runs at
--    observation time. F-83 join anchor: ALWAYS non-zero on a
--    committed manifest — if the table is empty, return 0 so the
--    manifest still has a valid bigint. The library treats 0 as "no
--    sweep recorded yet" and emits a structured log warning at the
--    next pass.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_snapshot_retention_sweep_runs_ts()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT COALESCE(MAX(completed_at_ms), 0::bigint)
    FROM public.retention_sweep_runs;
$$;

REVOKE EXECUTE ON FUNCTION public.backup_snapshot_retention_sweep_runs_ts()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backup_snapshot_retention_sweep_runs_ts()
  TO backup_writer_role;

COMMENT ON FUNCTION public.backup_snapshot_retention_sweep_runs_ts() IS
  'ADR-0018 §7 / T17.1 / M8.A.3a (F-83 join anchor): MAX(completed_at_ms) in retention_sweep_runs, or 0 if empty. STABLE. backup_writer_role only.';

-- ---------------------------------------------------------------------------
-- 4. backup_read_manifest
--
--    Returns one backup_manifests row by run_id. The library uses
--    this to confirm the manifest exists before transitioning it to
--    `hard_deleted` (F-74 cooperative-caller defense). Empty result
--    if not found — the library treats that as "row already gone."
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_read_manifest(
  p_run_id uuid,
  OUT run_id                              uuid,
  OUT manifest_status                     text,
  OUT started_at_ms                       bigint,
  OUT committed_at_ms                     bigint,
  OUT object_lock_until_ms                bigint,
  OUT hard_deleted_at_ms                  bigint,
  OUT object_ref                          text,
  OUT blob_sha256                         text,
  OUT blob_bytes                          bigint,
  OUT encryption_kid                      text,
  OUT audit_log_head_id                   bigint,
  OUT audit_log_head_ts_ms                bigint,
  OUT audit_log_head_hash                 bytea,
  OUT per_event_row_counts                jsonb,
  OUT per_table_row_counts                jsonb,
  OUT retention_sweep_runs_snapshot_ts_ms bigint,
  OUT schedule_hash                       text,
  OUT node_runtime_pin                    text
)
RETURNS record
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    m.run_id, m.manifest_status, m.started_at_ms, m.committed_at_ms,
    m.object_lock_until_ms, m.hard_deleted_at_ms, m.object_ref,
    m.blob_sha256, m.blob_bytes, m.encryption_kid,
    m.audit_log_head_id, m.audit_log_head_ts_ms, m.audit_log_head_hash,
    m.per_event_row_counts, m.per_table_row_counts,
    m.retention_sweep_runs_snapshot_ts_ms, m.schedule_hash,
    m.node_runtime_pin
  FROM public.backup_manifests m
  WHERE m.run_id = p_run_id;
$$;

REVOKE EXECUTE ON FUNCTION public.backup_read_manifest(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backup_read_manifest(uuid)
  TO backup_writer_role;

COMMENT ON FUNCTION public.backup_read_manifest(uuid) IS
  'ADR-0018 §7 / T17.1 / M8.A.3a: SELECT one backup_manifests row by run_id. Empty result if not found. STABLE. backup_writer_role only.';
