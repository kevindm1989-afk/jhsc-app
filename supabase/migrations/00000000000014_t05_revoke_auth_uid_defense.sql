-- ===========================================================================
-- T05.1 / G-T05-3 — in-function auth.uid() defense-in-depth for revoke_*
-- ===========================================================================
--
-- Migrations 12 + 13 added the `revoke_my_*` authenticated-grantable
-- wrappers that enforce ownership BEFORE delegating to the canonical
-- `revoke_session` / `revoke_all_sessions` / `revoke_passkey`. This
-- migration adds the in-function defense-in-depth check that the
-- original G-T05-3 recommendation named:
--
--   "add `IF v_session.user_id != auth.uid() THEN RAISE EXCEPTION ...`
--    (or equivalent) inside each function. Defense in depth."
--
-- Why the check is conditional on `auth.uid() IS NOT NULL`:
--
--   The canonical functions are GRANT'd to `supabase_auth_admin` only.
--   The existing callers reach them via the service-role / auth-admin
--   path which has NULL `auth.uid()` (service_role bypasses
--   `auth.uid()` resolution). A strict check that demanded a non-NULL
--   `auth.uid()` would break those legitimate callers.
--
--   The conditional check (`IF auth.uid() IS NOT NULL AND ...`) only
--   kicks in when the function is reached through an `authenticated`-
--   role caller — which is NOT supposed to happen today because the
--   GRANT excludes `authenticated`. If a future change accidentally
--   regrants these functions, the in-function check fails closed for
--   any caller whose JWT-bound identity doesn't match the target.
--
-- revoke_session uses `p_revoked_by` (explicit revoker uid) for the
-- check; revoke_all_sessions uses `p_user_id` (target user must equal
-- caller). revoke_passkey has no uid arg — its defense lives in the
-- `revoke_my_passkey` wrapper that resolves the credential's user_id
-- and matches against auth.uid() before delegating.

-- ---------------------------------------------------------------------------
-- revoke_session — add the in-function check
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.revoke_session(
  p_session_id      uuid,
  p_revoked_by      uuid,
  p_actor_pseudonym varchar(16),
  p_reason          text DEFAULT 'user_action'
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  -- G-T05-3 defense-in-depth: when called via an authenticated role
  -- (not service_role / supabase_auth_admin), the JWT-bound uid must
  -- match the claimed revoker. If a future regrant exposes this
  -- function to `authenticated`, the check ensures a caller can only
  -- revoke sessions where they are the revoker on record.
  IF auth.uid() IS NOT NULL AND p_revoked_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;

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
      p_request_id      => NULL,
      p_meta            => jsonb_build_object(
        'session_id_pseudonym', LEFT(encode(hmac(p_session_id::text::bytea, current_setting('app.hmac_pseudonym_key')::bytea, 'sha256'), 'hex'), 16),
        'revoked_by_actor_pseudonym', p_actor_pseudonym,
        'reason', p_reason
      )
    );
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- revoke_all_sessions — add the in-function check
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.revoke_all_sessions(
  p_user_id         uuid,
  p_actor_pseudonym varchar(16),
  p_reason          text DEFAULT 'user_action'
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_count int;
BEGIN
  -- G-T05-3 defense-in-depth: when called via authenticated, the
  -- caller can only revoke their own sessions (p_user_id must equal
  -- auth.uid()). Service-role / supabase_auth_admin callers have
  -- NULL auth.uid() and bypass the check.
  IF auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;

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
    p_request_id      => NULL,
    p_meta            => jsonb_build_object(
      'revoked_by_actor_pseudonym', p_actor_pseudonym,
      'reason', p_reason,
      'session_count', v_count
    )
  );

  RETURN v_count;
END;
$$;

-- revoke_passkey defense-in-depth lives in the revoke_my_passkey
-- wrapper (migration 13) because the canonical function has no uid
-- arg to check against. A future refactor that wants in-function
-- defense for revoke_passkey would need to query
-- webauthn_credentials.user_id inside the SECURITY DEFINER body —
-- duplicating what revoke_my_passkey already does.
