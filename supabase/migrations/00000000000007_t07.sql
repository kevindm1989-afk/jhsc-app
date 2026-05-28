-- ===========================================================================
-- T07.1 — Identity-keys + recovery-blob + committee-data-key server (keystone).
--
-- Server sibling of T07 (ADR-0003 library). Mirrors the SQL the
-- Memory{KeyStore} / committee-key.ts / recovery-blob.ts contracts encode:
--   storeIdentityKeys           → enroll_identity_keypair
--   storeRecoveryBlob           → store_recovery_blob               (F-12 single-POST)
--   restoreFromRecoveryBlob     → record_recovery_blob_restored     (server-emits)
--   showRecoveryPassphraseAgain → record_recovery_blob_viewed       (G-T07-7 cap-of-3)
--   <co-chair-action>           → issue_recovery_blob_reset         (G-T07-8 + recovery_reset.issued)
--   initCommitteeDataKey        → init_committee_data_key
--   wrapForMember               → wrap_committee_data_key_for_member (F-01 RLS-equiv)
--   unwrapForSession            → record_committee_data_key_unwrap
--   rotateCommitteeDataKey      → rotate_committee_data_key          (F-04 + G-T07-14)
--   <follow-up by app>          → finalize_committee_data_key_rotation
--   revokeMember                → revoke_committee_member            (purges wraps + audit)
--
-- Conventions mirror 0002_committee.sql / 0005_reprisal.sql:
-- SECURITY DEFINER functions; writes/reads mediated + REVOKED from
-- authenticated/anon; gate on session_is_live() (F-116); pseudonymised audit
-- via audit_emit + _committee_pseudonym.
--
-- E2EE (ADR-0003 Invariants 1, 3, 5, 6): identity private keys, the symmetric
-- committee data key, and the recovery-blob plaintext NEVER traverse this
-- layer. We only persist:
--   - identity_keys.public_key                (the X25519 public half)
--   - recovery_blobs.blob_ciphertext + kdf    (sealed under the user's passphrase)
--   - committee_key_wraps.wrapped_ciphertext  (sealed under each member's pubkey)
--
-- T07 carry-forwards resolved here (see .context/known-gaps.md):
--   G-T07-1 (the migration itself), G-T07-3 (pgTAP coverage; sibling file),
--   G-T07-4 (schedule rows — governance fold-in PR), G-T07-5 (PI inventory —
--   governance fold-in PR), G-T07-6 (`view_count` REMOVED — derive from audit
--   log), G-T07-7 (server-side cap-of-3 inside record_recovery_blob_viewed),
--   G-T07-8 (co-chair check + audit on issue_recovery_blob_reset; new enum
--   `recovery_reset.issued`), G-T07-11 (identity_pubkey relocation — handled
--   here: `identity_keys.public_key` IS the relocation; governance fold-in
--   PR documents the §PI shift), G-T07-14 (at-least-one-active-member
--   precondition inside rotate_committee_data_key).
--
-- Not resolved here (deferred to subsequent T07.1 increments):
--   G-T07-2  (SupabaseKeyStore + Edge Function wire-up)
--   G-T07-9  (F-02 server-issued nonce — Edge Function increment)
--   G-T07-10 (KeyStore interface split — TS lib increment)
--   G-T07-12 (`libsodium-wrappers-sumo` dep swap — TS lib increment)
--   G-T07-13 (`@ts-expect-error` cleanup — orthogonal)
--   G-T07-15 (`client.identity_selftest_fail` interface unification — TS lib)
--
-- Six-mirror folds (ADR-0003 Amendment A) handled in this PR:
--   - `recovery_reset.issued`  (NEW; G-T07-8 — emitted by issue_recovery_blob_reset)
--   - `panic_wipe.invoked`     (T19 reservation; ADR-0020 Decision 5 fold-in)
-- The TS const KEY_MATERIAL_AUDIT_EVENTS gains `recovery_reset.issued` in the
-- SupabaseKeyStore wire-up PR (the keystone PR only widens the SQL retention
-- mirror + the audit-log.md mirror + the check-audit-enum-coverage.sh mirror).
-- The DB-side CHECK constraint + audit_log_retention_schedule row are owned
-- by T18 (same carry-forward as `member.role_changed`).
--
-- PG14-safe (CI's committee-db-tests job is vanilla PG14): no PG15-only view
-- options; uses `pg_try_advisory_xact_lock` (available since PG8.2).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- retention_class_for — extend with the new T07.1 / T19 enum values.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retention_class_for(p_event_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT CASE p_event_type
    WHEN 'auth.passkey.enrolled'                          THEN '90d'
    WHEN 'auth.passkey.revoked'                           THEN '90d'
    WHEN 'session.revoked'                                THEN '90d'
    WHEN 'committee_data_key.unwrap'                      THEN '24mo'
    WHEN 'committee_data_key.rotation.started'            THEN '7y'
    WHEN 'committee_data_key.rotation.completed'          THEN '7y'
    WHEN 'committee_data_key.member_revoked'              THEN '7y'
    WHEN 'committee.key_rotated'                          THEN '7y'
    WHEN 'identity_keypair.created'                       THEN '7y'
    WHEN 'identity_privkey.recovery_blob.written'         THEN 'membership+24mo'
    WHEN 'identity_privkey.recovery_blob.restored'        THEN 'membership+24mo'
    WHEN 'identity_privkey.recovery_blob.viewed'          THEN 'membership+24mo'
    WHEN 'recovery_reset.issued'                          THEN 'membership+24mo'  -- T07.1 (G-T07-8)
    WHEN 'panic_wipe.invoked'                             THEN '7y'               -- T19 (ADR-0020 Decision 5)
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
    ELSE '24mo'
  END;
$$;
REVOKE EXECUTE ON FUNCTION public.retention_class_for(text) FROM public;
GRANT EXECUTE ON FUNCTION public.retention_class_for(text) TO supabase_auth_admin;

-- ===========================================================================
-- Tables
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- identity_keys — 1:1 with users (G-T07-11 relocation of users.identity_pubkey).
-- The PRIVATE half NEVER lands here (Invariant 1).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.identity_keys (
  user_id     uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  public_key  bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
ALTER TABLE public.identity_keys ENABLE ROW LEVEL SECURITY;
-- All access mediated through the SECURITY DEFINER functions below. Wrap
-- routing reads the pubkey via the wrap_for_member function, not a direct
-- SELECT; that keeps the F-02/F-03 self-test surface from leaking the public
-- half to the client in a path that bypasses the audit.
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.identity_keys FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- recovery_blobs — 1:1 with users. Single-row-per-user (F-12).
-- view_count column intentionally OMITTED (G-T07-6) — derive from audit log.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recovery_blobs (
  user_id          uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  blob_ciphertext  bytea NOT NULL,            -- [salt|nonce|secretbox-ct] envelope
  kdf_params       jsonb NOT NULL,            -- {ops, mem_bytes, alg, version}
  created_at       timestamptz NOT NULL DEFAULT now(),
  restored_at      timestamptz                -- most-recent restore; NULL until first
);
ALTER TABLE public.recovery_blobs ENABLE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.recovery_blobs FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- recovery_blob_resets — co-chair-issued reset tokens (F-12 / G-T07-8).
-- A row with consumed_at IS NULL allows the user's next store_recovery_blob
-- call to succeed even if a recovery_blobs row already exists. Consumed by
-- that successful store.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recovery_blob_resets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  issued_by       uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  consumed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS recovery_blob_resets_target_unconsumed_idx
  ON public.recovery_blob_resets (target_user_id) WHERE consumed_at IS NULL;
ALTER TABLE public.recovery_blob_resets ENABLE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.recovery_blob_resets FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- committee_data_keys — metadata only. The symmetric key itself NEVER lands
-- here (Invariant 1); it lives only inside member wraps.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.committee_data_keys (
  key_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  epoch       integer NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  rotated_at  timestamptz
);
CREATE INDEX IF NOT EXISTS committee_data_keys_active_idx
  ON public.committee_data_keys (epoch) WHERE rotated_at IS NULL;
ALTER TABLE public.committee_data_keys ENABLE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.committee_data_keys FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- committee_key_wraps — current wraps (one per member-per-key).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.committee_key_wraps (
  user_id             uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  key_id              uuid NOT NULL REFERENCES public.committee_data_keys(key_id) ON DELETE CASCADE,
  wrapped_ciphertext  bytea NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key_id)
);
CREATE INDEX IF NOT EXISTS committee_key_wraps_key_idx
  ON public.committee_key_wraps (key_id);
ALTER TABLE public.committee_key_wraps ENABLE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.committee_key_wraps FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- committee_key_wraps_history — past wraps for retention forensics (F-05).
-- Populated by revoke_committee_member (which copies removed-member wraps
-- here before deleting them from the live table) and by rotation (no copy:
-- the rotated-out epoch's wraps stay in the live table marked-via-FK to a
-- committee_data_keys row whose rotated_at IS NOT NULL).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.committee_key_wraps_history (
  id                  bigserial PRIMARY KEY,
  user_id             uuid NOT NULL,
  key_id              uuid NOT NULL,
  wrapped_ciphertext  bytea NOT NULL,
  archived_at         timestamptz NOT NULL DEFAULT now(),
  reason              text NOT NULL CHECK (reason IN ('member_revoked'))
);
CREATE INDEX IF NOT EXISTS committee_key_wraps_history_user_key_idx
  ON public.committee_key_wraps_history (user_id, key_id);
ALTER TABLE public.committee_key_wraps_history ENABLE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.committee_key_wraps_history FROM authenticated, anon;

-- ===========================================================================
-- Gate helpers
-- ===========================================================================

-- Active-member gate (used by most T07.1 entry points).
CREATE OR REPLACE FUNCTION public._t07_gate_active_member()
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
BEGIN
  IF NOT public.session_is_live() THEN RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501'; END IF;
  IF NOT public.is_active_member(auth.uid()) THEN RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501'; END IF;
END $$;

-- Co-chair gate (issue_recovery_blob_reset, revoke_committee_member).
CREATE OR REPLACE FUNCTION public._t07_gate_cochair()
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
BEGIN
  IF NOT public.session_is_live() THEN RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501'; END IF;
  IF NOT public._committee_is_active_co_chair(auth.uid()) THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;
END $$;

-- Live session only (enroll_identity_keypair, store_recovery_blob,
-- record_recovery_blob_restored, record_recovery_blob_viewed — pre-membership
-- onboarding paths: the user has a session but committee_membership.active
-- may still be false until activation completes).
CREATE OR REPLACE FUNCTION public._t07_gate_session()
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
BEGIN
  IF NOT public.session_is_live() THEN RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501'; END IF;
END $$;

-- ===========================================================================
-- (1) enroll_identity_keypair — actor enrolls own pubkey (Invariant 1).
--     The fingerprint MUST be the libsodium BLAKE2b digest the client
--     computed (the JS lib's `pubkeyFingerprint`) so the audit-row identifier
--     stays cross-system-consistent. We refuse to re-hash with SHA-256
--     server-side (that would break the cross-tier correlation property,
--     and per `.semgrep/no-bare-sha256-in-migrations.yml` server-side
--     SHA-256 is reserved for HMAC-keyed pseudonyms).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.enroll_identity_keypair(
  p_public_key          bytea,
  p_pubkey_fingerprint  text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  PERFORM public._t07_gate_session();
  IF p_public_key IS NULL OR length(p_public_key) <> 32 THEN
    RAISE EXCEPTION 'invalid_pubkey';                                       -- X25519 = 32 bytes
  END IF;
  -- BLAKE2b-32 output is 32 bytes → 64 hex chars (the JS lib's to_hex format).
  IF p_pubkey_fingerprint IS NULL OR p_pubkey_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_fingerprint';
  END IF;
  INSERT INTO public.identity_keys (user_id, public_key)
    VALUES (v_actor, p_public_key)
    ON CONFLICT (user_id) DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'duplicate' USING ERRCODE = '23505';                    -- one identity row per user
  END IF;
  PERFORM public.audit_emit(
    'identity_keypair.created', public._committee_pseudonym(v_actor),
    'C1', 'info', NULL, v_actor, NULL,
    jsonb_build_object(
      'actor_id', v_actor,
      'target_user_id', v_actor,
      'ident_pubkey_fingerprint', p_pubkey_fingerprint
    )
  );
  RETURN v_actor;
END $$;

-- ===========================================================================
-- (2) store_recovery_blob — F-12 single-POST; consumes a recovery reset.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.store_recovery_blob(
  p_blob_ciphertext bytea,
  p_kdf_params      jsonb
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_reset uuid;
  v_exists boolean;
BEGIN
  PERFORM public._t07_gate_session();
  IF p_blob_ciphertext IS NULL OR length(p_blob_ciphertext) < (16 + 24 + 1) THEN
    RAISE EXCEPTION 'invalid_blob';                                         -- salt(16) + nonce(24) + >=1 ct byte
  END IF;
  IF p_kdf_params IS NULL OR NOT (p_kdf_params ? 'alg' AND p_kdf_params ? 'version') THEN
    RAISE EXCEPTION 'invalid_kdf_params';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.recovery_blobs WHERE user_id = v_actor) INTO v_exists;
  IF v_exists THEN
    -- F-12: a second POST requires a co-chair-issued unconsumed reset.
    SELECT id INTO v_reset FROM public.recovery_blob_resets
      WHERE target_user_id = v_actor AND consumed_at IS NULL
      ORDER BY issued_at DESC LIMIT 1 FOR UPDATE;
    IF v_reset IS NULL THEN
      RAISE EXCEPTION 'duplicate' USING ERRCODE = '23505';
    END IF;
    UPDATE public.recovery_blob_resets SET consumed_at = now() WHERE id = v_reset;
    UPDATE public.recovery_blobs
       SET blob_ciphertext = p_blob_ciphertext, kdf_params = p_kdf_params,
           created_at = now(), restored_at = NULL
     WHERE user_id = v_actor;
  ELSE
    INSERT INTO public.recovery_blobs (user_id, blob_ciphertext, kdf_params)
      VALUES (v_actor, p_blob_ciphertext, p_kdf_params);
  END IF;

  PERFORM public.audit_emit(
    'identity_privkey.recovery_blob.written', public._committee_pseudonym(v_actor),
    'C1', 'info', NULL, v_actor, NULL,
    jsonb_build_object(
      'actor_id', v_actor,
      'target_user_id', v_actor,
      'kdf_params_version', p_kdf_params -> 'version',
      'reset_consumed', v_reset IS NOT NULL
    )
  );
END $$;

-- ===========================================================================
-- (3) record_recovery_blob_restored — server-side audit anchor for the
--     decrypt-on-new-device path. The actual decrypt happens client-side
--     (Invariant 1). The client passes the libsodium BLAKE2b hash of the
--     device-fingerprint material (matching the JS lib's `hashFingerprint`);
--     the server records that pre-hashed value verbatim. The raw UA never
--     traverses this layer (ADR-0003 Amendment A: "hashed; no raw UA").
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.record_recovery_blob_restored(
  p_device_fingerprint_hashed text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  PERFORM public._t07_gate_session();
  -- BLAKE2b-32 → 64 hex chars (the JS lib's `s.to_hex(s.crypto_generichash(32, ...))`).
  IF p_device_fingerprint_hashed IS NULL OR p_device_fingerprint_hashed !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_fingerprint';
  END IF;

  UPDATE public.recovery_blobs SET restored_at = now() WHERE user_id = v_actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';                                           -- no blob to restore against
  END IF;

  PERFORM public.audit_emit(
    'identity_privkey.recovery_blob.restored', public._committee_pseudonym(v_actor),
    'C1', 'notice', NULL, v_actor, NULL,
    jsonb_build_object(
      'actor_id', v_actor,
      'target_user_id', v_actor,
      'device_fingerprint', p_device_fingerprint_hashed
    )
  );
END $$;

-- ===========================================================================
-- (4) record_recovery_blob_viewed — G-T07-7 SERVER-SIDE cap-of-3 per
--     enrollment session. The client-supplied `reveal_count_in_session` is
--     IGNORED on the trust path; the server derives the count from the
--     audit log + rejects when the cap is reached.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.record_recovery_blob_viewed(
  p_enrollment_session_id text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_prior integer;
BEGIN
  PERFORM public._t07_gate_session();
  IF p_enrollment_session_id IS NULL OR length(p_enrollment_session_id) = 0 THEN
    RAISE EXCEPTION 'invalid_session_id';
  END IF;

  -- G-T07-7: derive the count from the audit log; do NOT trust a client-
  -- supplied counter. The library's per-session counter is a UX hint only.
  SELECT count(*) INTO v_prior FROM public.audit_log
    WHERE event_type = 'identity_privkey.recovery_blob.viewed'
      AND target_id = v_actor
      AND meta ->> 'enrollment_session_id' = p_enrollment_session_id;
  IF v_prior >= 3 THEN
    RAISE EXCEPTION 'cap_reached' USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.audit_emit(
    'identity_privkey.recovery_blob.viewed', public._committee_pseudonym(v_actor),
    'C1', 'notice', NULL, v_actor, NULL,
    jsonb_build_object(
      'actor_id', v_actor,
      'enrollment_session_id', p_enrollment_session_id,
      'reveal_count_in_session', v_prior + 1
    )
  );
  RETURN v_prior + 1;
END $$;

-- ===========================================================================
-- (5) issue_recovery_blob_reset — G-T07-8: co-chair-gated + audited;
--     emits the NEW `recovery_reset.issued` enum value.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.issue_recovery_blob_reset(
  p_target_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_id    uuid;
BEGIN
  PERFORM public._t07_gate_cochair();
  IF p_target_user_id IS NULL THEN RAISE EXCEPTION 'invalid_target'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_target_user_id) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  INSERT INTO public.recovery_blob_resets (target_user_id, issued_by)
    VALUES (p_target_user_id, v_actor)
    RETURNING id INTO v_id;
  PERFORM public.audit_emit(
    'recovery_reset.issued', public._committee_pseudonym(v_actor),
    'C2', 'notice', NULL, p_target_user_id, NULL,
    jsonb_build_object(
      'actor_id', v_actor,
      'target_user_id', p_target_user_id,
      'reset_id', v_id
    )
  );
  RETURN v_id;
END $$;

-- ===========================================================================
-- (6) init_committee_data_key — mint a fresh metadata row at epoch=max+1.
--     The symmetric data key itself is generated CLIENT-SIDE (Invariant 1).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.init_committee_data_key()
RETURNS TABLE(key_id uuid, epoch integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_id    uuid := gen_random_uuid();
  v_epoch integer;
BEGIN
  PERFORM public._t07_gate_active_member();
  -- A single active committee data key suffices for v1; second init is denied.
  IF EXISTS (SELECT 1 FROM public.committee_data_keys WHERE rotated_at IS NULL) THEN
    RAISE EXCEPTION 'already_initialised' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(max(cd.epoch), 0) + 1 INTO v_epoch FROM public.committee_data_keys cd;
  INSERT INTO public.committee_data_keys (key_id, epoch) VALUES (v_id, v_epoch);
  RETURN QUERY SELECT v_id, v_epoch;
END $$;

-- ===========================================================================
-- (7) wrap_committee_data_key_for_member — F-01 active-member gate on both
--     actor + target. The wrap bytes are produced CLIENT-SIDE by sealing the
--     symmetric data key to the target's pubkey (crypto_box_seal).
--     `p_rotation_id` is optional — non-NULL when called as part of a
--     rotation re-wrap pass; it threads onto the audit row so the .started /
--     .completed pair can be reconstructed.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.wrap_committee_data_key_for_member(
  p_member_user_id    uuid,
  p_key_id            uuid,
  p_wrapped_ciphertext bytea,
  p_rotation_id       uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  PERFORM public._t07_gate_active_member();
  IF p_member_user_id IS NULL OR p_key_id IS NULL
     OR p_wrapped_ciphertext IS NULL OR length(p_wrapped_ciphertext) = 0 THEN
    RAISE EXCEPTION 'invalid_args';
  END IF;
  -- F-01: target must be an active member. RLS-equivalent.
  IF NOT public.is_active_member(p_member_user_id) THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;
  -- Key must exist (current OR mid-rotation — rotated_at may be NULL or set).
  IF NOT EXISTS (SELECT 1 FROM public.committee_data_keys WHERE key_id = p_key_id) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  INSERT INTO public.committee_key_wraps (user_id, key_id, wrapped_ciphertext)
    VALUES (p_member_user_id, p_key_id, p_wrapped_ciphertext)
    ON CONFLICT (user_id, key_id) DO NOTHING;
  PERFORM public.audit_emit(
    'committee_data_key.wrapped_for_member', public._committee_pseudonym(v_actor),
    'C2', 'info', NULL, p_member_user_id, p_rotation_id,
    jsonb_build_object(
      'actor_id', v_actor,
      'target_member_id', p_member_user_id,
      'committee_key_id', p_key_id,
      'rotation_id', p_rotation_id
    )
  );
END $$;

-- ===========================================================================
-- (8) record_committee_data_key_unwrap — audit-only; the actual unwrap
--     happens CLIENT-SIDE with the actor's device-local identity privkey
--     (Invariant 1). Server confirms the actor has a wrap for this key.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.record_committee_data_key_unwrap(
  p_key_id uuid
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  PERFORM public._t07_gate_active_member();
  IF NOT EXISTS (SELECT 1 FROM public.committee_key_wraps
                  WHERE user_id = v_actor AND key_id = p_key_id) THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';                  -- no wrap → no unwrap claim
  END IF;
  PERFORM public.audit_emit(
    'committee_data_key.unwrap', public._committee_pseudonym(v_actor),
    'C2', 'info', NULL, v_actor, NULL,
    jsonb_build_object('actor_id', v_actor, 'committee_key_id', p_key_id)
  );
END $$;

-- ===========================================================================
-- (9) rotate_committee_data_key — F-04 advisory lock + G-T07-14 at-least-
--     one-active-member precondition. Marks the previous epoch rotated_at;
--     mints a new key_id at epoch+1; emits .rotation.started. Returns
--     (rotation_id, new_key_id) so the app can re-wrap.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.rotate_committee_data_key(
  p_trigger text
) RETURNS TABLE(rotation_id uuid, new_key_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_prev       public.committee_data_keys%ROWTYPE;
  v_new_id     uuid := gen_random_uuid();
  v_new_epoch  integer;
  v_rotation   uuid := gen_random_uuid();
BEGIN
  PERFORM public._t07_gate_active_member();
  IF p_trigger IS NULL OR p_trigger NOT IN ('scheduled','member_removal','incident') THEN
    RAISE EXCEPTION 'invalid_trigger';
  END IF;

  -- F-04: txn-scoped advisory lock. Concurrent rotations serialise; the
  -- second caller observes the lock as held and returns 'rotation_in_progress'.
  -- The constant `5709437` is the keystone's reserved lock slot (any stable
  -- int4 works; documented here so future code keeps the slot unique).
  IF NOT pg_try_advisory_xact_lock(5709437) THEN
    RAISE EXCEPTION 'rotation_in_progress' USING ERRCODE = '55P03';
  END IF;

  -- G-T07-14: refuse to rotate when the active set is empty. Otherwise the
  -- new epoch would have zero wraps and the data key under that epoch would
  -- be unrecoverable.
  IF (SELECT count(*) FROM public.committee_membership WHERE active) < 1 THEN
    RAISE EXCEPTION 'no_active_members' USING ERRCODE = 'P0001';
  END IF;

  -- Mark the current epoch (if any) rotated.
  SELECT * INTO v_prev FROM public.committee_data_keys
    WHERE rotated_at IS NULL ORDER BY epoch DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    UPDATE public.committee_data_keys SET rotated_at = now() WHERE key_id = v_prev.key_id;
  END IF;

  -- Mint the new epoch row.
  SELECT COALESCE(max(cd.epoch), 0) + 1 INTO v_new_epoch FROM public.committee_data_keys cd;
  INSERT INTO public.committee_data_keys (key_id, epoch) VALUES (v_new_id, v_new_epoch);

  -- Amendment A: emit .started BEFORE the re-wrap pass. The .completed row
  -- is emitted by finalize_committee_data_key_rotation once the app has
  -- inserted wraps for every remaining active member.
  PERFORM public.audit_emit(
    'committee_data_key.rotation.started', public._committee_pseudonym(v_actor),
    'C2', 'notice', NULL, NULL, v_rotation,
    jsonb_build_object(
      'actor_id', v_actor,
      'committee_key_id_prev', v_prev.key_id,
      'committee_key_id_next', v_new_id,
      'rotation_id', v_rotation,
      'trigger', p_trigger
    )
  );
  RETURN QUERY SELECT v_rotation, v_new_id;
END $$;

-- ===========================================================================
-- (10) finalize_committee_data_key_rotation — emits .completed. The app
--      passes back the rotation_id + new key_id from rotate_committee_data_key
--      and the count of members re-wrapped. We sanity-check that .started
--      with the same rotation_id exists (the SECURITY DEFINER chain prevents
--      a forged completion without a corresponding started row).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.finalize_committee_data_key_rotation(
  p_rotation_id              uuid,
  p_new_key_id               uuid,
  p_members_rewrapped_count  integer
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_prev_key_id uuid;
BEGIN
  PERFORM public._t07_gate_active_member();
  IF p_rotation_id IS NULL OR p_new_key_id IS NULL OR p_members_rewrapped_count IS NULL THEN
    RAISE EXCEPTION 'invalid_args';
  END IF;

  -- Pair against the .started row; pull the prev_id from its meta so the
  -- .completed row carries the same identifiers (audit-row pairing contract).
  SELECT (meta ->> 'committee_key_id_prev')::uuid INTO v_prev_key_id
    FROM public.audit_log
    WHERE event_type = 'committee_data_key.rotation.started'
      AND rotation_id = p_rotation_id
    ORDER BY ts DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rotation_not_started';
  END IF;

  -- The new key id MUST be a real (un-rotated-out) epoch.
  IF NOT EXISTS (SELECT 1 FROM public.committee_data_keys
                  WHERE key_id = p_new_key_id AND rotated_at IS NULL) THEN
    RAISE EXCEPTION 'invalid_new_key';
  END IF;

  PERFORM public.audit_emit(
    'committee_data_key.rotation.completed', public._committee_pseudonym(v_actor),
    'C2', 'notice', NULL, NULL, p_rotation_id,
    jsonb_build_object(
      'actor_id', v_actor,
      'committee_key_id_prev', v_prev_key_id,
      'committee_key_id_next', p_new_key_id,
      'rotation_id', p_rotation_id,
      'members_rewrapped_count', p_members_rewrapped_count
    )
  );
END $$;

-- ===========================================================================
-- (11) revoke_committee_member — purge removed member's wraps current +
--      history (the historical row preserves the wrap-ciphertext-as-it-was
--      for retention forensics — F-05); emits committee_data_key.member_revoked
--      paired by rotation_id with the rotation that follows the removal.
--      The membership.active flip is owned by T06.1 (committee_remove_member);
--      this function does NOT touch committee_membership.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.revoke_committee_member(
  p_removed_member_id uuid,
  p_rotation_id       uuid
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_purged     integer := 0;
  v_curr_key   uuid;
BEGIN
  PERFORM public._t07_gate_cochair();
  IF p_removed_member_id IS NULL OR p_rotation_id IS NULL THEN
    RAISE EXCEPTION 'invalid_args';
  END IF;
  -- Co-chair cannot revoke their own keys this way (use the T06.1 4-eyes
  -- self-removal path; that flips membership active=false first).
  IF v_actor = p_removed_member_id THEN
    RAISE EXCEPTION '4eyes_required' USING ERRCODE = '42501';
  END IF;

  -- Archive then delete from the live wraps table. The archive preserves
  -- the wrap ciphertext so retention forensics can trace pre-revoke access.
  WITH archived AS (
    INSERT INTO public.committee_key_wraps_history (user_id, key_id, wrapped_ciphertext, reason)
    SELECT user_id, key_id, wrapped_ciphertext, 'member_revoked'
      FROM public.committee_key_wraps WHERE user_id = p_removed_member_id
    RETURNING 1
  )
  SELECT count(*)::int INTO v_purged FROM archived;
  DELETE FROM public.committee_key_wraps WHERE user_id = p_removed_member_id;

  SELECT key_id INTO v_curr_key FROM public.committee_data_keys
    WHERE rotated_at IS NULL ORDER BY epoch DESC LIMIT 1;

  PERFORM public.audit_emit(
    'committee_data_key.member_revoked', public._committee_pseudonym(v_actor),
    'C2', 'notice', NULL, p_removed_member_id, p_rotation_id,
    jsonb_build_object(
      'actor_id', v_actor,
      'removed_member_id', p_removed_member_id,
      'committee_key_id', v_curr_key,
      'rotation_id', p_rotation_id,
      'wraps_removed', v_purged
    )
  );
  RETURN v_purged;
END $$;

-- ===========================================================================
-- Grants — writes are server-only; the gates above enforce caller authz.
-- ===========================================================================
REVOKE EXECUTE ON FUNCTION
  public.enroll_identity_keypair(bytea, text),
  public.store_recovery_blob(bytea, jsonb),
  public.record_recovery_blob_restored(text),
  public.record_recovery_blob_viewed(text),
  public.issue_recovery_blob_reset(uuid),
  public.init_committee_data_key(),
  public.wrap_committee_data_key_for_member(uuid, uuid, bytea, uuid),
  public.record_committee_data_key_unwrap(uuid),
  public.rotate_committee_data_key(text),
  public.finalize_committee_data_key_rotation(uuid, uuid, integer),
  public.revoke_committee_member(uuid, uuid)
FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION
  public.enroll_identity_keypair(bytea, text),
  public.store_recovery_blob(bytea, jsonb),
  public.record_recovery_blob_restored(text),
  public.record_recovery_blob_viewed(text),
  public.issue_recovery_blob_reset(uuid),
  public.init_committee_data_key(),
  public.wrap_committee_data_key_for_member(uuid, uuid, bytea, uuid),
  public.record_committee_data_key_unwrap(uuid),
  public.rotate_committee_data_key(text),
  public.finalize_committee_data_key_rotation(uuid, uuid, integer),
  public.revoke_committee_member(uuid, uuid)
TO authenticated, supabase_auth_admin;
