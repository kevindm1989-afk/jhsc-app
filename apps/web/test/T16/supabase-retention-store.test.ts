/**
 * SupabaseRetentionStore unit tests.
 *
 * Validates the contract surface against a mocked RPC + SELECT shim;
 * the SQL functions themselves are covered by the pgTAP suite landed
 * in #217 (supabase/test/t16_retention_sweep_functions.sql).
 *
 * Source: ADR-0017 §3; apps/web/src/lib/retention/supabase-retention-store.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SupabaseRetentionStore,
  RetentionRpcError,
  type SupabaseRetentionRpc,
  type SupabaseRetentionSelect
} from '../../src/lib/retention/supabase-retention-store';

const HMAC_KEY = 'unit-test-hmac-key-not-secret';

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function makeStore(over?: {
  rpcReturns?: (call: RpcCall) => Promise<unknown>;
  rpcErrors?: (call: RpcCall) => { code?: string; message: string } | null;
  selectCount?: number;
  selectError?: { code?: string; message: string } | null;
  nowMs?: number;
}): {
  store: SupabaseRetentionStore;
  calls: RpcCall[];
  selectCalls: number[];
} {
  const calls: RpcCall[] = [];
  const selectCalls: number[] = [];

  const rpc: SupabaseRetentionRpc = {
    async rpc(fn, args) {
      const call: RpcCall = { fn, args };
      calls.push(call);
      const err = over?.rpcErrors?.(call) ?? null;
      if (err) return { data: null, error: err };
      const data = (await over?.rpcReturns?.(call)) ?? 0;
      return { data, error: null };
    }
  };

  const select: SupabaseRetentionSelect = {
    async selectRunsStartedAfter(threshold_ms) {
      selectCalls.push(threshold_ms);
      return {
        count: over?.selectCount ?? 0,
        error: over?.selectError ?? null
      };
    }
  };

  return {
    store: new SupabaseRetentionStore({
      rpc,
      select,
      hmacKey: HMAC_KEY,
      nowMs: over?.nowMs !== undefined ? () => over.nowMs! : undefined
    }),
    calls,
    selectCalls
  };
}

describe('SupabaseRetentionStore — contract surface', () => {
  it('nowMs uses injected clock when supplied', () => {
    const { store } = makeStore({ nowMs: 1_700_000_000_000 });
    expect(store.nowMs()).toBe(1_700_000_000_000);
  });

  it('nowMs falls back to Date.now when no clock injected', () => {
    const { store } = makeStore();
    const before = Date.now();
    const v = store.nowMs();
    const after = Date.now();
    expect(v).toBeGreaterThanOrEqual(before);
    expect(v).toBeLessThanOrEqual(after);
  });

  it('systemActorPseudonym returns 16 hex chars derived from HMAC(key, "system:retention")', () => {
    const { store } = makeStore();
    const p = store.systemActorPseudonym();
    expect(p).toMatch(/^[0-9a-f]{16}$/);
    // Determinism — same key + same input → same pseudonym.
    const { store: store2 } = makeStore();
    expect(store2.systemActorPseudonym()).toBe(p);
  });
});

describe('SupabaseRetentionStore — RPC wiring', () => {
  it('deleteForEventType invokes retention_delete_for_event_type with mapped args', async () => {
    const { store, calls } = makeStore({
      rpcReturns: async (c) => (c.fn === 'retention_delete_for_event_type' ? 5 : 0)
    });
    const r = await store.deleteForEventType('session.revoked' as never, 1700, 100);
    expect(r).toEqual({ deleted_count: 5 });
    expect(calls).toEqual([
      {
        fn: 'retention_delete_for_event_type',
        args: { p_event_type: 'session.revoked', p_cutoff_ms: 1700, p_max_rows: 100 }
      }
    ]);
  });

  it('countCandidatesPerEventType issues one RPC per key', async () => {
    const { store, calls } = makeStore({
      rpcReturns: async (c) => {
        // Echo a synthetic count per event_type.
        if (c.args.p_event_type === 'session.revoked') return 3;
        if (c.args.p_event_type === 'auth.passkey.enrolled') return 7;
        return 0;
      }
    });
    const out = await store.countCandidatesPerEventType({
      'session.revoked': 1,
      'auth.passkey.enrolled': 2
    } as never);
    expect(out).toEqual({ 'session.revoked': 3, 'auth.passkey.enrolled': 7 });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.fn === 'retention_count_for_event_type')).toBe(true);
  });

  it('deleteOperationalTable forwards args verbatim', async () => {
    const { store, calls } = makeStore({
      rpcReturns: async () => 1
    });
    const r = await store.deleteOperationalTable('auth_totp_consumed_log', 12345, 10);
    expect(r).toEqual({ deleted_count: 1 });
    expect(calls[0]).toEqual({
      fn: 'retention_delete_operational_table',
      args: {
        p_table_name: 'auth_totp_consumed_log',
        p_cutoff_ms: 12345,
        p_max_rows: 10
      }
    });
  });

  it('countCandidatesInOperationalTable returns the RPC payload as number', async () => {
    const { store } = makeStore({ rpcReturns: async () => 42 });
    expect(await store.countCandidatesInOperationalTable('auth_totp_consumed_log', 0)).toBe(
      42
    );
  });

  it('emitRetentionDeletedAndRegisterRun forwards every run field', async () => {
    const { store, calls } = makeStore({ rpcReturns: async () => 1 });
    await store.emitRetentionDeletedAndRegisterRun({
      row: {
        event_type: 'retention.deleted',
        ts_ms: 0,
        target_id: null,
        actor_pseudonym: store.systemActorPseudonym(),
        meta: {}
      },
      run: {
        run_id: 'rt_aaaaaa',
        started_at_ms: 1,
        completed_at_ms: 2,
        schedule_hash: 'h',
        per_event_counts: { 'session.revoked': 1 },
        per_table_counts: { auth_totp_consumed_log: 0 },
        truncated_to_row_cap: false,
        alarm_fired: false,
        status: 'completed'
      }
    });
    expect(calls[0].fn).toBe('retention_emit_deleted_and_register_run');
    expect(calls[0].args).toMatchObject({
      p_run_id: 'rt_aaaaaa',
      p_started_at_ms: 1,
      p_completed_at_ms: 2,
      p_schedule_hash: 'h',
      p_truncated_to_row_cap: false,
      p_alarm_fired: false,
      p_status: 'completed'
    });
  });
});

describe('SupabaseRetentionStore — ceiling rule deferred to M6.1.B', () => {
  it('deleteForUnderlyingRecordCeiling throws not_implemented_until_m6_1_b', async () => {
    const { store } = makeStore();
    await expect(store.deleteForUnderlyingRecordCeiling(0, 1)).rejects.toThrow(
      /not_implemented_until_m6_1_b/
    );
  });

  it('countCandidatesForCeiling throws not_implemented_until_m6_1_b', async () => {
    const { store } = makeStore();
    await expect(store.countCandidatesForCeiling(0)).rejects.toThrow(
      /not_implemented_until_m6_1_b/
    );
  });
});

describe('SupabaseRetentionStore — snapshot/restore no-op', () => {
  it('snapshot returns a fresh symbol each call', () => {
    const { store } = makeStore();
    const t1 = store.snapshot();
    const t2 = store.snapshot();
    expect(typeof t1).toBe('symbol');
    expect(t1).not.toBe(t2);
  });

  it('restore is a no-op (does not throw)', () => {
    const { store } = makeStore();
    expect(() => store.restore(store.snapshot())).not.toThrow();
  });
});

describe('SupabaseRetentionStore — open-sweep lease check', () => {
  it('hasOpenSweepRunWithinWindow returns true when count > 0', async () => {
    const { store, selectCalls } = makeStore({ selectCount: 1 });
    expect(await store.hasOpenSweepRunWithinWindow(1_000_000, 5_000)).toBe(true);
    expect(selectCalls).toEqual([995_000]);
  });

  it('hasOpenSweepRunWithinWindow returns false when count = 0', async () => {
    const { store } = makeStore({ selectCount: 0 });
    expect(await store.hasOpenSweepRunWithinWindow(1_000_000, 5_000)).toBe(false);
  });
});

describe('SupabaseRetentionStore — error surface', () => {
  it('RPC error wraps into RetentionRpcError with fn name + cause', async () => {
    const { store } = makeStore({
      rpcErrors: (c) =>
        c.fn === 'retention_delete_for_event_type'
          ? { code: '22023', message: 'p_max_rows must be > 0' }
          : null
    });
    let caught: unknown;
    try {
      await store.deleteForEventType('session.revoked' as never, 0, 0);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RetentionRpcError);
    if (caught instanceof RetentionRpcError) {
      expect(caught.fn).toBe('retention_delete_for_event_type');
      expect(caught.cause.code).toBe('22023');
    }
  });

  it('select error surfaces from hasOpenSweepRunWithinWindow', async () => {
    const { store } = makeStore({
      selectCount: 0,
      selectError: { code: '42501', message: 'rls_denied' }
    });
    await expect(store.hasOpenSweepRunWithinWindow(0, 1000)).rejects.toBeInstanceOf(
      RetentionRpcError
    );
  });
});
