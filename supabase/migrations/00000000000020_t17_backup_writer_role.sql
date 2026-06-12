-- ===========================================================================
-- M8.A / T17.1 — backup_writer_role + backup_manifests scaffolding
--
--   This migration is the SECURITY SCAFFOLD for T17.1 (the production
--   wire-up of the backup pipeline whose library already exists in
--   apps/web/src/lib/backup/). It does NOT yet implement the
--   SECURITY DEFINER backup functions (those land in T17.1's
--   subsequent PRs). What it ships now:
--
--     1. Role `backup_writer_role` (NOLOGIN, B6.1 trust boundary —
--        the non-login role with EXECUTE on the SECURITY DEFINER
--        backup functions and explicit SELECT on the BACKUP_TABLES
--        allowlist).
--     2. Table `backup_manifests` — one row per pg_dump pass. The
--        T18 integrity-check pass reads this table for the reconcile
--        join against the live audit chain.
--     3. REVOKE-everything-GRANT-narrow pattern on `backup_manifests`
--        (only backup_writer_role can INSERT/UPDATE; authenticated
--        can SELECT for the on-call surface).
--     4. State machine CHECK on `manifest_status`: 'pending' ->
--        'committed' / 'aborted'; 'committed' -> 'hard_deleted'.
--
--   What this migration does NOT do (deferred to T17.1+):
--     - The SECURITY DEFINER backup function set (backup_extract_head_pointer,
--       backup_dump_closed_allowlist, backup_write_manifest_pending,
--       backup_transition_manifest_status, backup_emit_manifest_written,
--       backup_has_open_run_within_window, deleteObjectIfUnlocked).
--     - The `backups-ca-central-1` Supabase Storage bucket with
--       object-lock policy.
--     - pg_cron daily 03:00 ET schedule kicking the backup pass.
--     - SupabaseBackupStore implementing the library's BackupStore
--       interface against this table.
--
-- Authoritative ADRs: ADR-0018 (T17 backup object-lock library +
--   MemoryBackupStore), ADR-0012 (backup strategy + crypto-shred-on-
--   retention). Threat-model.md §6 (B6.1 trust boundary added at
--   T17.1; this migration creates the role).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. backup_writer_role (B6.1 boundary)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_writer_role') THEN
    CREATE ROLE backup_writer_role NOLOGIN;
  END IF;
END $$;

COMMENT ON ROLE backup_writer_role IS
  'ADR-0018 / T17.1 / B6.1 trust boundary: NOLOGIN sibling of retention_service_role (B6), c4_read_service, mint_writer, deploy_reader_role. Holds EXECUTE on the SECURITY DEFINER backup functions + explicit SELECT on the BACKUP_TABLES allowlist for the dump function. NO BYPASSRLS, no caller-supplied predicate path. Reached via a pg_cron-bound service connection at 03:00 ET daily.';

-- ---------------------------------------------------------------------------
-- 2. backup_manifests — one row per pg_dump pass
--
--    F-80: NO pseudonyms in this table.
--    NO target_ids of PI records (head-pointer id is an audit_log row
--    id, which is structural metadata, not a PI target).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backup_manifests (
  run_id                          uuid PRIMARY KEY,
  started_at_ms                   bigint NOT NULL,
  committed_at_ms                 bigint,
  -- The pg_dump artifact reference inside the backups-ca-central-1
  -- bucket. Library-derived (backupObjectRefFor(manifest)); never
  -- caller-supplied.
  object_ref                      text NOT NULL,
  -- SHA-256 of the dump blob bytes (hex, 64 chars).
  blob_sha256                     text NOT NULL CHECK (blob_sha256 ~ '^[0-9a-f]{64}$'),
  blob_bytes                      bigint NOT NULL CHECK (blob_bytes >= 0),
  -- The committee_data_key kid used to encrypt the blob.
  encryption_kid                  text NOT NULL,
  -- ADR-0018 §7 manifest field set (consumed by T18 integrity check).
  audit_log_head_id               bigint NOT NULL,
  audit_log_head_ts_ms            bigint NOT NULL,
  audit_log_head_hash             bytea NOT NULL,
  per_event_row_counts            jsonb NOT NULL DEFAULT '{}'::jsonb,
  per_table_row_counts            jsonb NOT NULL DEFAULT '{}'::jsonb,
  retention_sweep_runs_snapshot_ts_ms bigint NOT NULL,
  schedule_hash                   text NOT NULL,
  node_runtime_pin                text NOT NULL,
  -- State machine: pending -> committed | aborted; committed -> hard_deleted.
  manifest_status                 text NOT NULL DEFAULT 'pending'
                                  CHECK (manifest_status IN
                                    ('pending','committed','aborted','hard_deleted')),
  -- Object-lock expiry (42 days after committed_at_ms per ADR-0018 §6).
  object_lock_until_ms            bigint,
  hard_deleted_at_ms              bigint,
  created_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backup_manifests_started_at_ms_idx
  ON public.backup_manifests (started_at_ms DESC);
CREATE INDEX IF NOT EXISTS backup_manifests_status_idx
  ON public.backup_manifests (manifest_status);

COMMENT ON TABLE public.backup_manifests IS
  'ADR-0018 §7: one row per pg_dump pass. F-80: NO pseudonyms, NO target_ids of PI records. The T18 integrity-check pass reads this table for the reconcile join against the live audit chain.';

REVOKE INSERT, UPDATE, DELETE ON public.backup_manifests FROM PUBLIC;
GRANT INSERT, UPDATE, SELECT ON public.backup_manifests TO backup_writer_role;
-- T18 integrity-check role (B6.2) will get SELECT in migration 21.
-- Operators / co-chairs may SELECT for the on-call backup-health surface.
GRANT SELECT ON public.backup_manifests TO authenticated;

ALTER TABLE public.backup_manifests ENABLE ROW LEVEL SECURITY;
CREATE POLICY backup_manifests_select_all
  ON public.backup_manifests
  FOR SELECT TO authenticated, backup_writer_role
  USING (true);
CREATE POLICY backup_manifests_insert_writer_only
  ON public.backup_manifests
  FOR INSERT TO backup_writer_role
  WITH CHECK (true);
CREATE POLICY backup_manifests_update_writer_only
  ON public.backup_manifests
  FOR UPDATE TO backup_writer_role
  USING (true)
  WITH CHECK (true);

-- DELETE on backup_manifests is REVOKED from every role — the rows
-- are retained 7y per ADR-0018 §"Classification per surface" (mirrors
-- retention.deleted + the backup.manifest_written audit row). Aging
-- out happens through the audit-log retention pass via the
-- match_underlying ceiling rule when applicable.
DO $$
DECLARE v_role text;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_roles
     WHERE rolname IN ('service_role','audit_writer_role','c4_read_service',
                       'mint_writer','authenticator','authenticated','anon',
                       'retention_service_role','backup_writer_role')
  LOOP
    EXECUTE format('REVOKE DELETE ON public.backup_manifests FROM %I', v_role);
  END LOOP;
END $$;
