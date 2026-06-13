-- ===========================================================================
-- M8.A.3c (partial) / T17.1 — backup_dump_table_rows SECURITY DEFINER fn.
--
--   Ships the per-table jsonb dump surface the T17 backup library's
--   `dumpClosedAllowlist` consumes. Returns `jsonb_agg(row_to_json(t))`
--   for ONE allowlisted BACKUP_TABLES entry. The TS adapter
--   composes one call per table into the final blob.
--
--   Closed allowlist mirrors `backup_count_rows_in_allowlist` (the
--   migration 24 fn that ships the per-table COUNT surface): the same
--   10 tables, the same CASE WHEN gate. Unknown table -> 22023.
--
--   What this PR does NOT ship:
--     - Supabase Storage SDK methods (putWithObjectLock /
--       isObjectLocked / deleteObjectIfUnlocked) — those land when
--       the actual bucket is provisioned (M8.A.3c-storage).
--     - The TS `dumpClosedAllowlist` wire-up that composes per-table
--       calls into a BackupDumpSnapshot — lands alongside the bucket
--       wiring (it's most useful end-to-end with a real put path).
--
--   Two CRITICAL invariants the fn enforces:
--     1. Allowlist (F-19 / F-84): the CASE WHEN gate is the ONLY
--        path from a caller-supplied text to an actual SELECT. No
--        format()/dynamic-SQL/EXECUTE.
--     2. STABLE: the fn does not mutate state. Concurrent dumps see
--        a consistent snapshot per the caller's transaction boundary.
--
-- Authoritative ADRs: ADR-0018 §"BACKUP_TABLES allowlist" + §4 (T17
--   fn set), §7 (manifest field set); threat-model.md §6 B6.1
--   (backup_writer_role); F-19 closed-allowlist lineage.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.backup_dump_table_rows(p_table_name text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_rows jsonb;
BEGIN
  -- Closed CASE-WHEN gate. Adding a table to BACKUP_TABLES requires:
  --   (a) extending the TS const in apps/web/src/lib/backup/backup-tables.ts
  --   (b) extending this fn
  --   (c) extending the sibling backup_count_rows_in_allowlist arm
  --   (d) extending the pgTAP test below
  -- A drift gate (separate verify script) asserts all three SQL arms
  -- are byte-for-byte aligned with the TS const.
  CASE p_table_name
    WHEN 'audit_log' THEN
      SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb)
        INTO v_rows
        FROM public.audit_log t;
    WHEN 'audit_log_retention_schedule' THEN
      SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb)
        INTO v_rows
        FROM public.audit_log_retention_schedule t;
    WHEN 'concerns' THEN
      SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb)
        INTO v_rows
        FROM public.concerns t;
    WHEN 'identity_keys' THEN
      SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb)
        INTO v_rows
        FROM public.identity_keys t;
    WHEN 'recovery_blobs' THEN
      SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb)
        INTO v_rows
        FROM public.recovery_blobs t;
    WHEN 'recovery_blob_resets' THEN
      SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb)
        INTO v_rows
        FROM public.recovery_blob_resets t;
    WHEN 'reprisal_log' THEN
      SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb)
        INTO v_rows
        FROM public.reprisal_log t;
    WHEN 'retention_sweep_runs' THEN
      SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb)
        INTO v_rows
        FROM public.retention_sweep_runs t;
    WHEN 's51_evidence' THEN
      SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb)
        INTO v_rows
        FROM public.s51_evidence t;
    WHEN 'work_refusal' THEN
      SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb)
        INTO v_rows
        FROM public.work_refusal t;
    ELSE
      RAISE EXCEPTION 'p_table_name % is not on the closed BACKUP_TABLES allowlist',
        p_table_name USING ERRCODE = '22023';
  END CASE;
  RETURN v_rows;
END
$$;

REVOKE EXECUTE ON FUNCTION public.backup_dump_table_rows(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backup_dump_table_rows(text)
  TO backup_writer_role;

COMMENT ON FUNCTION public.backup_dump_table_rows(text) IS
  'ADR-0018 §4 / T17.1 / M8.A.3c (partial): returns jsonb_agg(row_to_json(t)) for one BACKUP_TABLES-allowlisted table. CASE-WHEN gate is the only caller-supplied-text -> SELECT path (no dynamic SQL). STABLE. backup_writer_role only.';
