-- ===========================================================================
-- 046 / F-121 — session-revocation UNIFORMITY at the SQL layer.
-- ===========================================================================
--
-- Finding: F-121 (open HIGH — session-revocation uniformity).
-- Source: threat-model.md §3.14 F-116 / F-121 ; ADR-0023 (session_is_live) +
--         Amendment A (the uniformity gate is STRUCTURAL, mirrored by
--         scripts/verify-session-live-uniformity.sh).
--
-- The F-116 EF-dispatcher precheck (assertSessionLive) already 401s a
-- revoked-but-unexpired caller on the Edge-Function path. The OPEN F-121
-- surface is the DIRECT-PostgREST bypass: a revoked-but-unexpired GoTrue JWT
-- still carries a valid `sub`, so the self-scoped READ policies
-- (`auth.uid() = …`) and the authenticated-grantable REVOKE RPCs still
-- authorize the caller — because none of them consult session_is_live().
--
-- This migration closes the bypass by gating SIX surfaces on the CALLER's
-- live session, mirroring committee_membership_select_active
-- (00000000000002_committee.sql:149-151):
--   read policies : users_select_self, auth_sessions_select_self,
--                   webauthn_credentials_select_self
--   revoke RPCs   : revoke_my_session, revoke_all_my_sessions, revoke_my_passkey
--
-- The gate is on the CALLER, never the target. A LIVE caller is unaffected:
-- it still reads its own rows, and may still idempotently re-revoke an
-- already-revoked owned target (the revoke wrappers keep their existing
-- `auth.uid()` ownership checks + the `UPDATE … WHERE revoked_at IS NULL`
-- idempotence). No behaviour change for legitimate flows.

-- ---------------------------------------------------------------------------
-- (1-3) Read policies — prepend the caller-liveness conjunct.
-- A revoked-but-unexpired JWT still satisfies `auth.uid() = …`; the added
-- `public.session_is_live()` conjunct hides the caller's OWN rows once the
-- session is revoked. It is only a CONJUNCT, so a LIVE caller's own-row reads
-- are unchanged (mirrors committee_membership_select_active).
-- ---------------------------------------------------------------------------
ALTER POLICY users_select_self ON public.users
  USING (public.session_is_live() AND auth.uid() = id);

ALTER POLICY auth_sessions_select_self ON public.auth_sessions
  USING (public.session_is_live() AND auth.uid() = user_id);

ALTER POLICY webauthn_credentials_select_self ON public.webauthn_credentials
  USING (public.session_is_live() AND auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- (4) revoke_my_session — faithful CREATE OR REPLACE of migration 12's body
-- with ONLY the F-121 caller-liveness gate prepended as the FIRST statement.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_my_session(p_session_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_session_owner uuid;
  v_pseudonym varchar(16);
BEGIN
  -- F-121: gate the CALLER's live session FIRST (session_is_live, via the
  -- existing _t07_gate_session one-liner). A revoked-but-unexpired caller is
  -- denied here, closing the direct-PostgREST bypass; a LIVE caller proceeds
  -- unchanged. The gate is on the CALLER, not the target — the idempotent
  -- UPDATE downstream still lets a live caller re-revoke an already-revoked row.
  PERFORM public._t07_gate_session();

  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;

  -- Defense-in-depth: verify the target session belongs to the caller.
  -- The auth_sessions RLS policy already enforces this at SELECT time,
  -- but inside a SECURITY DEFINER function we bypass RLS by design —
  -- so the explicit check is required to honour G-T05-3.
  SELECT user_id INTO v_session_owner
    FROM public.auth_sessions
   WHERE session_id = p_session_id;

  -- If the session does not exist OR belongs to someone else, deny.
  -- Returning the same error for both cases avoids leaking which
  -- session_ids are valid via a permission-vs-not-found differential.
  IF v_session_owner IS NULL OR v_session_owner <> v_caller_uid THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;

  -- Derive the actor pseudonym server-side from auth.uid(). Mirrors
  -- the inline HMAC pattern in `revoke_session` (line 497 of the
  -- auth migration) and `_committee_pseudonym` in the committee
  -- migration; truncated to 16 hex chars per B1.
  v_pseudonym := LEFT(
    encode(
      hmac(
        v_caller_uid::text::bytea,
        private._hmac_pseudonym_key()::bytea,
        'sha256'
      ),
      'hex'
    ),
    16
  )::varchar(16);

  -- Delegate to the canonical revoke + audit function. Idempotent on
  -- already-revoked sessions (the UPDATE filters `revoked_at IS NULL`).
  PERFORM public.revoke_session(
    p_session_id      => p_session_id,
    p_revoked_by      => v_caller_uid,
    p_actor_pseudonym => v_pseudonym,
    p_reason          => 'user_action'
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.revoke_my_session(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.revoke_my_session(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- (5) revoke_all_my_sessions — faithful CREATE OR REPLACE of migration 13's
-- body with ONLY the F-121 caller-liveness gate prepended.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_all_my_sessions()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_pseudonym  varchar(16);
  v_count      int;
BEGIN
  -- F-121: gate the CALLER's live session FIRST (session_is_live, via
  -- _t07_gate_session). A revoked-but-unexpired caller is denied here.
  PERFORM public._t07_gate_session();

  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;

  v_pseudonym := LEFT(
    encode(
      hmac(
        v_caller_uid::text::bytea,
        private._hmac_pseudonym_key()::bytea,
        'sha256'
      ),
      'hex'
    ),
    16
  )::varchar(16);

  -- Delegate to the canonical bulk-revoke + audit function. The
  -- canonical function emits ONE audit row carrying session_count
  -- — that's the right granularity for logout-everywhere.
  v_count := public.revoke_all_sessions(
    p_user_id         => v_caller_uid,
    p_actor_pseudonym => v_pseudonym,
    p_reason          => 'user_action'
  );

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.revoke_all_my_sessions() FROM public;
GRANT EXECUTE ON FUNCTION public.revoke_all_my_sessions() TO authenticated;

-- ---------------------------------------------------------------------------
-- (6) revoke_my_passkey — faithful CREATE OR REPLACE of migration 13's body
-- with ONLY the F-121 caller-liveness gate prepended.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_my_passkey(p_credential_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_cred_owner uuid;
  v_pseudonym  varchar(16);
BEGIN
  -- F-121: gate the CALLER's live session FIRST (session_is_live, via
  -- _t07_gate_session). A revoked-but-unexpired caller is denied here.
  PERFORM public._t07_gate_session();

  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;

  SELECT user_id INTO v_cred_owner
    FROM public.webauthn_credentials
   WHERE credential_id = p_credential_id;

  IF v_cred_owner IS NULL OR v_cred_owner <> v_caller_uid THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;

  v_pseudonym := LEFT(
    encode(
      hmac(
        v_caller_uid::text::bytea,
        private._hmac_pseudonym_key()::bytea,
        'sha256'
      ),
      'hex'
    ),
    16
  )::varchar(16);

  -- Delegate to the canonical revoke + audit function. The
  -- actor and revoker pseudonyms are equal here (self-revoke).
  PERFORM public.revoke_passkey(
    p_credential_id     => p_credential_id,
    p_actor_pseudonym   => v_pseudonym,
    p_revoker_pseudonym => v_pseudonym
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.revoke_my_passkey(text) FROM public;
GRANT EXECUTE ON FUNCTION public.revoke_my_passkey(text) TO authenticated;
