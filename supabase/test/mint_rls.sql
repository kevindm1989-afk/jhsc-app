-- ===========================================================================
-- T05.1 — pgTAP: mint-session DB layer (ADR-0023 / threat-model §3.12).
--
-- Proves the least-privilege mint path: only `mint_writer` may invoke the
-- mint_* RPCs (anon/authenticated cannot mint a session — F-117/F-119), the
-- login challenge is single-use + TTL-bounded, and the jti row lands in
-- auth_sessions (F-116). Run:
--   pg_prove -d <db> supabase/test/mint_rls.sql
-- ===========================================================================

BEGIN;
SELECT plan(14);

-- Seed: a user + one registered passkey credential.
INSERT INTO public.users (id, active)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true);
INSERT INTO public.webauthn_credentials (credential_id, user_id, public_key, rp_id)
  VALUES ('cred-mint-1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '\xdeadbeef'::bytea, 'app.example.test');

-- (1) the dedicated role exists; (2) the challenge table is RLS-locked.
SELECT has_role('mint_writer', 'mint_writer role exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname = 'auth_challenges'),
  'auth_challenges has RLS enabled');

-- (3)-(6) grant matrix: only mint_writer may reach the mint path.
SELECT ok(has_function_privilege('mint_writer',
  'public.mint_create_session(uuid, timestamptz)', 'EXECUTE'),
  'mint_writer may execute mint_create_session');
SELECT ok(NOT has_function_privilege('anon',
  'public.mint_create_session(uuid, timestamptz)', 'EXECUTE'),
  'anon may NOT execute mint_create_session');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.mint_create_session(uuid, timestamptz)', 'EXECUTE'),
  'authenticated may NOT execute mint_create_session');
SELECT ok(NOT has_function_privilege('anon',
  'public.mint_issue_challenge(text, text, integer)', 'EXECUTE'),
  'anon may NOT issue a login challenge');

-- (7)-(9) challenge lifecycle: single-use + expiry. Capture one live challenge.
CREATE TEMP TABLE _mc AS
  SELECT public.mint_issue_challenge('app.example.test', 'https://app.example.test') AS ch;
SELECT is((SELECT public.mint_consume_challenge(ch) FROM _mc), true,
  'a fresh challenge is consumed once');
SELECT is((SELECT public.mint_consume_challenge(ch) FROM _mc), false,
  'the same challenge cannot be consumed twice (single-use)');
INSERT INTO public.auth_challenges (challenge, rp_id, origin, expires_at)
  VALUES ('expired-xyz', 'app.example.test', 'https://app.example.test', now() - interval '1 minute');
SELECT is(public.mint_consume_challenge('expired-xyz'), false,
  'an expired challenge cannot be consumed');

-- (10) credential → uid resolves server-side (F-117/F-119).
SELECT is((SELECT user_id FROM public.mint_lookup_credential('cred-mint-1')),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'::uuid,
  'mint_lookup_credential resolves the owning uid');

-- (11)-(12) session creation writes the jti row (F-116).
SELECT isnt(public.mint_create_session(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'::uuid, now() + interval '5 minutes'),
  NULL, 'mint_create_session returns a session_id');
SELECT ok(EXISTS(SELECT 1 FROM public.auth_sessions
    WHERE user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'),
  'the jti row is written to auth_sessions');

-- (13)-(14) signature counter is monotonic (WebAuthn clone detection).
SELECT public.mint_bump_counter('cred-mint-1', 7);
SELECT is((SELECT counter FROM public.webauthn_credentials WHERE credential_id = 'cred-mint-1'),
  7::bigint, 'mint_bump_counter raises the counter');
SELECT public.mint_bump_counter('cred-mint-1', 3);
SELECT is((SELECT counter FROM public.webauthn_credentials WHERE credential_id = 'cred-mint-1'),
  7::bigint, 'mint_bump_counter never decreases the counter');

-- The runtime privilege boundary is asserted above via has_function_privilege
-- (portable, no role switching — the live-stack pg_prove role cannot SET ROLE).

SELECT * FROM finish();
ROLLBACK;
