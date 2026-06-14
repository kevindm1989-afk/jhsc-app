-- ===========================================================================
-- M8.B.1 / T18.1 — pgTAP coverage for integrity-check SECURITY DEFINER fns.
--
-- Source: migration 00000000000025_t18_integrity_check_functions.sql.
-- Authority: ADR-0019 §3.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
-- pg_prove counts RETURNS-record row from extract_chain_head etc.
SELECT plan(16);

-- (1)-(5) functions exist.
SELECT has_function('public', 'integrity_check_has_open_run_within_window',
  ARRAY['bigint','bigint'],
  'integrity_check_has_open_run_within_window(bigint,bigint) exists');

SELECT has_function('public', 'integrity_check_record_run_started',
  ARRAY['uuid','text','bigint','text','text'],
  'integrity_check_record_run_started(uuid,text,bigint,text,text) exists');

SELECT has_function('public', 'integrity_check_read_latest_backup_manifest',
  ARRAY[]::name[],
  'integrity_check_read_latest_backup_manifest() exists');

SELECT has_function('public', 'integrity_check_list_sweep_runs_through',
  ARRAY['bigint','integer'],
  'integrity_check_list_sweep_runs_through(bigint,integer) exists');

SELECT has_function('public', 'integrity_check_extract_chain_head',
  ARRAY[]::name[],
  'integrity_check_extract_chain_head() exists');

-- (6) all 5 SECURITY DEFINER.
SELECT ok(
  (SELECT bool_and(prosecdef) FROM pg_proc
    WHERE proname IN ('integrity_check_has_open_run_within_window',
                      'integrity_check_record_run_started',
                      'integrity_check_read_latest_backup_manifest',
                      'integrity_check_list_sweep_runs_through',
                      'integrity_check_extract_chain_head')
      AND pronamespace = 'public'::regnamespace),
  'all 5 integrity_check functions are SECURITY DEFINER');

-- (7) record_run_started inserts a row with status=running.
SELECT public.integrity_check_record_run_started(
  '11111111-1111-1111-1111-111111111111'::uuid,
  'scheduled',
  1700000000000::bigint,
  'node@v20',
  'sched_hash_1'
);

SELECT is(
  (SELECT status FROM public.integrity_check_runs
    WHERE run_id = '11111111-1111-1111-1111-111111111111'::uuid),
  'running',
  'record_run_started inserts a row with status=running');

-- (8) invalid trigger raises 22023.
SELECT throws_ok(
  $$SELECT public.integrity_check_record_run_started(
      gen_random_uuid(), 'not_a_trigger', 0::bigint, '{"node_version":"20.0.0","openssl_version":"3.0.13"}', 'h')$$,
  '22023', NULL,
  'invalid trigger raises 22023');

-- (9) has_open_run_within_window true when recent.
SELECT ok(
  public.integrity_check_has_open_run_within_window(1700000100000::bigint, 1000000::bigint),
  'has_open_run_within_window true when row started in window');

-- (10) has_open_run_within_window false when outside.
SELECT ok(
  NOT public.integrity_check_has_open_run_within_window(1800000000000::bigint, 1000::bigint),
  'has_open_run_within_window false when no row in window');

-- (11) Read latest committed backup manifest — seed a committed row.
INSERT INTO public.backup_manifests (
  run_id, started_at_ms, committed_at_ms, object_ref, blob_sha256,
  blob_bytes, encryption_kid, audit_log_head_id, audit_log_head_ts_ms,
  audit_log_head_hash, per_event_row_counts, per_table_row_counts,
  retention_sweep_runs_snapshot_ts_ms, schedule_hash, node_runtime_pin,
  manifest_status, object_lock_until_ms
) VALUES (
  '22222222-2222-2222-2222-222222222222'::uuid,
  1700001000000::bigint, 1700001200000::bigint, 'bucket://a', repeat('a',64),
  100::bigint, 'kid', 7::bigint, 1700001000000::bigint, '\x00'::bytea,
  '{}'::jsonb, '{}'::jsonb, 1700001000000::bigint, 'sh', '{"node_version":"20.0.0","openssl_version":"3.0.13"}',
  'committed', 1700001200000::bigint + 42::bigint * 86400000
);

SELECT is(
  (SELECT manifest_run_id FROM public.integrity_check_read_latest_backup_manifest()),
  '22222222-2222-2222-2222-222222222222'::uuid,
  'read_latest_backup_manifest returns the committed manifest run_id');

-- (12) list_sweep_runs_through returns rows whose completed_at_ms is
--      <= the cursor.
INSERT INTO public.retention_sweep_runs (
  run_id, started_at_ms, completed_at_ms, schedule_hash,
  per_event_counts, per_table_counts, truncated_to_row_cap,
  alarm_fired, status
) VALUES
  ('33333333-3333-3333-3333-333333333333'::uuid,
   1700002000000::bigint, 1700002100000::bigint, 'sh',
   '{}'::jsonb, '{}'::jsonb, false, false, 'completed'),
  ('44444444-4444-4444-4444-444444444444'::uuid,
   1700003000000::bigint, 1700003100000::bigint, 'sh',
   '{}'::jsonb, '{}'::jsonb, false, false, 'completed');

SELECT is(
  (SELECT count(*)::int FROM public.integrity_check_list_sweep_runs_through(
    1700002500000::bigint, 100)),
  1,
  'list_sweep_runs_through returns 1 row at mid-cursor');

SELECT is(
  (SELECT count(*)::int FROM public.integrity_check_list_sweep_runs_through(
    1700004000000::bigint, 100)),
  2,
  'list_sweep_runs_through returns 2 rows at later cursor');

-- (13) extract_chain_head returns a non-null tuple when audit_log
--      has rows.
INSERT INTO public.audit_log
  (event_type, actor_pseudonym, target_class, severity, retention_class, ts)
VALUES ('session.revoked', 'p0000000000000a1', 'C0', 'info', '90d', now());

SELECT ok(
  (SELECT head_id IS NOT NULL FROM public.integrity_check_extract_chain_head()),
  'extract_chain_head returns a non-null head_id');

-- (14) GRANT chain — integrity_check_role has EXECUTE.
SELECT ok(
  has_function_privilege('integrity_check_role',
    'public.integrity_check_extract_chain_head()', 'EXECUTE'),
  'integrity_check_role has EXECUTE on integrity_check_extract_chain_head');

-- (15) authenticated has NO EXECUTE.
SELECT ok(
  NOT has_function_privilege('authenticated',
    'public.integrity_check_extract_chain_head()', 'EXECUTE'),
  'authenticated has NO EXECUTE on integrity_check_extract_chain_head');

SELECT * FROM finish();
ROLLBACK;
