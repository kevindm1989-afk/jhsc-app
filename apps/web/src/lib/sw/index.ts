/**
 * Service-worker skeleton — ADR-0013 cache allowlist.
 *
 * The closed allowlist is the contract: only the resources named here are
 * cached. Anything else, especially anything tagged
 * `X-Data-Class: C3` or `C4`, is rejected at the fetch handler.
 *
 * This is a SKELETON. The implementer of T10 (offline inspections) wires
 * the full snapshot test (apps/web/test/T10/sw-cache.snapshot.test.ts).
 * The shape below is just enough for that test to compile and the
 * snapshot to be regenerated.
 */

export const SW_VERSION = '0.0.0-scaffold';

/**
 * Closed allowlist of routes that may be cached. Adding an entry requires
 * a reviewer-gated change to apps/web/test/T10/sw-cache.expected-snapshot.json.
 */
export const CACHE_ALLOWLIST: readonly string[] = ['/', '/manifest.webmanifest', '/favicon.png'];

/**
 * Reject a Response whose X-Data-Class header marks it as sensitive.
 * Returns true if the response is safe to cache, false otherwise.
 */
export function isCacheable(response: Response): boolean {
  const dataClass = response.headers.get('X-Data-Class');
  if (dataClass === 'C3' || dataClass === 'C4') return false;
  return true;
}

/**
 * Compute the cache snapshot the T10 snapshot test compares against.
 * Returns a stable, lexically-sorted view of the allowlist + version.
 */
export function cacheSnapshot(): { version: string; allowlist: string[] } {
  return {
    version: SW_VERSION,
    allowlist: [...CACHE_ALLOWLIST].sort()
  };
}
