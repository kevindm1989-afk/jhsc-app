/**
 * SupabaseBackupStore — production-time BackupStore against the
 * Supabase project. Mirrors the same BackupStore contract the
 * library consumes from MemoryBackupStore.
 *
 * Source obligations:
 *   - ADR-0018 §4 (T17 backup library + sibling task spec).
 *   - ADR-0012 + amendments (backup strategy + 42-day object-lock).
 *   - threat-model.md §6 B6.1 trust boundary (backup_writer_role).
 *
 * Production path:
 *   The store calls SECURITY DEFINER RPCs landed in migration
 *   00000000000024_t17_backup_functions.sql:
 *     - backup_extract_head_pointer
 *     - backup_write_manifest_pending
 *     - backup_transition_manifest_status
 *     - backup_has_open_run_within_window
 *     - backup_list_manifests_older_than_ms
 *   These functions have EXECUTE granted ONLY to backup_writer_role.
 *
 * What this PR does NOT yet ship (separate M8.A.3 follow-up):
 *   - getCurrentKid, countAuditRowsByEventType,
 *     snapshotRetentionSweepRunsTs — need new SECURITY DEFINER fns.
 *   - dumpClosedAllowlist — heavy; needs the pg_dump-shaped surface
 *     (separate Edge Function + table-by-table SECURITY DEFINER set).
 *   - putWithObjectLock / isObjectLocked / deleteObjectIfUnlocked —
 *     Supabase Storage SDK wiring; not pure DB.
 *   - hardDeleteManifestRow, readManifest — need new SECURITY DEFINER
 *     fns (M8.A.1 ships transition_manifest_status which covers
 *     committed -> hard_deleted at the status level; the row-delete
 *     surface is deferred).
 *   - emitBackupManifestWritten — needs the ADR-0003 Amendment A
 *     six-mirror enum-extension for `backup.manifest_written`.
 *   Each deferred method throws `not_implemented_until_m8_a_3` so a
 *   premature caller fails closed instead of silently dropping data.
 */

import { createHmac } from 'node:crypto';
import type {
  BackupDeleteResult,
  BackupDumpSnapshot,
  BackupManifestPendingInput,
  BackupManifestWrittenAuditRow,
  BackupPutResult,
  BackupStore,
  CommittedManifestSummary
} from './backup-store';
import type { BackupAuditLogHead, BackupManifest, BackupManifestStatus } from './types';

/**
 * Minimal RPC interface — narrower than the supabase-js client. Keeps
 * this module testable without dragging the full @supabase/supabase-js
 * type surface into vitest. The production caller passes a wrapper
 * over `supabase.rpc(fn, args)`.
 */
export interface SupabaseBackupRpc {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): Promise<{ data: unknown; error: { code?: string | null; message: string } | null }>;
}

/**
 * Configuration for the production store. The caller injects:
 *   - `rpc`: the supabase-js .rpc() shim.
 *   - `nowMs`: clock; defaults to Date.now (overridable in tests).
 *   - `hmacKey`: ONLY used to derive `systemActorPseudonym()` for the
 *     row-shape the library asks for. In production the same value of
 *     `$HMAC_PSEUDONYM_KEY` flows in (the parity gate enforces it).
 */
export interface SupabaseBackupStoreConfig {
  readonly rpc: SupabaseBackupRpc;
  readonly nowMs?: () => number;
  readonly hmacKey: string;
}

/**
 * Maps the library's expanded `aborted_*` discriminator down to the
 * single 'aborted' the SQL state machine accepts. The structured
 * reason carries in the library's own log; the audit row records the
 * upload-rejection reason in `meta` when M8.A.3 wires emit.
 */
function mapTransitionStatusForSql(s: BackupManifestStatus): string {
  if (s === 'pending') return 'pending';
  if (s === 'committed') return 'committed';
  if (s === 'hard_deleted') return 'hard_deleted';
  // Every aborted_* discriminator collapses to 'aborted' in SQL.
  return 'aborted';
}

export class SupabaseBackupStore implements BackupStore {
  private readonly cfg: SupabaseBackupStoreConfig;
  private readonly _nowMs: () => number;
  /** Cached HMAC('system:backup-pass') for the row's actor_pseudonym. */
  private readonly _systemActorPseudonym: string;

  constructor(cfg: SupabaseBackupStoreConfig) {
    this.cfg = cfg;
    this._nowMs = cfg.nowMs ?? Date.now;
    this._systemActorPseudonym = createHmac('sha256', cfg.hmacKey)
      .update('system:backup-pass')
      .digest('hex')
      .slice(0, 16);
  }

  nowMs(): number {
    return this._nowMs();
  }

  systemActorPseudonym(): string {
    return this._systemActorPseudonym;
  }

  // ---- head pointer ------------------------------------------------------

  async extractAuditLogHead(): Promise<BackupAuditLogHead | null> {
    const { data, error } = await this.cfg.rpc.rpc('backup_extract_head_pointer', {});
    if (error) throw new BackupRpcError('backup_extract_head_pointer', error);
    if (data == null) return null;
    // RETURNS record yields a single row with three named fields.
    const row = Array.isArray(data) ? data[0] : data;
    if (row == null || typeof row !== 'object') return null;
    const r = row as { head_id?: unknown; head_ts_ms?: unknown; head_hash?: unknown };
    if (r.head_id == null) return null;
    return {
      id: String(r.head_id),
      ts_ms: Number(r.head_ts_ms ?? 0),
      hash: String(r.head_hash ?? '')
    };
  }

  // ---- manifest write + transition --------------------------------------

  async writeManifestPending(input: BackupManifestPendingInput): Promise<void> {
    const { error } = await this.cfg.rpc.rpc('backup_write_manifest_pending', {
      p_run_id: input.run_id,
      p_started_at_ms: input.started_at_ms,
      p_object_ref: input.object_ref,
      p_blob_sha256: input.sha256,
      p_blob_bytes: input.bytes,
      p_encryption_kid: input.committee_data_key_kid,
      p_audit_log_head_id: input.audit_log_head?.id ?? null,
      p_audit_log_head_ts_ms: input.audit_log_head?.ts_ms ?? null,
      p_audit_log_head_hash: input.audit_log_head?.hash ?? null,
      p_per_event_row_counts: input.per_event_row_counts,
      p_per_table_row_counts: input.per_table_row_counts,
      p_retention_sweep_runs_snapshot_ts_ms: input.retention_sweep_runs_snapshot_ts_ms,
      p_schedule_hash: input.schedule_hash,
      p_node_runtime_pin: JSON.stringify(input.node_runtime_pin)
    });
    if (error) throw new BackupRpcError('backup_write_manifest_pending', error);
  }

  async transitionManifestStatus(
    run_id: string,
    to_status: BackupManifestStatus,
    finalized_at_ms: number
  ): Promise<void> {
    const { error } = await this.cfg.rpc.rpc('backup_transition_manifest_status', {
      p_run_id: run_id,
      p_new_status: mapTransitionStatusForSql(to_status),
      p_now_ms: finalized_at_ms
    });
    if (error) throw new BackupRpcError('backup_transition_manifest_status', error);
  }

  // ---- lease check ------------------------------------------------------

  async hasOpenBackupRunWithinWindow(now_ms: number, lease_window_ms: number): Promise<boolean> {
    const { data, error } = await this.cfg.rpc.rpc('backup_has_open_run_within_window', {
      p_now_ms: now_ms,
      p_lease_window_ms: lease_window_ms
    });
    if (error) throw new BackupRpcError('backup_has_open_run_within_window', error);
    return data === true;
  }

  // ---- committed-manifest list ------------------------------------------
  //
  // backup_list_manifests_older_than_ms returns committed manifests
  // strictly older than the threshold. To enumerate ALL committed
  // manifests at observation time, pass nowMs + 1 — every committed
  // manifest's committed_at_ms is < nowMs by construction.

  async listCommittedManifests(): Promise<readonly CommittedManifestSummary[]> {
    const threshold = this._nowMs() + 1;
    const { data, error } = await this.cfg.rpc.rpc('backup_list_manifests_older_than_ms', {
      p_threshold_ms: threshold
    });
    if (error) throw new BackupRpcError('backup_list_manifests_older_than_ms', error);
    if (!Array.isArray(data)) return [];
    const out: CommittedManifestSummary[] = [];
    for (const row of data as Array<Record<string, unknown>>) {
      if (row.run_id == null || row.committed_at_ms == null) continue;
      out.push({
        run_id: String(row.run_id),
        object_ref: String(row.object_ref ?? ''),
        committed_at_ms: Number(row.committed_at_ms)
      });
    }
    return out;
  }

  // ---- read surface (M8.A.3a — wired against migration 28 RPCs) --------

  async getCurrentKid(): Promise<string> {
    const { data, error } = await this.cfg.rpc.rpc('backup_get_current_kid', {});
    if (error) throw new BackupRpcError('backup_get_current_kid', error);
    if (data == null || typeof data !== 'string' || data.length === 0) {
      throw new BackupRpcError('backup_get_current_kid', {
        code: 'no_active_kid',
        message: 'no active committee_data_key (rotated_at IS NULL)'
      });
    }
    return data;
  }

  async countAuditRowsByEventType(): Promise<Readonly<Record<string, number>>> {
    const { data, error } = await this.cfg.rpc.rpc('backup_count_rows_by_event_type', {});
    if (error) throw new BackupRpcError('backup_count_rows_by_event_type', error);
    if (data == null || typeof data !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out[k] = Number(v);
    }
    return out;
  }

  async snapshotRetentionSweepRunsTs(): Promise<number> {
    const { data, error } = await this.cfg.rpc.rpc('backup_snapshot_retention_sweep_runs_ts', {});
    if (error) throw new BackupRpcError('backup_snapshot_retention_sweep_runs_ts', error);
    return Number(data ?? 0);
  }

  async readManifest(run_id: string): Promise<BackupManifest | null> {
    const { data, error } = await this.cfg.rpc.rpc('backup_read_manifest', {
      p_run_id: run_id
    });
    if (error) throw new BackupRpcError('backup_read_manifest', error);
    if (data == null) return null;
    const row = Array.isArray(data) ? data[0] : data;
    if (row == null || typeof row !== 'object') return null;
    const r = row as Record<string, unknown>;
    // RPC returns NULL fields when the row doesn't exist; the OUT-fn
    // shape still produces a record with NULL columns, so guard on
    // run_id being non-null.
    if (r.run_id == null) return null;
    const head: BackupAuditLogHead = {
      id: String(r.audit_log_head_id),
      ts_ms: Number(r.audit_log_head_ts_ms ?? 0),
      hash: String(r.audit_log_head_hash ?? '')
    };
    return {
      run_id: String(r.run_id),
      status: r.manifest_status as BackupManifest['status'],
      started_at_ms: Number(r.started_at_ms),
      committed_at_ms: r.committed_at_ms == null ? null : Number(r.committed_at_ms),
      finalized_at_ms: r.committed_at_ms == null ? null : Number(r.committed_at_ms),
      hard_deleted_at_ms: r.hard_deleted_at_ms == null ? null : Number(r.hard_deleted_at_ms),
      object_ref: String(r.object_ref ?? ''),
      sha256: String(r.blob_sha256 ?? ''),
      bytes: Number(r.blob_bytes ?? 0),
      retention_class: '42d',
      lock_until_ms: Number(r.object_lock_until_ms ?? 0),
      committee_data_key_kid: String(r.encryption_kid ?? ''),
      audit_log_head: r.audit_log_head_id == null ? null : head,
      per_table_row_counts: (r.per_table_row_counts as Record<string, number>) ?? {},
      per_event_row_counts: (r.per_event_row_counts as Record<string, number>) ?? {},
      retention_sweep_runs_snapshot_ts_ms: Number(r.retention_sweep_runs_snapshot_ts_ms ?? 0),
      schedule_hash: String(r.schedule_hash ?? ''),
      node_runtime_pin:
        typeof r.node_runtime_pin === 'string'
          ? (JSON.parse(r.node_runtime_pin) as BackupManifest['node_runtime_pin'])
          : { node_version: '', openssl_version: '' }
    };
  }

  async hardDeleteManifestRow(run_id: string, hard_deleted_at_ms: number): Promise<void> {
    // The M8.A.1 state machine already covers committed -> hard_deleted
    // (the row stays as a tombstone per the DELETE-revoked posture);
    // delegate to the existing transition.
    await this.transitionManifestStatus(run_id, 'hard_deleted', hard_deleted_at_ms);
  }

  // ---- backup.manifest_written emit (M8.A.3b — wired against migration 29) -

  async emitBackupManifestWritten(row: BackupManifestWrittenAuditRow): Promise<void> {
    // The SQL fn re-derives actor_pseudonym server-side; the row's
    // actor_pseudonym is structural-only on the wire. The fn rejects
    // empty kid / bad sha256 / negative bytes with 22023.
    const meta = row.meta as Record<string, unknown>;
    const head =
      (meta.audit_log_head as { id?: string; ts_ms?: number; hash?: string } | null) ?? null;
    const { error } = await this.cfg.rpc.rpc('backup_emit_manifest_written', {
      p_run_id: meta.run_id,
      p_emitted_at_ms: row.ts_ms,
      p_sha256: meta.sha256,
      p_bytes: meta.bytes,
      p_committee_data_key_kid: meta.committee_data_key_kid,
      p_audit_log_head_id: head?.id ?? null,
      p_audit_log_head_ts_ms: head?.ts_ms ?? null,
      p_audit_log_head_hash: head?.hash ?? null,
      p_per_event_row_counts: meta.per_event_row_counts ?? {},
      p_per_table_row_counts: meta.per_table_row_counts ?? {},
      p_retention_sweep_runs_snapshot_ts_ms: meta.retention_sweep_runs_snapshot_ts_ms,
      p_schedule_hash: meta.schedule_hash,
      p_node_runtime_pin:
        typeof meta.node_runtime_pin === 'string'
          ? meta.node_runtime_pin
          : JSON.stringify(meta.node_runtime_pin)
    });
    if (error) throw new BackupRpcError('backup_emit_manifest_written', error);
  }

  // ---- deferred to M8.A.3c (dump + Supabase Storage SDK wiring) --------

  async dumpClosedAllowlist(): Promise<BackupDumpSnapshot> {
    throw new Error('not_implemented_until_m8_a_3c');
  }

  async putWithObjectLock(
    _object_ref: string,
    _blob: Uint8Array,
    _lock_until_ms: number
  ): Promise<BackupPutResult> {
    throw new Error('not_implemented_until_m8_a_3c');
  }

  async isObjectLocked(_object_ref: string): Promise<boolean> {
    throw new Error('not_implemented_until_m8_a_3c');
  }

  async deleteObjectIfUnlocked(_object_ref: string): Promise<BackupDeleteResult> {
    throw new Error('not_implemented_until_m8_a_3c');
  }
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Wraps a Postgres-level error from a backup RPC call. Caller maps
 * (e.g.) ERRCODE 22023 to the library's structured error vocabulary
 * (`manifest_write_failed`, `transition_failed`, `head_pointer_failed`).
 */
export class BackupRpcError extends Error {
  constructor(
    public readonly fn: string,
    public override readonly cause: { code?: string | null; message: string }
  ) {
    super(`backup rpc ${fn} failed: ${cause.code ?? 'unknown'} — ${cause.message}`);
    this.name = 'BackupRpcError';
  }
}
