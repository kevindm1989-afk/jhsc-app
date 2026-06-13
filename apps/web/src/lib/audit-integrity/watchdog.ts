/**
 * A-INTEGRITY-001 watchdog probe (M9.B).
 *
 * Out-of-band check that a successful integrity-check pass (`status =
 * 'ok'`) occurred within the configured window. The library's run
 * shape only surfaces alerts INSIDE a pass; if the pass never fired
 * at all, the only signal is silence. The watchdog turns that silence
 * into a real alert dispatch.
 *
 * Source: docs/runbooks/A-INTEGRITY-001.md; ADR-0019 §3 (T18
 * scheduled-pass cadence — daily 04:30 ET).
 *
 * Wiring shape:
 *   - This module is pure TS. It takes a `WatchdogStore` shim that
 *     answers ONE question: "what is the started_at_ms of the most
 *     recent integrity_check_runs row with status='ok'?" — and a
 *     monotonic `nowMs()` clock.
 *   - The actual production probe (Edge Function or pg_cron) wires
 *     a Supabase-backed `WatchdogStore` over a SECURITY DEFINER
 *     function (`integrity_check_runs.status='ok'` SELECT) and calls
 *     `runWatchdogProbe(...)`.
 *   - The probe is invoked by the M9 alert dispatch infrastructure
 *     via `dispatchWatchdogAlerts(result, ts_ms)` (see
 *     ../alerts/result-adapters.ts).
 */

/** Closed discriminated-union result. */
export type WatchdogProbeResult =
  | {
      readonly status: 'ok';
      readonly most_recent_ok_ms: number;
      readonly age_ms: number;
    }
  | {
      readonly status: 'no_recent_pass';
      readonly most_recent_ok_ms: number | null;
      readonly age_ms: number | null;
      readonly window_ms: number;
      readonly would_fire_alert: 'A-INTEGRITY-001';
    };

/** Minimal store interface — testable without a real Supabase client. */
export interface WatchdogStore {
  /**
   * Returns the `started_at_ms` of the most recent integrity_check_runs
   * row with `status = 'ok'`, or `null` if none exists.
   */
  mostRecentOkRunStartedAtMs(): Promise<number | null>;
}

/** Probe configuration. */
export interface WatchdogProbeConfig {
  readonly store: WatchdogStore;
  readonly nowMs: () => number;
  /**
   * The watchdog window in ms. The probe fires A-INTEGRITY-001 if the
   * most recent ok-run is older than `nowMs() - window_ms`. Default
   * upstream is `9 * 60 * 60 * 1000` (9h = 2× the 4:30 ET daily cadence
   * with slack), but the caller passes the value explicitly so the
   * window is part of the audit trail.
   */
  readonly window_ms: number;
}

/**
 * Single probe pass. Pure async; no side effects beyond the
 * `WatchdogStore` read.
 *
 * Validation:
 *   - `window_ms` must be > 0; non-positive raises before the store
 *     read so a misconfigured probe never silently passes.
 */
export async function runWatchdogProbe(cfg: WatchdogProbeConfig): Promise<WatchdogProbeResult> {
  if (cfg.window_ms <= 0) {
    throw new Error('watchdog window_ms must be > 0');
  }
  const now = cfg.nowMs();
  const mostRecent = await cfg.store.mostRecentOkRunStartedAtMs();
  if (mostRecent == null) {
    return {
      status: 'no_recent_pass',
      most_recent_ok_ms: null,
      age_ms: null,
      window_ms: cfg.window_ms,
      would_fire_alert: 'A-INTEGRITY-001'
    };
  }
  const age_ms = now - mostRecent;
  if (age_ms <= cfg.window_ms) {
    return {
      status: 'ok',
      most_recent_ok_ms: mostRecent,
      age_ms
    };
  }
  return {
    status: 'no_recent_pass',
    most_recent_ok_ms: mostRecent,
    age_ms,
    window_ms: cfg.window_ms,
    would_fire_alert: 'A-INTEGRITY-001'
  };
}

/**
 * Default window: 9 hours. Twice the 4:30 ET daily cadence plus
 * slack for deploy windows and pg_cron drift.
 *
 * Production callers MUST pass `window_ms` explicitly; this constant
 * is a documented default for tests and the runbook.
 */
export const WATCHDOG_DEFAULT_WINDOW_MS = 9 * 60 * 60 * 1000;
