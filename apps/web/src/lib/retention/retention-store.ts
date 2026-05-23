/**
 * RetentionStore interfaces (T16; F-64, F-65, F-66).
 *
 * Two layers:
 *   - `RetentionStore` — production-only surface. Zero `__debug*` /
 *     `__force*` members. Closed allowlist of methods; no caller-supplied
 *     WHERE/predicate/filter (F-64).
 *   - `TestRetentionStore extends RetentionStore` — test-only superset that
 *     adds the `__debug*` / `__force*` hooks the harness uses to seed and
 *     poison the store. SupabaseRetentionStore (T16.1) implements
 *     `RetentionStore` only — narrowing it back to TestRetentionStore is
 *     a type error.
 *
 * Pattern lineage: G-T11-21 / G-T13-15 / G-T14-17 — the test surface is
 * strictly additive over the production surface so production callers
 * cannot reach the seeding hooks even via a structural cast.
 */

import type { RetentionEventType } from './types';

/**
 * Audit-log delete batch result returned by `deleteForEventType`. The library
 * consumes only the count; the row ids are surfaced for diagnostics in test
 * cases that need to verify a specific row was swept.
 */
export interface DeleteBatchResult {
  readonly deleted_count: number;
}

/**
 * Audit-log row shape consumed by `emitRetentionDeleted`. The library
 * computes every field; the store persists.
 */
export interface RetentionDeletedAuditRow {
  readonly event_type: 'retention.deleted';
  readonly ts_ms: number;
  readonly target_id: null;
  readonly actor_pseudonym: string;
  readonly meta: Record<string, unknown>;
}

/**
 * Production interface — the closed-allowlist of methods the library calls.
 *
 * F-64: `deleteForEventType` has arity 3 — (event_type, cutoff_ms, max_rows).
 * No method here accepts a string SQL fragment, a predicate, or a filter.
 */
export interface RetentionStore {
  /** F-66 — monotonic ms-epoch clock. Strictly increasing across calls. */
  nowMs(): number;

  /**
   * Delete `audit_log` rows for a given event_type whose `ts_ms` is `<=
   * cutoff_ms`, up to `max_rows`. Returns the number actually deleted.
   *
   * The store is responsible for the underlying-record-ceiling rule when
   * the schedule entry's kind is `match_underlying` — the library passes
   * the ceiling cutoff via the dedicated `deleteForCeiling` call instead.
   * This method handles the per-event-type cutoff only.
   */
  deleteForEventType(
    event_type: RetentionEventType,
    cutoff_ms: number,
    max_rows: number
  ): Promise<DeleteBatchResult>;

  /**
   * Delete audit_log rows of any event_type whose linked `target_id` was
   * deleted from its source table > `ceiling_cutoff_ms` ms ago AND whose
   * schedule entry does NOT carry `no_target_id: true`. F-61.
   */
  deleteForUnderlyingRecordCeiling(
    ceiling_cutoff_ms: number,
    max_rows: number
  ): Promise<DeleteBatchResult>;

  /**
   * Delete rows from a named operational table whose ts column is older
   * than `cutoff_ms`. Table name comes from the closed
   * `OPERATIONAL_TABLE_SCHEDULE` allowlist.
   */
  deleteOperationalTable(
    table_name: string,
    cutoff_ms: number,
    max_rows: number
  ): Promise<DeleteBatchResult>;

  /**
   * Count candidate audit_log rows per event_type — the over-delete alarm
   * uses this to decide whether to fire BEFORE any deletes commit. The
   * library never proceeds to delete if the alarm fires without explicit
   * operator confirmation (F-57).
   */
  countCandidatesPerEventType(
    cutoffs_ms: Readonly<Record<RetentionEventType, number>>
  ): Promise<Readonly<Record<RetentionEventType, number>>>;

  /** Count candidate rows under the underlying-record-ceiling rule. */
  countCandidatesForCeiling(ceiling_cutoff_ms: number): Promise<number>;

  /** Count candidate rows in an operational table older than `cutoff_ms`. */
  countCandidatesInOperationalTable(table_name: string, cutoff_ms: number): Promise<number>;

  /**
   * Atomically: emit the `retention.deleted` summary row AS THE LAST row
   * of the pass, AND record the `retention_sweep_runs` checkpoint row. If
   * either fails, the implementation MUST roll back all in-flight deletes
   * the pass has performed (F-58 + F-24 inversion).
   *
   * The library calls this exactly once per non-aborted pass.
   */
  emitRetentionDeletedAndRegisterRun(args: {
    row: RetentionDeletedAuditRow;
    run: {
      readonly run_id: string;
      readonly started_at_ms: number;
      readonly completed_at_ms: number;
      readonly schedule_hash: string;
      readonly per_event_counts: Readonly<Record<string, number>>;
      readonly per_table_counts: Readonly<Record<string, number>>;
      readonly truncated_to_row_cap: boolean;
      readonly alarm_fired: boolean;
      readonly status: 'completed' | 'capped';
    };
  }): Promise<void>;

  /**
   * Take an in-memory snapshot used for the rollback path (F-58). The
   * library snapshots BEFORE the first delete and restores on emit failure.
   * The token is opaque to the library.
   */
  snapshot(): symbol;

  /** Restore the snapshot identified by the token. Idempotent. */
  restore(token: symbol): void;

  /**
   * Check the `retention_sweep_runs` lease window (F-59). Returns true if a
   * prior pass started within the last `lease_window_ms`.
   */
  hasOpenSweepRunWithinWindow(now_ms: number, lease_window_ms: number): Promise<boolean>;

  /** F-19/F-67 — HMAC-pseudonym for the SYSTEM actor (no PII path). */
  systemActorPseudonym(): string;
}
