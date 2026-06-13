/**
 * SupabaseWatchdogStore — production-time WatchdogStore against the
 * Supabase project. Calls the SECURITY DEFINER RPC landed in migration
 * 00000000000033_t18_watchdog_read_fn.sql.
 *
 * Source obligations:
 *   - apps/web/src/lib/audit-integrity/watchdog.ts (the WatchdogStore
 *     interface + runWatchdogProbe contract).
 *   - docs/runbooks/A-INTEGRITY-001.md.
 *   - threat-model.md §6 B6.2 (integrity_check_role).
 *
 * Production wiring (out of scope for this PR; ships with the cron
 * schedule pin):
 *   - Edge Function (or pg_cron task) calls runWatchdogProbe with
 *     this store + nowMs + window_ms.
 *   - dispatchWatchdogAlerts(result, ts_ms) fires A-INTEGRITY-001 on
 *     no_recent_pass.
 */

import type { WatchdogStore } from './watchdog';

/**
 * Minimal RPC interface — narrower than the supabase-js client. Keeps
 * this module testable without dragging the full @supabase/supabase-js
 * type surface into vitest. The production caller passes a wrapper
 * over `supabase.rpc(fn, args)`. Mirrors the
 * SupabaseRetentionStore / SupabaseBackupStore shim shape.
 */
export interface SupabaseWatchdogRpc {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): Promise<{ data: unknown; error: { code?: string | null; message: string } | null }>;
}

/** Store configuration. */
export interface SupabaseWatchdogStoreConfig {
  readonly rpc: SupabaseWatchdogRpc;
}

export class SupabaseWatchdogStore implements WatchdogStore {
  constructor(private readonly cfg: SupabaseWatchdogStoreConfig) {}

  async mostRecentOkRunStartedAtMs(): Promise<number | null> {
    const { data, error } = await this.cfg.rpc.rpc(
      'integrity_check_most_recent_ok_started_at_ms',
      {}
    );
    if (error) {
      throw new WatchdogRpcError('integrity_check_most_recent_ok_started_at_ms', error);
    }
    if (data == null) return null;
    return Number(data);
  }
}

/**
 * Wraps a Postgres-level error from a watchdog RPC. The caller
 * (runWatchdogProbe) does NOT catch this — a probe that fails to
 * read state is itself a signal worth pager attention, but it's
 * the dispatcher's job to surface it (probably as a separate
 * one-shot log line rather than a fired alert symbol; the runbook
 * §3 "watchdog of the watchdog" thread covers it).
 */
export class WatchdogRpcError extends Error {
  constructor(
    public readonly fn: string,
    public override readonly cause: { code?: string | null; message: string }
  ) {
    super(`watchdog rpc ${fn} failed: ${cause.code ?? 'unknown'} — ${cause.message}`);
    this.name = 'WatchdogRpcError';
  }
}
