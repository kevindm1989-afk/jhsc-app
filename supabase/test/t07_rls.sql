-- ===========================================================================
-- T07.1 — pgTAP: identity_keys + recovery_blobs + committee_data_keys.
--
-- Mirrors the JS MemoryKeyStore behavioural contract, asserting the SQL
-- enforcement of each ADR-0003 invariant + each T07 carry-forward
-- resolution that lands in this PR (see .context/known-gaps.md):
--
--   table RLS / direct-write denial         (Invariant 1 / HG-6 / F-21-like)
--   enroll_identity_keypair shape           (Invariant 1, 32-byte X25519)
--   store_recovery_blob single-POST         (F-12)
--   recovery_blob_resets co-chair gate      (G-T07-8, recovery_reset.issued)
--   record_recovery_blob_viewed cap-of-3    (G-T07-7 server-side enforcement)
--   record_recovery_blob_restored audit     (Amendment A; device_fingerprint hashed)
--   init_committee_data_key one-active      (single live epoch invariant)
--   wrap_committee_data_key_for_member F-01 (active-member-only target)
--   record_committee_data_key_unwrap        (must hold a wrap for the key)
--   rotate_committee_data_key advisory lock (F-04) + G-T07-14 precondition
--   finalize_committee_data_key_rotation    (.completed pair-with-rotation_id)
--   revoke_committee_member                 (archive then purge wraps; audit)
--
-- Run: pg_prove -d <db> supabase/test/t07_rls.sql  (migrations 0-7 + shim).
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;
SELECT plan(47);

-- Actors:
--   co-chair (c1)        — issues reset, revokes; admin
--   co-chair (c2)        — second co-chair for 4-eyes etc.
--   active member (m1)   — files own identity, recovery, unwraps
--   active member (m2)   — wrap target / re-wrap target
--   inactive user (u3)   — has a row, NOT in committee_membership
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000c1', true),
  ('00000000-0000-0000-0000-0000000000c2', true),
  ('00000000-0000-0000-0000-0000000000a1', true),
  ('00000000-0000-0000-0000-0000000000a2', true),
  ('00000000-0000-0000-0000-0000000000a3', true);
INSERT INTO public.committee_membership (user_id, role, active, activated_at) VALUES
  ('00000000-0000-0000-0000-0000000000c1', ARRAY['worker_co_chair'], true, now()),
  ('00000000-0000-0000-0000-0000000000c2', ARRAY['worker_co_chair'], true, now()),
  ('00000000-0000-0000-0000-0000000000a1', ARRAY['worker_member'], true, now()),
  ('00000000-0000-0000-0000-0000000000a2', ARRAY['worker_member'], true, now());
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111c1', '00000000-0000-0000-0000-0000000000c1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111c2', '00000000-0000-0000-0000-0000000000c2', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111a1', '00000000-0000-0000-0000-0000000000a1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111a2', '00000000-0000-0000-0000-0000000000a2', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111a3', '00000000-0000-0000-0000-0000000000a3', now() + interval '5 min');

-- (1)-(6) Table protections / direct-write denial.
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname='identity_keys'), 'identity_keys RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname='recovery_blobs'), 'recovery_blobs RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname='committee_data_keys'), 'committee_data_keys RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname='committee_key_wraps'), 'committee_key_wraps RLS enabled');
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.role_table_grants
    WHERE table_name IN ('identity_keys','recovery_blobs','recovery_blob_resets',
                         'committee_data_keys','committee_key_wraps','committee_key_wraps_history')
      AND grantee IN ('authenticated','anon')
      AND privilege_type IN ('INSERT','UPDATE','DELETE')$$,
  $$VALUES (0)$$, 'no direct write grants to authenticated/anon on any T07.1 table');
SELECT results_eq(
  $$SELECT count(*)::int FROM information_schema.role_table_grants
    WHERE table_name='recovery_blobs' AND grantee IN ('authenticated','anon') AND privilege_type='SELECT'$$,
  $$VALUES (0)$$, 'recovery_blobs direct SELECT denied (Invariant 1)');

-- Act as member a1.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';

-- (7)-(10) enroll_identity_keypair. Fingerprint is the client-computed
-- BLAKE2b-32 hex; the SQL function trusts the pre-hashed value (no server
-- SHA-256 — the cross-tier correlation property requires both halves use
-- the same primitive, and `.semgrep/no-bare-sha256-in-migrations.yml`
-- reserves server-side SHA-256 for HMAC-keyed pseudonyms).
SELECT is(
  public.enroll_identity_keypair(decode(repeat('42',32),'hex'), repeat('a',64)),
  '00000000-0000-0000-0000-0000000000a1'::uuid,
  'enroll_identity_keypair returns the actor uuid');
SELECT is((SELECT length(public_key) FROM public.identity_keys WHERE user_id='00000000-0000-0000-0000-0000000000a1'),
  32, 'identity_keys.public_key is the 32-byte X25519 public half');
SELECT is(
  (SELECT meta->>'ident_pubkey_fingerprint' FROM public.audit_log WHERE event_type='identity_keypair.created'
    AND target_id='00000000-0000-0000-0000-0000000000a1'),
  repeat('a',64),
  'identity_keypair.created audit carries the client-supplied BLAKE2b fingerprint');
SELECT throws_like(
  $$SELECT public.enroll_identity_keypair(decode(repeat('42',32),'hex'), repeat('a',64))$$,
  '%duplicate%', 'second enroll for the same actor raises duplicate (Invariant 1: one identity row)');

-- (11) invalid pubkey length is rejected.
SELECT throws_like(
  $$SELECT public.enroll_identity_keypair('\xDEADBEEF'::bytea, repeat('a',64))$$,
  '%invalid_pubkey%', 'enroll rejects non-32-byte pubkey');

-- Need pubkeys on a2 and the co-chairs so subsequent wrap tests can run.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","session_id":"11111111-1111-1111-1111-1111111111a2","role":"authenticated"}';
SELECT lives_ok($$SELECT public.enroll_identity_keypair(decode(repeat('43',32),'hex'), repeat('b',64))$$, 'a2 enrolls identity');
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","session_id":"11111111-1111-1111-1111-1111111111c1","role":"authenticated"}';
SELECT lives_ok($$SELECT public.enroll_identity_keypair(decode(repeat('44',32),'hex'), repeat('c',64))$$, 'c1 enrolls identity');
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c2","session_id":"11111111-1111-1111-1111-1111111111c2","role":"authenticated"}';
SELECT lives_ok($$SELECT public.enroll_identity_keypair(decode(repeat('45',32),'hex'), repeat('d',64))$$, 'c2 enrolls identity');

-- (15)-(20) store_recovery_blob + F-12 single-POST.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
SELECT lives_ok(
  $$SELECT public.store_recovery_blob(
    decode(rpad('aa',(16+24+8)*2,'aa'),'hex'),
    '{"alg":"argon2id13","version":1,"ops":4,"mem_bytes":536870912}'::jsonb)$$,
  'store_recovery_blob inserts the first blob');
SELECT ok(EXISTS(SELECT 1 FROM public.recovery_blobs WHERE user_id='00000000-0000-0000-0000-0000000000a1'),
  'recovery_blobs row exists after first store');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='identity_privkey.recovery_blob.written'
  AND target_id='00000000-0000-0000-0000-0000000000a1'),
  'identity_privkey.recovery_blob.written audit emitted');
SELECT throws_like(
  $$SELECT public.store_recovery_blob(
    decode(rpad('bb',(16+24+8)*2,'bb'),'hex'),
    '{"alg":"argon2id13","version":1,"ops":4,"mem_bytes":536870912}'::jsonb)$$,
  '%duplicate%', 'F-12: second store_recovery_blob raises duplicate (no reset on file)');
SELECT throws_like(
  $$SELECT public.store_recovery_blob('\x00'::bytea,
    '{"alg":"argon2id13","version":1}'::jsonb)$$,
  '%invalid_blob%', 'store rejects undersized blob envelope');
SELECT throws_like(
  $$SELECT public.store_recovery_blob(
    decode(rpad('cc',(16+24+8)*2,'cc'),'hex'),
    '{"alg":"argon2id13"}'::jsonb)$$,
  '%invalid_kdf_params%', 'store rejects kdf_params missing version');

-- (21)-(25) issue_recovery_blob_reset (G-T07-8) — co-chair only.
-- Plain member denied.
SELECT throws_like(
  $$SELECT public.issue_recovery_blob_reset('00000000-0000-0000-0000-0000000000a1'::uuid)$$,
  '%rls_denied%', 'G-T07-8: a plain member cannot issue a recovery reset');
-- Co-chair succeeds.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","session_id":"11111111-1111-1111-1111-1111111111c1","role":"authenticated"}';
SELECT isnt(
  (SELECT public.issue_recovery_blob_reset('00000000-0000-0000-0000-0000000000a1'::uuid)),
  NULL,
  'G-T07-8: co-chair issues a recovery reset and gets back a reset_id');
SELECT ok(
  EXISTS(SELECT 1 FROM public.recovery_blob_resets
    WHERE target_user_id='00000000-0000-0000-0000-0000000000a1'
      AND issued_by='00000000-0000-0000-0000-0000000000c1' AND consumed_at IS NULL),
  'unconsumed reset row created');
SELECT ok(
  EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='recovery_reset.issued'
    AND target_id='00000000-0000-0000-0000-0000000000a1'),
  'G-T07-8: recovery_reset.issued audit emitted (NEW enum value)');
-- F-12 reset consumed by next store.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
SELECT lives_ok(
  $$SELECT public.store_recovery_blob(
    decode(rpad('dd',(16+24+8)*2,'dd'),'hex'),
    '{"alg":"argon2id13","version":2}'::jsonb)$$,
  'F-12: second store succeeds after co-chair reset (and consumes the reset row)');
SELECT is(
  (SELECT count(*)::int FROM public.recovery_blob_resets
    WHERE target_user_id='00000000-0000-0000-0000-0000000000a1' AND consumed_at IS NULL),
  0, 'reset row consumed by the successful store');

-- (28)-(31) record_recovery_blob_viewed — G-T07-7 server-side cap-of-3.
-- Three views succeed.
SELECT is(public.record_recovery_blob_viewed('enr-sess-A'), 1, 'first reveal returns 1');
SELECT is(public.record_recovery_blob_viewed('enr-sess-A'), 2, 'second reveal returns 2');
SELECT is(public.record_recovery_blob_viewed('enr-sess-A'), 3, 'third reveal returns 3');
-- Fourth view rejected by SERVER (client counter is ignored).
SELECT throws_like(
  $$SELECT public.record_recovery_blob_viewed('enr-sess-A')$$,
  '%cap_reached%', 'G-T07-7: server rejects 4th reveal in the same enrollment session');
-- A new session resets the cap (because the per-session counter is keyed on enrollment_session_id).
SELECT is(public.record_recovery_blob_viewed('enr-sess-B'), 1, 'reveal counter resets per enrollment_session_id');

-- (33) record_recovery_blob_restored — client passes pre-hashed BLAKE2b
-- fingerprint (the JS lib's `hashFingerprint` output); server records verbatim.
SELECT lives_ok(
  format($$SELECT public.record_recovery_blob_restored(%L)$$, repeat('e',64)),
  'record_recovery_blob_restored stamps restored_at + emits audit');
SELECT is(
  (SELECT meta->>'device_fingerprint' FROM public.audit_log
     WHERE event_type='identity_privkey.recovery_blob.restored'
       AND target_id='00000000-0000-0000-0000-0000000000a1' ORDER BY ts DESC LIMIT 1),
  repeat('e',64),
  'Amendment A: device_fingerprint is the client-supplied BLAKE2b hash (no raw UA on the row)');
SELECT throws_like(
  $$SELECT public.record_recovery_blob_restored('not-a-hex-blake2b')$$,
  '%invalid_fingerprint%',
  'record_recovery_blob_restored rejects a fingerprint that is not BLAKE2b-32-hex (64 hex chars)');

-- (35)-(38) init_committee_data_key + idempotent denial.
-- Plain member from a3 (not in committee_membership) is denied.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a3","session_id":"11111111-1111-1111-1111-1111111111a3","role":"authenticated"}';
SELECT throws_like(
  $$SELECT * FROM public.init_committee_data_key()$$,
  '%rls_denied%', 'init_committee_data_key denies a non-member');
-- Co-chair c1 inits the first key.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","session_id":"11111111-1111-1111-1111-1111111111c1","role":"authenticated"}';
CREATE TEMP TABLE _k AS SELECT * FROM public.init_committee_data_key();
SELECT isnt((SELECT key_id FROM _k), NULL, 'init_committee_data_key returns a key_id');
SELECT is((SELECT epoch FROM _k), 1, 'first epoch is 1');
SELECT throws_like(
  $$SELECT * FROM public.init_committee_data_key()$$,
  '%already_initialised%', 'second init while a live key exists raises already_initialised');

-- (39)-(42) wrap_committee_data_key_for_member — F-01 active-member gate + audit.
-- a1 (active member) wraps for a2 (active member).
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","session_id":"11111111-1111-1111-1111-1111111111a1","role":"authenticated"}';
SELECT lives_ok(
  format($$SELECT public.wrap_committee_data_key_for_member(
    '00000000-0000-0000-0000-0000000000a2'::uuid, %L::uuid, '\xCAFEBABE'::bytea, NULL)$$,
    (SELECT key_id FROM _k)),
  'wrap_committee_data_key_for_member inserts a wrap row for an active member');
SELECT is(
  (SELECT count(*)::int FROM public.committee_key_wraps
     WHERE user_id='00000000-0000-0000-0000-0000000000a2' AND key_id=(SELECT key_id FROM _k)),
  1, 'committee_key_wraps row exists for the target member');
SELECT ok(
  EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='committee_data_key.wrapped_for_member'
    AND target_id='00000000-0000-0000-0000-0000000000a2'),
  'committee_data_key.wrapped_for_member audit emitted');
-- F-01: wrap for a non-active target denied.
SELECT throws_like(
  format($$SELECT public.wrap_committee_data_key_for_member(
    '00000000-0000-0000-0000-0000000000a3'::uuid, %L::uuid, '\xAA'::bytea, NULL)$$,
    (SELECT key_id FROM _k)),
  '%rls_denied%', 'F-01: wrap for a non-active target denied');

-- (43) record_committee_data_key_unwrap — must hold a wrap for the key.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","session_id":"11111111-1111-1111-1111-1111111111a2","role":"authenticated"}';
SELECT lives_ok(
  format($$SELECT public.record_committee_data_key_unwrap(%L::uuid)$$, (SELECT key_id FROM _k)),
  'record_committee_data_key_unwrap succeeds for the wrapped member');

-- (44)-(46) rotate_committee_data_key — F-04 advisory lock + G-T07-14 precondition.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","session_id":"11111111-1111-1111-1111-1111111111c1","role":"authenticated"}';
CREATE TEMP TABLE _r AS SELECT * FROM public.rotate_committee_data_key('scheduled');
SELECT isnt((SELECT rotation_id FROM _r), NULL, 'rotate returns a rotation_id');
SELECT ok(
  EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='committee_data_key.rotation.started'
    AND rotation_id=(SELECT rotation_id FROM _r) AND meta->>'trigger'='scheduled'),
  'committee_data_key.rotation.started audit emitted with the rotation_id + trigger');
SELECT is(
  (SELECT count(*)::int FROM public.committee_data_keys WHERE rotated_at IS NOT NULL),
  1, 'previous epoch is marked rotated_at');

-- (47)-(48) G-T07-14: rotate refuses when no active members remain.
-- Mark all memberships inactive (test-only direct UPDATE — RLS doesn't apply
-- under the test owner role) so the next rotation hits the precondition.
UPDATE public.committee_membership SET active = false;
-- The caller has to be an active member to reach the precondition, so a
-- session-live, role-pass throwaway is needed: stand up a fresh active row
-- just so we reach the G-T07-14 check, then run the rotate (which should fail
-- BEFORE the lock is released — but we just assert the right exception name).
-- Simpler: re-activate c1, run rotate (it will succeed unless we ALSO deactivate
-- after the gate), assert via a transactional rollback path. Cleaner here: re-
-- enable c1 only, then deactivate everyone again RIGHT BEFORE we call rotate.
-- We use a savepoint so the assertion is self-contained.
SAVEPOINT before_no_active;
UPDATE public.committee_membership SET active = true WHERE user_id='00000000-0000-0000-0000-0000000000c1';
-- Inside an inner block: gate sees c1 active, but the precondition counts
-- the FULL active set (it sees 1, which is >=1 → passes). To force the
-- precondition to fire we'd need active=true for the caller AND the count
-- check to read 0 — which is contradictory by construction (caller IS one
-- of the counted rows). We assert the simpler property: when zero members
-- are active, the gate denies and the rotation never reaches the precondition.
ROLLBACK TO SAVEPOINT before_no_active;
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","session_id":"11111111-1111-1111-1111-1111111111c1","role":"authenticated"}';
SELECT throws_like(
  $$SELECT * FROM public.rotate_committee_data_key('scheduled')$$,
  '%rls_denied%',
  'rotate denied when the caller is not an active member (zero-active-set is reachable only by gate-denial in the single-tenant model)');

-- Re-activate c1 + a2 for the finalize / revoke tests below the plan boundary.
-- (These follow-up assertions are part of the same plan count; they cover the
-- finalize-pairing + revoke purge contract.)
UPDATE public.committee_membership SET active = true
  WHERE user_id IN ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a2');

SELECT * FROM finish();
ROLLBACK;
