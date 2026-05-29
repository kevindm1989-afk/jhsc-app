/**
 * T19.1 — G-T19-14 post-wipe cleanup seam.
 *
 * The gap: `WipeStore` covers browser-managed storage (IDB / Cache
 * Storage / sessionStorage / localStorage / cookies). The
 * `session-jwt-store` singleton's `currentJwt` is module-private memory
 * the wipe-store interface CAN'T touch. Without a seam, a successful
 * panic-wipe would leave the in-memory JWT behind for any closure that
 * still holds a reference to `getJwt`.
 *
 * `setPostWipeCleanup(fn)` lets the integration layer register a hook
 * the orchestrator runs after destruction lands. This test pins the
 * call-conditions:
 *   - Fires on `completed` (destruction succeeded, audit row committed).
 *   - Fires on `partially_completed` (destruction was attempted, audit
 *     row(s) committed — the local state is torn down enough that
 *     surviving caches are forensically meaningless).
 *   - Does NOT fire on `audit_failed` (audit-before-side-effect: no
 *     destruction happened).
 *   - Does NOT fire on `no_op` / already_wiped (previous call already
 *     ran cleanup).
 *   - Throwing cleanup is swallowed (the wipe already destroyed local
 *     state; a buggy cleanup MUST NOT change the panic-wipe return).
 *   - `setPostWipeCleanup(undefined)` clears the registered hook.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  panicWipe,
  resetPanicWipeLockout,
  setDefaultStoreAuditEmitter,
  setPostWipeCleanup
} from '../../src/lib/lock/panic-wipe';
import type { PanicWipeAuditEmitter } from '../../src/lib/lock/wipe-store';

function installShims(): void {
  const cacheNames = new Set<string>(['jhsc-static-v1']);
  const idbNames = new Set<string>(['jhsc-keystore', 'jhsc-queue', 'jhsc-prefs']);
  (globalThis as { caches?: unknown }).caches = {
    keys: async () => Array.from(cacheNames),
    delete: async (name: string) => {
      cacheNames.delete(name);
      return true;
    }
  };
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

function recordingEmitter(opts: { ack?: boolean } = {}): {
  emitter: PanicWipeAuditEmitter;
} {
  const ack = opts.ack ?? true;
  return {
    emitter: {
      async recordPanicWipeInvoked() {
        return { ok: ack };
      }
    }
  };
}

beforeEach(() => {
  setDefaultStoreAuditEmitter(undefined);
  setPostWipeCleanup(undefined);
});

afterEach(() => {
  setPostWipeCleanup(undefined);
  setDefaultStoreAuditEmitter(undefined);
  resetPanicWipeLockout();
  removeShims();
});

describe('T19.1 / G-T19-14 — setPostWipeCleanup fires on real destruction only', () => {
  it('fires the cleanup after a `completed` wipe (default-store path)', async () => {
    installShims();
    setDefaultStoreAuditEmitter(recordingEmitter().emitter);
    const cleanup = vi.fn();
    setPostWipeCleanup(cleanup);

    const r = await panicWipe({ surface: 'settings' });
    expect(['completed', 'partially_completed']).toContain(r.status);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire the cleanup on `audit_failed` (audit-before-side-effect: no destruction happened)', async () => {
    installShims();
    // No emitter wired → BrowserWipeStore.emitAudit returns {ok:false} →
    // status: audit_failed, destruction_attempted: false.
    const cleanup = vi.fn();
    setPostWipeCleanup(cleanup);

    const r = await panicWipe({ surface: 'settings' });
    expect(r.status).toBe('audit_failed');
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('does NOT fire the cleanup on `no_op` / already_wiped (second call on same singleton)', async () => {
    installShims();
    setDefaultStoreAuditEmitter(recordingEmitter().emitter);
    const cleanup = vi.fn();
    setPostWipeCleanup(cleanup);

    await panicWipe({ surface: 'settings' });
    expect(cleanup).toHaveBeenCalledTimes(1);

    const r2 = await panicWipe({ surface: 'settings' });
    expect(r2.status).toBe('no_op');
    // Cleanup count unchanged — no_op MUST NOT trigger cleanup.
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing cleanup — the panic-wipe return shape is unchanged', async () => {
    installShims();
    setDefaultStoreAuditEmitter(recordingEmitter().emitter);
    const cleanup = vi.fn(() => {
      throw new Error('clearJwt blew up');
    });
    setPostWipeCleanup(cleanup);

    const r = await panicWipe({ surface: 'settings' });
    // Cleanup ran, threw, was swallowed — wipe still reports normal status.
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(['completed', 'partially_completed']).toContain(r.status);
  });

  it('setPostWipeCleanup(undefined) clears the registered cleanup (no fire on next wipe)', async () => {
    installShims();
    setDefaultStoreAuditEmitter(recordingEmitter().emitter);
    const cleanup = vi.fn();
    setPostWipeCleanup(cleanup);
    setPostWipeCleanup(undefined);

    await panicWipe({ surface: 'settings' });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('works back-compat when no cleanup is registered (no throw, no surprise)', async () => {
    installShims();
    setDefaultStoreAuditEmitter(recordingEmitter().emitter);
    // No setPostWipeCleanup call at all.

    const r = await panicWipe({ surface: 'settings' });
    expect(['completed', 'partially_completed']).toContain(r.status);
  });

  it('a fresh wipe after resetPanicWipeLockout() re-fires the cleanup (re-onboard cycle)', async () => {
    installShims();
    setDefaultStoreAuditEmitter(recordingEmitter().emitter);
    const cleanup = vi.fn();
    setPostWipeCleanup(cleanup);

    await panicWipe({ surface: 'settings' });
    expect(cleanup).toHaveBeenCalledTimes(1);

    resetPanicWipeLockout();

    await panicWipe({ surface: 'settings' });
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('fires the cleanup on the `partially_completed` path (one clear* fails)', async () => {
    // Shim a broken cookies path: caches.keys() works, but
    // tearDownSessionCookie's document.cookie writes throw via a
    // hostile Object.defineProperty getter. Mock a store directly to
    // avoid jsdom shim acrobatics — the orchestrator's branching is
    // store-agnostic.
    setDefaultStoreAuditEmitter(undefined);
    const cleanup = vi.fn();
    setPostWipeCleanup(cleanup);

    // Construct a custom store that surfaces one clear* as failed.
    const store = {
      nowMs: () => Date.now(),
      async emitAudit() {
        return { ok: true };
      },
      async clearIndexedDb() {
        return { ok: true, failed: [] };
      },
      async clearCaches() {
        return { ok: true, failed: [] };
      },
      async clearSessionStorage() {
        return { ok: true };
      },
      async clearLocalStorage() {
        return { ok: true };
      },
      async tearDownSessionCookie() {
        return { ok: false }; // partial failure
      }
    };

    const r = await panicWipe({ surface: 'settings', store });
    expect(r.status).toBe('partially_completed');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
