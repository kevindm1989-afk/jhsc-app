/**
 * T19.1 — G-T19-14 final close: page → SW control-channel messaging.
 *
 * Pins both ends of the `clear-dynamic-caches` message:
 *
 *   - `apps/web/src/service-worker.ts` has a `message` event listener
 *     that calls `clearDynamicCachesOnLock` when it receives
 *     `{ type: 'clear-dynamic-caches' }`.
 *
 *   - `apps/web/src/lib/sw/sw-control.ts` exports
 *     `clearDynamicCachesViaServiceWorker()` that sends the message
 *     via `navigator.serviceWorker.controller.postMessage`, gated
 *     on the SW being available + an active controller existing.
 *
 * The helper is wired now even though no caller fires it yet (the
 * future lock-on-idle implementation in `lib/feature-flags.ts
 * setupSafetyHandlers` will). panicWipe() does NOT use this path —
 * its page-side `caches.keys()` iteration reaches the SW's caches
 * directly because page and SW share Cache Storage.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SW_PATH = resolve(__dirname, '../../src/service-worker.ts');
const HELPER_PATH = resolve(__dirname, '../../src/lib/sw/sw-control.ts');

describe('T19.1 / G-T19-14 — SW message handler for clear-dynamic-caches', () => {
  const src = readFileSync(SW_PATH, 'utf8');

  it('imports clearDynamicCachesOnLock from $lib/sw', () => {
    expect(src).toMatch(/clearDynamicCachesOnLock\b/);
  });

  it('registers a `message` event listener', () => {
    expect(src).toMatch(/addEventListener\s*\(\s*['"]message['"]/);
  });

  it('dispatches on data.type === "clear-dynamic-caches"', () => {
    // Defense pin: the type-string match is the routing key. Drift
    // here would silently break the page-side helper, leaving the
    // lock-on-idle implementation calling into a no-op SW.
    expect(src).toMatch(/['"]clear-dynamic-caches['"]/);
  });

  it('calls clearDynamicCachesOnLock(self.caches ...) inside the message handler', () => {
    // The handler must invoke the library cleanup function, not
    // re-implement the "keep static, drop everything else" logic
    // inline. Allow the type cast wrapper around self.caches.
    expect(src).toMatch(/clearDynamicCachesOnLock\s*\([\s\S]{0,200}?self\.caches\b/);
  });
});

describe('T19.1 / G-T19-14 — page-side helper sw-control.ts', () => {
  it('the helper file exists at src/lib/sw/sw-control.ts', () => {
    expect(existsSync(HELPER_PATH)).toBe(true);
  });

  const src = readFileSync(HELPER_PATH, 'utf8');

  it('exports the SwControlMessage type with `clear-dynamic-caches` variant', () => {
    expect(src).toMatch(/export\s+type\s+SwControlMessage\s*=\s*\{\s*type:\s*['"]clear-dynamic-caches['"]\s*\}/);
  });

  it('exports clearDynamicCachesViaServiceWorker() with a void return', () => {
    expect(src).toMatch(/export\s+function\s+clearDynamicCachesViaServiceWorker\s*\(\s*\)\s*:\s*void/);
  });

  it('gates the postMessage on navigator + serviceWorker support (UA back-compat)', () => {
    // Defense pin: an unguarded call on a UA without SW support
    // throws TypeError. Same gating posture as the registration
    // call in hooks.client.ts.
    expect(src).toMatch(/['"]serviceWorker['"]\s+in\s+navigator/);
    expect(src).toMatch(/typeof\s+navigator\s*===\s*['"]undefined['"]/);
  });

  it('reads navigator.serviceWorker.controller and short-circuits if null (SW not yet active)', () => {
    // The controller is null until the SW activates AND the page
    // reloads (or claims clients via clients.claim() — which our
    // SW does). Short-circuit avoids posting a message into the
    // void in that window.
    expect(src).toMatch(/navigator\.serviceWorker\.controller/);
    expect(src).toMatch(/if\s*\(\s*!\s*controller\s*\)\s*return/);
  });

  it('posts the canonical message shape ({ type: "clear-dynamic-caches" })', () => {
    expect(src).toMatch(/postMessage\s*\(/);
    expect(src).toMatch(/type:\s*['"]clear-dynamic-caches['"]/);
  });
});
