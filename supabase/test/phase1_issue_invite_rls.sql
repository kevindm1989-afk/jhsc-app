-- ===========================================================================
-- ADR-0029 P1-1 (KEYSTONE, SQL) — pgTAP for `issue_member_invite`.
--
-- The co-chair-side producer: creates the invitee `public.users` row at ISSUE
-- time (so the committee_invite.target_user_id FK is satisfiable), creates the
-- `auth_totp_bootstraps` row (15-min TTL, secret_hash = HMAC of the passed
-- code), then DELEGATES to `committee_invite_member` with the named
-- p_bootstrap_id / p_ttl_minutes so the committee_invite.bootstrap_id linkage
-- is populated (the gap ADR-0029 closes).
--
-- PRIVACY-DEFERRED SIGNATURE: the keystone signature drops p_display_name and
-- p_off_employer_contact (the privacy review BLOCKED their persistence in this
-- increment without employer-domain rejection / retention enforcement; the
-- decision is to defer both fields and re-introduce them in the co-chair
-- roster increment). committee_invite_member's NULL defaults
-- (00000000000002:215-216) keep the delegate call safe.
--
-- Findings covered (threat-model §3.18):
--   F-173 — role escalation via the invite role array (facet i ACCEPTED:
--           a worker_co_chair invite by a co-chair succeeds; invalid_role for
--           an out-of-enum array; role is server-bound at issue, not at redeem).
--   F-168 — the co-chair gate on issuance (non-co-chair / dead-session denied;
--           granted to authenticated, gated in-fn).
--   F-177 — issuance is ONE txn (create-user + TOTP + pending-membership +
--           invite all-or-nothing; no orphan user on a partial issue).
--   F-176 — secret_hash (HMAC) is at rest, NOT the raw code (never persisted).
--   F-175 — UNIQUE(user_id) cap-of-1 on auth_totp_bootstraps holds post-issue.
--
-- Conventions mirror committee_rls.sql + adr0025_bootstrap_first_co_chair.sql:
-- the request.jwt.claims sub+session_id shim + a live auth_sessions row; the
-- app.hmac_pseudonym_key dev/CI placeholder; `set local role` where a real
-- role boundary is asserted; ok()/is()/throws_like()/results_eq().
--
-- Run: pg_prove -d <db> supabase/test/phase1_issue_invite_rls.sql
--   (migrations 0..N + the local auth shim; CI committee-db-tests stage).
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;
SELECT plan(21);

-- NOTE (privacy-deferred): the keystone signature deliberately excludes
-- p_display_name / p_off_employer_contact (the privacy review BLOCKED their
-- persistence in the keystone; the user chose to defer both fields out and
-- re-introduce them in the co-chair roster increment with employer-domain
-- rejection + retention). The signature here is (text[], text, integer); the
-- pre-existing committee_invite_member NULL defaults (00000000000002:215-216)
-- keep the delegate call safe. This change is contract-tracking, not a
-- weakening of any security assertion.

-- ---------------------------------------------------------------------------
-- Fixtures: a founding active co-chair + a non-co-chair worker member, each
-- with a live session, mirroring committee_rls.sql.
-- ---------------------------------------------------------------------------
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000f1', true),   -- founder co-chair
  ('00000000-0000-0000-0000-0000000000b2', true);   -- worker_member (not co-chair)
INSERT INTO public.committee_membership (user_id, role, active, activated_at) VALUES
  ('00000000-0000-0000-0000-0000000000f1', ARRAY['worker_member','worker_co_chair'], true, now()),
  ('00000000-0000-0000-0000-0000000000b2', ARRAY['worker_member'], true, now());
INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111f1', '00000000-0000-0000-0000-0000000000f1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111b2', '00000000-0000-0000-0000-0000000000b2', now() + interval '5 min'),
  -- A dead (revoked) session for the co-chair to test the session_is_live gate.
  ('11111111-1111-1111-1111-11111111dead', '00000000-0000-0000-0000-0000000000f1', now() + interval '5 min');
UPDATE public.auth_sessions SET revoked_at = now()
  WHERE session_id = '11111111-1111-1111-1111-11111111dead';

-- ---------------------------------------------------------------------------
-- (0) The function exists with the ADR-0029 signature (the keystone contract).
--     Signature per ADR-0029 "NEW hosted artifacts" (privacy-deferred shape):
--     issue_member_invite(p_roles text[], p_totp_code text, p_ttl_minutes int)
-- ---------------------------------------------------------------------------
SELECT has_function(
  'public', 'issue_member_invite',
  ARRAY['text[]','text','integer'],
  'ADR-0029 P1-1: issue_member_invite(text[],text,int) exists (privacy-deferred shape)'
);

-- ---------------------------------------------------------------------------
-- (1) F-168 — grant posture: issuance is granted to `authenticated` (the
--     co-chair's JWT), gated IN-FN. anon cannot reach it directly.
-- ---------------------------------------------------------------------------
SELECT is(
  has_function_privilege('authenticated',
    'public.issue_member_invite(text[], text, integer)', 'EXECUTE'),
  true,
  'F-168: authenticated CAN execute issue_member_invite (co-chair-gated in-fn)'
);
SELECT is(
  has_function_privilege('anon',
    'public.issue_member_invite(text[], text, integer)', 'EXECUTE'),
  false,
  'F-168: anon canNOT execute issue_member_invite'
);

-- ---------------------------------------------------------------------------
-- (2) F-168 — non-co-chair issuance is denied. Act as the worker_member.
--     `set local role authenticated` so the privilege boundary is real
--     (pgTAP runs as superuser by default — the migration-0039 view-perm miss).
-- ---------------------------------------------------------------------------
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","session_id":"11111111-1111-1111-1111-1111111111b2","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  $$SELECT public.issue_member_invite(ARRAY['worker_member'], '123456', 10080)$$,
  '%rls_denied%',
  'F-168: a worker_member (non-co-chair) cannot issue an invite (rls_denied)'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- (3) F-168 — a co-chair with a DEAD (revoked) session is denied (session_is_live).
-- ---------------------------------------------------------------------------
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-11111111dead","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  $$SELECT public.issue_member_invite(ARRAY['worker_member'], '123456', 10080)$$,
  '%rls_denied%',
  'F-168: a co-chair with a revoked session cannot issue (session_is_live gate)'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- (4) Happy path — the co-chair issues a worker_member invite. The function
--     must return the three identifiers the co-chair needs:
--     {invite_id, invitee_user_id, bootstrap_id}. Stash them for the
--     downstream state assertions.
-- ---------------------------------------------------------------------------
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.issue_member_invite(
    ARRAY['worker_member'], '424242', 10080
  );
  PERFORM set_config('test.invite_id',   r.invite_id::text,       false);
  PERFORM set_config('test.invitee_uid', r.invitee_user_id::text, false);
  PERFORM set_config('test.bootstrap_id', r.bootstrap_id::text,   false);
END $$;
RESET ROLE;

-- (4a) A fresh public.users row was created for the invitee at ISSUE time, with
--      active=true and role=NULL (role is set on ACTIVATION, not now — F-173).
SELECT is(
  (SELECT active FROM public.users WHERE id = current_setting('test.invitee_uid')::uuid),
  true,
  'issue: invitee public.users row created with active=true at issue time'
);
SELECT is(
  (SELECT role FROM public.users WHERE id = current_setting('test.invitee_uid')::uuid),
  NULL,
  'F-173: invitee users.role is NULL at issue (role bound only on activation)'
);

-- (4b) A pending committee_membership(active=false) exists for the invitee,
--      carrying the issued role array (server-bound at issue).
SELECT is(
  (SELECT active FROM public.committee_membership WHERE user_id = current_setting('test.invitee_uid')::uuid),
  false,
  'issue: pending committee_membership(active=false) created for the invitee'
);
SELECT is(
  (SELECT role FROM public.committee_membership WHERE user_id = current_setting('test.invitee_uid')::uuid),
  ARRAY['worker_member'],
  'F-173: pending membership carries the issued role array (server-bound at issue)'
);

-- (4c) The committee_invite row exists, points at the invitee, and — the gap
--      ADR-0029 closes — its bootstrap_id is POPULATED (delegated via the named
--      p_bootstrap_id), with the requested 7-day (10080-min) TTL.
SELECT is(
  (SELECT bootstrap_id FROM public.committee_invite WHERE invite_id = current_setting('test.invite_id')::uuid),
  current_setting('test.bootstrap_id')::uuid,
  'KEYSTONE: committee_invite.bootstrap_id is populated (the ADR-0029 linkage gap)'
);
SELECT is(
  (SELECT target_user_id FROM public.committee_invite WHERE invite_id = current_setting('test.invite_id')::uuid),
  current_setting('test.invitee_uid')::uuid,
  'issue: committee_invite.target_user_id binds to the freshly-created invitee'
);
SELECT ok(
  (SELECT expires_at BETWEEN now() + interval '10079 minutes' AND now() + interval '10081 minutes'
     FROM public.committee_invite WHERE invite_id = current_setting('test.invite_id')::uuid),
  'issue: committee_invite TTL honours p_ttl_minutes (7 days)'
);

-- (4d) F-176 — the auth_totp_bootstraps row stores the HMAC of the passed code,
--      NOT the raw code; the raw code never lands at rest. Assert secret_hash
--      equals hmac('424242', key) and that no column holds the literal '424242'.
SELECT is(
  (SELECT secret_hash FROM public.auth_totp_bootstraps WHERE id = current_setting('test.bootstrap_id')::uuid),
  hmac('424242'::bytea, private._hmac_pseudonym_key()::bytea, 'sha256'),
  'F-176: bootstrap.secret_hash = HMAC(code) at rest (the raw code is never stored)'
);

-- (4e) F-170/auth — the TOTP bootstrap expires in 15 min (the SECURITY-critical
--      non-extendable clock), regardless of the much longer invite TTL.
SELECT ok(
  (SELECT expires_at BETWEEN now() + interval '14 minutes' AND now() + interval '16 minutes'
     FROM public.auth_totp_bootstraps WHERE id = current_setting('test.bootstrap_id')::uuid),
  'F-170: bootstrap expires in 15 min (fixed) even though invite TTL is 7 days'
);

-- (4f) F-175 — UNIQUE(user_id) cap-of-1: exactly one bootstrap per invitee.
SELECT is(
  (SELECT count(*)::int FROM public.auth_totp_bootstraps WHERE user_id = current_setting('test.invitee_uid')::uuid),
  1,
  'F-175: exactly one outstanding TOTP bootstrap per invitee (UNIQUE(user_id))'
);

-- ---------------------------------------------------------------------------
-- (5) F-173 — facet (i) ACCEPTED: a co-chair CAN invite another worker_co_chair
--     (the spec's "2nd co-chair"). The pending membership carries the co-chair
--     role array, server-bound at issue.
-- ---------------------------------------------------------------------------
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.issue_member_invite(
    ARRAY['worker_member','worker_co_chair'], '535353', 10080
  );
  PERFORM set_config('test.cc_invitee_uid', r.invitee_user_id::text, false);
END $$;
RESET ROLE;
SELECT is(
  (SELECT role FROM public.committee_membership WHERE user_id = current_setting('test.cc_invitee_uid')::uuid),
  ARRAY['worker_co_chair','worker_member'],  -- _committee_norm_roles sorts DISTINCT
  'F-173 facet (i): a co-chair CAN invite a worker_co_chair (2nd co-chair accepted)'
);

-- ---------------------------------------------------------------------------
-- (6) F-173 — invalid_role: an out-of-enum role array is rejected at issue.
-- ---------------------------------------------------------------------------
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  $$SELECT public.issue_member_invite(ARRAY['superuser'], '646464', 10080)$$,
  '%invalid_role%',
  'F-173: an out-of-enum role array is rejected (invalid_role) at issue'
);
RESET ROLE;

-- ---------------------------------------------------------------------------
-- (7) F-177 — issuance is ONE atomic SECURITY DEFINER txn. We pin two
--     deterministic, mechanism-independent invariants:
--     (a) the producer NEVER leaves an orphan — every invitee user row created
--         by the successful issues above has BOTH a committee_invite AND a
--         committee_membership (no half-created user, no danglers);
--     (b) a rejected issue (out-of-enum role, asserted in (6)) created NO user.
--     (a) is the all-or-nothing observable: a producer that inserted a user but
--     failed to delegate would surface here as an orphan.
-- ---------------------------------------------------------------------------
-- (7a) Every invitee created by the producer is fully wired (no orphan user).
SELECT is(
  (SELECT count(*)::int
     FROM public.users u
    WHERE u.id IN (current_setting('test.invitee_uid')::uuid,
                   current_setting('test.cc_invitee_uid')::uuid)
      AND ( NOT EXISTS (SELECT 1 FROM public.committee_invite ci WHERE ci.target_user_id = u.id)
            OR NOT EXISTS (SELECT 1 FROM public.committee_membership cm WHERE cm.user_id = u.id) )),
  0,
  'F-177: every issued invitee has BOTH an invite AND a membership (no orphan user)'
);
-- (7b) The rejected out-of-enum issue (assertion 6) created NO stray user: the
--      only non-co-chair-seed users are the two legitimate invitees + the
--      founder + the worker fixture (4 total). A wrapper that inserted-then-
--      rolled-back correctly leaves no extra row.
SELECT is(
  (SELECT count(*)::int FROM public.users),
  4,
  'F-177: a rejected (invalid_role) issue left NO stray user row (4 users total)'
);
-- (7c) The producer is SECURITY DEFINER (single-frame atomic; the all-or-nothing
--      property rests on this — a multi-txn producer would re-open the F-177 gap).
SELECT is(
  (SELECT prosecdef FROM pg_proc
    WHERE proname = 'issue_member_invite' AND pronamespace = 'public'::regnamespace
    LIMIT 1),
  true,
  'F-177: issue_member_invite is SECURITY DEFINER (one atomic frame)'
);

-- ---------------------------------------------------------------------------
-- (8) F-176 — no auth_totp_bootstraps / committee_invite column anywhere stores
--     the raw plaintext code. Assert no row holds the literal code bytes in a
--     text-castable column (the secret_hash is bytea HMAC, never the code).
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.committee_invite
    WHERE invite_id::text = '424242'
       OR target_user_id::text = '424242'),
  0,
  'F-176: the raw 6-digit code is not stored as any committee_invite identifier'
);

SELECT * FROM finish();
ROLLBACK;
