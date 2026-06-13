/**
 * SupabaseWatchdogStore unit tests (M9.B).
 *
 * Validates the contract surface against a mocked RPC shim; the SQL
 * function itself is covered by the pgTAP suite landed alongside
 * this PR (supabase/test/t18_watchdog_read_fn.sql).
 *
 * Source: apps/web/src/lib/audit-integrity/supabase-watchdog-store.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  SupabaseWatchdogStore,
  WatchdogRpcError,
  type SupabaseWatchdogRpc
} from '../../src/lib/audit-integrity/supabase-watchdog-store';
import { runWatchdogProbe } from '../../src/lib/audit-integrity';

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function makeStore(over?: {
  rpcReturns?: () => unknown;
  rpcErrors?: () => { code?: string; message: string } | null;
}): { store: SupabaseWatchdogStore; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const rpc: SupabaseWatchdogRpc = {
    async rpc(fn, args) {
      const call: RpcCall = { fn, args };
      calls.push(call);
      const err = over?.rpcErrors?.() ?? null;
      if (err) return { data: null, error: err };
      const data = over?.rpcReturns?.() ?? null;
      return { data, error: null };
    }
  };
  return { store: new SupabaseWatchdogStore({ rpc }), calls };
}

describe('SupabaseWatchdogStore — contract surface', () => {
  it('forwards the RPC call shape', async () => {
    const { store, calls } = makeStore({ rpcReturns: () => 1_700_000_000_000 });
    await store.mostRecentOkRunStartedAtMs();
    expect(calls).toEqual([
      { fn: 'integrity_check_most_recent_ok_started_at_ms', args: {} }
    ]);
  });

  it('coerces RPC bigint result to number', async () => {
    const { store } = makeStore({ rpcReturns: () => '1700000000000' });
    expect(await store.mostRecentOkRunStartedAtMs()).toBe(1_700_000_000_000);
  });

  it('returns null when RPC returns null (no ok-run ever recorded)', async () => {
    const { store } = makeStore({ rpcReturns: () => null });
    expect(await store.mostRecentOkRunStartedAtMs()).toBeNull();
  });

  it('throws WatchdogRpcError on RPC error', async () => {
    const { store } = makeStore({
      rpcErrors: () => ({ code: 'P0001', message: 'boom' })
    });
    await expect(store.mostRecentOkRunStartedAtMs()).rejects.toBeInstanceOf(WatchdogRpcError);
  });
});

describe('SupabaseWatchdogStore — end-to-end with runWatchdogProbe', () => {
  // Closes the loop: store -> runWatchdogProbe -> closed result shape.
  // No alert dispatch here; that's covered by the watchdog adapter tests.

  it('inside window → status ok', async () => {
    const now = 1_700_000_000_000;
    const { store } = makeStore({ rpcReturns: () => now - 60_000 });
    const r = await runWatchdogProbe({
      store,
      nowMs: () => now,
      window_ms: 9 * 60 * 60 * 1000
    });
    expect(r.status).toBe('ok');
  });

  it('outside window → status no_recent_pass + would_fire_alert', async () => {
    const now = 1_700_000_000_000;
    const { store } = makeStore({ rpcReturns: () => now - 10 * 60 * 60 * 1000 });
    const r = await runWatchdogProbe({
      store,
      nowMs: () => now,
      window_ms: 9 * 60 * 60 * 1000
    });
    expect(r.status).toBe('no_recent_pass');
    if (r.status === 'no_recent_pass') {
      expect(r.would_fire_alert).toBe('A-INTEGRITY-001');
    }
  });

  it('no ok-run ever → status no_recent_pass with null fields', async () => {
    const { store } = makeStore({ rpcReturns: () => null });
    const r = await runWatchdogProbe({
      store,
      nowMs: () => 1_700_000_000_000,
      window_ms: 9 * 60 * 60 * 1000
    });
    expect(r.status).toBe('no_recent_pass');
    if (r.status === 'no_recent_pass') {
      expect(r.most_recent_ok_ms).toBeNull();
      expect(r.age_ms).toBeNull();
    }
  });
});

describe('WatchdogRpcError', () => {
  it('exposes fn + cause', () => {
    const e = new WatchdogRpcError('integrity_check_most_recent_ok_started_at_ms', {
      code: 'P0001',
      message: 'boom'
    });
    expect(e.fn).toBe('integrity_check_most_recent_ok_started_at_ms');
    expect(e.cause.code).toBe('P0001');
    expect(e.message).toContain('integrity_check_most_recent_ok_started_at_ms');
    expect(e.message).toContain('P0001');
  });
});
