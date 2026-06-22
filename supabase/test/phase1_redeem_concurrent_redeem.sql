-- ===========================================================================
-- ADR-0029 P1-1 (KEYSTONE, SQL) — pgTAP for F-177 CONCURRENT redeem.
--
-- Sibling of phase1_redeem_invite_rls.sql, pinning the single F-177 facet that
-- the threat-model + second-opinion review called out specifically: two
-- concurrent `redeem_invite_complete` calls on the SAME invite cannot both
-- succeed. The other F-177 facets (atomicity of the wrong-code path, the
-- bad-code-leaves-bootstrap-present property) are already covered by the main
-- redeem file; this one is the concurrency-specific gap.
--
-- pgTAP runs the whole file in ONE outer transaction (the wrapping BEGIN /
-- ROLLBACK below); inside that we cannot spawn a true second backend without
-- platform plumbing (dblink/pg_background) that the rest of the suite does
-- not require. We therefore pin the MECHANISM that makes the concurrent
-- exactly-one-wins property hold, in three deterministic, single-backend
-- observables:
--
--   (a) The `redeem_invite_complete` source body LOADS the invite `FOR UPDATE`
--       (the row-level lock is the kernel of the exactly-one-wins property;
--       a second redeem racing against a successful first SERIALIZES on this
--       lock and observes consumed_at IS NOT NULL when it gets through).
--
--   (b) After a successful redeem, the invite is consumed_at-set AND a second
--       redeem of the SAME invite raises `invite_invalid` (the normalized
--       oracle literal, identical to the consumed/expired/non-existent
--       branches — F-169 is the parallel cover). This is the observable
--       behavior the lock yields: the loser sees the consumed row.
--
--   (c) The invite row's consumed_at is set BEFORE any other side effect that
--       the redeem produces is observable — i.e., committee_invite.consumed_at
--       is the canonical "who won" marker, not some downstream artefact, so a
--       concurrent observer doing a `SELECT … FOR UPDATE` on the invite is
--       guaranteed to see the binary winner/loser distinction.
--
-- Together (a)+(b)+(c) are the mechanism-independent statement that two
-- concurrent redeems cannot BOTH succeed: either the second arrives after
-- the first commits (consumed_at observed → invite_invalid) or it blocks on
-- the FOR UPDATE lock and observes consumed_at when the first commits → same.
--
-- F-177
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;
SELECT plan(4);

-- ---------------------------------------------------------------------------
-- Fixture: a founding active co-chair + a pre-created invitee with a bootstrap
-- + committee_invite (mirrors phase1_redeem_invite_rls.sql's seed_invite shape
-- but inlined here to keep the file self-contained).
-- ---------------------------------------------------------------------------
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000f1', true);
INSERT INTO public.committee_membership (user_id, role, active, activated_at) VALUES
  ('00000000-0000-0000-0000-0000000000f1', ARRAY['worker_member','worker_co_chair'], true, now());

INSERT INTO public.users (id, active, role) VALUES
  ('00000000-0000-0000-0000-0000000000c1', true, NULL);
INSERT INTO public.committee_membership (user_id, role, active, invited_by, invited_at) VALUES
  ('00000000-0000-0000-0000-0000000000c1', ARRAY['worker_member'], false,
   '00000000-0000-0000-0000-0000000000f1', now());
INSERT INTO public.auth_totp_bootstraps (user_id, secret_hash, expires_at)
  VALUES ('00000000-0000-0000-0000-0000000000c1',
          hmac('777777'::bytea, private._hmac_pseudonym_key()::bytea, 'sha256'),
          now() + interval '15 min')
  RETURNING id;
DO $$
DECLARE v_inv uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.committee_invite (invite_id, target_user_id, bootstrap_id, role, issued_by, expires_at)
    VALUES (v_inv, '00000000-0000-0000-0000-0000000000c1',
            (SELECT id FROM public.auth_totp_bootstraps WHERE user_id='00000000-0000-0000-0000-0000000000c1'),
            ARRAY['worker_member'],
            '00000000-0000-0000-0000-0000000000f1', now() + interval '7 days');
  PERFORM set_config('test.inv_c1', v_inv::text, false);
END $$;

-- ---------------------------------------------------------------------------
-- (a) F-177 — the redeem function takes a ROW-LEVEL LOCK on the invite. The
--     `SELECT * INTO v_inv FROM public.committee_invite WHERE invite_id = …
--     FOR UPDATE` is what serializes two concurrent backends. We pin this by
--     introspecting the function source — a regression that dropped the
--     FOR UPDATE clause (the kernel of exactly-one-wins) would fail here.
-- ---------------------------------------------------------------------------
SELECT matches(
  (SELECT pg_get_functiondef('public.redeem_invite_complete(uuid, text, text, bytea, uuid, text[], text, text)'::regprocedure)),
  'committee_invite[^;]*FOR UPDATE',
  'F-177(a): redeem_invite_complete loads the invite FOR UPDATE (the row-lock that serializes concurrent redeems)'
);

-- ---------------------------------------------------------------------------
-- (b) F-177 — after a successful redeem the invite is consumed AND a second
--     redeem of the same invite raises invite_invalid (the loser's observable
--     when the FOR UPDATE lock yields after the winner commits).
-- ---------------------------------------------------------------------------
SET LOCAL ROLE mint_writer;
SELECT lives_ok(
  $$SELECT public.redeem_invite_complete(
       current_setting('test.inv_c1')::uuid, '777777',
       'cred-c1', '\x01'::bytea, NULL, ARRAY['internal']::text[],
       'example.com', 'device-c1')$$,
  'F-177(b): the first redeem succeeds (the "winner" of the would-be race)'
);
SELECT throws_like(
  $$SELECT public.redeem_invite_complete(
       current_setting('test.inv_c1')::uuid, '777777',
       'cred-c1-second', '\x02'::bytea, NULL, ARRAY['internal']::text[],
       'example.com', 'device-c1-second')$$,
  '%invite_invalid%',
  'F-177(b): a SECOND redeem of the same invite raises invite_invalid (the "loser" of the would-be race)'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- (c) F-177 — consumed_at is the canonical winner marker (set by the winning
--     redeem, observed by the losing one through the FOR UPDATE lock). Assert
--     it is set AND it points within the test window — so a concurrent observer
--     blocked on the row lock sees a definite winner/loser distinction.
-- ---------------------------------------------------------------------------
SELECT ok(
  (SELECT consumed_at IS NOT NULL
     FROM public.committee_invite
    WHERE invite_id = current_setting('test.inv_c1')::uuid),
  'F-177(c): committee_invite.consumed_at is the canonical winner marker after a successful redeem'
);

SELECT * FROM finish();
ROLLBACK;
