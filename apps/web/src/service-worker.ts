/**
 * Service worker — minimal lifecycle scaffold (G-T19-14 partial close).
 *
 * SvelteKit auto-detects `src/service-worker.ts` and compiles it as a
 * separate `/service-worker.js` bundle in the adapter-static output.
 * The registration call lives in `hooks.client.ts` (gated on
 * `'serviceWorker' in navigator` + `import.meta.env.PROD`).
 *
 * Scope of this PR: register the SW + own the lifecycle. There is
 * INTENTIONALLY no `fetch` event handler in this file — without one,
 * the SW installs and activates but does not intercept any network
 * requests, so it can't break Edge Function calls, Supabase asset
 * loads, or anything else while we ship the registration path
 * first.
 *
 * The full cache-policy fetch handler (per ADR-0013 / lib/sw/index.ts
 * `bucketForUrl` + `handleFetchResponse`) lands in a follow-up PR
 * with its own focused test surface.
 *
 * Why skipWaiting + clients.claim:
 *
 *   The default SW lifecycle puts a new SW version into a "waiting"
 *   state until every open tab is closed. For a no-fetch-handler SW
 *   that's an awkward UX — users would see a stale SW version banner
 *   for hours. `skipWaiting()` activates the new SW immediately;
 *   `clients.claim()` takes control of every open client so they
 *   pick up the new version on the next navigation. Both are safe
 *   here BECAUSE we have no fetch handler that could conflict with
 *   the previous SW version's behaviour. When the follow-up PR adds
 *   fetch interception, the skipWaiting trade-off needs re-evaluation
 *   (a fetch handler swap mid-page-load can break in-flight requests).
 */

/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

// eslint-config: the project's flat config wires `globals.browser` +
// `globals.node` but not `globals.serviceworker`. Declaring the SW-only
// global names this file uses keeps the `no-undef` rule off while
// avoiding a config-wide change that would affect every other file.
/* global ServiceWorkerGlobalScope */

import { version } from '$service-worker';
import { setServiceWorkerVersion } from '$lib/sw';

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
  // Take control of every open client so they pick up the new SW
  // immediately on the next navigation. Without `clients.claim()`,
  // existing tabs would keep talking to the previous SW until they
  // close + reopen.
  event.waitUntil(self.clients.claim());
});

// NOTE: no `fetch` event handler. This is intentional for the
// minimal-scaffold scope (G-T19-14 partial close). The follow-up
// PR wires `bucketForUrl` + `handleFetchResponse` from $lib/sw to
// realize ADR-0013's closed-allowlist cache policy.
