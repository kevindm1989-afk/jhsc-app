-- ===========================================================================
-- T05.1 / G-T05-3 — authenticated-callable session-revoke wrapper.
-- ===========================================================================
--
-- The existing `public.revoke_session(p_session_id, p_revoked_by,
-- p_actor_pseudonym, p_reason)` SECURITY DEFINER function is granted
-- only to `supabase_auth_admin` (not authenticated) and takes
-- `p_actor_pseudonym` as input rather than deriving it from
-- `auth.uid()`. That posture matches the original architect intent of
-- "server-only callers" but blocks the T05.1 browser-side
-- AuthStore.revokeSession path from invoking it directly.
--
-- This migration adds a small wrapper `public.revoke_my_session` that:
--
--   1. Verifies the caller owns the target session
--      (auth.uid() = auth_sessions.user_id) — closes the G-T05-3
--      in-function defense-in-depth gap for the new code path.
--   2. Derives `p_actor_pseudonym` server-side from `auth.uid()`
--      using the same HMAC pattern that `_committee_pseudonym`
--      already uses (avoids a refactor of the existing
--      `revoke_session` signature).
--   3. Calls the existing `public.revoke_session` SECURITY DEFINER
--      function (which handles the UPDATE + audit_emit atomically).
--
-- Grants: EXECUTE TO authenticated. Inside a SECURITY DEFINER
-- function called by an authenticated user, `auth.uid()` still
-- returns the CALLER's uid (the JWT-bound identity is preserved;
-- only the privilege level is elevated). This lets the auth-op Edge
-- Function call the wrapper via the caller-bound supabase client
-- without needing a service-role admin client.
--
-- G-T05-3 partial close: the wrapper pattern demonstrates the
-- in-function defense-in-depth posture. The original
-- `revoke_session` / `revoke_all_sessions` / `revoke_passkey`
-- functions still rely on their wrappers to enforce auth.uid()
-- ownership; bringing the in-function check inside those functions
-- (the original G-T05-3 recommendation) is a follow-up.

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
