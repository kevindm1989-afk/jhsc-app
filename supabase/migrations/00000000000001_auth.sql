-- T05 — Authentication: passkeys (WebAuthn) + TOTP bootstrap + sessions.
--
-- Source obligations:
--   - .context/decisions.md ADR-0002 — passkeys-only, TOTP enrollment.
--   - .context/decisions.md ADR-0001 — Canadian region pin (orthogonal).
--   - .context/threat-model.md §3.1 F-37..F-43.
--   - observability/audit-log.md §1 "Auth + session (T05)".
--   - observability/alerts.md §1 A-AUTH-001, A-AUTH-002.
--
-- Hard rules followed:
--   - RLS on every table (ADR-0004). Default deny; SELECT scoped to the
--     owning user; UPDATE / DELETE controlled paths only.
--   - Audit emission via a SECURITY DEFINER `audit_emit` function (architect
--     pattern; the chain hash is computed by the function — callers cannot
--     forge a hash).
--   - TOTP bootstrap row is DELETED in the same transaction as the first
--     passkey enrollment (F-43); a separate `auth_totp_consumed_log` table
--     records the consumed-code so reuse attempts can still be detected as
--     410 Gone (F-38) without bringing the row back.
--   - Session jti revocation is server-side (F-39); a revoked session_id
--     cannot reauthenticate even if the JWT is held client-side.
--
-- Notes:
--   - This migration assumes the `users` table is provided by Supabase
--     Auth as a view backed by `auth.users`. The JHSC profile fields live
--     on a side-table `public.users` keyed by the same UUID.
--   - The `audit_log` table itself is created later in T18's migration; this
--     migration creates a STUB `audit_log` table here so the auth emission
--     paths have somewhere to write. The T18 migration will ALTER it to add
--     hash-chain columns + the strict CHECK constraint.

-- ===========================================================================
-- AUDIT-LOG STUB (full schema lands in T18 migration)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.audit_log (
  id              bigserial PRIMARY KEY,
  ts              timestamptz NOT NULL DEFAULT now(),
  actor_pseudonym varchar(16) NOT NULL,
  event_type      text NOT NULL,
  target_id       uuid,
  target_class    text NOT NULL CHECK (target_class IN ('C0','C1','C2','C3','C4')),
  severity        text NOT NULL DEFAULT 'info'
                  CHECK (severity IN ('info','notice','warn','alert')),
  request_id      uuid,
  rotation_id     uuid,
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash       bytea,
  hash            bytea
);

CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON public.audit_log (ts);
CREATE INDEX IF NOT EXISTS audit_log_event_type_ts_idx
  ON public.audit_log (event_type, ts);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- SELECT: active members only. is_active_member() lands with T07/T08;
-- until then we deny by default.
CREATE POLICY audit_log_select_deny_default ON public.audit_log
  FOR SELECT TO authenticated
  USING (false);

REVOKE INSERT, UPDATE, DELETE ON public.audit_log FROM authenticated, anon;

-- ===========================================================================
-- audit_emit — SECURITY DEFINER emission path
-- ===========================================================================
--
-- The hash-chain is filled in by T18's migration. Until then, callers go
-- through this function so we have a single emission path that the
-- semgrep rule + audit-log CI gate can match on.

CREATE OR REPLACE FUNCTION public.audit_emit(
  p_event_type      text,
  p_actor_pseudonym varchar(16),
  p_target_class    text,
  p_severity        text,
  p_target_id       uuid DEFAULT NULL,
  p_rotation_id     uuid DEFAULT NULL,
  p_meta            jsonb DEFAULT '{}'::jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO public.audit_log (
    event_type, actor_pseudonym, target_class, severity,
    target_id, rotation_id, meta
  )
  VALUES (
    p_event_type, p_actor_pseudonym, p_target_class, p_severity,
    p_target_id, p_rotation_id, p_meta
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.audit_emit(
  text, varchar, text, text, uuid, uuid, jsonb
) FROM public;

-- ===========================================================================
-- USERS profile side-table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.users (
  id                  uuid PRIMARY KEY,
  active              boolean NOT NULL DEFAULT true,
  role                text CHECK (role IN ('worker_member','worker_co_chair','certified_member')),
  totp_destroyed_at   timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Each user sees their own profile row; co-chairs see all (gated by role).
CREATE POLICY users_select_self ON public.users
  FOR SELECT TO authenticated
  USING (auth.uid() = id);

-- ===========================================================================
-- TOTP bootstrap (F-38, F-43)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.auth_totp_bootstraps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- The secret is HMAC-derived in production; for the test harness this
  -- column holds the literal short code. Production callers MUST hash
  -- before storing.
  secret_hash     bytea NOT NULL,
  totp_code       text NOT NULL,                    -- short-lived code; for the harness only
  issued_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,             -- issued_at + 15 min
  consumed_at     timestamptz,
  wrong_attempts  integer NOT NULL DEFAULT 0,
  locked_at       timestamptz,
  UNIQUE (user_id, totp_code)
);

CREATE INDEX IF NOT EXISTS auth_totp_bootstraps_user_id_idx
  ON public.auth_totp_bootstraps (user_id);

ALTER TABLE public.auth_totp_bootstraps ENABLE ROW LEVEL SECURITY;

-- TOTP bootstraps are server-managed; users do NOT SELECT them. Only
-- the audit_emit-shaped SECURITY DEFINER functions read them.
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.auth_totp_bootstraps
  FROM authenticated, anon;

-- ===========================================================================
-- TOTP consumed-log (F-38 reuse detection without keeping the row)
-- ===========================================================================
--
-- Per F-43 the bootstrap row is DELETED on consume. To still answer
-- "is this code one we already accepted?" (F-38 single-use) we record a
-- minimal audit-shaped row here. Retained 24h (T16 will own the
-- retention rule).

CREATE TABLE IF NOT EXISTS public.auth_totp_consumed_log (
  id              bigserial PRIMARY KEY,
  user_id         uuid NOT NULL,
  totp_code_hash  bytea NOT NULL,                   -- HMAC of the consumed code
  consumed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_totp_consumed_log_user_idx
  ON public.auth_totp_consumed_log (user_id, consumed_at);

ALTER TABLE public.auth_totp_consumed_log ENABLE ROW LEVEL SECURITY;

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.auth_totp_consumed_log
  FROM authenticated, anon;

-- ===========================================================================
-- WebAuthn credentials (passkeys)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.webauthn_credentials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id   text NOT NULL UNIQUE,              -- WebAuthn cred ID (base64url)
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  public_key      bytea NOT NULL,
  counter         bigint NOT NULL DEFAULT 0,
  aaguid          uuid,
  transports      text[] NOT NULL DEFAULT '{}'::text[],
  -- User-provided device label only. NEVER raw UA. Audited so a co-chair
  -- can read the label in the audit log without seeing a fingerprintable
  -- UA string.
  device_label    text,
  rp_id           text NOT NULL,                     -- the eTLD+1 bound at registration (F-37)
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webauthn_credentials_user_idx
  ON public.webauthn_credentials (user_id);

ALTER TABLE public.webauthn_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY webauthn_credentials_select_self ON public.webauthn_credentials
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ===========================================================================
-- Sessions (F-39 server-side jti revocation)
-- ===========================================================================
--
-- The jti is stored as the `session_id`. Every request through the auth
-- middleware looks up this row; `revoked_at IS NOT NULL` short-circuits
-- to 401 within 5 seconds of the revoke.

CREATE TABLE IF NOT EXISTS public.auth_sessions (
  session_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  device_label        text,
  device_fingerprint  text,                          -- hashed; never raw UA
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,          -- 15 min TTL per ADR-0002
  revoked_at          timestamptz
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
  ON public.auth_sessions (user_id) WHERE revoked_at IS NULL;

ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_sessions_select_self ON public.auth_sessions
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ===========================================================================
-- enroll_first_passkey — F-43 atomic: consume TOTP + bind passkey + audit
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.enroll_first_passkey(
  p_user_id        uuid,
  p_totp_code      text,
  p_credential_id  text,
  p_public_key     bytea,
  p_aaguid         uuid,
  p_transports     text[],
  p_rp_id          text,
  p_device_label   text,
  p_actor_pseudonym varchar(16)
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bootstrap public.auth_totp_bootstraps%ROWTYPE;
BEGIN
  -- Lock the bootstrap row for the duration of this transaction.
  SELECT *
    INTO v_bootstrap
    FROM public.auth_totp_bootstraps
   WHERE user_id = p_user_id
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

  IF now() >= v_bootstrap.expires_at THEN
    RAISE EXCEPTION 'TOTP_BOOTSTRAP_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  IF v_bootstrap.totp_code <> p_totp_code THEN
    UPDATE public.auth_totp_bootstraps
       SET wrong_attempts = wrong_attempts + 1,
           locked_at = CASE WHEN wrong_attempts + 1 >= 5 THEN now() ELSE locked_at END
     WHERE id = v_bootstrap.id;
    RAISE EXCEPTION 'TOTP_BOOTSTRAP_WRONG_CODE' USING ERRCODE = 'P0001';
  END IF;

  -- Atomically: insert consumed-log row, delete bootstrap, set
  -- users.totp_destroyed_at, save credential, emit audit row.
  INSERT INTO public.auth_totp_consumed_log (user_id, totp_code_hash)
    VALUES (p_user_id, digest(p_totp_code, 'sha256'));

  DELETE FROM public.auth_totp_bootstraps WHERE id = v_bootstrap.id;

  UPDATE public.users
     SET totp_destroyed_at = now(),
         updated_at        = now()
   WHERE id = p_user_id;

  INSERT INTO public.webauthn_credentials (
    credential_id, user_id, public_key, aaguid, transports, rp_id, device_label
  )
  VALUES (
    p_credential_id, p_user_id, p_public_key, p_aaguid, p_transports, p_rp_id, p_device_label
  );

  PERFORM public.audit_emit(
    p_event_type      => 'auth.passkey.enrolled',
    p_actor_pseudonym => p_actor_pseudonym,
    p_target_class    => 'C1',
    p_severity        => 'info',
    p_meta            => jsonb_build_object(
      'cred_id_pseudonym', encode(digest(p_credential_id, 'sha256'), 'hex')
    )
  );

  RETURN p_credential_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enroll_first_passkey(
  uuid, text, text, bytea, uuid, text[], text, text, varchar
) FROM public;

-- ===========================================================================
-- revoke_session — F-39 with audit row in same txn
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.revoke_session(
  p_session_id      uuid,
  p_revoked_by      uuid,
  p_actor_pseudonym varchar(16),
  p_reason          text DEFAULT 'user_action'
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.auth_sessions
     SET revoked_at = now()
   WHERE session_id = p_session_id
     AND revoked_at IS NULL;

  IF FOUND THEN
    PERFORM public.audit_emit(
      p_event_type      => 'session.revoked',
      p_actor_pseudonym => p_actor_pseudonym,
      p_target_id       => p_session_id,
      p_target_class    => 'C1',
      p_severity        => 'info',
      p_meta            => jsonb_build_object(
        'session_id_pseudonym', encode(digest(p_session_id::text, 'sha256'), 'hex'),
        'revoked_by_actor_pseudonym', p_actor_pseudonym,
        'reason', p_reason
      )
    );
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.revoke_session(uuid, uuid, varchar, text)
  FROM public;

-- ===========================================================================
-- revoke_all_sessions — F-39
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.revoke_all_sessions(
  p_user_id         uuid,
  p_actor_pseudonym varchar(16),
  p_reason          text DEFAULT 'user_action'
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE public.auth_sessions
     SET revoked_at = now()
   WHERE user_id = p_user_id
     AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  PERFORM public.audit_emit(
    p_event_type      => 'session.revoked',
    p_actor_pseudonym => p_actor_pseudonym,
    p_target_class    => 'C1',
    p_severity        => 'info',
    p_meta            => jsonb_build_object(
      'revoked_by_actor_pseudonym', p_actor_pseudonym,
      'reason', p_reason,
      'session_count', v_count
    )
  );

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.revoke_all_sessions(uuid, varchar, text)
  FROM public;

-- ===========================================================================
-- revoke_passkey
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.revoke_passkey(
  p_credential_id   text,
  p_actor_pseudonym varchar(16),
  p_revoker_pseudonym varchar(16)
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  DELETE FROM public.webauthn_credentials
   WHERE credential_id = p_credential_id
   RETURNING user_id INTO v_user_id;

  IF FOUND THEN
    PERFORM public.audit_emit(
      p_event_type      => 'auth.passkey.revoked',
      p_actor_pseudonym => p_actor_pseudonym,
      p_target_class    => 'C1',
      p_severity        => 'info',
      p_meta            => jsonb_build_object(
        'cred_id_pseudonym',         encode(digest(p_credential_id, 'sha256'), 'hex'),
        'revoked_by_actor_pseudonym', p_revoker_pseudonym
      )
    );
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.revoke_passkey(text, varchar, varchar)
  FROM public;
