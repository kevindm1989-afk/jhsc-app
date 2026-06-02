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
const LAYOUT_TS_PATH = resolve(__dirname, '../../src/routes/+layout.ts');

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

  it('renders a Settings link to /settings when $isSignedIn is true (one-click access to sign-out + panic-wipe)', () => {
    const src = readFileSync(LAYOUT_PATH, 'utf8');
    // Svelte auto-subscribes via the `$` prefix.
    expect(src).toMatch(/\{#if\s+\$isSignedIn\}/);
    expect(src).toMatch(/<a\s+href=["']\/settings["'][^>]*data-testid=["']header-settings-link["']/);
    expect(src).toMatch(/t\(['"]common\.header\.settings_link['"]\)/);
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
    expect(typeof catalog.common.header.sign_in_link).toBe('string');
    expect(typeof catalog.common.header.settings_link).toBe('string');
  });

  it('renders a "Skip to main content" link as the first focusable element (WCAG 2.4.1 bypass)', () => {
    const src = readFileSync(LAYOUT_PATH, 'utf8');
    // The skip link must appear BEFORE the <header> in template order
    // so it is the first focusable element on every page. Without
    // this, keyboard users have to tab through the entire header
    // (home link + signed-in/settings/sign-in link) before reaching
    // the page content on every navigation.
    expect(src).toMatch(/<a\s+class=["']skip-link["'][^>]*href=["']#main-content["'][^>]*data-testid=["']skip-to-content["']/);
    expect(src).toMatch(/t\(['"]common\.actions\.skip_to_content['"]\)/);
    const skipAt = src.indexOf('skip-link');
    const headerAt = src.indexOf('<header>');
    expect(skipAt).toBeGreaterThan(-1);
    expect(headerAt).toBeGreaterThan(-1);
    expect(skipAt).toBeLessThan(headerAt);
  });

  it('the <main> landmark carries id="main-content" + tabindex="-1" so the skip-link target focuses correctly', () => {
    const src = readFileSync(LAYOUT_PATH, 'utf8');
    expect(src).toMatch(/<main[^>]*id=["']main-content["'][^>]*tabindex=["']-1["']/);
  });

  it('the app name wraps in a link to / (standard home-link pattern)', () => {
    const src = readFileSync(LAYOUT_PATH, 'utf8');
    // The app name is the canonical home link in every SaaS header.
    // Wrapping it in an <a href="/"> with a stable test-id lets e2e
    // tests drive header navigation. The link's accessible name is
    // the rendered app name itself — no aria-label override needed.
    expect(src).toMatch(/<a\s+href=["']\/["'][^>]*data-testid=["']header-home-link["']/);
    // The app name still surfaces inside the link so its visible text
    // continues to come from t('common.app_name') (defense against a
    // refactor that wraps the link around the wrong element).
    expect(src).toMatch(/<a\s+href=["']\/["'][^>]*>\s*<strong>\{t\(['"]common\.app_name['"]\)\}<\/strong>\s*<\/a>/);
  });

  it('the header navigation links live inside a <nav> landmark with an i18n-keyed aria-label (WCAG 1.3.1 / 2.4.1)', () => {
    const src = readFileSync(LAYOUT_PATH, 'utf8');
    // The <nav> landmark makes the primary navigation discoverable by
    // screen-reader users (announced as "Primary navigation, list of N
    // items" instead of two bare sibling links). The aria-label is
    // i18n-keyed so localisation propagates to the announcement.
    expect(src).toMatch(
      /<nav\s+aria-label=\{t\(['"]common\.header\.primary_nav_aria_label['"]\)\}[^>]*data-testid=["']header-primary-nav["']/
    );
    // The catalog key is present.
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(typeof catalog.common.header.primary_nav_aria_label).toBe('string');
  });

  it('header links carry aria-current="page" based on $page.url.pathname (WCAG 4.1.2 + ARIA "you are here")', () => {
    const src = readFileSync(LAYOUT_PATH, 'utf8');
    // The layout imports the SvelteKit page store and uses it to
    // compute per-link aria-current values. Defense against a
    // refactor that drops the reactive annotation (which would
    // remove the SR "current page" signal silently).
    expect(src).toMatch(/import\s*{[^}]*page[^}]*}\s+from\s+['"]\$app\/stores['"]/);
    // Reactive declarations derive each link's aria-current from the
    // current pathname.
    expect(src).toMatch(/\$:\s*currentPath\s*=\s*\$page\.url\.pathname/);
    // Each reactive declaration sets the value to 'page' (possibly
    // wrapped in `as const` for svelte-check's union-type narrowing)
    // when the pathname matches, undefined otherwise.
    expect(src).toMatch(/\$:\s*ariaCurrentHome\s*=\s*currentPath\s*===\s*['"]\/['"]\s*\?[^;]*['"]page['"][^;]*:\s*undefined/);
    expect(src).toMatch(/\$:\s*ariaCurrentSettings\s*=\s*currentPath\s*===\s*['"]\/settings['"]\s*\?[^;]*['"]page['"][^;]*:\s*undefined/);
    expect(src).toMatch(/\$:\s*ariaCurrentSignIn\s*=\s*currentPath\s*===\s*['"]\/sign-in['"]\s*\?[^;]*['"]page['"][^;]*:\s*undefined/);
  });

  it('each header link wires aria-current to its corresponding reactive value', () => {
    const src = readFileSync(LAYOUT_PATH, 'utf8');
    // The home link uses ariaCurrentHome.
    expect(src).toMatch(/<a\s+href=["']\/["']\s+aria-current=\{ariaCurrentHome\}/);
    // The settings link uses ariaCurrentSettings.
    expect(src).toMatch(/<a\s+href=["']\/settings["']\s+aria-current=\{ariaCurrentSettings\}/);
    // The sign-in link uses ariaCurrentSignIn.
    expect(src).toMatch(/<a\s+href=["']\/sign-in["']\s+aria-current=\{ariaCurrentSignIn\}/);
  });

  it('both the home link and the conditional Sign-in/Settings link live INSIDE the <nav> landmark', () => {
    const src = readFileSync(LAYOUT_PATH, 'utf8');
    // Defense against a refactor that places one of the links outside
    // the <nav> (which would orphan it from the landmark and break the
    // semantic grouping). String-index check: the <nav> opens before
    // both <a> links and closes after them.
    const navOpen = src.indexOf('<nav ');
    const navClose = src.indexOf('</nav>');
    const homeLinkAt = src.indexOf('data-testid="header-home-link"');
    const signInLinkAt = src.indexOf('data-testid="header-sign-in-link"');
    const settingsLinkAt = src.indexOf('data-testid="header-settings-link"');
    expect(navOpen).toBeGreaterThan(-1);
    expect(navClose).toBeGreaterThan(-1);
    expect(homeLinkAt).toBeGreaterThan(navOpen);
    expect(homeLinkAt).toBeLessThan(navClose);
    expect(signInLinkAt).toBeGreaterThan(navOpen);
    expect(signInLinkAt).toBeLessThan(navClose);
    expect(settingsLinkAt).toBeGreaterThan(navOpen);
    expect(settingsLinkAt).toBeLessThan(navClose);
  });
});

describe('T19.1 — root layout (+layout.ts) prerender + ssr posture', () => {
  // The per-route +page.ts files (PR #79 + earlier landed `/onboarding`,
  // `/sign-in`, `/settings`, `/`) each re-affirm `prerender=true` +
  // `ssr=false` so a future change to the layout can't silently flip
  // the contract underneath them. But the +layout.ts itself — the
  // upstream source of these settings + the default any FUTURE route
  // inherits — was never structurally pinned. Without this guard, a
  // refactor that drops or flips the posture in +layout.ts would
  // silently re-enable SSR on every new route that doesn't add its
  // own +page.ts (i.e. the layout becomes the only line of defense
  // for new routes, and that line is unenforced).
  //
  // This block closes the gap with the same defense-in-depth pattern
  // the per-route pins use.

  it('the +layout.ts exists at apps/web/src/routes/+layout.ts', () => {
    expect(existsSync(LAYOUT_TS_PATH)).toBe(true);
  });

  it('declares `prerender = true` (adapter-static needs the prerender flag on every route the build emits)', () => {
    const src = readFileSync(LAYOUT_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+prerender\s*=\s*true/);
  });

  it('declares `ssr = false` (no SSR — the app boots client-side; PI never lands in SSR HTML)', () => {
    const src = readFileSync(LAYOUT_TS_PATH, 'utf8');
    // The ssr=false posture is the load-bearing PI-safety guarantee
    // for adapter-static deployments: without it, any future route
    // that loads from $page.data on the server side could render PI
    // into the prerendered HTML (which then sits in CDN cache).
    expect(src).toMatch(/export\s+const\s+ssr\s*=\s*false/);
  });
});
