/**
 * SupabaseBackupStore unit tests.
 *
 * Validates the contract surface against a mocked RPC shim; the SQL
 * functions themselves are covered by the pgTAP suite landed in #220
 * (supabase/test/t17_backup_functions.sql).
 *
 * Source: ADR-0018 §4; apps/web/src/lib/backup/supabase-backup-store.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  SupabaseBackupStore,
  BackupRpcError,
  type SupabaseBackupRpc
} from '../../src/lib/backup/supabase-backup-store';
import type { BackupManifestPendingInput } from '../../src/lib/backup/backup-store';

const HMAC_KEY = 'unit-test-hmac-key-not-secret';

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function makeStore(over?: {
  rpcReturns?: (call: RpcCall) => unknown;
  rpcErrors?: (call: RpcCall) => { code?: string; message: string } | null;
  nowMs?: number;
}): { store: SupabaseBackupStore; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const rpc: SupabaseBackupRpc = {
    async rpc(fn, args) {
      const call: RpcCall = { fn, args };
      calls.push(call);
      const err = over?.rpcErrors?.(call) ?? null;
      if (err) return { data: null, error: err };
      const data = over?.rpcReturns?.(call) ?? null;
      return { data, error: null };
    }
  };
  return {
    store: new SupabaseBackupStore({
      rpc,
      hmacKey: HMAC_KEY,
      nowMs: over?.nowMs !== undefined ? () => over.nowMs! : undefined
    }),
    calls
  };
}

const SAMPLE_PENDING_INPUT: BackupManifestPendingInput = {
  run_id: '11111111-1111-1111-1111-111111111111',
  started_at_ms: 1_700_000_000_000,
  object_ref: 'backups/2026/06/13/run-1.bin',
  sha256: 'a'.repeat(64),
  bytes: 4096,
  lock_until_ms: 1_700_000_000_000 + 42 * 86_400_000,
  committee_data_key_kid: 'kid-v1',
  audit_log_head: { id: '7', ts_ms: 1_700_000_000_000, hash: 'b'.repeat(64) },
  per_table_row_counts: { audit_log: 42 },
  per_event_row_counts: { 'session.revoked': 7 },
  retention_sweep_runs_snapshot_ts_ms: 1_700_000_000_000,
  schedule_hash: 'sch-hash-abc',
  node_runtime_pin: { node_version: 'v20.0.0', openssl_version: '3.0.0' }
};

describe('SupabaseBackupStore — contract surface', () => {
  it('nowMs uses injected clock when supplied', () => {
    const { store } = makeStore({ nowMs: 1_700_000_000_000 });
    expect(store.nowMs()).toBe(1_700_000_000_000);
  });

  it('nowMs falls back to Date.now when no clock injected', () => {
    const { store } = makeStore();
    const before = Date.now();
    const value = store.nowMs();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  it('systemActorPseudonym is HMAC-deterministic over a fixed key', () => {
    const { store: s1 } = makeStore();
    const { store: s2 } = makeStore();
    expect(s1.systemActorPseudonym()).toBe(s2.systemActorPseudonym());
    expect(s1.systemActorPseudonym()).toHaveLength(16);
    expect(s1.systemActorPseudonym()).toMatch(/^[0-9a-f]+$/);
  });

  it('different hmac keys produce different pseudonyms', () => {
    const s1 = new SupabaseBackupStore({
      rpc: { async rpc() { return { data: null, error: null }; } },
      hmacKey: 'k1'
    });
    const s2 = new SupabaseBackupStore({
      rpc: { async rpc() { return { data: null, error: null }; } },
      hmacKey: 'k2'
    });
    expect(s1.systemActorPseudonym()).not.toBe(s2.systemActorPseudonym());
  });
});

describe('SupabaseBackupStore — extractAuditLogHead', () => {
  it('returns the head triple from the RPC row', async () => {
    const { store, calls } = makeStore({
      rpcReturns: () => ({ head_id: 42, head_ts_ms: 1700, head_hash: 'deadbeef' })
    });
    const head = await store.extractAuditLogHead();
    expect(head).toEqual({ id: '42', ts_ms: 1700, hash: 'deadbeef' });
    expect(calls).toEqual([{ fn: 'backup_extract_head_pointer', args: {} }]);
  });

  it('returns null on an empty chain (RPC returns null)', async () => {
    const { store } = makeStore({ rpcReturns: () => null });
    expect(await store.extractAuditLogHead()).toBeNull();
  });

  it('returns null when RPC yields a row with null head_id', async () => {
    const { store } = makeStore({
      rpcReturns: () => ({ head_id: null, head_ts_ms: null, head_hash: null })
    });
    expect(await store.extractAuditLogHead()).toBeNull();
  });

  it('throws BackupRpcError on RPC error', async () => {
    const { store } = makeStore({
      rpcErrors: () => ({ code: 'P0001', message: 'boom' })
    });
    await expect(store.extractAuditLogHead()).rejects.toBeInstanceOf(BackupRpcError);
  });
});

describe('SupabaseBackupStore — writeManifestPending', () => {
  it('maps every PendingInput field to the SQL RPC arg shape', async () => {
    const { store, calls } = makeStore();
    await store.writeManifestPending(SAMPLE_PENDING_INPUT);
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('backup_write_manifest_pending');
    expect(calls[0].args).toMatchObject({
      p_run_id: SAMPLE_PENDING_INPUT.run_id,
      p_started_at_ms: SAMPLE_PENDING_INPUT.started_at_ms,
      p_object_ref: SAMPLE_PENDING_INPUT.object_ref,
      p_blob_sha256: SAMPLE_PENDING_INPUT.sha256,
      p_blob_bytes: SAMPLE_PENDING_INPUT.bytes,
      p_encryption_kid: SAMPLE_PENDING_INPUT.committee_data_key_kid,
      p_audit_log_head_id: '7',
      p_audit_log_head_ts_ms: 1_700_000_000_000,
      p_audit_log_head_hash: 'b'.repeat(64),
      p_per_event_row_counts: { 'session.revoked': 7 },
      p_per_table_row_counts: { audit_log: 42 },
      p_retention_sweep_runs_snapshot_ts_ms: 1_700_000_000_000,
      p_schedule_hash: 'sch-hash-abc'
    });
    // node_runtime_pin is serialized as JSON for the text column.
    expect(JSON.parse(calls[0].args.p_node_runtime_pin as string)).toEqual({
      node_version: 'v20.0.0',
      openssl_version: '3.0.0'
    });
  });

  it('passes null head fields when audit_log_head is null', async () => {
    const { store, calls } = makeStore();
    await store.writeManifestPending({ ...SAMPLE_PENDING_INPUT, audit_log_head: null });
    expect(calls[0].args.p_audit_log_head_id).toBeNull();
    expect(calls[0].args.p_audit_log_head_ts_ms).toBeNull();
    expect(calls[0].args.p_audit_log_head_hash).toBeNull();
  });

  it('throws BackupRpcError on RPC error', async () => {
    const { store } = makeStore({
      rpcErrors: () => ({ code: '22023', message: 'invalid input' })
    });
    await expect(store.writeManifestPending(SAMPLE_PENDING_INPUT)).rejects.toBeInstanceOf(
      BackupRpcError
    );
  });
});

describe('SupabaseBackupStore — transitionManifestStatus', () => {
  it('passes committed through unchanged', async () => {
    const { store, calls } = makeStore();
    await store.transitionManifestStatus('run-1', 'committed', 1700);
    expect(calls[0].args.p_new_status).toBe('committed');
    expect(calls[0].args.p_now_ms).toBe(1700);
  });

  it('passes hard_deleted through unchanged', async () => {
    const { store, calls } = makeStore();
    await store.transitionManifestStatus('run-2', 'hard_deleted', 1701);
    expect(calls[0].args.p_new_status).toBe('hard_deleted');
  });

  it('collapses every aborted_* discriminator to "aborted" for SQL', async () => {
    const { store, calls } = makeStore();
    await store.transitionManifestStatus('r1', 'aborted_upload_failed', 1);
    await store.transitionManifestStatus('r2', 'aborted_object_lock_policy_rejected', 2);
    await store.transitionManifestStatus('r3', 'aborted_cross_region_destination_refused', 3);
    await store.transitionManifestStatus('r4', 'aborted_unknown_storage_error', 4);
    for (const c of calls) expect(c.args.p_new_status).toBe('aborted');
  });

  it('throws BackupRpcError on RPC error', async () => {
    const { store } = makeStore({
      rpcErrors: () => ({ code: '22023', message: 'invalid transition' })
    });
    await expect(store.transitionManifestStatus('r', 'committed', 1)).rejects.toBeInstanceOf(
      BackupRpcError
    );
  });
});

describe('SupabaseBackupStore — hasOpenBackupRunWithinWindow', () => {
  it('returns true when RPC returns true', async () => {
    const { store } = makeStore({ rpcReturns: () => true });
    expect(await store.hasOpenBackupRunWithinWindow(1700, 60_000)).toBe(true);
  });

  it('returns false when RPC returns false', async () => {
    const { store } = makeStore({ rpcReturns: () => false });
    expect(await store.hasOpenBackupRunWithinWindow(1700, 60_000)).toBe(false);
  });

  it('throws BackupRpcError on RPC error', async () => {
    const { store } = makeStore({
      rpcErrors: () => ({ code: 'P0001', message: 'boom' })
    });
    await expect(store.hasOpenBackupRunWithinWindow(1, 1)).rejects.toBeInstanceOf(BackupRpcError);
  });
});

describe('SupabaseBackupStore — listCommittedManifests', () => {
  it('maps RPC rows to CommittedManifestSummary objects', async () => {
    const { store, calls } = makeStore({
      nowMs: 1_700_000_000_000,
      rpcReturns: () => [
        {
          run_id: 'aaaa',
          committed_at_ms: 1_700_000_000_000 - 1000,
          object_ref: 'backups/x',
          object_lock_until_ms: 999
        },
        {
          run_id: 'bbbb',
          committed_at_ms: 1_700_000_000_000 - 500,
          object_ref: 'backups/y',
          object_lock_until_ms: 1000
        }
      ]
    });
    const out = await store.listCommittedManifests();
    expect(out).toEqual([
      { run_id: 'aaaa', object_ref: 'backups/x', committed_at_ms: 1_700_000_000_000 - 1000 },
      { run_id: 'bbbb', object_ref: 'backups/y', committed_at_ms: 1_700_000_000_000 - 500 }
    ]);
    // threshold is nowMs + 1 so every committed row is < threshold.
    expect(calls[0].args.p_threshold_ms).toBe(1_700_000_000_001);
  });

  it('returns [] when the RPC returns []', async () => {
    const { store } = makeStore({ rpcReturns: () => [] });
    expect(await store.listCommittedManifests()).toEqual([]);
  });

  it('throws BackupRpcError on RPC error', async () => {
    const { store } = makeStore({
      rpcErrors: () => ({ code: 'P0001', message: 'boom' })
    });
    await expect(store.listCommittedManifests()).rejects.toBeInstanceOf(BackupRpcError);
  });
});

describe('SupabaseBackupStore — getCurrentKid (M8.A.3a)', () => {
  it('returns the kid string from the RPC', async () => {
    const { store, calls } = makeStore({
      rpcReturns: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    });
    expect(await store.getCurrentKid()).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(calls[0].fn).toBe('backup_get_current_kid');
  });

  it('throws BackupRpcError with no_active_kid code on null result', async () => {
    const { store } = makeStore({ rpcReturns: () => null });
    await expect(store.getCurrentKid()).rejects.toMatchObject({
      fn: 'backup_get_current_kid',
      cause: { code: 'no_active_kid' }
    });
  });

  it('throws BackupRpcError on RPC error', async () => {
    const { store } = makeStore({
      rpcErrors: () => ({ code: 'P0001', message: 'boom' })
    });
    await expect(store.getCurrentKid()).rejects.toBeInstanceOf(BackupRpcError);
  });
});

describe('SupabaseBackupStore — countAuditRowsByEventType (M8.A.3a)', () => {
  it('maps RPC jsonb to a frozen record', async () => {
    const { store, calls } = makeStore({
      rpcReturns: () => ({ 'session.revoked': 2, 'auth.passkey.enrolled': 1 })
    });
    const out = await store.countAuditRowsByEventType();
    expect(out).toEqual({ 'session.revoked': 2, 'auth.passkey.enrolled': 1 });
    expect(calls[0].fn).toBe('backup_count_rows_by_event_type');
  });

  it('returns {} when RPC returns null', async () => {
    const { store } = makeStore({ rpcReturns: () => null });
    expect(await store.countAuditRowsByEventType()).toEqual({});
  });

  it('coerces string-counted bigint values to number', async () => {
    const { store } = makeStore({
      rpcReturns: () => ({ 'session.revoked': '42' })
    });
    expect(await store.countAuditRowsByEventType()).toEqual({ 'session.revoked': 42 });
  });
});

describe('SupabaseBackupStore — snapshotRetentionSweepRunsTs (M8.A.3a)', () => {
  it('returns the bigint coerced to number', async () => {
    const { store, calls } = makeStore({ rpcReturns: () => 1_700_000_000_000 });
    expect(await store.snapshotRetentionSweepRunsTs()).toBe(1_700_000_000_000);
    expect(calls[0].fn).toBe('backup_snapshot_retention_sweep_runs_ts');
  });

  it('returns 0 when RPC returns null', async () => {
    const { store } = makeStore({ rpcReturns: () => null });
    expect(await store.snapshotRetentionSweepRunsTs()).toBe(0);
  });
});

describe('SupabaseBackupStore — readManifest (M8.A.3a)', () => {
  it('maps a populated RPC row to a BackupManifest', async () => {
    const { store, calls } = makeStore({
      rpcReturns: () => ({
        run_id: '33333333-3333-3333-3333-333333333333',
        manifest_status: 'committed',
        started_at_ms: 1700000000000,
        committed_at_ms: 1700000200000,
        object_lock_until_ms: 1700000200000 + 42 * 86400000,
        hard_deleted_at_ms: null,
        object_ref: 'backups/x',
        blob_sha256: 'a'.repeat(64),
        blob_bytes: 4096,
        encryption_kid: 'kid-v1',
        audit_log_head_id: 7,
        audit_log_head_ts_ms: 1700000000000,
        audit_log_head_hash: 'b'.repeat(64),
        per_event_row_counts: { 'session.revoked': 2 },
        per_table_row_counts: { audit_log: 10 },
        retention_sweep_runs_snapshot_ts_ms: 1700000000000,
        schedule_hash: 'sch-hash-abc',
        node_runtime_pin: JSON.stringify({ node_version: 'v20.0.0', openssl_version: '3.0.0' })
      })
    });
    const m = await store.readManifest('33333333-3333-3333-3333-333333333333');
    expect(m).not.toBeNull();
    expect(m!.run_id).toBe('33333333-3333-3333-3333-333333333333');
    expect(m!.status).toBe('committed');
    expect(m!.retention_class).toBe('42d');
    expect(m!.committed_at_ms).toBe(1700000200000);
    expect(m!.finalized_at_ms).toBe(1700000200000);
    expect(m!.hard_deleted_at_ms).toBeNull();
    expect(m!.audit_log_head).toEqual({
      id: '7',
      ts_ms: 1700000000000,
      hash: 'b'.repeat(64)
    });
    expect(m!.node_runtime_pin).toEqual({ node_version: 'v20.0.0', openssl_version: '3.0.0' });
    expect(calls[0].args.p_run_id).toBe('33333333-3333-3333-3333-333333333333');
  });

  it('returns null when RPC yields a row with null run_id (no match)', async () => {
    const { store } = makeStore({
      rpcReturns: () => ({
        run_id: null,
        manifest_status: null,
        started_at_ms: null,
        committed_at_ms: null,
        object_lock_until_ms: null,
        hard_deleted_at_ms: null,
        object_ref: null,
        blob_sha256: null,
        blob_bytes: null,
        encryption_kid: null,
        audit_log_head_id: null,
        audit_log_head_ts_ms: null,
        audit_log_head_hash: null,
        per_event_row_counts: null,
        per_table_row_counts: null,
        retention_sweep_runs_snapshot_ts_ms: null,
        schedule_hash: null,
        node_runtime_pin: null
      })
    });
    expect(await store.readManifest('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBeNull();
  });

  it('null head fields produce audit_log_head=null', async () => {
    const { store } = makeStore({
      rpcReturns: () => ({
        run_id: '33333333-3333-3333-3333-333333333333',
        manifest_status: 'pending',
        started_at_ms: 1,
        committed_at_ms: null,
        object_lock_until_ms: null,
        hard_deleted_at_ms: null,
        object_ref: 'r',
        blob_sha256: 'a'.repeat(64),
        blob_bytes: 0,
        encryption_kid: 'k',
        audit_log_head_id: null,
        audit_log_head_ts_ms: null,
        audit_log_head_hash: null,
        per_event_row_counts: {},
        per_table_row_counts: {},
        retention_sweep_runs_snapshot_ts_ms: 0,
        schedule_hash: 's',
        node_runtime_pin: JSON.stringify({ node_version: 'x', openssl_version: 'y' })
      })
    });
    const m = await store.readManifest('33333333-3333-3333-3333-333333333333');
    expect(m!.audit_log_head).toBeNull();
  });
});

describe('SupabaseBackupStore — hardDeleteManifestRow (M8.A.3a)', () => {
  it('delegates to transitionManifestStatus(hard_deleted)', async () => {
    const { store, calls } = makeStore();
    await store.hardDeleteManifestRow('33333333-3333-3333-3333-333333333333', 1700);
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('backup_transition_manifest_status');
    expect(calls[0].args.p_new_status).toBe('hard_deleted');
    expect(calls[0].args.p_now_ms).toBe(1700);
  });
});

describe('SupabaseBackupStore — still-deferred methods throw', () => {
  it.each([
    [
      'emitBackupManifestWritten',
      'not_implemented_until_m8_a_3b',
      (s: SupabaseBackupStore) =>
        s.emitBackupManifestWritten({
          event_type: 'backup.manifest_written',
          ts_ms: 1,
          target_id: null,
          actor_pseudonym: 'a'.repeat(16),
          meta: {}
        })
    ],
    [
      'dumpClosedAllowlist',
      'not_implemented_until_m8_a_3c',
      (s: SupabaseBackupStore) => s.dumpClosedAllowlist()
    ],
    [
      'putWithObjectLock',
      'not_implemented_until_m8_a_3c',
      (s: SupabaseBackupStore) => s.putWithObjectLock('ref', new Uint8Array(), 1)
    ],
    [
      'isObjectLocked',
      'not_implemented_until_m8_a_3c',
      (s: SupabaseBackupStore) => s.isObjectLocked('ref')
    ],
    [
      'deleteObjectIfUnlocked',
      'not_implemented_until_m8_a_3c',
      (s: SupabaseBackupStore) => s.deleteObjectIfUnlocked('ref')
    ]
  ])('%s throws %s', async (_name, marker, call) => {
    const { store } = makeStore();
    await expect(call(store)).rejects.toThrow(marker);
  });
});

describe('BackupRpcError', () => {
  it('exposes the failing fn name and the wrapped cause', () => {
    const e = new BackupRpcError('backup_write_manifest_pending', {
      code: '22023',
      message: 'invalid input'
    });
    expect(e.fn).toBe('backup_write_manifest_pending');
    expect(e.cause.code).toBe('22023');
    expect(e.message).toContain('backup_write_manifest_pending');
    expect(e.message).toContain('22023');
  });
});
