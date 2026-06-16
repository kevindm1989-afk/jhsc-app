/**
 * Service-worker cache policy (T10 — HG-3 / ADR-0013).
 *
 * Closed allowlist by data classification. The fetch handler enforces:
 *   1. URLs matching the allowlist are cached in the appropriate named
 *      cache (static / locales / dynamic).
 *   2. `/api/**` is never cached.
 *   3. Responses with `X-Data-Class: C3` or `C4` are forwarded to the
 *      page but rejected from any cache; a `client.cache_policy_violation`
 *      audit row is queued for next online.
 *   4. Lock / logout / panic-wipe deletes every cache not in the static-
 *      asset allowlist (dynamic + locale caches are cleared).
 *   5. SW version bump (build-hash mismatch) deletes every prior-build
 *      cache and forces a fresh population.
 *
 * Source obligations:
 *   - ADR-0013 — closed URL allowlist + X-Data-Class sanity check + clear
 *     on lock/logout/panic + version-bump invalidation.
 *   - threat-model §3.5 F-10 — no `/api/**` plaintext in Cache Storage.
 *   - audit-log.md §1 — `client.cache_policy_violation`.
 *   - alerts.md — HG-3 cache-policy regression detector.
 *
 * This module is JS-runnable in both production (real service-worker
 * context with native `caches`/`Cache`) and in the test harness (which
 * injects a fake Cache Storage). All cache mutations go through the
 * `CachesLike` interface so the test harness can observe them.
 */

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

export const ALLOWLIST_VERSION = 'v1';

/**
 * Default service-worker build version. Production replaces this at
 * build time via a Vite define / SvelteKit version file. Tests override
 * via `setServiceWorkerVersion(...)` in the harness.
 */
let SW_BUILD_VERSION = 'build-test';

export function setServiceWorkerVersion(v: string): void {
  SW_BUILD_VERSION = v;
}

export function getServiceWorkerVersion(): string {
  return SW_BUILD_VERSION;
}

// ---------------------------------------------------------------------------
// Cache name strategy
// ---------------------------------------------------------------------------

/** Cache name buckets — each carries the SW build version as a suffix. */
export function staticCacheName(version: string = SW_BUILD_VERSION): string {
  return `static-assets-${version}`;
}
export function localesCacheName(version: string = SW_BUILD_VERSION): string {
  return `locales-${version}`;
}
export function dynamicCacheName(version: string = SW_BUILD_VERSION): string {
  return `dynamic-${version}`;
}

// ---------------------------------------------------------------------------
// URL allowlist
// ---------------------------------------------------------------------------

/**
 * Closed URL allowlist per ADR-0013. Each entry maps a URL pattern (a
 * literal string or a RegExp) to the cache bucket it belongs to. Any
 * URL not matching this list is bypassed (network-only).
 */
interface AllowlistEntry {
  match: (url: string) => boolean;
  bucket: 'static' | 'locales' | 'dynamic';
}

const ALLOWLIST: ReadonlyArray<AllowlistEntry> = [
  // App shell
  { match: (u) => u === '/' || u === '/index.html', bucket: 'static' },
  { match: (u) => u === '/manifest.webmanifest', bucket: 'static' },
  { match: (u) => /^\/favicon\.(ico|png|svg)$/.test(u), bucket: 'static' },
  // Build outputs (chunks, styles). The hash segment is preserved in the
  // cache key; the snapshot test normalises `/_app/<chunk>.<hash>.<ext>`
  // to `/_app/<chunk>.[hash].<ext>` for stable comparison.
  { match: (u) => /^\/_app\/.+\.(js|css|woff2?)$/.test(u), bucket: 'static' },
  // Build-info / schema
  { match: (u) => u === '/schema-version', bucket: 'static' },
  // Locales — C0 public
  { match: (u) => /^\/locales\/[a-z]{2}-[A-Z]{2}\.json$/.test(u), bucket: 'locales' },
  // C0 library — public regulatory text
  { match: (u) => /^\/library\/[\w-]+$/.test(u), bucket: 'dynamic' },
  // C1 — feature flags + schema bits (24h max-age — enforced upstream)
  { match: (u) => u === '/feature-flags', bucket: 'dynamic' }
];

/**
 * Determine which cache bucket a URL belongs to, or `null` if it must
 * never be cached.
 */
export function bucketForUrl(url: string): 'static' | 'locales' | 'dynamic' | null {
  // ADR-0013 rule 2 — anything under /api/** is NEVER cached.
  if (/^\/api\//.test(url)) return null;
  for (const e of ALLOWLIST) {
    if (e.match(url)) return e.bucket;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Response sanity check (X-Data-Class)
// ---------------------------------------------------------------------------

/**
 * Returns true iff the response is safe to cache by class. C3/C4
 * responses are forwarded but never cached.
 */
export function isResponseCacheable(response: {
  headers: { get(name: string): string | null };
}): boolean {
  const dataClass = response.headers.get('X-Data-Class');
  if (dataClass === 'C3' || dataClass === 'C4') return false;
  return true;
}

// ---------------------------------------------------------------------------
// CachesLike — the abstraction over Cache Storage
// ---------------------------------------------------------------------------

export interface CacheLike {
  put(url: string, response: unknown): Promise<void>;
  match(url: string): Promise<unknown | undefined>;
  keys(): Promise<{ url: string }[]>;
  delete(url: string): Promise<boolean>;
}

export interface CachesLike {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Pending audit emission (queued offline)
// ---------------------------------------------------------------------------

export interface PendingCacheViolation {
  event_type: 'client.cache_policy_violation';
  meta: {
    route: string;
    data_class: 'C3' | 'C4';
    allowlist_version: string;
  };
  queued_at: string;
}

/**
 * G-T10-16 — intentionally module-scoped state.
 *
 * `pendingViolations` is a process-singleton: it lives at module scope
 * and is shared across every consumer of this file within a JS realm.
 * That matches the production runtime exactly — a real ServiceWorker
 * is itself a per-origin singleton, so a per-instance queue would just
 * duplicate effort.
 *
 * The downside: the test harness lacks per-test isolation and relies
 * on the `tearDown` ordering inside `apps/web/test/_helpers/supabase-
 * test.ts` to drain this array between tests. The harness today calls
 * `drainPendingCacheViolations()` during cleanup; a future regression
 * that adds a new test path without that tear-down step would see
 * leaked violations from the previous test.
 *
 * Resolution if leakage becomes a real issue: bind this state to a
 * `CachesLike` instance (the ADR-0013 store handle). For now the
 * module-scoped behaviour is intentional and matches production.
 */
const pendingViolations: PendingCacheViolation[] = [];

/** Test/observability surface — pop the queued violations. */
export function drainPendingCacheViolations(): PendingCacheViolation[] {
  return pendingViolations.splice(0, pendingViolations.length);
}

/** Test/observability surface — peek without draining. */
export function peekPendingCacheViolations(): PendingCacheViolation[] {
  return [...pendingViolations];
}

// ---------------------------------------------------------------------------
// Fetch handler — the on-route cache decision
// ---------------------------------------------------------------------------

/**
 * Handle a fetched response: decide whether to cache it, and emit any
 * sanity-check violations.
 *
 * The `cachesImpl` parameter is provided by tests; production wires the
 * native `caches` global at the fetch-handler boundary.
 */
export async function handleFetchResponse(
  request: { url: string },
  response: {
    headers: { get(name: string): string | null };
    clone?: () => unknown;
  },
  cachesImpl: CachesLike
): Promise<void> {
  // Normalise URL to pathname for the allowlist match.
  const pathname = urlToPathname(request.url);

  // ADR-0013 rule 3 — X-Data-Class sanity check.
  if (!isResponseCacheable(response)) {
    const dataClass = response.headers.get('X-Data-Class') as 'C3' | 'C4';
    pendingViolations.push({
      event_type: 'client.cache_policy_violation',
      meta: {
        route: pathname,
        data_class: dataClass,
        allowlist_version: ALLOWLIST_VERSION
      },
      queued_at: new Date().toISOString()
    });
    return;
  }

  // Closed allowlist.
  const bucket = bucketForUrl(pathname);
  if (bucket === null) return;

  const cacheName =
    bucket === 'static'
      ? staticCacheName()
      : bucket === 'locales'
        ? localesCacheName()
        : dynamicCacheName();
  const cache = await cachesImpl.open(cacheName);
  await cache.put(pathname, response);
}

/**
 * Strip protocol/host from a URL and return the pathname-only form. The
 * allowlist matches on path-only.
 */
function urlToPathname(url: string): string {
  // Accept already-pathname inputs.
  if (url.startsWith('/')) return url.split('?')[0]!.split('#')[0]!;
  try {
    const parsed = new URL(url, 'http://localhost');
    return parsed.pathname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Lock / logout / panic-wipe — drop dynamic + locale caches
// ---------------------------------------------------------------------------

/**
 * Delete every cache not in the static-asset allowlist. Static-asset
 * caches survive (they hold no PI by ADR-0013 classification).
 */
export async function clearDynamicCachesOnLock(cachesImpl: CachesLike): Promise<void> {
  const names = await cachesImpl.keys();
  for (const name of names) {
    if (name.startsWith('static-assets-')) continue;
    await cachesImpl.delete(name);
  }
}

// ---------------------------------------------------------------------------
// Version bump — delete every cache from a prior build
// ---------------------------------------------------------------------------

/**
 * When the SW build version bumps, delete every cache whose name does
 * not carry the new version. This forces a fresh fetch + repopulate.
 */
export async function clearStaleVersionCaches(
  cachesImpl: CachesLike,
  currentVersion: string = SW_BUILD_VERSION
): Promise<void> {
  const names = await cachesImpl.keys();
  for (const name of names) {
    if (!name.endsWith(`-${currentVersion}`)) {
      await cachesImpl.delete(name);
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot — for the T10 snapshot test
// ---------------------------------------------------------------------------

/**
 * Enumerate every cache + URL across the SW Cache Storage. The result is
 * the "what is cached right now" view the snapshot test asserts against.
 */
export async function enumerateCacheStorage(
  cachesImpl: CachesLike
): Promise<Array<{ cache_name: string; url: string }>> {
  const out: Array<{ cache_name: string; url: string }> = [];
  const names = await cachesImpl.keys();
  for (const name of names) {
    const cache = await cachesImpl.open(name);
    const keys = await cache.keys();
    for (const k of keys) {
      out.push({ cache_name: name, url: k.url });
    }
  }
  return out;
}
