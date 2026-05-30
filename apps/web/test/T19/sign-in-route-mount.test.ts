/**
 * T19.1 — /sign-in production route mount.
 *
 * Closes the mint-session sign-in loop end-to-end. Before this PR the
 * mint-session client (PR #51), signInViaMintSession orchestrator
 * (PR #52), and webauthnGetAssertion DOM wrapper (PR #53) all existed
 * as library functions but no production route called them — meaning
 * the session-jwt-store stayed empty in production and every Edge
 * Function factory's lazy `getJwt()` returned null.
 *
 * This file pins the structural contract:
 *   - The route exists at `apps/web/src/routes/sign-in/+page.svelte`.
 *   - It imports + calls `createSupabaseMintSessionClient` from the
 *     server-client factory module.
 *   - It imports `signInViaMintSession`, `webauthnGetAssertion`, and
 *     the REAL `setJwt` from `$lib/auth/session-jwt-store`.
 *   - The signIn handler passes setJwt directly to signInViaMintSession
 *     (defense-in-depth against a refactor that swaps in a no-op
 *     stub or pre-poisons the store).
 *   - The handler uses webauthnGetAssertion as the getAssertion callback
 *     (no inline `() => null` placeholder).
 *   - prerender=true + ssr=false (matches /onboarding and /settings).
 *   - noindex meta (sign-in pages are not search-indexed).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROUTE_DIR = resolve(__dirname, '../../src/routes/sign-in');
const PAGE_PATH = resolve(ROUTE_DIR, '+page.svelte');
const PAGE_TS_PATH = resolve(ROUTE_DIR, '+page.ts');

describe('T19.1 — /sign-in production route mount', () => {
  it('the /sign-in route exists at apps/web/src/routes/sign-in/+page.svelte', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('the route imports createSupabaseMintSessionClient from the server-client factory module', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*{[^}]*createSupabaseMintSessionClient[^}]*}\s+from\s+['"][^'"]*server-client\/mint-session-client-factory['"]/
    );
  });

  it('the route imports signInViaMintSession from $lib/auth/sign-in-flow', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*{[^}]*signInViaMintSession[^}]*}\s+from\s+['"][^'"]*lib\/auth\/sign-in-flow['"]/
    );
  });

  it('the route imports webauthnGetAssertion from $lib/auth/webauthn-assertion', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*{[^}]*webauthnGetAssertion[^}]*}\s+from\s+['"][^'"]*lib\/auth\/webauthn-assertion['"]/
    );
  });

  it('the route imports the REAL setJwt from lib/auth/session-jwt-store (not a no-op stub)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*{[^}]*setJwt[^}]*}\s+from\s+['"][^'"]*lib\/auth\/session-jwt-store['"]/
    );
    // Defense-in-depth: no inline `setJwt: () => {}` shim hiding the wiring.
    expect(src).not.toMatch(/setJwt:\s*\(\s*\)\s*=>\s*\{?\s*\}?/);
  });

  it('the signIn handler passes setJwt directly to signInViaMintSession', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // The handler should pass the imported `setJwt` as the option, NOT
    // a hardcoded shim. Defense-in-depth against a refactor that breaks
    // the wiring between the orchestrator and the session-jwt-store.
    expect(src).toMatch(/signInViaMintSession\s*\(\s*\{[\s\S]*?setJwt[\s\S]*?\}\s*\)/);
  });

  it('the signIn handler uses webauthnGetAssertion as the getAssertion callback', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Match the literal call composition so a refactor that swaps in a
    // `() => null` placeholder (or a different wrapper) breaks the test.
    expect(src).toMatch(/getAssertion:\s*\([^)]*\)\s*=>\s*webauthnGetAssertion\(/);
  });

  it('the route reads PUBLIC_SUPABASE_URL with a localhost:54321 fallback', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/env\.PUBLIC_SUPABASE_URL/);
    expect(src).toMatch(/localhost:54321/);
  });

  it('the route sets prerender=true + ssr=false (adapter-static + no SSR for PI safety)', () => {
    expect(existsSync(PAGE_TS_PATH)).toBe(true);
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+prerender\s*=\s*true/);
    expect(src).toMatch(/export\s+const\s+ssr\s*=\s*false/);
  });

  it('the route carries a noindex meta tag', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('the route does NOT forward any `__test_*` prop (ADR-0020 Decision 8: production strip)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Defense-in-depth: test-only seams must not surface in production routes.
    const testProbe = '__test_';
    expect(src.includes(testProbe)).toBe(false);
  });

  it('the route consumes visible text via t() — no raw English prose in the template (ADR-0009 / verify-i18n.sh)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Import is present.
    expect(src).toMatch(/import\s*{[^}]*\bt\b[^}]*}\s+from\s+['"]\$lib\/i18n['"]/);
    // Every state-machine label resolves via t(). Defense-in-depth against
    // a refactor that re-inlines an English string (which would re-trip
    // verify-i18n.sh in CI).
    expect(src).toMatch(/t\(['"]signIn\.title['"]\)/);
    expect(src).toMatch(/t\(['"]signIn\.intro['"]\)/);
    expect(src).toMatch(/t\(['"]signIn\.button\.idle['"]\)/);
    expect(src).toMatch(/t\(['"]signIn\.button\.signing_in['"]\)/);
    expect(src).toMatch(/t\(['"]signIn\.button\.signed_in['"]\)/);
    expect(src).toMatch(/t\(['"]signIn\.cancelled['"]\)/);
    expect(src).toMatch(/t\(['"]signIn\.failed['"]/);
    expect(src).toMatch(/t\(['"]signIn\.success['"]/);
  });

  it('every signIn.* key the route references is present in the root catalog (i18n/en-CA.json)', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.signIn).toBeDefined();
    expect(typeof catalog.signIn.title).toBe('string');
    expect(typeof catalog.signIn.intro).toBe('string');
    expect(typeof catalog.signIn.button.idle).toBe('string');
    expect(typeof catalog.signIn.button.signing_in).toBe('string');
    expect(typeof catalog.signIn.button.signed_in).toBe('string');
    expect(typeof catalog.signIn.cancelled).toBe('string');
    expect(typeof catalog.signIn.failed).toBe('string');
    expect(typeof catalog.signIn.success).toBe('string');
    // The failed + success strings use {reason} / {sessionId} interpolations.
    expect(catalog.signIn.failed).toMatch(/\{reason\}/);
    expect(catalog.signIn.success).toMatch(/\{sessionId\}/);
  });
});
