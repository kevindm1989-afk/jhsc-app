/**
 * SupabaseRetentionStore — production-time RetentionStore against the
 * Supabase project. Mirrors the same RetentionStore contract the
 * library consumes from MemoryRetentionStore.
 *
 * Source obligations:
 *   - ADR-0017 §3/§7 (T16 retention sweep library + sibling task spec).
 *   - ADR-0015 + Amendment I (per-event-type retention schedule).
 *   - threat-model.md §6 B6 trust boundary (retention_service_role).
 *
 * Production path:
 *   The store calls SECURITY DEFINER RPCs landed in migration
 *   00000000000022_t16_retention_sweep_functions.sql:
 *     - retention_delete_for_event_type
 *     - retention_count_for_event_type
 *     - retention_delete_operational_table
 *     - retention_count_in_operational_table
 *     - retention_emit_deleted_and_register_run
 *   These functions have EXECUTE granted ONLY to retention_service_role.
 *   The supabase client supplied to this store MUST authenticate as a
 *   role that can EXECUTE them — in production the pg_cron job runs as
 *   retention_service_role directly.
 *
 * What this PR does NOT yet ship (separate M6 follow-ups):
 *   - deleteForUnderlyingRecordCeiling + countCandidatesForCeiling
 *     throw `not_implemented_until_m6_1_b` until #219 lands.
 *   - pg_cron wrapper that invokes the library's runRetentionPass.
 */

import { createHmac } from 'node:crypto';
import type { RetentionEventType } from './types';
import type { DeleteBatchResult, RetentionStore } from './retention-store';

/**
 * Minimal RPC interface — narrower than the supabase-js client. Keeps
 * this module testable without dragging the full @supabase/supabase-js
 * type surface into vitest. The production caller passes a wrapper
 * over `supabase.rpc(fn, args)`.
 */
export interface SupabaseRetentionRpc {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): Promise<{ data: unknown; error: { code?: string | null; message: string } | null }>;
}

/**
 * Minimal selectable interface for the open-sweep-run lease check.
 * Mirrors supabase-js's `.from('retention_sweep_runs').select(...)`.
 */
export interface SupabaseRetentionSelect {
  selectRunsStartedAfter(
    threshold_ms: number
  ): Promise<{ count: number; error: { code?: string | null; message: string } | null }>;
}

/**
 * Configuration for the production store. The caller injects:
 *   - `rpc`: the supabase-js .rpc() shim.
 *   - `select`: the supabase-js .from() shim for retention_sweep_runs.
 *   - `nowMs`: clock; defaults to Date.now (overridable in tests).
 *   - `hmacKey`: ONLY used to derive `systemActorPseudonym()` for the
 *     row-shape the library asks for. The SQL RPC re-derives the
 *     pseudonym server-side and ignores the value returned here, so
 *     this is structural only. In production the same value of
 *     `$HMAC_PSEUDONYM_KEY` flows in (the parity gate enforces it).
 */
export interface SupabaseRetentionStoreConfig {
  readonly rpc: SupabaseRetentionRpc;
  readonly select: SupabaseRetentionSelect;
  readonly nowMs?: () => number;
  readonly hmacKey: string;
}

export class SupabaseRetentionStore implements RetentionStore {
  private readonly cfg: SupabaseRetentionStoreConfig;
  private readonly _nowMs: () => number;
  /** Cached HMAC('system:retention') for the row's actor_pseudonym. */
  private readonly _systemActorPseudonym: string;

  constructor(cfg: SupabaseRetentionStoreConfig) {
    this.cfg = cfg;
    this._nowMs = cfg.nowMs ?? Date.now;
    this._systemActorPseudonym = createHmac('sha256', cfg.hmacKey)
      .update('system:retention')
      .digest('hex')
      .slice(0, 16);
  }

  nowMs(): number {
    return this._nowMs();
  }

  systemActorPseudonym(): string {
    return this._systemActorPseudonym;
  }

  // ---- delete/count: event_type ------------------------------------------

  async deleteForEventType(
    event_type: RetentionEventType,
    cutoff_ms: number,
    max_rows: number
  ): Promise<DeleteBatchResult> {
    const { data, error } = await this.cfg.rpc.rpc('retention_delete_for_event_type', {
      p_event_type: event_type,
      p_cutoff_ms: cutoff_ms,
      p_max_rows: max_rows
    });
    if (error) throw new RetentionRpcError('retention_delete_for_event_type', error);
    return { deleted_count: Number(data ?? 0) };
  }

  async countCandidatesPerEventType(
    cutoffs_ms: Readonly<Record<RetentionEventType, number>>
  ): Promise<Readonly<Record<RetentionEventType, number>>> {
    const out: Partial<Record<RetentionEventType, number>> = {};
    // Sequential — the candidate set is small (one row per event type)
    // and the RPC is cheap. Parallelising would add multi-statement
    // transaction surface for no measurable win.
    for (const [et, cutoff] of Object.entries(cutoffs_ms) as Array<[RetentionEventType, number]>) {
      const { data, error } = await this.cfg.rpc.rpc('retention_count_for_event_type', {
        p_event_type: et,
        p_cutoff_ms: cutoff
      });
      if (error) throw new RetentionRpcError('retention_count_for_event_type', error);
      out[et] = Number(data ?? 0);
    }
    return out as Readonly<Record<RetentionEventType, number>>;
  }

  // ---- delete/count: operational table -----------------------------------

  async deleteOperationalTable(
    table_name: string,
    cutoff_ms: number,
    max_rows: number
  ): Promise<DeleteBatchResult> {
    const { data, error } = await this.cfg.rpc.rpc('retention_delete_operational_table', {
      p_table_name: table_name,
      p_cutoff_ms: cutoff_ms,
      p_max_rows: max_rows
    });
    if (error) throw new RetentionRpcError('retention_delete_operational_table', error);
    return { deleted_count: Number(data ?? 0) };
  }

  async countCandidatesInOperationalTable(table_name: string, cutoff_ms: number): Promise<number> {
    const { data, error } = await this.cfg.rpc.rpc('retention_count_in_operational_table', {
      p_table_name: table_name,
      p_cutoff_ms: cutoff_ms
    });
    if (error) throw new RetentionRpcError('retention_count_in_operational_table', error);
    return Number(data ?? 0);
  }

  // ---- ceiling rule — DEFERRED to M6.1.B (#219) --------------------------

  async deleteForUnderlyingRecordCeiling(
    _ceiling_cutoff_ms: number,
    _max_rows: number
  ): Promise<DeleteBatchResult> {
    throw new Error('not_implemented_until_m6_1_b');
  }

  async countCandidatesForCeiling(_ceiling_cutoff_ms: number): Promise<number> {
    throw new Error('not_implemented_until_m6_1_b');
  }

  // ---- emit + checkpoint -------------------------------------------------

  async emitRetentionDeletedAndRegisterRun(
    args: Parameters<RetentionStore['emitRetentionDeletedAndRegisterRun']>[0]
  ): Promise<void> {
    const { run } = args;
    const { error } = await this.cfg.rpc.rpc('retention_emit_deleted_and_register_run', {
      p_run_id: run.run_id,
      p_started_at_ms: run.started_at_ms,
      p_completed_at_ms: run.completed_at_ms,
      p_schedule_hash: run.schedule_hash,
      p_per_event_counts: run.per_event_counts,
      p_per_table_counts: run.per_table_counts,
      p_truncated_to_row_cap: run.truncated_to_row_cap,
      p_alarm_fired: run.alarm_fired,
      p_status: run.status
    });
    if (error) throw new RetentionRpcError('retention_emit_deleted_and_register_run', error);
  }

  // ---- snapshot / restore — no-ops -------------------------------------
  //
  // The SQL emit_deleted_and_register_run RPC is atomic at the
  // transaction level (INSERT checkpoint + audit_emit in one tx). The
  // library's per-pass snapshot/restore models the MemoryStore's
  // rollback-by-deep-copy semantic. Production rollback is the SQL
  // transaction's COMMIT/ROLLBACK; snapshot+restore are no-ops here.

  snapshot(): symbol {
    return Symbol('retention-snapshot:noop');
  }

  restore(_token: symbol): void {
    // intentional no-op — see header comment
  }

  // ---- lease / open-sweep check -----------------------------------------

  async hasOpenSweepRunWithinWindow(now_ms: number, lease_window_ms: number): Promise<boolean> {
    const threshold = now_ms - lease_window_ms;
    const { count, error } = await this.cfg.select.selectRunsStartedAfter(threshold);
    if (error) throw new RetentionRpcError('selectRunsStartedAfter', error);
    return count > 0;
  }
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Wraps a Postgres-level error from a retention RPC call. Caller maps
 * (e.g.) ERRCODE 22023 to invalid_input and falls into the library's
 * abort-and-restore path.
 */
export class RetentionRpcError extends Error {
  constructor(
    public readonly fn: string,
    public override readonly cause: { code?: string | null; message: string }
  ) {
    super(`retention rpc ${fn} failed: ${cause.code ?? 'unknown'} — ${cause.message}`);
    this.name = 'RetentionRpcError';
  }
}
