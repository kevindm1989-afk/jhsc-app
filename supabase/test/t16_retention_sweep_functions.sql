-- ===========================================================================
-- M6.1 / T16.1 — pgTAP coverage for the SECURITY DEFINER retention
-- sweep functions.
--
-- Source: migration 00000000000022_t16_retention_sweep_functions.sql.
-- Authority: ADR-0017 (T16 retention library); ADR-0016 (operational
--   retention); ADR-0015 + Amendment I (per-event-type schedule).
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
-- 20 assertions + 1 result row from emit's RETURNS bigint (pg_prove
-- counts the SELECT-returning row).
SELECT plan(21);

-- ---------------------------------------------------------------------------
-- (1)-(5) Functions exist + are SECURITY DEFINER.
-- ---------------------------------------------------------------------------
SELECT has_function('public', 'retention_delete_for_event_type',
  ARRAY['text','bigint','integer'],
  'retention_delete_for_event_type(text, bigint, integer) exists');

SELECT has_function('public', 'retention_count_for_event_type',
  ARRAY['text','bigint'],
  'retention_count_for_event_type(text, bigint) exists');

SELECT has_function('public', 'retention_delete_operational_table',
  ARRAY['text','bigint','integer'],
  'retention_delete_operational_table(text, bigint, integer) exists');

SELECT has_function('public', 'retention_count_in_operational_table',
  ARRAY['text','bigint'],
  'retention_count_in_operational_table(text, bigint) exists');

SELECT has_function('public', 'retention_emit_deleted_and_register_run',
  ARRAY['uuid','bigint','bigint','text','jsonb','jsonb','boolean','boolean','text'],
  'retention_emit_deleted_and_register_run(...) exists');

SELECT ok(
  (SELECT bool_and(prosecdef) FROM pg_proc
    WHERE proname IN ('retention_delete_for_event_type',
                      'retention_count_for_event_type',
                      'retention_delete_operational_table',
                      'retention_count_in_operational_table',
                      'retention_emit_deleted_and_register_run')
      AND pronamespace = 'public'::regnamespace),
  'all 5 retention functions are SECURITY DEFINER');

-- ---------------------------------------------------------------------------
-- (7)-(10) deleteForEventType + countForEventType happy path.
-- ---------------------------------------------------------------------------
-- Seed 5 audit_log rows of type 'session.revoked' at ascending ts.
-- audit_emit owns the prev_hash chain; bypass it by inserting directly
-- (we set retention_class explicitly so the table CHECK is satisfied).
INSERT INTO public.audit_log
  (event_type, actor_pseudonym, target_class, severity, retention_class, ts)
VALUES
  ('session.revoked', 'p0000000000000a1', 'C0', 'info', '90d', now() - interval '200 days'),
  ('session.revoked', 'p0000000000000a2', 'C0', 'info', '90d', now() - interval '180 days'),
  ('session.revoked', 'p0000000000000a3', 'C0', 'info', '90d', now() - interval '160 days'),
  ('session.revoked', 'p0000000000000a4', 'C0', 'info', '90d', now() - interval '140 days'),
  ('session.revoked', 'p0000000000000a5', 'C0', 'info', '90d', now() -  interval '10 days');

-- All 5 rows match the cutoff "now" except the last one (10 days old).
-- 4 rows should be candidate for a 100-day cutoff.
SELECT is(
  public.retention_count_for_event_type(
    'session.revoked',
    (extract(epoch from (now() - interval '100 days')) * 1000)::bigint
  ),
  4::bigint,
  'count_for_event_type returns 4 with a 100-day cutoff');

-- Delete with max_rows=2 → only 2 deleted, leaving 2 candidates.
SELECT is(
  public.retention_delete_for_event_type(
    'session.revoked',
    (extract(epoch from (now() - interval '100 days')) * 1000)::bigint,
    2
  ),
  2,
  'delete_for_event_type returns 2 when max_rows=2');

SELECT is(
  public.retention_count_for_event_type(
    'session.revoked',
    (extract(epoch from (now() - interval '100 days')) * 1000)::bigint
  ),
  2::bigint,
  'count_for_event_type reflects the 2 just-deleted rows are gone');

-- Delete remaining 2 with max_rows=10 → 2 deleted.
SELECT is(
  public.retention_delete_for_event_type(
    'session.revoked',
    (extract(epoch from (now() - interval '100 days')) * 1000)::bigint,
    10
  ),
  2,
  'delete_for_event_type returns 2 when 2 candidates remain (max_rows=10)');

-- ---------------------------------------------------------------------------
-- (11)-(12) deleteForEventType — input validation.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$SELECT public.retention_delete_for_event_type('session.revoked', 0, 0)$$,
  '22023', NULL,
  'p_max_rows = 0 raises 22023');

SELECT throws_ok(
  $$SELECT public.retention_delete_for_event_type('', 0, 100)$$,
  '22023', NULL,
  'empty p_event_type raises 22023');

-- ---------------------------------------------------------------------------
-- (13)-(15) deleteOperationalTable + countInOperationalTable + allowlist.
-- ---------------------------------------------------------------------------
INSERT INTO public.auth_totp_consumed_log
  (user_id, totp_code_hash, consumed_at)
VALUES
  ('00000000-0000-0000-0000-0000000000a1',
   '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea,
   now() - interval '48 hours');

SELECT is(
  public.retention_count_in_operational_table(
    'auth_totp_consumed_log',
    (extract(epoch from (now() - interval '24 hours')) * 1000)::bigint
  ),
  1::bigint,
  'count_in_operational_table returns 1 for the 48h-old row at 24h cutoff');

SELECT is(
  public.retention_delete_operational_table(
    'auth_totp_consumed_log',
    (extract(epoch from (now() - interval '24 hours')) * 1000)::bigint,
    10
  ),
  1,
  'delete_operational_table returns 1');

SELECT throws_ok(
  $$SELECT public.retention_delete_operational_table('not_an_allowed_table', 0, 1)$$,
  '22023', NULL,
  'unknown operational table raises 22023 (closed-allowlist invariant)');

-- ---------------------------------------------------------------------------
-- (16) emitRetentionDeletedAndRegisterRun — writes both rows
--      atomically; retention.deleted has retention_class '7y' (per
--      ADR-0015 no_target_id carve-out).
-- ---------------------------------------------------------------------------
SELECT public.retention_emit_deleted_and_register_run(
  '11111111-1111-1111-1111-111111111111'::uuid,
  1700000000000::bigint,
  1700000123456::bigint,
  'sha256:dummyhash',
  jsonb_build_object('session.revoked', 4),
  jsonb_build_object('auth_totp_consumed_log', 1),
  false,
  false,
  'completed'
);

SELECT is(
  (SELECT count(*)::int FROM public.retention_sweep_runs
    WHERE run_id = '11111111-1111-1111-1111-111111111111'::uuid),
  1,
  'retention_sweep_runs row written');

SELECT is(
  (SELECT retention_class FROM public.audit_log
    WHERE event_type = 'retention.deleted'
      AND meta->>'run_id' = '11111111-1111-1111-1111-111111111111'
    ORDER BY id DESC LIMIT 1),
  '7y',
  'retention.deleted audit row written with retention_class = 7y (no_target_id carve-out)');

-- ---------------------------------------------------------------------------
-- (17)-(18) emit — input validation + target_id NULL invariant.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$SELECT public.retention_emit_deleted_and_register_run(
      gen_random_uuid(), 0, 1, 'h',
      '{}'::jsonb, '{}'::jsonb, false, false, 'not_a_status')$$,
  '22023', NULL,
  'emit raises 22023 on invalid status');

SELECT is(
  (SELECT target_id FROM public.audit_log
    WHERE event_type = 'retention.deleted'
      AND meta->>'run_id' = '11111111-1111-1111-1111-111111111111'
    ORDER BY id DESC LIMIT 1),
  NULL::uuid,
  'retention.deleted target_id is NULL (ADR-0015 Amendment I no_target_id)');

-- ---------------------------------------------------------------------------
-- (19)-(20) GRANT chain — retention_service_role only.
-- ---------------------------------------------------------------------------
SELECT ok(
  has_function_privilege('retention_service_role',
    'public.retention_delete_for_event_type(text,bigint,integer)', 'EXECUTE'),
  'retention_service_role has EXECUTE on retention_delete_for_event_type');

SELECT ok(
  NOT has_function_privilege('authenticated',
    'public.retention_delete_for_event_type(text,bigint,integer)', 'EXECUTE'),
  'authenticated has NO EXECUTE on retention_delete_for_event_type');

SELECT * FROM finish();
ROLLBACK;
