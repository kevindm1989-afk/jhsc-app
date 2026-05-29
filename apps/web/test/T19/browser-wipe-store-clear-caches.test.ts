/**
 * T19.1 — G-T19-8 BrowserWipeStore.clearCaches dynamic-enumeration
 * contract.
 *
 * The gap text:
 *
 *   > The production-side `BrowserWipeStore.clearCaches` implementation
 *   > MUST iterate via `await caches.keys()` and
 *   > `await Promise.all(keys.map(k => caches.delete(k)))` to capture all
 *   > caches present at wipe time.
 *
 * The pre-existing d6 test ('clears every cache returned by caches.keys()')
 * asserted a weaker contract — it called `store.clearCaches(await
 * caches.keys())` and verified deletion happened. That passed even when
 * the BrowserWipeStore implementation iterated the caller-supplied list,
 * so a future caller passing a stale list would silently miss caches.
 *
 * This file pins the strong contract:
 *   - BrowserWipeStore.clearCaches IGNORES the caller-supplied list and
 *     enumerates via caches.keys() instead.
 *   - When caches.keys() returns more entries than the caller asked for,
 *     those extras ARE deleted (the security-relevant case: a future
 *     SW-cache addition not yet in the caller's allowlist).
 *   - When caches.keys() returns fewer entries than the caller asked for
 *     (the unusual case: caller asked for a no-longer-present cache),
 *     the result is { ok: true, failed: [] } — nothing to wipe.
 *   - When caches.keys() throws, the caller-supplied list surfaces as
 *     `failed` so the audit-row partial_failure_classes carries
 *     forensic context.
 *   - When the Cache Storage API is absent (e.g. SSR / jsdom no-shim),
 *     the caller-supplied list also surfaces as `failed`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserWipeStore } from '../../src/lib/lock/wipe-store';

interface CacheShim {
  keys: () => Promise<string[]>;
  delete: (name: string) => Promise<boolean>;
}

function installCaches(shim: CacheShim) {
  (globalThis as { caches?: CacheShim }).caches = shim;
}
function removeCaches() {
  delete (globalThis as { caches?: unknown }).caches;
}

beforeEach(() => removeCaches());
afterEach(() => removeCaches());

describe('T19.1 / G-T19-8 — BrowserWipeStore.clearCaches dynamic enumeration', () => {
  it('enumerates caches via caches.keys() and clears EVERY one present (even ones not in the caller list)', async () => {
    const present = new Set(['cache-a', 'cache-b', 'sw-future-cache-not-in-allowlist']);
    installCaches({
      keys: async () => Array.from(present),
      delete: async (name: string) => {
        present.delete(name);
        return true;
      }
    });
    const store = new BrowserWipeStore();
    // The caller-supplied list is intentionally STALE — missing the
    // 'sw-future-cache-not-in-allowlist' entry. The store must wipe it
    // anyway because of dynamic enumeration.
    const r = await store.clearCaches(['cache-a', 'cache-b']);
    expect(r.ok).toBe(true);
    expect(r.failed).toEqual([]);
    expect(present.size).toBe(0);
  });

  it('returns { ok: true, failed: [] } when caches.keys() is empty even if caller asked to wipe something', async () => {
    installCaches({
      keys: async () => [],
      delete: async () => true
    });
    const store = new BrowserWipeStore();
    const r = await store.clearCaches(['cache-a-already-gone']);
    expect(r.ok).toBe(true);
    expect(r.failed).toEqual([]);
  });

  it('does NOT iterate the caller-supplied list (defensive contract pin)', async () => {
    const deleteCalls: string[] = [];
    installCaches({
      keys: async () => ['only-dynamic-one'],
      delete: async (name: string) => {
        deleteCalls.push(name);
        return true;
      }
    });
    const store = new BrowserWipeStore();
    await store.clearCaches(['NOT_IN_caches_keys_a', 'NOT_IN_caches_keys_b']);
    expect(deleteCalls).toEqual(['only-dynamic-one']);
  });

  it('surfaces caller-supplied list as `failed` when caches.keys() throws (forensic context preserved)', async () => {
    installCaches({
      keys: async () => {
        throw new Error('boom');
      },
      delete: async () => true
    });
    const store = new BrowserWipeStore();
    const r = await store.clearCaches(['cache-a', 'cache-b']);
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual(['cache-a', 'cache-b']);
  });

  it('surfaces caller-supplied list as `failed` when the Cache Storage API is absent', async () => {
    // No installCaches() — `globalThis.caches` is undefined.
    const store = new BrowserWipeStore();
    const r = await store.clearCaches(['cache-a', 'cache-b']);
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual(['cache-a', 'cache-b']);
  });

  it('collects per-cache delete failures into `failed`', async () => {
    installCaches({
      keys: async () => ['ok-cache', 'broken-cache'],
      delete: async (name: string) => {
        if (name === 'broken-cache') throw new Error('cache delete failed');
        return true;
      }
    });
    const store = new BrowserWipeStore();
    const r = await store.clearCaches([]);
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual(['broken-cache']);
  });

  it('treats a `delete(name) === false` return as a failure (delete reported "not deleted")', async () => {
    installCaches({
      keys: async () => ['cache-a'],
      delete: async () => false
    });
    const store = new BrowserWipeStore();
    const r = await store.clearCaches([]);
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual(['cache-a']);
  });
});
