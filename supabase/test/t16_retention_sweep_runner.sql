-- ===========================================================================
-- M6.3 / T16.1 — pgTAP coverage for retention_sweep_runner orchestrator.
--
-- Source: migration 00000000000026_t16_retention_sweep_runner.sql.
-- Authority: ADR-0017; ADR-0015 + Amendment I.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SELECT plan(14);

-- (1) function exists.
SELECT has_function('public', 'retention_sweep_runner',
  ARRAY['bigint','integer'],
  'retention_sweep_runner(bigint,integer) exists');

-- (2) SECURITY DEFINER.
SELECT ok(
  (SELECT prosecdef FROM pg_proc
    WHERE proname = 'retention_sweep_runner'
      AND pronamespace = 'public'::regnamespace),
  'retention_sweep_runner is SECURITY DEFINER');

-- (3) p_max_rows_per_arm = 0 raises 22023.
SELECT throws_ok(
  $$SELECT public.retention_sweep_runner(1700000000000::bigint, 0)$$,
  '22023', NULL,
  'p_max_rows_per_arm = 0 raises 22023');

-- (4) p_now_ms = 0 raises 22023.
SELECT throws_ok(
  $$SELECT public.retention_sweep_runner(0::bigint, 100)$$,
  '22023', NULL,
  'p_now_ms = 0 raises 22023');

-- Seed audit_log: 3 session.revoked rows >90d old (the 90d arm)
-- and 1 sensitive.access_attempt >24mo old (the 24mo arm).
INSERT INTO public.audit_log
  (event_type, actor_pseudonym, target_class, severity, retention_class, ts)
VALUES
  ('session.revoked', 'p0000000000001a1', 'C0', 'info', '90d', now() - interval '200 days'),
  ('session.revoked', 'p0000000000001a2', 'C0', 'info', '90d', now() - interval '180 days'),
  ('session.revoked', 'p0000000000001a3', 'C0', 'info', '90d', now() - interval '160 days'),
  ('sensitive.access_attempt', 'p0000000000001b1', 'C3', 'info', '24mo',
   now() - interval '800 days');

-- Seed an operational-table row >24h old.
INSERT INTO public.auth_totp_consumed_log
  (user_id, totp_code_hash, consumed_at)
VALUES
  ('00000000-0000-0000-0000-0000000000c1',
   '\x0000000000000000000000000000000000000000000000000000000000000001'::bytea,
   now() - interval '48 hours');

-- (5) Happy path: returns a non-null run_id.
SELECT ok(
  (SELECT public.retention_sweep_runner(
    (extract(epoch from now()) * 1000)::bigint, 100) IS NOT NULL),
  'runner returns non-null run_id on uncontended call');

-- (6) A retention_sweep_runs row is written.
SELECT is(
  (SELECT count(*)::int FROM public.retention_sweep_runs
    WHERE schedule_hash IS NOT NULL),
  1,
  'retention_sweep_runs has 1 row after the first pass');

-- (7) per_event_counts in the just-written run has the session.revoked arm.
SELECT is(
  (SELECT (per_event_counts->>'session.revoked')::int
    FROM public.retention_sweep_runs
    ORDER BY started_at_ms DESC LIMIT 1),
  3,
  'per_event_counts session.revoked = 3 (the 3 seeded >90d rows deleted)');

-- (8) per_table_counts has the auth_totp_consumed_log arm.
SELECT is(
  (SELECT (per_table_counts->>'auth_totp_consumed_log')::int
    FROM public.retention_sweep_runs
    ORDER BY started_at_ms DESC LIMIT 1),
  1,
  'per_table_counts auth_totp_consumed_log = 1 (the seeded >24h row deleted)');

-- (9) status = completed (no arm hit the 100-row cap).
SELECT is(
  (SELECT status FROM public.retention_sweep_runs
    ORDER BY started_at_ms DESC LIMIT 1),
  'completed',
  'status = completed when no arm capped');

-- (10) retention.deleted audit row exists with matching run_id.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE event_type = 'retention.deleted'
      AND meta->>'run_id' = (
        SELECT run_id::text FROM public.retention_sweep_runs
        ORDER BY started_at_ms DESC LIMIT 1
      )),
  1,
  'retention.deleted audit row emitted with matching run_id');

-- A second pass should be a no-op (no candidates left). It should
-- still emit a retention.deleted row but per_event_counts = {}.
-- Bump p_now_ms by +1 so the checkpoint row has a strictly later
-- started_at_ms — otherwise ORDER BY DESC LIMIT 1 is a tie against
-- the first pass.
SELECT ok(
  (SELECT public.retention_sweep_runner(
    ((extract(epoch from now()) * 1000)::bigint) + 1, 100) IS NOT NULL),
  'second pass returns non-null run_id');

SELECT is(
  (SELECT per_event_counts FROM public.retention_sweep_runs
    ORDER BY started_at_ms DESC LIMIT 1),
  '{}'::jsonb,
  'second pass per_event_counts is empty (nothing left to sweep)');

-- (11) GRANT chain — retention_service_role has EXECUTE; authenticated
-- does NOT.
SELECT ok(
  has_function_privilege('retention_service_role',
    'public.retention_sweep_runner(bigint,integer)', 'EXECUTE'),
  'retention_service_role has EXECUTE on retention_sweep_runner');

SELECT ok(
  NOT has_function_privilege('authenticated',
    'public.retention_sweep_runner(bigint,integer)', 'EXECUTE'),
  'authenticated has NO EXECUTE on retention_sweep_runner');

SELECT * FROM finish();
ROLLBACK;
