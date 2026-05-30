/**
 * T19.1 — landing route mount (`/`).
 *
 * Pins the structural contract that the landing page offers BOTH
 * onboarding entry (new device) and sign-in entry (returning device).
 * Without both, a returning user has no way to reach /sign-in from the
 * front door without typing the URL — which is fine in dev but breaks
 * the basic "open the app and sign in" flow in production.
 *
 * Also pins that every visible string resolves via t() — ADR-0009 /
 * verify-i18n.sh contract, mirroring the sign-in and settings routes.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/+page.svelte');

describe('T19.1 — landing route (/) mount', () => {
  it('the landing page exists at apps/web/src/routes/+page.svelte', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('the landing page links to /onboarding (new-device path)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/onboarding["']/);
    // Defense-in-depth: the testid we use to drive this link from
    // future e2e tests.
    expect(src).toMatch(/data-testid=["']landing-link-onboarding["']/);
  });

  it('the landing page links to /sign-in (returning-device path)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/sign-in["']/);
    expect(src).toMatch(/data-testid=["']landing-link-sign-in["']/);
  });

  it('both CTAs use t() for their visible labels (ADR-0009 / verify-i18n.sh)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/import\s*{[^}]*\bt\b[^}]*}\s+from\s+['"]\$lib\/i18n['"]/);
    expect(src).toMatch(/t\(['"]landing\.new_device\.cta['"]\)/);
    expect(src).toMatch(/t\(['"]landing\.returning_device\.cta['"]\)/);
    expect(src).toMatch(/t\(['"]landing\.new_device\.heading['"]\)/);
    expect(src).toMatch(/t\(['"]landing\.returning_device\.heading['"]\)/);
  });

  it('every landing.* key the page references is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.landing).toBeDefined();
    expect(typeof catalog.landing.subtitle).toBe('string');
    expect(typeof catalog.landing.new_device.heading).toBe('string');
    expect(typeof catalog.landing.new_device.description).toBe('string');
    expect(typeof catalog.landing.new_device.cta).toBe('string');
    expect(typeof catalog.landing.returning_device.heading).toBe('string');
    expect(typeof catalog.landing.returning_device.description).toBe('string');
    expect(typeof catalog.landing.returning_device.cta).toBe('string');
    expect(typeof catalog.landing.signed_in.heading).toBe('string');
    expect(typeof catalog.landing.signed_in.description).toBe('string');
    expect(typeof catalog.landing.signed_in.cta).toBe('string');
  });

  it('the landing page does NOT carry a stale "release: scaffold" string (previously inlined dev marker)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // The pre-PR landing page hardcoded a `release` constant + rendered it
    // in the template. That's a dev-only artefact that should not ship.
    expect(src).not.toMatch(/release:\s*['"]scaffold['"]/);
    expect(src).not.toMatch(/—\s*release:/);
  });

  it('the page reactively tracks JWT state via subscribeToJwt (parity with /sign-in PR #59 and /settings PR #58)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*{[^}]*subscribeToJwt[^}]*}\s+from\s+['"][^'"]*lib\/auth\/session-jwt-store['"]/
    );
    expect(src).toMatch(/subscribeToJwt\s*\(\s*\(\s*jwt\s*\)\s*=>\s*\{[\s\S]*?isSignedIn\s*=\s*jwt\s*!==\s*null/);
  });

  it('the page initializes isSignedIn from getJwt() at mount (no flash of two-CTA layout for returning visitors)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/let\s+isSignedIn\s*=\s*getJwt\(\)\s*!==\s*null/);
  });

  it('the page unsubscribes from subscribeToJwt on destroy (no leaked listener)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/import\s*{[^}]*onDestroy[^}]*}\s+from\s+['"]svelte['"]/);
    expect(src).toMatch(/onDestroy\s*\(\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*\)/);
  });

  it('signed-in branch surfaces a /settings link + landing.signed_in.* copy', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // The signed-in section is rendered ONLY inside {#if isSignedIn} so
    // unauthed users never see the link (defense-in-depth).
    expect(src).toMatch(/data-testid=["']landing-signed-in["']/);
    expect(src).toMatch(/<a\s+href=["']\/settings["']/);
    expect(src).toMatch(/data-testid=["']landing-link-settings["']/);
    expect(src).toMatch(/t\(['"]landing\.signed_in\.heading['"]\)/);
    expect(src).toMatch(/t\(['"]landing\.signed_in\.description['"]\)/);
    expect(src).toMatch(/t\(['"]landing\.signed_in\.cta['"]\)/);
  });

  it('signed-in and not-signed-in branches are mutually exclusive (else block, not duplicate sections)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // The signed-in section + the two-CTA section live in an
    // {#if isSignedIn}…{:else}…{/if} block. Defense against a refactor
    // that surfaces both at the same time (which would let a signed-in
    // user click through to /sign-in or /onboarding by mistake).
    expect(src).toMatch(/\{#if\s+isSignedIn\}[\s\S]*?\{:else\}[\s\S]*?\{\/if\}/);
  });
});
