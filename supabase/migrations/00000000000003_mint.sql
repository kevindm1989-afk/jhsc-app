-- ===========================================================================
-- T05.1 — mint-session DB layer (ADR-0023 / threat-model §3.12).
--
-- The passkey-login mint path. The mint Edge Function verifies the WebAuthn
-- assertion in Deno, then assumes a dedicated least-privilege role (mint_writer)
-- via a self-minted role JWT signed with the SAME isolated asymmetric key it
-- uses for session tokens (F-118) — NO service_role is involved. It then calls
-- the SECURITY DEFINER RPCs below, which are granted EXECUTE to mint_writer
-- ONLY (never anon/authenticated/PUBLIC), so a session can be created solely
-- behind a verified assertion inside the Edge Function (F-117 / F-119). WebAuthn
-- replay is bounded by a single-use, short-TTL, server-issued challenge.
--
-- Source: ADR-0023 (mint deferral → T05.1), ADR-0002 (passkeys), threat-model
-- §3.1 (F-37 RP-ID) + §3.12 (F-116..F-120). Composes the T05 tables
-- webauthn_credentials (public_key, counter) + auth_sessions (the jti list).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- mint_writer — the narrow identity the mint Edge Function assumes.
-- NOLOGIN: reachable only via a JWT carrying role='mint_writer'. Granted ONLY
-- EXECUTE on the mint_* RPCs below (no table privileges, never RLS-bypassing).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mint_writer') THEN
    CREATE ROLE mint_writer NOLOGIN;
  END IF;
  -- PostgREST/GoTrue SET ROLE into the role named by the JWT `role` claim; that
  -- requires the connection role (`authenticator`, on the Supabase stack) to be
  -- a member. Absent on the vanilla pgTAP shim, hence the guard.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    GRANT mint_writer TO authenticator;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- auth_challenges — single-use, short-TTL WebAuthn login challenges.
-- RLS on with NO policies: unreachable by anon/authenticated; the SECURITY
-- DEFINER mint_* RPCs are the only path that touches it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.auth_challenges (
  challenge    text PRIMARY KEY,                 -- base64url, server-issued CSPRNG
  rp_id        text NOT NULL,                    -- eTLD+1 bound at issuance (F-37)
  origin       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);

ALTER TABLE public.auth_challenges ENABLE ROW LEVEL SECURITY;
-- (No policies: default-deny for anon/authenticated.)

-- ---------------------------------------------------------------------------
-- mint_issue_challenge — mint a fresh login challenge (TTL clamped to ≤120s).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mint_issue_challenge(
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
  -- 32 bytes CSPRNG → base64url (RFC 4648 §5: + → -, / → _, drop '=' padding).
  v_challenge := translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_');
  INSERT INTO public.auth_challenges (challenge, rp_id, origin, expires_at)
  VALUES (v_challenge, p_rp_id, p_origin,
          now() + make_interval(secs => LEAST(GREATEST(p_ttl_seconds, 1), 120)));
  RETURN v_challenge;
END $$;

-- ---------------------------------------------------------------------------
-- mint_consume_challenge — atomically single-use a live challenge. Returns
-- true only if it existed, was unexpired and not already consumed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mint_consume_challenge(p_challenge text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_ok boolean;
BEGIN
  UPDATE public.auth_challenges
     SET consumed_at = now()
   WHERE challenge = p_challenge
     AND consumed_at IS NULL
     AND expires_at > now()
  RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END $$;

-- ---------------------------------------------------------------------------
-- mint_lookup_credential — resolve a proven credential to its owner + key
-- material (F-117/F-119: uid is server-derived from the credential).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mint_lookup_credential(p_credential_id text)
RETURNS TABLE(user_id uuid, public_key bytea, counter bigint, rp_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT user_id, public_key, counter, rp_id
    FROM public.webauthn_credentials
   WHERE credential_id = p_credential_id;
$$;

-- ---------------------------------------------------------------------------
-- mint_create_session — write the jti row to the revocation list (F-116:
-- written before the token is issued, so a revoke can deny it for its life).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mint_create_session(
  p_user_id     uuid,
  p_expires_at  timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_session_id uuid;
BEGIN
  INSERT INTO public.auth_sessions (user_id, expires_at)
  VALUES (p_user_id, p_expires_at)
  RETURNING session_id INTO v_session_id;
  RETURN v_session_id;
END $$;

-- ---------------------------------------------------------------------------
-- mint_bump_counter — monotonic signature-counter update (WebAuthn clone
-- detection); never decreases.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mint_bump_counter(
  p_credential_id  text,
  p_counter        bigint
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  UPDATE public.webauthn_credentials
     SET counter = GREATEST(counter, p_counter),
         last_used_at = now()
   WHERE credential_id = p_credential_id;
$$;

-- ---------------------------------------------------------------------------
-- Grant matrix — the mint path is reachable ONLY by mint_writer. Revoking the
-- default PUBLIC EXECUTE then granting mint_writer means anon/authenticated
-- (members of PUBLIC) cannot create a session without a verified assertion.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.mint_issue_challenge(text, text, integer)   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mint_consume_challenge(text)                FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mint_lookup_credential(text)                FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mint_create_session(uuid, timestamptz)      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mint_bump_counter(text, bigint)             FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.mint_issue_challenge(text, text, integer) TO mint_writer;
GRANT EXECUTE ON FUNCTION public.mint_consume_challenge(text)              TO mint_writer;
GRANT EXECUTE ON FUNCTION public.mint_lookup_credential(text)              TO mint_writer;
GRANT EXECUTE ON FUNCTION public.mint_create_session(uuid, timestamptz)    TO mint_writer;
GRANT EXECUTE ON FUNCTION public.mint_bump_counter(text, bigint)           TO mint_writer;
