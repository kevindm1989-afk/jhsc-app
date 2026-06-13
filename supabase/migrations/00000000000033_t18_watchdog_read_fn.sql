-- ===========================================================================
-- M9.B / T18.1 — watchdog SECURITY DEFINER read fn.
--
--   Closes the M9.B watchdog probe's production wiring by shipping the
--   SECURITY DEFINER read function that SupabaseWatchdogStore consumes:
--
--     integrity_check_most_recent_ok_started_at_ms() RETURNS bigint
--
--   Returns the `started_at_ms` of the most recent
--   `integrity_check_runs` row with `status = 'ok'`, or NULL if no
--   such row exists.
--
--   The TS adapter (apps/web/src/lib/audit-integrity/supabase-
--   watchdog-store.ts) calls this fn on each probe tick; the
--   watchdog library translates the result into the closed
--   WatchdogProbeResult discriminated union (no_recent_pass /
--   ok), and the alerts adapter (dispatchWatchdogAlerts) fires
--   A-INTEGRITY-001 when appropriate.
--
--   Closed STABLE fn; integrity_check_role only (B6.2 trust
--   boundary). NO PI — operational telemetry surface.
--
-- Authoritative ADRs: ADR-0019 §3 (T18 fn set); M9.B watchdog probe
--   (apps/web/src/lib/audit-integrity/watchdog.ts); docs/runbooks/
--   A-INTEGRITY-001.md.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.integrity_check_most_recent_ok_started_at_ms()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT MAX(started_at_ms)
    FROM public.integrity_check_runs
   WHERE status = 'ok';
$$;

REVOKE EXECUTE ON FUNCTION public.integrity_check_most_recent_ok_started_at_ms()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.integrity_check_most_recent_ok_started_at_ms()
  TO integrity_check_role;

COMMENT ON FUNCTION public.integrity_check_most_recent_ok_started_at_ms() IS
  'ADR-0019 §3 / M9.B watchdog probe: MAX(started_at_ms) of integrity_check_runs WHERE status=ok, or NULL when no ok-run ever recorded. STABLE. integrity_check_role only.';
