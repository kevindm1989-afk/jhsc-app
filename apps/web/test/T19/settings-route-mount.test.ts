/**
 * T19.1 — /settings production route mount.
 *
 * Closes the panic-wipe end-to-end loop. Before this PR there was no
 * route reachable in production that could actually invoke
 * `PanicWipeModal` with a real `auditEmitter` wired — every existing
 * test render used `MemoryWipeStore` via the `__test_store` seam, which
 * meant production callers had no way to satisfy the F-53 / M-106a
 * audit-before-side-effect precondition.
 *
 * This file pins the structural contract:
 *   - The route exists at `apps/web/src/routes/settings/+page.svelte`.
 *   - It imports PanicWipeModal AND mounts it with a `wipeStore` prop
 *     (not just the bare default-store path that fails-closed).
 *   - The wipeStore is constructed via `createPanicWipeAuditEmitter`
 *     from the t07-client-factory module so the audit row actually
 *     reaches t07-op.
 *   - prerender=true + ssr=false (matches the rest of the app).
 *   - noindex meta (settings pages are not search-indexed).
 *
 * Also pins the PanicWipeModal-side prop contract: the `wipeStore` prop
 * is declared and threads into the wipe call.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROUTE_DIR = resolve(__dirname, '../../src/routes/settings');
const PAGE_PATH = resolve(ROUTE_DIR, '+page.svelte');
const PAGE_TS_PATH = resolve(ROUTE_DIR, '+page.ts');
const MODAL_PATH = resolve(__dirname, '../../src/lib/lock/PanicWipeModal.svelte');

describe('T19.1 — /settings production route mount', () => {
  it('the /settings route exists at apps/web/src/routes/settings/+page.svelte', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('the route imports PanicWipeModal', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/import\s+PanicWipeModal\s+from\s+['"][^'"]*lib\/lock\/PanicWipeModal\.svelte['"]/);
    expect(src).toMatch(/<PanicWipeModal\b/);
  });

  it('the route wires a production wipeStore through createPanicWipeAuditEmitter (no fail-closed default)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/createSupabaseT07Client/);
    expect(src).toMatch(/createPanicWipeAuditEmitter/);
    // The modal receives the wipeStore — i.e. it's not just the bare
    // panicWipe-internal default which fails-closed.
    expect(src).toMatch(/{wipeStore}|wipeStore={/);
  });

  it('the route reads the JWT from lib/auth/session-jwt-store (not a hard-coded null)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/from\s+['"][^'"]*lib\/auth\/session-jwt-store['"]/);
    expect(src).toMatch(/getJwt/);
    // The bare `() => null` placeholder is gone — production wiring
    // now goes through the session-jwt-store module.
    expect(src).not.toMatch(/getJwt:\s*\(\s*\)\s*=>\s*null/);
  });

  it('the route wires `onSessionRevoked: clearJwt` so a 401 from the audit-emit clears the in-memory JWT (F-39 loop, parity with hooks.client.ts)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Imports clearJwt from the same session-jwt-store module.
    expect(src).toMatch(/import\s*{[^}]*clearJwt[^}]*}\s+from\s+['"][^'"]*lib\/auth\/session-jwt-store['"]/);
    // Passes it as the onSessionRevoked callback so 401 → clearJwt fires.
    expect(src).toMatch(/onSessionRevoked:\s*clearJwt/);
  });

  it('the route does NOT forward any `__test_*` prop to PanicWipeModal (ADR-0020 Decision 8: production strip)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    const testProbe = '__test_' + 'store';
    const ready = '__test_' + 'ready_delay_ms';
    const autoSubmit = '__test_' + 'auto_submit';
    expect(src.includes(testProbe)).toBe(false);
    expect(src.includes(ready)).toBe(false);
    expect(src.includes(autoSubmit)).toBe(false);
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

  it('the route renders a Sign-out button wired to clearJwt (user-initiated F-39 clear)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // The button is present with the test-id we use to drive it from
    // higher-level / e2e tests.
    expect(src).toMatch(/data-testid=["']sign-out-button["']/);
    // It triggers a signOut handler — the handler's body calls clearJwt
    // (the imported function from session-jwt-store), NOT a no-op shim
    // or an alternate route that bypasses the F-39 contract.
    expect(src).toMatch(/function\s+signOut\s*\([^)]*\)\s*\{[\s\S]*?clearJwt\(\)/);
  });

  it('the Sign-out section consumes its visible text via t() (ADR-0009 / verify-i18n.sh)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/t\(['"]signOut\.heading['"]\)/);
    expect(src).toMatch(/t\(['"]signOut\.intro['"]\)/);
    expect(src).toMatch(/t\(['"]signOut\.button['"]\)/);
    expect(src).toMatch(/t\(['"]signOut\.signed_out['"]\)/);
  });

  it('every signOut.* key the route references is present in the root catalog (i18n/en-CA.json)', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.signOut).toBeDefined();
    expect(typeof catalog.signOut.heading).toBe('string');
    expect(typeof catalog.signOut.intro).toBe('string');
    expect(typeof catalog.signOut.button).toBe('string');
    expect(typeof catalog.signOut.signed_out).toBe('string');
    expect(typeof catalog.signOut.sign_in_again_cta).toBe('string');
  });

  it('after sign-out, the route surfaces a /sign-in link so the user has somewhere to go', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/sign-in["']/);
    expect(src).toMatch(/data-testid=["']signed-out-sign-in-again["']/);
    expect(src).toMatch(/t\(['"]signOut\.sign_in_again_cta['"]\)/);
  });

  it('the route reactively tracks JWT state via the $isSignedIn store wrapper (side-channel clears flip the UI)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // PR #63 introduced `$lib/auth/session-jwt-svelte` as a Svelte
    // readable wrapper over subscribeToJwt. /settings consumes
    // `$isSignedIn` from it — a 401 from another t07-op call, a
    // panic-wipe post-cleanup hook, a cross-tab sign-out broadcast
    // (PR #61), or a future server-side revoke all flip the UI via
    // the same store. The wrapper owns the subscribeToJwt + onDestroy
    // lifecycle so the route doesn't need to.
    expect(src).toMatch(
      /import\s*{[^}]*isSignedIn[^}]*}\s+from\s+['"][^'"]*lib\/auth\/session-jwt-svelte['"]/
    );
    // The route uses $isSignedIn to drive the signedOut UI flag via a
    // reactive declaration (defense against a refactor that drops the
    // reactivity).
    expect(src).toMatch(/\$:\s*signedOut\s*=\s*!\$isSignedIn/);
  });

  it('the route no longer hand-rolls subscribeToJwt + onDestroy (wrapper owns the lifecycle now)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // After PR #63's wrapper migration, the manual subscriber pattern
    // is gone. Regression guard against re-adding it (which would
    // double-subscribe and leak listeners).
    expect(src).not.toMatch(
      /import\s*{[^}]*subscribeToJwt[^}]*}\s+from\s+['"][^'"]*session-jwt-store['"]/
    );
    expect(src).not.toMatch(/subscribeToJwt\s*\(/);
  });

  it('the signOut handler no longer manually flips `signedOut = true` (the subscriber owns it)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Defense-in-depth against a refactor that re-adds the manual flip
    // — that would mask any side-channel clear and reintroduce the
    // one-shot-only state tracking. Extract the signOut body and
    // assert it doesn't contain `signedOut = true`.
    const fnMatch = src.match(/function\s+signOut\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch?.[1]).not.toMatch(/signedOut\s*=\s*true/);
  });

  it('the Settings page title, h1 heading, Device-data section + wipe button consume i18n via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Defense-in-depth against the multi-line / under-threshold layout
    // loophole that lets verify-i18n.sh miss these strings. The route
    // MUST route every visible string through t() per ADR-0009.
    expect(src).toMatch(/t\(['"]settings\.title['"]\)/);
    expect(src).toMatch(/t\(['"]settings\.device_data\.heading['"]\)/);
    expect(src).toMatch(/t\(['"]settings\.device_data\.wipe_button['"]\)/);
    expect(src).toMatch(/t\(['"]settings\.device_data\.intro_before_emphasis['"]\)/);
    expect(src).toMatch(/t\(['"]settings\.device_data\.intro_emphasis['"]\)/);
    expect(src).toMatch(/t\(['"]settings\.device_data\.intro_after_emphasis['"]\)/);
    // The hardcoded English literals must NOT survive the refactor.
    expect(src).not.toMatch(/<h1>\s*Settings\s*<\/h1>/);
    expect(src).not.toMatch(/<h2>\s*Device data\s*<\/h2>/);
    expect(src).not.toMatch(/Wipe this device's data/);
    expect(src).not.toMatch(/<title>Settings\s*—\s*JHSC<\/title>/);
  });

  it('every settings.* key the route references is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.settings).toBeDefined();
    expect(typeof catalog.settings.title).toBe('string');
    expect(typeof catalog.settings.device_data.heading).toBe('string');
    expect(typeof catalog.settings.device_data.intro_before_emphasis).toBe('string');
    expect(typeof catalog.settings.device_data.intro_emphasis).toBe('string');
    expect(typeof catalog.settings.device_data.intro_after_emphasis).toBe('string');
    expect(typeof catalog.settings.device_data.wipe_button).toBe('string');
  });
});

describe('T19.1 — PanicWipeModal accepts a production wipeStore prop', () => {
  it('PanicWipeModal declares an `export let wipeStore` prop', () => {
    const src = readFileSync(MODAL_PATH, 'utf8');
    expect(src).toMatch(/export\s+let\s+wipeStore\b/);
  });

  it('PanicWipeModal threads the wipeStore prop into the panicWipe call (production override)', () => {
    const src = readFileSync(MODAL_PATH, 'utf8');
    // The non-test path now uses `wipeStore` somewhere in the chain
    // before calling panicWipe.
    expect(src).toMatch(/wipeStore/);
    // Specifically: the panicWipe call's store argument falls back through
    // the `__test_store ?? wipeStore ?? undefined` chain.
    expect(src).toMatch(/__test_store\s*\?\?\s*wipeStore/);
  });
});
