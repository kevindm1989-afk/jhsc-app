-- ===========================================================================
-- T05.1 / G-T05-3 — sibling authenticated-callable revoke wrappers.
-- ===========================================================================
--
-- Migration 12 added `revoke_my_session` as the first authenticated-
-- grantable wrapper that derives `auth.uid()` server-side and verifies
-- caller ownership in-function. This migration adds the two sibling
-- wrappers for the remaining browser-side revoke methods:
--
--   - revoke_all_my_sessions()             ← AuthStore.revokeAllForUser
--   - revoke_my_passkey(p_credential_id)   ← AuthStore.deleteCredential
--
-- Both follow the exact pattern PR #109 established for
-- `revoke_my_session`:
--
--   1. Verify auth.uid() IS NOT NULL.
--   2. Verify the caller owns the target (auth.uid() = row.user_id).
--   3. Derive the actor pseudonym server-side via the HMAC pattern.
--   4. Delegate to the canonical SECURITY DEFINER function that
--      handles the UPDATE/DELETE + audit_emit atomically.
--
-- G-T05-3 further partial close: this migration extends the in-
-- function defense-in-depth posture to two more code paths. The
-- original `revoke_all_sessions` / `revoke_passkey` functions still
-- rely on their `supabase_auth_admin`-bound callers for ownership
-- enforcement; bringing the check inside those functions per the
-- original recommendation is still a future task.

-- ---------------------------------------------------------------------------
-- revoke_all_my_sessions — every active session for the caller
-- ---------------------------------------------------------------------------
--
-- The AuthStore.revokeAllForUser contract takes a user_id parameter
-- because the in-memory MemoryAuthStore supports arbitrary-user revoke
-- (admin scenarios). The Supabase wrapper restricts to self-revoke
-- only — the SQL function derives user_id from auth.uid() and ignores
-- any client-supplied value. The dispatcher (auth-op) enforces that
-- the caller-supplied user_id matches auth.uid() before invocation
-- as a defense-in-depth measure.

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
  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'rls_denied' USING ERRCODE = '42501';
  END IF;

  v_pseudonym := LEFT(
    encode(
      hmac(
        v_caller_uid::text::bytea,
        current_setting('app.hmac_pseudonym_key')::bytea,
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
-- revoke_my_passkey — delete one passkey credential the caller owns
-- ---------------------------------------------------------------------------
--
-- Like `revoke_my_session`, this wrapper:
--   - Looks up the credential's user_id to verify caller ownership.
--   - Collapses "not found" + "not yours" into the same rls_denied
--     error to avoid leaking which credential_ids are valid via a
--     permission-vs-not-found differential.
--   - Derives BOTH the actor and the revoker pseudonyms server-side
--     from auth.uid() — they're equal for self-revoke (the only path
--     this wrapper supports). The canonical `revoke_passkey` takes
--     them separately to support an admin-revoke flow that this
--     wrapper does NOT expose.

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
        current_setting('app.hmac_pseudonym_key')::bytea,
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
