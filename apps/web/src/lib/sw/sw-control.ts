/**
 * Page → service-worker control-channel helper (G-T19-14 close).
 *
 * Sends a structured message to the active service worker controller
 * to trigger SW-side operations that can't reach the SW via the
 * page-side Cache Storage API alone.
 *
 * Today there's exactly one message: `clear-dynamic-caches`. It
 * triggers `clearDynamicCachesOnLock` inside the SW, which deletes
 * every cache NOT prefixed with `static-assets-` (so the app shell +
 * fonts survive across a lock; dynamic + locale caches are dropped).
 *
 * Why this exists vs. `panicWipe()`'s page-side cache clear:
 *
 *   `panicWipe()` (in `lib/lock/panic-wipe.ts`) already clears EVERY
 *   cache by enumerating `caches.keys()` from the page and deleting
 *   each — because page and SW share Cache Storage, the deletes
 *   reach the SW's caches without any messaging. That's the right
 *   posture for the most aggressive surface (intentional device
 *   wipe — nothing is preserved).
 *
 *   A future lock-on-idle event needs the LESS-AGGRESSIVE selective
 *   clear (keep static assets so unlock doesn't redownload the
 *   shell). That's what this messaging path is for. The lock-on-
 *   idle implementation (currently `lib/feature-flags.ts
 *   setupSafetyHandlers` no-op) calls this helper from its event
 *   hook.
 *
 * Safety: every call is gated by the SW-availability + controller-
 * presence checks below, so calling this on a UA without SW support
 * (or before the SW has activated) is a no-op rather than an error.
 */

export type SwControlMessage = { type: 'clear-dynamic-caches' };

/**
 * Send `{ type: 'clear-dynamic-caches' }` to the active SW so it
 * clears every non-static cache. No-op if there is no SW controller
 * (UA without SW support, dev mode where the SW is not registered,
 * or the SW has not activated yet).
 */
export function clearDynamicCachesViaServiceWorker(): void {
  if (typeof navigator === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  const controller = navigator.serviceWorker.controller;
  if (!controller) return;
  const msg: SwControlMessage = { type: 'clear-dynamic-caches' };
  controller.postMessage(msg);
}
