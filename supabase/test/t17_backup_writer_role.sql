-- ===========================================================================
-- M8.A / T17.1 — pgTAP coverage for backup_writer_role scaffolding.
--
-- Source: migration 00000000000020_t17_backup_writer_role.sql.
-- Authority: ADR-0018 (T17 backup library + MemoryBackupStore).
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SELECT plan(13);

-- (1) role exists.
SELECT ok(
  EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'backup_writer_role'),
  'backup_writer_role exists');

-- (2) role is NOLOGIN.
SELECT ok(
  NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'backup_writer_role'),
  'backup_writer_role is NOLOGIN');

-- (3) backup_manifests table exists.
SELECT has_table('public', 'backup_manifests',
  'backup_manifests table exists');

-- (4) backup_manifests.run_id is the primary key.
SELECT col_is_pk('public', 'backup_manifests', 'run_id',
  'backup_manifests.run_id is the PRIMARY KEY');

-- (5) backup_manifests.blob_sha256 CHECK rejects non-hex.
SELECT throws_ok(
  $$INSERT INTO public.backup_manifests
      (run_id, started_at_ms, object_ref, blob_sha256, blob_bytes,
       encryption_kid, audit_log_head_id, audit_log_head_ts_ms,
       audit_log_head_hash, retention_sweep_runs_snapshot_ts_ms,
       schedule_hash, node_runtime_pin)
    VALUES (gen_random_uuid(), 0, 'r', 'not-a-sha', 0, 'kid', 0, 0,
            '\x00'::bytea, 0, 'h', 'pin')$$,
  '23514', NULL,
  'backup_manifests.blob_sha256 CHECK rejects non-hex value');

-- (6) backup_manifests.manifest_status CHECK rejects unknown values.
SELECT throws_ok(
  $$INSERT INTO public.backup_manifests
      (run_id, started_at_ms, object_ref, blob_sha256, blob_bytes,
       encryption_kid, audit_log_head_id, audit_log_head_ts_ms,
       audit_log_head_hash, retention_sweep_runs_snapshot_ts_ms,
       schedule_hash, node_runtime_pin, manifest_status)
    VALUES (gen_random_uuid(), 0, 'r', repeat('a',64), 0, 'kid', 0, 0,
            '\x00'::bytea, 0, 'h', 'pin', 'not_a_status')$$,
  '23514', NULL,
  'backup_manifests.manifest_status CHECK rejects unknown values');

-- (7) backup_manifests.blob_bytes >= 0 CHECK.
SELECT throws_ok(
  $$INSERT INTO public.backup_manifests
      (run_id, started_at_ms, object_ref, blob_sha256, blob_bytes,
       encryption_kid, audit_log_head_id, audit_log_head_ts_ms,
       audit_log_head_hash, retention_sweep_runs_snapshot_ts_ms,
       schedule_hash, node_runtime_pin)
    VALUES (gen_random_uuid(), 0, 'r', repeat('a',64), -1, 'kid', 0, 0,
            '\x00'::bytea, 0, 'h', 'pin')$$,
  '23514', NULL,
  'backup_manifests.blob_bytes >= 0 CHECK rejects negative');

-- (8) backup_writer_role has INSERT on backup_manifests.
SELECT ok(
  has_table_privilege('backup_writer_role', 'public.backup_manifests', 'INSERT'),
  'backup_writer_role has INSERT on backup_manifests');

-- (9) backup_writer_role has UPDATE on backup_manifests.
SELECT ok(
  has_table_privilege('backup_writer_role', 'public.backup_manifests', 'UPDATE'),
  'backup_writer_role has UPDATE on backup_manifests');

-- (10) backup_writer_role has SELECT on backup_manifests.
SELECT ok(
  has_table_privilege('backup_writer_role', 'public.backup_manifests', 'SELECT'),
  'backup_writer_role has SELECT on backup_manifests');

-- (11) DELETE on backup_manifests is granted to NO role
--      (mirrors the audit_log/retention_sweep_runs pattern — the
--       7y retention is enforced by the audit-log retention pass).
SELECT is(
  (SELECT string_agg(grantee::text, ',' ORDER BY grantee::text)
     FROM information_schema.role_table_grants
    WHERE table_name = 'backup_manifests'
      AND privilege_type = 'DELETE'
      AND grantee::text IN ('authenticated','anon','service_role',
                            'audit_writer_role','c4_read_service',
                            'retention_service_role','backup_writer_role',
                            'mint_writer')),
  NULL,
  'DELETE on backup_manifests granted to NO role (7y retention enforced via audit_log path)');

-- (12) authenticated has SELECT on backup_manifests (on-call surface).
SELECT ok(
  has_table_privilege('authenticated', 'public.backup_manifests', 'SELECT'),
  'authenticated has SELECT on backup_manifests (on-call surface)');

-- (13) authenticated has NO INSERT/UPDATE on backup_manifests.
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.backup_manifests', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.backup_manifests', 'UPDATE'),
  'authenticated has NO INSERT/UPDATE on backup_manifests');

SELECT * FROM finish();
ROLLBACK;
