-- ===========================================================================
-- T07.1 — Server-side emission path for `client.identity_selftest_fail`
-- (G-T07-2 / G-T07-15 production-wire-up tail).
--
-- The audit-log enum value `client.identity_selftest_fail` is reserved in
-- the closed enum (ADR-0015 / observability/audit-log.md §1) with 90-day
-- retention. It is a CLIENT-EMITTED operational signal: the F-03 self-test
-- in `apps/web/src/lib/crypto/index.ts` fires it when the device-local
-- private key (IndexedDB) drifts from the server-side public key. No SQL
-- function in the keystone (0007) or F-02 (0008) migrations emits it,
-- because the signal is purely about device-side state — there's no
-- server-side trigger.
--
-- This migration closes that gap: `record_identity_selftest_fail(p_meta)`
-- gates on session_is_live (F-116) and forwards to the existing
-- audit_emit infrastructure with the server-computed pseudonym and the
-- canonical event_type string. The Edge Function `t07-op record_selftest_fail`
-- op routes the call from the production `SupabaseT07Client`.
--
-- Conventions mirror the prior T07 migrations:
--   - SECURITY DEFINER; REVOKED from PUBLIC, GRANTed to authenticated +
--     supabase_auth_admin.
--   - Session-live gate (F-116) — a revoked-but-unexpired session cannot
--     manufacture a self-test-fail row.
--   - Pseudonym derived server-side via `_committee_pseudonym(auth.uid())`
--     (HMAC-SHA256 keyed by `app.hmac_pseudonym_key`).
--   - Meta is jsonb under client control — the closed-enum + the
--     retention_class are server-derived; the meta provides forensic
--     context only and never affects routing.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.record_identity_selftest_fail(
  p_meta jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  PERFORM public._t07_gate_session();
  PERFORM public.audit_emit(
    'client.identity_selftest_fail', public._committee_pseudonym(v_actor),
    'C1', 'warn', NULL, v_actor, NULL,
    COALESCE(p_meta, '{}'::jsonb) || jsonb_build_object('actor_id', v_actor)
  );
END $$;

REVOKE EXECUTE ON FUNCTION public.record_identity_selftest_fail(jsonb)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_identity_selftest_fail(jsonb)
  TO authenticated, supabase_auth_admin;
