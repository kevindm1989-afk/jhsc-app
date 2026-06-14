-- ===========================================================================
-- T08.1 — pgTAP: concerns RLS + SECURITY DEFINER functions.
--   F-15  active-member gate on submit (and F-30 removed-member denial)
--   F-17  actor_id always recorded; source_name_ct NULL when anonymous; audit
--         always carries the submitter pseudonym
--   F-16  concern_update emits concern.updated with prev_field_hashes
--   F-18  concerns_default_view omits source_name_ct; reveal audits-before-return
--   F-20  consume_concern_rate_budget enforces 20/hour AND 200/24h (G-T08-13)
--   G-T08-6  per-record reveal passphrase verified server-side
--
-- Run: pg_prove -d <db> supabase/test/concerns_rls.sql  (after migrations 0-4
-- + the local auth shim, with app.hmac_pseudonym_key set).
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;   -- so digest()/crypt() resolve in the test body
SELECT plan(34);

-- Users: an active member, a non-member, and a removed member (F-30).
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000a1', true),
  ('00000000-0000-0000-0000-0000000000b2', true),
  ('00000000-0000-0000-0000-0000000000c3', true);
INSERT INTO public.committee_membership (user_id, role, active, activated_at) VALUES
  ('00000000-0000-0000-0000-0000000000a1', ARRAY['worker_member'], true, now()),
  ('00000000-0000-0000-0000-0000000000c3', ARRAY['worker_member'], false, now());  -- removed
-- Live sessions (jti = session_id) so session_is_live() passes; the gate then
-- turns purely on is_active_member for the denial cases.
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111a1', '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111b2', '00000000-0000-0000-0000-0000000000b2', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111c3', '00000000-0000-0000-0000-0000000000c3', now() + interval '5 min');

-- (1)-(4) table protections.
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname = 'concerns'),
  'concerns has RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname = 'concern_rate_log'),
  'concern_rate_log has RLS enabled');
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.role_table_grants
     WHERE table_name='concerns' AND grantee IN ('authenticated','anon')
       AND privilege_type IN ('INSERT','UPDATE','DELETE')$$,
  $$VALUES (0)$$, 'concerns write grants empty for authenticated/anon');
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.role_table_grants
     WHERE table_name='concerns' AND grantee IN ('authenticated','anon')
       AND privilege_type='SELECT'$$,
  $$VALUES (0)$$, 'F-18: direct SELECT on concerns denied (reads go via the view)');

-- Act as the active member.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';

-- (5)-(9) anonymous submit.
CREATE TEMP TABLE _c AS
  SELECT 'anon'::text AS tag,
         public.concern_submit('\x01'::bytea, '\x02'::bytea, 'physical', 'low', 'loc-1', true) AS id;
SELECT isnt((SELECT id FROM _c WHERE tag='anon'), NULL, 'concern_submit (anonymous) returns an id');
SELECT is((SELECT actor_id FROM public.concerns WHERE id=(SELECT id FROM _c WHERE tag='anon')),
  '00000000-0000-0000-0000-0000000000a1'::uuid, 'F-17: actor_id is the submitter (never null)');
SELECT ok((SELECT source_name_ct IS NULL FROM public.concerns WHERE id=(SELECT id FROM _c WHERE tag='anon')),
  'F-17: anonymous submit stores no source_name_ct');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_log
    WHERE event_type='concern.created' AND target_id=(SELECT id FROM _c WHERE tag='anon')),
  'F-17: concern.created audit row emitted');
SELECT is((SELECT meta->>'anonymous_default_kept' FROM public.audit_log
    WHERE event_type='concern.created' AND target_id=(SELECT id FROM _c WHERE tag='anon')),
  'true', 'audit meta records anonymous_default_kept');

-- (10)-(12) named submit (with per-record passphrase). body_ct=\xAAAA for the F-16 hash check.
INSERT INTO _c SELECT 'named',
  public.concern_submit('\x0A'::bytea, '\xAAAA'::bytea, 'chemical', 'high', 'loc-2', false,
                        '\xCAFEBABE'::bytea, 'open-sesame');
SELECT isnt((SELECT id FROM _c WHERE tag='named'), NULL, 'concern_submit (named) returns an id');
SELECT ok((SELECT source_name_ct IS NOT NULL FROM public.concerns WHERE id=(SELECT id FROM _c WHERE tag='named')),
  'named submit stores source_name_ct');
SELECT ok((SELECT source_passphrase_hash IS NOT NULL FROM public.concerns WHERE id=(SELECT id FROM _c WHERE tag='named')),
  'G-T08-6: per-record passphrase hash stored');

-- (13)-(14) F-15 / F-30 active-member gate.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","session_id":"11111111-1111-1111-1111-1111111111b2","role":"authenticated"}';
SELECT throws_like(
  $$SELECT public.concern_submit('\x01'::bytea,'\x02'::bytea,'physical','low','loc-x', true)$$,
  '%rls_denied%', 'F-15: a non-member cannot submit a concern');
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c3","session_id":"11111111-1111-1111-1111-1111111111c3","role":"authenticated"}';
SELECT throws_like(
  $$SELECT public.concern_submit('\x01'::bytea,'\x02'::bytea,'physical','low','loc-x', true)$$,
  '%rls_denied%', 'F-30: a removed member cannot submit a concern');

-- Back to the active member.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';

-- (15)-(18) F-18 default-list projection.
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.columns
     WHERE table_name='concerns_default_view' AND column_name='source_name_ct'$$,
  $$VALUES (0)$$, 'F-18: concerns_default_view omits source_name_ct');
SELECT ok((SELECT has_named_source FROM public.concerns_default_view WHERE id=(SELECT id FROM _c WHERE tag='named')),
  'F-18: has_named_source is true for a named concern');
SELECT ok((SELECT NOT has_named_source FROM public.concerns_default_view WHERE id=(SELECT id FROM _c WHERE tag='anon')),
  'F-18: has_named_source is false for an anonymous concern');
SELECT cmp_ok((SELECT count(*)::int FROM public.concerns_default_view), '>=', 2,
  'an active member sees concerns via the default view');

-- (19)-(22) F-16 update + prev_field_hashes.
SELECT lives_ok(
  format($$SELECT public.concern_update(%L::uuid, NULL, '\xBBBB'::bytea)$$, (SELECT id FROM _c WHERE tag='named')),
  'concern_update re-encrypts the body');
SELECT is((SELECT body_ct FROM public.concerns WHERE id=(SELECT id FROM _c WHERE tag='named')),
  '\xBBBB'::bytea, 'body_ct updated to the new ciphertext');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_log
    WHERE event_type='concern.updated' AND target_id=(SELECT id FROM _c WHERE tag='named')),
  'F-16: concern.updated audit row emitted');
SELECT is(
  (SELECT meta->'prev_field_hashes'->>'body_ct' FROM public.audit_log
     WHERE event_type='concern.updated' AND target_id=(SELECT id FROM _c WHERE tag='named')),
  encode(digest('\xAAAA'::bytea, 'sha256'), 'hex'),
  'F-16: prev_field_hashes.body_ct is the SHA-256 of the prior ciphertext');

-- (23)-(26) F-18 reveal + G-T08-6 passphrase gate.
SELECT is(
  public.reveal_concern_source((SELECT id FROM _c WHERE tag='named'), 'open-sesame'),
  '\xCAFEBABE'::bytea, 'reveal returns the source ciphertext with the correct passphrase');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_log
    WHERE event_type='concern.source_revealed' AND target_id=(SELECT id FROM _c WHERE tag='named')),
  'F-18: concern.source_revealed audit row emitted');
SELECT throws_like(
  format($$SELECT public.reveal_concern_source(%L::uuid, 'wrong')$$, (SELECT id FROM _c WHERE tag='named')),
  '%rls_denied%', 'G-T08-6: reveal with a wrong passphrase is denied');
SELECT ok(
  public.reveal_concern_source((SELECT id FROM _c WHERE tag='anon'), NULL) IS NULL,
  'reveal on an anonymous concern returns NULL');

-- (27)-(29) F-20 / G-T08-13 rate-limit windows (direct seeding of the log).
-- Hourly ceiling: 20 within the hour ⇒ denied; 19 ⇒ allowed.
INSERT INTO public.concern_rate_log (actor_id, created_at)
  SELECT '00000000-0000-0000-0000-000000000020', now() - (g || ' minutes')::interval
  FROM generate_series(1, 20) g;
SELECT is(public.consume_concern_rate_budget('00000000-0000-0000-0000-000000000020'), false,
  'F-20: 20 submits within the hour exhausts the hourly budget');
INSERT INTO public.concern_rate_log (actor_id, created_at)
  SELECT '00000000-0000-0000-0000-000000000019', now() - (g || ' minutes')::interval
  FROM generate_series(1, 19) g;
SELECT is(public.consume_concern_rate_budget('00000000-0000-0000-0000-000000000019'), true,
  'F-20: a 20th submit within the hour is allowed');
-- 24h ceiling: 200 within 24h but older than 1h (hourly window empty) ⇒ denied.
INSERT INTO public.concern_rate_log (actor_id, created_at)
  SELECT '00000000-0000-0000-0000-000000000200', now() - interval '2 hours' - (g || ' seconds')::interval
  FROM generate_series(1, 200) g;
SELECT is(public.consume_concern_rate_budget('00000000-0000-0000-0000-000000000200'), false,
  'G-T08-13: 200 submits within 24h exhausts the daily budget');

-- (30)-(33) G-T08-16 / F-30 timing-budget cases.
--
-- The gap text asks for "at least one case at >0s and one ≤60s." The
-- SECURITY DEFINER concern_submit reads is_active_member() against
-- the LIVE committee_membership table on every call, so propagation
-- of a membership flip is bounded by the call latency itself —
-- effectively immediate at the SQL layer. These cases prove:
--
--   (30) immediate denial after a membership flip (propagation > 0s
--        because the flip + the next call happen on the same session,
--        but the propagation delay measured between the UPDATE and
--        the throws_like is well under 1s — and crucially under 60s).
--   (31) the elapsed wall-clock time between the membership UPDATE
--        and the denial throws_like is < 60_000 ms (the F-30 budget).
--   (32) the elapsed time is > 0 ms (propagation is observable; the
--        test is not a no-op).
--   (33) post-pg_sleep robustness — even after a small real sleep,
--        the denial holds. This guards against an accidental cache
--        that would only be visible if the test ran fast enough to
--        miss the eviction.

-- Seed a fresh active member for the timing case.
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000d4', true);
INSERT INTO public.committee_membership (user_id, role, active, activated_at) VALUES
  ('00000000-0000-0000-0000-0000000000d4', ARRAY['worker_member'], true, now());
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111d4', '00000000-0000-0000-0000-0000000000d4', now() + interval '5 min');

SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000d4","session_id":"11111111-1111-1111-1111-1111111111d4","role":"authenticated"}';

-- Sanity: D4 can submit while active.
SELECT lives_ok(
  $$SELECT public.concern_submit('\x01'::bytea,'\x02'::bytea,'physical','low','loc-x', true)$$,
  'G-T08-16 setup: an active member can submit before the flip');

-- Capture the wall clock immediately before the membership flip.
DO $$
DECLARE
  v_t0 timestamptz;
  v_t1 timestamptz;
  v_elapsed_ms double precision;
  v_caught text := '';
BEGIN
  v_t0 := clock_timestamp();
  UPDATE public.committee_membership
     SET active = false
   WHERE user_id = '00000000-0000-0000-0000-0000000000d4';
  -- Next call MUST deny; capture the elapsed time at the moment of
  -- denial so we can assert the F-30 budget below.
  BEGIN
    PERFORM public.concern_submit('\x01'::bytea,'\x02'::bytea,'physical','low','loc-x', true);
  EXCEPTION WHEN OTHERS THEN
    v_caught := SQLERRM;
  END;
  v_t1 := clock_timestamp();
  v_elapsed_ms := extract(epoch from (v_t1 - v_t0)) * 1000;
  -- Stash for the pgTAP asserts via SET LOCAL.
  PERFORM set_config('app.f30_caught_msg', v_caught, true);
  PERFORM set_config('app.f30_elapsed_ms', v_elapsed_ms::text, true);
END $$;

SELECT ok(
  current_setting('app.f30_caught_msg', true) LIKE '%rls_denied%',
  'F-30 / G-T08-16: a removed member is denied on the next submit (immediate)');

SELECT cmp_ok(
  current_setting('app.f30_elapsed_ms', true)::numeric,
  '<=',
  60000::numeric,
  'F-30 / G-T08-16: the membership-flip-to-denial propagation is <= 60_000 ms');

SELECT cmp_ok(
  current_setting('app.f30_elapsed_ms', true)::numeric,
  '>',
  0::numeric,
  'F-30 / G-T08-16: the membership-flip-to-denial propagation is > 0 ms (observable)');

-- Post-real-sleep: ensure no cache is masking the denial.
SELECT pg_sleep(0.05);
SELECT throws_like(
  $$SELECT public.concern_submit('\x01'::bytea,'\x02'::bytea,'physical','low','loc-x', true)$$,
  '%rls_denied%',
  'F-30 / G-T08-16: denial holds after a 50 ms real sleep (no eviction-window race)');

SELECT * FROM finish();
ROLLBACK;
