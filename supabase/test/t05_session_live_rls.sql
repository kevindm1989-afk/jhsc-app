-- ===========================================================================
-- T05 / F-121 — pgTAP: session-liveness UNIFORMITY at the SQL layer.
--
-- Finding: F-121 (open HIGH auth finding — session-revocation uniformity).
-- Source: threat-model.md §3.14 F-116 / F-121 ; ADR-0023 (session_is_live).
--
-- WHAT THIS PINS
--   The F-116 EF-dispatcher precheck (assertSessionLive) is already enforced.
--   The OPEN F-121 surface is the DIRECT-PostgREST bypass: a revoked-but-
--   unexpired GoTrue JWT still carries a valid `sub`, so the self-scoped read
--   policies (`auth.uid() = id`) and the authenticated-grantable revoke RPCs
--   still authorize it — because none of them consult session_is_live().
--
--   The fix (implementer, migration 0000000000004x) gates SIX surfaces on the
--   CALLER's live session, mirroring committee_membership_select_active
--   (00000000000002_committee.sql:149-151):
--     read policies : users_select_self, auth_sessions_select_self,
--                     webauthn_credentials_select_self
--     revoke RPCs   : revoke_my_session, revoke_all_my_sessions, revoke_my_passkey
--
-- HOW TO RUN (mirrors the sibling committee runner; sandbox has PG16 + pgTAP):
--   pg_prove -d "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     supabase/test/t05_session_live_rls.sql
--   (or, shim-style: apply local_shim.sql + migrations 0..N, then pg_prove.)
--
-- CANONICAL REVOKED-SESSION IDIOM: mirrors committee_rls.sql:114-122 —
--   set request.jwt.claims (sub + session_id=jti), seed a live auth_sessions
--   row, revoke it in-request, assert session_is_live() flips.
--
-- RED-FIRST CONTRACT (against the current `main` schema, migrations 0..45):
--   * The LIVE-baseline block (tests 1-8) is GREEN on both main and post-fix —
--     it guards against an OVER-BROAD gate (a live caller must still read own
--     rows and revoke; a live caller revoking an already-revoked target still
--     succeeds — the gate is on the CALLER, never the target).
--   * The F-121 DENIAL block (tests 10-15) is RED on main for the intended
--     reason: with a revoked-but-unexpired session the self reads still return
--     the caller's rows (should be 0) and the revoke RPCs still succeed
--     (should raise rls_denied). It goes GREEN once the six surfaces gate on
--     session_is_live().
-- ===========================================================================

BEGIN;
-- Non-secret dev/CI pseudonym key (consumed by the revoke RPCs' HMAC actor-
-- pseudonym derivation). A plain SET works for any role; a DATABASE-level
-- default is not settable on the Supabase local stack. Mirrors committee_rls.sql:19.
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';

-- Production posture: in real Supabase, `authenticated` HOLDS table-level
-- SELECT on these public tables (RLS is the only thing that restricts rows) —
-- which is exactly WHY the F-121 bypass is reachable: a revoked-but-unexpired
-- JWT still satisfies `auth.uid() = id`. The CI shim does not seed Supabase's
-- default grants, so grant them here to make RLS the deciding factor (no-op /
-- idempotent against the live stack where the grant already exists).
GRANT SELECT ON public.users, public.auth_sessions, public.webauthn_credentials
  TO authenticated;

SELECT plan(15);

-- --- Seed --------------------------------------------------------------------
-- One user (the caller under test).
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000a1', true);

-- Three sessions the caller OWNS:
--   SA (aaaa…) — the CURRENT JWT session; drives session_is_live() (the jti).
--   SB (bbbb…) — a second owned session; live-revoke target (tests 5/6).
--   SD (dddd…) — a third owned session; makes the read-count non-trivial and
--                gives revoke_all_my_sessions() something to revoke (test 8).
-- All unexpired (expires_at in the future) so ONLY revocation — never
-- expiry — is what session_is_live() keys off.
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min');

-- Two passkeys the caller OWNS:
--   CREDA — live-revoke target (test 7).
--   CREDD — read-fixture row that stays present into the denial block (test 12).
INSERT INTO public.webauthn_credentials (credential_id, user_id, public_key, rp_id) VALUES
  ('credA-live-revoke-target', '00000000-0000-0000-0000-0000000000a1', '\x00'::bytea, 'example.org'),
  ('credD-readfixture',        '00000000-0000-0000-0000-0000000000a1', '\x00'::bytea, 'example.org');

-- The caller's JWT: sub = the user, session_id = SA (the live jti).
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';

-- ===========================================================================
-- LIVE BASELINE (tests 1-8) — guards against an OVER-BROAD gate.
-- Run as the `authenticated` role so RLS policies actually apply (the
-- migrations are applied by a superuser, which would otherwise BYPASS RLS).
-- ===========================================================================
SET ROLE authenticated;

-- (1) Precondition: the caller's session is live.
SELECT ok(public.session_is_live(),
  'F-121 baseline: session_is_live() true for the caller''s unrevoked, unexpired session');

-- (2-4) A LIVE caller reads their OWN rows through each self-scoped policy.
--       Post-fix these MUST still return the rows (the gate adds a conjunct,
--       it must not hide a live caller's own data).
SELECT results_eq(
  $$SELECT count(*)::int FROM public.users$$,
  $$VALUES (1)$$,
  'F-121 baseline: live caller sees own users row (users_select_self)');
SELECT results_eq(
  $$SELECT count(*)::int FROM public.auth_sessions$$,
  $$VALUES (3)$$,
  'F-121 baseline: live caller sees own 3 sessions (auth_sessions_select_self)');
SELECT results_eq(
  $$SELECT count(*)::int FROM public.webauthn_credentials$$,
  $$VALUES (2)$$,
  'F-121 baseline: live caller sees own 2 passkeys (webauthn_credentials_select_self)');

-- (5) A LIVE caller may revoke an owned session.
SELECT lives_ok(
  $$SELECT public.revoke_my_session('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')$$,
  'F-121 baseline: live caller revokes own session (revoke_my_session succeeds)');

-- (6) GATE-ON-CALLER, NOT-ON-TARGET: a LIVE caller re-revoking an ALREADY-
--     revoked owned session still succeeds (the UPDATE is idempotent on
--     `WHERE revoked_at IS NULL`). This fails if the implementer wrongly gates
--     on the TARGET's revoked state instead of the CALLER's liveness.
SELECT lives_ok(
  $$SELECT public.revoke_my_session('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')$$,
  'F-121 baseline: live caller re-revoking an already-revoked own session is idempotent (gate is on the caller)');

-- (7) A LIVE caller may revoke an owned passkey.
SELECT lives_ok(
  $$SELECT public.revoke_my_passkey('credA-live-revoke-target')$$,
  'F-121 baseline: live caller revokes own passkey (revoke_my_passkey succeeds)');

-- (8) A LIVE caller may revoke ALL own sessions (this revokes SA too — the
--     deliberate transition into the revoked-but-unexpired state below).
SELECT lives_ok(
  $$SELECT public.revoke_all_my_sessions()$$,
  'F-121 baseline: live caller revokes all own sessions (revoke_all_my_sessions succeeds)');

RESET ROLE;

-- ===========================================================================
-- TRANSITION → revoked-but-unexpired (as the table owner; RLS-free seeding).
-- Re-seed PRISTINE denial targets so the denial block's RPC calls have a
-- valid, owned, UNREVOKED target — the ONLY reason they may be denied is the
-- caller's dead session, never ownership or not-found.
-- ===========================================================================
-- SE (eeee…) — pristine owned, unrevoked session (denial target, test 13).
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min');
-- CREDE — pristine owned passkey (denial target, test 15).
INSERT INTO public.webauthn_credentials (credential_id, user_id, public_key, rp_id) VALUES
  ('credE-denial-target', '00000000-0000-0000-0000-0000000000a1', '\x00'::bytea, 'example.org');

-- Canonical idiom (committee_rls.sql:118): revoke the caller's CURRENT session
-- explicitly. It is still UNEXPIRED (expires_at is +5 min) — so the ONLY thing
-- that makes it not-live is `revoked_at`, isolating the F-121 property.
UPDATE public.auth_sessions SET revoked_at = now()
  WHERE session_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- ===========================================================================
-- F-121 DENIAL BLOCK (tests 9-15) — RED against current `main`.
-- ===========================================================================
SET ROLE authenticated;

-- (9) Precondition: the same in-flight request is now NOT live (revoked but
--     unexpired). GREEN on main (session_is_live already exists); it exists to
--     prove the denial tests below run under a genuinely revoked session.
SELECT ok(NOT public.session_is_live(),
  'F-121: session_is_live() false immediately after revoke (revoked-but-unexpired)');

-- (10-12) F-121 READ DENIAL. The caller's OWN rows still EXIST (users row,
--         the four session rows, the two passkey rows) — a working gate must
--         HIDE them because the session is not live. RED on main: the bare
--         `auth.uid() = id` policies still return the caller's rows.
SELECT results_eq(
  $$SELECT count(*)::int FROM public.users$$,
  $$VALUES (0)$$,
  'F-121: revoked-session caller CANNOT read own users row (users_select_self must gate on session_is_live)');
SELECT results_eq(
  $$SELECT count(*)::int FROM public.auth_sessions$$,
  $$VALUES (0)$$,
  'F-121: revoked-session caller CANNOT read own auth_sessions rows (auth_sessions_select_self must gate on session_is_live)');
SELECT results_eq(
  $$SELECT count(*)::int FROM public.webauthn_credentials$$,
  $$VALUES (0)$$,
  'F-121: revoked-session caller CANNOT read own webauthn_credentials rows (webauthn_credentials_select_self must gate on session_is_live)');

-- (13-15) F-121 REVOKE DENIAL. Each target is owned + valid, so the ONLY
--         possible denial reason is the caller's dead session. RED on main:
--         the revoke wrappers do not consult session_is_live(), so they
--         SUCCEED (no throw) for a revoked caller.
SELECT throws_like(
  $$SELECT public.revoke_my_session('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')$$,
  '%rls_denied%',
  'F-121: revoked-session caller CANNOT revoke_my_session (must raise rls_denied on the caller''s dead session)');
SELECT throws_like(
  $$SELECT public.revoke_all_my_sessions()$$,
  '%rls_denied%',
  'F-121: revoked-session caller CANNOT revoke_all_my_sessions (must raise rls_denied on the caller''s dead session)');
SELECT throws_like(
  $$SELECT public.revoke_my_passkey('credE-denial-target')$$,
  '%rls_denied%',
  'F-121: revoked-session caller CANNOT revoke_my_passkey (must raise rls_denied on the caller''s dead session)');

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
