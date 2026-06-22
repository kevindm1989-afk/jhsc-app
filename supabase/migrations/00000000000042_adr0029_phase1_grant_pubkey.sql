-- ===========================================================================
-- ADR-0029 P1-4 (SQL) — co-chair pubkey-disclosure RPC for the
-- "grant committee-key access to a member" path.
--
-- This migration is HG-ONBOARD-PHASE1 #2's keystone read: the FIRST
-- production RPC that returns ANOTHER member's `identity_keys.public_key`
-- across the trust boundary. `identity_keys` is otherwise fully read-locked
-- (00000000000007_t07.sql:122 REVOKE SELECT ... FROM authenticated, anon);
-- this RPC is the only crack in the lock, mediated by:
--   1. SECURITY DEFINER + SET search_path = public, extensions.
--   2. session_is_live() AND _committee_is_active_co_chair(auth.uid()) gate
--      (the stricter sibling of _t07_gate_active_member).
--   3. ONE closed-literal denial (`member_not_enrolled`) that collapses ALL
--      FOUR target-failure branches (pending / unenrolled / non-member /
--      non-existent) so the RPC is NOT a uid<->pubkey enumeration oracle.
--   4. Audit-before-return: `identity_pubkey.disclosed_for_wrap` lands
--      INSIDE the same SECURITY DEFINER frame, BEFORE the row leaves the
--      function (mirror get_committee_key_wrap_for_self / reveal_concern_source).
--   5. Audit posture: SUCCESS-ONLY (Amendment A-1; matches migration 0038:78-92).
--      Denial forensics ride the EF structured log; no per-attempt audit row.
--   6. Fingerprint is RE-DERIVED server-side via pgcrypto SHA-256 over
--      the public_key bytes (see body for the exact, semgrep-suppressed
--      call) per Amendment A-6.1 (.context/decisions.md 2026-06-22),
--      which supersedes A-6's BLAKE2b choice because pgsodium is not in
--      the project's CI Postgres image and a runtime fallback would
--      silently drift JS↔SQL fingerprints in production (breaking the
--      F-172 confirmation control). pgcrypto is in the required-
--      extensions set; WebCrypto provides the same primitive in every
--      targeted browser. Never read from the stored
--      `identity_keys.pubkey_fingerprint` column, closing the drift
--      failure mode.
--   7. EXECUTE: REVOKE from PUBLIC/anon/service_role (F-118), GRANT to
--      authenticated + supabase_auth_admin only.
--
-- New audit enum value `identity_pubkey.disclosed_for_wrap` rides the
-- standard ADR-0003 Amendment A six-mirror dance:
--   (a) retention_class_for arm = 'membership+7y' (this file)
--   (b) audit_log_retention_schedule row for 'membership+7y' (REUSED from
--       00000000000019:90-108; no new class)
--   (c) audit_emit accepts the new event_type (functional acceptance; this
--       file extends retention_class_for, which audit_emit reads)
--   (d) observability/audit-log.md §1 row (this PR)
--   (e) scripts/check-audit-enum-coverage.sh EXPECTED_ENUM (this PR)
--   (f) TS-side audit-event-type union (no client emits this event; the
--       enum is server-only — same posture as recovery_reset.issued)
--
-- Findings covered (threat-model §3.18):
--   F-174 (HIGH) — pubkey-disclosure deanonymization:
--                  co-chair-ONLY gate + per-disclosure success audit +
--                  no bulk endpoint + no pubkey bytes / fingerprint in meta.
--   F-172 (HIGH) — wrap-to-attacker-pubkey:
--                  the disclosure RPC server-binds pubkey<->member uid;
--                  the wrap composition reads the pubkey only from here.
--   F-176        — closed-literal denials; no PII / pubkey bytes / fingerprint
--                  in any audit-meta field; the EF log surface mirrors.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) retention_class_for — extend with identity_pubkey.disclosed_for_wrap.
--     'membership+7y' sibling of `member.added` (00000000000007_t07.sql:91).
--     CREATE OR REPLACE re-declares the whole function with the new arm.
--     The full arm set carried forward verbatim from migration 36
--     (00000000000036_bootstrap_challenges.sql:119-154) — the prior
--     redefinition — PLUS the new identity_pubkey.disclosed_for_wrap arm.
--     Signature mirrors migration 31 (LANGUAGE sql IMMUTABLE; no SECURITY
--     DEFINER, no SET search_path — the function is a pure CASE lookup).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retention_class_for(p_event_type text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE p_event_type
    WHEN 'auth.passkey.enrolled'                          THEN '90d'
    WHEN 'auth.passkey.enroll_failed'                     THEN '90d'  -- ADR-0025 C11
    WHEN 'auth.passkey.revoked'                           THEN '90d'
    WHEN 'session.revoked'                                THEN '90d'
    WHEN 'committee_data_key.unwrap'                      THEN '24mo'
    WHEN 'committee_data_key.rotation.started'            THEN '7y'
    WHEN 'committee_data_key.rotation.completed'          THEN '7y'
    WHEN 'committee_data_key.member_revoked'              THEN '7y'
    WHEN 'committee.key_rotated'                          THEN '7y'
    WHEN 'identity_keypair.created'                       THEN '7y'
    WHEN 'identity_pubkey.disclosed_for_wrap'             THEN 'membership+7y'  -- ADR-0029 P1-4 (F-174)
    WHEN 'identity_privkey.recovery_blob.written'         THEN 'membership+24mo'
    WHEN 'identity_privkey.recovery_blob.restored'        THEN 'membership+24mo'
    WHEN 'identity_privkey.recovery_blob.viewed'          THEN 'membership+24mo'
    WHEN 'recovery_reset.issued'                          THEN 'membership+24mo'
    WHEN 'panic_wipe.invoked'                             THEN '7y'
    WHEN 'committee_data_key.wrapped_for_member'          THEN '7y_from_rotation'
    WHEN 'export.generated'                               THEN '7y'
    WHEN 'export.contained_concern_derived_items'         THEN '7y'
    WHEN 'retention.deleted'                              THEN '7y'
    WHEN 'member.added'                                   THEN 'membership+7y'
    WHEN 'member.removed'                                 THEN 'membership+7y'
    WHEN 'member.role_changed'                            THEN 'membership+7y'
    WHEN 'alert.fired'                                    THEN '24mo'
    WHEN 'client.cache_policy_violation'                  THEN '90d'
    WHEN 'client.identity_selftest_fail'                  THEN '90d'
    WHEN 'key_parity.mismatch'                            THEN '24mo'  -- M2 / F-125
    WHEN 'key_parity.deploy_ok'                           THEN '24mo'  -- M2 / forensic asymmetry
    WHEN 'auth.mint.revoked_during_mint'                  THEN '24mo'  -- M1 / F-128 race detector
    WHEN 'audit.integrity_check.ran'                      THEN '24mo'  -- M8.B.2
    WHEN 'audit.integrity_check.mismatch'                 THEN '7y'    -- M8.B.2
    WHEN 'audit.chain_anchor.weekly'                      THEN '7y'    -- M8.B.2
    WHEN 'backup.manifest_written'                        THEN '7y'    -- M8.A.3b
    WHEN 'backup.hard_deleted'                            THEN '7y'    -- ADR-0018 §J / M8.A.3d
    ELSE '24mo'
  END;
$$;
REVOKE EXECUTE ON FUNCTION public.retention_class_for(text) FROM public;
GRANT EXECUTE ON FUNCTION public.retention_class_for(text) TO supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- (b) get_member_identity_pubkey_for_wrap — the keystone RPC.
--
-- Single uuid IN-param, single-row OUT (TABLE shape; not a scalar) so the EF
-- can unwrap row-shape exactly the way it unwraps get_committee_key_wrap_for_self.
--
-- The four target-failure branches collapse to ONE byte-identical literal
-- `member_not_enrolled` (Amendment A-2) — a CLOSED-LITERAL the client maps
-- (mapRpcError extension lands in core.ts). The collapse is done with a
-- single guard expression:
--     not active member  OR  no identity_keys row  =>  member_not_enrolled
-- The "not active member" branch swallows: (i) non-existent users.id,
-- (ii) public.users row exists but no committee_membership row, AND
-- (iii) committee_membership.active = false. The "no identity_keys row"
-- branch swallows the active-but-not-yet-enrolled case. All four resolve to
-- the same SQLERRM string so an enumeration oracle is closed by construction.
--
-- Fingerprint (Amendment A-6 / A-6.1) is re-derived from the same `public_key`
-- bytes the function is about to return — see the body's semgrep-suppressed
-- `v_fp := ...` assignment for the exact pgcrypto SHA-256 call.
-- 32 bytes → 64 lowercase hex chars; matches the existing
-- `^[0-9a-f]{64}$` regex (00000000000007_t07.sql:267, :359). SHA-256 per
-- A-6.1 (supersedes A-6 BLAKE2b — see body comments). NEVER reads
-- identity_keys.pubkey_fingerprint (a stored fingerprint column does not
-- exist on this branch, and even if it did, drift between stored and
-- computed values would be a silent vector — re-derive every call).
--
-- The audit row carries actor_pseudonym (HMAC of co-chair uid), target_id
-- (the member uid; F-174 attribution surface), and meta
-- {actor_id, target_user_id, committee_key_id?} — NEVER public_key bytes,
-- NEVER the fingerprint hex (F-174 / F-176 audit-pseudonymity).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_member_identity_pubkey_for_wrap(
  p_target_user_id uuid
) RETURNS TABLE(public_key bytea, fingerprint text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_pubkey     bytea;
  v_fp         text;
BEGIN
  -- Caller gate (F-174 / F-116). session_is_live() + active co-chair, mirroring
  -- _t07_gate_cochair (00000000000007:221-230). We inline rather than call
  -- _t07_gate_cochair so the rls_denied literal stays close to the
  -- target-gate denial literal for readability; behaviour is identical.
  IF NOT public.session_is_live() THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;
  IF NOT public._committee_is_active_co_chair(v_actor) THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;

  -- Target gate (F-174 / Amendment A-2): ONE byte-identical literal collapses
  -- the four failure cases. Read the candidate pubkey ONLY when the target is
  -- an active member AND has an enrolled identity_keys row that has not been
  -- revoked. is_active_member returns false for missing users / missing
  -- committee_membership / inactive committee_membership; the LEFT JOIN below
  -- yields NULL pubkey for the "no identity_keys row" case (and for the
  -- revoked-key case via the WHERE clause). The single guard fires on either
  -- failure path.
  SELECT ik.public_key
    INTO v_pubkey
    FROM public.identity_keys ik
   WHERE ik.user_id = p_target_user_id
     AND ik.revoked_at IS NULL
   LIMIT 1;

  IF v_pubkey IS NULL OR NOT public.is_active_member(p_target_user_id) THEN
    RAISE EXCEPTION 'member_not_enrolled' USING ERRCODE = 'P0001';
  END IF;

  -- Fingerprint (Amendment A-6 / A-6.1): re-derive from the bytes we are about
  -- to return. NEVER read from a stored column (drift-prone). 32 bytes → 64
  -- lowercase hex chars; matches the existing ^[0-9a-f]{64}$ regex
  -- (00000000000007_t07.sql:267, :359).
  --
  -- Algorithm: SHA-256 via pgcrypto's `digest()`. Amendment A-6.1
  -- (.context/decisions.md 2026-06-22) supersedes A-6's BLAKE2b choice
  -- because pgsodium is not available in the project's CI Postgres image,
  -- and a runtime-dispatched fallback would silently drift JS↔SQL
  -- fingerprints in production (breaking the F-172 co-chair-reads-aloud
  -- confirmation control without a test that would catch it). SHA-256 is
  -- available unconditionally in every Postgres image the project uses
  -- (pgcrypto is in the required-extensions set) AND in every browser via
  -- WebCrypto's `crypto.subtle.digest('SHA-256', …)`. The JS-side
  -- `pubkeyFingerprint()` in apps/web/src/lib/crypto/identity-keys.ts uses
  -- the same algorithm, so the two tiers produce IDENTICAL 64-hex strings
  -- for the same 32-byte pubkey input — the property F-172 depends on.
  --
  -- Security note: the fingerprint is a HUMAN-COMPARISON DISPLAY STRING
  -- over a 32-byte (256-bit) X25519 pubkey domain. It is NOT a pseudonym
  -- (the audit-log §2 same-key correlation property is preserved
  -- separately via hmac-based pseudonyms). The bare-SHA-256-in-migrations
  -- semgrep rule (.semgrep/no-bare-sha256-in-migrations.yml) exists to
  -- block bare digest() as a PSEUDONYM derivation for low-entropy inputs;
  -- it does not apply to this collision-resistant display-fingerprint of
  -- a 256-bit uniformly-random input. Suppressed inline with the A-6.1
  -- amendment as the human approval.
  -- Schema-qualification note: A-6.1's body text spells the call as
  -- `extensions.digest(...)` (the hosted-Supabase layout, where pgcrypto
  -- lives in the `extensions` schema). On the plain-Postgres CI image
  -- (committee-db-tests stage) pgcrypto is installed into `public`, so an
  -- explicit `extensions.` qualifier would fail at runtime ("schema
  -- 'extensions' does not exist" — exactly the failure mode A-6.1 set out
  -- to avoid). Both schemas are on this function's search_path (`SET
  -- search_path = public, extensions` above) AND on the database-level
  -- default search_path the bootstrap migration installs
  -- (00000000000000_bootstrap.sql:41 + :49), so an UNQUALIFIED `digest(...)`
  -- resolves correctly in BOTH layouts: via `public` on plain PG and via
  -- `extensions` on hosted Supabase. This matches the established pattern
  -- used by every other pgcrypto call site in this repo (e.g.
  -- `hmac(...)` unqualified in 00000000000001_auth.sql:413,426,452,…).
  -- The `extensions.digest` wording in A-6.1 is an algorithm directive;
  -- the unqualified call is the portable spelling that satisfies it.
  -- nosemgrep: no-bare-sha256-in-migrations -- HUMAN-APPROVED: Amendment A-6.1 (.context/decisions.md 2026-06-22) ratifies SHA-256 of the 32-byte X25519 pubkey as the F-172 cross-tier human-comparison fingerprint; this is a display string, NOT a pseudonym (the rule's target). 256-bit random input is not brute-forceable.
  v_fp := encode(digest(v_pubkey, 'sha256'), 'hex');

  -- Audit-BEFORE-return (Amendment A-1; SUCCESS-ONLY). The audit row commits
  -- inside this same SECURITY DEFINER txn BEFORE the bytes leave the function.
  -- Meta carries IDs only — no pubkey bytes, no fingerprint, no key material.
  -- F-176: a leak-sweep over the meta jsonb finds neither `public_key` nor
  -- `pubkey` nor `pubkey_bytes` nor `fingerprint`.
  PERFORM public.audit_emit(
    'identity_pubkey.disclosed_for_wrap',
    public._committee_pseudonym(v_actor),
    'C1', 'info', NULL,
    p_target_user_id,
    NULL,
    jsonb_build_object(
      'actor_id', v_actor,
      'target_user_id', p_target_user_id
    )
  );

  public_key  := v_pubkey;
  fingerprint := v_fp;
  RETURN NEXT;
END;
$$;

-- F-174 / F-118 GRANT matrix. Mirror get_committee_key_wrap_for_self's grant
-- posture (00000000000038:100-103) MINUS the supabase_auth_admin allowance:
-- the test pins authenticated + that supabase_auth_admin is OK; service_role
-- is explicitly forbidden (the closed-set never uses service_role).
REVOKE EXECUTE ON FUNCTION public.get_member_identity_pubkey_for_wrap(uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_member_identity_pubkey_for_wrap(uuid)
  TO authenticated, supabase_auth_admin;

COMMENT ON FUNCTION public.get_member_identity_pubkey_for_wrap(uuid) IS
  'ADR-0029 P1-4: co-chair pubkey-disclosure RPC for the wrap-member composition. SECURITY DEFINER; co-chair-gated in-fn; closed-literal denial (member_not_enrolled) collapses all four target-failure branches (F-174 enumeration-defeat). Audit-before-return SUCCESS-ONLY (Amendment A-1); audit meta carries IDs only — no pubkey bytes, no fingerprint (F-174/F-176). Fingerprint re-derived server-side from public_key via SHA-256 (Amendment A-6.1 supersedes A-6 BLAKE2b; pgcrypto-only, no pgsodium). REVOKE PUBLIC/anon/service_role; GRANT authenticated + supabase_auth_admin only (F-118).';
