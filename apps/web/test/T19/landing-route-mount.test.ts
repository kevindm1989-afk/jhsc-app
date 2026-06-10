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
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/+page.ts');

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

  it('the page reactively tracks JWT state via the $isSignedIn store wrapper (PR #63 migration)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // PR #63 introduced `$lib/auth/session-jwt-svelte`. The landing
    // page imports `isSignedIn` from it and branches on the auto-
    // subscribed `$isSignedIn` — no flash of the two-CTA layout for
    // returning visitors, and cross-tab sign-outs (PR #61) flip the
    // UI through the same store.
    expect(src).toMatch(
      /import\s*{[^}]*isSignedIn[^}]*}\s+from\s+['"][^'"]*lib\/auth\/session-jwt-svelte['"]/
    );
    expect(src).toMatch(/\{#if\s+\$isSignedIn\}/);
  });

  it('the page no longer hand-rolls subscribeToJwt + onDestroy (wrapper owns the lifecycle now)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Regression guard against re-adding the manual subscriber pattern.
    expect(src).not.toMatch(
      /import\s*{[^}]*subscribeToJwt[^}]*}\s+from\s+['"][^'"]*session-jwt-store['"]/
    );
    expect(src).not.toMatch(/subscribeToJwt\s*\(/);
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
    // {#if $isSignedIn}…{:else}…{/if} block. Defense against a refactor
    // that surfaces both at the same time (which would let a signed-in
    // user click through to /sign-in or /onboarding by mistake).
    expect(src).toMatch(/\{#if\s+\$isSignedIn\}[\s\S]*?\{:else\}[\s\S]*?\{\/if\}/);
  });

  it('signed-in branch mounts the HomeDashboard alongside the welcome-back card', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // The dashboard sibling card surfaces the cross-register
    // "needs attention" digest. Pinning the import + the mount keeps
    // the front-door digest from being silently dropped in a refactor.
    expect(src).toMatch(
      /import\s+HomeDashboard\s+from\s+['"]\$lib\/home\/HomeDashboard\.svelte['"]/
    );
    expect(src).toMatch(
      /import\s*\{[\s\S]*buildHomeSummary[\s\S]*\}\s+from\s+['"]\$lib\/home\/home-summary['"]/
    );
    expect(src).toMatch(/data-testid=["']landing-dashboard["']/);
    expect(src).toMatch(/<HomeDashboard\s+\{summary\}/);
  });

  it('home.dashboard.* i18n keys referenced by the dashboard are in the catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.home.dashboard).toBeDefined();
    expect(typeof catalog.home.dashboard.heading).toBe('string');
    expect(typeof catalog.home.dashboard.intro).toBe('string');
    expect(typeof catalog.home.dashboard.see_all_cta).toBe('string');
    expect(typeof catalog.home.dashboard.tile.open_concerns).toBe('string');
    expect(typeof catalog.home.dashboard.tile.overdue_recommendations).toBe('string');
    expect(typeof catalog.home.dashboard.tile.expired_training).toBe('string');
    expect(typeof catalog.home.dashboard.tile.active_refusals).toBe('string');
    expect(typeof catalog.home.dashboard.tile.preserving_scenes).toBe('string');
  });

  it('signed-in branch mounts the RecentActivityCard with top-5 audit rows', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s+RecentActivityCard\s+from\s+['"]\$lib\/home\/RecentActivityCard\.svelte['"]/
    );
    expect(src).toMatch(
      /import\s*\{[\s\S]*buildDemoAuditRows[\s\S]*\}\s+from\s+['"]\$lib\/audit\/demo-audit-rows['"]/
    );
    expect(src).toMatch(/data-testid=["']landing-recent["']/);
    expect(src).toMatch(/<RecentActivityCard\s+rows=\{recentRows\}/);
    // The top-5 slice — pinned so a refactor that drops the slice
    // (and dumps all 50 rows into the home card) is loud.
    expect(src).toMatch(/buildDemoAuditRows\(50\)\.slice\(0,\s*5\)/);
  });

  it('home.recent.* i18n keys referenced by the recent-activity card are in the catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.home.recent).toBeDefined();
    expect(typeof catalog.home.recent.heading).toBe('string');
    expect(typeof catalog.home.recent.intro).toBe('string');
    expect(typeof catalog.home.recent.empty).toBe('string');
    expect(typeof catalog.home.recent.actor_label).toBe('string');
    expect(typeof catalog.home.recent.see_all_cta).toBe('string');
  });

  it('the route sets prerender=true + ssr=false (adapter-static + no SSR for PI safety; per-route pin, parity with /onboarding /sign-in /settings)', () => {
    // The other three routes (/onboarding, /sign-in, /settings) each
    // carry a +page.ts that re-affirms the layout's posture. Before
    // this pin, the landing page inherited from +layout.ts only —
    // a future change to the layout would silently flip SSR on for
    // the front door without breaking any test. The per-route +page.ts
    // is the defense-in-depth pin that closes that gap.
    expect(existsSync(PAGE_TS_PATH)).toBe(true);
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+prerender\s*=\s*true/);
    expect(src).toMatch(/export\s+const\s+ssr\s*=\s*false/);
  });
});
