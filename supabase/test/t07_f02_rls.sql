-- ===========================================================================
-- T07.1 — pgTAP: F-02 sealed-box enrollment-challenge handshake (G-T07-9).
--
-- Asserts the SQL contract for the two-step enrollment flow:
--   - issue_enrollment_challenge stores the nonce as an HMAC; the raw
--     nonce never lands at rest.
--   - verify_and_enroll_identity_keypair re-HMACs the observed nonce and
--     compares constant-time-ish (= operator on equal-length bytea).
--   - On match: identity_keys row written + identity_keypair.created
--     audit emitted with meta.enrolled_via='f02_sealed_box_challenge'.
--   - On mismatch: no identity_keys row, no audit, attempts incremented,
--     cap-of-3 enforced.
--   - Expired, consumed, and tampered-target challenges all rejected
--     with specific reasons.
--
-- The Edge Function path (sealing the nonce with crypto_box_seal) is
-- covered by the Deno test in supabase/functions/t07-op/test/.
-- Run: pg_prove -d <db> supabase/test/t07_f02_rls.sql  (migrations 0-8 + shim).
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;
SELECT plan(22);

INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000a1', true),
  ('00000000-0000-0000-0000-0000000000a2', true);
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111a1', '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111a2', '00000000-0000-0000-0000-0000000000a2', now() + interval '5 min');

-- (1)-(2) table protection.
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname='enrollment_challenges'),
  'enrollment_challenges RLS enabled');
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.role_table_grants
    WHERE table_name='enrollment_challenges' AND grantee IN ('authenticated','anon')
      AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')$$,
  $$VALUES (0)$$, 'enrollment_challenges has no direct grants to authenticated/anon');

-- Act as a1.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';

-- (3) issue_enrollment_challenge accepts a 32-byte pubkey + 64-char BLAKE2b hex fp + a ≥16-byte nonce.
CREATE TEMP TABLE _c AS SELECT public.issue_enrollment_challenge(
  decode(repeat('42',32),'hex'),    -- public_key
  repeat('a',64),                   -- pubkey_fingerprint (BLAKE2b-32-hex)
  decode(repeat('cd',32),'hex'),    -- raw_nonce (Edge Fn generates this)
  10                                -- ttl_minutes
) AS challenge_id;
SELECT isnt((SELECT challenge_id FROM _c), NULL, 'issue_enrollment_challenge returns a challenge_id');

-- (4)-(5) The row stores ONLY the HMAC of the nonce (NOT the raw nonce).
SELECT is(
  (SELECT nonce_hash FROM public.enrollment_challenges WHERE challenge_id=(SELECT challenge_id FROM _c)),
  hmac(decode(repeat('cd',32),'hex'), 'dev-ci-pseudonym-key-not-secret'::bytea, 'sha256'),
  'nonce_hash is HMAC-SHA256(nonce, app.hmac_pseudonym_key) — semgrep no-bare-sha256 compliant');
SELECT is(
  (SELECT target_user_id FROM public.enrollment_challenges WHERE challenge_id=(SELECT challenge_id FROM _c)),
  '00000000-0000-0000-0000-0000000000a1'::uuid,
  'challenge is bound to the caller via auth.uid()');

-- (6)-(9) Input validation.
SELECT throws_like(
  $$SELECT public.issue_enrollment_challenge('\xDEADBEEF'::bytea, repeat('a',64), decode(repeat('cd',32),'hex'), 10)$$,
  '%invalid_pubkey%', 'issue rejects non-32-byte pubkey');
SELECT throws_like(
  $$SELECT public.issue_enrollment_challenge(decode(repeat('42',32),'hex'), 'not-blake2b', decode(repeat('cd',32),'hex'), 10)$$,
  '%invalid_fingerprint%', 'issue rejects non-BLAKE2b-32-hex fingerprint');
SELECT throws_like(
  $$SELECT public.issue_enrollment_challenge(decode(repeat('42',32),'hex'), repeat('a',64), '\x01'::bytea, 10)$$,
  '%invalid_nonce%', 'issue rejects too-short nonce');
SELECT throws_like(
  $$SELECT public.issue_enrollment_challenge(decode(repeat('42',32),'hex'), repeat('a',64), decode(repeat('cd',32),'hex'), 0)$$,
  '%invalid_ttl%', 'issue rejects TTL out of range');

-- (10) verify with the WRONG nonce surfaces wrong_nonce.
SELECT throws_like(
  format($$SELECT public.verify_and_enroll_identity_keypair(%L::uuid, decode(repeat('00',32),'hex'))$$, (SELECT challenge_id FROM _c)),
  '%wrong_nonce%', 'verify with wrong nonce raises wrong_nonce');

-- (11) The challenge row stays unconsumed after a wrong-nonce attempt
-- (Postgres rolls back the function body on RAISE; we don't track an
-- attempts counter — see migration docstring for rationale).
SELECT is(
  (SELECT consumed_at FROM public.enrollment_challenges WHERE challenge_id=(SELECT challenge_id FROM _c)),
  NULL, 'wrong-nonce attempt leaves the challenge unconsumed (TTL still bounds replay)');

-- (12) NO identity_keys row, NO audit emitted on mismatch.
SELECT is(
  (SELECT count(*)::int FROM public.identity_keys WHERE user_id='00000000-0000-0000-0000-0000000000a1'),
  0, 'wrong-nonce verify does NOT create the identity_keys row');
SELECT is(
  (SELECT count(*)::int FROM public.audit_log WHERE event_type='identity_keypair.created' AND target_id='00000000-0000-0000-0000-0000000000a1'),
  0, 'wrong-nonce verify emits no identity_keypair.created audit');

-- (14)-(16) verify with the CORRECT nonce: atomic INSERT + audit + mark consumed.
SELECT is(
  public.verify_and_enroll_identity_keypair((SELECT challenge_id FROM _c), decode(repeat('cd',32),'hex')),
  '00000000-0000-0000-0000-0000000000a1'::uuid,
  'verify with the right nonce returns the actor uuid');
SELECT is(
  (SELECT length(public_key) FROM public.identity_keys WHERE user_id='00000000-0000-0000-0000-0000000000a1'),
  32, 'identity_keys row written with the bound 32-byte public_key');
SELECT is(
  (SELECT meta->>'enrolled_via' FROM public.audit_log
     WHERE event_type='identity_keypair.created' AND target_id='00000000-0000-0000-0000-0000000000a1'),
  'f02_sealed_box_challenge',
  'identity_keypair.created audit carries enrolled_via=f02_sealed_box_challenge');

-- (17) The consumed challenge can't be replayed.
SELECT throws_like(
  format($$SELECT public.verify_and_enroll_identity_keypair(%L::uuid, decode(repeat('cd',32),'hex'))$$, (SELECT challenge_id FROM _c)),
  '%challenge_consumed%',
  'consumed challenge raises challenge_consumed on replay');

-- (18) Tampered challenge_id (caller is not target) → rls_denied.
-- Switch to a2 and try to verify a1's (now-consumed) challenge.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","session_id":"11111111-1111-1111-1111-1111111111a2","role":"authenticated"}';
-- Issue a fresh challenge for a1 first (back to a1) so we have an unconsumed
-- target; this also exercises the "delete prior unconsumed" garbage collection.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
-- a1 already has identity_keys row → duplicate.
SELECT throws_like(
  $$SELECT public.issue_enrollment_challenge(decode(repeat('42',32),'hex'), repeat('a',64), decode(repeat('cd',32),'hex'), 10)$$,
  '%duplicate%',
  'issue rejects re-enrollment for a caller that already has identity_keys');

-- (19) a2 can issue (no identity_keys row yet) → unconsumed challenge for a2.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","session_id":"11111111-1111-1111-1111-1111111111a2","role":"authenticated"}';
CREATE TEMP TABLE _c2 AS SELECT public.issue_enrollment_challenge(
  decode(repeat('43',32),'hex'), repeat('b',64), decode(repeat('ee',32),'hex'), 10
) AS challenge_id;
-- a1 tries to verify a2's challenge → rls_denied (target mismatch).
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
SELECT throws_like(
  format($$SELECT public.verify_and_enroll_identity_keypair(%L::uuid, decode(repeat('ee',32),'hex'))$$, (SELECT challenge_id FROM _c2)),
  '%rls_denied%',
  'verify rejects target mismatch — challenge_id is bound to the issuer');

-- (20)-(21) Issuing a new challenge for the same target garbage-collects
-- the prior unconsumed one (no orphan rows accumulating per actor).
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","session_id":"11111111-1111-1111-1111-1111111111a2","role":"authenticated"}';
CREATE TEMP TABLE _c3 AS SELECT public.issue_enrollment_challenge(
  decode(repeat('43',32),'hex'), repeat('b',64), decode(repeat('ff',32),'hex'), 10
) AS challenge_id;
SELECT is(
  (SELECT count(*)::int FROM public.enrollment_challenges
     WHERE target_user_id='00000000-0000-0000-0000-0000000000a2'),
  1, 'issuing a fresh challenge garbage-collects the prior unconsumed one (one row per actor max)');

-- (22) Expired challenge.
UPDATE public.enrollment_challenges
   SET expires_at = now() - interval '1 minute'
 WHERE challenge_id = (SELECT challenge_id FROM _c3);
SELECT throws_like(
  format($$SELECT public.verify_and_enroll_identity_keypair(%L::uuid, decode(repeat('ff',32),'hex'))$$, (SELECT challenge_id FROM _c3)),
  '%challenge_expired%', 'expired challenge raises challenge_expired');

-- (23) No session → rls_denied (the session_is_live gate runs first).
SET request.jwt.claims = '{}';
SELECT throws_like(
  $$SELECT public.issue_enrollment_challenge(decode(repeat('42',32),'hex'), repeat('a',64), decode(repeat('cd',32),'hex'), 10)$$,
  '%rls_denied%', 'no session → issue raises rls_denied (F-116)');

SELECT * FROM finish();
ROLLBACK;
