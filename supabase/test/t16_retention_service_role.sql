-- ===========================================================================
-- M6 / T16.1 — pgTAP coverage for retention service-role scaffolding.
--
-- Asserts:
--   • retention_service_role exists and is NOLOGIN.
--   • audit_log_retention_schedule table exists with one row per
--     retention_class returned by retention_class_for().
--   • retention_sweep_runs table exists with the expected shape.
--   • DELETE on audit_log is GRANTed ONLY to retention_service_role
--     (matches the supabase/test/c4_read_audited_rls.sql §5.3
--     invariant).
--   • SELECT on audit_log_retention_schedule is permitted to
--     authenticated (non-PI, public policy).
--
-- Source: migration 00000000000019_t16_retention_service_role.sql.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SELECT plan(13);

-- (1) role exists.
SELECT ok(
  EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'retention_service_role'),
  'retention_service_role exists');

-- (2) role is NOLOGIN.
SELECT ok(
  NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'retention_service_role'),
  'retention_service_role is NOLOGIN');

-- (3) audit_log_retention_schedule table exists.
SELECT has_table('public', 'audit_log_retention_schedule',
  'audit_log_retention_schedule table exists');

-- (4) schedule table has the seven canonical retention_class rows.
SELECT results_eq(
  $$SELECT array_agg(retention_class ORDER BY retention_class)::text
      FROM public.audit_log_retention_schedule$$,
  $$VALUES ('{24mo,7y,7y_from_rotation,90d,match_underlying,membership+24mo,membership+7y}'::text)$$,
  'schedule rows cover the seven canonical retention_class values');

-- (5) every retention_class produced by retention_class_for() has a
--     schedule row. (Closed-set drift assertion — if a future migration
--     adds an arm without a schedule row, this fails.)
SELECT ok(
  (SELECT COUNT(*) = 0 FROM (
    SELECT DISTINCT public.retention_class_for(et) AS rc
      FROM unnest(ARRAY[
        'auth.passkey.enrolled','auth.passkey.revoked','session.revoked',
        'committee_data_key.unwrap','committee_data_key.rotation.started',
        'committee_data_key.rotation.completed','committee_data_key.member_revoked',
        'committee.key_rotated','identity_keypair.created',
        'identity_privkey.recovery_blob.written',
        'identity_privkey.recovery_blob.restored',
        'identity_privkey.recovery_blob.viewed','recovery_reset.issued',
        'panic_wipe.invoked','committee_data_key.wrapped_for_member',
        'export.generated','export.contained_concern_derived_items',
        'retention.deleted','member.added','member.removed','member.role_changed',
        'alert.fired','client.cache_policy_violation','client.identity_selftest_fail',
        'key_parity.mismatch','key_parity.deploy_ok','auth.mint.revoked_during_mint'
      ]) AS et
  ) sub
  LEFT JOIN public.audit_log_retention_schedule sch ON sch.retention_class = sub.rc
  WHERE sch.retention_class IS NULL),
  'every retention_class_for() arm has a matching audit_log_retention_schedule row');

-- (6) schedule.interval_ms is positive everywhere.
SELECT ok(
  (SELECT bool_and(interval_ms > 0) FROM public.audit_log_retention_schedule),
  'audit_log_retention_schedule.interval_ms > 0 for every row');

-- (7) schedule.semantics is in the closed set.
SELECT ok(
  (SELECT bool_and(semantics IN ('interval','match_underlying','membership_relative'))
     FROM public.audit_log_retention_schedule),
  'audit_log_retention_schedule.semantics is in the closed set');

-- (8) retention_sweep_runs table exists.
SELECT has_table('public', 'retention_sweep_runs',
  'retention_sweep_runs table exists');

-- (9) retention_sweep_runs.status CHECK accepts the closed set.
SELECT throws_ok(
  $$INSERT INTO public.retention_sweep_runs
      (started_at_ms, completed_at_ms, schedule_hash, status)
    VALUES (0, 1, 'h', 'not_a_status')$$,
  '23514', NULL,
  'retention_sweep_runs.status CHECK rejects unknown status values');

-- (10) DELETE on audit_log is granted ONLY to retention_service_role.
SELECT is(
  (SELECT string_agg(grantee::text, ',' ORDER BY grantee::text)
     FROM information_schema.role_table_grants
    WHERE table_name = 'audit_log'
      AND privilege_type = 'DELETE'
      AND grantee::text IN ('authenticated','anon','service_role','audit_writer_role',
                            'c4_read_service','retention_service_role','mint_writer')),
  'retention_service_role',
  'DELETE on audit_log granted ONLY to retention_service_role (matches T18 audit-log §5.3)');

-- (11) UPDATE on audit_log is granted to NO ONE.
SELECT results_eq(
  $$SELECT COUNT(*)::int FROM information_schema.role_table_grants
     WHERE table_name = 'audit_log'
       AND privilege_type = 'UPDATE'
       AND grantee::text IN ('authenticated','anon','service_role','audit_writer_role',
                             'c4_read_service','retention_service_role','mint_writer')$$,
  $$VALUES (0)$$,
  'UPDATE on audit_log granted to NO role');

-- (12) retention_service_role has SELECT on audit_log.
SELECT ok(
  has_table_privilege('retention_service_role', 'public.audit_log', 'SELECT'),
  'retention_service_role has SELECT on audit_log');

-- (13) authenticated can SELECT from audit_log_retention_schedule
--      (non-PI public policy).
SELECT ok(
  has_table_privilege('authenticated', 'public.audit_log_retention_schedule', 'SELECT'),
  'authenticated has SELECT on audit_log_retention_schedule');

SELECT * FROM finish();
ROLLBACK;
