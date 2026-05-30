/**
 * T19.1 — root layout (`+layout.svelte`) JWT-reactive header indicator.
 *
 * Pins the structural contract introduced when the layout joined the
 * JWT-reactive trifecta (/sign-in PR #59, /settings PR #58, / PR #60):
 *
 *   - The layout imports `isSignedIn` from the Svelte readable
 *     wrapper at `$lib/auth/session-jwt-svelte`.
 *   - When signed in, a "Signed in" badge is rendered. When not, a
 *     "Sign in" link points to /sign-in.
 *   - Both visible labels resolve via t() per ADR-0009.
 *   - The route does NOT hand-roll subscribeToJwt + onDestroy
 *     boilerplate (the wrapper owns that lifecycle).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LAYOUT_PATH = resolve(__dirname, '../../src/routes/+layout.svelte');

describe('T19.1 — root layout JWT-reactive header indicator', () => {
  it('the layout exists at apps/web/src/routes/+layout.svelte', () => {
    expect(existsSync(LAYOUT_PATH)).toBe(true);
  });

  it('imports isSignedIn from the Svelte store wrapper (not hand-rolled subscribeToJwt)', () => {
    const src = readFileSync(LAYOUT_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*{[^}]*isSignedIn[^}]*}\s+from\s+['"][^'"]*lib\/auth\/session-jwt-svelte['"]/
    );
    // The wrapper owns the subscribeToJwt + onDestroy boilerplate, so
    // the layout itself should not import or call them.
    expect(src).not.toMatch(
      /import\s*{[^}]*subscribeToJwt[^}]*}\s+from\s+['"][^'"]*session-jwt-store['"]/
    );
  });

  it('renders a "Signed in" badge when $isSignedIn is true', () => {
    const src = readFileSync(LAYOUT_PATH, 'utf8');
    // Svelte auto-subscribes via the `$` prefix.
    expect(src).toMatch(/\{#if\s+\$isSignedIn\}/);
    expect(src).toMatch(/data-testid=["']header-signed-in-badge["']/);
    expect(src).toMatch(/t\(['"]common\.header\.signed_in_badge['"]\)/);
  });

  it('renders a /sign-in link when $isSignedIn is false (else branch)', () => {
    const src = readFileSync(LAYOUT_PATH, 'utf8');
    expect(src).toMatch(/\{:else\}/);
    expect(src).toMatch(/<a\s+href=["']\/sign-in["']/);
    expect(src).toMatch(/data-testid=["']header-sign-in-link["']/);
    expect(src).toMatch(/t\(['"]common\.header\.sign_in_link['"]\)/);
  });

  it('the if / else branches are mutually exclusive (single {#if}…{:else}…{/if} block)', () => {
    const src = readFileSync(LAYOUT_PATH, 'utf8');
    // Defense against a refactor that surfaces both at once (which
    // would show "Signed in" + a "Sign in" link simultaneously).
    expect(src).toMatch(/\{#if\s+\$isSignedIn\}[\s\S]*?\{:else\}[\s\S]*?\{\/if\}/);
  });

  it('every common.header.* key referenced is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.common).toBeDefined();
    expect(catalog.common.header).toBeDefined();
    expect(typeof catalog.common.header.signed_in_badge).toBe('string');
    expect(typeof catalog.common.header.sign_in_link).toBe('string');
  });
});
