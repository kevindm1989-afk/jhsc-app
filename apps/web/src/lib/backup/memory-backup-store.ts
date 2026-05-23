/**
 * In-memory implementation of BackupStore (T17; library-only per ADR-0002 H).
 *
 * Mirrors the SQL semantics SupabaseBackupStore will ship in T17.1:
 *   - `backup_manifests` is an append-only array; transitions mutate the row.
 *   - Stored objects are a Map keyed by `object_ref` carrying
 *     `(blob, unlocked_at_ms)` — the cooperative-caller defense lives here.
 *   - `audit_log` rows used for head-pointer + per-event histogram are stored
 *     in `auditChainRows` (insertion-ordered).
 *   - `audit_log` rows emitted by the library (`backup.manifest_written`,
 *     `backup.hard_deleted`) are stored separately in `emittedAuditRows`.
 *
 * Pseudonyms: HMAC-SHA-256 keyed by a per-store random key (mirrors
 * MemoryRetentionStore; the library does not depend on a specific key, only
 * on determinism within a store instance).
 *
 * Test-only override hooks (`__force*`, `__debug*`, `__set*`, `__insert*`,
 * `__advance*`) live on `TestBackupStore` which extends `BackupStore`; the
 * public barrel does NOT re-export `MemoryBackupStore` or `TestBackupStore`
 * (T11/T12 F-1 BLOCK lesson; mirrors T16's MemoryRetentionStore).
 *
 * Source: ADR-0018 §4/§5; threat-model §3.10 F-70..F-85.
 */

import { createHmac, randomBytes } from 'node:crypto';
import type {
  BackupDeleteResult,
  BackupDumpSnapshot,
  BackupManifestPendingInput,
  BackupManifestWrittenAuditRow,
  BackupPutResult,
  BackupStore,
  CommittedManifestSummary
} from './backup-store';
import type {
  BackupAuditLogHead,
  BackupNodeRuntimePin,
  BackupManifest,
  BackupManifestStatus
} from './types';
import { BACKUP_NOW_MS_MIN_INCREMENT } from './types';

/**
 * Pseudonym constant — opaque system actor id used in the
 * `backup.manifest_written` audit row's `actor_pseudonym` field. The HMAC
 * pseudonym derived from this id is what appears in the audit row; the bare
 * id never leaves the library.
 */
const SYSTEM_ACTOR_ID = 'system:backup-pass';

/** Default kid bootstrapped on construction. */
const DEFAULT_KID = 'default-kid-v1';

interface AuditChainRow {
  readonly id: string;
  readonly ts_ms: number;
  readonly hash: string;
  readonly event_type: string;
  readonly sequence: number;
}

interface EmittedAuditRow {
  readonly event_type: string;
  readonly ts_ms: number;
  readonly target_id: string | null;
  readonly actor_pseudonym: string;
  readonly meta: Record<string, unknown>;
}

interface StoredObject {
  readonly object_ref: string;
  readonly bytes: number;
  readonly unlocked_at_ms: number;
}

interface RecordedPutCall {
  readonly object_ref: string;
  readonly lock_until_ms: number;
  readonly sequence: number;
}

interface ManifestRow {
  run_id: string;
  status: BackupManifestStatus;
  started_at_ms: number;
  committed_at_ms: number | null;
  finalized_at_ms: number | null;
  hard_deleted_at_ms: number | null;
  object_ref: string;
  sha256: string;
  bytes: number;
  retention_class: '42d';
  lock_until_ms: number;
  committee_data_key_kid: string;
  audit_log_head: BackupAuditLogHead | null;
  per_table_row_counts: Record<string, number>;
  per_event_row_counts: Record<string, number>;
  retention_sweep_runs_snapshot_ts_ms: number;
  schedule_hash: string;
  node_runtime_pin: BackupNodeRuntimePin;
  insert_sequence: number;
}

/**
 * Test-only fixture input for `__insertManifestFixture`. Narrower than the
 * full BackupManifest — the store fills in canonical defaults so the test
 * can focus on the age + lock relationship that drives F-74/F-75 invariants.
 */
export interface BackupManifestFixtureInput {
  readonly run_id: string;
  readonly object_ref: string;
  readonly committed_at_ms: number;
  /** ms-epoch when the object's lock expires; controls F-71/F-75 refusal. */
  readonly unlocked_at_ms: number;
}

/**
 * Test-only audit-chain row input for `__debugInsertAuditChainRow`. The id
 * is treated as opaque (the F-76 head-pointer test injects custom ids like
 * `row-xyz`); the F-81 test injects a UUID canary value here too.
 */
export interface BackupAuditChainRowInput {
  readonly id: string;
  readonly ts_ms: number;
  readonly hash: string;
  readonly event_type: string;
}

/**
 * Test-only superset of the production `BackupStore`. Adds the seeding and
 * poisoning hooks the T17 test file consumes via deep import.
 *
 * F-85: SupabaseBackupStore (T17.1) implements `BackupStore` only — narrowing
 * it back to `TestBackupStore` is a type error.
 */
export interface TestBackupStore extends BackupStore {
  __forceUploadFailure(on: boolean): void;
  __forceManifestWriteFailure(on: boolean): void;
  __forceHeadPointerFailure(on: boolean): void;
  __forceKidLookupFailure(on: boolean): void;
  __forceDeleteFailure(on: boolean): void;
  __setCurrentKid(kid: string): void;
  __advanceObjectLockClock(ms: number): void;
  __insertManifestFixture(input: BackupManifestFixtureInput): void;
  __debugInsertAuditChainRow(row: BackupAuditChainRowInput): void;
  __debugListPutCalls(): readonly RecordedPutCall[];
  __debugListAuditRows(): readonly EmittedAuditRow[];
  __debugListObjects(): readonly StoredObject[];
  __debugListManifests(): readonly BackupManifest[];
  __debugManifestWriteSequence(): number;
  __debugSystemActorPseudonym(): string;
  __setDumpBlobOverride(blob: Uint8Array): void;
}

export class MemoryBackupStore implements TestBackupStore {
  private readonly hmacKey: Buffer;

  private manifests: ManifestRow[] = [];
  private objects = new Map<string, { blob: Uint8Array; unlocked_at_ms: number }>();
  private auditChainRows: AuditChainRow[] = [];
  private emittedAuditRows: EmittedAuditRow[] = [];
  private putCalls: RecordedPutCall[] = [];

  private currentKid: string = DEFAULT_KID;
  private dumpBlobOverride: Uint8Array | null = null;

  // Forced-failure flags.
  private forceUploadFailure = false;
  private forceManifestWriteFailure = false;
  private forceHeadPointerFailure = false;
  private forceKidLookupFailure = false;
  private forceDeleteFailure = false;

  // F-66 monotonic clock floor; mirrors MemoryRetentionStore.
  private lastIssuedNowMs = 0;

  // Insert-sequence counters — used for the F-72 happy-path ordering assertion
  // (the manifest pending-write MUST precede the upload).
  private nextSequence = 1;
  // Sequence-of-last-pending-write. Sequence 0 means no pending write yet.
  private lastPendingWriteSequence = 0;

  // Object-lock clock skew (test-only — __advanceObjectLockClock).
  private lockClockSkewMs = 0;

  constructor(hmacKey?: Buffer) {
    this.hmacKey = hmacKey ?? randomBytes(32);
  }

  // -------------------------------------------------------------------
  // Production surface (BackupStore)
  // -------------------------------------------------------------------

  nowMs(): number {
    const wall = Date.now();
    const next =
      wall > this.lastIssuedNowMs ? wall : this.lastIssuedNowMs + BACKUP_NOW_MS_MIN_INCREMENT;
    this.lastIssuedNowMs = next;
    return next;
  }

  systemActorPseudonym(): string {
    return createHmac('sha256', this.hmacKey).update(SYSTEM_ACTOR_ID).digest('hex').slice(0, 32);
  }

  async getCurrentKid(): Promise<string> {
    if (this.forceKidLookupFailure) {
      // Structured error; no PII in message (F-81).
      throw new Error('kid_lookup_failed');
    }
    return this.currentKid;
  }

  async extractAuditLogHead(): Promise<BackupAuditLogHead | null> {
    if (this.forceHeadPointerFailure) {
      throw new Error('head_pointer_failed');
    }
    if (this.auditChainRows.length === 0) return null;
    const head = this.auditChainRows[this.auditChainRows.length - 1]!;
    return { id: head.id, ts_ms: head.ts_ms, hash: head.hash };
  }

  async countAuditRowsByEventType(): Promise<Readonly<Record<string, number>>> {
    const counts: Record<string, number> = {};
    for (const r of this.auditChainRows) {
      counts[r.event_type] = (counts[r.event_type] ?? 0) + 1;
    }
    return counts;
  }

  async snapshotRetentionSweepRunsTs(): Promise<number> {
    // F-83 invariant: ALWAYS non-zero on a committed manifest. Library shim
    // returns nowMs(); production T17.1 reads `MAX(completed_at_ms)` from
    // the `retention_sweep_runs` table.
    return this.nowMs();
  }

  async dumpClosedAllowlist(): Promise<BackupDumpSnapshot> {
    const retentionTs = await this.snapshotRetentionSweepRunsTs();

    if (this.dumpBlobOverride !== null) {
      // F-78 hash-determinism harness: return the fixed override blob so the
      // sha256 pin is reproducible.
      return {
        blob: this.dumpBlobOverride,
        per_table_row_counts: {},
        per_event_row_counts: await this.countAuditRowsByEventType(),
        retention_sweep_runs_snapshot_ts_ms: retentionTs
      };
    }

    // Canonical default dump: tiny placeholder bytes; the library does not
    // assume any specific content shape. The per-event histogram is computed
    // from the seeded audit chain rows (G-T16-RECONCILE-CEILING: per-event,
    // never aggregated).
    return {
      blob: new Uint8Array([0]),
      per_table_row_counts: {},
      per_event_row_counts: await this.countAuditRowsByEventType(),
      retention_sweep_runs_snapshot_ts_ms: retentionTs
    };
  }

  async writeManifestPending(input: BackupManifestPendingInput): Promise<void> {
    if (this.forceManifestWriteFailure) {
      throw new Error('manifest_write_failed');
    }
    const seq = this.nextSequence++;
    this.lastPendingWriteSequence = seq;
    const row: ManifestRow = {
      run_id: input.run_id,
      status: 'pending',
      started_at_ms: input.started_at_ms,
      committed_at_ms: null,
      finalized_at_ms: null,
      hard_deleted_at_ms: null,
      object_ref: input.object_ref,
      sha256: input.sha256,
      bytes: input.bytes,
      retention_class: '42d',
      lock_until_ms: input.lock_until_ms,
      committee_data_key_kid: input.committee_data_key_kid,
      audit_log_head: input.audit_log_head,
      per_table_row_counts: { ...input.per_table_row_counts },
      per_event_row_counts: { ...input.per_event_row_counts },
      retention_sweep_runs_snapshot_ts_ms: input.retention_sweep_runs_snapshot_ts_ms,
      schedule_hash: input.schedule_hash,
      node_runtime_pin: { ...input.node_runtime_pin },
      insert_sequence: seq
    };
    this.manifests.push(row);
  }

  async transitionManifestStatus(
    run_id: string,
    to_status: BackupManifestStatus,
    finalized_at_ms: number
  ): Promise<void> {
    const row = this.manifests.find((m) => m.run_id === run_id);
    if (!row) return;
    if (to_status === 'committed') {
      row.committed_at_ms = finalized_at_ms;
    }
    if (to_status === 'hard_deleted') {
      row.hard_deleted_at_ms = finalized_at_ms;
    }
    row.finalized_at_ms = finalized_at_ms;
    row.status = to_status;
  }

  async putWithObjectLock(
    object_ref: string,
    blob: Uint8Array,
    lock_until_ms: number
  ): Promise<BackupPutResult> {
    const seq = this.nextSequence++;
    this.putCalls.push({ object_ref, lock_until_ms, sequence: seq });

    if (this.forceUploadFailure) {
      // Structured rejection (G-T11-29); no throw on upload failure.
      return { committed: false, reason: 'unknown_storage_error' };
    }

    this.objects.set(object_ref, {
      blob: new Uint8Array(blob),
      unlocked_at_ms: lock_until_ms
    });
    return { committed: true };
  }

  async isObjectLocked(object_ref: string): Promise<boolean> {
    const obj = this.objects.get(object_ref);
    if (!obj) return false;
    return obj.unlocked_at_ms > this.effectiveLockNowMs();
  }

  async deleteObjectIfUnlocked(object_ref: string): Promise<BackupDeleteResult> {
    if (this.forceDeleteFailure) {
      // Structured rejection; no PII in reason (F-81).
      return { deleted: false, reason: 'unknown_storage_error' };
    }
    const obj = this.objects.get(object_ref);
    if (!obj) {
      return { deleted: false, reason: 'not_found' };
    }
    if (obj.unlocked_at_ms > this.effectiveLockNowMs()) {
      return { deleted: false, reason: 'still_locked' };
    }
    this.objects.delete(object_ref);
    return { deleted: true };
  }

  async listCommittedManifests(): Promise<readonly CommittedManifestSummary[]> {
    return this.manifests
      .filter((m) => m.status === 'committed' && m.committed_at_ms !== null)
      .map((m) => ({
        run_id: m.run_id,
        object_ref: m.object_ref,
        committed_at_ms: m.committed_at_ms as number
      }));
  }

  async hardDeleteManifestRow(run_id: string, hard_deleted_at_ms: number): Promise<void> {
    const row = this.manifests.find((m) => m.run_id === run_id);
    if (!row) return;
    row.status = 'hard_deleted';
    row.hard_deleted_at_ms = hard_deleted_at_ms;
  }

  async emitBackupManifestWritten(row: BackupManifestWrittenAuditRow): Promise<void> {
    this.emittedAuditRows.push({
      event_type: row.event_type,
      ts_ms: row.ts_ms,
      target_id: row.target_id,
      actor_pseudonym: row.actor_pseudonym,
      meta: { ...row.meta }
    });
  }

  async hasOpenBackupRunWithinWindow(now_ms: number, lease_window_ms: number): Promise<boolean> {
    for (const m of this.manifests) {
      if (m.status === 'hard_deleted') continue;
      if (now_ms - m.started_at_ms < lease_window_ms) return true;
    }
    return false;
  }

  async readManifest(run_id: string): Promise<BackupManifest | null> {
    const row = this.manifests.find((m) => m.run_id === run_id);
    return row ? this.toBackupManifest(row) : null;
  }

  // -------------------------------------------------------------------
  // Test surface (TestBackupStore) — never re-exported via the barrel.
  // -------------------------------------------------------------------

  __forceUploadFailure(on: boolean): void {
    this.forceUploadFailure = on;
  }

  __forceManifestWriteFailure(on: boolean): void {
    this.forceManifestWriteFailure = on;
  }

  __forceHeadPointerFailure(on: boolean): void {
    this.forceHeadPointerFailure = on;
  }

  __forceKidLookupFailure(on: boolean): void {
    this.forceKidLookupFailure = on;
  }

  __forceDeleteFailure(on: boolean): void {
    this.forceDeleteFailure = on;
  }

  __setCurrentKid(kid: string): void {
    this.currentKid = kid;
  }

  __advanceObjectLockClock(ms: number): void {
    this.lockClockSkewMs += ms;
  }

  __insertManifestFixture(input: BackupManifestFixtureInput): void {
    const seq = this.nextSequence++;
    const lockUntilMs = input.unlocked_at_ms;
    const row: ManifestRow = {
      run_id: input.run_id,
      status: 'committed',
      started_at_ms: input.committed_at_ms,
      committed_at_ms: input.committed_at_ms,
      finalized_at_ms: input.committed_at_ms,
      hard_deleted_at_ms: null,
      object_ref: input.object_ref,
      sha256: '',
      bytes: 0,
      retention_class: '42d',
      lock_until_ms: lockUntilMs,
      committee_data_key_kid: this.currentKid,
      audit_log_head: null,
      per_table_row_counts: {},
      per_event_row_counts: {},
      retention_sweep_runs_snapshot_ts_ms: input.committed_at_ms,
      schedule_hash: '',
      node_runtime_pin: { node_version: '', openssl_version: '' },
      insert_sequence: seq
    };
    this.manifests.push(row);
    // Pre-populate the underlying object so the retention pass's
    // deleteObjectIfUnlocked finds it.
    this.objects.set(input.object_ref, {
      blob: new Uint8Array([0]),
      unlocked_at_ms: lockUntilMs
    });
  }

  __debugInsertAuditChainRow(row: BackupAuditChainRowInput): void {
    const seq = this.nextSequence++;
    this.auditChainRows.push({
      id: row.id,
      ts_ms: row.ts_ms,
      hash: row.hash,
      event_type: row.event_type,
      sequence: seq
    });
  }

  __debugListPutCalls(): readonly RecordedPutCall[] {
    return this.putCalls.slice();
  }

  __debugListAuditRows(): readonly EmittedAuditRow[] {
    return this.emittedAuditRows.map((r) => ({
      event_type: r.event_type,
      ts_ms: r.ts_ms,
      target_id: r.target_id,
      actor_pseudonym: r.actor_pseudonym,
      meta: { ...r.meta }
    }));
  }

  __debugListObjects(): readonly StoredObject[] {
    const out: StoredObject[] = [];
    for (const [object_ref, obj] of this.objects.entries()) {
      out.push({
        object_ref,
        bytes: obj.blob.byteLength,
        unlocked_at_ms: obj.unlocked_at_ms
      });
    }
    return out;
  }

  __debugListManifests(): readonly BackupManifest[] {
    // Insertion-ordered (the algorithm tests rely on this).
    return this.manifests
      .slice()
      .sort((a, b) => a.insert_sequence - b.insert_sequence)
      .map((m) => this.toBackupManifest(m));
  }

  __debugManifestWriteSequence(): number {
    return this.lastPendingWriteSequence;
  }

  __debugSystemActorPseudonym(): string {
    return this.systemActorPseudonym();
  }

  __setDumpBlobOverride(blob: Uint8Array): void {
    this.dumpBlobOverride = new Uint8Array(blob);
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  private effectiveLockNowMs(): number {
    return Date.now() + this.lockClockSkewMs;
  }

  private toBackupManifest(row: ManifestRow): BackupManifest {
    return {
      run_id: row.run_id,
      status: row.status,
      started_at_ms: row.started_at_ms,
      committed_at_ms: row.committed_at_ms,
      finalized_at_ms: row.finalized_at_ms,
      hard_deleted_at_ms: row.hard_deleted_at_ms,
      object_ref: row.object_ref,
      sha256: row.sha256,
      bytes: row.bytes,
      retention_class: row.retention_class,
      lock_until_ms: row.lock_until_ms,
      committee_data_key_kid: row.committee_data_key_kid,
      audit_log_head: row.audit_log_head,
      per_table_row_counts: { ...row.per_table_row_counts },
      per_event_row_counts: { ...row.per_event_row_counts },
      retention_sweep_runs_snapshot_ts_ms: row.retention_sweep_runs_snapshot_ts_ms,
      schedule_hash: row.schedule_hash,
      node_runtime_pin: { ...row.node_runtime_pin }
    };
  }
}
