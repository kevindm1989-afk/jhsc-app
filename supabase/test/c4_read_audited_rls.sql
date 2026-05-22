-- ===========================================================================
-- T13 / T14 — pgTAP tests for C4 server-enforced read-audit (HG-6 +
--             Amendment A extension).
--
-- Source:
--   - .context/decisions.md ADR-0003 Amendment B (HG-6).
--   - .context/decisions.md ADR-0003 Amendment A extension (work_refusal.read /
--     s51_evidence.read enum values).
--   - observability/audit-log.md §3, §4, §5 obligations.
--   - .context/test-plan.md §3 infrastructure: pgTAP is the SQL test harness;
--     install via `CREATE EXTENSION pgtap` in the supabase local stack.
--
-- Run: `pg_prove -d postgres -h localhost supabase/test/c4_read_audited_rls.sql`
-- ===========================================================================

BEGIN;
SELECT plan(18);

-- ---------------------------------------------------------------------------
-- (1) Underlying C4 tables have RLS enabled and SELECT GRANT empty for the
--     three public-API-reachable roles. (audit-log.md §5 coverage; T13/T14.)
-- ---------------------------------------------------------------------------

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'reprisal_log'),
  'T13 / HG-6 — reprisal_log has RLS enabled'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'work_refusal'),
  'T14 / Amendment A — work_refusal has RLS enabled'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE relname = 's51_evidence'),
  'T14 / Amendment A — s51_evidence has RLS enabled'
);

-- ---------------------------------------------------------------------------
-- (2) SELECT on each C4 table is REVOKED from authenticated, anon, service_role.
-- ---------------------------------------------------------------------------

SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.role_table_grants
    WHERE table_name = 'reprisal_log'
      AND grantee IN ('authenticated','anon','service_role')
      AND privilege_type = 'SELECT'$$,
  $$VALUES (0)$$,
  'T13 / HG-6 — reprisal_log SELECT GRANT empty for authenticated/anon/service_role'
);
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.role_table_grants
    WHERE table_name = 'work_refusal'
      AND grantee IN ('authenticated','anon','service_role')
      AND privilege_type = 'SELECT'$$,
  $$VALUES (0)$$,
  'T14 / Amendment A — work_refusal SELECT GRANT empty for authenticated/anon/service_role'
);
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.role_table_grants
    WHERE table_name = 's51_evidence'
      AND grantee IN ('authenticated','anon','service_role')
      AND privilege_type = 'SELECT'$$,
  $$VALUES (0)$$,
  'T14 / Amendment A — s51_evidence SELECT GRANT empty for authenticated/anon/service_role'
);

-- ---------------------------------------------------------------------------
-- (3) The corresponding `_read_audited` SECURITY DEFINER views exist and are
--     owned by c4_read_service. Authenticated has SELECT on each view.
-- ---------------------------------------------------------------------------

SELECT has_view('public', 'reprisal_log_read_audited',
  'T13 / HG-6 — view reprisal_log_read_audited exists');
SELECT has_view('public', 'work_refusal_read_audited',
  'T14 / Amendment A — view work_refusal_read_audited exists');
SELECT has_view('public', 's51_evidence_read_audited',
  'T14 / Amendment A — view s51_evidence_read_audited exists');

SELECT results_eq(
  $$SELECT viewowner FROM pg_views WHERE viewname = 'reprisal_log_read_audited'$$,
  $$VALUES ('c4_read_service')$$,
  'T13 / HG-6 — reprisal_log_read_audited owned by c4_read_service'
);

-- ---------------------------------------------------------------------------
-- (4) UPDATE on audit_log is REVOKED from every role (audit-log §5.2).
-- ---------------------------------------------------------------------------

SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.role_table_grants
    WHERE table_name = 'audit_log'
      AND grantee IN ('authenticated','anon','service_role','audit_writer_role','c4_read_service','retention_service_role')
      AND privilege_type = 'UPDATE'$$,
  $$VALUES (0)$$,
  'T18 / audit-log §5.2 — UPDATE on audit_log revoked from every role'
);

-- ---------------------------------------------------------------------------
-- (5) DELETE on audit_log is REVOKED from every role except retention_service_role.
-- ---------------------------------------------------------------------------

SELECT results_eq(
  $$SELECT array_agg(grantee ORDER BY grantee)::text
    FROM information_schema.role_table_grants
    WHERE table_name = 'audit_log'
      AND privilege_type = 'DELETE'
      AND grantee IN ('authenticated','anon','service_role','audit_writer_role','c4_read_service','retention_service_role')$$,
  $$VALUES ('{retention_service_role}'::text)$$,
  'T18 / audit-log §5.3 — DELETE on audit_log granted ONLY to retention_service_role'
);

-- ---------------------------------------------------------------------------
-- (6) The closed enum on audit_log.event_type rejects an arbitrary value.
-- ---------------------------------------------------------------------------

SELECT throws_ok(
  $$INSERT INTO audit_log (event_type, target_class, severity, request_id, meta, prev_hash)
    VALUES ('not.a.real.event', 'C1', 'info', gen_random_uuid(), '{}'::jsonb, '\x00'::bytea)$$,
  '23514', NULL,
  'T18 / audit-log §5.6 — CHECK constraint on event_type rejects unknown values'
);

-- ---------------------------------------------------------------------------
-- (7) jhsc_caller_can_read_reprisal predicate exists.
-- ---------------------------------------------------------------------------

SELECT has_function('public', 'jhsc_caller_can_read_reprisal',
  ARRAY['uuid','uuid'],
  'T13 / HG-6 — RLS predicate function jhsc_caller_can_read_reprisal(uuid,uuid) exists');

-- ---------------------------------------------------------------------------
-- (8) jhsc_log_sensitive_read is SECURITY DEFINER and owned by c4_read_service.
-- ---------------------------------------------------------------------------

SELECT results_eq(
  $$SELECT prosecdef::int FROM pg_proc WHERE proname = 'jhsc_log_sensitive_read' LIMIT 1$$,
  $$VALUES (1)$$,
  'T13 / HG-6 — jhsc_log_sensitive_read is SECURITY DEFINER'
);
SELECT results_eq(
  $$SELECT r.rolname::text FROM pg_proc p JOIN pg_roles r ON p.proowner = r.oid
    WHERE proname = 'jhsc_log_sensitive_read' LIMIT 1$$,
  $$VALUES ('c4_read_service'::text)$$,
  'T13 / HG-6 — jhsc_log_sensitive_read owned by c4_read_service'
);

-- ---------------------------------------------------------------------------
-- (9) audit_log has retention_class NOT NULL with CHECK referencing schedule.
-- ---------------------------------------------------------------------------

SELECT col_not_null('audit_log', 'retention_class',
  'T16 / ADR-0015 — audit_log.retention_class NOT NULL');
SELECT has_table('public', 'audit_log_retention_schedule',
  'T16 / ADR-0015 — audit_log_retention_schedule table exists');

SELECT * FROM finish();
ROLLBACK;
