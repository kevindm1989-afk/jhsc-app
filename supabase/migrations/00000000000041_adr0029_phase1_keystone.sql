-- ===========================================================================
-- ADR-0029 P1-1 (KEYSTONE, SQL) — member onboarding producers/terminals.
--
-- Two SECURITY DEFINER functions that close the "no producer of a non-bootstrap
-- user row / TOTP bootstrap" gap (ADR-0029 Decision 2) WITHOUT making the
-- redeem path one-shot (the opposite of bootstrap_first_co_chair):
--
--   * issue_member_invite — the CO-CHAIR-SIDE producer. Creates the invitee's
--     public.users row at ISSUE time (so committee_invite.target_user_id FK is
--     satisfiable), an auth_totp_bootstraps row (15-min TTL, secret_hash =
--     HMAC(code)), then DELEGATES to committee_invite_member with the NAMED
--     p_bootstrap_id / p_ttl_minutes so committee_invite.bootstrap_id is
--     populated (the linkage gap ADR-0029 closes). Co-chair-gated in-fn,
--     GRANT authenticated (mirrors committee_invite_member, F-168/F-173/F-177).
--
--   * redeem_invite_complete — the INVITEE-SIDE terminal, called by the
--     redeem-invite Edge Function via its self-minted mint_writer token (the
--     repeatable sibling of bootstrap_first_co_chair). Validates the invite +
--     TOTP, binds the first passkey, activates the membership — ALL in one
--     atomic txn (F-177). GRANT mint_writer ONLY (REVOKE PUBLIC/anon/
--     authenticated/service_role — byte-for-byte the bootstrap posture,
--     mirroring 00000000000035:124-127). Two uuid IN-params, NO caller target
--     uid (F-171). The invite/TOTP error oracle is normalized: consumed ≡
--     expired ≡ non-existent all raise the SAME literal `invite_invalid`
--     (F-169/F-170).
--
-- Conventions mirror 00000000000001_auth.sql (enroll_first_passkey TOTP
-- semantics), 00000000000002_committee.sql (committee_invite_member +
-- committee_activate_membership delegation; the role enum), and
-- 00000000000035_bootstrap_first_co_chair.sql (the mint_writer-only terminal
-- grant posture). No NEW audit enum: member.added is emitted by
-- committee_activate_membership; auth.passkey.enrolled reuses the existing arm.
--
-- Findings covered (threat-model §3.18): F-168, F-169, F-170, F-171, F-173,
-- F-175, F-176, F-177.
-- ===========================================================================

-- ===========================================================================
-- issue_member_invite — co-chair-side producer (F-168/F-173/F-176/F-177).
--
-- Signature per ADR-0029 "NEW hosted artifacts" (privacy-deferred shape):
--   issue_member_invite(p_roles text[], p_totp_code text, p_ttl_minutes int)
--     → TABLE(invite_id uuid, invitee_user_id uuid, bootstrap_id uuid)
--
-- NOTE: p_display_name / p_off_employer_contact are DELIBERATELY NOT collected
-- by the keystone. The privacy review BLOCKED their persistence here (no
-- validation, no retention enforcement); the user decided to DEFER both fields
-- out of the keystone entirely. They will be re-introduced (with employer-domain
-- rejection on the contact field + an explicit retention class) in the co-chair
-- roster increment that adds the member-management UI. The two-arg defaults on
-- committee_invite_member (NULL/NULL, 00000000000002:215-216) keep that delegate
-- call safe without forwarding any PI from this layer.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.issue_member_invite(
  p_roles                text[],
  p_totp_code            text,
  p_ttl_minutes          integer
) RETURNS TABLE(invite_id uuid, invitee_user_id uuid, bootstrap_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor     uuid := auth.uid();
  v_roles     text[];
  v_new_uid   uuid := gen_random_uuid();
  v_bootstrap uuid;
  v_invite    uuid;
BEGIN
  -- F-168: the co-chair gate. session_is_live() + active co-chair, mirroring
  -- committee_invite_member (00000000000002:230-235). A revoked/expired session
  -- or a non-co-chair caller is denied with rls_denied BEFORE any row is
  -- created (so a denied issue leaves NO orphan user — F-177).
  IF NOT public.session_is_live() THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';  -- F-116: revoked/expired session
  END IF;
  IF NOT public._committee_is_active_co_chair(v_actor) THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;

  -- F-173: validate the role array BEFORE creating the user (so an invalid_role
  -- issue rolls back whole and leaves no stray user — F-177). The role is
  -- server-bound at issue; the redeemer never supplies a role.
  v_roles := public._committee_norm_roles(p_roles);
  IF array_length(v_roles, 1) IS NULL
     OR NOT (v_roles <@ ARRAY['worker_member','worker_co_chair','certified_member']::text[]) THEN
    RAISE EXCEPTION 'invalid_role';
  END IF;

  -- 1. The invitee profile row, created at ISSUE time so committee_invite's
  --    target_user_id FK is satisfiable (ADR-0029 Decision 2a). active=true,
  --    role=NULL — the role is bound only on ACTIVATION (F-173), mirroring how
  --    committee_activate_membership sets users.role (00000000000002:290).
  --    NO public.users row is created at redeem time; this is the only producer.
  --    display_name / off_employer_contact are NOT written (privacy-deferred —
  --    see header note; both columns are nullable, the row stays NULL on both).
  INSERT INTO public.users (id, active, role)
    VALUES (v_new_uid, true, NULL);

  -- 2. The TOTP bootstrap. F-176: secret_hash = HMAC(code) at rest — the raw
  --    6-digit code is NEVER persisted (identical to enroll_first_passkey:413
  --    / auth_totp_bootstraps:258-261). F-170: 15-min FIXED TTL, independent of
  --    the (longer) invite TTL — the security-critical non-extendable clock.
  --    F-175: UNIQUE(user_id) cap-of-1 holds (a fresh user → one bootstrap).
  INSERT INTO public.auth_totp_bootstraps (user_id, secret_hash, expires_at)
    VALUES (
      v_new_uid,
      hmac(p_totp_code::bytea, private._hmac_pseudonym_key()::bytea, 'sha256'),
      now() + interval '15 min'
    )
    RETURNING id INTO v_bootstrap;

  -- 3. Delegate to the existing primitive with the NAMED p_bootstrap_id +
  --    p_ttl_minutes so committee_invite.bootstrap_id is POPULATED (the linkage
  --    gap ADR-0029 closes). committee_invite_member re-runs its own co-chair
  --    gate + role validation (idempotent here) and inserts the pending
  --    committee_membership(active=false) + the committee_invite row. This is
  --    ONE SECURITY DEFINER frame (F-177): all-or-nothing.
  --    p_display_name / p_off_employer_contact are DELIBERATELY NOT forwarded;
  --    committee_invite_member's NULL defaults (00000000000002:215-216) apply.
  v_invite := public.committee_invite_member(
    p_target_user_id       => v_new_uid,
    p_roles                => v_roles,
    p_bootstrap_id         => v_bootstrap,
    p_ttl_minutes          => p_ttl_minutes
  );

  -- Return the three identifiers the co-chair needs. The raw code is NOT
  -- returned from SQL — the EF that generated it owns its single response-body
  -- emission (F-176); the SQL only ever held it for the one hmac() statement.
  invite_id       := v_invite;
  invitee_user_id := v_new_uid;
  bootstrap_id    := v_bootstrap;
  RETURN NEXT;
END;
$$;

-- F-168: co-chair-gated in-fn, REST-reachable by the co-chair's authenticated
-- JWT (NOT anon). Mirrors committee_invite_member's grant posture exactly.
REVOKE EXECUTE ON FUNCTION public.issue_member_invite(text[], text, integer)
  FROM public;
GRANT EXECUTE ON FUNCTION public.issue_member_invite(text[], text, integer)
  TO authenticated, supabase_auth_admin;

COMMENT ON FUNCTION public.issue_member_invite(text[], text, integer) IS
  'ADR-0029 P1-1: co-chair-side invite producer. Creates the invitee users row + auth_totp_bootstraps (15-min, HMAC at rest) + delegates to committee_invite_member with the named bootstrap_id/ttl. Co-chair-gated in-fn; GRANT authenticated. display_name/off_employer_contact deliberately NOT collected here (privacy-deferred to the co-chair roster increment with employer-domain rejection + retention). F-168/F-173/F-176/F-177.';

-- ===========================================================================
-- redeem_invite_complete — invitee-side terminal (mint_writer-ONLY).
--
-- Signature per ADR-0029 "NEW hosted artifacts":
--   redeem_invite_complete(p_invite_id uuid, p_totp_code text,
--     p_credential_id text, p_public_key bytea, p_aaguid uuid,
--     p_transports text[], p_rp_id text, p_device_label text)
--     → TABLE(user_id uuid)
--
-- Exactly TWO uuid IN-params (p_invite_id, p_aaguid) — NO caller target uid
-- (F-171). The credential + activation bind to committee_invite.target_user_id,
-- set at issuance; the redeemer can never retarget.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.redeem_invite_complete(
  p_invite_id      uuid,
  p_totp_code      text,
  p_credential_id  text,
  p_public_key     bytea,
  p_aaguid         uuid,
  p_transports     text[],
  p_rp_id          text,
  p_device_label   text
) RETURNS TABLE(user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_inv       public.committee_invite%ROWTYPE;
  v_bootstrap public.auth_totp_bootstraps%ROWTYPE;
  v_target    uuid;
BEGIN
  -- (i) Load the invite FOR UPDATE so concurrent redeems SERIALIZE on the row
  --     (F-169 exactly-one-wins: the first to commit sets consumed_at, the
  --     second observes it and loses). NORMALIZED ERROR ORACLE (F-169/F-170):
  --     non-existent, consumed, and expired ALL raise the byte-identical literal
  --     `invite_invalid` — an attacker cannot distinguish a real-but-spent from
  --     a real-but-expired from a fictional invite_id (enumeration defeat).
  SELECT * INTO v_inv FROM public.committee_invite WHERE invite_id = p_invite_id FOR UPDATE;
  IF NOT FOUND OR v_inv.consumed_at IS NOT NULL OR v_inv.expires_at < now() THEN
    RAISE EXCEPTION 'invite_invalid' USING ERRCODE = 'P0001';
  END IF;

  -- F-171: the target is the invite's OWN bound target_user_id. The redeemer
  -- supplies NO uid; binding is by construction. v_target flows into the
  -- credential bind AND committee_activate_membership's p_enrolling_uid, so the
  -- hard `target = enrolling` check (00000000000002:275-277) is satisfied by
  -- construction rather than by trusting the caller.
  v_target := v_inv.target_user_id;

  -- (ii) Validate + consume the TOTP bootstrap with the EXACT enroll_first_passkey
  --      semantics (00000000000001:388-428). These distinct TOTP literals are
  --      correct here: they surface only AFTER a valid invite is proven above,
  --      so they leak nothing about invite existence (F-169). The wrong-code
  --      branch's wrong_attempts++/locked_at is the ONE deliberate persisting
  --      side effect (F-177) — production realises it via the statement frame;
  --      every OTHER failure rolls back whole.
  SELECT * INTO v_bootstrap
    FROM public.auth_totp_bootstraps AS b
   WHERE b.user_id = v_target
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TOTP_BOOTSTRAP_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_bootstrap.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'TOTP_BOOTSTRAP_CONSUMED' USING ERRCODE = 'P0001';
  END IF;
  IF v_bootstrap.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'TOTP_BOOTSTRAP_LOCKED' USING ERRCODE = 'P0001';
  END IF;
  -- F-175: server now() is authoritative for expiry (clock-skew safe).
  IF now() >= v_bootstrap.expires_at THEN
    RAISE EXCEPTION 'TOTP_BOOTSTRAP_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  -- F-170/F-177: wrong code → increment + lock at the 5th (the one persisting
  -- exception); the activation that follows never runs, so nothing else commits.
  IF v_bootstrap.secret_hash <> hmac(p_totp_code::bytea, private._hmac_pseudonym_key()::bytea, 'sha256') THEN
    UPDATE public.auth_totp_bootstraps
       SET wrong_attempts = wrong_attempts + 1,
           locked_at = CASE WHEN wrong_attempts + 1 >= 5 THEN now() ELSE locked_at END
     WHERE id = v_bootstrap.id;
    RAISE EXCEPTION 'TOTP_BOOTSTRAP_WRONG_CODE' USING ERRCODE = 'P0001';
  END IF;

  -- (iii) Consume the TOTP: write the single-use consumed-log row (F-38 reuse
  --       detection without keeping the row) + DELETE the bootstrap (mirrors
  --       00000000000001:425-428). A re-presented valid code finds no bootstrap.
  --       Then stamp users.totp_destroyed_at for forensic parity with
  --       enroll_first_passkey (00000000000001:430-433) — the moment the
  --       bootstrap stops being a path is the same row-of-truth in both flows.
  INSERT INTO public.auth_totp_consumed_log (user_id, totp_code_hash)
    VALUES (v_target, hmac(p_totp_code::bytea, private._hmac_pseudonym_key()::bytea, 'sha256'));
  DELETE FROM public.auth_totp_bootstraps WHERE id = v_bootstrap.id;
  UPDATE public.users
     SET totp_destroyed_at = now(),
         updated_at        = now()
   WHERE id = v_target;

  -- (iv) Bind the first passkey to the invite's OWN target (F-171). Only the
  --      verified credential fields the EF forwards reach this point.
  INSERT INTO public.webauthn_credentials (
    credential_id, user_id, public_key, aaguid, transports, rp_id, device_label
  )
  VALUES (
    p_credential_id, v_target, p_public_key, p_aaguid,
    COALESCE(p_transports, '{}'::text[]), p_rp_id, p_device_label
  );

  -- (v) Activate the membership, passing the invite's OWN target as the
  --     enrolling uid so committee_activate_membership's `target = enrolling`
  --     bind (00000000000002:275-277) holds BY CONSTRUCTION. This consumes the
  --     invite (consumed_at), flips active=true, sets users.role from the
  --     PRE-SET membership role (F-173 — no redeem-time role param to elevate),
  --     and emits member.added (F-170 attribution / audit-before-return). All
  --     in this same txn (F-177).
  PERFORM public.committee_activate_membership(p_invite_id, v_target);

  -- (vi) Audit the passkey binding (auth.passkey.enrolled — closed enum, mirrors
  --      enroll_first_passkey:445-454). F-176: only the cred-id pseudonym (keyed
  --      HMAC, truncated) — NEVER the raw code, the public key, or the cred id.
  PERFORM public.audit_emit(
    p_event_type      => 'auth.passkey.enrolled',
    p_actor_pseudonym => public._committee_pseudonym(v_target),
    p_target_class    => 'C1',
    p_severity        => 'info',
    p_request_id      => NULL,
    p_meta            => jsonb_build_object(
      'redeem', true,
      'cred_id_pseudonym',
        LEFT(encode(hmac(p_credential_id::bytea, private._hmac_pseudonym_key()::bytea, 'sha256'), 'hex'), 16)
    )
  );

  user_id := v_target;
  RETURN NEXT;
END;
$$;

-- F-168: byte-for-byte the bootstrap_first_co_chair terminal posture
-- (00000000000035:124-127). Reachable ONLY by the redeem EF's self-minted
-- mint_writer identity; closed to every REST-reachable role so the
-- verify_jwt=false EF cannot be bypassed by a direct anon/authenticated RPC,
-- and service_role is closed too (F-118 — the closed-set never uses service_role).
REVOKE ALL ON FUNCTION public.redeem_invite_complete(uuid, text, text, bytea, uuid, text[], text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.redeem_invite_complete(uuid, text, text, bytea, uuid, text[], text, text)
  TO mint_writer;

COMMENT ON FUNCTION public.redeem_invite_complete(uuid, text, text, bytea, uuid, text[], text, text) IS
  'ADR-0029 P1-1: invitee-side redeem terminal (mint_writer-ONLY). Atomic: validate invite (normalized invite_invalid oracle) + validate/consume TOTP (enroll_first_passkey semantics) + bind passkey + activate membership (member.added). No caller target uid (binds committee_invite.target_user_id). F-168/F-169/F-170/F-171/F-173/F-177.';
