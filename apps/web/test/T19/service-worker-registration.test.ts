/**
 * T19.1 — G-T19-14 partial close: service-worker registration scaffold.
 *
 * Structural pin for the two files that together register the SW:
 *
 *   - `apps/web/src/service-worker.ts` — SvelteKit auto-detects this
 *     filename and compiles it into `/service-worker.js` in the
 *     adapter-static output. Hosts the minimal `install` + `activate`
 *     handlers plus the `setServiceWorkerVersion(version)` wire-up
 *     from `$service-worker`'s build version.
 *
 *   - `apps/web/src/hooks.client.ts` — the existing client-side
 *     hooks module. Carries the registration call gated on
 *     `'serviceWorker' in navigator` + `import.meta.env.PROD`.
 *
 * Scope contract this file enforces:
 *
 *   - The SW file exists at the SvelteKit-canonical path.
 *   - It imports `version` from `$service-worker` and calls
 *     `setServiceWorkerVersion(version)` — so cache names carry the
 *     build version when the follow-up PR wires the fetch handler.
 *   - It has `install` + `activate` event handlers with
 *     `skipWaiting()` + `clients.claim()` so the SW activates
 *     immediately rather than sitting in "waiting".
 *   - It INTENTIONALLY has no `fetch` event handler (the follow-up
 *     PR ships that; defending against a premature add ensures the
 *     scope split is intentional).
 *
 *   - hooks.client.ts has the registration call.
 *   - The call is gated on the UA probe (`'serviceWorker' in
 *     navigator`) so older UAs don't hard-fail.
 *   - The call is gated on `import.meta.env.PROD` so dev iterations
 *     don't pick up cached stale bundles.
 *   - Registration uses `type: 'module'` + `scope: '/'`.
 *   - Errors route through the structured logger.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SW_PATH = resolve(__dirname, '../../src/service-worker.ts');
const HOOKS_PATH = resolve(__dirname, '../../src/hooks.client.ts');

describe('T19.1 / G-T19-14 — src/service-worker.ts scaffold', () => {
  it('the SW file exists at the SvelteKit-canonical path', () => {
    expect(existsSync(SW_PATH)).toBe(true);
  });

  it('imports `version` from $service-worker (SvelteKit virtual module)', () => {
    const src = readFileSync(SW_PATH, 'utf8');
    expect(src).toMatch(/import\s*{[^}]*\bversion\b[^}]*}\s*from\s*['"]\$service-worker['"]/);
  });

  it('imports setServiceWorkerVersion from $lib/sw and calls it with the build version', () => {
    const src = readFileSync(SW_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*{[^}]*setServiceWorkerVersion[^}]*}\s*from\s*['"]\$lib\/sw['"]/
    );
    expect(src).toMatch(/setServiceWorkerVersion\s*\(\s*version\s*\)/);
  });

  it('registers an `install` event handler with skipWaiting()', () => {
    const src = readFileSync(SW_PATH, 'utf8');
    expect(src).toMatch(/addEventListener\s*\(\s*['"]install['"]/);
    expect(src).toMatch(/\.skipWaiting\s*\(\s*\)/);
  });

  it('registers an `activate` event handler with clients.claim()', () => {
    const src = readFileSync(SW_PATH, 'utf8');
    expect(src).toMatch(/addEventListener\s*\(\s*['"]activate['"]/);
    expect(src).toMatch(/\.clients\.claim\s*\(\s*\)/);
  });

  it('does NOT register a `fetch` event handler (defense pin against premature scope expansion)', () => {
    const src = readFileSync(SW_PATH, 'utf8');
    // The cache-policy fetch handler (per ADR-0013) is the follow-up
    // PR's responsibility. Pinning the absence here ensures the
    // minimal-scaffold scope is intentional — a premature add (e.g.,
    // copy-paste from another SvelteKit project) would silently change
    // the network-interception behaviour without an architecture
    // conversation.
    expect(src).not.toMatch(/addEventListener\s*\(\s*['"]fetch['"]/);
  });
});

describe('T19.1 / G-T19-14 — hooks.client.ts registration call', () => {
  const src = readFileSync(HOOKS_PATH, 'utf8');

  it('calls navigator.serviceWorker.register on /service-worker.js', () => {
    // Allow prettier's chained-call line-break between `.serviceWorker`
    // and `.register(` — the regex tolerates any amount of whitespace
    // (including newlines) at that boundary.
    expect(src).toMatch(
      /navigator\.serviceWorker\s*\.register\s*\(\s*['"]\/service-worker\.js['"]/
    );
  });

  it('gates the register call on the UA probe (\'serviceWorker\' in navigator)', () => {
    // Defense pin: older UAs without SW support hard-fail on
    // `navigator.serviceWorker.register` (the property doesn't
    // exist). The probe avoids that.
    expect(src).toMatch(/['"]serviceWorker['"]\s+in\s+navigator/);
  });

  it('gates the register call on import.meta.env.PROD (dev does not register the SW)', () => {
    // Defense pin: in dev (vite dev) the SW caches stale dev builds,
    // producing "why does my code change not show up?" puzzlers.
    // Gating on PROD keeps the dev loop snappy.
    expect(src).toMatch(/import\.meta\.env\.PROD/);
  });

  it('registers with type: \'module\' and scope: \'/\'', () => {
    // Defense pin: SvelteKit compiles the SW as ESM by default;
    // omitting type: 'module' would make the browser refuse to
    // register the bundle. scope: '/' claims the entire origin so
    // future fetch handlers can intercept any route.
    expect(src).toMatch(/type:\s*['"]module['"]/);
    expect(src).toMatch(/scope:\s*['"]\/['"]/);
  });

  it('routes registration errors through the structured logger (log.error event=sw.register_failed)', () => {
    // Defense pin: a silent .catch(() => {}) would hide registration
    // failures in production where the cache-policy gains of
    // ADR-0013 don't realize without SW registration succeeding.
    expect(src).toMatch(/log\.error\s*\(\s*\{\s*event:\s*['"]sw\.register_failed['"]/);
  });

  it('captures registration errors via Sentry when PUBLIC_SENTRY_DSN is wired', () => {
    expect(src).toMatch(
      /if\s*\(\s*PUBLIC_SENTRY_DSN\s*\)\s*\{\s*Sentry\.captureException\s*\(\s*err\s*\)/
    );
  });
});
