-- ===========================================================================
-- T07.1 / ADR-0026 Phase 0a (P0a-2) — Server-side READ probe for the live
-- committee data key's resume state (F-138 edge-A discriminator).
--
-- The keystone (migration 0007) revokes all direct SELECT on
-- `committee_data_keys` + `committee_key_wraps` from authenticated/anon. The
-- Phase-0a co-chair provisioning ceremony's RESUME branch needs to read,
-- without ever touching key material, the state of the live
-- (`rotated_at IS NULL`) key so it can correctly route `already_initialised`:
--
--   - zero wraps for ANY member  → TRUE edge-A (init-ok / wrap-fail): the key
--                                  bytes are irretrievably lost; rotate the
--                                  dead key and re-init under a fresh key_id.
--   - actor holds a wrap         → already provisioned (success-equivalent).
--   - some OTHER member wrapped,  → foreign-held: the actor cannot self-wrap;
--     actor does NOT               surface a recoverable error.
--
-- Per ADR-0026 Amendment A Ruling 1 the load-bearing discriminator is the
-- TOTAL WRAP COUNT of the live key, NOT actor-wrap presence (which cannot
-- tell the zero-wrap case from the foreign-held case). This function returns
-- both the count and the actor flag so the client branches on the count.
--
-- No audit row is emitted on the READ itself (a pure resume probe; emission
-- stays with the write paths — init/wrap/rotate own their rows per ADR-0003
-- Amendment A single-emission-path). No key material crosses the boundary:
-- only the key_id (a uuid), the epoch (an integer), a count, and a boolean.
--
-- Conventions mirror the prior T07 migrations (esp. migration 0010's
-- self-only read fn):
--   - SECURITY DEFINER; gates on `_t07_gate_active_member()` (F-01 — the
--     resume path only runs for an active member, matching its sibling
--     init/wrap/rotate fns).
--   - REVOKED from PUBLIC, anon, service_role; GRANTed to authenticated +
--     supabase_auth_admin (matches the sibling T07 fns the t07-op dispatcher
--     calls under the caller's auth.uid()).
--   - No-row case (no live key) returns no rows; the client maps that to
--     "not provisioned" and proceeds to a fresh init.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.committee_key_state_for_self()
RETURNS TABLE(key_id uuid, epoch integer, wrap_count integer, actor_has_wrap boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  PERFORM public._t07_gate_active_member();
  RETURN QUERY
    SELECT
      cdk.key_id,
      cdk.epoch,
      (SELECT count(*)::integer
         FROM public.committee_key_wraps w
        WHERE w.key_id = cdk.key_id)                                AS wrap_count,
      EXISTS (SELECT 1
                FROM public.committee_key_wraps w
               WHERE w.key_id = cdk.key_id
                 AND w.user_id = v_actor)                           AS actor_has_wrap
      FROM public.committee_data_keys cdk
     WHERE cdk.rotated_at IS NULL;
END $$;

REVOKE EXECUTE ON FUNCTION public.committee_key_state_for_self()
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.committee_key_state_for_self()
  TO authenticated, supabase_auth_admin;
