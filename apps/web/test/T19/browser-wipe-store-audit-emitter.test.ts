/**
 * T19 — G-T19-PRIV-3 BrowserWipeStore.emitAudit production wire-up.
 *
 * Before this PR, `BrowserWipeStore.emitAudit` was a fail-closed stub
 * that returned `{ok: false}` unconditionally. The gap was the missing
 * production transport for the `panic_wipe.invoked` audit row. This file
 * pins the new contract:
 *
 *   - When NO `auditEmitter` is wired the store stays fail-closed
 *     (back-compat with the existing F-53 / M-106a posture).
 *   - When an emitter IS wired, `emitAudit` forwards the row's `meta`
 *     verbatim to `recordPanicWipeInvoked` and returns whatever the
 *     emitter returns.
 *   - When the emitter THROWS (transport / network error) the store
 *     stays fail-closed so the audit-before-side-effect contract holds
 *     even under flaky connectivity.
 *
 * The actual SupabaseT07Client adapter (which routes the call to the
 * t07-op `record_panic_wipe` op) is covered by
 * `supabase-t07-client.test.ts`; this file tests the WipeStore-side
 * surface in isolation with a stub emitter.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BrowserWipeStore,
  type PanicWipeAuditEmitter,
  type PanicWipeAuditRow
} from '../../src/lib/lock/wipe-store';

function sampleRow(
  overrides: Partial<PanicWipeAuditRow['meta']> = {}
): PanicWipeAuditRow {
  return {
    event_type: 'panic_wipe.invoked',
    ts: 1_700_000_000_000,
    meta: {
      surface: 'settings',
      wipe_scope: 'local_only',
      completed: true,
      partial_failure_classes: [],
      ...overrides
    }
  };
}

describe('T19 / G-T19-PRIV-3 — BrowserWipeStore.emitAudit', () => {
  it('stays fail-closed when no auditEmitter is wired (back-compat)', async () => {
    const store = new BrowserWipeStore();
    const result = await store.emitAudit(sampleRow());
    expect(result.ok).toBe(false);
  });

  it('forwards the row meta verbatim to the emitter + returns its result', async () => {
    const calls: Array<{ meta: Record<string, unknown> }> = [];
    const emitter: PanicWipeAuditEmitter = {
      async recordPanicWipeInvoked(input) {
        calls.push(input);
        return { ok: true };
      }
    };
    const store = new BrowserWipeStore({ auditEmitter: emitter });
    const row = sampleRow({
      surface: 'lock_screen',
      completed: false,
      partial_failure_classes: ['indexeddb', 'caches']
    });
    const result = await store.emitAudit(row);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.meta).toEqual(row.meta);
  });

  it('returns { ok: false } when the emitter returns { ok: false }', async () => {
    const emitter: PanicWipeAuditEmitter = {
      async recordPanicWipeInvoked() {
        return { ok: false };
      }
    };
    const store = new BrowserWipeStore({ auditEmitter: emitter });
    const result = await store.emitAudit(sampleRow());
    expect(result.ok).toBe(false);
  });

  it('catches a thrown emitter error and surfaces it as { ok: false } (fail-closed under network failure)', async () => {
    const emitter: PanicWipeAuditEmitter = {
      async recordPanicWipeInvoked() {
        throw new Error('network error');
      }
    };
    const store = new BrowserWipeStore({ auditEmitter: emitter });
    const result = await store.emitAudit(sampleRow());
    expect(result.ok).toBe(false);
  });

  it('does NOT pass the row.event_type or row.ts to the emitter (server stamps both)', async () => {
    const recordSpy = vi.fn(async () => ({ ok: true }));
    const emitter: PanicWipeAuditEmitter = { recordPanicWipeInvoked: recordSpy };
    const store = new BrowserWipeStore({ auditEmitter: emitter });
    await store.emitAudit(sampleRow());
    const arg = recordSpy.mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect((arg as Record<string, unknown>)?.event_type).toBeUndefined();
    expect((arg as Record<string, unknown>)?.ts).toBeUndefined();
    expect((arg as { meta: Record<string, unknown> }).meta).toBeDefined();
  });
});
