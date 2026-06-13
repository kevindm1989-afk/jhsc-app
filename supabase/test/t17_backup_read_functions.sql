-- ===========================================================================
-- M8.A.3a / T17.1 — pgTAP coverage for the four new backup read fns.
--
-- Source: migration 00000000000028_t17_backup_read_functions.sql.
-- Authority: ADR-0018 §4 / §7; threat-model.md §6 B6.1.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SELECT plan(16);

-- (1)-(4) functions exist.
SELECT has_function('public', 'backup_get_current_kid',
  ARRAY[]::name[],
  'backup_get_current_kid() exists');
SELECT has_function('public', 'backup_count_rows_by_event_type',
  ARRAY[]::name[],
  'backup_count_rows_by_event_type() exists');
SELECT has_function('public', 'backup_snapshot_retention_sweep_runs_ts',
  ARRAY[]::name[],
  'backup_snapshot_retention_sweep_runs_ts() exists');
SELECT has_function('public', 'backup_read_manifest',
  ARRAY['uuid'],
  'backup_read_manifest(uuid) exists');

-- (5) all 4 SECURITY DEFINER.
SELECT ok(
  (SELECT bool_and(prosecdef) FROM pg_proc
    WHERE proname IN ('backup_get_current_kid',
                      'backup_count_rows_by_event_type',
                      'backup_snapshot_retention_sweep_runs_ts',
                      'backup_read_manifest')
      AND pronamespace = 'public'::regnamespace),
  'all 4 new backup read fns are SECURITY DEFINER');

-- ---------------------------------------------------------------------------
-- (6) get_current_kid — seed one active row.
-- ---------------------------------------------------------------------------
INSERT INTO public.committee_data_keys (key_id, epoch)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 1);

SELECT is(
  public.backup_get_current_kid(),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'get_current_kid returns the active kid');

-- (7) get_current_kid still returns active even after a rotated row added.
INSERT INTO public.committee_data_keys (key_id, epoch, rotated_at)
  VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 0, now() - interval '1 day');

SELECT is(
  public.backup_get_current_kid(),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'get_current_kid still returns the rotated_at IS NULL row');

-- ---------------------------------------------------------------------------
-- (8) count_rows_by_event_type empty.
-- ---------------------------------------------------------------------------
SELECT is(
  public.backup_count_rows_by_event_type(),
  '{}'::jsonb,
  'count_rows_by_event_type returns {} on empty audit_log');

-- Seed audit rows.
INSERT INTO public.audit_log
  (event_type, actor_pseudonym, target_class, severity, retention_class, ts)
VALUES
  ('session.revoked',  'p0000000000001a1', 'C0', 'info', '90d', now()),
  ('session.revoked',  'p0000000000001a2', 'C0', 'info', '90d', now()),
  ('auth.passkey.enrolled', 'p0000000000001b1', 'C0', 'info', '90d', now());

-- (9) count_rows_by_event_type now reflects seeds.
SELECT is(
  (public.backup_count_rows_by_event_type()->>'session.revoked')::int,
  2,
  'count_rows_by_event_type session.revoked = 2');

SELECT is(
  (public.backup_count_rows_by_event_type()->>'auth.passkey.enrolled')::int,
  1,
  'count_rows_by_event_type auth.passkey.enrolled = 1');

-- ---------------------------------------------------------------------------
-- (10) snapshot_retention_sweep_runs_ts empty.
-- ---------------------------------------------------------------------------
SELECT is(
  public.backup_snapshot_retention_sweep_runs_ts(),
  0::bigint,
  'snapshot_retention_sweep_runs_ts = 0 on empty retention_sweep_runs');

INSERT INTO public.retention_sweep_runs (
  run_id, started_at_ms, completed_at_ms, schedule_hash,
  per_event_counts, per_table_counts, truncated_to_row_cap,
  alarm_fired, status
) VALUES
  ('11111111-1111-1111-1111-111111111111'::uuid, 1, 100, 'h',
   '{}'::jsonb, '{}'::jsonb, false, false, 'completed'),
  ('22222222-2222-2222-2222-222222222222'::uuid, 200, 300, 'h',
   '{}'::jsonb, '{}'::jsonb, false, false, 'completed');

SELECT is(
  public.backup_snapshot_retention_sweep_runs_ts(),
  300::bigint,
  'snapshot_retention_sweep_runs_ts = MAX(completed_at_ms) = 300');

-- ---------------------------------------------------------------------------
-- (11)-(12) read_manifest — empty + populated.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT run_id FROM public.backup_read_manifest(
    'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)),
  NULL::uuid,
  'read_manifest returns no row for unknown run_id');

INSERT INTO public.backup_manifests (
  run_id, started_at_ms, committed_at_ms, object_ref, blob_sha256,
  blob_bytes, encryption_kid, audit_log_head_id, audit_log_head_ts_ms,
  audit_log_head_hash, per_event_row_counts, per_table_row_counts,
  retention_sweep_runs_snapshot_ts_ms, schedule_hash, node_runtime_pin,
  manifest_status, object_lock_until_ms
) VALUES (
  '33333333-3333-3333-3333-333333333333'::uuid,
  1700000000000::bigint, 1700000200000::bigint,
  'backups/x', repeat('a',64), 100::bigint, 'kid',
  7::bigint, 1700000000000::bigint, '\x00'::bytea,
  '{}'::jsonb, '{}'::jsonb, 1700000000000::bigint,
  'sh', 'pin', 'committed', 1700000200000::bigint + 42::bigint * 86400000
);

SELECT is(
  (SELECT manifest_status FROM public.backup_read_manifest(
    '33333333-3333-3333-3333-333333333333'::uuid)),
  'committed',
  'read_manifest returns the inserted manifest_status');

-- ---------------------------------------------------------------------------
-- (13)-(14) GRANT chain.
-- ---------------------------------------------------------------------------
SELECT ok(
  has_function_privilege('backup_writer_role',
    'public.backup_get_current_kid()', 'EXECUTE'),
  'backup_writer_role has EXECUTE on backup_get_current_kid');

SELECT ok(
  NOT has_function_privilege('authenticated',
    'public.backup_read_manifest(uuid)', 'EXECUTE'),
  'authenticated has NO EXECUTE on backup_read_manifest');

SELECT * FROM finish();
ROLLBACK;
