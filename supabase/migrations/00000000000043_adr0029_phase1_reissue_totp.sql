-- ===========================================================================
-- ADR-0029 P1-6 (EF/SQL) — "Re-send code": reissue_member_totp.
--
-- The 15-min TOTP (auth_totp_bootstraps.expires_at, 00000000000001_auth.sql:263)
-- expires long before the 7-day invite TTL (committee_invite.expires_at), so a
-- member who does not redeem inside the 15-min window needs a FRESH TOTP against
-- the SAME, still-unconsumed invite. This fn re-issues the bootstrap WITHOUT
-- re-creating the user / invite / membership (ADR-0029 Decision 3 sub-decision;
-- the common real case — co-chair sets up Monday, member redeems Thursday and
-- needs a fresh code Thursday).
--
-- Mechanism (Decision 3 + threat-model §3.18 F-175 mitigation): the
-- UNIQUE(user_id) cap-of-1 on auth_totp_bootstraps (00000000000001:268) means
-- re-issue is a delete-then-insert / upsert: the existing bootstrap row for the
-- invite's target user is REPLACED with a fresh secret_hash = HMAC(new code), a
-- fresh 15-min expires_at, and reset wrong_attempts / locked_at, and
-- committee_invite.bootstrap_id is re-pointed at the NEW row. The OLD code no
-- longer validates. The invite itself is OTHERWISE UNCHANGED (same invite_id,
-- target_user_id, role, expires_at — re-send re-arms the TOTP, NOT the invite).
--
-- Signature per ADR-0029 "NEW hosted artifacts" (line 9805):
--   reissue_member_totp(p_invite_id uuid, p_totp_code text)
--     → TABLE(invite_id uuid, bootstrap_id uuid)   (Amendment A-7.3)
--   — co-chair-gated, GRANT authenticated. The EF generates the raw code +
--     passes it; the SQL computes secret_hash = HMAC(code) internally and never
--     returns the raw code (mirrors issue_member_invite, 00000000000041:100-111).
--
-- Closed error oracle (Amendment A-7.2): a consumed / expired / non-existent
-- invite all RAISE the SAME literal `invite_invalid`, byte-identical to
-- redeem_invite_complete (00000000000041:186-189; same F-169/F-170 no-leak
-- posture — a co-chair re-sending against a dead invite gets the same closed
-- literal an attacker would).
--
-- Audit (Amendment A-7.1): re-send emits a dedicated, SUCCESS-ONLY,
-- actor-attributable `member.totp_reissued` audit event so insider re-send abuse
-- (F-175) goes from trace-less (the cap-of-1 delete-then-insert leaves only the
-- LATEST bootstrap; the committee-op EF structured log carries route+outcome but
-- NO actor uid) to attributable + countable. Meta carries {actor_id,
-- target_user_id, invite_id} ONLY — never the code / secret_hash / TOTP (F-176).
-- Success-only per Amendment A-1: the co-chair gate + the invite_invalid close
-- RAISE BEFORE any audit_emit, with NO exception handler, so a DENIED re-send
-- emits no audit row (denial forensics ride the EF log).
--
-- New enum value `member.totp_reissued` rides the full ADR-0003 Amendment A
-- six-mirror dance, placed exactly as identity_pubkey.disclosed_for_wrap was in
-- P1-4 (00000000000042:35-45 is the template):
--   (a) retention_class_for arm 'membership+7y' (this file; CREATE OR REPLACE)
--   (b) audit_log_retention_schedule row — REUSE the existing 'membership+7y'
--       class (00000000000019; sibling of member.added); NO new class / row
--   (c) audit_emit functional acceptance (it reads retention_class_for; arm (a)
--       is the acceptance — audit_emit accepts any text event_type)
--   (d) observability/audit-log.md §1 Membership row (this PR)
--   (e) scripts/check-audit-enum-coverage.sh EXPECTED_ENUM (this PR)
--   (f) TS-side mirror is N/A — server-only (no client emits this event; same
--       posture identity_pubkey.disclosed_for_wrap took, 00000000000042:44-45)
--
-- Conventions mirror 00000000000041_adr0029_phase1_keystone.sql (issue_member_invite
-- gate + HMAC-at-rest), 00000000000042_adr0029_phase1_grant_pubkey.sql (the
-- retention_class_for redefinition + the audit_emit call posture), and
-- 00000000000001_auth.sql (the auth_totp_bootstraps schema).
--
-- Findings covered (threat-model §3.18): F-175, F-176.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) retention_class_for — extend with member.totp_reissued = 'membership+7y'
--     (the REUSED member.* class; sibling of member.added 00000000000007:91 /
--     00000000000042:93). CREATE OR REPLACE re-declares the whole function with
--     the new arm, carrying forward the full arm set verbatim from migration 42
--     (00000000000042:68-109) PLUS the new member.totp_reissued arm. Signature
--     mirrors migration 42 (LANGUAGE sql IMMUTABLE; no SECURITY DEFINER, no SET
--     search_path — a pure CASE lookup). An un-mirrored new event would fall
--     through to the '24mo' default — the missing-arm tell the pgTAP pins.
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
    WHEN 'member.totp_reissued'                           THEN 'membership+7y'  -- ADR-0029 P1-6 / A-7.1 (F-175)
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
-- (b) reissue_member_totp — the "re-send code" producer.
--
-- Exactly TWO IN-params (p_invite_id uuid, p_totp_code text) — ADR-0029:9805.
-- Co-chair-gated in-fn (session_is_live + active co-chair), mirroring
-- issue_member_invite (00000000000041:74-79). One atomic SECURITY DEFINER frame:
-- the bootstrap swap + the linkage update + the audit row are all-or-nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reissue_member_totp(
  p_invite_id   uuid,
  p_totp_code   text
) RETURNS TABLE(invite_id uuid, bootstrap_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor     uuid := auth.uid();
  v_inv       public.committee_invite%ROWTYPE;
  v_bootstrap uuid;
BEGIN
  -- F-175: the co-chair gate. session_is_live() + active co-chair, mirroring
  -- issue_member_invite (00000000000041:74-79). A revoked/expired session or a
  -- non-co-chair caller is denied with rls_denied BEFORE any row is touched (so
  -- a denied re-send leaves the bootstrap untouched and emits no audit row).
  IF NOT public.session_is_live() THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';  -- F-116: revoked/expired session
  END IF;
  IF NOT public._committee_is_active_co_chair(v_actor) THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;

  -- Closed error oracle (Amendment A-7.2): load the invite FOR UPDATE so a
  -- concurrent redeem/re-send SERIALIZES on the row. NORMALIZED ERROR ORACLE
  -- (F-169/F-170): non-existent, consumed, and expired ALL raise the
  -- byte-identical literal `invite_invalid`, mirroring redeem_invite_complete
  -- (00000000000041:186-189). Re-send does NOT resurrect an expired invite (that
  -- needs a fresh invite, not a fresh TOTP).
  SELECT * INTO v_inv FROM public.committee_invite
   WHERE committee_invite.invite_id = p_invite_id
   FOR UPDATE;
  IF NOT FOUND OR v_inv.consumed_at IS NOT NULL OR v_inv.expires_at < now() THEN
    RAISE EXCEPTION 'invite_invalid' USING ERRCODE = 'P0001';
  END IF;

  -- Re-issue the bootstrap as a delete-then-insert under the UNIQUE(user_id)
  -- cap-of-1 (F-175: re-send REPLACES, never accumulates — the OLD row is gone,
  -- the OLD code no longer validates). F-176: secret_hash = HMAC(code) at rest;
  -- the raw 6-digit code is NEVER persisted (identical to issue_member_invite
  -- 00000000000041:108 / enroll_first_passkey:413). Fresh 15-min FIXED TTL re-arms
  -- the security-critical non-extendable clock; wrong_attempts reset to 0 and
  -- locked_at cleared (re-send is the documented lock-recovery path —
  -- ADR-0029 "Failure-mode analysis": "Member asks the co-chair to re-send code").
  DELETE FROM public.auth_totp_bootstraps
   WHERE auth_totp_bootstraps.user_id = v_inv.target_user_id;

  INSERT INTO public.auth_totp_bootstraps (user_id, secret_hash, expires_at, wrong_attempts, locked_at)
    VALUES (
      v_inv.target_user_id,
      hmac(p_totp_code::bytea, private._hmac_pseudonym_key()::bytea, 'sha256'),
      now() + interval '15 min',
      0,
      NULL
    )
    RETURNING id INTO v_bootstrap;

  -- Re-point committee_invite.bootstrap_id at the NEW bootstrap row (the OLD one
  -- is gone). The invite is OTHERWISE UNCHANGED — target/role/expires_at/
  -- consumed_at are NOT touched (re-send does not retarget, re-role, extend the
  -- 7-day invite TTL, or consume the invite).
  UPDATE public.committee_invite
     SET bootstrap_id = v_bootstrap
   WHERE committee_invite.invite_id = p_invite_id;

  -- Audit (Amendment A-7.1; SUCCESS-ONLY per A-1) — emitted INSIDE this same
  -- SECURITY DEFINER frame BEFORE RETURN, with NO exception handler (the gate +
  -- the invite_invalid close RAISE before reaching here, so a denied re-send
  -- never lands a row). actor = co-chair pseudonym; target = the invite's bound
  -- target_user_id; class C2 (mirrors member.added 00000000000002:296-298).
  -- Meta carries {actor_id, target_user_id, invite_id} ONLY — NEVER the code,
  -- the secret_hash, or any TOTP material (F-176). audit_emit signature per
  -- 00000000000001_auth.sql:185-194 (named args; matches member.added's call at
  -- 00000000000002:293-299 and identity_pubkey.disclosed_for_wrap at
  -- 00000000000042:243-253).
  PERFORM public.audit_emit(
    p_event_type      => 'member.totp_reissued',
    p_actor_pseudonym => public._committee_pseudonym(v_actor),
    p_target_class    => 'C2',
    p_severity        => 'info',
    p_target_id       => v_inv.target_user_id,
    p_meta            => jsonb_build_object(
      'actor_id', v_actor,
      'target_user_id', v_inv.target_user_id,
      'invite_id', p_invite_id
    )
  );

  -- Return the identifiers the co-chair needs (Amendment A-7.3); the raw code is
  -- NOT returned from SQL — the committee-op EF that generated it owns the single
  -- response-body emission (F-176).
  invite_id    := p_invite_id;
  bootstrap_id := v_bootstrap;
  RETURN NEXT;
END;
$$;

-- F-175: co-chair-gated in-fn, REST-reachable by the co-chair's authenticated
-- JWT (NOT anon). Mirrors issue_member_invite's grant posture exactly
-- (00000000000041:140-143).
REVOKE EXECUTE ON FUNCTION public.reissue_member_totp(uuid, text)
  FROM public;
GRANT EXECUTE ON FUNCTION public.reissue_member_totp(uuid, text)
  TO authenticated, supabase_auth_admin;

COMMENT ON FUNCTION public.reissue_member_totp(uuid, text) IS
  'ADR-0029 P1-6: re-send code. Co-chair-gated; re-issues the auth_totp_bootstraps row (delete-then-insert under UNIQUE(user_id) cap-of-1) with a fresh HMAC-at-rest secret + fresh 15-min TTL + reset wrong_attempts/locked_at, and re-points committee_invite.bootstrap_id; the OLD code dies. Does NOT touch the user/invite/membership. Closed error oracle: consumed/expired/non-existent invite -> invite_invalid (A-7.2). Emits SUCCESS-ONLY member.totp_reissued audit (A-7.1; meta = actor_id/target_user_id/invite_id only — never the code/secret, F-176). Returns {invite_id, bootstrap_id} (A-7.3). GRANT authenticated. F-175/F-176.';
