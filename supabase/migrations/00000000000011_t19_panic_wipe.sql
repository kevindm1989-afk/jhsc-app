-- ===========================================================================
-- T19.1 — Server-side emission path for `panic_wipe.invoked`
-- (G-T19-PRIV-3 production-wire-up).
--
-- The audit-log enum value `panic_wipe.invoked` is reserved in the closed
-- enum (ADR-0020 Decision 5; documented in observability/audit-log.md §1).
-- It is a CLIENT-EMITTED operational signal: the panic-wipe flow in
-- `apps/web/src/lib/lock/panic-wipe.ts` MUST write this row BEFORE
-- IndexedDB is cleared (F-53 / M-106a audit-before-side-effect). The TS
-- `BrowserWipeStore.emitAudit` was a fail-closed stub until this PR;
-- without a server-side emission path the production panic-wipe button
-- could not actually wipe (the audit-row precondition would fail every
-- call). This migration closes that gap.
--
-- Conventions mirror the prior client-emitted server-side emission paths:
--   - SECURITY DEFINER; REVOKED from PUBLIC, GRANTed to authenticated +
--     supabase_auth_admin.
--   - Session-live gate (F-116) — a revoked-but-unexpired session cannot
--     manufacture a panic-wipe row.
--   - Pseudonym derived server-side via `_committee_pseudonym(auth.uid())`.
--   - The CLIENT-supplied meta jsonb (surface, wipe_scope, completed,
--     partial_failure_classes) merges with the SERVER-derived `actor_id`;
--     the server-derived `actor_id` ALWAYS overrides any value the
--     client smuggles in (same pattern as record_identity_selftest_fail
--     from migration 0009).
--   - Severity 'warn' — operational signal worth surfacing in the daily
--     review queue without firing an alert (ADR-0020 Decision 5: forensic,
--     not alertable).
--   - target_class 'C1' — lifecycle metadata; the wipe affects ONE
--     device's local state, the row is anchored to that user.
--   - target_id := auth.uid() — anchors the row to the wiping user; the
--     Amendment D pseudonymized feed can surface it without exposing
--     identity (the actor_pseudonym field carries the HMAC).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.record_panic_wipe_invoked(
  p_meta jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  PERFORM public._t07_gate_session();
  PERFORM public.audit_emit(
    'panic_wipe.invoked', public._committee_pseudonym(v_actor),
    'C1', 'warn', NULL, v_actor, NULL,
    COALESCE(p_meta, '{}'::jsonb) || jsonb_build_object('actor_id', v_actor)
  );
END $$;

REVOKE EXECUTE ON FUNCTION public.record_panic_wipe_invoked(jsonb)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_panic_wipe_invoked(jsonb)
  TO authenticated, supabase_auth_admin;
