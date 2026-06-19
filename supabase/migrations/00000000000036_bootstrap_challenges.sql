-- ===========================================================================
-- ADR-0025 + threat-model C1/C2/C4/C14 — bootstrap-isolated WebAuthn challenge
-- surface.
--
-- The mint sign-in path uses `public.auth_challenges` + `mint_issue_challenge`
-- / `mint_consume_challenge` (migration 0003). The bootstrap REGISTRATION
-- ceremony is a SEPARATE trust domain: a challenge issued for the bootstrap
-- (one-shot first-co-chair create) must NEVER satisfy mint's consume, and vice
-- versa. The WebAuthn ceremony itself naturally binds challenges via
-- `clientDataJSON.type` (webauthn.create vs webauthn.get), but belt-and-braces:
-- isolate the storage so a logic error in either path cannot cross-pollute.
--
-- The bootstrap challenge also carries the issuance rp_id + origin so the
-- handler can REJECT (C4) when a challenge issued for one rp/origin is
-- presented with a different one in the body — closes the gap between
-- single-use-correctness and binding-correctness.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.bootstrap_challenges (
  challenge    text PRIMARY KEY,                 -- base64url, server-issued CSPRNG
  rp_id        text NOT NULL,                    -- bound at issuance (F-37)
  origin       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS bootstrap_challenges_unconsumed_expires_idx
  ON public.bootstrap_challenges (expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE public.bootstrap_challenges ENABLE ROW LEVEL SECURITY;
-- (No policies: default-deny for anon/authenticated. Reachable only via the
-- mint_writer-granted issue/consume SECURITY DEFINER functions below.)

-- ---------------------------------------------------------------------------
-- bootstrap_issue_challenge — server-issued single-use challenge with TTL
-- clamp (1..120s). Mirrors mint_issue_challenge.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bootstrap_issue_challenge(
  p_rp_id        text,
  p_origin       text,
  p_ttl_seconds  integer DEFAULT 120
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_challenge text;
BEGIN
  v_challenge := translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_');
  INSERT INTO public.bootstrap_challenges (challenge, rp_id, origin, expires_at)
  VALUES (v_challenge, p_rp_id, p_origin,
          now() + make_interval(secs => LEAST(GREATEST(p_ttl_seconds, 1), 120)));
  RETURN v_challenge;
END $$;

-- ---------------------------------------------------------------------------
-- bootstrap_consume_challenge — atomic single-use consume that ALSO returns
-- the issuance (rp_id, origin) so the EF can bind body values to them (C4).
-- A consumed/expired/missing challenge returns NULL row; the EF treats this
-- and any (rp_id, origin) mismatch as the SAME normalized error (C12).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bootstrap_consume_challenge(p_challenge text)
RETURNS TABLE(rp_id text, origin text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.bootstrap_challenges
     SET consumed_at = now()
   WHERE challenge = p_challenge
     AND consumed_at IS NULL
     AND expires_at > now()
  RETURNING bootstrap_challenges.rp_id, bootstrap_challenges.origin;
END $$;

REVOKE ALL ON FUNCTION public.bootstrap_issue_challenge(text, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bootstrap_consume_challenge(text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.bootstrap_issue_challenge(text, text, integer)
  TO mint_writer;
GRANT EXECUTE ON FUNCTION public.bootstrap_consume_challenge(text)
  TO mint_writer;

COMMENT ON TABLE public.bootstrap_challenges IS
  'ADR-0025 C2: bootstrap registration challenges, isolated from auth_challenges so a register-challenge cannot satisfy mint_consume_challenge and vice versa. Self-expiring (≤120s); RLS default-deny; only reachable via the mint_writer-granted issue/consume fns.';

-- ===========================================================================
-- Audit-event enum extension — auth.passkey.enroll_failed (ADR-0025 C11).
--
-- Adds a new closed-enum event so a forged-attestation attempt during the
-- bootstrap window has a DURABLE forensic record (the bootstrap EF rejects
-- before the RPC, so the SQL fn cannot emit it). Six-mirror dance per
-- patterns.md:
--   (1) TS RetentionEventType union               — apps/web/src/lib/retention/types.ts
--   (2) TS RETENTION_SCHEDULE + EVENT_TYPES_RUNTIME — apps/web/src/lib/retention/schedule.ts
--   (3) SQL retention_class_for arm                — THIS migration (below)
--   (4) observability/audit-log.md §1 row          — see docs
--   (5) scripts/check-audit-enum-coverage.sh        — EXPECTED_ENUM array
--   (6) pgTAP retention-class arm test              — supabase/test/adr0015_amend_i_retention_classes.sql
--
-- Retention class 90d: operational forensic surface — the value lies in
-- 30-90-day post-incident review, not 7y archival. Matches `auth.passkey.enrolled`
-- and `auth.passkey.revoked` siblings.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.retention_class_for(p_event_type text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE p_event_type
    WHEN 'auth.passkey.enrolled'                          THEN '90d'
    WHEN 'auth.passkey.enroll_failed'                     THEN '90d'  -- ADR-0025 C11 (NEW)
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
    WHEN 'key_parity.mismatch'                            THEN '24mo'
    WHEN 'key_parity.deploy_ok'                           THEN '24mo'
    WHEN 'auth.mint.revoked_during_mint'                  THEN '24mo'
    WHEN 'audit.integrity_check.ran'                      THEN '24mo'
    WHEN 'audit.integrity_check.mismatch'                 THEN '7y'
    WHEN 'audit.chain_anchor.weekly'                      THEN '7y'
    WHEN 'backup.manifest_written'                        THEN '7y'
    WHEN 'backup.hard_deleted'                            THEN '7y'
    ELSE '24mo'
  END;
$$;

-- ---------------------------------------------------------------------------
-- bootstrap_audit_enroll_failed — purpose-narrow wrapper letting the bootstrap
-- EF emit `auth.passkey.enroll_failed` from its self-minted mint_writer
-- identity. `audit_emit` itself is supabase_auth_admin-only; rather than widen
-- its grant matrix, expose ONLY this single-event emission path to mint_writer.
-- Defense in depth: the wrapper hardcodes the event_type so a caller cannot
-- forge any other audit row through it. Origin/rpId travel as meta (length-
-- bounded by Postgres jsonb). NO raw credential id / clientDataJSON / AAGUID
-- (privacy + no info-disclosure-via-audit).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bootstrap_audit_enroll_failed(
  p_outcome     text,
  p_rp_id       text,
  p_origin      text,
  p_request_id  uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF p_outcome IS NULL OR length(p_outcome) > 64
     OR p_rp_id IS NULL OR length(p_rp_id) > 256
     OR p_origin IS NULL OR length(p_origin) > 256 THEN
    RAISE EXCEPTION 'BOOTSTRAP_AUDIT_BAD_INPUT' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.audit_emit(
    p_event_type      => 'auth.passkey.enroll_failed',
    p_actor_pseudonym => 'bootstrap0000000',  -- deterministic, no PI
    p_target_class    => 'C1',
    p_severity        => 'warn',
    p_request_id      => p_request_id,
    p_meta            => jsonb_build_object(
      'outcome', p_outcome,
      'rp_id',   p_rp_id,
      'origin',  p_origin
    )
  );
END $$;

REVOKE ALL ON FUNCTION public.bootstrap_audit_enroll_failed(text, text, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bootstrap_audit_enroll_failed(text, text, text, uuid)
  TO mint_writer;
