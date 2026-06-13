-- ===========================================================================
-- M8.A.1 / T17.1 — SECURITY DEFINER backup pipeline functions
--
--   Ships the SECURITY DEFINER surface the T17 backup library
--   (apps/web/src/lib/backup/) consumes from production. Each
--   function is owned by the migration role with EXECUTE granted
--   ONLY to backup_writer_role (B6.1 trust boundary; #214).
--
--   This is migration 24 of ADR-0018's sibling task spec; the
--   backups-ca-central-1 Supabase Storage bucket with object-lock
--   policy + pg_cron 03:00 ET daily schedule + the actual pg_dump
--   binary execution are all ABOVE this layer (in the wrapper or
--   the bucket policy). These functions are pure database surface.
--
--   Audit emission (backup.manifest_written / backup.hard_deleted)
--   is deferred to M8.A.2 — it carries the ADR-0003 Amendment A
--   six-mirror enum-extension dance (schedule.ts library const +
--   retention_class_for + audit-log.md + check-audit-enum-coverage.sh
--   EXPECTED_ENUM + ADR + pgTAP).
--
-- Authoritative ADRs: ADR-0018 (T17 backup library + MemoryBackupStore;
--   §4 the function set this migration ships); ADR-0012 + amendments
--   (backup strategy). Threat-model.md §6 B6.1 (backup_writer_role).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. backup_extract_head_pointer
--
--    Returns the (id, ts_ms, hash) triple for the latest audit_log
--    row at snapshot time. The T18 integrity-check pass reads this
--    field from the manifest to drive the RA-2 reconciliation join.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_extract_head_pointer(
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
    -- The prev_hash chain is owned by T18; until that lands, use a
    -- deterministic synthetic hash so the manifest still has a
    -- non-null pointer T18 can reconcile against.
    digest(a.id::text || a.ts::text, 'sha256')
  FROM public.audit_log a
  ORDER BY a.id DESC
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.backup_extract_head_pointer()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backup_extract_head_pointer()
  TO backup_writer_role;

COMMENT ON FUNCTION public.backup_extract_head_pointer() IS
  'ADR-0018 Sec4 / T17.1: returns the (id, ts_ms, hash) triple for the latest audit_log row at snapshot time. STABLE. backup_writer_role only.';

-- ---------------------------------------------------------------------------
-- 2. backup_count_rows_in_allowlist
--
--    Validates each table in p_tables against the closed
--    BACKUP_TABLES allowlist + returns per-table row counts. The
--    library packs these into the manifest's per_event_row_counts /
--    per_table_row_counts. Unknown table names raise 22023.
--
--    Closed allowlist mirrors apps/web/src/lib/backup/backup-tables.ts
--    BACKUP_TABLES — only entries whose underlying table currently
--    exists in this schema are accepted. As new BACKUP_TABLES land
--    (with their migrations) the corresponding WHEN branch is
--    added in a sibling migration.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_count_rows_in_allowlist(
  p_tables text[]
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_result jsonb := '{}'::jsonb;
  v_table  text;
  v_count  bigint;
BEGIN
  IF p_tables IS NULL OR array_length(p_tables, 1) IS NULL THEN
    RETURN v_result;
  END IF;

  FOREACH v_table IN ARRAY p_tables LOOP
    CASE v_table
      WHEN 'audit_log' THEN
        SELECT count(*) INTO v_count FROM public.audit_log;
      WHEN 'audit_log_retention_schedule' THEN
        SELECT count(*) INTO v_count FROM public.audit_log_retention_schedule;
      WHEN 'concerns' THEN
        SELECT count(*) INTO v_count FROM public.concerns;
      WHEN 'identity_keys' THEN
        SELECT count(*) INTO v_count FROM public.identity_keys;
      WHEN 'recovery_blobs' THEN
        SELECT count(*) INTO v_count FROM public.recovery_blobs;
      WHEN 'recovery_blob_resets' THEN
        SELECT count(*) INTO v_count FROM public.recovery_blob_resets;
      WHEN 'reprisal_log' THEN
        SELECT count(*) INTO v_count FROM public.reprisal_log;
      WHEN 'retention_sweep_runs' THEN
        SELECT count(*) INTO v_count FROM public.retention_sweep_runs;
      WHEN 's51_evidence' THEN
        SELECT count(*) INTO v_count FROM public.s51_evidence;
      WHEN 'work_refusal' THEN
        SELECT count(*) INTO v_count FROM public.work_refusal;
      ELSE
        RAISE EXCEPTION 'p_tables contains % which is not on the closed BACKUP_TABLES allowlist', v_table
          USING ERRCODE = '22023';
    END CASE;
    v_result := v_result || jsonb_build_object(v_table, v_count);
  END LOOP;

  RETURN v_result;
END
$$;

REVOKE EXECUTE ON FUNCTION public.backup_count_rows_in_allowlist(text[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backup_count_rows_in_allowlist(text[])
  TO backup_writer_role;

COMMENT ON FUNCTION public.backup_count_rows_in_allowlist(text[]) IS
  'ADR-0018 Sec4 / T17.1: validates p_tables against the closed BACKUP_TABLES allowlist + returns per-table row counts as jsonb. Unknown table names raise 22023. STABLE. backup_writer_role only.';

-- ---------------------------------------------------------------------------
-- 3. backup_write_manifest_pending
--
--    INSERTs a row into backup_manifests with manifest_status='pending'.
--    The wrapper later flips status to 'committed' (object-lock put
--    succeeded) or 'aborted'. The lock-until ms is computed at the
--    transition step (committed_at_ms + 42 days per ADR-0018 Sec6).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_write_manifest_pending(
  p_run_id                              uuid,
  p_started_at_ms                       bigint,
  p_object_ref                          text,
  p_blob_sha256                         text,
  p_blob_bytes                          bigint,
  p_encryption_kid                      text,
  p_audit_log_head_id                   bigint,
  p_audit_log_head_ts_ms                bigint,
  p_audit_log_head_hash                 bytea,
  p_per_event_row_counts                jsonb,
  p_per_table_row_counts                jsonb,
  p_retention_sweep_runs_snapshot_ts_ms bigint,
  p_schedule_hash                       text,
  p_node_runtime_pin                    text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  INSERT INTO public.backup_manifests (
    run_id, started_at_ms, object_ref, blob_sha256, blob_bytes,
    encryption_kid, audit_log_head_id, audit_log_head_ts_ms,
    audit_log_head_hash, per_event_row_counts, per_table_row_counts,
    retention_sweep_runs_snapshot_ts_ms, schedule_hash, node_runtime_pin,
    manifest_status
  )
  VALUES (
    p_run_id, p_started_at_ms, p_object_ref, p_blob_sha256, p_blob_bytes,
    p_encryption_kid, p_audit_log_head_id, p_audit_log_head_ts_ms,
    p_audit_log_head_hash, p_per_event_row_counts, p_per_table_row_counts,
    p_retention_sweep_runs_snapshot_ts_ms, p_schedule_hash, p_node_runtime_pin,
    'pending'
  );
END
$$;

REVOKE EXECUTE ON FUNCTION public.backup_write_manifest_pending(
  uuid, bigint, text, text, bigint, text, bigint, bigint, bytea,
  jsonb, jsonb, bigint, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backup_write_manifest_pending(
  uuid, bigint, text, text, bigint, text, bigint, bigint, bytea,
  jsonb, jsonb, bigint, text, text
) TO backup_writer_role;

COMMENT ON FUNCTION public.backup_write_manifest_pending IS
  'ADR-0018 Sec4 / T17.1: INSERTs a backup_manifests row with status=pending. backup_writer_role only.';

-- ---------------------------------------------------------------------------
-- 4. backup_transition_manifest_status
--
--    UPDATEs an existing manifest's status with a state-machine
--    guard. Valid transitions:
--      pending   -> committed | aborted
--      committed -> hard_deleted
--    Sets committed_at_ms + object_lock_until_ms on pending->committed
--    (object_lock_until_ms = committed_at_ms + 42 days per ADR-0018 Sec6).
--    Sets hard_deleted_at_ms on committed->hard_deleted.
--    Invalid transitions raise 22023.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_transition_manifest_status(
  p_run_id            uuid,
  p_new_status        text,
  p_now_ms            bigint
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_current_status text;
  v_lock_until_ms  bigint;
BEGIN
  SELECT manifest_status INTO v_current_status
    FROM public.backup_manifests
   WHERE run_id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'backup_manifests row not found for run_id %', p_run_id
      USING ERRCODE = '22023';
  END IF;

  -- State-machine guard.
  IF NOT (
    (v_current_status = 'pending'   AND p_new_status IN ('committed','aborted'))
    OR
    (v_current_status = 'committed' AND p_new_status = 'hard_deleted')
  ) THEN
    RAISE EXCEPTION 'invalid manifest transition: % -> %', v_current_status, p_new_status
      USING ERRCODE = '22023';
  END IF;

  IF p_new_status = 'committed' THEN
    -- 42 days = 42 * 24 * 60 * 60 * 1000 ms.
    v_lock_until_ms := p_now_ms + (42::bigint * 24 * 60 * 60 * 1000);
    UPDATE public.backup_manifests
       SET manifest_status     = 'committed',
           committed_at_ms     = p_now_ms,
           object_lock_until_ms = v_lock_until_ms
     WHERE run_id = p_run_id;
  ELSIF p_new_status = 'aborted' THEN
    UPDATE public.backup_manifests
       SET manifest_status     = 'aborted',
           committed_at_ms     = p_now_ms
     WHERE run_id = p_run_id;
  ELSIF p_new_status = 'hard_deleted' THEN
    UPDATE public.backup_manifests
       SET manifest_status     = 'hard_deleted',
           hard_deleted_at_ms  = p_now_ms
     WHERE run_id = p_run_id;
  END IF;
END
$$;

REVOKE EXECUTE ON FUNCTION public.backup_transition_manifest_status(uuid, text, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backup_transition_manifest_status(uuid, text, bigint)
  TO backup_writer_role;

COMMENT ON FUNCTION public.backup_transition_manifest_status(uuid, text, bigint) IS
  'ADR-0018 Sec4 / T17.1: state-machine transition for backup_manifests.manifest_status. Valid: pending -> committed|aborted; committed -> hard_deleted. Invalid raises 22023. backup_writer_role only.';

-- ---------------------------------------------------------------------------
-- 5. backup_list_manifests_older_than_ms
--
--    Returns committed manifests whose committed_at_ms is older than
--    p_threshold_ms. Used by the 42-day hard-delete pass at 04:00 ET.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_list_manifests_older_than_ms(
  p_threshold_ms bigint
)
RETURNS TABLE (
  run_id               uuid,
  committed_at_ms      bigint,
  object_ref           text,
  object_lock_until_ms bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT m.run_id, m.committed_at_ms, m.object_ref, m.object_lock_until_ms
    FROM public.backup_manifests m
   WHERE m.manifest_status = 'committed'
     AND m.committed_at_ms IS NOT NULL
     AND m.committed_at_ms < p_threshold_ms
   ORDER BY m.committed_at_ms;
$$;

REVOKE EXECUTE ON FUNCTION public.backup_list_manifests_older_than_ms(bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backup_list_manifests_older_than_ms(bigint)
  TO backup_writer_role;

COMMENT ON FUNCTION public.backup_list_manifests_older_than_ms(bigint) IS
  'ADR-0018 Sec4 / T17.1: returns committed manifests older than threshold for the 42-day hard-delete pass. STABLE. backup_writer_role only.';

-- ---------------------------------------------------------------------------
-- 6. backup_has_open_run_within_window
--
--    Returns true if any backup_manifests row has started_at_ms within
--    the window (lease check — prevents two concurrent backup passes).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_has_open_run_within_window(
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
    SELECT 1 FROM public.backup_manifests
     WHERE started_at_ms > p_now_ms - p_lease_window_ms
  );
$$;

REVOKE EXECUTE ON FUNCTION public.backup_has_open_run_within_window(bigint, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backup_has_open_run_within_window(bigint, bigint)
  TO backup_writer_role;

COMMENT ON FUNCTION public.backup_has_open_run_within_window(bigint, bigint) IS
  'ADR-0018 Sec4 / T17.1: lease check — true if any backup_manifests row started in the window. STABLE. backup_writer_role only.';
