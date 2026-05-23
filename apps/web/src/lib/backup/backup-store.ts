/**
 * BackupStore interface (T17; F-85 production half).
 *
 * Closed-allowlist surface. ZERO `__` properties — the test mutators live
 * exclusively on `TestBackupStore` (which extends this) in
 * `./memory-backup-store.ts`.
 *
 * Pattern lineage: G-T11-21 / G-T13-15 / G-T14-17 / G-T16-PRIV-1. The test
 * surface is strictly additive over the production surface so production
 * callers cannot reach the seeding hooks even via a structural cast.
 *
 * F-84 defense-in-depth: no method here accepts a caller-supplied predicate,
 * WHERE-fragment, table-name string, or lock duration. The library hard-codes
 * the closed allowlist from `BACKUP_TABLES` and the lock window from
 * `BACKUP_OBJECT_LOCK_DAYS`.
 */

import type { BackupAuditLogHead, BackupManifest, BackupManifestStatus } from './types';

/**
 * Structured upload-rejection reason vocabulary (F-82). Closed literal union;
 * a random string assignment fails tsc.
 */
export type BackupUploadRejectionReason =
  | 'object_lock_policy_rejected'
  | 'cross_region_destination_refused'
  | 'unknown_storage_error';

/**
 * `putWithObjectLock` result discriminated union. The library NEVER returns
 * `{committed: true}` for an upload that did not receive an ACK (G-T11-29).
 */
export type BackupPutResult =
  | { readonly committed: true }
  | { readonly committed: false; readonly reason: BackupUploadRejectionReason };

/**
 * `deleteObjectIfUnlocked` result. `still_locked` is the cooperative-caller
 * defense (F-71); never thrown, always returned as a structured reason.
 */
export type BackupDeleteResult =
  | { readonly deleted: true }
  | { readonly deleted: false; readonly reason: 'still_locked' | 'not_found' | 'unknown_storage_error' };

/**
 * Committed-manifest summary returned by `listCommittedManifests`.
 * Subset of the manifest shape — the retention pass only needs run_id,
 * object_ref, committed_at_ms to make the age-out decision.
 */
export interface CommittedManifestSummary {
  readonly run_id: string;
  readonly object_ref: string;
  readonly committed_at_ms: number;
}

/**
 * Snapshot of the closed-allowlist dump bytes + per-event/per-table counts +
 * the retention_sweep_runs observation timestamp (G-T16-RECONCILE-CEILING:
 * per-event attribution is NEVER aggregated to a `__ceiling__` key).
 */
export interface BackupDumpSnapshot {
  readonly blob: Uint8Array;
  readonly per_table_row_counts: Readonly<Record<string, number>>;
  readonly per_event_row_counts: Readonly<Record<string, number>>;
  readonly retention_sweep_runs_snapshot_ts_ms: number;
}

/**
 * Pending manifest write input — every field the library composes BEFORE the
 * upload (F-72 audit-anchor-before-side-effect inversion).
 */
export interface BackupManifestPendingInput {
  readonly run_id: string;
  readonly started_at_ms: number;
  readonly object_ref: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly lock_until_ms: number;
  readonly committee_data_key_kid: string;
  readonly audit_log_head: BackupAuditLogHead | null;
  readonly per_table_row_counts: Readonly<Record<string, number>>;
  readonly per_event_row_counts: Readonly<Record<string, number>>;
  readonly retention_sweep_runs_snapshot_ts_ms: number;
}

/**
 * `backup.manifest_written` audit row input — composed by the library AFTER
 * the upload + manifest transition committed (F-72 step 10).
 *
 * G-T16-PRIV-1: actor_pseudonym at TOP LEVEL only; never duplicated into meta.
 */
export interface BackupManifestWrittenAuditRow {
  readonly event_type: 'backup.manifest_written';
  readonly ts_ms: number;
  readonly target_id: string | null;
  readonly actor_pseudonym: string;
  readonly meta: Readonly<Record<string, unknown>>;
}

/**
 * Production interface — the closed-allowlist of methods the library calls.
 *
 * F-85: ZERO `__` properties. SupabaseBackupStore (T17.1) implements this
 * interface only; narrowing it back to TestBackupStore is a type error.
 */
export interface BackupStore {
  /** F-66 mirror — monotonic ms-epoch clock. Strictly increasing across calls. */
  nowMs(): number;

  /** F-19/F-67 mirror — HMAC pseudonym for the SYSTEM actor (no PII path). */
  systemActorPseudonym(): string;

  /**
   * Read the kid of the currently-active `committee_data_key` (ADR-0007).
   * On failure throws — the library translates to the structured error_code
   * `kid_lookup_failed`.
   */
  getCurrentKid(): Promise<string>;

  /**
   * Extract the head pointer of the audit chain (highest id; F-76 +
   * RA-2 follow-up anchor). Returns null on an empty chain.
   * On failure throws — the library translates to `head_pointer_failed`.
   */
  extractAuditLogHead(): Promise<BackupAuditLogHead | null>;

  /**
   * Per-event-type histogram of the audit_log at dump time (F-77;
   * G-T16-RECONCILE-CEILING — never aggregated to a synthetic key).
   */
  countAuditRowsByEventType(): Promise<Readonly<Record<string, number>>>;

  /**
   * Snapshot the retention_sweep_runs observation timestamp (F-83 join
   * anchor; ALWAYS non-zero on a committed manifest).
   */
  snapshotRetentionSweepRunsTs(): Promise<number>;

  /**
   * Dump the closed `BACKUP_TABLES` allowlist as a single blob + per-table /
   * per-event row counts. The store hard-codes the table list from
   * `BACKUP_TABLES`; the library does NOT accept a caller-supplied list.
   */
  dumpClosedAllowlist(): Promise<BackupDumpSnapshot>;

  /**
   * F-72: write the manifest in `pending` status BEFORE the upload. On
   * failure throws — the library translates to `manifest_write_failed`.
   */
  writeManifestPending(input: BackupManifestPendingInput): Promise<void>;

  /**
   * F-72 state-machine transition. The library calls this with `committed`
   * on upload ACK, or `aborted_*` on upload failure.
   */
  transitionManifestStatus(
    run_id: string,
    to_status: BackupManifestStatus,
    finalized_at_ms: number
  ): Promise<void>;

  /**
   * Upload the encrypted blob to the object-lock bucket. The library computes
   * `lock_until_ms = nowMs + BACKUP_OBJECT_LOCK_DAYS * MS_PER_DAY` and passes
   * it; the store enforces (the cooperative-caller defense, F-71).
   *
   * Structured rejection per F-82: never throws on upload failure; always
   * returns `{committed: false, reason}`. The library narrows the reason
   * into the `error_code` literal union.
   */
  putWithObjectLock(
    object_ref: string,
    blob: Uint8Array,
    lock_until_ms: number
  ): Promise<BackupPutResult>;

  /**
   * F-71 cooperative-caller defense. Returns true iff the lock has not yet
   * expired for the named object.
   */
  isObjectLocked(object_ref: string): Promise<boolean>;

  /**
   * F-71 + F-75 cooperative-caller defense. Returns `{deleted: false,
   * reason: 'still_locked'}` for objects whose `unlocked_at_ms > nowMs()`
   * regardless of caller intent. Never throws on lock refusal.
   */
  deleteObjectIfUnlocked(object_ref: string): Promise<BackupDeleteResult>;

  /**
   * F-74 retention pass driver. Lists every manifest currently in
   * `committed` status — the retention pass age-checks each against
   * `BACKUP_HARD_DELETE_DAYS`.
   */
  listCommittedManifests(): Promise<readonly CommittedManifestSummary[]>;

  /**
   * F-74 hard-delete of the manifest row itself. Called only AFTER
   * `deleteObjectIfUnlocked` returns `{deleted: true}`.
   */
  hardDeleteManifestRow(run_id: string, hard_deleted_at_ms: number): Promise<void>;

  /**
   * Emit the `backup.manifest_written` audit row AS THE LAST step of a
   * committed pass (F-72 step 10; mirrors ADR-0017 §6 step 9).
   */
  emitBackupManifestWritten(row: BackupManifestWrittenAuditRow): Promise<void>;

  /**
   * F-59 mirror — lease window check. Returns true if a prior pass started
   * within `lease_window_ms`.
   */
  hasOpenBackupRunWithinWindow(now_ms: number, lease_window_ms: number): Promise<boolean>;

  /**
   * Read a manifest row by run_id. Used by the retention pass to confirm
   * the manifest exists before transitioning it to `hard_deleted`.
   */
  readManifest(run_id: string): Promise<BackupManifest | null>;
}
