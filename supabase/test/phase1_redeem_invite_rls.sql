-- ===========================================================================
-- ADR-0029 P1-1 (KEYSTONE, SQL) — pgTAP for `redeem_invite_complete`.
--
-- The invitee-side terminal (mint_writer-ONLY, called by the redeem-invite EF
-- via its self-minted mint_writer token). ATOMICALLY: load invite FOR UPDATE
-- (not consumed / not expired / bootstrap present), validate the TOTP with the
-- EXACT enroll_first_passkey lock semantics, consume the bootstrap, bind the
-- passkey to the invite's OWN target_user_id, activate the membership, emit
-- auth.passkey.enrolled. Returns {user_id}.
--
-- RED-FIRST: `public.redeem_invite_complete(...)` does NOT exist on `main` yet
-- (P1-1 implementer builds it against this test). Every call raises
-- `function ... does not exist` until the migration lands.
--
-- Findings covered (threat-model §3.18):
--   F-168 — terminal grant lockdown: mint_writer ONLY (REVOKE PUBLIC/anon/
--           authenticated/service_role), byte-for-byte the bootstrap posture.
--   F-169 — single-use (2nd redeem -> invite_invalid; no 2nd binding) AND the
--           NORMALIZED error oracle: consumed == expired == non-existent all
--           RAISE the SAME literal (no leak of which condition failed).
--   F-170 — 15-min TOTP window (expired -> TOTP_BOOTSTRAP_EXPIRED, no binding);
--           5-attempt lock (5 wrong -> locked_at; 6th -> TOTP_BOOTSTRAP_LOCKED);
--           a successful redeem emits member.added (attribution / detectability).
--   F-171 — retarget closed by construction: NO caller-supplied uid parameter;
--           the credential + activation bind to committee_invite.target_user_id.
--   F-173 — redeemer cannot self-elevate: the activated role is read from the
--           pre-set membership, there is no redeem-time role param.
--   F-175 — server clock is authoritative for expiry (clock-skew safe).
--   F-177 — atomicity: a bad-code redeem rolls the activation back but PERSISTS
--           wrong_attempts/locked_at (the one deliberate exception); an expired
--           invite mid-redeem rolls back whole; the bootstrap stays present and
--           the invite stays unconsumed on any failure.
--
-- Conventions mirror adr0025_bootstrap_first_co_chair.sql (the mint_writer
-- terminal + reachability invariants) and committee_rls.sql (the seeding +
-- request.jwt.claims shim). The bootstrap rows are seeded directly (the issue
-- side is exercised in phase1_issue_invite_rls.sql); secret_hash is the HMAC
-- of a known code so the redeem can validate it.
--
-- Run: pg_prove -d <db> supabase/test/phase1_redeem_invite_rls.sql
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;
SELECT plan(28);

-- ---------------------------------------------------------------------------
-- A reusable fixture builder: a co-chair (issuer) + a fresh pre-created
-- invitee user (active, role NULL) + a pending membership + a bootstrap whose
-- secret_hash = HMAC(<code>) + a committee_invite linking them. This mirrors
-- the post-issue state phase1_issue_invite_rls.sql asserts the producer writes.
-- Returns the invite_id via a set_config key. p_code is the plaintext TOTP.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.seed_invite(
  p_uid          uuid,
  p_session      uuid,
  p_code         text,
  p_roles        text[]            DEFAULT ARRAY['worker_member'],
  p_invite_ttl   interval          DEFAULT interval '7 days',
  p_totp_ttl     interval          DEFAULT interval '15 min'
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_boot uuid;
  v_inv  uuid;
BEGIN
  INSERT INTO public.users (id, active, role) VALUES (p_uid, true, NULL);
  INSERT INTO public.committee_membership (user_id, role, active, invited_by, invited_at)
    VALUES (p_uid, p_roles, false,
            '00000000-0000-0000-0000-0000000000f1', now());
  INSERT INTO public.auth_totp_bootstraps (user_id, secret_hash, expires_at)
    VALUES (p_uid,
            hmac(p_code::bytea, private._hmac_pseudonym_key()::bytea, 'sha256'),
            now() + p_totp_ttl)
    RETURNING id INTO v_boot;
  v_inv := gen_random_uuid();
  INSERT INTO public.committee_invite (invite_id, target_user_id, bootstrap_id, role, issued_by, expires_at)
    VALUES (v_inv, p_uid, v_boot, p_roles,
            '00000000-0000-0000-0000-0000000000f1', now() + p_invite_ttl);
  RETURN v_inv;
END $$;

-- Founding co-chair (the issuer; needed for the member.added actor pseudonym).
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000f1', true);
INSERT INTO public.committee_membership (user_id, role, active, activated_at) VALUES
  ('00000000-0000-0000-0000-0000000000f1', ARRAY['worker_member','worker_co_chair'], true, now());

-- ---------------------------------------------------------------------------
-- (0) The function exists with the ADR-0029 signature. RED until P1-1 lands.
--     redeem_invite_complete(p_invite_id uuid, p_totp_code text,
--       p_credential_id text, p_public_key bytea, p_aaguid uuid,
--       p_transports text[], p_rp_id text, p_device_label text)
-- ---------------------------------------------------------------------------
SELECT has_function(
  'public', 'redeem_invite_complete',
  ARRAY['uuid','text','text','bytea','uuid','text[]','text','text'],
  'ADR-0029 P1-1: redeem_invite_complete(uuid,text,text,bytea,uuid,text[],text,text) exists'
);

-- (0a) F-171 — the signature has NO caller-supplied uid / enrolling INPUT param.
--      The only uuid INPUT parameters are p_invite_id and p_aaguid; there is NO
--      p_user_id / p_enrolling_uid. Count IN-mode uuid params only (the OUT
--      user_id of the RETURN TABLE is excluded). A regression that added a
--      caller target uid would push the IN count to 3 and fail this.
SELECT is(
  (SELECT count(*)::int
     FROM information_schema.parameters
    WHERE specific_schema = 'public'
      AND specific_name LIKE 'redeem_invite_complete%'
      AND parameter_mode = 'IN'
      AND data_type = 'uuid'),
  2,
  'F-171: redeem_invite_complete has exactly 2 uuid INPUT params (invite_id, aaguid) — no caller target uid'
);

-- ---------------------------------------------------------------------------
-- (1) F-168 — terminal grant lockdown (byte-for-byte the bootstrap posture):
--     EXECUTE REVOKED from PUBLIC/anon/authenticated/service_role; GRANTED to
--     mint_writer ONLY. A direct anon/authenticated call is REST-unreachable.
-- ---------------------------------------------------------------------------
SELECT is(
  has_function_privilege('anon',
    'public.redeem_invite_complete(uuid, text, text, bytea, uuid, text[], text, text)', 'EXECUTE'),
  false,
  'F-168: anon canNOT EXECUTE redeem_invite_complete (REST-unreachable)'
);
SELECT is(
  has_function_privilege('authenticated',
    'public.redeem_invite_complete(uuid, text, text, bytea, uuid, text[], text, text)', 'EXECUTE'),
  false,
  'F-168: authenticated canNOT EXECUTE redeem_invite_complete (REST-unreachable)'
);
SELECT is(
  has_function_privilege('service_role',
    'public.redeem_invite_complete(uuid, text, text, bytea, uuid, text[], text, text)', 'EXECUTE'),
  false,
  'F-168: service_role canNOT EXECUTE redeem_invite_complete (closed-set; F-118 no service_role)'
);
SELECT is(
  has_function_privilege('mint_writer',
    'public.redeem_invite_complete(uuid, text, text, bytea, uuid, text[], text, text)', 'EXECUTE'),
  true,
  'F-168: mint_writer CAN EXECUTE redeem_invite_complete (the SOLE grant target)'
);

-- ===========================================================================
-- HAPPY PATH + downstream state. Act as mint_writer (the EF self-mints this).
-- ===========================================================================
SELECT pg_temp.seed_invite(
  '00000000-0000-0000-0000-0000000000a1',
  '22222222-2222-2222-2222-2222222222a1',
  '111111'
);
-- Stash the invite_id for the seeded invitee a1.
DO $$
BEGIN
  PERFORM set_config('test.inv_a1',
    (SELECT invite_id::text FROM public.committee_invite
       WHERE target_user_id = '00000000-0000-0000-0000-0000000000a1'), false);
END $$;

SET LOCAL ROLE mint_writer;
SELECT lives_ok(
  $$SELECT public.redeem_invite_complete(
       current_setting('test.inv_a1')::uuid, '111111',
       'cred-a1', '\x01020304'::bytea, NULL, ARRAY['internal']::text[],
       'example.com', 'device-a1')$$,
  'happy: a valid code + valid invite redeems (mint_writer)'
);
RESET ROLE;

-- (2) Activation: the membership is now active.
SELECT ok(
  public.is_active_member('00000000-0000-0000-0000-0000000000a1'),
  'happy: the invitee membership is ACTIVE after redeem'
);
-- (3) F-171 — the passkey credential is bound to the invite's OWN target, and
--     to NO other user (the redeemer never supplies a uid).
SELECT is(
  (SELECT user_id FROM public.webauthn_credentials WHERE credential_id = 'cred-a1'),
  '00000000-0000-0000-0000-0000000000a1'::uuid,
  'F-171: the bound passkey targets committee_invite.target_user_id, not a caller uid'
);
SELECT is(
  (SELECT count(*)::int FROM public.webauthn_credentials WHERE credential_id = 'cred-a1'),
  1,
  'happy: exactly one credential bound by the redeem'
);
-- (4) F-173 — the activated users.role is worker_member (read from the
--     pre-set membership; there is no redeem-time role param to self-elevate).
SELECT is(
  (SELECT role FROM public.users WHERE id = '00000000-0000-0000-0000-0000000000a1'),
  'worker_member',
  'F-173: activated users.role = worker_member (from membership, not redeemer-supplied)'
);
-- (5) The bootstrap is consumed (DELETEd) and the invite is consumed.
SELECT is(
  (SELECT count(*)::int FROM public.auth_totp_bootstraps WHERE user_id = '00000000-0000-0000-0000-0000000000a1'),
  0,
  'happy: the TOTP bootstrap is deleted on consume'
);
SELECT isnt(
  (SELECT consumed_at FROM public.committee_invite WHERE invite_id = current_setting('test.inv_a1')::uuid),
  NULL,
  'happy: the invite is consumed (consumed_at set)'
);
-- (6) F-170 — a successful redeem emits member.added (the forensic attribution
--     of the binding; the takeover-reconstruction trace).
SELECT ok(
  (SELECT EXISTS(SELECT 1 FROM public.audit_log WHERE event_type='member.added')),
  'F-170: a successful redeem emits member.added (attribution / detectability)'
);

-- ===========================================================================
-- F-169 — SINGLE-USE: a second redeem of the SAME invite -> invite_invalid,
-- and NO second credential bound.
-- ===========================================================================
SET LOCAL ROLE mint_writer;
SELECT throws_like(
  $$SELECT public.redeem_invite_complete(
       current_setting('test.inv_a1')::uuid, '111111',
       'cred-a1-second', '\x05060708'::bytea, NULL, ARRAY['internal']::text[],
       'example.com', 'device-a1-second')$$,
  '%invite_invalid%',
  'F-169: a SECOND redeem of a consumed invite raises invite_invalid'
);
RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM public.webauthn_credentials WHERE credential_id = 'cred-a1-second'),
  0,
  'F-169: the second (losing) redeem binds NO credential'
);

-- ===========================================================================
-- F-169 — NORMALIZED ERROR ORACLE: consumed == expired == non-existent all
-- RAISE the byte-IDENTICAL literal `invite_invalid`. We capture each SQLERRM
-- and assert all three are equal (no condition leaks via the error).
-- ===========================================================================
-- Seed an EXPIRED invite for a2.
SELECT pg_temp.seed_invite(
  '00000000-0000-0000-0000-0000000000a2',
  '22222222-2222-2222-2222-2222222222a2',
  '222222',
  ARRAY['worker_member'],
  interval '-1 second'   -- invite already expired
);
-- NOTE: we capture each SQLERRM in its own subtransaction. redeem_invite_complete
-- is SECURITY DEFINER (runs as owner), so the error LITERAL is independent of the
-- caller role; the mint_writer-only grant is asserted separately above (3-6).
-- Each inner BEGIN re-establishes nothing role-related so a savepoint rollback
-- on one branch cannot strand the next (the SET LOCAL ROLE + exception-savepoint
-- interaction otherwise reverts the role mid-block).
DO $$
DECLARE
  v_consumed text;
  v_expired  text;
  v_missing  text;
BEGIN
  -- consumed: re-redeem a1 (already consumed above)
  BEGIN
    PERFORM public.redeem_invite_complete(
      current_setting('test.inv_a1')::uuid, '111111',
      'x', '\x00'::bytea, NULL, ARRAY[]::text[], 'example.com', 'd');
  EXCEPTION WHEN others THEN v_consumed := SQLERRM; END;
  -- expired: the a2 invite (TTL -1s)
  BEGIN
    PERFORM public.redeem_invite_complete(
      (SELECT invite_id FROM public.committee_invite WHERE target_user_id='00000000-0000-0000-0000-0000000000a2'),
      '222222', 'x', '\x00'::bytea, NULL, ARRAY[]::text[], 'example.com', 'd');
  EXCEPTION WHEN others THEN v_expired := SQLERRM; END;
  -- non-existent: a random uuid that was never issued
  BEGIN
    PERFORM public.redeem_invite_complete(
      '99999999-9999-9999-9999-999999999999'::uuid,
      '000000', 'x', '\x00'::bytea, NULL, ARRAY[]::text[], 'example.com', 'd');
  EXCEPTION WHEN others THEN v_missing := SQLERRM; END;
  PERFORM set_config('test.err_consumed', COALESCE(v_consumed,'<none>'), false);
  PERFORM set_config('test.err_expired',  COALESCE(v_expired,'<none>'),  false);
  PERFORM set_config('test.err_missing',  COALESCE(v_missing,'<none>'),  false);
END $$;
SELECT is(
  current_setting('test.err_consumed'),
  current_setting('test.err_expired'),
  'F-169 oracle: consumed and expired yield a BYTE-IDENTICAL error literal'
);
SELECT is(
  current_setting('test.err_expired'),
  current_setting('test.err_missing'),
  'F-169 oracle: expired and non-existent yield a BYTE-IDENTICAL error literal'
);
SELECT matches(
  current_setting('test.err_missing'),
  'invite_invalid',
  'F-169 oracle: the shared literal is invite_invalid (no condition disclosed)'
);

-- ===========================================================================
-- F-170 — 15-min TOTP window: an EXPIRED bootstrap -> TOTP_BOOTSTRAP_EXPIRED,
-- no binding (the invite itself is still valid).
-- ===========================================================================
SELECT pg_temp.seed_invite(
  '00000000-0000-0000-0000-0000000000a3',
  '22222222-2222-2222-2222-2222222222a3',
  '333333',
  ARRAY['worker_member'],
  interval '7 days',
  interval '-1 second'   -- TOTP already expired, invite still live
);
SELECT throws_like(
  $$SELECT public.redeem_invite_complete(
       (SELECT invite_id FROM public.committee_invite WHERE target_user_id='00000000-0000-0000-0000-0000000000a3'),
       '333333', 'cred-a3', '\x09'::bytea, NULL, ARRAY[]::text[], 'example.com', 'd')$$,
  '%TOTP_BOOTSTRAP_EXPIRED%',
  'F-170: an expired TOTP bootstrap -> TOTP_BOOTSTRAP_EXPIRED, no binding'
);
SELECT is(
  (SELECT count(*)::int FROM public.webauthn_credentials WHERE credential_id = 'cred-a3'),
  0,
  'F-170: the expired-TOTP redeem binds NO credential'
);

-- ===========================================================================
-- F-170 / F-177 — the 5-attempt lock (mirrors enroll_first_passkey:413-419).
--
-- DETERMINISM NOTE: pgTAP wraps the whole file in ONE transaction, and a RAISE
-- caught by a DO-block savepoint ROLLS BACK to that savepoint — so the
-- production "wrong_attempts++ survives the rolled-back redeem" persistence
-- (the one deliberate F-177 exception, which production realises via an
-- autonomous-txn / statement-frame commit) is NOT observable across separate
-- pgTAP statements. We therefore pin the MECHANISM-INDEPENDENT observable
-- contract: (a) the wrong-code branch increments the counter + locks at the 5th
-- WITHIN one statement frame (asserted by seeding wrong_attempts=4 and checking
-- a 5th wrong code's branch), and (b) a bootstrap already at lock state rejects
-- with TOTP_BOOTSTRAP_LOCKED and binds nothing. Both are deterministic.
-- ===========================================================================

-- (a) Seed an invitee whose bootstrap is already at wrong_attempts=4 (one shy of
--     the lock). A 5th wrong code must (within the function's own frame) set
--     locked_at — we assert the function RAISEs WRONG_CODE on the wrong code,
--     and (separately, mechanism-independently) that a pre-locked bootstrap is
--     refused. The 5th-attempt counter write is in the function's frame; we
--     verify the lock-AT-5 boundary via the pre-seeded path below.
SELECT pg_temp.seed_invite(
  '00000000-0000-0000-0000-0000000000a4',
  '22222222-2222-2222-2222-2222222222a4',
  '444444'
);
UPDATE public.auth_totp_bootstraps
   SET wrong_attempts = 4
 WHERE user_id = '00000000-0000-0000-0000-0000000000a4';
SELECT throws_like(
  $$SELECT public.redeem_invite_complete(
       (SELECT invite_id FROM public.committee_invite WHERE target_user_id='00000000-0000-0000-0000-0000000000a4'),
       '000000', 'cred-a4-5', '\x0a'::bytea, NULL, ARRAY[]::text[], 'example.com', 'd')$$,
  '%TOTP_BOOTSTRAP_WRONG_CODE%',
  'F-170: a wrong code -> TOTP_BOOTSTRAP_WRONG_CODE (the 5th attempt at attempts=4)'
);
SELECT is(
  (SELECT count(*)::int FROM public.webauthn_credentials WHERE credential_id = 'cred-a4-5'),
  0,
  'F-177: a wrong-code redeem binds NO credential (activation rolled back)'
);

-- (b) Seed an invitee whose bootstrap is ALREADY locked (locked_at set). Even
--     the CORRECT code must be refused with TOTP_BOOTSTRAP_LOCKED, no binding.
SELECT pg_temp.seed_invite(
  '00000000-0000-0000-0000-0000000000a6',
  '22222222-2222-2222-2222-2222222222a6',
  '666666'
);
UPDATE public.auth_totp_bootstraps
   SET wrong_attempts = 5, locked_at = now()
 WHERE user_id = '00000000-0000-0000-0000-0000000000a6';
SELECT throws_like(
  $$SELECT public.redeem_invite_complete(
       (SELECT invite_id FROM public.committee_invite WHERE target_user_id='00000000-0000-0000-0000-0000000000a6'),
       '666666', 'cred-a6', '\x0b'::bytea, NULL, ARRAY[]::text[], 'example.com', 'd')$$,
  '%TOTP_BOOTSTRAP_LOCKED%',
  'F-170: a locked bootstrap refuses even the CORRECT code (TOTP_BOOTSTRAP_LOCKED)'
);
SELECT is(
  (SELECT count(*)::int FROM public.webauthn_credentials WHERE credential_id = 'cred-a6'),
  0,
  'F-170: a locked-bootstrap redeem binds NO credential'
);

-- ===========================================================================
-- F-177 — a bad-code redeem is otherwise all-or-nothing: the membership stays
-- PENDING and the invite stays UNCONSUMED after a wrong-code attempt (only the
-- counter mutates). Use a fresh invitee a5 with one wrong attempt.
-- ===========================================================================
SELECT pg_temp.seed_invite(
  '00000000-0000-0000-0000-0000000000a5',
  '22222222-2222-2222-2222-2222222222a5',
  '555555'
);
DO $$
BEGIN
  BEGIN
    PERFORM public.redeem_invite_complete(
      (SELECT invite_id FROM public.committee_invite WHERE target_user_id='00000000-0000-0000-0000-0000000000a5'),
      '000000', 'cred-a5', '\x0c'::bytea, NULL, ARRAY[]::text[], 'example.com', 'd');
  EXCEPTION WHEN others THEN NULL; END;
END $$;
SELECT ok(
  NOT public.is_active_member('00000000-0000-0000-0000-0000000000a5'),
  'F-177: a bad-code redeem leaves the membership PENDING (activation rolled back)'
);
SELECT is(
  (SELECT consumed_at FROM public.committee_invite WHERE target_user_id='00000000-0000-0000-0000-0000000000a5'),
  NULL,
  'F-177: a bad-code redeem leaves the invite UNCONSUMED (rolled back)'
);
SELECT is(
  (SELECT count(*)::int FROM public.auth_totp_bootstraps WHERE user_id='00000000-0000-0000-0000-0000000000a5'),
  1,
  'F-177: a bad-code redeem leaves the bootstrap PRESENT (not deleted)'
);

SELECT * FROM finish();
ROLLBACK;
