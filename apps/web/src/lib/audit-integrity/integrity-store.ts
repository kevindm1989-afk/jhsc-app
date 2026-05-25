/**
 * IntegrityStore interface (T18; F-98 production half).
 *
 * Closed-allowlist surface. ZERO `__` properties — the test mutators live
 * exclusively on `TestIntegrityStore` (which extends this) in
 * `./memory-integrity-store.ts`.
 *
 * Pattern lineage: G-T11-21 / G-T13-15 / G-T14-17 / G-T16-PRIV-1 / G-T17
 * F-85. The test surface is strictly additive over the production surface
 * so production callers cannot reach the seeding hooks even via a
 * structural cast.
 *
 * F-97 defense-in-depth: no method here accepts a caller-supplied
 * predicate, WHERE-fragment, table-name string, pivot, or runtime_pin.
 * The library hard-codes the closed allowlist from `IntegrityCheckTrigger`
 * and reads the runtime pin via `readNodeRuntimePin()`.
 */

import type {
  AuditChainRowMaterialized,
  BackupManifestSnapshot,
  IntegrityCheckRunRow,
  IntegrityMismatchMeta,
  IntegrityNodeRuntimePin,
  RetentionSweepRunSnapshot
} from './types';

/**
 * Emitted audit-row shape. The library never composes a row with PII; the
 * `actor_pseudonym` is the system-actor HMAC at TOP LEVEL only (G-T16-PRIV-1).
 */
export interface IntegrityEmittedAuditRow {
  readonly event_type:
    | 'audit.integrity_check.ran'
    | 'audit.integrity_check.mismatch'
    | 'audit.chain_anchor.weekly';
  readonly ts_ms: number;
  readonly target_id: string | null;
  readonly actor_pseudonym: string;
  readonly target_class: string;
  readonly severity: 'info' | 'notice' | 'alert';
  readonly meta: Readonly<Record<string, unknown>>;
}

/**
 * Composed `audit.integrity_check.mismatch` row — built by the library and
 * passed through `emitIntegrityCheckRunAndMismatches`.
 */
export interface IntegrityCheckMismatchRow {
  readonly event_type: 'audit.integrity_check.mismatch';
  readonly ts_ms: number;
  readonly target_id: null;
  readonly actor_pseudonym: string;
  readonly target_class: 'C1';
  readonly severity: 'alert';
  readonly meta: IntegrityMismatchMeta;
}

/**
 * Composed `audit.integrity_check.ran` row — the LAST audit row written in
 * the integrity-check transaction (F-58 + F-88 summary-LAST).
 */
export interface IntegrityCheckRanAuditRow {
  readonly event_type: 'audit.integrity_check.ran';
  readonly ts_ms: number;
  readonly target_id: null;
  readonly actor_pseudonym: string;
  readonly target_class: 'C1';
  readonly severity: 'info';
  readonly meta: Readonly<Record<string, unknown>>;
}

/**
 * Composed `audit.chain_anchor.weekly` row — single emission per weekly
 * anchor pass (F-96).
 */
export interface ChainAnchorWeeklyAuditRow {
  readonly event_type: 'audit.chain_anchor.weekly';
  readonly ts_ms: number;
  readonly target_id: null;
  readonly actor_pseudonym: string;
  readonly target_class: 'C1';
  readonly severity: 'notice';
  readonly meta: {
    readonly anchor_at_ms: number;
    readonly head: {
      readonly id: string;
      readonly ts_ms: number;
      readonly hash: string;
    };
  };
}

/**
 * Args for the atomic emission of mismatch rows + ran row + run-row
 * terminal-state transition. The store implementation MUST:
 *   (i)   write each mismatch row BEFORE the ran row (F-24 / F-87);
 *   (ii)  write the ran row LAST in the transaction (F-58 / F-88);
 *   (iii) transition the run row to its terminal state atomically with both.
 * If any step throws, the library calls `restore(snapshotToken)`.
 */
export interface EmitIntegrityCheckRunAndMismatchesArgs {
  readonly run: IntegrityCheckRunRow;
  readonly mismatches: ReadonlyArray<IntegrityCheckMismatchRow>;
  readonly ran_row: IntegrityCheckRanAuditRow | null;
}

/**
 * Production interface — the closed-allowlist of methods the library calls.
 *
 * F-98: ZERO `__` properties. SupabaseIntegrityStore (T18.1) implements
 * this interface only; narrowing it back to TestIntegrityStore is a type
 * error.
 */
export interface IntegrityStore {
  /** F-66 mirror — monotonic ms-epoch clock. Strictly increasing across calls. */
  nowMs(): number;

  /** F-19/F-67 mirror — HMAC pseudonym for the SYSTEM actor (no PII path). */
  systemActorPseudonym(): string;

  /**
   * Read the live runtime pin (G-T11-23). The library compares this against
   * the manifest's recorded pin BEFORE any chain walk or backup-diff. A
   * divergence routes to `runtime_pin_mismatch` (F-93), not A-AUDIT-001.
   */
  readNodeRuntimePin(): IntegrityNodeRuntimePin;

  /**
   * Read the latest committed backup manifest (G-T17-RA2-ANCHOR-CONSUMER).
   * Returns null when no committed manifest exists (Phase-0 / cold-start —
   * backup-diff is skipped; chain-walk proceeds independently).
   *
   * On failure throws — the library translates to `head_read_failed`.
   */
  readLatestCommittedBackupManifest(): Promise<BackupManifestSnapshot | null>;

  /**
   * Id-ordered read of chain rows materialized for canonical-JSON recompute.
   *
   * `start_after_id === null` reads from the chain start; otherwise reads
   * the rows whose id > start_after_id. `max_rows` bounds the batch size
   * (memory-bounded; the library batches at `INTEGRITY_CHAIN_WALK_BATCH_SIZE`).
   *
   * No caller-supplied WHERE / predicate / pivot (F-97).
   * On failure throws — the library translates to `chain_walk_failed`.
   */
  readChainSegment(opts: {
    readonly start_after_id: string | null;
    readonly max_rows: number;
  }): Promise<ReadonlyArray<AuditChainRowMaterialized>>;

  /**
   * Read sweep_run rows for the Option G reconciliation join. Filters by
   * `started_at_ms <= snapshot_ts_ms`.
   */
  listRetentionSweepRunsThrough(
    snapshot_ts_ms: number
  ): Promise<ReadonlyArray<RetentionSweepRunSnapshot>>;

  /**
   * Read the highest-id chain row (the chain head). Used by the weekly
   * anchor pass. Returns null on an empty chain.
   * On failure throws — the library translates to `head_read_failed`.
   */
  readChainHead(): Promise<AuditChainRowMaterialized | null>;

  /**
   * F-59 mirror — lease window check. Returns true if a prior integrity
   * pass started within `lease_window_ms`.
   */
  hasOpenIntegrityRunWithinWindow(now_ms: number, lease_window_ms: number): Promise<boolean>;

  /**
   * F-72 state machine: write the run row in `status: 'running'` BEFORE
   * the chain walk begins. On failure throws — the library translates to
   * `run_start_failed`.
   */
  recordIntegrityRunStarted(run: {
    readonly run_id: string;
    readonly trigger: 'scheduled' | 'post_rotation' | 'post_export';
    readonly started_at_ms: number;
  }): Promise<void>;

  /**
   * F-58 + F-72 + F-87 + F-88: atomically transition the run row to its
   * terminal state, write all mismatch audit rows BEFORE the ran row, and
   * emit the `audit.integrity_check.ran` row LAST (omitted on errored runs).
   */
  emitIntegrityCheckRunAndMismatches(args: EmitIntegrityCheckRunAndMismatchesArgs): Promise<void>;

  /** Single-row emission for the weekly anchor (F-96). */
  emitChainAnchorWeekly(row: ChainAnchorWeeklyAuditRow): Promise<void>;

  /** F-58 rollback hooks (mirrors ADR-0017 §6 / ADR-0018 §5). */
  snapshot(): symbol;
  restore(token: symbol): void;
}
