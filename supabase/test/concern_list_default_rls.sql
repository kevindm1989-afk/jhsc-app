-- ===========================================================================
-- Production RLS/permission fix — pgTAP for `concern_list_default()`
-- (migration 0040). This is the test that WOULD have caught the production
-- bug: the prior CI never exercised the `authenticated` role path, so the
-- PG view-invoker EXECUTE check on the REVOKE'd `_committee_pseudonym`
-- (called by the widened `concerns_default_view`, migration 0039) was never
-- hit. Here we explicitly `SET LOCAL ROLE authenticated` so the privilege
-- boundary is real.
--
-- ASSERTIONS:
--   (a) `authenticated` CAN execute `concern_list_default()` and gets the
--       seeded member's rows, with `actor_pseudonym` = _committee_pseudonym(actor_id)
--       (the deanonymization-safe pseudonym, derived under the definer).
--   (b) raw `actor_id` is NOT a column of the result (F-149).
--   (c) `source_name_ct` is NOT a column of the result (F-18).
--   (d) `authenticated` STILL canNOT execute `public._committee_pseudonym(uuid)`
--       directly (has_function_privilege = false — the lock-down is preserved).
--   (e) a non-member / dead-session caller gets ZERO rows (the per-caller
--       session_is_live + is_active_member gate is preserved under SECURITY
--       DEFINER via request.jwt.claims).
--   (f) REGRESSION: a direct `SELECT … FROM concerns_default_view` AS
--       `authenticated` raises permission-denied — documents WHY the RPC
--       exists (the original production bug).
--
-- Conventions mirror `supabase/test/concerns_rls.sql` for seeding + the
-- request.jwt.claims shape. Run:
--   pg_prove -d <db> supabase/test/concern_list_default_rls.sql
--   (migrations 0..40 + the local auth shim). CI-only (no local Postgres).
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;
SELECT plan(12);

-- Members: A (active), B (active), C (removed). Seed as the superuser BEFORE
-- dropping to the authenticated role (authenticated cannot write the
-- RLS-locked base tables).
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000a1', true),
  ('00000000-0000-0000-0000-0000000000b2', true),
  ('00000000-0000-0000-0000-0000000000c3', true);
INSERT INTO public.committee_membership (user_id, role, active, activated_at) VALUES
  ('00000000-0000-0000-0000-0000000000a1', ARRAY['worker_member'], true,  now()),
  ('00000000-0000-0000-0000-0000000000b2', ARRAY['worker_member'], true,  now()),
  ('00000000-0000-0000-0000-0000000000c3', ARRAY['worker_member'], false, now());  -- removed
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111a1', '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111b2', '00000000-0000-0000-0000-0000000000b2', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111c3', '00000000-0000-0000-0000-0000000000c3', now() + interval '5 min');

-- Seed two concerns as A (via the gated SECURITY DEFINER submit fn): one
-- anonymous (location_id L-1), one named (location_id L-2). Done with A's JWT
-- claims set; submit runs as definer. The anon/named rows are distinguished by
-- location_id below so the assertions do not depend on a temp table surviving
-- the role switch.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
SELECT public.concern_submit('\x01'::bytea, '\x02'::bytea, 'physical', 'low',  'L-1', true);
SELECT public.concern_submit('\x0A'::bytea, '\xAA'::bytea, 'chemical', 'high', 'L-2', false,
                             '\xCAFEBABE'::bytea, 'open-sesame');

-- ==========================================================================
-- Drop to the REAL authenticated role — this is the privilege boundary the
-- production PostgREST caller hits, and the boundary CI never exercised.
-- request.jwt.claims is a session GUC and survives SET ROLE, so auth.uid()
-- still resolves to A.
-- ==========================================================================
SET LOCAL ROLE authenticated;

-- (1) (a) authenticated CAN execute the RPC and sees A's two rows.
SELECT cmp_ok(
  (SELECT count(*)::int FROM public.concern_list_default()),
  '>=',
  2,
  '(a) authenticated can execute concern_list_default() and sees the seeded rows');

-- (2) (a) actor_pseudonym is STABLE for the same submitter across rows (both
--     rows are A's), derived under the definer through the locked-down helper.
SELECT is(
  (SELECT actor_pseudonym FROM public.concern_list_default() WHERE location_id='L-1'),
  (SELECT actor_pseudonym FROM public.concern_list_default() WHERE location_id='L-2'),
  '(a) actor_pseudonym is stable for the same submitter across rows (same actor A)');

SELECT isnt(
  (SELECT actor_pseudonym FROM public.concern_list_default() WHERE location_id='L-1'),
  NULL,
  '(a) actor_pseudonym is non-null (the definer derived it through the locked-down helper)');

-- (3) (a) anonymous_default_kept / has_named_source derive correctly.
SELECT ok(
  (SELECT anonymous_default_kept FROM public.concern_list_default() WHERE location_id='L-1'),
  '(a) anonymous row → anonymous_default_kept TRUE');
SELECT ok(
  (SELECT has_named_source FROM public.concern_list_default() WHERE location_id='L-2'),
  '(a) named row → has_named_source TRUE');

-- (4) (b) raw actor_id is NOT a column of the RPC result (F-149). The OUT
--     column names of a RETURNS TABLE function are pg_proc.proargnames for the
--     OUT-mode args (proargmodes 'o'/'t').
SELECT ok(
  NOT (
    SELECT 'actor_id' = ANY(p.proargnames)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'concern_list_default'
  ),
  '(b) F-149: actor_id is NOT a column of concern_list_default()');

-- (5) (c) source_name_ct is NOT a column of the RPC result (F-18).
SELECT ok(
  NOT (
    SELECT 'source_name_ct' = ANY(p.proargnames)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'concern_list_default'
  ),
  '(c) F-18: source_name_ct is NOT a column of concern_list_default()');

-- Sanity: actor_pseudonym + has_named_source ARE columns (shape preserved).
-- (folded into the existing plan via the assertions above; not a separate test)

-- (6) (d) authenticated STILL cannot execute _committee_pseudonym directly —
--     the deanonymization lock-down (0002:205) is preserved.
SELECT ok(
  NOT has_function_privilege('authenticated', 'public._committee_pseudonym(uuid)', 'EXECUTE'),
  '(d) authenticated still has NO EXECUTE on _committee_pseudonym (lock-down preserved)');

-- (7) (f) REGRESSION — the direct view read raises permission-denied for
--     authenticated (this is the production bug the RPC routes around).
SELECT throws_ok(
  $$SELECT * FROM public.concerns_default_view$$,
  '42501',
  NULL,
  '(f) regression: direct SELECT on concerns_default_view raises permission-denied for authenticated (why the RPC exists)');

-- (8) (e) a removed member (C) gets ZERO rows — the per-caller gate is preserved
--     under SECURITY DEFINER (session_is_live + is_active_member via the JWT GUC).
RESET ROLE;
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c3","session_id":"11111111-1111-1111-1111-1111111111c3","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT count(*)::int FROM public.concern_list_default()),
  0,
  '(e) a removed member sees zero rows through the RPC (is_active_member gate preserved)');

-- (9) (e) a dead session (no live auth_sessions row) → zero rows even for an
--     active member. Switch to A's sub but with a non-existent session_id.
RESET ROLE;
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"99999999-9999-9999-9999-999999999999","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT count(*)::int FROM public.concern_list_default()),
  0,
  '(e) a dead/unknown session sees zero rows through the RPC (session_is_live gate preserved)');

-- (10) grants matrix on the RPC: authenticated + supabase_auth_admin EXECUTE;
--      anon denied.
RESET ROLE;
SELECT ok(
  has_function_privilege('authenticated', 'public.concern_list_default()', 'EXECUTE')
  AND has_function_privilege('supabase_auth_admin', 'public.concern_list_default()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.concern_list_default()', 'EXECUTE'),
  'grants matrix: authenticated + supabase_auth_admin EXECUTE; anon denied');

SELECT * FROM finish();
ROLLBACK;
