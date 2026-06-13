-- ===========================================================================
-- M6.1.B / T16.1 — pgTAP coverage for the SECURITY DEFINER
-- underlying-record-ceiling functions.
--
-- Source: migration 00000000000023_t16_retention_ceiling_rule.sql.
-- Authority: ADR-0015 Sec3.5 (ceiling rule); ADR-0017 (T16 library).
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SELECT plan(13);

-- (1) functions exist.
SELECT has_function('public', 'retention_delete_for_ceiling',
  ARRAY['bigint','integer'],
  'retention_delete_for_ceiling(bigint, integer) exists');

SELECT has_function('public', 'retention_count_for_ceiling',
  ARRAY['bigint'],
  'retention_count_for_ceiling(bigint) exists');

-- (3) both SECURITY DEFINER.
SELECT ok(
  (SELECT bool_and(prosecdef) FROM pg_proc
    WHERE proname IN ('retention_delete_for_ceiling',
                      'retention_count_for_ceiling')
      AND pronamespace = 'public'::regnamespace),
  'both ceiling functions are SECURITY DEFINER');

-- Seed scenarios. We need:
--   - 1 concern A (committee-data-key model unwound for the test —
--     concerns table requires committee_data_key_wraps to exist for
--     the user. Insert directly bypassing the trigger chain isn't
--     possible without seeding the entire C3 path. So we test the
--     orphan-detection logic with a SYNTHETIC concern id that
--     definitely doesn't exist in concerns.)
--
-- audit_log rows used by tests:
--   row 1: retention_class='match_underlying', target_id=ORPHAN,
--          event_type='concern.created', ts=200d old  → DELETE candidate
--   row 2: same but ts=10d old                        → NOT a delete
--                                                       candidate at
--                                                       30d cutoff
--   row 3: target_id=NULL                              → never delete
--   row 4: retention_class='7y' (different class)     → never delete
--   row 5: event_type NOT on allowlist                → never delete
INSERT INTO public.audit_log
  (event_type, actor_pseudonym, target_class, severity, retention_class, target_id, ts)
VALUES
  ('concern.created', 'p0000000000000a1', 'C3', 'info', 'match_underlying',
   '11111111-1111-1111-1111-111111111111'::uuid, now() - interval '200 days'),
  ('concern.created', 'p0000000000000a2', 'C3', 'info', 'match_underlying',
   '22222222-2222-2222-2222-222222222222'::uuid, now() - interval '10 days'),
  ('concern.created', 'p0000000000000a3', 'C3', 'info', 'match_underlying',
   NULL, now() - interval '200 days'),
  ('committee_data_key.unwrap', 'p0000000000000a4', 'C1', 'info', '24mo',
   '33333333-3333-3333-3333-333333333333'::uuid, now() - interval '200 days'),
  ('session.revoked', 'p0000000000000a5', 'C0', 'info', '90d',
   NULL, now() - interval '200 days');

-- (4) Cutoff at 30 days ago: only row 1 qualifies (target_id orphan +
--     match_underlying + on allowlist + ts older than cutoff).
SELECT is(
  public.retention_count_for_ceiling(
    (extract(epoch from (now() - interval '30 days')) * 1000)::bigint
  ),
  1::bigint,
  'count_for_ceiling returns 1 at 30d cutoff');

-- (5) Cutoff at 5 days ago: now row 2 also qualifies (still match,
--     orphan, allowlist, but the 10-day-old row is OLDER than the
--     5-day cutoff so it counts).
SELECT is(
  public.retention_count_for_ceiling(
    (extract(epoch from (now() - interval '5 days')) * 1000)::bigint
  ),
  2::bigint,
  'count_for_ceiling returns 2 at 5d cutoff');

-- (6) Delete with max_rows=0 raises 22023.
SELECT throws_ok(
  $$SELECT public.retention_delete_for_ceiling(0, 0)$$,
  '22023', NULL,
  'p_max_rows = 0 raises 22023');

-- (7) Delete with max_rows=1 deletes 1 row.
SELECT is(
  public.retention_delete_for_ceiling(
    (extract(epoch from (now() - interval '30 days')) * 1000)::bigint,
    1
  ),
  1,
  'delete_for_ceiling deletes 1 row when max_rows=1 (the 200d-old orphan)');

-- (8) After the delete, 0 candidates remain at the 30d cutoff.
SELECT is(
  public.retention_count_for_ceiling(
    (extract(epoch from (now() - interval '30 days')) * 1000)::bigint
  ),
  0::bigint,
  'count_for_ceiling returns 0 after the only candidate was deleted');

-- (9) The NULL-target_id row was NOT deleted.
SELECT ok(
  EXISTS(SELECT 1 FROM public.audit_log
          WHERE event_type='concern.created'
            AND actor_pseudonym='p0000000000000a3'
            AND target_id IS NULL),
  'row with target_id=NULL survives (Sec3.5 carve-out)');

-- (10) The non-match_underlying row was NOT deleted.
SELECT ok(
  EXISTS(SELECT 1 FROM public.audit_log
          WHERE event_type='committee_data_key.unwrap'
            AND actor_pseudonym='p0000000000000a4'),
  'row with retention_class != match_underlying survives');

-- (11) The off-allowlist event_type row was NOT deleted.
SELECT ok(
  EXISTS(SELECT 1 FROM public.audit_log
          WHERE event_type='session.revoked'
            AND actor_pseudonym='p0000000000000a5'),
  'row with event_type off the closed allowlist survives');

-- (12) GRANT chain — retention_service_role has EXECUTE.
SELECT ok(
  has_function_privilege('retention_service_role',
    'public.retention_delete_for_ceiling(bigint,integer)', 'EXECUTE'),
  'retention_service_role has EXECUTE on retention_delete_for_ceiling');

-- (13) authenticated has NO EXECUTE.
SELECT ok(
  NOT has_function_privilege('authenticated',
    'public.retention_delete_for_ceiling(bigint,integer)', 'EXECUTE'),
  'authenticated has NO EXECUTE on retention_delete_for_ceiling');

SELECT * FROM finish();
ROLLBACK;
