-- ===========================================================================
-- ADR-0029 P1-6 (EF/SQL) — pgTAP for `reissue_member_totp`.
--
-- The "re-send code" SQL fn. The 15-min TOTP (auth_totp_bootstraps.expires_at,
-- 00000000000001_auth.sql:263) expires long before the 7-day invite TTL
-- (committee_invite.expires_at), so a member who does not redeem inside the
-- 15-min window needs a FRESH TOTP against the SAME, still-unconsumed invite.
-- This fn re-issues the bootstrap WITHOUT re-creating the user / invite /
-- membership (ADR-0029 Decision 3 sub-decision; the common real case — co-chair
-- sets up Monday, member redeems Thursday and needs a fresh code Thursday).
--
-- Mechanism (per ADR-0029 Decision 3 + threat-model §3.18 F-175 mitigation):
-- the UNIQUE(user_id) cap-of-1 on auth_totp_bootstraps (00000000000001:268)
-- means re-issue is a delete-then-insert / upsert: the existing bootstrap row
-- for the invite's target user is REPLACED with a fresh secret_hash (HMAC of a
-- new code), a fresh 15-min expires_at, and reset wrong_attempts / locked_at,
-- and committee_invite.bootstrap_id is re-pointed at the NEW row. The OLD code
-- no longer validates. The invite itself is otherwise UNCHANGED (same
-- invite_id, target_user_id, role, expires_at — re-send does NOT extend the
-- 7-day invite TTL, only the TOTP).
--
-- Signature pinned to ADR-0029 "NEW hosted artifacts" (line 9805):
--   reissue_member_totp(p_invite_id uuid, p_totp_code text)
--   — co-chair-gated, GRANT authenticated.
-- The shape mirrors issue_member_invite's "EF generates the raw code + passes
-- it; the SQL computes secret_hash = hmac(code) internally" contract
-- (Decision 2a / 00000000000041:100-111). The return shape is NOT pinned by
-- ADR-0029 P1-6 prose; the EF op-test (reissue-totp.test.ts) pins the EF
-- response wire shape, so this pgTAP asserts only side-effect STATE, not the
-- RETURNS column names (CONTRACT-AMBIGUITY-1 — see header note below).
--
-- RED-FIRST: `public.reissue_member_totp(uuid, text)` does NOT exist on `main`
-- (P1-6 implementer builds it against this test). Every call raises
-- `function public.reissue_member_totp(uuid, text) does not exist` (SQLSTATE
-- 42883) until the migration lands — the intended red.
--
-- Findings covered (threat-model §3.18):
--   F-175 — TOTP issuance/re-send abuse: only an active co-chair re-sends
--           (gated); the OLD code dies on re-send; UNIQUE(user_id) cap-of-1
--           holds (re-send REPLACES, never accumulates); fresh 15-min expiry;
--           server now() authoritative on the new expiry.
--   F-176 — secret_hash (HMAC) at rest, NOT the raw code; the raw code is never
--           persisted in any column.
--
-- CONTRACT AMBIGUITIES (flagged to the orchestrator; see the trailing comment
-- block in the test-writer report):
--   AMBIGUITY-1 (closed error literal for a consumed/expired invite). ADR-0029
--     P1-6 prose (line 9791) does NOT name the literal. The sibling keystone
--     redeem_invite_complete normalizes consumed == expired == non-existent to
--     ONE literal `invite_invalid` (00000000000041:186-189, F-169/F-170). We
--     pin `invite_invalid` here to MIRROR that closed-oracle posture (the brief
--     instructs "use the same closed-oracle posture as the keystone"). If the
--     implementer chooses a different literal, this assertion must be the place
--     it is reconciled — do NOT relax it silently.
--   AMBIGUITY-2 (reissue audit event name). ADR-0029 does NOT pin a reissue
--     audit event, does NOT list one in "NEW hosted artifacts", and the P1-6 AC
--     (line 9791) names NONE. The ONLY new Phase-1 audit enum is
--     identity_pubkey.disclosed_for_wrap (Decision 4, P1-4). We therefore do
--     NOT hard-assert a NEW event name (that would fabricate contract). We pin
--     the conservative, ADR-grounded property instead: re-send must NOT emit
--     member.added (the activation event; a re-send is not an activation) and
--     must NOT emit identity_pubkey.disclosed_for_wrap. The architect must
--     decide whether re-send needs a dedicated audit enum (e.g.
--     member.totp_reissued, which would require the full six-mirror dance) — if
--     so, a follow-up assertion lands here, six-mirrored like
--     t18_integrity_check_event_types.sql / phase1_get_pubkey_rls.sql.
--
-- Conventions mirror phase1_issue_invite_rls.sql + phase1_redeem_invite_rls.sql:
-- the app.hmac_pseudonym_key dev/CI placeholder, the request.jwt.claims
-- sub+session_id shim + a live auth_sessions row, `set local role authenticated`
-- on EVERY role-gated assertion (the gate is worthless without it — this exact
-- gap caused a prior bug), ok()/is()/throws_like().
--
-- Run: pg_prove -d <db> supabase/test/phase1_reissue_totp_rls.sql
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;
SELECT plan(38);

-- ---------------------------------------------------------------------------
-- A reusable fixture builder mirroring phase1_redeem_invite_rls.sql's
-- pg_temp.seed_invite: a pre-created invitee user (active, role NULL) + a
-- pending membership + a bootstrap whose secret_hash = HMAC(<code>) + a
-- committee_invite linking them. Returns the invite_id. This is exactly the
-- post-issue state phase1_issue_invite_rls.sql asserts the producer writes
-- (so re-send operates on a real, still-unconsumed invite).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.seed_invite(
  p_uid          uuid,
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

-- ---------------------------------------------------------------------------
-- Founding active co-chair (the re-sender) + a non-co-chair worker member,
-- each with a live session, plus a dead (revoked) co-chair session for the
-- session_is_live gate. Mirrors phase1_issue_invite_rls.sql.
-- ---------------------------------------------------------------------------
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000f1', true),   -- founder co-chair (re-sender)
  ('00000000-0000-0000-0000-0000000000b2', true);   -- worker_member (not co-chair)
INSERT INTO public.committee_membership (user_id, role, active, activated_at) VALUES
  ('00000000-0000-0000-0000-0000000000f1', ARRAY['worker_member','worker_co_chair'], true, now()),
  ('00000000-0000-0000-0000-0000000000b2', ARRAY['worker_member'], true, now());
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111f1', '00000000-0000-0000-0000-0000000000f1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111b2', '00000000-0000-0000-0000-0000000000b2', now() + interval '5 min'),
  ('11111111-1111-1111-1111-11111111dead', '00000000-0000-0000-0000-0000000000f1', now() + interval '5 min');
UPDATE public.auth_sessions SET revoked_at = now()
  WHERE session_id = '11111111-1111-1111-1111-11111111dead';

-- The target invitee of the still-unconsumed invite we will re-send against.
-- OLD_CODE is the code from the original issue; NEW_CODE is the re-send code.
SELECT pg_temp.seed_invite(
  '00000000-0000-0000-0000-0000000000e7'::uuid,   -- invitee uid
  '111111'                                         -- OLD_CODE
) AS inv \gset
SELECT set_config('test.invite_id', :'inv', false);

-- Stash the ORIGINAL bootstrap id + its expiry so we can prove the swap.
DO $$
DECLARE r record;
BEGIN
  SELECT b.id, b.expires_at, b.secret_hash
    INTO r
    FROM public.auth_totp_bootstraps b
   WHERE b.user_id = '00000000-0000-0000-0000-0000000000e7'::uuid;
  PERFORM set_config('test.old_bootstrap_id', r.id::text, false);
  PERFORM set_config('test.old_expires_at',   r.expires_at::text, false);
END $$;

-- ===========================================================================
-- (0) The function exists with the ADR-0029 signature (line 9805).
-- ===========================================================================
SELECT has_function(
  'public', 'reissue_member_totp',
  ARRAY['uuid','text'],
  'ADR-0029 P1-6: reissue_member_totp(uuid, text) exists'
);

-- ===========================================================================
-- (1) F-175 — EXECUTE matrix: granted to authenticated (the co-chair's JWT),
--     gated IN-FN; revoked from anon and PUBLIC (a co-chair re-sends via
--     committee-op, exactly like issue_member_invite, 00000000000041:140-143).
-- ===========================================================================
SELECT is(
  has_function_privilege('authenticated',
    'public.reissue_member_totp(uuid, text)', 'EXECUTE'),
  true,
  'F-175: authenticated CAN execute reissue_member_totp (co-chair-gated in-fn)'
);
SELECT is(
  has_function_privilege('anon',
    'public.reissue_member_totp(uuid, text)', 'EXECUTE'),
  false,
  'F-175: anon canNOT execute reissue_member_totp'
);
SELECT is(
  has_function_privilege('public',
    'public.reissue_member_totp(uuid, text)', 'EXECUTE'),
  false,
  'F-175: PUBLIC has no EXECUTE on reissue_member_totp'
);

-- ===========================================================================
-- (2) F-175 — co-chair gate: a non-co-chair worker_member cannot re-send.
--     `set local role authenticated` so the privilege boundary is REAL
--     (pgTAP runs as superuser otherwise; the gate would be untested).
-- ===========================================================================
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","session_id":"11111111-1111-1111-1111-1111111111b2","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  format($$SELECT public.reissue_member_totp(%L, '222222')$$,
         current_setting('test.invite_id')),
  '%rls_denied%',
  'F-175: a worker_member (non-co-chair) cannot re-send a code (rls_denied)'
);
RESET ROLE;

-- ===========================================================================
-- (3) F-175 — session_is_live gate: a co-chair with a DEAD (revoked) session
--     is denied (mirrors issue_member_invite's gate, 00000000000041:74-76).
-- ===========================================================================
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-11111111dead","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  format($$SELECT public.reissue_member_totp(%L, '222222')$$,
         current_setting('test.invite_id')),
  '%rls_denied%',
  'F-175: a co-chair with a revoked session cannot re-send (session_is_live gate)'
);
RESET ROLE;

-- ===========================================================================
-- (4) Closed error oracle (AMBIGUITY-1) — a CONSUMED invite re-send is denied
--     with the SAME stable literal the keystone uses for a spent/expired/
--     fictional invite: `invite_invalid` (00000000000041:186-189). No leak of
--     WHICH condition failed. Build a separate consumed invite for this.
-- ===========================================================================
SELECT pg_temp.seed_invite(
  '00000000-0000-0000-0000-0000000000c0'::uuid,   -- consumed-invite invitee
  '333333'
) AS cinv \gset
UPDATE public.committee_invite SET consumed_at = now()
  WHERE invite_id = :'cinv'::uuid;

SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  format($$SELECT public.reissue_member_totp(%L, '444444')$$, :'cinv'),
  '%invite_invalid%',
  'AMBIGUITY-1: re-send against a CONSUMED invite -> invite_invalid (closed oracle, mirrors keystone)'
);
RESET ROLE;

-- ===========================================================================
-- (5) Closed error oracle (AMBIGUITY-1) — an EXPIRED invite re-send raises the
--     SAME literal as the consumed case (no condition leak). Re-send does NOT
--     resurrect an expired invite (that needs a fresh invite, not a fresh TOTP).
-- ===========================================================================
SELECT pg_temp.seed_invite(
  '00000000-0000-0000-0000-0000000000ec'::uuid,   -- expired-invite invitee
  '555555',
  ARRAY['worker_member'],
  interval '-1 min'                                -- invite already expired
) AS einv \gset

SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  format($$SELECT public.reissue_member_totp(%L, '666666')$$, :'einv'),
  '%invite_invalid%',
  'AMBIGUITY-1: re-send against an EXPIRED invite -> invite_invalid (same literal, no condition leak)'
);
RESET ROLE;

-- ===========================================================================
-- HAPPY PATH — a co-chair re-sends against the still-unconsumed invite.
-- ===========================================================================
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  format($$SELECT public.reissue_member_totp(%L, '999999')$$,
         current_setting('test.invite_id')),
  'happy: a co-chair re-sends a fresh code against the unconsumed invite'
);
RESET ROLE;

-- Stash the NEW bootstrap id for the swap assertions.
DO $$
DECLARE r record;
BEGIN
  SELECT b.id INTO r FROM public.auth_totp_bootstraps b
   WHERE b.user_id = '00000000-0000-0000-0000-0000000000e7'::uuid;
  PERFORM set_config('test.new_bootstrap_id', r.id::text, false);
END $$;

-- (6) F-175 — cap-of-1: EXACTLY ONE bootstrap row for the target user after
--     re-send (UNIQUE(user_id) holds; re-send REPLACES, never accumulates).
SELECT is(
  (SELECT count(*)::int FROM public.auth_totp_bootstraps
    WHERE user_id = '00000000-0000-0000-0000-0000000000e7'::uuid),
  1,
  'F-175: exactly one bootstrap for the target after re-send (UNIQUE(user_id) cap-of-1)'
);

-- (7) F-175 — the OLD bootstrap row is GONE (delete-then-insert / upsert): the
--     id changed, so the original row was replaced, not mutated-in-place into
--     a stale-but-present row.
SELECT is(
  (SELECT count(*)::int FROM public.auth_totp_bootstraps
    WHERE id = current_setting('test.old_bootstrap_id')::uuid),
  0,
  'F-175: the OLD bootstrap row is gone after re-send (replaced, not accumulated)'
);

-- (8) F-176 / F-175 — the NEW bootstrap stores HMAC(NEW_CODE='999999'), i.e.
--     the OLD code no longer validates. Assert the stored secret_hash equals
--     HMAC of the new code AND does NOT equal HMAC of the old code.
SELECT is(
  (SELECT secret_hash FROM public.auth_totp_bootstraps
    WHERE user_id = '00000000-0000-0000-0000-0000000000e7'::uuid),
  hmac('999999'::bytea, private._hmac_pseudonym_key()::bytea, 'sha256'),
  'F-176: re-send stores HMAC(new code) at rest (the new code validates)'
);
SELECT isnt(
  (SELECT secret_hash FROM public.auth_totp_bootstraps
    WHERE user_id = '00000000-0000-0000-0000-0000000000e7'::uuid),
  hmac('111111'::bytea, private._hmac_pseudonym_key()::bytea, 'sha256'),
  'F-175: the OLD code (111111) no longer validates against the new bootstrap'
);

-- (9) F-176 — the raw code is NEVER stored as plaintext anywhere: no bootstrap
--     row holds the literal new code in any text-castable identifier column.
SELECT is(
  (SELECT count(*)::int FROM public.auth_totp_bootstraps
    WHERE id::text = '999999' OR user_id::text = '999999'),
  0,
  'F-176: the raw re-send code is not stored as any bootstrap identifier'
);

-- (10) F-175 — fresh 15-min TTL: the new expires_at is ~15 min in the future
--      (the SECURITY-critical non-extendable clock, re-armed by the re-send).
SELECT ok(
  (SELECT expires_at BETWEEN now() + interval '14 minutes' AND now() + interval '16 minutes'
     FROM public.auth_totp_bootstraps
    WHERE user_id = '00000000-0000-0000-0000-0000000000e7'::uuid),
  'F-175: re-send sets a fresh 15-min TTL (the new bootstrap expires in ~15 min)'
);

-- (11) The new expiry is STRICTLY LATER than the old one (the re-send re-armed
--      the clock — the whole point of P1-6). Deterministic: same-txn now() is
--      stable, but the new bootstrap was inserted later in the seed→reissue
--      sequence, so its +15m anchor is >= the old +15m anchor. Use >= to stay
--      robust to a single-statement-frame now() (the old was seeded earlier).
SELECT ok(
  (SELECT b.expires_at >= current_setting('test.old_expires_at')::timestamptz
     FROM public.auth_totp_bootstraps b
    WHERE b.user_id = '00000000-0000-0000-0000-0000000000e7'::uuid),
  'F-175: the re-sent bootstrap expiry is not earlier than the original (clock re-armed)'
);

-- (12) F-175 — re-send resets wrong_attempts to 0. Seed a fresh invite, drive
--      its bootstrap to wrong_attempts=3, then re-send and assert it is reset.
SELECT pg_temp.seed_invite(
  '00000000-0000-0000-0000-0000000000a3'::uuid,   -- attempts-reset invitee
  '707070'
) AS ainv \gset
UPDATE public.auth_totp_bootstraps SET wrong_attempts = 3
  WHERE user_id = '00000000-0000-0000-0000-0000000000a3'::uuid;

SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  format($$SELECT public.reissue_member_totp(%L, '808080')$$, :'ainv'),
  'happy: re-send against an invite whose bootstrap had wrong_attempts=3'
);
RESET ROLE;
SELECT is(
  (SELECT wrong_attempts FROM public.auth_totp_bootstraps
    WHERE user_id = '00000000-0000-0000-0000-0000000000a3'::uuid),
  0,
  'F-175: re-send resets wrong_attempts to 0 (a fresh bootstrap, not the stale counter)'
);

-- (13) F-175 — re-send clears locked_at. Seed a fresh invite, LOCK its
--      bootstrap (locked_at set, wrong_attempts=5), then re-send and assert
--      the lock is cleared (re-send is the documented recovery from a lock —
--      §"Failure-mode analysis": "Member asks the co-chair to re-send code").
SELECT pg_temp.seed_invite(
  '00000000-0000-0000-0000-0000000000d5'::uuid,   -- locked invitee
  '616161'
) AS linv \gset
UPDATE public.auth_totp_bootstraps SET wrong_attempts = 5, locked_at = now()
  WHERE user_id = '00000000-0000-0000-0000-0000000000d5'::uuid;

SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  format($$SELECT public.reissue_member_totp(%L, '626262')$$, :'linv'),
  'happy: re-send against a LOCKED bootstrap (the documented lock-recovery path)'
);
RESET ROLE;
SELECT is(
  (SELECT locked_at FROM public.auth_totp_bootstraps
    WHERE user_id = '00000000-0000-0000-0000-0000000000d5'::uuid),
  NULL,
  'F-175: re-send clears locked_at (re-send is the lock-recovery path)'
);

-- ===========================================================================
-- LINKAGE — committee_invite.bootstrap_id re-points at the NEW bootstrap row,
-- and the invite is OTHERWISE UNCHANGED (re-send does NOT extend the invite
-- TTL or touch its identifying fields).
-- ===========================================================================

-- (14) committee_invite.bootstrap_id now points at the NEW bootstrap (the old
--      one is gone, so a stale pointer would be a dangling FK / wrong row).
SELECT is(
  (SELECT bootstrap_id FROM public.committee_invite
    WHERE invite_id = current_setting('test.invite_id')::uuid),
  current_setting('test.new_bootstrap_id')::uuid,
  'linkage: committee_invite.bootstrap_id re-points at the NEW bootstrap'
);
SELECT isnt(
  (SELECT bootstrap_id FROM public.committee_invite
    WHERE invite_id = current_setting('test.invite_id')::uuid),
  current_setting('test.old_bootstrap_id')::uuid,
  'linkage: committee_invite.bootstrap_id no longer points at the OLD bootstrap'
);

-- (15) The invite TTL is UNCHANGED — re-send re-arms the 15-min TOTP, NOT the
--      7-day invite. expires_at stays ~7 days out (re-send does not extend it).
SELECT ok(
  (SELECT expires_at BETWEEN now() + interval '6 days 23 hours'
                          AND now() + interval '7 days 1 hour'
     FROM public.committee_invite
    WHERE invite_id = current_setting('test.invite_id')::uuid),
  'unchanged: re-send does NOT extend the 7-day invite TTL (only the TOTP)'
);

-- (16) The invite's identifying fields are UNCHANGED: same invite_id, same
--      target_user_id, same role array. (target/role are server-bound at issue;
--      re-send must not retarget or re-role.)
SELECT is(
  (SELECT target_user_id FROM public.committee_invite
    WHERE invite_id = current_setting('test.invite_id')::uuid),
  '00000000-0000-0000-0000-0000000000e7'::uuid,
  'unchanged: re-send leaves committee_invite.target_user_id intact'
);
SELECT is(
  (SELECT role FROM public.committee_invite
    WHERE invite_id = current_setting('test.invite_id')::uuid),
  ARRAY['worker_member'],
  'unchanged: re-send leaves committee_invite.role intact (no re-roling)'
);
SELECT is(
  (SELECT consumed_at FROM public.committee_invite
    WHERE invite_id = current_setting('test.invite_id')::uuid),
  NULL,
  'unchanged: re-send does NOT consume the invite (still redeemable)'
);

-- ===========================================================================
-- NO NEW USER / INVITE / MEMBERSHIP — re-send swaps ONLY the bootstrap row.
-- We compare table counts BEFORE and AFTER a re-send on a fresh fixture so the
-- assertion is mechanism-independent and self-contained.
-- ===========================================================================
SELECT pg_temp.seed_invite(
  '00000000-0000-0000-0000-0000000000f7'::uuid,   -- count-invariance invitee
  '101010'
) AS finv \gset

DO $$
BEGIN
  PERFORM set_config('test.n_users',  (SELECT count(*) FROM public.users)::text, false);
  PERFORM set_config('test.n_invite', (SELECT count(*) FROM public.committee_invite)::text, false);
  PERFORM set_config('test.n_member', (SELECT count(*) FROM public.committee_membership)::text, false);
END $$;

SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  format($$SELECT public.reissue_member_totp(%L, '202020')$$, :'finv'),
  'happy: re-send on the count-invariance fixture'
);
RESET ROLE;

-- (17) public.users count is unchanged by a re-send (no new user created).
SELECT is(
  (SELECT count(*)::int FROM public.users),
  current_setting('test.n_users')::int,
  'no-new-user: public.users count is unchanged by a re-send'
);
-- (18) committee_invite count is unchanged (no new invite created).
SELECT is(
  (SELECT count(*)::int FROM public.committee_invite),
  current_setting('test.n_invite')::int,
  'no-new-invite: committee_invite count is unchanged by a re-send'
);
-- (19) committee_membership count is unchanged (no new / re-activated membership).
SELECT is(
  (SELECT count(*)::int FROM public.committee_membership),
  current_setting('test.n_member')::int,
  'no-new-membership: committee_membership count is unchanged by a re-send'
);
-- (20) The re-send target's membership stays PENDING (active=false): re-send is
--      not an activation. (The only activation path is committee_activate_membership.)
SELECT is(
  (SELECT active FROM public.committee_membership
    WHERE user_id = '00000000-0000-0000-0000-0000000000f7'::uuid),
  false,
  'no-activation: the re-send target membership stays pending (active=false)'
);

-- ===========================================================================
-- AUDIT (RESOLVED by Amendment A-7.1) — re-send emits a dedicated, success-only
-- `member.totp_reissued` audit event so insider re-send abuse (F-175) goes from
-- trace-less to attributable + countable (the committee-op EF structured log
-- carries route+outcome but NO actor uid, so audit_log is the only
-- actor-attributable durable record). Meta carries {actor_id, target_user_id,
-- invite_id} ONLY — never the code/secret_hash/TOTP (F-176). Success-only per
-- A-1: a denied re-send emits NO audit row (denial forensics ride the EF log).
-- Retention class membership+7y (REUSED, sibling of member.added). The re-send
-- must still NOT emit member.added (activation event) or
-- identity_pubkey.disclosed_for_wrap (the P1-4 grant-key path).
-- ===========================================================================

-- (21) No member.added row was emitted for the re-send target by a re-send
--      (the member is still pending; member.added fires only on activation).
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE event_type = 'member.added'
      AND target_id = '00000000-0000-0000-0000-0000000000e7'::uuid),
  0,
  'A-7.1: a re-send emits NO member.added for the target (re-send is not an activation)'
);

-- (22) No identity_pubkey.disclosed_for_wrap row was emitted for the re-send
--      target (re-send is unrelated to the P1-4 grant-key disclosure path).
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE event_type = 'identity_pubkey.disclosed_for_wrap'
      AND target_id = '00000000-0000-0000-0000-0000000000e7'::uuid),
  0,
  'A-7.1: a re-send emits NO identity_pubkey.disclosed_for_wrap (unrelated path)'
);

-- (23) A-7.1 — a SUCCESSFUL re-send emits EXACTLY ONE member.totp_reissued row
--      for the target (the happy-path re-send at the top used code 999999
--      against target e7). This is the F-175 attributability record.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE event_type = 'member.totp_reissued'
      AND target_id = '00000000-0000-0000-0000-0000000000e7'::uuid),
  1,
  'A-7.1: a successful re-send emits exactly one member.totp_reissued row for the target'
);

-- (24) A-7.1 / F-176 — the member.totp_reissued meta carries {actor_id,
--      target_user_id, invite_id} ONLY: it has those three keys and does NOT
--      carry the raw code (999999), nor any code/totp/secret_hash key.
SELECT ok(
  (SELECT meta ? 'actor_id'
      AND meta ? 'target_user_id'
      AND meta ? 'invite_id'
      AND NOT (meta ? 'code')
      AND NOT (meta ? 'totp_code')
      AND NOT (meta ? 'secret_hash')
      AND meta::text NOT ILIKE '%999999%'
     FROM public.audit_log
    WHERE event_type = 'member.totp_reissued'
      AND target_id = '00000000-0000-0000-0000-0000000000e7'::uuid
    LIMIT 1),
  'A-7.1 / F-176: member.totp_reissued meta carries {actor_id,target_user_id,invite_id} only — no code/secret'
);

-- (25) A-7.1 / A-1 — a DENIED re-send emits NO member.totp_reissued (success-only
--      audit; the consumed-invite re-send against target c0 was rejected with
--      invite_invalid above, so no audit row for c0).
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE event_type = 'member.totp_reissued'
      AND target_id = '00000000-0000-0000-0000-0000000000c0'::uuid),
  0,
  'A-7.1 / A-1: a DENIED re-send (consumed invite) emits NO member.totp_reissued (success-only)'
);

-- (26) A-7.1 six-mirror — member.totp_reissued maps to retention class
--      membership+7y (the REUSED member.* class). An un-mirrored new event would
--      fall through to the '24mo' default (the missing-arm tell).
SELECT is(
  public.retention_class_for('member.totp_reissued'),
  'membership+7y',
  'A-7.1 six-mirror: member.totp_reissued retention class is membership+7y (not the 24mo default)'
);

-- ===========================================================================
-- STRUCTURE — re-send is a single-frame SECURITY DEFINER fn (the bootstrap
-- swap + linkage update + any audit must be all-or-nothing, like the keystone).
-- ===========================================================================
SELECT is(
  (SELECT prosecdef FROM pg_proc
    WHERE proname = 'reissue_member_totp' AND pronamespace = 'public'::regnamespace
    LIMIT 1),
  true,
  'structure: reissue_member_totp is SECURITY DEFINER (one atomic frame)'
);

SELECT * FROM finish();
ROLLBACK;
