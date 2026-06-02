/**
 * Service worker — cache-policy fetch handler (G-T19-14 close).
 *
 * SvelteKit auto-detects `src/service-worker.ts` and compiles it as a
 * separate `/service-worker.js` bundle in the adapter-static output.
 * The registration call lives in `hooks.client.ts` (gated on
 * `'serviceWorker' in navigator` + `import.meta.env.PROD`).
 *
 * Scope: per ADR-0013 the SW caches only allowlisted URLs (static /
 * locales / dynamic buckets). The fetch handler implements:
 *
 *   - **Pass-through for non-GET** — POST / PUT / DELETE bypass the
 *     cache entirely (Edge Function calls, audit emissions).
 *   - **Pass-through for non-allowlisted URLs** — `bucketForUrl()`
 *     returns null and the SW lets the browser handle the request
 *     directly. /api/** is never cached (ADR-0013 rule 2).
 *   - **Cache-first for static + locales** — these are immutable
 *     across a deploy (build hash in the URL for static; locale
 *     files turn over at the locale-pass cadence, not per page). On
 *     a cache hit, serve from cache and trigger a stale-while-
 *     revalidate refresh in the background.
 *   - **Network-first for dynamic** — the dynamic bucket carries
 *     low-PI items (feature-flags, public library content) that may
 *     change between requests. Prefer the network; fall back to
 *     cache on network failure.
 *   - **X-Data-Class C3/C4 reject** — handled inside
 *     `handleFetchResponse`: responses tagged C3/C4 are forwarded to
 *     the page but never cached, and a `client.cache_policy_violation`
 *     audit row is queued (consumed by the next online audit drain).
 *
 * The `activate` handler also calls `clearStaleVersionCaches` so a
 * new deploy's SW purges every prior-build cache, forcing fresh
 * population against the new build.
 *
 * Clear-on-lock messaging (BroadcastChannel/postMessage from the
 * page-side panic-wipe / lock to the SW so it calls
 * `clearDynamicCachesOnLock`) is the one remaining ADR-0013 wire-up;
 * deferred to a focused follow-up because it requires its own
 * cross-thread protocol design.
 */

/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

// eslint-config: the project's flat config wires `globals.browser` +
// `globals.node` but not `globals.serviceworker`. Declaring the SW-only
// global names this file uses keeps the `no-undef` rule off while
// avoiding a config-wide change that would affect every other file.
/* global ServiceWorkerGlobalScope */

import { version } from '$service-worker';
import {
  bucketForUrl,
  clearStaleVersionCaches,
  dynamicCacheName,
  handleFetchResponse,
  localesCacheName,
  setServiceWorkerVersion,
  staticCacheName
} from '$lib/sw';

// `self` in a service-worker context is a `ServiceWorkerGlobalScope`,
// not a `Window`. The `lib="webworker"` reference above brings the
// type in; the local declaration narrows the ambient `self` to it so
// `addEventListener` is typed against the SW event map (giving
// `ExtendableEvent` for install / activate handlers).
declare const self: ServiceWorkerGlobalScope;

// Wire the SvelteKit build version into the cache-name strategy in
// $lib/sw. Each named cache (`static-assets-${version}`, `locales-
// ${version}`, `dynamic-${version}`) carries this string as a
// suffix so a new deploy gets fresh caches and the `activate`
// handler can purge prior-build caches by version-mismatch.
setServiceWorkerVersion(version);

self.addEventListener('install', (event) => {
  // No pre-caching yet (deferred to the follow-up PR). Skip the
  // "waiting" state so the new SW activates immediately on install
  // — safe here because no fetch handler is registered, so there's
  // no behaviour to clobber from the previous SW version.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  // Two activate-time obligations:
  //   1. Take control of every open client so they pick up the new
  //      SW immediately on the next navigation. Without
  //      `clients.claim()`, existing tabs would keep talking to the
  //      previous SW until they close + reopen.
  //   2. Purge every cache whose name doesn't carry the new build
  //      version. ADR-0013 rule 5: a SW version bump invalidates
  //      every prior-build cache so the next fetch repopulates
  //      against the current build's hashes.
  event.waitUntil(
    (async () => {
      // Cast: native CacheStorage is structurally compatible with the
      // library's narrower `CachesLike` (the test-friendly interface
      // uses `{ url: string }[]` for keys, which native `Request[]`
      // satisfies value-wise but doesn't match TS-shape variance).
      await clearStaleVersionCaches(
        self.caches as unknown as Parameters<typeof clearStaleVersionCaches>[0]
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Pass-through for non-GET — POST/PUT/DELETE bypass the cache
  // entirely (Edge Function calls, audit emissions, mint-session).
  // Caching those would risk replaying state-changing requests.
  if (req.method !== 'GET') return;

  // Pass-through for non-allowlisted URLs. The browser handles them
  // directly; the SW does not intercept. ADR-0013 rule 2: /api/**
  // is never cached, which `bucketForUrl` enforces by returning null.
  const bucket = bucketForUrl(new URL(req.url).pathname);
  if (bucket === null) return;

  // Cache strategy per bucket (see the file header).
  if (bucket === 'static' || bucket === 'locales') {
    event.respondWith(cacheFirst(req, bucket));
  } else {
    event.respondWith(networkFirst(req));
  }
});

function cacheNameFor(bucket: 'static' | 'locales' | 'dynamic'): string {
  return bucket === 'static'
    ? staticCacheName()
    : bucket === 'locales'
      ? localesCacheName()
      : dynamicCacheName();
}

async function cacheFirst(req: Request, bucket: 'static' | 'locales'): Promise<Response> {
  // Try cache first. On hit, fire a background refresh (stale-while-
  // revalidate) so the next request gets the fresher copy without
  // delaying THIS request. On miss, fetch + cache + return.
  const cache = await caches.open(cacheNameFor(bucket));
  const pathname = new URL(req.url).pathname;
  const cached = await cache.match(pathname);
  if (cached) {
    // Stale-while-revalidate. Ignore failures — the cached copy is
    // already returned; the refresh is best-effort.
    fetch(req)
      .then((fresh) =>
        handleFetchResponse(
          { url: req.url },
          fresh,
          caches as unknown as Parameters<typeof handleFetchResponse>[2]
        )
      )
      .catch(() => undefined);
    return cached as Response;
  }
  const fresh = await fetch(req);
  // Defer the cache decision to handleFetchResponse so the
  // X-Data-Class C3/C4 reject path runs uniformly.
  await handleFetchResponse(
    { url: req.url },
    fresh.clone(),
    caches as unknown as Parameters<typeof handleFetchResponse>[2]
  );
  return fresh;
}

async function networkFirst(req: Request): Promise<Response> {
  // Prefer the network so the dynamic bucket carries fresh data
  // (feature-flags, library content). Fall back to cache only if
  // the network throws (offline / DNS failure / timeout).
  try {
    const fresh = await fetch(req);
    await handleFetchResponse(
      { url: req.url },
      fresh.clone(),
      caches as unknown as Parameters<typeof handleFetchResponse>[2]
    );
    return fresh;
  } catch (err) {
    const cache = await caches.open(cacheNameFor('dynamic'));
    const pathname = new URL(req.url).pathname;
    const cached = await cache.match(pathname);
    if (cached) return cached as Response;
    throw err;
  }
}
