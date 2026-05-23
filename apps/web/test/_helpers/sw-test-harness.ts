/**
 * Service-worker test harness (T10 — HG-3 / ADR-0013).
 *
 * Provides a deterministic, in-memory Cache Storage that the SW module
 * (`apps/web/src/lib/sw/index.ts`) drives via the `CachesLike` interface.
 *
 * The harness does NOT execute a real service worker; it simulates the
 * install + activate + fetch handler lifecycle in-process so the snapshot
 * test runs in jsdom without a real SW runtime.
 *
 * Source obligations:
 *   - ADR-0013 — closed allowlist + X-Data-Class sanity + lock-clears +
 *     version-bump invalidation.
 *   - test-plan.md §3.E — fake Cache Storage harness.
 */

import {
  ALLOWLIST_VERSION,
  bucketForUrl,
  clearDynamicCachesOnLock,
  clearStaleVersionCaches,
  drainPendingCacheViolations,
  dynamicCacheName,
  enumerateCacheStorage as enumerateImpl,
  handleFetchResponse,
  localesCacheName,
  setServiceWorkerVersion,
  staticCacheName,
  type CacheLike,
  type CachesLike
} from '../../src/lib/sw/index';

// ---------------------------------------------------------------------------
// Fake Cache Storage
// ---------------------------------------------------------------------------

class FakeCache implements CacheLike {
  private entries = new Map<string, unknown>();
  async put(url: string, response: unknown): Promise<void> {
    this.entries.set(url, response);
  }
  async match(url: string): Promise<unknown | undefined> {
    return this.entries.get(url);
  }
  async keys(): Promise<{ url: string }[]> {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async delete(url: string): Promise<boolean> {
    return this.entries.delete(url);
  }
}

class FakeCaches implements CachesLike {
  private caches = new Map<string, FakeCache>();
  async open(name: string): Promise<CacheLike> {
    let c = this.caches.get(name);
    if (!c) {
      c = new FakeCache();
      this.caches.set(name, c);
    }
    return c;
  }
  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
}

// ---------------------------------------------------------------------------
// Module-level harness state
// ---------------------------------------------------------------------------

let fakeCaches: FakeCaches = new FakeCaches();
let currentVersion = 'build-test';

// ---------------------------------------------------------------------------
// install + activate
// ---------------------------------------------------------------------------

/**
 * Precache the app shell into the static-assets cache. Mirrors the
 * `install` event in production. The shell list here is the closed
 * allowlist's static bucket.
 */
const APP_SHELL_PRECACHE: ReadonlyArray<string> = [
  '/',
  '/_app/chunk-app.abc1230f.js',
  '/_app/chunk-vendor.def4561a.js',
  '/_app/style.fade5678.css',
  '/favicon.ico',
  '/manifest.webmanifest',
  '/schema-version'
];

const LOCALE_PRECACHE: ReadonlyArray<string> = ['/locales/en-CA.json'];

/**
 * Simulate a cold-cache SW install. Clears all caches, sets the build
 * version, populates the app-shell + locales caches per the closed
 * allowlist.
 */
export async function installServiceWorkerInColdCache(
  opts: { version?: string } = {}
): Promise<void> {
  fakeCaches = new FakeCaches();
  currentVersion = opts.version ?? 'build-test';
  setServiceWorkerVersion(currentVersion);
  const staticCache = await fakeCaches.open(staticCacheName(currentVersion));
  for (const url of APP_SHELL_PRECACHE) {
    await staticCache.put(url, makeStubResponse(url, 'static'));
  }
  const localesCache = await fakeCaches.open(localesCacheName(currentVersion));
  for (const url of LOCALE_PRECACHE) {
    await localesCache.put(url, makeStubResponse(url, 'locale'));
  }
}

/**
 * Bump the SW build version and clear stale caches.
 */
export async function bumpServiceWorkerVersion(newVersion: string): Promise<void> {
  currentVersion = newVersion;
  setServiceWorkerVersion(newVersion);
  await clearStaleVersionCaches(fakeCaches, newVersion);
  // Re-precache under the new version.
  const staticCache = await fakeCaches.open(staticCacheName(newVersion));
  for (const url of APP_SHELL_PRECACHE) {
    await staticCache.put(url, makeStubResponse(url, 'static'));
  }
  const localesCache = await fakeCaches.open(localesCacheName(newVersion));
  for (const url of LOCALE_PRECACHE) {
    await localesCache.put(url, makeStubResponse(url, 'locale'));
  }
}

// ---------------------------------------------------------------------------
// loginAndVisit — simulates navigation triggers
// ---------------------------------------------------------------------------

/**
 * Map each visited route to the set of network resources its first
 * paint would fetch (and whose responses are routed through the SW).
 * This is the deterministic mapping the snapshot test assertions hinge
 * on. Routes outside this map fetch only resources already in the
 * static cache (no new cache entries).
 */
const ROUTE_FETCHES: Record<string, Array<{ url: string; dataClass?: 'C3' | 'C4' }>> = {
  '/': [],
  '/inspections': [],
  '/concerns': [],
  '/reprisal': [],
  '/minutes': [],
  '/library': [{ url: '/library/ohsa-quickref' }],
  '/feature-flags': [{ url: '/feature-flags' }],
  // `/api/**` paths in the test fire to assert non-caching. The harness
  // surfaces them through handleFetchResponse to confirm the allowlist
  // refuses them.
  '/api/concerns': [{ url: '/api/concerns', dataClass: 'C3' }],
  '/api/feature-flags': [{ url: '/api/feature-flags' }],
  '/api/minutes/some-id': [{ url: '/api/minutes/some-id', dataClass: 'C3' }]
};

/**
 * Simulate logging in (no-op for the cache surface) and visiting the
 * given paths in order. Each visit fans out to the route's mapped
 * resource fetches, which are then routed through the SW fetch handler.
 */
export async function loginAndVisit(
  _user: { user_id: string },
  paths: ReadonlyArray<string>
): Promise<void> {
  for (const p of paths) {
    const fetches = ROUTE_FETCHES[p] ?? [];
    for (const f of fetches) {
      const headers = new Map<string, string>();
      if (f.dataClass) headers.set('X-Data-Class', f.dataClass);
      const response = {
        headers: { get: (n: string) => headers.get(n) ?? null }
      };
      await handleFetchResponse({ url: f.url }, response, fakeCaches);
    }
  }
}

// ---------------------------------------------------------------------------
// enumerateCacheStorage — snapshot surface
// ---------------------------------------------------------------------------

export async function enumerateCacheStorage(): Promise<
  Array<{ cache_name: string; url: string }>
> {
  return enumerateImpl(fakeCaches);
}

// ---------------------------------------------------------------------------
// craftResponseWithDataClass + routeFetchThroughSW (single-shot)
// ---------------------------------------------------------------------------

export interface CraftedResponse {
  url: string;
  body: string;
  headers: { get(name: string): string | null };
}

export function craftResponseWithDataClass(
  dataClass: 'C0' | 'C1' | 'C2' | 'C3' | 'C4',
  opts: { url: string; body: string }
): CraftedResponse {
  const headers = new Map<string, string>([['X-Data-Class', dataClass]]);
  return {
    url: opts.url,
    body: opts.body,
    headers: { get: (n: string) => headers.get(n) ?? null }
  };
}

export async function routeFetchThroughSW(
  response: CraftedResponse
): Promise<{ received_in_page: boolean }> {
  await handleFetchResponse({ url: response.url }, response, fakeCaches);
  // C3/C4 responses are NEVER cached but ARE forwarded to the page.
  // The harness's "received_in_page" is always true for the test path
  // here because we are simulating a fetch the page initiated.
  return { received_in_page: true };
}

// ---------------------------------------------------------------------------
// triggerLockOrPanicWipe
// ---------------------------------------------------------------------------

export async function triggerLockOrPanicWipe(
  _reason: 'lock' | 'logout' | 'panic'
): Promise<void> {
  await clearDynamicCachesOnLock(fakeCaches);
}

// ---------------------------------------------------------------------------
// Pending cache violations — exposed to the supabase-test harness so the
// `client.cache_policy_violation` audit row can be flushed on next online.
// ---------------------------------------------------------------------------

export function flushCacheViolationsForTest(): ReturnType<typeof drainPendingCacheViolations> {
  return drainPendingCacheViolations();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubResponse(
  _url: string,
  bucket: 'static' | 'locale' | 'dynamic'
): { headers: { get(n: string): string | null } } {
  const ct = bucket === 'static' ? 'application/javascript' : 'application/json';
  const headers = new Map<string, string>([['Content-Type', ct]]);
  return { headers: { get: (n: string) => headers.get(n) ?? null } };
}

/**
 * Test-only — expose the current cache-name suffix bucket helpers so
 * downstream assertions can construct expected names.
 */
export const __SW_TEST = {
  staticCacheName,
  localesCacheName,
  dynamicCacheName,
  bucketForUrl,
  ALLOWLIST_VERSION,
  get currentVersion() {
    return currentVersion;
  }
};
