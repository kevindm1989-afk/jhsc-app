/**
 * T19.1 — G-T19-11 default-store re-onboard cycle.
 *
 * The gap: before G-T19-PRIV-3 (PR #36) shipped a real audit transport,
 * `BrowserWipeStore.emitAudit` always returned `{ok: false}`, so the
 * default-store path (`panicWipe()` with no `opts.store`) never reached
 * `__wipedStores.add` — every panic-wipe surfaced `audit_failed` and
 * destroyed nothing. With the audit emit dead, the gap couldn't test
 * the full re-onboard cycle: wipe → reset → wipe.
 *
 * PR #36 added the `auditEmitter` constructor option to
 * `BrowserWipeStore`, then PR #37 added the `createPanicWipeAuditEmitter`
 * adapter that bridges it to `SupabaseT07Client`. But the DEFAULT
 * singleton in `panic-wipe.ts` was constructed bare, so the production
 * default-store path still failed-closed.
 *
 * This PR closes that loop:
 *   - `panic-wipe.ts` exports `setDefaultStoreAuditEmitter(emitter)` so
 *     the default-store singleton can be wired without prop threading.
 *   - This test pins the full re-onboard cycle through the default
 *     singleton:
 *       1. Without an emitter, default-store wipe surfaces audit_failed.
 *       2. With an emitter wired, wipe completes and a second wipe on the
 *          SAME singleton is no_op (lockout from F-113 M-113a).
 *       3. `resetPanicWipeLockout()` re-issues the singleton.
 *       4. The new singleton picks up the SAME emitter (the emitter is
 *          NOT cleared by reset).
 *       5. Setting the emitter to `undefined` restores the bare
 *          fail-closed default.
 *       6. Swapping emitters mid-session re-issues the singleton.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  panicWipe,
  resetPanicWipeLockout,
  setDefaultStoreAuditEmitter
} from '../../src/lib/lock/panic-wipe';
import type { PanicWipeAuditEmitter } from '../../src/lib/lock/wipe-store';

// ---------------------------------------------------------------------------
// Minimal jsdom shims for the browser globals BrowserWipeStore touches.
// ---------------------------------------------------------------------------

function installShims(): void {
  const cacheNames = new Set<string>(['jhsc-static-v1', 'jhsc-api-v1']);
  const idbNames = new Set<string>(['jhsc-keystore', 'jhsc-queue', 'jhsc-prefs']);
  (globalThis as { caches?: unknown }).caches = {
    keys: async () => Array.from(cacheNames),
    delete: async (name: string) => {
      cacheNames.delete(name);
      return true;
    }
  };
  // Minimal IndexedDB: deleteDatabase fires onsuccess asynchronously.
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    deleteDatabase(name: string) {
      const req: {
        result?: unknown;
        error?: unknown;
        onsuccess?: () => void;
        onerror?: () => void;
        onblocked?: () => void;
      } = {};
      queueMicrotask(() => {
        idbNames.delete(name);
        req.onsuccess?.();
      });
      return req;
    }
  };
}

function removeShims(): void {
  delete (globalThis as { caches?: unknown }).caches;
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
}

beforeEach(() => {
  setDefaultStoreAuditEmitter(undefined);
});
afterEach(() => {
  setDefaultStoreAuditEmitter(undefined);
  resetPanicWipeLockout();
  removeShims();
});

function recordingEmitter(): {
  emitter: PanicWipeAuditEmitter;
  calls: Array<{ meta: Record<string, unknown> }>;
} {
  const calls: Array<{ meta: Record<string, unknown> }> = [];
  const emitter: PanicWipeAuditEmitter = {
    async recordPanicWipeInvoked(input) {
      calls.push(input);
      return { ok: true };
    }
  };
  return { emitter, calls };
}

describe('T19.1 / G-T19-11 — default-store re-onboard cycle', () => {
  it('without a wired audit emitter, default-store panicWipe returns audit_failed (pre-wire fail-closed)', async () => {
    installShims();
    const r = await panicWipe({ surface: 'settings' });
    expect(r.status).toBe('audit_failed');
  });

  it('with a wired audit emitter, default-store panicWipe completes + a second wipe on the SAME default singleton is no_op', async () => {
    installShims();
    const { emitter, calls } = recordingEmitter();
    setDefaultStoreAuditEmitter(emitter);

    const r1 = await panicWipe({ surface: 'settings' });
    expect(['completed', 'partially_completed']).toContain(r1.status);
    // The audit emitter saw the row (the precondition for __wipedStores.add).
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const callsAfterFirst = calls.length;

    const r2 = await panicWipe({ surface: 'settings' });
    expect(r2.status).toBe('no_op');
    expect((r2 as { reason?: string }).reason).toBe('already_wiped');
    // No second audit row (lockout short-circuits before emit).
    expect(calls.length).toBe(callsAfterFirst);
  });

  it('resetPanicWipeLockout() re-issues the default singleton; a fresh wipe is NOT no_op', async () => {
    installShims();
    const { emitter } = recordingEmitter();
    setDefaultStoreAuditEmitter(emitter);

    const r1 = await panicWipe({ surface: 'settings' });
    expect(['completed', 'partially_completed']).toContain(r1.status);

    // Simulate re-onboarding: D.7 calls resetPanicWipeLockout.
    resetPanicWipeLockout();

    const r2 = await panicWipe({ surface: 'settings' });
    expect(['completed', 'partially_completed']).toContain(r2.status);
    expect((r2 as { reason?: string }).reason).toBeUndefined();
  });

  it('resetPanicWipeLockout does NOT clear the audit emitter (re-issued singleton picks up the same emitter)', async () => {
    installShims();
    const { emitter, calls } = recordingEmitter();
    setDefaultStoreAuditEmitter(emitter);

    await panicWipe({ surface: 'settings' });
    resetPanicWipeLockout();
    await panicWipe({ surface: 'settings' });
    // Both wipes routed through the SAME emitter.
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('setDefaultStoreAuditEmitter(undefined) restores the bare fail-closed default + re-issues the singleton', async () => {
    installShims();
    const { emitter } = recordingEmitter();
    setDefaultStoreAuditEmitter(emitter);
    const r1 = await panicWipe({ surface: 'settings' });
    expect(['completed', 'partially_completed']).toContain(r1.status);

    setDefaultStoreAuditEmitter(undefined);
    // Fresh singleton with NO emitter — audit_failed again.
    const r2 = await panicWipe({ surface: 'settings' });
    expect(r2.status).toBe('audit_failed');
  });

  it('setDefaultStoreAuditEmitter swapping emitters re-issues the singleton mid-session', async () => {
    installShims();
    const a = recordingEmitter();
    const b = recordingEmitter();
    setDefaultStoreAuditEmitter(a.emitter);
    await panicWipe({ surface: 'settings' });
    // Swap to a fresh emitter (e.g. user re-authenticated with a new JWT).
    setDefaultStoreAuditEmitter(b.emitter);
    await panicWipe({ surface: 'settings' });
    expect(a.calls.length).toBeGreaterThanOrEqual(1);
    expect(b.calls.length).toBeGreaterThanOrEqual(1);
  });
});
