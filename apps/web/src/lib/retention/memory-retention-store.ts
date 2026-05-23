/**
 * In-memory implementation of RetentionStore (T16; library-only per ADR-0002 H).
 *
 * Mirrors the SQL semantics SupabaseRetentionStore will ship in T16.1:
 *   - `audit_log` is an append-only array; deletes remove by id.
 *   - `retention_sweep_runs` is an append-only checkpoint array.
 *   - `deleted_records` is a map keyed by `target_id` carrying `deleted_at_ms`
 *      and `source_table` (the underlying-record-ceiling lookup, F-61).
 *   - Operational tables (e.g., `auth_totp_consumed_log`) are arrays of rows
 *      with a kind-specific timestamp column.
 *
 * Snapshot/restore: `snapshot()` returns a token; the store keeps a deep-copy
 * of the audit_log array and the operational-table arrays at that point. On
 * `restore(token)` the arrays are replaced by the snapshot copies. Mirrors
 * Postgres single-transaction semantics for the F-58 rollback path.
 *
 * Pseudonyms: HMAC-SHA-256 keyed by a per-store random key (production stores
 * share the AuthStore's key per ADR-0016 §Decision 1; the library does not
 * depend on a specific key, only on determinism within a store instance).
 *
 * Source: ADR-0017 §4/§5/§6; threat-model §3.9 F-56..F-69.
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { listRetentionEventTypes } from './schedule';
import type {
  DeleteBatchResult,
  RetentionDeletedAuditRow,
  RetentionStore
} from './retention-store';
import { NOW_MS_MIN_INCREMENT } from './types';
import type { RetentionEventType } from './types';

/**
 * Pseudonym constant — opaque system actor id used in `retention.deleted`
 * rows. The HMAC pseudonym derived from this id appears in the audit row's
 * `actor_pseudonym` field; the bare id never leaves the library.
 */
const SYSTEM_ACTOR_ID = 'system:retention-sweep';

interface AuditRow {
  id: string;
  event_type: string;
  ts_ms: number;
  target_id: string | null;
  meta: Record<string, unknown>;
}

interface DeletedRecord {
  readonly target_id: string;
  readonly source_table: string;
  readonly deleted_at_ms: number;
}

interface SweepRunRow {
  readonly run_id: string;
  readonly started_at_ms: number;
  readonly completed_at_ms: number;
  readonly schedule_hash: string;
  readonly per_event_counts: Readonly<Record<string, number>>;
  readonly per_table_counts: Readonly<Record<string, number>>;
  readonly truncated_to_row_cap: boolean;
  readonly alarm_fired: boolean;
  readonly status: 'completed' | 'capped';
}

interface OperationalRow {
  readonly id: string;
  /**
   * Generic timestamp column. The library reads it via the
   * `OPERATIONAL_TABLE_SCHEDULE` allowlist; the row carrier stores the same
   * ms-epoch under a kind-specific name (e.g., `consumed_at_ms`). The test
   * fixture passes through whichever name; we normalise to `ts_ms` here.
   */
  readonly ts_ms: number;
  readonly raw: Readonly<Record<string, unknown>>;
}

interface Snapshot {
  auditRows: AuditRow[];
  operational: Map<string, OperationalRow[]>;
}

/**
 * Test-only superset of the production `RetentionStore`. Adds the seeding
 * and poisoning hooks the T16 test file consumes via deep import.
 */
export interface TestRetentionStore extends RetentionStore {
  __debugAuditRows(): ReadonlyArray<{
    event_type: string;
    ts_ms: number;
    target_id: string | null;
    meta: Record<string, unknown>;
  }>;

  __debugInsertAuditRow(row: {
    event_type: string;
    ts_ms: number;
    target_id: string | null;
    meta: Record<string, unknown>;
  }): void;

  __debugInsertFixture(table_name: string, row: Record<string, unknown>): void;

  __debugListTable(table_name: string): ReadonlyArray<{ id: string; ts_ms: number }>;

  __debugRegisterTargetDeletion(rec: {
    target_id: string;
    source_table: string;
    deleted_at_ms: number;
  }): void;

  __debugListSweepRuns(): ReadonlyArray<SweepRunRow>;

  __forceAuditEmitFailure(on: boolean): void;
}

export class MemoryRetentionStore implements TestRetentionStore {
  private auditRows: AuditRow[] = [];
  private deletedRecords = new Map<string, DeletedRecord>();
  private operational = new Map<string, OperationalRow[]>();
  private sweepRuns: SweepRunRow[] = [];
  private snapshots = new Map<symbol, Snapshot>();

  private hmacKey: Buffer;
  private auditEmitFailureForced = false;

  // F-66 monotonic clock — guarantees strictly-increasing ms-epoch across
  // every nowMs() call within a process. Stores the last value handed out so
  // back-to-back calls within the same Date.now() millisecond still increase.
  private lastIssuedNowMs = 0;

  constructor(hmacKey?: Buffer) {
    this.hmacKey = hmacKey ?? randomBytes(32);
    // Bootstrap the closed operational tables so __debugListTable returns
    // arrays for tables the schedule knows about even before seeding.
    this.operational.set('auth_totp_consumed_log', []);
  }

  // -------------------------------------------------------------------
  // Production surface (RetentionStore)
  // -------------------------------------------------------------------

  nowMs(): number {
    const wall = Date.now();
    const next = wall > this.lastIssuedNowMs ? wall : this.lastIssuedNowMs + NOW_MS_MIN_INCREMENT;
    this.lastIssuedNowMs = next;
    return next;
  }

  systemActorPseudonym(): string {
    return createHmac('sha256', this.hmacKey).update(SYSTEM_ACTOR_ID).digest('hex').slice(0, 32);
  }

  async deleteForEventType(
    event_type: RetentionEventType,
    cutoff_ms: number,
    max_rows: number
  ): Promise<DeleteBatchResult> {
    let deleted = 0;
    const kept: AuditRow[] = [];
    for (const r of this.auditRows) {
      if (r.event_type === event_type && r.ts_ms <= cutoff_ms && deleted < max_rows) {
        deleted += 1;
      } else {
        kept.push(r);
      }
    }
    this.auditRows = kept;
    return { deleted_count: deleted };
  }

  async deleteForUnderlyingRecordCeiling(
    ceiling_cutoff_ms: number,
    max_rows: number
  ): Promise<DeleteBatchResult> {
    let deleted = 0;
    const kept: AuditRow[] = [];
    for (const r of this.auditRows) {
      if (deleted >= max_rows) {
        kept.push(r);
        continue;
      }
      // F-62: rows whose schedule entry carries no_target_id are exempt from
      // the ceiling rule. We model that here as "target_id === null implies
      // exempt" since the audit row carries no link to chase.
      if (r.target_id === null) {
        kept.push(r);
        continue;
      }
      const rec = this.deletedRecords.get(r.target_id);
      if (rec && rec.deleted_at_ms <= ceiling_cutoff_ms) {
        deleted += 1;
        continue;
      }
      kept.push(r);
    }
    this.auditRows = kept;
    return { deleted_count: deleted };
  }

  async deleteOperationalTable(
    table_name: string,
    cutoff_ms: number,
    max_rows: number
  ): Promise<DeleteBatchResult> {
    const rows = this.operational.get(table_name);
    if (!rows) return { deleted_count: 0 };
    let deleted = 0;
    const kept: OperationalRow[] = [];
    for (const r of rows) {
      if (r.ts_ms <= cutoff_ms && deleted < max_rows) {
        deleted += 1;
      } else {
        kept.push(r);
      }
    }
    this.operational.set(table_name, kept);
    return { deleted_count: deleted };
  }

  async countCandidatesPerEventType(
    cutoffs_ms: Readonly<Record<RetentionEventType, number>>
  ): Promise<Readonly<Record<RetentionEventType, number>>> {
    const counts = {} as Record<RetentionEventType, number>;
    for (const et of listRetentionEventTypes()) {
      counts[et] = 0;
    }
    for (const r of this.auditRows) {
      const et = r.event_type as RetentionEventType;
      const cutoff = cutoffs_ms[et];
      if (cutoff === undefined) continue;
      if (r.ts_ms <= cutoff) {
        counts[et] = (counts[et] ?? 0) + 1;
      }
    }
    return counts;
  }

  async countCandidatesForCeiling(ceiling_cutoff_ms: number): Promise<number> {
    let n = 0;
    for (const r of this.auditRows) {
      if (r.target_id === null) continue;
      const rec = this.deletedRecords.get(r.target_id);
      if (rec && rec.deleted_at_ms <= ceiling_cutoff_ms) n += 1;
    }
    return n;
  }

  async countCandidatesInOperationalTable(table_name: string, cutoff_ms: number): Promise<number> {
    const rows = this.operational.get(table_name) ?? [];
    let n = 0;
    for (const r of rows) {
      if (r.ts_ms <= cutoff_ms) n += 1;
    }
    return n;
  }

  async emitRetentionDeletedAndRegisterRun(args: {
    row: RetentionDeletedAuditRow;
    run: SweepRunRow;
  }): Promise<void> {
    if (this.auditEmitFailureForced) {
      // Structured error code — no PII (F-67).
      throw new Error('audit_emit_failed');
    }
    this.auditRows.push({
      id: randomUUID(),
      event_type: args.row.event_type,
      ts_ms: args.row.ts_ms,
      target_id: args.row.target_id,
      meta: { ...args.row.meta, actor_pseudonym: args.row.actor_pseudonym }
    });
    this.sweepRuns.push(args.run);
  }

  snapshot(): symbol {
    const token = Symbol('retention-snapshot');
    const opCopy = new Map<string, OperationalRow[]>();
    for (const [k, v] of this.operational.entries()) {
      opCopy.set(k, v.slice());
    }
    this.snapshots.set(token, {
      auditRows: this.auditRows.slice(),
      operational: opCopy
    });
    return token;
  }

  restore(token: symbol): void {
    const s = this.snapshots.get(token);
    if (!s) return;
    this.auditRows = s.auditRows.slice();
    this.operational = new Map<string, OperationalRow[]>();
    for (const [k, v] of s.operational.entries()) {
      this.operational.set(k, v.slice());
    }
    this.snapshots.delete(token);
  }

  async hasOpenSweepRunWithinWindow(now_ms: number, lease_window_ms: number): Promise<boolean> {
    for (const r of this.sweepRuns) {
      if (now_ms - r.started_at_ms < lease_window_ms) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------
  // Test surface (TestRetentionStore)
  // -------------------------------------------------------------------

  __debugAuditRows(): ReadonlyArray<{
    event_type: string;
    ts_ms: number;
    target_id: string | null;
    meta: Record<string, unknown>;
  }> {
    return this.auditRows.map((r) => ({
      event_type: r.event_type,
      ts_ms: r.ts_ms,
      target_id: r.target_id,
      meta: r.meta
    }));
  }

  __debugInsertAuditRow(row: {
    event_type: string;
    ts_ms: number;
    target_id: string | null;
    meta: Record<string, unknown>;
  }): void {
    this.auditRows.push({
      id: randomUUID(),
      event_type: row.event_type,
      ts_ms: row.ts_ms,
      target_id: row.target_id,
      meta: { ...row.meta }
    });
  }

  __debugInsertFixture(table_name: string, row: Record<string, unknown>): void {
    // Operational table fixtures use a kind-specific ts column. Normalise to
    // ts_ms based on the table name.
    const id =
      typeof row.id === 'string' ? row.id : (row.id !== undefined ? String(row.id) : randomUUID());
    let ts_ms: number | undefined;
    if (table_name === 'auth_totp_consumed_log') {
      ts_ms = typeof row.consumed_at_ms === 'number' ? row.consumed_at_ms : undefined;
    }
    if (ts_ms === undefined && typeof row.ts_ms === 'number') ts_ms = row.ts_ms;
    if (ts_ms === undefined) {
      // No PII in the error — name the table generically.
      throw new Error(`fixture_missing_ts: ${table_name}`);
    }
    const arr = this.operational.get(table_name) ?? [];
    arr.push({ id, ts_ms, raw: { ...row } });
    this.operational.set(table_name, arr);
  }

  __debugListTable(table_name: string): ReadonlyArray<{ id: string; ts_ms: number }> {
    const rows = this.operational.get(table_name) ?? [];
    return rows.map((r) => ({ id: r.id, ts_ms: r.ts_ms }));
  }

  __debugRegisterTargetDeletion(rec: {
    target_id: string;
    source_table: string;
    deleted_at_ms: number;
  }): void {
    this.deletedRecords.set(rec.target_id, {
      target_id: rec.target_id,
      source_table: rec.source_table,
      deleted_at_ms: rec.deleted_at_ms
    });
  }

  __debugListSweepRuns(): ReadonlyArray<SweepRunRow> {
    return this.sweepRuns.slice();
  }

  __forceAuditEmitFailure(on: boolean): void {
    this.auditEmitFailureForced = on;
  }
}
