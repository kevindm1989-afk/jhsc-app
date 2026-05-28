-- ===========================================================================
-- T07.1 — Server-side READ path for the recovery blob (F-08 restore flow).
--
-- The keystone (migration 0007) revokes all direct SELECT on
-- `recovery_blobs` from authenticated/anon. `store_recovery_blob` writes
-- the row; `record_recovery_blob_restored` audits the post-decrypt restore;
-- `record_recovery_blob_viewed` audits the Amendment F reveal — but there
-- was NO production path to READ the blob ciphertext + kdf_params back to
-- the client so it could DECRYPT on a new device. Without that, the F-08
-- restore-on-new-device flow is dead-on-arrival: the user can write their
-- passphrase-sealed blob during onboarding, but a future device cannot
-- fetch it to attempt a decrypt.
--
-- This migration closes that gap with a self-only SECURITY DEFINER
-- function. The function ONLY returns the auth.uid()'s own row (the row
-- shape itself enforces "self-only" — there's no parameter — so RLS is
-- structural rather than predicate-checked). No audit row is emitted on
-- the READ itself; the subsequent client-side decrypt either succeeds
-- (and the client posts `record_recovery_blob_restored` which audits) or
-- fails (the client posts nothing; the wrong-passphrase forensic surface
-- is the failed sign-in attempt the AuthStore already records).
--
-- Conventions mirror the prior T07 migrations:
--   - SECURITY DEFINER; gates on session_is_live() (F-116).
--   - REVOKED from PUBLIC, GRANTed to authenticated + supabase_auth_admin.
--   - No-row case returns no rows (RETURNS TABLE shape); client handles.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.get_recovery_blob_for_self()
RETURNS TABLE(blob_ciphertext bytea, kdf_params jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  PERFORM public._t07_gate_session();
  RETURN QUERY
    SELECT rb.blob_ciphertext, rb.kdf_params
      FROM public.recovery_blobs rb
     WHERE rb.user_id = v_actor;
END $$;

REVOKE EXECUTE ON FUNCTION public.get_recovery_blob_for_self()
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_recovery_blob_for_self()
  TO authenticated, supabase_auth_admin;
