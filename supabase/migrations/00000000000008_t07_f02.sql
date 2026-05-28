-- ===========================================================================
-- T07.1 — F-02 sealed-box enrollment-challenge handshake (G-T07-9).
--
-- Threat (F-02 in threat-model.md): a hostile client could enroll an
-- identity public key without holding the corresponding private half.
-- The keystone migration 0007's `enroll_identity_keypair(public_key, fp)`
-- accepts the pubkey at face value — useful for tests / direct flows, but
-- production onboarding needs proof-of-possession.
--
-- Mitigation (F-02 / G-T07-9):
--   1. The client posts its just-generated `public_key` + the BLAKE2b
--      fingerprint to the t07-op `enrollment_challenge_init` endpoint.
--   2. The Edge Function generates a fresh random nonce, seals it to the
--      posted pubkey via `crypto_box_seal`, calls
--      `issue_enrollment_challenge(public_key, pubkey_fingerprint, raw_nonce)`
--      so the SQL function stores the HMAC of the nonce (NOT the raw nonce),
--      and returns the SEALED nonce to the client.
--   3. The client unseals the nonce with its device-local private key and
--      posts the cleartext back to `enrollment_challenge_finalize`.
--   4. The Edge Function calls
--      `verify_and_enroll_identity_keypair(challenge_id, raw_nonce_observed)`
--      which HMACs the observed nonce, compares to the stored hash, and on
--      match atomically INSERTs the `identity_keys` row + emits
--      `identity_keypair.created`. A hostile client without the privkey can't
--      unseal the nonce and falls at step 3.
--
-- Conventions mirror migration 0007:
--   - SECURITY DEFINER functions; writes mediated + REVOKED from
--     authenticated/anon; gate on `session_is_live()` (F-116).
--   - Pseudonym derivation goes through the existing `_committee_pseudonym(uid)`
--     helper from 0002 (HMAC-SHA256 keyed by `app.hmac_pseudonym_key`).
--   - Nonce hashing is also HMAC-SHA256 keyed by `app.hmac_pseudonym_key` —
--     stays compliant with `.semgrep/no-bare-sha256-in-migrations.yml`
--     (the rule reserves bare SHA-256 for HMAC-keyed pseudonyms / commitments).
--
-- Failure modes:
--   - `challenge_expired` (P0001) — TTL elapsed (default 10 min).
--   - `challenge_consumed` (P0001) — already finalized successfully.
--   - `wrong_nonce` (P0001) — single mismatch; no side effects, no audit
--     row (forensic noise discouraged at this layer; the TTL is the
--     rate-limit bound since the nonce is 32 random bytes and brute force
--     is 1/2^256 per attempt). Postgres rolls back the whole function
--     on RAISE EXCEPTION so a server-side attempt counter is moot
--     anyway — TTL is the bound.
--
-- The keystone's direct `enroll_identity_keypair(public_key, fingerprint)`
-- is left in place for test-direct paths but is documented as
-- "non-F-02-hardened"; production wire-up routes through the challenge
-- functions only. A follow-up may REVOKE the direct path from `authenticated`
-- once SupabaseKeyStore lands.
--
-- PG14-safe (CI's committee-db-tests job is vanilla PG14): no PG15-only
-- features; pgcrypto.hmac is available since the pgcrypto extension is
-- already loaded by migration 0000_bootstrap.sql.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- enrollment_challenges — in-flight F-02 challenges.
-- The raw nonce NEVER lands here; only its HMAC.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.enrollment_challenges (
  challenge_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The pubkey the challenge is bound to. The verify step does NOT
  -- re-accept a pubkey from the client; it pulls this row and uses
  -- THIS value as the canonical identity public key being enrolled.
  target_user_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  public_key            bytea NOT NULL,
  pubkey_fingerprint    text NOT NULL,
  -- HMAC of the raw nonce, computed by issue_enrollment_challenge using
  -- `app.hmac_pseudonym_key`. The raw nonce lives only in the Edge
  -- Function's response payload (sealed to the pubkey).
  nonce_hash            bytea NOT NULL,
  issued_at             timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  consumed_at           timestamptz
);
CREATE INDEX IF NOT EXISTS enrollment_challenges_target_idx
  ON public.enrollment_challenges (target_user_id);
CREATE INDEX IF NOT EXISTS enrollment_challenges_open_idx
  ON public.enrollment_challenges (expires_at) WHERE consumed_at IS NULL;

ALTER TABLE public.enrollment_challenges ENABLE ROW LEVEL SECURITY;
-- All access mediated via the SECURITY DEFINER functions below.
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.enrollment_challenges FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- issue_enrollment_challenge — server records the challenge for the caller.
-- Returns the challenge_id; the Edge Function combines it with the SEALED
-- nonce (which it computed itself before this call) into the response payload.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_enrollment_challenge(
  p_public_key          bytea,
  p_pubkey_fingerprint  text,
  p_raw_nonce           bytea,
  p_ttl_minutes         integer DEFAULT 10
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_id    uuid;
  v_hash  bytea;
BEGIN
  PERFORM public._t07_gate_session();
  IF p_public_key IS NULL OR length(p_public_key) <> 32 THEN
    RAISE EXCEPTION 'invalid_pubkey';                                       -- X25519 = 32 bytes
  END IF;
  -- BLAKE2b-32 output is 32 bytes → 64 hex chars (the JS lib's to_hex format).
  IF p_pubkey_fingerprint IS NULL OR p_pubkey_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_fingerprint';
  END IF;
  IF p_raw_nonce IS NULL OR length(p_raw_nonce) < 16 THEN
    RAISE EXCEPTION 'invalid_nonce';                                        -- ≥ 16 bytes; Edge Fn picks 32
  END IF;
  IF p_ttl_minutes IS NULL OR p_ttl_minutes < 1 OR p_ttl_minutes > 60 THEN
    RAISE EXCEPTION 'invalid_ttl';
  END IF;
  -- Refuse to issue if the caller already has an identity_keys row — the
  -- challenge is for first enrollment only. (A re-enrollment after recovery
  -- goes through restoreFromRecoveryBlob; not this path.)
  IF EXISTS (SELECT 1 FROM public.identity_keys WHERE user_id = v_actor) THEN
    RAISE EXCEPTION 'duplicate' USING ERRCODE = '23505';
  END IF;

  v_hash := hmac(p_raw_nonce, current_setting('app.hmac_pseudonym_key')::bytea, 'sha256');

  -- Garbage-collect prior unconsumed challenges from this caller so a
  -- replay-or-spam attempt can't accumulate state.
  DELETE FROM public.enrollment_challenges
    WHERE target_user_id = v_actor AND consumed_at IS NULL;

  INSERT INTO public.enrollment_challenges (
    target_user_id, public_key, pubkey_fingerprint, nonce_hash, expires_at
  ) VALUES (
    v_actor, p_public_key, p_pubkey_fingerprint, v_hash,
    now() + make_interval(mins => p_ttl_minutes)
  ) RETURNING challenge_id INTO v_id;

  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- verify_and_enroll_identity_keypair — atomic verify + enroll.
-- On match: INSERTs identity_keys + emits identity_keypair.created + marks
-- the challenge consumed, all in one transaction. On mismatch / expiry /
-- too-many-attempts: raises with a specific reason; no identity_keys row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_and_enroll_identity_keypair(
  p_challenge_id           uuid,
  p_raw_nonce_observed     bytea
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_row      public.enrollment_challenges%ROWTYPE;
  v_observed bytea;
BEGIN
  PERFORM public._t07_gate_session();
  IF p_challenge_id IS NULL THEN RAISE EXCEPTION 'invalid_args'; END IF;
  IF p_raw_nonce_observed IS NULL OR length(p_raw_nonce_observed) < 16 THEN
    RAISE EXCEPTION 'invalid_nonce';
  END IF;

  SELECT * INTO v_row FROM public.enrollment_challenges
    WHERE challenge_id = p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  -- Caller must be the challenge's target; defense in depth on top of
  -- session_is_live (the target_user_id was captured from auth.uid()
  -- at issue-time, so this is a tampering check on a forged challenge_id).
  IF v_row.target_user_id <> v_actor THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;
  IF v_row.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'challenge_consumed' USING ERRCODE = 'P0001';
  END IF;
  IF v_row.expires_at < now() THEN
    RAISE EXCEPTION 'challenge_expired' USING ERRCODE = 'P0001';
  END IF;

  v_observed := hmac(p_raw_nonce_observed, current_setting('app.hmac_pseudonym_key')::bytea, 'sha256');
  IF v_observed <> v_row.nonce_hash THEN
    -- Mismatch: surface the reason. We do NOT increment a server-side
    -- counter — Postgres rolls back the whole function on RAISE so any
    -- counter update would be reverted. The TTL is the bound (random
    -- 32-byte nonce; per-attempt success probability ≈ 1/2^256).
    RAISE EXCEPTION 'wrong_nonce' USING ERRCODE = 'P0001';
  END IF;

  -- Atomic: insert identity_keys, mark challenge consumed, emit audit.
  -- ON CONFLICT DO NOTHING covers the (improbable) race where two
  -- concurrent verifications for the same target hit at once; the second
  -- caller would fail-out at the consumed_at check on the second pass
  -- because we mark the row consumed below.
  INSERT INTO public.identity_keys (user_id, public_key)
    VALUES (v_actor, v_row.public_key)
    ON CONFLICT (user_id) DO NOTHING;
  IF NOT FOUND THEN
    -- Identity row already existed — same user double-enrolling between
    -- challenge issuance and verification. Surface as duplicate to mirror
    -- the direct path's contract.
    RAISE EXCEPTION 'duplicate' USING ERRCODE = '23505';
  END IF;
  UPDATE public.enrollment_challenges SET consumed_at = now()
    WHERE challenge_id = p_challenge_id;

  PERFORM public.audit_emit(
    'identity_keypair.created', public._committee_pseudonym(v_actor),
    'C1', 'info', NULL, v_actor, NULL,
    jsonb_build_object(
      'actor_id', v_actor,
      'target_user_id', v_actor,
      'ident_pubkey_fingerprint', v_row.pubkey_fingerprint,
      'enrolled_via', 'f02_sealed_box_challenge'
    )
  );

  RETURN v_actor;
END $$;

-- ---------------------------------------------------------------------------
-- Grants — writes are server-only; the gates enforce caller authz.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  public.issue_enrollment_challenge(bytea, text, bytea, integer),
  public.verify_and_enroll_identity_keypair(uuid, bytea)
FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION
  public.issue_enrollment_challenge(bytea, text, bytea, integer),
  public.verify_and_enroll_identity_keypair(uuid, bytea)
TO authenticated, supabase_auth_admin;
