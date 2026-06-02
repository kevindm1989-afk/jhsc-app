/**
 * T19.1 — package.json structural pin (private + critical deps).
 *
 * Two classes of pin:
 *
 *   - **`private: true`** — defense against accidental `npm publish`.
 *     The package contains worker-side intake code for a privacy-
 *     sensitive committee app; publishing to the public npm registry
 *     would be a privacy + reputational disaster. The `private: true`
 *     field makes npm refuse to publish the package; removing it
 *     would silently allow publication. Pinning it is cheap; the
 *     consequence of drift is catastrophic.
 *
 *   - **Critical dependency presence** — the four packages whose
 *     absence would break load-bearing features:
 *
 *       * `@sentry/sveltekit` — observability per ADR-0010.
 *       * `libsodium-wrappers-sumo` — the Argon2id-bearing crypto
 *         primitive (G-T07-12 boot-fail-fast depends on this).
 *       * `@sveltejs/adapter-static` — the deployment target pinned
 *         by svelte-config-adapter.test.ts.
 *       * `@sveltejs/kit` — SvelteKit itself.
 *
 *     Each absence would break in a different test, but pinning
 *     them in one place documents the "load-bearing dependency"
 *     contract.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG_PATH = resolve(__dirname, '../../package.json');

describe('T19.1 — package.json (private + identity)', () => {
  it('package.json exists', () => {
    expect(existsSync(PKG_PATH)).toBe(true);
  });

  it('is valid JSON', () => {
    const src = readFileSync(PKG_PATH, 'utf8');
    expect(() => JSON.parse(src)).not.toThrow();
  });

  it('declares `private: true` (defense against accidental npm publish)', () => {
    const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
    // The package contains worker-side intake code for a privacy-
    // sensitive committee app. Publishing to the public npm registry
    // would be a privacy + reputational disaster. `private: true`
    // makes npm refuse to publish.
    expect(pkg.private).toBe(true);
  });

  it('declares `type: "module"` (ESM, required by SvelteKit + vite-plugin-svelte)', () => {
    const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
    expect(pkg.type).toBe('module');
  });

  it('uses the @jhsc scope (defense pin against name drift)', () => {
    const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
    // Drift would happen if someone accidentally renamed the package
    // when extracting to a new repo or workspace. The scope is the
    // canonical identifier other workspace packages reference.
    expect(pkg.name).toMatch(/^@jhsc\//);
  });
});

describe('T19.1 — package.json critical dependencies', () => {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const allDeps: Record<string, string> = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {})
  };

  it('depends on @sentry/sveltekit (ADR-0010 observability — bundled SDK, never CDN)', () => {
    expect(allDeps['@sentry/sveltekit']).toBeDefined();
  });

  it('depends on libsodium-wrappers-sumo (G-T07-12 Argon2id boot-fail-fast)', () => {
    // The `-sumo` build carries `crypto_pwhash` (Argon2id), which the
    // recovery-blob KDF requires. The non-sumo build does not, and a
    // drift to the non-sumo version would silently fall through to an
    // inferior KDF — exactly the regression G-T07-12 protects against.
    expect(allDeps['libsodium-wrappers-sumo']).toBeDefined();
  });

  it('depends on @sveltejs/adapter-static (pinned deployment target)', () => {
    expect(allDeps['@sveltejs/adapter-static']).toBeDefined();
  });

  it('depends on @sveltejs/kit (SvelteKit framework — used by every route)', () => {
    expect(allDeps['@sveltejs/kit']).toBeDefined();
  });

  it('does NOT depend on @supabase/supabase-js in the BROWSER bundle (decisions.md §4: server-only)', () => {
    // Per ADR / decisions.md §4: "`@supabase/supabase-js` added
    // server-only (Edge Functions / never the browser bundle; CSP
    // `connect-src 'self'` + the bundle gate keep it out of `build/`)."
    // The browser package (apps/web/package.json) MUST NOT list it.
    // Edge Functions (supabase/functions/) have their own runtime
    // (Deno imports), separate from this package.
    expect(allDeps['@supabase/supabase-js']).toBeUndefined();
  });
});
