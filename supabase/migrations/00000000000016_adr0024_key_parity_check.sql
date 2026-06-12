-- ===========================================================================
-- ADR-0024 (M0 closure for M2):
--   key_parity_server_sha() SECURITY DEFINER function + deploy_reader_role.
--
--   The deploy-time CI step + the per-Edge-Function cold-start check both
--   call this one function to read SHA-256 of the GUC app.hmac_pseudonym_key
--   and compare against SHA-256 of $HMAC_PSEUDONYM_KEY in the caller. The
--   function returns the SHA only — never the key. Audit emission happens
--   at the caller (CI step or EF dispatcher), not in this fn.
--
-- Authoritative ADRs: ADR-0024 (`.context/decisions.md`),
--   threat-model.md §3.14 F-124 / F-125 / F-126, new trust boundary B9.
--
-- New role: `deploy_reader_role` (NOLOGIN) with EXECUTE on this function
-- and NOTHING else. No BYPASSRLS, no SELECT on base tables, no other
-- GRANTs. The role is reachable via a dedicated DB connection used only
-- by the deploy job. EF cold-start runs as the EF's existing connection
-- role (authenticator / service_role) which already has EXECUTE on
-- public functions; the per-process check imports key-parity.ts which
-- calls this fn over the same connection — no role change at runtime.
-- ===========================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deploy_reader_role') THEN
    CREATE ROLE deploy_reader_role NOLOGIN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.key_parity_server_sha()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_key text;
BEGIN
  -- current_setting('app.hmac_pseudonym_key', true): the second arg makes
  -- a missing GUC return NULL instead of raising. NULL → empty-string SHA
  -- which will never match a real key SHA, so the caller's parity check
  -- fails closed even when the GUC isn't set on this connection.
  v_key := COALESCE(current_setting('app.hmac_pseudonym_key', true), '');
  RETURN encode(digest(v_key::bytea, 'sha256'), 'hex');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.key_parity_server_sha() FROM public;
GRANT EXECUTE ON FUNCTION public.key_parity_server_sha() TO deploy_reader_role;

-- The EF cold-start path runs as supabase_auth_admin / authenticator on the
-- Supabase stack and consumes the same fn; mirror the auth grant so the
-- runtime half can call it without role-switching.
GRANT EXECUTE ON FUNCTION public.key_parity_server_sha() TO supabase_auth_admin;

COMMENT ON FUNCTION public.key_parity_server_sha() IS
  'ADR-0024 / B9: returns SHA-256 of app.hmac_pseudonym_key GUC (hex). Never returns the key. Caller compares against sha256($HMAC_PSEUDONYM_KEY). Mismatch ⇒ caller fails closed.';
COMMENT ON ROLE deploy_reader_role IS
  'ADR-0024 / B9 deploy-pipeline trust boundary: NOLOGIN sibling of mint_writer/c4_read_service. Holds EXECUTE on key_parity_server_sha() and nothing else. Reached via a dedicated deploy-job DB connection.';
