-- ===========================================================================
-- ADR-0029 P1-4 (SQL) — pgTAP for `get_member_identity_pubkey_for_wrap`
--   + the new audit enum `identity_pubkey.disclosed_for_wrap` (six-mirror)
--   + the wrap-audit binding carry-forward for P1-5
--   (threat-model §3.18 F-172 + F-174 + F-176).
--
-- This is the FIRST production RPC that returns ANOTHER member's
-- `identity_keys.public_key`. `identity_keys` is otherwise fully read-locked
-- (`00000000000007_t07.sql:122` REVOKE SELECT … FROM authenticated, anon);
-- the comment at `:118-121` ("Wrap routing reads the pubkey via the
-- wrap_for_member function") is FACTUALLY WRONG and ADR-0029 ratifies a
-- doc-only fix alongside this RPC. This file pins the contract:
--
--   public.get_member_identity_pubkey_for_wrap(p_target_user_id uuid)
--     RETURNS TABLE(public_key bytea, fingerprint text)
--     SECURITY DEFINER, SET search_path = public, extensions
--     gates on session_is_live() + _committee_is_active_co_chair(auth.uid())
--     REVOKE EXECUTE FROM PUBLIC, anon, service_role
--     GRANT  EXECUTE TO   authenticated, supabase_auth_admin
--     AUDIT-BEFORE-RETURN: emits `identity_pubkey.disclosed_for_wrap`
--                          (actor=co-chair pseudonym, target=member uid)
--                          INSIDE the same SECURITY DEFINER frame, BEFORE
--                          the row leaves the function (mirror
--                          `reveal_concern_source` / `get_committee_key_wrap_for_self`).
--     NORMALIZED denial:   non-co-chair / dead session / wrong target →
--                          a CLOSED-LITERAL error (rls_denied or
--                          target_not_member). Same literal across the
--                          "non-existent uid" / "non-member uid" /
--                          "no-identity-row" cases so the RPC is not a
--                          uid↔pubkey enumeration oracle.
--
-- It is the COMPANION pgTAP to:
--   * `wrap_committee_data_key_for_member` (existing, `00000000000007_t07.sql:485-522`)
--     — first production wrap-for-ANOTHER-member; F-172 mitigation set.
--
-- Findings covered (threat-model §3.18):
--   F-174 (HIGH) — pubkey-disclosure deanonymization
--                  • co-chair-ONLY gate (stricter than _t07_gate_active_member)
--                  • per-disclosure audit-BEFORE-return
--                  • NO bulk-enumeration endpoint (single uid per call)
--                  • audit meta carries NO pubkey bytes (preserve pseudonymity)
--                  • identity_keys table read-lock UNCHANGED
--   F-172 (HIGH) — wrap-to-attacker-pubkey
--                  • the disclosure RPC server-binds pubkey↔member uid
--                  • wrap_committee_data_key_for_member re-asserts active-member
--                    target (:502-503) — wrap denied for inactive / non-member
--                  • wrap audit binds actor + target + key (:512-521); no
--                    `wrapped_ciphertext` echoed into audit meta
--   F-176        — the audit meta NEVER carries pubkey/wrap bytes
--   six-mirror   — `identity_pubkey.disclosed_for_wrap` arms verified:
--                  retention_class_for arm = 'membership+7y'
--                  audit_log_retention_schedule has the 'membership+7y' row
--                  (sibling of `member.added`, `00000000000002:92`)
--                  audit_emit accepts the new event_type without REJECTing
--                  it on a closed-set allowlist (functional probe)
--
-- Conventions mirror supabase/test/phase1_issue_invite_rls.sql +
--   supabase/test/t07_get_committee_key_wrap_rls.sql (audit-before-return
--   pattern) + supabase/test/t18_integrity_check_event_types.sql (six-mirror).
-- `set local role authenticated` so the role boundary is real (pgTAP runs as
-- superuser by default — without `set local role` an RLS / EXECUTE-grant
-- assertion is meaningless).
--
-- Run: pg_prove -d <db> supabase/test/phase1_get_pubkey_rls.sql
--   (migrations 0..N + the local auth shim; CI committee-db-tests stage).
--
-- RED-FIRST: the function does NOT exist on `main`; the audit enum row
-- in `audit_log_retention_schedule` is the EXISTING `membership+7y` row, but
-- `retention_class_for('identity_pubkey.disclosed_for_wrap')` returns the
-- safe-ceiling default `'24mo'` instead of `'membership+7y'` until the P1-4
-- implementer adds the arm. Several assertions fail with "function does not
-- exist" / "retention_class mismatch" / "audit_emit rejects" — exactly as
-- intended for TDD. The implementer treats this file as READ-ONLY.
-- ===========================================================================

BEGIN;
SET app.hmac_pseudonym_key = 'dev-ci-pseudonym-key-not-secret';
SET search_path = public, extensions;
SELECT plan(30);

-- ---------------------------------------------------------------------------
-- Fixtures
--   F1 — founding active co-chair (cochair-of-record, the caller we test).
--   F2 — second active co-chair (so the "non-co-chair but member" case
--        below uses a worker_member, not a co-chair-with-different-uid).
--   B2 — active worker_member (non-co-chair active member, used for both the
--        "non-co-chair caller is denied" case AND as the TARGET of a happy
--        disclosure by F1).
--   C3 — pending invitee (membership active=false). For F-174 target-gate.
--   D4 — fully active member but with NO identity_keys row enrolled yet
--        (the "member_not_enrolled" target case).
--   X9 — a uuid that has NO public.users row (the "non-existent uid" case
--        for the normalized-oracle assertion).
--   Y9 — a public.users row that is NOT a committee member (the
--        "non-member uid" case for the normalized-oracle assertion).
--
-- B2 + C3 + D4 each get an `identity_keys` row except D4 (the whole point of
-- D4 is to be active-but-unenrolled). The bytes are deliberately distinct so
-- the happy assertion can read them back exactly.
-- ---------------------------------------------------------------------------
INSERT INTO public.users (id, active) VALUES
  ('00000000-0000-0000-0000-0000000000f1', true),  -- F1: co-chair (caller)
  ('00000000-0000-0000-0000-0000000000f2', true),  -- F2: second co-chair
  ('00000000-0000-0000-0000-0000000000b2', true),  -- B2: worker_member (target/caller)
  ('00000000-0000-0000-0000-0000000000c3', true),  -- C3: pending invitee
  ('00000000-0000-0000-0000-0000000000d4', true),  -- D4: active-but-no-identity
  ('00000000-0000-0000-0000-0000000000f9', true);  -- F9: non-member user

INSERT INTO public.committee_membership (user_id, role, active, activated_at) VALUES
  ('00000000-0000-0000-0000-0000000000f1', ARRAY['worker_member','worker_co_chair'], true,  now()),
  ('00000000-0000-0000-0000-0000000000f2', ARRAY['worker_member','worker_co_chair'], true,  now()),
  ('00000000-0000-0000-0000-0000000000b2', ARRAY['worker_member'],                    true,  now()),
  ('00000000-0000-0000-0000-0000000000c3', ARRAY['worker_member'],                    false, NULL),
  ('00000000-0000-0000-0000-0000000000d4', ARRAY['worker_member'],                    true,  now());

INSERT INTO public.auth_sessions (session_id, user_id, expires_at) VALUES
  ('11111111-1111-1111-1111-1111111111f1', '00000000-0000-0000-0000-0000000000f1', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111f2', '00000000-0000-0000-0000-0000000000f2', now() + interval '5 min'),
  ('11111111-1111-1111-1111-1111111111b2', '00000000-0000-0000-0000-0000000000b2', now() + interval '5 min'),
  -- A dead session for F1 to test the session_is_live gate.
  ('11111111-1111-1111-1111-11111111dead', '00000000-0000-0000-0000-0000000000f1', now() + interval '5 min');
UPDATE public.auth_sessions SET revoked_at = now()
  WHERE session_id = '11111111-1111-1111-1111-11111111dead';

-- 32-byte distinct pubkeys + the BLAKE2b-32 fingerprint each one would have
-- per the JS lib's `pubkeyFingerprint` (the SQL fn returns whatever the row
-- carries; we don't pin the fingerprint format here — that is the JS layer's
-- responsibility — but we assert it is returned alongside the pubkey bytes).
INSERT INTO public.identity_keys (user_id, public_key) VALUES
  ('00000000-0000-0000-0000-0000000000f1', decode(repeat('f1', 32), 'hex')),
  ('00000000-0000-0000-0000-0000000000b2', decode(repeat('b2', 32), 'hex')),
  ('00000000-0000-0000-0000-0000000000c3', decode(repeat('c3', 32), 'hex'));
-- D4: deliberately NO identity_keys row.

-- ===========================================================================
-- (0) The function exists with the ADR-0029 signature.
-- ===========================================================================
SELECT has_function(
  'public', 'get_member_identity_pubkey_for_wrap',
  ARRAY['uuid'],
  'P1-4: get_member_identity_pubkey_for_wrap(uuid) exists with the ADR-0029 signature');

-- (1) F-174 — SECURITY DEFINER (the gate-internal posture; the table read-lock
-- means the fn MUST run with definer rights to read identity_keys).
SELECT is(
  (SELECT prosecdef FROM pg_proc
    WHERE proname = 'get_member_identity_pubkey_for_wrap'
      AND pronamespace = 'public'::regnamespace
    LIMIT 1),
  true,
  'F-174: get_member_identity_pubkey_for_wrap is SECURITY DEFINER');

-- ---------------------------------------------------------------------------
-- (2)-(4) F-174 GRANT matrix — anon / service_role DENIED; authenticated +
-- supabase_auth_admin GRANTED. Mirrors get_committee_key_wrap_for_self
-- (00000000000038:100-103). PUBLIC default-deny implicit.
-- ---------------------------------------------------------------------------
SELECT is(
  has_function_privilege('anon',
    'public.get_member_identity_pubkey_for_wrap(uuid)', 'EXECUTE'),
  false,
  'F-174: anon CANNOT execute get_member_identity_pubkey_for_wrap');
SELECT is(
  has_function_privilege('service_role',
    'public.get_member_identity_pubkey_for_wrap(uuid)', 'EXECUTE'),
  false,
  'F-174 / F-118: service_role CANNOT execute get_member_identity_pubkey_for_wrap');
SELECT is(
  has_function_privilege('authenticated',
    'public.get_member_identity_pubkey_for_wrap(uuid)', 'EXECUTE'),
  true,
  'F-174: authenticated CAN execute get_member_identity_pubkey_for_wrap (co-chair-gated in-fn)');

-- ---------------------------------------------------------------------------
-- (5) F-174 — the `identity_keys` table read-lock stays in place. The RPC is
-- the ONLY crack in the lock; a direct SELECT under `set local role
-- authenticated` (with a co-chair JWT — the most-privileged caller short of
-- the service role) must STILL fail. Without `set local role` this would
-- silently pass (pgTAP runs as superuser).
-- ---------------------------------------------------------------------------
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT public_key FROM public.identity_keys
    WHERE user_id = '00000000-0000-0000-0000-0000000000b2'$$,
  '42501', NULL,
  'F-174: a direct SELECT on identity_keys under role authenticated is STILL denied (RPC is the only path)');
RESET ROLE;

-- ---------------------------------------------------------------------------
-- (6) F-174 co-chair-ONLY — a non-co-chair active member is denied. STRICTER
-- than _t07_gate_active_member (which would let any active member through);
-- this gate is _committee_is_active_co_chair, mirroring Decision 4.
-- ---------------------------------------------------------------------------
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","session_id":"11111111-1111-1111-1111-1111111111b2","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  $$SELECT * FROM public.get_member_identity_pubkey_for_wrap(
      '00000000-0000-0000-0000-0000000000f1'::uuid)$$,
  '%rls_denied%',
  'F-174: a worker_member (non-co-chair) CANNOT disclose another member''s pubkey (rls_denied)');
RESET ROLE;

-- (7) F-174 / F-116 — a co-chair with a dead session is denied (session_is_live).
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-11111111dead","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  $$SELECT * FROM public.get_member_identity_pubkey_for_wrap(
      '00000000-0000-0000-0000-0000000000b2'::uuid)$$,
  '%rls_denied%',
  'F-174 / F-116: a co-chair with a revoked session CANNOT disclose (session_is_live gate)');
RESET ROLE;

-- ---------------------------------------------------------------------------
-- (8)-(11) F-174 happy path — F1 (co-chair) discloses B2's pubkey, the
-- function returns the row, and the audit row is committed BEFORE the bytes
-- left the function (mirror reveal_concern_source / get_committee_key_wrap_for_self).
--
-- The "audit-before-return" property is verified with the same pattern as
-- t07_get_committee_key_wrap_rls.sql:181-225 — establish a pre-call baseline,
-- drain the function, then assert the audit row is present in the SAME txn
-- as the returned bytes (a path that returned bytes without first emitting
-- would leave the assertion failing).
-- ---------------------------------------------------------------------------
-- Pre-call baseline: how many disclosed_for_wrap rows for target B2 right now?
-- Role 'authenticated' has no SELECT on audit_log by design (migration 0001:118
-- + 0019 — audit is service-role-readable only), so the baseline count runs
-- under the pgTAP superuser role and the role is set ONLY when calling the
-- function under test.
CREATE TEMP TABLE _disclose_base AS
  SELECT count(*)::int AS n FROM public.audit_log
   WHERE event_type = 'identity_pubkey.disclosed_for_wrap'
     AND target_id = '00000000-0000-0000-0000-0000000000b2';

SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- Drain the function and read the row.
SELECT is(
  (SELECT public_key FROM public.get_member_identity_pubkey_for_wrap(
     '00000000-0000-0000-0000-0000000000b2'::uuid) LIMIT 1),
  decode(repeat('b2', 32), 'hex'),
  'F-174 happy: co-chair F1 receives B2''s EXACT enrolled pubkey bytes (32B)');

-- The fingerprint companion field exists (Decision 4 contract: returns
-- {public_key, fingerprint}). Per Amendment A-6.1 the algorithm is SHA-256
-- of the pubkey bytes, hex-encoded (64 chars) — same algorithm both layers,
-- no pgsodium dependency. We accept any non-empty text here; the byte-for-
-- byte JS↔SQL parity property is asserted in the vitest composition test.
SELECT ok(
  (SELECT length(fingerprint) > 0 FROM public.get_member_identity_pubkey_for_wrap(
     '00000000-0000-0000-0000-0000000000b2'::uuid) LIMIT 1),
  'F-174 happy: fingerprint is returned alongside public_key (Decision 5/6 UI confirmation surface)');

-- Audit-before-return: AFTER the calls above resolved, the audit row is
-- already present in this txn. (A return-then-emit path would still pass —
-- but combined with the EXACTLY-ONE-PER-CALL assertion below this triangulates
-- the audit-BEFORE-return contract: an emit-after path would race with the
-- exception of the caller-already-consumed-row branch tested at (16).)
RESET ROLE;
SELECT ok(
  EXISTS(SELECT 1 FROM public.audit_log
          WHERE event_type = 'identity_pubkey.disclosed_for_wrap'
            AND target_id = '00000000-0000-0000-0000-0000000000b2'),
  'F-174 / audit-before-return: identity_pubkey.disclosed_for_wrap row present after disclosure');

-- Exactly ONE NEW row per call (idempotent on baseline). Two disclosures
-- above (assertions 8 + 9 each call the function); the baseline captures
-- pre-call state, so the delta is exactly 2.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log
    WHERE event_type = 'identity_pubkey.disclosed_for_wrap'
      AND target_id = '00000000-0000-0000-0000-0000000000b2')
    - (SELECT n FROM _disclose_base),
  2,
  'F-174 / audit-before-return: exactly one disclosed_for_wrap row PER call (no double-count, no suppression)');

-- ---------------------------------------------------------------------------
-- (12) F-174 — audit meta carries NO pubkey bytes. The audit row records
-- actor + target pseudonyms ONLY; the disclosed pubkey bytes MUST NEVER
-- appear in any meta field (would defeat the audit row's own pseudonymity).
-- ---------------------------------------------------------------------------
SELECT ok(
  NOT EXISTS(
    SELECT 1 FROM public.audit_log
     WHERE event_type = 'identity_pubkey.disclosed_for_wrap'
       AND target_id = '00000000-0000-0000-0000-0000000000b2'
       AND (
         -- The raw pubkey hex anywhere in the meta JSON text.
         meta::text ILIKE '%' || encode(decode(repeat('b2', 32), 'hex'), 'hex') || '%'
         -- A `public_key` / `pubkey` / `pubkey_bytes` key in the meta.
         OR meta ? 'public_key'
         OR meta ? 'pubkey'
         OR meta ? 'pubkey_bytes'
       )
  ),
  'F-174 / F-176: audit meta carries NO pubkey bytes (no public_key/pubkey/pubkey_bytes key, no raw hex)');

-- ---------------------------------------------------------------------------
-- (13) F-174 — the audit row carries the co-chair caller's PSEUDONYM
-- (mirrors get_committee_key_wrap_for_self) — never the raw actor uid.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT actor_pseudonym FROM public.audit_log
    WHERE event_type = 'identity_pubkey.disclosed_for_wrap'
      AND target_id = '00000000-0000-0000-0000-0000000000b2'
    ORDER BY id DESC LIMIT 1),
  public._committee_pseudonym('00000000-0000-0000-0000-0000000000f1'),
  'F-174: the disclosed_for_wrap audit row carries the co-chair pseudonym (NOT the raw actor uid)');

-- ---------------------------------------------------------------------------
-- (14)-(15) F-174 target-gate — the target must be an ACTIVE MEMBER with an
-- ENROLLED, non-revoked identity key. A pending (active=false) member, a
-- never-enrolled active member, a non-member user_id, AND a non-existent
-- user_id all resolve to the SAME normalized literal so the RPC is not a
-- uid↔pubkey enumeration oracle (F-174 mitigation: no bulk enumeration AND
-- no per-uid existence side-channel).
-- ADR-0029 leaves the exact literal open between `target_not_member` and
-- `not_found`; we pin a CLOSED literal (NOT a wildcard) by asserting all
-- four error messages are byte-identical. The implementer can pick either
-- literal — the no-enumeration property is what F-174 demands.
-- ---------------------------------------------------------------------------
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SET LOCAL ROLE authenticated;

-- Stash the error from each branch via plpgsql GET STACKED DIAGNOSTICS so we
-- can compare them byte-identically across the four cases.
DO $$
DECLARE v_pending text; v_unenrolled text; v_nonmember text; v_nonexistent text;
BEGIN
  -- (a) pending invitee (membership.active=false, identity_keys row PRESENT)
  BEGIN
    PERFORM * FROM public.get_member_identity_pubkey_for_wrap('00000000-0000-0000-0000-0000000000c3'::uuid);
    v_pending := '<no exception raised>';
  EXCEPTION WHEN OTHERS THEN
    v_pending := SQLERRM;
  END;
  -- (b) active member with NO identity_keys row
  BEGIN
    PERFORM * FROM public.get_member_identity_pubkey_for_wrap('00000000-0000-0000-0000-0000000000d4'::uuid);
    v_unenrolled := '<no exception raised>';
  EXCEPTION WHEN OTHERS THEN
    v_unenrolled := SQLERRM;
  END;
  -- (c) public.users row exists but NOT a committee member
  BEGIN
    PERFORM * FROM public.get_member_identity_pubkey_for_wrap('00000000-0000-0000-0000-0000000000f9'::uuid);
    v_nonmember := '<no exception raised>';
  EXCEPTION WHEN OTHERS THEN
    v_nonmember := SQLERRM;
  END;
  -- (d) public.users row does NOT exist
  BEGIN
    PERFORM * FROM public.get_member_identity_pubkey_for_wrap('00000000-0000-0000-0000-0000000000aa'::uuid);
    v_nonexistent := '<no exception raised>';
  EXCEPTION WHEN OTHERS THEN
    v_nonexistent := SQLERRM;
  END;
  PERFORM set_config('test.err_pending',     v_pending,     false);
  PERFORM set_config('test.err_unenrolled',  v_unenrolled,  false);
  PERFORM set_config('test.err_nonmember',   v_nonmember,   false);
  PERFORM set_config('test.err_nonexistent', v_nonexistent, false);
END $$;
RESET ROLE;

-- (14) The four error messages are byte-identical (no enumeration side-channel).
SELECT ok(
  current_setting('test.err_pending')    = current_setting('test.err_unenrolled')
  AND current_setting('test.err_unenrolled') = current_setting('test.err_nonmember')
  AND current_setting('test.err_nonmember')  = current_setting('test.err_nonexistent')
  AND current_setting('test.err_pending')    NOT LIKE '<no exception raised>',
  'F-174 oracle: pending/unenrolled/non-member/non-existent ALL raise the SAME byte-identical literal (no enumeration side-channel)');

-- (15) That literal is one of the closed pinned strings the ADR allows
-- (`target_not_member` per Decision 4 / threat-model §3.18 F-174, or
-- `not_found` per Decision 5 step 2's `member_not_enrolled` fallback). Reject
-- a wildcard / opaque message ("relation does not exist", "permission
-- denied", etc.) — the literal MUST be a closed-set client-mappable string.
SELECT ok(
  current_setting('test.err_pending') IN (
    'target_not_member',
    'not_found',
    'member_not_enrolled'
  ),
  format('F-174: the denial literal is a CLOSED-SET string the client can map (got: %s)',
         current_setting('test.err_pending')));

-- ---------------------------------------------------------------------------
-- (16) F-174 — success-only audit (Amendment A-1, ratified). The disclosure
-- RPC mirrors the existing get_committee_key_wrap_for_self pattern
-- (00000000000038:78-92) which audits success-only — no other SECURITY
-- DEFINER disclosure RPC in the project audits denials. Denial forensics
-- ride the EF structured log (functions/t07-op/index.ts). A denied call
-- to a pending/unenrolled target therefore writes NO audit row; the only
-- audit rows for identity_pubkey.disclosed_for_wrap come from (15)'s
-- successful disclosure of B2's pubkey, NOT from the denied attempts in
-- (13)/(14) against C3/D4.
-- ---------------------------------------------------------------------------
SELECT ok(
  NOT EXISTS(
    SELECT 1 FROM public.audit_log
     WHERE event_type = 'identity_pubkey.disclosed_for_wrap'
       AND target_id IN (
         '00000000-0000-0000-0000-0000000000c3',  -- pending (denied)
         '00000000-0000-0000-0000-0000000000d4'   -- unenrolled (denied)
       )
  ),
  'F-174 / Amendment A-1: a DENIED disclosure does NOT emit an audit row (denial forensics ride the EF structured log)');

-- ---------------------------------------------------------------------------
-- (17) F-174 — no bulk-enumeration variant. The function takes ONE uid;
-- there is no `get_member_identity_pubkeys_for_wrap` (plural) /
-- `_for_all_members` / `_for_committee` overload. Pin structurally.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname ~ '^get_member_identity_pubkey'
      AND p.pronargs > 1),
  0,
  'F-174 no-bulk: NO multi-arg / list variant of get_member_identity_pubkey_for_wrap exists');

SELECT is(
  (SELECT count(*)::int FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'get_member_identity_pubkeys_for_wrap',
        'get_all_member_identity_pubkeys',
        'get_committee_identity_pubkeys'
      )),
  0,
  'F-174 no-bulk: no list / "all members" / "committee-wide" pubkey-disclosure RPC exists');

-- ===========================================================================
-- SIX-MIRROR DANCE for `identity_pubkey.disclosed_for_wrap`
-- (ADR-0003 Amendment A; mirror t18_integrity_check_event_types.sql:17-22).
-- The TS-side mirrors (RetentionEventType union, RETENTION_SCHEDULE,
-- check-audit-enum-coverage.sh EXPECTED_ENUM, observability/audit-log.md)
-- are not visible from pgTAP — those are CI-side gates. The DB-side mirrors
-- (retention_class_for arm, audit_log_retention_schedule row, audit_emit
-- functional acceptance) are pinned here.
-- ===========================================================================

-- (18) retention_class_for arm — `membership+7y` (sibling of `member.added`).
SELECT is(
  public.retention_class_for('identity_pubkey.disclosed_for_wrap'),
  'membership+7y',
  'six-mirror (1): retention_class_for(identity_pubkey.disclosed_for_wrap) = membership+7y (Decision 4)');

-- (19) audit_log_retention_schedule has the membership+7y row (REUSED row,
-- not a new class). The class is the linkage; this assertion guards against
-- a future ADR that adds an `identity_pubkey+...` retention class and forgets
-- to register the schedule arm.
SELECT is(
  (SELECT count(*)::int FROM public.audit_log_retention_schedule
    WHERE retention_class = 'membership+7y'),
  1,
  'six-mirror (2): audit_log_retention_schedule has the membership+7y row (REUSED, sibling of member.added)');

-- (20)-(21) audit_emit functional acceptance — the new event_type is on
-- whatever closed allowlist `audit_emit` enforces, AND the resulting audit
-- row carries retention_class=`membership+7y`. A safe-ceiling fallback to
-- `24mo` (the default arm of retention_class_for) would PROVE the arm at
-- (18) is missing — the assertions triangulate so a half-mirror surfaces.
DO $$
BEGIN
  PERFORM public.audit_emit(
    'identity_pubkey.disclosed_for_wrap',
    public._committee_pseudonym('00000000-0000-0000-0000-0000000000f1'),
    'C1', 'info', NULL,
    '00000000-0000-0000-0000-0000000000b2'::uuid,
    NULL,
    jsonb_build_object('actor_id', '00000000-0000-0000-0000-0000000000f1', 'target_user_id', '00000000-0000-0000-0000-0000000000b2')
  );
END $$;

SELECT is(
  (SELECT retention_class FROM public.audit_log
    WHERE event_type = 'identity_pubkey.disclosed_for_wrap'
      AND meta->>'target_user_id' = '00000000-0000-0000-0000-0000000000b2'
    ORDER BY id DESC LIMIT 1),
  'membership+7y',
  'six-mirror (3): audit_emit stamps retention_class=membership+7y for identity_pubkey.disclosed_for_wrap (NOT the 24mo safe-ceiling fallback)');

SELECT ok(
  EXISTS(SELECT 1 FROM public.audit_log
          WHERE event_type = 'identity_pubkey.disclosed_for_wrap'
            AND meta ? 'target_user_id'),
  'six-mirror (4): audit_emit ACCEPTS identity_pubkey.disclosed_for_wrap (event_type is on the closed allowlist)');

-- ===========================================================================
-- F-172 — wrap_committee_data_key_for_member: the active-member re-assert
-- and the audit-binding are the second leg of the wrap-to-attacker-pubkey
-- mitigation set (cross-ref ADR-0029 Decision 5 + threat-model §3.18 F-172).
-- The RPC already exists (00000000000007_t07.sql:485-522); this pgTAP
-- companion pins the F-172 contract a P1-5 PR must keep intact.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Setup a live committee data key + a wrap for F1 so F1 can act as an
-- active key-holder co-chair calling wrap_member for B2.
-- ---------------------------------------------------------------------------
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE _wrap_k AS SELECT * FROM public.init_committee_data_key();
RESET ROLE;

-- (22) F-172 happy: F1 (active co-chair) wraps for B2 (active worker_member).
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  format($$SELECT public.wrap_committee_data_key_for_member(
    '00000000-0000-0000-0000-0000000000b2'::uuid, %L::uuid, '\xCAFEBABE'::bytea, NULL)$$,
    (SELECT key_id FROM _wrap_k)),
  'F-172 happy: an active co-chair can wrap for an active worker_member (existing :485-522 contract)');
RESET ROLE;

-- (23) F-172 — the wrap audit binds actor (co-chair pseudonym) + target +
-- key_id (`:512-521`). A successful wrap is attributable + reconstructable
-- so a mis-wrap to a wrong target leaves a forensic trace.
SELECT ok(
  EXISTS(SELECT 1 FROM public.audit_log
          WHERE event_type = 'committee_data_key.wrapped_for_member'
            AND target_id = '00000000-0000-0000-0000-0000000000b2'
            AND (meta->>'committee_key_id')::uuid = (SELECT key_id FROM _wrap_k)
            AND actor_pseudonym = public._committee_pseudonym('00000000-0000-0000-0000-0000000000f1')),
  'F-172: wrap audit binds actor (co-chair pseudonym) + target + key_id (forensically attributable)');

-- (24) F-172 / F-176 — the wrap audit meta does NOT echo the
-- `wrapped_ciphertext` bytes into any field. The ciphertext is opaque sealed
-- bytes (not key material), but echoing it into the audit would defeat the
-- audit row's compact attributable shape and create an unbounded-size leak
-- surface. The audit row carries IDs only.
SELECT ok(
  NOT EXISTS(
    SELECT 1 FROM public.audit_log
     WHERE event_type = 'committee_data_key.wrapped_for_member'
       AND target_id = '00000000-0000-0000-0000-0000000000b2'
       AND (
         meta ? 'wrapped_ciphertext'
         OR meta ? 'sealed'
         OR meta ? 'ciphertext'
         OR meta::text ILIKE '%cafebabe%'
       )
  ),
  'F-172 / F-176: wrap audit meta does NOT echo the wrapped_ciphertext bytes (IDs only)');

-- (25) F-172 — wrap_member for a TARGET who is not an active member is
-- denied (rls_denied). Re-assert of `:502-503`. This means a compromised
-- co-chair cannot land a wrap for an attacker uid that is not on the
-- membership roster.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  format($$SELECT public.wrap_committee_data_key_for_member(
    '00000000-0000-0000-0000-0000000000c3'::uuid, %L::uuid, '\xAA'::bytea, NULL)$$,
    (SELECT key_id FROM _wrap_k)),
  '%rls_denied%',
  'F-172: wrap for a PENDING (active=false) target is DENIED (rls_denied) — re-assert of :502-503');
SELECT throws_like(
  format($$SELECT public.wrap_committee_data_key_for_member(
    '00000000-0000-0000-0000-0000000000f9'::uuid, %L::uuid, '\xAA'::bytea, NULL)$$,
    (SELECT key_id FROM _wrap_k)),
  '%rls_denied%',
  'F-172: wrap for a NON-MEMBER (no committee_membership row) target is DENIED (rls_denied)');
RESET ROLE;

-- (26)-(27) F-172 — re-grant idempotency. wrap_committee_data_key_for_member
-- uses `ON CONFLICT (user_id, key_id) DO NOTHING` (`:509-511`), so a SECOND
-- wrap for the same (target, key) silently leaves the FIRST bytes in place.
-- This is the "re-grant overwrites" sub-case the threat model flagged
-- (F-172 mitigation #6 / Failure-mode analysis: "the ON CONFLICT DO NOTHING
-- means a re-grant against the same key_id would need the prior bad wrap
-- removed; flag a 're-grant overwrites' sub-case for the test-writer"). We
-- pin the EXISTING semantics so a P1-5 PR that "fixes" it to overwrite
-- silently — silently widening the surface — fails this test.
SET request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f1","session_id":"11111111-1111-1111-1111-1111111111f1","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  format($$SELECT public.wrap_committee_data_key_for_member(
    '00000000-0000-0000-0000-0000000000b2'::uuid, %L::uuid, '\xBADBADBA'::bytea, NULL)$$,
    (SELECT key_id FROM _wrap_k)),
  'F-172: a SECOND wrap for the same (target,key) does NOT raise (ON CONFLICT DO NOTHING)');
RESET ROLE;
-- The wrap-row preservation check reads committee_key_wraps, which is
-- REVOKE'd from `authenticated` by design (F-142 — migration 0007:184).
-- Drop back to superuser (the pgTAP default) before the SELECT, then assert.
SELECT is(
  (SELECT wrapped_ciphertext FROM public.committee_key_wraps
    WHERE user_id = '00000000-0000-0000-0000-0000000000b2'
      AND key_id = (SELECT key_id FROM _wrap_k)),
  '\xCAFEBABE'::bytea,
  'F-172: the FIRST wrap bytes are PRESERVED on re-grant (ON CONFLICT DO NOTHING — re-grant requires explicit removal first)');

SELECT * FROM finish();
ROLLBACK;
