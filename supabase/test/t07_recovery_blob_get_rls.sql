-- ===========================================================================
-- T07.1 — pgTAP: get_recovery_blob_for_self (F-08 restore-flow read path).
-- Asserts the session-live gate + self-only structural posture (no parameter
-- means no way to ask for someone else's blob; we still verify the row a1
-- gets is a1's own).
-- Run: pg_prove -d <db> supabase/test/t07_recovery_blob_get_rls.sql
--   (migrations 0-10 + shim).
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;
SELECT plan(7);

INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000a1', true),
  ('00000000-0000-0000-0000-0000000000a2', true);
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111a1', '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111a2', '00000000-0000-0000-0000-0000000000a2', now() + interval '5 min');

-- Seed: a1 stores a recovery blob; a2 stores a different one.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
SELECT lives_ok(
  $$SELECT public.store_recovery_blob(
    decode(rpad('a1',(16+24+8)*2,'a1'),'hex'),
    '{"alg":"argon2id13","version":1}'::jsonb)$$,
  'seed: a1 stores their blob');
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","session_id":"11111111-1111-1111-1111-1111111111a2","role":"authenticated"}';
SELECT lives_ok(
  $$SELECT public.store_recovery_blob(
    decode(rpad('a2',(16+24+8)*2,'a2'),'hex'),
    '{"alg":"argon2id13","version":2}'::jsonb)$$,
  'seed: a2 stores their blob');

-- (3) No session → rls_denied.
SET request.jwt.claims = '{}';
SELECT throws_like(
  $$SELECT * FROM public.get_recovery_blob_for_self()$$,
  '%rls_denied%',
  'no session → get_recovery_blob_for_self raises rls_denied (F-116)');

-- (4) a1 gets exactly a1's blob (NOT a2's).
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
SELECT is(
  (SELECT blob_ciphertext FROM public.get_recovery_blob_for_self() LIMIT 1),
  decode(rpad('a1',(16+24+8)*2,'a1'),'hex'),
  'a1 gets their own blob_ciphertext back (structurally self-only)');
SELECT is(
  (SELECT kdf_params->>'version' FROM public.get_recovery_blob_for_self() LIMIT 1),
  '1',
  'a1 gets their own kdf_params (version=1)');

-- (5) a2 gets exactly a2's blob.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","session_id":"11111111-1111-1111-1111-1111111111a2","role":"authenticated"}';
SELECT is(
  (SELECT kdf_params->>'version' FROM public.get_recovery_blob_for_self() LIMIT 1),
  '2',
  'a2 gets their own kdf_params (version=2; NOT a1''s version=1)');

-- (7) A caller with NO recovery blob row returns zero rows (no error).
INSERT INTO public.users (id, active) VALUES ('00000000-0000-0000-0000-0000000000b1', true);
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111b1', '00000000-0000-0000-0000-0000000000b1', now() + interval '5 min');
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","session_id":"11111111-1111-1111-1111-1111111111b1","role":"authenticated"}';
SELECT is(
  (SELECT count(*)::int FROM public.get_recovery_blob_for_self()),
  0,
  'a user with no recovery_blobs row gets zero rows (not an error)');

SELECT * FROM finish();
ROLLBACK;
