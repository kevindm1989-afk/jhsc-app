-- ===========================================================================
-- M9.B / T18.1 — pgTAP coverage for the watchdog read fn.
--
-- Source: migration 00000000000033_t18_watchdog_read_fn.sql.
-- Authority: ADR-0019 §3; M9.B watchdog probe.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SELECT plan(8);

-- (1) fn exists.
SELECT has_function('public', 'integrity_check_most_recent_ok_started_at_ms',
  ARRAY[]::name[],
  'integrity_check_most_recent_ok_started_at_ms() exists');

-- (2) SECURITY DEFINER.
SELECT ok(
  (SELECT prosecdef FROM pg_proc
    WHERE proname = 'integrity_check_most_recent_ok_started_at_ms'
      AND pronamespace = 'public'::regnamespace),
  'integrity_check_most_recent_ok_started_at_ms is SECURITY DEFINER');

-- (3) STABLE.
SELECT is(
  (SELECT provolatile FROM pg_proc
    WHERE proname = 'integrity_check_most_recent_ok_started_at_ms'
      AND pronamespace = 'public'::regnamespace),
  's'::"char",
  'integrity_check_most_recent_ok_started_at_ms is STABLE');

-- (4) Empty table returns NULL.
SELECT is(
  public.integrity_check_most_recent_ok_started_at_ms(),
  NULL::bigint,
  'returns NULL when no integrity_check_runs row exists');

-- Seed a 'running' row only — should still return NULL (status filter).
SELECT public.integrity_check_record_run_started(
  '11111111-1111-1111-1111-111111111111'::uuid,
  'scheduled',
  1700000000000::bigint,
  '{"node_version":"20.0.0","openssl_version":"3.0.13"}',
  'sched_hash_1'
);

-- (5) Running-only state still returns NULL.
SELECT is(
  public.integrity_check_most_recent_ok_started_at_ms(),
  NULL::bigint,
  'returns NULL when only running (not-yet-ok) rows exist');

-- Finalize the running row to status='ok' (via emit_run_and_mismatches).
SELECT public.integrity_check_emit_run_and_mismatches(
  '11111111-1111-1111-1111-111111111111'::uuid,
  1700000100000::bigint, 'ok',
  100::bigint, 0::bigint, 0::bigint, false, NULL::bigint,
  '[]'::jsonb
);

-- (6) Returns the started_at_ms of the ok row.
SELECT is(
  public.integrity_check_most_recent_ok_started_at_ms(),
  1700000000000::bigint,
  'returns started_at_ms of the only ok row');

-- Add a NEWER ok row.
SELECT public.integrity_check_record_run_started(
  '22222222-2222-2222-2222-222222222222'::uuid,
  'scheduled',
  1700001000000::bigint,
  '{"node_version":"20.0.0","openssl_version":"3.0.13"}',
  'sched_hash_2'
);
SELECT public.integrity_check_emit_run_and_mismatches(
  '22222222-2222-2222-2222-222222222222'::uuid,
  1700001100000::bigint, 'ok',
  100::bigint, 0::bigint, 0::bigint, false, NULL::bigint,
  '[]'::jsonb
);

-- (7) Returns the MAX (newer) started_at_ms.
SELECT is(
  public.integrity_check_most_recent_ok_started_at_ms(),
  1700001000000::bigint,
  'returns the newer started_at_ms when two ok rows exist');

-- (8) GRANT chain — integrity_check_role has EXECUTE; authenticated does NOT.
SELECT ok(
  has_function_privilege('integrity_check_role',
    'public.integrity_check_most_recent_ok_started_at_ms()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
    'public.integrity_check_most_recent_ok_started_at_ms()', 'EXECUTE'),
  'GRANT chain: integrity_check_role only');

SELECT * FROM finish();
ROLLBACK;
