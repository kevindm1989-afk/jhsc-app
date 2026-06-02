/**
 * T19.1 — built-output integrity (conditional on `build/` existing).
 *
 * This file verifies that every static asset + meta tag the source-
 * level tests pin actually lands in the adapter-static `build/`
 * output. Running these as ordinary vitest suites catches the case
 * where the source contract is right but a build-config drift drops
 * an asset on the way to deploy (e.g., a `static/` directory rename,
 * an adapter-static option flip, a missing SvelteKit virtual-module
 * wire-up).
 *
 * The whole block is gated on `existsSync('build/index.html')`:
 *
 *   - Locally / after a developer runs `pnpm build`: the test runs
 *     and pins the integrity.
 *   - In CI test-only stages where `build/` doesn't exist yet (test
 *     runs before build): the block is skipped via `describe.skipIf`,
 *     so the test surface remains a "pass" without false signal.
 *
 * The skipIf pattern is preferred to a hard fail because vitest
 * itself doesn't sequence build → test; making the test conditional
 * keeps the gate self-contained.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BUILD_DIR = resolve(__dirname, '../../build');
const INDEX_HTML = resolve(BUILD_DIR, 'index.html');
const buildPresent = existsSync(INDEX_HTML);

describe.skipIf(!buildPresent)('T19.1 — built-output integrity', () => {
  it('build/index.html exists', () => {
    expect(existsSync(INDEX_HTML)).toBe(true);
  });

  it('build/manifest.webmanifest is copied through adapter-static', () => {
    // Defense pin: a `static/` directory rename or an adapter-static
    // `assets` path drift would leave the file in source-only state.
    // The browser's manifest fetch would 404 silently.
    expect(existsSync(resolve(BUILD_DIR, 'manifest.webmanifest'))).toBe(true);
  });

  it('build/icon.svg is copied through adapter-static', () => {
    expect(existsSync(resolve(BUILD_DIR, 'icon.svg'))).toBe(true);
  });

  it('build/robots.txt is copied through adapter-static', () => {
    expect(existsSync(resolve(BUILD_DIR, 'robots.txt'))).toBe(true);
  });

  it('build/service-worker.js is emitted (SvelteKit auto-detects src/service-worker.ts)', () => {
    // The SW source lives at src/service-worker.ts; SvelteKit's
    // service-worker auto-detection compiles it to a separate bundle.
    // Without this file, the production register call would 404.
    expect(existsSync(resolve(BUILD_DIR, 'service-worker.js'))).toBe(true);
  });

  it('build/.well-known/security.txt is copied through adapter-static (RFC 9116)', () => {
    // The deployed origin must serve /.well-known/security.txt at
    // the canonical path. adapter-static preserves nested directory
    // structure under static/ — drift here would mean the file is
    // unreachable at the published URL.
    expect(existsSync(resolve(BUILD_DIR, '.well-known/security.txt'))).toBe(true);
  });

  it('all four routes emit prerendered HTML files (per-route ssr=false pin contract)', () => {
    // Per the route-mount tests' `prerender = true` pin, every route
    // must produce a static HTML file in build/. A drift to
    // `prerender = false` on any one route would silently drop that
    // route's HTML, producing a 404 on direct navigation.
    expect(existsSync(resolve(BUILD_DIR, 'index.html'))).toBe(true);
    expect(existsSync(resolve(BUILD_DIR, 'sign-in.html'))).toBe(true);
    expect(existsSync(resolve(BUILD_DIR, 'settings.html'))).toBe(true);
    expect(existsSync(resolve(BUILD_DIR, 'onboarding.html'))).toBe(true);
  });
});

describe.skipIf(!buildPresent)('T19.1 — built index.html head injection', () => {
  // Each pin reads the prerendered HTML and asserts the meta tag /
  // link the source-level tests pin actually survived SvelteKit's
  // %sveltekit.head% injection pass. A regression where SvelteKit's
  // CSP-auto pass strips or rewrites a tag would land here.

  const src = readFileSync(INDEX_HTML, 'utf8');

  it('contains the manifest link', () => {
    expect(src).toContain('<link rel="manifest"');
    expect(src).toContain('/manifest.webmanifest');
  });

  it('contains the SVG icon link', () => {
    expect(src).toContain('/icon.svg');
  });

  it('contains the theme-color meta tag (light variant)', () => {
    expect(src).toContain('content="#2d3a8c"');
  });

  it('contains the noindex robots meta tag (every route is noindex by design)', () => {
    expect(src).toMatch(/<meta\s+name=["']robots["']\s+content=["']noindex/i);
  });

  it('contains the CSP meta tag with default-src \'self\' (svelte-config-csp.test.ts source pin landed in the prerendered HTML)', () => {
    // The svelte-config-csp.test.ts source pin verified the CSP
    // directives in svelte.config.js. THIS pin verifies the
    // SvelteKit auto-CSP pass actually emitted them into the
    // prerendered HTML.
    //
    // NOTE: `frame-ancestors` is intentionally NOT checked here —
    // browsers ignore that directive when it appears in a `<meta>`
    // tag (it's an HTTP-header-only directive per CSP spec). The
    // value lives in svelte.config.js (pinned by
    // svelte-config-csp.test.ts) so the deploy-time response-header
    // pipeline can carry it.
    expect(src).toMatch(/<meta\s+http-equiv=["']content-security-policy["']/i);
    expect(src).toContain("default-src 'self'");
    expect(src).toContain("base-uri 'self'");
  });
});
