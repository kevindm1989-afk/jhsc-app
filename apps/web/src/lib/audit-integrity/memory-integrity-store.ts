/**
 * In-memory implementation of IntegrityStore (T18; library-only per ADR-0002 H).
 *
 * Mirrors the SQL semantics SupabaseIntegrityStore will ship in T18.1:
 *   - `audit_log` chain rows are stored in `auditChainRows` (insertion-ordered).
 *     Each row carries a `canonical_hash` snapshot — the immutable expected
 *     hash recorded at insert time. The mutable `hash` is the LIVE stored
 *     hash (mirrors what an A5/A2 attacker would mutate); the integrity
 *     library compares the two to detect chain-walk mismatch.
 *   - `backup_manifests` is an append-only array; `readLatestCommittedBackupManifest`
 *     returns the most-recently-committed by `committed_at_ms`. Inserting
 *     a manifest fixture snapshots the current chain rows into the
 *     manifest's `audit_log_rows_in_dump` (ADR-0019 §5 step 8 MVP note).
 *   - `retention_sweep_runs` is an append-only array.
 *   - `integrity_check_runs` rows are written by `recordIntegrityRunStarted`
 *     + transitioned by `emitIntegrityCheckRunAndMismatches`.
 *   - Emitted audit rows live in `emittedAuditRows`; the ordering preserves
 *     the F-87 / F-88 mismatch-before-ran invariant.
 *
 * Pseudonyms: HMAC-SHA-256 keyed by a per-store random key (production
 * stores derive from the AuthStore key per ADR-0016).
 *
 * Test-only override hooks (`__debug*`, `__force*`, `__set*`) live on
 * `TestIntegrityStore` which extends `IntegrityStore`; the public barrel
 * does NOT re-export `MemoryIntegrityStore` or `TestIntegrityStore`
 * (T11/T12 F-1 BLOCK lesson; mirrors T16/T17).
 *
 * Source: ADR-0019 §3/§4/§5; threat-model §3.11 F-86..F-100.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  INTEGRITY_GENESIS_PREV_HASH,
  INTEGRITY_NOW_MS_MIN_INCREMENT,
  type AuditChainRowMaterialized,
  type BackupManifestSnapshot,
  type IntegrityNodeRuntimePin,
  type RetentionSweepRunSnapshot
} from './types';
import type {
  ChainAnchorWeeklyAuditRow,
  EmitIntegrityCheckRunAndMismatchesArgs,
  IntegrityStore
} from './integrity-store';

/**
 * Pseudonym constant — opaque system actor id used in every audit row this
 * library emits. The HMAC derived from this id is what appears in the
 * `actor_pseudonym` field; the bare id never leaves the library.
 */
const SYSTEM_ACTOR_ID = 'system:integrity-check';

/**
 * Canonical-JSON sort-key recompute over the structural row fields. Sorts
 * object keys lexicographically so the output is deterministic regardless
 * of insertion order. SHA-256 stands in for BLAKE2b-256 on the in-memory
 * mirror — the production T18.1 store reads the SQL trigger's BLAKE2b-256
 * output. The library never depends on the specific hash function; it
 * depends on round-trip determinism through the store.
 */
function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJSON(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return (
      '{' +
      keys
        .map((k) => JSON.stringify(k) + ':' + canonicalJSON((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  }
  return 'null';
}

function computeCanonicalHash(fields: {
  readonly id: string;
  readonly ts_ms: number;
  readonly actor_pseudonym: string;
  readonly event_type: string;
  readonly target_id: string | null;
  readonly target_class: string;
  readonly severity: string;
  readonly request_id: string | null;
  readonly rotation_id: string | null;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly prev_hash: string;
}): string {
  const serialized = canonicalJSON(fields);
  return createHash('sha256').update(serialized).digest('hex');
}

interface ChainRowInternal {
  id: string;
  ts_ms: number;
  actor_pseudonym: string;
  event_type: string;
  target_id: string | null;
  target_class: string;
  severity: string;
  request_id: string | null;
  rotation_id: string | null;
  meta: Record<string, unknown>;
  prev_hash: string;
  /** Live stored hash — mutable via __debugCorruptRowHash. */
  hash: string;
  /** Immutable canonical hash recorded at insert time (recompute snapshot). */
  canonical_hash: string;
  /** Insertion sequence for stable ordering. */
  sequence: number;
}

interface IntegrityRunInternal {
  run_id: string;
  trigger: 'scheduled' | 'post_rotation' | 'post_export';
  started_at_ms: number;
  completed_at_ms: number | null;
  status: 'running' | 'completed' | 'capped' | 'errored';
  rows_walked: number;
  mismatches_count: number;
  attributable_count: number;
  unattributable_count: number;
  backup_diff_performed: boolean;
  backup_manifest_run_id: string | null;
  resume_after_id: string | null;
  node_runtime_pin: IntegrityNodeRuntimePin;
  schedule_hash: string | null;
}

interface EmittedAuditRowInternal {
  event_type: string;
  ts_ms: number;
  target_id: string | null;
  actor_pseudonym: string;
  target_class: string;
  severity: string;
  meta: Record<string, unknown>;
  sequence: number;
}

interface ChainRowInputSeed {
  readonly id: string;
  readonly ts_ms: number;
  readonly hash: string;
  readonly event_type: string;
  readonly prev_hash: string;
  readonly actor_pseudonym: string;
  readonly target_id: string | null;
  readonly target_class: string;
  readonly severity: string;
  readonly request_id: string | null;
  readonly rotation_id: string | null;
  readonly meta: Readonly<Record<string, unknown>>;
}

interface BackupManifestFixtureSeed {
  readonly run_id: string;
  readonly committed_at_ms: number;
  readonly audit_log_head: {
    readonly id: string;
    readonly ts_ms: number;
    readonly hash: string;
  } | null;
  readonly per_event_row_counts: Readonly<Record<string, number>>;
  readonly retention_sweep_runs_snapshot_ts_ms: number;
  readonly schedule_hash: string;
  readonly node_runtime_pin: IntegrityNodeRuntimePin;
}

interface SweepRunFixtureSeed {
  readonly run_id: string;
  readonly started_at_ms: number;
  readonly completed_at_ms: number;
  readonly per_event_counts: Readonly<Record<string, number>>;
  readonly status: 'completed' | 'capped';
}

interface BackupManifestInternal {
  run_id: string;
  committed_at_ms: number;
  audit_log_head: {
    id: string;
    ts_ms: number;
    hash: string;
  } | null;
  per_event_row_counts: Record<string, number>;
  retention_sweep_runs_snapshot_ts_ms: number;
  schedule_hash: string;
  node_runtime_pin: IntegrityNodeRuntimePin;
  audit_log_rows_in_dump: Array<{
    id: string;
    ts_ms: number;
    hash: string;
    prev_hash: string;
    event_type: string;
  }>;
  insert_sequence: number;
}

interface SnapshotPayload {
  auditChainRows: ChainRowInternal[];
  integrityRuns: IntegrityRunInternal[];
  emittedAuditRows: EmittedAuditRowInternal[];
}

/**
 * Test-only superset of the production `IntegrityStore`. Adds the seeding
 * and poisoning hooks the T18 test files consume via deep import.
 *
 * F-98: SupabaseIntegrityStore (T18.1) implements `IntegrityStore` only —
 * narrowing it back to `TestIntegrityStore` is a type error.
 */
export interface TestIntegrityStore extends IntegrityStore {
  __debugCorruptRowHash(id: string, new_hash: string): void;
  __debugInsertChainRow(row: ChainRowInputSeed): void;
  __debugInsertBackupManifestFixture(input: BackupManifestFixtureSeed): void;
  __debugInsertSweepRunFixture(run: SweepRunFixtureSeed): void;
  __debugDeleteRowAtId(id: string): void;
  __forceSummaryEmitFailure(on: boolean): void;
  __forceChainWalkException(on: boolean): void;
  __setLiveRuntimePin(pin: IntegrityNodeRuntimePin): void;
  __debugListRuns(): ReadonlyArray<{
    readonly run_id: string;
    readonly status: 'running' | 'completed' | 'capped' | 'errored';
  }>;
  __debugListAuditRows(): ReadonlyArray<{
    readonly event_type: string;
    readonly ts_ms: number;
    readonly target_id: string | null;
    readonly actor_pseudonym: string;
    readonly meta: Record<string, unknown>;
  }>;
}

export class MemoryIntegrityStore implements TestIntegrityStore {
  private readonly hmacKey: Buffer;

  private auditChainRows: ChainRowInternal[] = [];
  private backupManifests: BackupManifestInternal[] = [];
  private retentionSweepRuns: SweepRunFixtureSeed[] = [];
  private integrityRuns: IntegrityRunInternal[] = [];
  private emittedAuditRows: EmittedAuditRowInternal[] = [];

  private lastIssuedNowMs = 0;
  private nextSequence = 1;

  private liveRuntimePin: IntegrityNodeRuntimePin = {
    node_version: process.versions.node ?? '',
    openssl_version: process.versions.openssl ?? ''
  };

  private forceSummaryEmitFailure = false;
  private forceChainWalkException = false;

  /** Snapshot registry keyed by symbol — F-58 rollback (mirrors T16). */
  private snapshots = new Map<symbol, SnapshotPayload>();

  constructor(hmacKey?: Buffer) {
    this.hmacKey = hmacKey ?? randomBytes(32);
  }

  // -------------------------------------------------------------------
  // Production surface (IntegrityStore)
  // -------------------------------------------------------------------

  nowMs(): number {
    const wall = Date.now();
    const next =
      wall > this.lastIssuedNowMs ? wall : this.lastIssuedNowMs + INTEGRITY_NOW_MS_MIN_INCREMENT;
    this.lastIssuedNowMs = next;
    return next;
  }

  systemActorPseudonym(): string {
    return createHmac('sha256', this.hmacKey).update(SYSTEM_ACTOR_ID).digest('hex').slice(0, 32);
  }

  readNodeRuntimePin(): IntegrityNodeRuntimePin {
    return { ...this.liveRuntimePin };
  }

  async readLatestCommittedBackupManifest(): Promise<BackupManifestSnapshot | null> {
    if (this.backupManifests.length === 0) return null;
    // Most-recently-committed by committed_at_ms; ties broken by insert order.
    const sorted = this.backupManifests
      .slice()
      .sort((a, b) =>
        b.committed_at_ms - a.committed_at_ms !== 0
          ? b.committed_at_ms - a.committed_at_ms
          : b.insert_sequence - a.insert_sequence
      );
    const latest = sorted[0]!;
    return this.toBackupManifestSnapshot(latest);
  }

  async readChainSegment(opts: {
    readonly start_after_id: string | null;
    readonly max_rows: number;
  }): Promise<ReadonlyArray<AuditChainRowMaterialized>> {
    if (this.forceChainWalkException) {
      throw new Error('chain_walk_failed');
    }
    const ordered = this.auditChainRows.slice().sort((a, b) => compareIds(a.id, b.id));
    let startedAt = 0;
    if (opts.start_after_id !== null) {
      const idx = ordered.findIndex((r) => compareIds(r.id, opts.start_after_id as string) > 0);
      startedAt = idx === -1 ? ordered.length : idx;
    }
    const slice = ordered.slice(startedAt, startedAt + Math.max(0, opts.max_rows));
    return slice.map((r) => this.toMaterialized(r));
  }

  async listRetentionSweepRunsThrough(
    snapshot_ts_ms: number
  ): Promise<ReadonlyArray<RetentionSweepRunSnapshot>> {
    return this.retentionSweepRuns
      .filter((r) => r.started_at_ms <= snapshot_ts_ms)
      .map((r) => ({
        run_id: r.run_id,
        started_at_ms: r.started_at_ms,
        completed_at_ms: r.completed_at_ms,
        per_event_counts: { ...r.per_event_counts },
        status: r.status
      }));
  }

  async readChainHead(): Promise<AuditChainRowMaterialized | null> {
    if (this.forceChainWalkException) {
      throw new Error('head_read_failed');
    }
    if (this.auditChainRows.length === 0) return null;
    const sorted = this.auditChainRows.slice().sort((a, b) => compareIds(b.id, a.id));
    return this.toMaterialized(sorted[0]!);
  }

  async hasOpenIntegrityRunWithinWindow(
    now_ms: number,
    lease_window_ms: number
  ): Promise<boolean> {
    for (const r of this.integrityRuns) {
      if (r.status !== 'running') continue;
      if (now_ms - r.started_at_ms < lease_window_ms) return true;
    }
    return false;
  }

  async recordIntegrityRunStarted(run: {
    readonly run_id: string;
    readonly trigger: 'scheduled' | 'post_rotation' | 'post_export';
    readonly started_at_ms: number;
  }): Promise<void> {
    this.integrityRuns.push({
      run_id: run.run_id,
      trigger: run.trigger,
      started_at_ms: run.started_at_ms,
      completed_at_ms: null,
      status: 'running',
      rows_walked: 0,
      mismatches_count: 0,
      attributable_count: 0,
      unattributable_count: 0,
      backup_diff_performed: false,
      backup_manifest_run_id: null,
      resume_after_id: null,
      node_runtime_pin: this.readNodeRuntimePin(),
      schedule_hash: null
    });
  }

  async emitIntegrityCheckRunAndMismatches(
    args: EmitIntegrityCheckRunAndMismatchesArgs
  ): Promise<void> {
    // Step (i) + (ii): write mismatch rows FIRST, ran row LAST.
    for (const m of args.mismatches) {
      this.appendEmittedRow({
        event_type: m.event_type,
        ts_ms: m.ts_ms,
        target_id: m.target_id,
        actor_pseudonym: m.actor_pseudonym,
        target_class: m.target_class,
        severity: m.severity,
        meta: { ...m.meta } as Record<string, unknown>
      });
    }
    if (args.ran_row !== null) {
      if (this.forceSummaryEmitFailure) {
        throw new Error('audit_emit_failed');
      }
      this.appendEmittedRow({
        event_type: args.ran_row.event_type,
        ts_ms: args.ran_row.ts_ms,
        target_id: args.ran_row.target_id,
        actor_pseudonym: args.ran_row.actor_pseudonym,
        target_class: args.ran_row.target_class,
        severity: args.ran_row.severity,
        meta: { ...args.ran_row.meta }
      });
    }
    // Step (iii): atomic terminal-state transition on the run row.
    const idx = this.integrityRuns.findIndex((r) => r.run_id === args.run.run_id);
    if (idx === -1) {
      this.integrityRuns.push({
        run_id: args.run.run_id,
        trigger: args.run.trigger,
        started_at_ms: args.run.started_at_ms,
        completed_at_ms: args.run.completed_at_ms,
        status: args.run.status,
        rows_walked: args.run.rows_walked,
        mismatches_count: args.run.mismatches_count,
        attributable_count: args.run.attributable_count,
        unattributable_count: args.run.unattributable_count,
        backup_diff_performed: args.run.backup_diff_performed,
        backup_manifest_run_id: args.run.backup_manifest_run_id,
        resume_after_id: args.run.resume_after_id,
        node_runtime_pin: { ...args.run.node_runtime_pin },
        schedule_hash: args.run.schedule_hash
      });
    } else {
      const existing = this.integrityRuns[idx]!;
      existing.completed_at_ms = args.run.completed_at_ms;
      existing.status = args.run.status;
      existing.rows_walked = args.run.rows_walked;
      existing.mismatches_count = args.run.mismatches_count;
      existing.attributable_count = args.run.attributable_count;
      existing.unattributable_count = args.run.unattributable_count;
      existing.backup_diff_performed = args.run.backup_diff_performed;
      existing.backup_manifest_run_id = args.run.backup_manifest_run_id;
      existing.resume_after_id = args.run.resume_after_id;
      existing.node_runtime_pin = { ...args.run.node_runtime_pin };
      existing.schedule_hash = args.run.schedule_hash;
    }
  }

  async emitChainAnchorWeekly(row: ChainAnchorWeeklyAuditRow): Promise<void> {
    this.appendEmittedRow({
      event_type: row.event_type,
      ts_ms: row.ts_ms,
      target_id: row.target_id,
      actor_pseudonym: row.actor_pseudonym,
      target_class: row.target_class,
      severity: row.severity,
      meta: {
        anchor_at_ms: row.meta.anchor_at_ms,
        head: { ...row.meta.head }
      }
    });
  }

  snapshot(): symbol {
    const token = Symbol('integrity-snapshot');
    this.snapshots.set(token, {
      auditChainRows: this.auditChainRows.map((r) => ({ ...r, meta: { ...r.meta } })),
      integrityRuns: this.integrityRuns.map((r) => ({
        ...r,
        node_runtime_pin: { ...r.node_runtime_pin }
      })),
      emittedAuditRows: this.emittedAuditRows.map((r) => ({ ...r, meta: { ...r.meta } }))
    });
    return token;
  }

  restore(token: symbol): void {
    const payload = this.snapshots.get(token);
    if (payload === undefined) return;
    this.auditChainRows = payload.auditChainRows.map((r) => ({ ...r, meta: { ...r.meta } }));
    this.integrityRuns = payload.integrityRuns.map((r) => ({
      ...r,
      node_runtime_pin: { ...r.node_runtime_pin }
    }));
    this.emittedAuditRows = payload.emittedAuditRows.map((r) => ({
      ...r,
      meta: { ...r.meta }
    }));
    this.snapshots.delete(token);
  }

  // -------------------------------------------------------------------
  // Test surface (TestIntegrityStore) — never re-exported via the barrel.
  // -------------------------------------------------------------------

  __debugCorruptRowHash(id: string, new_hash: string): void {
    const r = this.auditChainRows.find((x) => x.id === id);
    if (r === undefined) return;
    r.hash = new_hash;
  }

  __debugInsertChainRow(row: ChainRowInputSeed): void {
    const seq = this.nextSequence++;
    // The seeded `hash` doubles as the canonical-hash snapshot for the
    // in-memory mirror — the test inserts what the canonical recompute
    // would have produced for this row's content. Subsequent
    // __debugCorruptRowHash mutates `hash` but leaves `canonical_hash`
    // intact so the chain-walk can detect the divergence.
    this.auditChainRows.push({
      id: row.id,
      ts_ms: row.ts_ms,
      actor_pseudonym: row.actor_pseudonym,
      event_type: row.event_type,
      target_id: row.target_id,
      target_class: row.target_class,
      severity: row.severity,
      request_id: row.request_id,
      rotation_id: row.rotation_id,
      meta: { ...row.meta },
      prev_hash: row.prev_hash,
      hash: row.hash,
      canonical_hash: row.hash,
      sequence: seq
    });
  }

  __debugInsertBackupManifestFixture(input: BackupManifestFixtureSeed): void {
    const seq = this.nextSequence++;
    // Snapshot the current chain rows AS the dump's view per ADR-0019 §5
    // step 8 MVP note. T18.1 reads this view from the object-locked bucket.
    const dumpRows = this.auditChainRows
      .slice()
      .sort((a, b) => compareIds(a.id, b.id))
      .map((r) => ({
        id: r.id,
        ts_ms: r.ts_ms,
        hash: r.hash,
        prev_hash: r.prev_hash,
        event_type: r.event_type
      }));
    this.backupManifests.push({
      run_id: input.run_id,
      committed_at_ms: input.committed_at_ms,
      audit_log_head:
        input.audit_log_head === null ? null : { ...input.audit_log_head },
      per_event_row_counts: { ...input.per_event_row_counts },
      retention_sweep_runs_snapshot_ts_ms: input.retention_sweep_runs_snapshot_ts_ms,
      schedule_hash: input.schedule_hash,
      node_runtime_pin: { ...input.node_runtime_pin },
      audit_log_rows_in_dump: dumpRows,
      insert_sequence: seq
    });
  }

  __debugInsertSweepRunFixture(run: SweepRunFixtureSeed): void {
    this.retentionSweepRuns.push({
      run_id: run.run_id,
      started_at_ms: run.started_at_ms,
      completed_at_ms: run.completed_at_ms,
      per_event_counts: { ...run.per_event_counts },
      status: run.status
    });
  }

  __debugDeleteRowAtId(id: string): void {
    this.auditChainRows = this.auditChainRows.filter((r) => r.id !== id);
  }

  __forceSummaryEmitFailure(on: boolean): void {
    this.forceSummaryEmitFailure = on;
  }

  __forceChainWalkException(on: boolean): void {
    this.forceChainWalkException = on;
  }

  __setLiveRuntimePin(pin: IntegrityNodeRuntimePin): void {
    this.liveRuntimePin = { ...pin };
  }

  __debugListRuns(): ReadonlyArray<{
    readonly run_id: string;
    readonly status: 'running' | 'completed' | 'capped' | 'errored';
  }> {
    return this.integrityRuns.map((r) => ({ run_id: r.run_id, status: r.status }));
  }

  __debugListAuditRows(): ReadonlyArray<{
    readonly event_type: string;
    readonly ts_ms: number;
    readonly target_id: string | null;
    readonly actor_pseudonym: string;
    readonly meta: Record<string, unknown>;
  }> {
    return this.emittedAuditRows
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map((r) => ({
        event_type: r.event_type,
        ts_ms: r.ts_ms,
        target_id: r.target_id,
        actor_pseudonym: r.actor_pseudonym,
        meta: { ...r.meta }
      }));
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  private appendEmittedRow(row: Omit<EmittedAuditRowInternal, 'sequence'>): void {
    const seq = this.nextSequence++;
    this.emittedAuditRows.push({
      event_type: row.event_type,
      ts_ms: row.ts_ms,
      target_id: row.target_id,
      actor_pseudonym: row.actor_pseudonym,
      target_class: row.target_class,
      severity: row.severity,
      meta: { ...row.meta },
      sequence: seq
    });
  }

  private toMaterialized(r: ChainRowInternal): AuditChainRowMaterialized {
    return {
      id: r.id,
      ts_ms: r.ts_ms,
      actor_pseudonym: r.actor_pseudonym,
      event_type: r.event_type,
      target_id: r.target_id,
      target_class: r.target_class,
      severity: r.severity,
      request_id: r.request_id,
      rotation_id: r.rotation_id,
      meta: { ...r.meta },
      prev_hash: r.prev_hash,
      hash: r.hash,
      canonical_hash: r.canonical_hash
    };
  }

  private toBackupManifestSnapshot(m: BackupManifestInternal): BackupManifestSnapshot {
    return {
      run_id: m.run_id,
      committed_at_ms: m.committed_at_ms,
      audit_log_head: m.audit_log_head === null ? null : { ...m.audit_log_head },
      per_event_row_counts: { ...m.per_event_row_counts },
      retention_sweep_runs_snapshot_ts_ms: m.retention_sweep_runs_snapshot_ts_ms,
      schedule_hash: m.schedule_hash,
      node_runtime_pin: { ...m.node_runtime_pin },
      audit_log_rows_in_dump: m.audit_log_rows_in_dump.map((r) => ({ ...r }))
    };
  }
}

/**
 * Numeric-aware id comparator. The test seeds string ids that are numeric
 * (e.g., '1'..'20001'); lexicographic compare would order '10' before '2'.
 * For non-numeric ids fall back to lexicographic compare. Production T18.1
 * compares bigints directly.
 */
function compareIds(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn) && String(an) === a && String(bn) === b) {
    return an - bn;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// Hash helpers are unused by the in-memory mirror's runtime path (the
// canonical_hash snapshot is recorded at insert time) but exported for
// the T18.1 production wire-up. Suppress an unused-import-style notice
// by re-exporting them under a documented alias.
export { computeCanonicalHash, canonicalJSON, INTEGRITY_GENESIS_PREV_HASH };
