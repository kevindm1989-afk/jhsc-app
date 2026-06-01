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
});
