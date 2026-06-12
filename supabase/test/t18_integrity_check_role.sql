-- ===========================================================================
-- M8.B / T18.1 — pgTAP coverage for integrity_check_role scaffolding.
--
-- Source: migration 00000000000021_t18_integrity_check_role.sql.
-- Authority: ADR-0019 (T18 integrity-check library + MemoryIntegrityStore).
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SELECT plan(15);

-- (1) role exists.
SELECT ok(
  EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'integrity_check_role'),
  'integrity_check_role exists');

-- (2) role is NOLOGIN.
SELECT ok(
  NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'integrity_check_role'),
  'integrity_check_role is NOLOGIN');

-- (3) integrity_check_runs table exists.
SELECT has_table('public', 'integrity_check_runs',
  'integrity_check_runs table exists');

-- (4) audit_chain_anchors table exists.
SELECT has_table('public', 'audit_chain_anchors',
  'audit_chain_anchors table exists');

-- (5) integrity_check_runs.trigger CHECK rejects unknown values.
SELECT throws_ok(
  $$INSERT INTO public.integrity_check_runs
      (run_id, trigger, started_at_ms, node_runtime_pin, schedule_hash)
    VALUES (gen_random_uuid(), 'not_a_trigger', 0, 'pin', 'h')$$,
  '23514', NULL,
  'integrity_check_runs.trigger CHECK rejects unknown values');

-- (6) integrity_check_runs.status CHECK rejects unknown values.
SELECT throws_ok(
  $$INSERT INTO public.integrity_check_runs
      (run_id, trigger, started_at_ms, status, node_runtime_pin, schedule_hash)
    VALUES (gen_random_uuid(), 'scheduled', 0, 'not_a_status', 'pin', 'h')$$,
  '23514', NULL,
  'integrity_check_runs.status CHECK rejects unknown values');

-- (7) integrity_check_runs accepts every closed-set trigger value.
SELECT lives_ok(
  $$INSERT INTO public.integrity_check_runs
      (run_id, trigger, started_at_ms, node_runtime_pin, schedule_hash)
    VALUES (gen_random_uuid(), 'scheduled', 0, 'pin', 'h'),
           (gen_random_uuid(), 'post_rotation', 0, 'pin', 'h'),
           (gen_random_uuid(), 'post_export', 0, 'pin', 'h'),
           (gen_random_uuid(), 'weekly_anchor', 0, 'pin', 'h')$$,
  'integrity_check_runs accepts all 4 closed-set trigger values');

-- (8) "finished status implies completed_at_ms" CHECK works.
SELECT throws_ok(
  $$INSERT INTO public.integrity_check_runs
      (run_id, trigger, started_at_ms, status, node_runtime_pin, schedule_hash)
    VALUES (gen_random_uuid(), 'scheduled', 0, 'ok', 'pin', 'h')$$,
  '23514', NULL,
  'finished status with NULL completed_at_ms is rejected');

-- (9) integrity_check_role has SELECT on audit_log.
SELECT ok(
  has_table_privilege('integrity_check_role', 'public.audit_log', 'SELECT'),
  'integrity_check_role has SELECT on audit_log');

-- (10) integrity_check_role has SELECT on retention_sweep_runs.
SELECT ok(
  has_table_privilege('integrity_check_role', 'public.retention_sweep_runs', 'SELECT'),
  'integrity_check_role has SELECT on retention_sweep_runs');

-- (11) integrity_check_role has SELECT on backup_manifests (if it exists).
--      The migration's conditional grant runs when backup_manifests is
--      present (i.e. when #214 has merged); the test asserts the
--      end-state.
SELECT ok(
  NOT EXISTS(SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'backup_manifests')
  OR has_table_privilege('integrity_check_role', 'public.backup_manifests', 'SELECT'),
  'integrity_check_role has SELECT on backup_manifests (when present)');

-- (12) integrity_check_role has NO UPDATE on audit_log.
SELECT ok(
  NOT has_table_privilege('integrity_check_role', 'public.audit_log', 'UPDATE'),
  'integrity_check_role has NO UPDATE on audit_log');

-- (13) integrity_check_role has NO DELETE on audit_log.
SELECT ok(
  NOT has_table_privilege('integrity_check_role', 'public.audit_log', 'DELETE'),
  'integrity_check_role has NO DELETE on audit_log');

-- (14) integrity_check_role has INSERT on integrity_check_runs.
SELECT ok(
  has_table_privilege('integrity_check_role', 'public.integrity_check_runs', 'INSERT'),
  'integrity_check_role has INSERT on integrity_check_runs');

-- (15) DELETE on integrity_check_runs is granted to NO role.
SELECT is(
  (SELECT string_agg(grantee::text, ',' ORDER BY grantee::text)
     FROM information_schema.role_table_grants
    WHERE table_name = 'integrity_check_runs'
      AND privilege_type = 'DELETE'
      AND grantee::text IN ('authenticated','anon','service_role',
                            'audit_writer_role','c4_read_service',
                            'retention_service_role','backup_writer_role',
                            'integrity_check_role','mint_writer')),
  NULL,
  'DELETE on integrity_check_runs granted to NO role');

SELECT * FROM finish();
ROLLBACK;
