-- ===========================================================================
-- M8.B.3 / T18.1 — pgTAP coverage for integrity_check_runner.
--
-- Source: migration 00000000000030_t18_integrity_check_runner.sql.
-- Authority: ADR-0019 §3; threat-model.md §6 B6.2.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SELECT plan(15);

-- (1) function exists.
SELECT has_function('public', 'integrity_check_runner',
  ARRAY['text','bigint','bigint','text','text'],
  'integrity_check_runner(text,bigint,bigint,text,text) exists');

-- (2) SECURITY DEFINER.
SELECT ok(
  (SELECT prosecdef FROM pg_proc
    WHERE proname = 'integrity_check_runner'
      AND pronamespace = 'public'::regnamespace),
  'integrity_check_runner is SECURITY DEFINER');

-- (3)-(5) input validation.
SELECT throws_ok(
  $$SELECT public.integrity_check_runner(
      'not_a_trigger', 1700000000000::bigint, 60000::bigint, '{"node_version":"20.0.0","openssl_version":"3.0.13"}', 'h')$$,
  '22023', NULL,
  'invalid trigger raises 22023');

SELECT throws_ok(
  $$SELECT public.integrity_check_runner(
      'scheduled', 0::bigint, 60000::bigint, '{"node_version":"20.0.0","openssl_version":"3.0.13"}', 'h')$$,
  '22023', NULL,
  'p_now_ms=0 raises 22023');

SELECT throws_ok(
  $$SELECT public.integrity_check_runner(
      'scheduled', 1700000000000::bigint, -1::bigint, '{"node_version":"20.0.0","openssl_version":"3.0.13"}', 'h')$$,
  '22023', NULL,
  'negative lease window raises 22023');

-- ---------------------------------------------------------------------------
-- (6) Happy path A: empty chain + no backup manifests => status=ok,
-- no mismatches.
-- ---------------------------------------------------------------------------
SELECT ok(
  (SELECT public.integrity_check_runner(
    'scheduled', 1700000000000::bigint, 60000::bigint, 'node@v20', 'sh1')
     IS NOT NULL),
  'first pass with empty chain returns non-null run_id');

SELECT is(
  (SELECT status FROM public.integrity_check_runs
    ORDER BY started_at_ms DESC LIMIT 1),
  'ok',
  'first pass status = ok (nothing to diff)');

-- ---------------------------------------------------------------------------
-- (7) Lease check — second pass within the window returns NULL.
-- ---------------------------------------------------------------------------
SELECT is(
  public.integrity_check_runner(
    'scheduled', 1700000010000::bigint, 60000::bigint, 'node@v20', 'sh1'),
  NULL::uuid,
  'second pass inside lease window returns NULL');

-- ---------------------------------------------------------------------------
-- (8) Happy path B: seed an audit row + a committed manifest whose
-- head_id matches the live head exactly. Pass outside lease window.
-- Expect status=ok, no mismatches.
-- ---------------------------------------------------------------------------
INSERT INTO public.audit_log
  (event_type, actor_pseudonym, target_class, severity, retention_class, ts)
VALUES
  ('session.revoked', 'p0000000000099a1', 'C0', 'info', '90d', now());

-- Manifest head_id MUST match the live head_id, AND the synthetic
-- head_hash MUST match what extract_chain_head produces for that row,
-- so the runner emits no mismatch.
INSERT INTO public.backup_manifests (
  run_id, started_at_ms, committed_at_ms, object_ref, blob_sha256,
  blob_bytes, encryption_kid, audit_log_head_id, audit_log_head_ts_ms,
  audit_log_head_hash, per_event_row_counts, per_table_row_counts,
  retention_sweep_runs_snapshot_ts_ms, schedule_hash, node_runtime_pin,
  manifest_status, object_lock_until_ms
)
SELECT
  '11111111-1111-1111-1111-111111111111'::uuid,
  1700001000000::bigint, 1700001200000::bigint,
  'backups/x', repeat('a', 64), 100::bigint, 'kid',
  (SELECT head_id FROM public.integrity_check_extract_chain_head()),
  (SELECT head_ts_ms FROM public.integrity_check_extract_chain_head()),
  (SELECT head_hash FROM public.integrity_check_extract_chain_head()),
  '{}'::jsonb, '{}'::jsonb, 1700001000000::bigint, 'sh', '{"node_version":"20.0.0","openssl_version":"3.0.13"}',
  'committed', 1700001200000::bigint + 42::bigint * 86400000;

SELECT ok(
  (SELECT public.integrity_check_runner(
    'scheduled', 1700100000000::bigint, 1000::bigint, 'node@v20', 'sh2')
     IS NOT NULL),
  'matched-head pass returns non-null run_id');

SELECT is(
  (SELECT status FROM public.integrity_check_runs
    ORDER BY started_at_ms DESC LIMIT 1),
  'ok',
  'matched-head pass status = ok (no mismatches)');

-- ---------------------------------------------------------------------------
-- (9) Mismatch path: insert another audit row so live head > manifest
-- head. NO retention_sweep_run exists, so the gap is unattributable.
-- Expect status=mismatch_found + a row_missing mismatch.
-- ---------------------------------------------------------------------------
INSERT INTO public.audit_log
  (event_type, actor_pseudonym, target_class, severity, retention_class, ts)
VALUES
  ('session.revoked', 'p0000000000099a2', 'C0', 'info', '90d', now());

SELECT ok(
  (SELECT public.integrity_check_runner(
    'scheduled', 1700200000000::bigint, 1000::bigint, 'node@v20', 'sh3')
     IS NOT NULL),
  'drift pass returns non-null run_id');

SELECT is(
  (SELECT status FROM public.integrity_check_runs
    ORDER BY started_at_ms DESC LIMIT 1),
  'mismatch_found',
  'drift pass status = mismatch_found');

SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE event_type = 'audit.integrity_check.mismatch'
      AND meta->>'mismatch_kind' = 'row_missing'),
  1,
  'one row_missing mismatch emitted');

-- ---------------------------------------------------------------------------
-- (10) GRANT chain.
-- ---------------------------------------------------------------------------
SELECT ok(
  has_function_privilege('integrity_check_role',
    'public.integrity_check_runner(text,bigint,bigint,text,text)',
    'EXECUTE'),
  'integrity_check_role has EXECUTE on integrity_check_runner');

SELECT ok(
  NOT has_function_privilege('authenticated',
    'public.integrity_check_runner(text,bigint,bigint,text,text)',
    'EXECUTE'),
  'authenticated has NO EXECUTE on integrity_check_runner');

SELECT * FROM finish();
ROLLBACK;
