/**
 * T19.1 — svelte.config.js adapter + alias pins.
 *
 * The CSP-focused pin (svelte-config-csp.test.ts, PR #91) covered the
 * security directives. This file pins the other half of svelte.config.js:
 * the SvelteKit adapter choice, prerender-strict mode, output paths,
 * and the $lib alias. None were structurally pinned before.
 *
 * Why each matters:
 *
 *   - **adapter-static** is the load-bearing deployment choice — per
 *     the config's own comment (ADR-0006 follow-up): "the default
 *     since auth is Supabase-side and most routes are client-rendered
 *     after login. If auth callback SSR becomes necessary, switch to
 *     adapter-node deliberately." A silent swap to adapter-node would
 *     re-enable SSR for the prerendered routes (every route in T19.1)
 *     and put PI into prerendered HTML — exactly the gap the per-
 *     route `ssr=false` pins (PR #79 + the route-mount tests) are
 *     trying to defend against. Pinning the adapter itself is the
 *     upstream guard.
 *
 *   - **strict: true** is adapter-static's "fail the build if any
 *     route can't be prerendered" flag. Without it, a route that
 *     accidentally exports `prerender = false` (or a load function
 *     that escapes the prerender pass) silently ships as a missing
 *     HTML file in build/, producing a 404 at deploy. The strict
 *     option converts that into a build-time error.
 *
 *   - **fallback: 'index.html'** turns adapter-static into an SPA
 *     fallback shell — every unrecognized path serves index.html so
 *     client-side routing can handle it. Without this, any path the
 *     CDN serves before SvelteKit's router takes over (e.g., a
 *     bookmarked deep link to a route that's purely client-side)
 *     returns the CDN's generic 404 page instead of letting
 *     SvelteKit render the +error.svelte boundary.
 *
 *   - **$lib alias** is the import convention every existing test
 *     and source file depends on. A drift here (e.g., dropping the
 *     `$lib/*` recursive form) would break tsc + svelte-check on
 *     hundreds of import sites.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONFIG_PATH = resolve(__dirname, '../../svelte.config.js');

describe('T19.1 — svelte.config.js adapter choice (adapter-static)', () => {
  it('svelte.config.js exists', () => {
    expect(existsSync(CONFIG_PATH)).toBe(true);
  });

  it('imports adapter from @sveltejs/adapter-static (NOT adapter-node / adapter-vercel / etc.)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    // Defense pin: the adapter choice IS the SSR contract. A swap to
    // adapter-node would re-enable SSR for routes that opt in, even
    // with ssr=false on the layout level.
    expect(src).toMatch(/import\s+adapter\s+from\s+['"]@sveltejs\/adapter-static['"]/);
    // The forbidden alternatives — pin against the three most likely
    // refactor candidates.
    expect(src).not.toMatch(/import\s+adapter\s+from\s+['"]@sveltejs\/adapter-node['"]/);
    expect(src).not.toMatch(/import\s+adapter\s+from\s+['"]@sveltejs\/adapter-vercel['"]/);
    expect(src).not.toMatch(/import\s+adapter\s+from\s+['"]@sveltejs\/adapter-auto['"]/);
  });

  it('the adapter is actually invoked under `kit.adapter`', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    // Defense pin: importing the adapter without invoking it would
    // silently fall back to the SvelteKit default (adapter-auto in
    // recent versions).
    expect(src).toMatch(/\badapter:\s*adapter\s*\(\s*\{/);
  });
});

describe('T19.1 — adapter-static options (strict, fallback, output paths)', () => {
  const src = readFileSync(CONFIG_PATH, 'utf8');

  it('sets `strict: true` (fail build if any route can\'t be prerendered)', () => {
    // Without strict mode, a route that accidentally exports
    // `prerender = false` (or whose load function escapes the
    // prerender pass) silently ships as a missing HTML file in build/,
    // producing a deploy-time 404. strict mode upgrades that to a
    // build-time failure.
    expect(src).toMatch(/\bstrict:\s*true/);
  });

  it('sets `fallback: \'index.html\'` (SPA-fallback mode)', () => {
    // SvelteKit's adapter-static fallback option turns every
    // unrecognized path into a serve of index.html so client-side
    // routing can handle it. Without this, a CDN serving a
    // bookmarked deep link returns the CDN's generic 404 instead
    // of letting SvelteKit render +error.svelte.
    expect(src).toMatch(/\bfallback:\s*['"]index\.html['"]/);
  });

  it('sets `pages: \'build\'` (output directory for prerendered pages)', () => {
    // The output path is referenced by every CI workflow that copies
    // the build to deploy targets. Drift here breaks deploy without
    // any test catching it.
    expect(src).toMatch(/\bpages:\s*['"]build['"]/);
  });

  it('sets `assets: \'build\'` (output directory for static assets — same as pages)', () => {
    // Splitting pages + assets into different directories is the
    // alternative; pinning them together keeps the build output
    // single-rooted (deploy scripts depend on this).
    expect(src).toMatch(/\bassets:\s*['"]build['"]/);
  });

  it('sets `precompress: false` (CDN handles gzip/brotli; no in-build precompression)', () => {
    // Defense pin: precompress=true creates .gz / .br files alongside
    // the originals, which doubles the build size and is redundant
    // when the CDN handles compression. Pin against drift to true.
    expect(src).toMatch(/\bprecompress:\s*false/);
  });
});

describe('T19.1 — $lib alias (import convention)', () => {
  const src = readFileSync(CONFIG_PATH, 'utf8');

  it('declares `$lib` alias mapping to `src/lib`', () => {
    // The $lib alias is the import convention every existing test
    // and source file depends on. Hundreds of import sites would
    // break if this alias is dropped or repointed.
    //
    // `$lib` is a valid JS identifier so it can appear as a bareword
    // key OR a quoted string key. Accept both forms; the `$lib/*`
    // form below MUST be quoted (slash breaks bareword parsing).
    expect(src).toMatch(/(?:['"]\$lib['"]|\$lib)\s*:\s*['"]src\/lib['"]/);
  });

  it('declares `$lib/*` recursive alias (so `$lib/sub/path` resolves)', () => {
    // The wildcard form is needed for nested paths like
    // `$lib/auth/session-jwt-svelte` which most of the routes use.
    // Without it, only top-level `$lib/` resolves and every nested
    // import breaks.
    expect(src).toMatch(/['"]\$lib\/\*['"]\s*:\s*['"]src\/lib\/\*['"]/);
  });
});
