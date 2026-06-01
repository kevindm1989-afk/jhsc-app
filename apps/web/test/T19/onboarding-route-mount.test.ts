/**
 * T19 — G-T19-9 structural contract: a production SvelteKit route MUST
 * mount `OnboardingFlow.svelte`.
 *
 * Before this PR, OnboardingFlow was library-only and no `apps/web/src/routes/**`
 * file imported it — the gap entry read "Resolution scope (T19.1): a
 * production route mounts the wizard so end-to-end users can actually
 * reach it." This test pins that contract structurally so a future
 * refactor can't silently drop the route.
 *
 * We do NOT render the full SvelteKit page here (the testing-library
 * adapter doesn't set up SvelteKit's filesystem router); we verify the
 * file lives at the expected path AND that it imports the wizard
 * component. That's the file-system contract SvelteKit's adapter-static
 * walks at build time.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROUTE_DIR = resolve(__dirname, '../../src/routes/onboarding');
const PAGE_PATH = resolve(ROUTE_DIR, '+page.svelte');
const PAGE_TS_PATH = resolve(ROUTE_DIR, '+page.ts');

describe('T19 / G-T19-9 — production route mounts OnboardingFlow', () => {
  it('a /onboarding route exists at apps/web/src/routes/onboarding/+page.svelte', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('the route imports OnboardingFlow from the library + mounts it', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Either `$lib/onboarding/OnboardingFlow.svelte` or the relative
    // `../../lib/onboarding/OnboardingFlow.svelte` form is acceptable —
    // both reach the same file. We just pin the contract: the route
    // imports the wizard and mounts it.
    expect(src).toMatch(/import\s+OnboardingFlow\s+from\s+['"][^'"]*lib\/onboarding\/OnboardingFlow\.svelte['"]/);
    expect(src).toMatch(/<OnboardingFlow\b/);
  });

  it('the route does NOT forward any `__test_*` prop (ADR-0020 Decision 8: production strip)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Split-form check defeats constant-folding leak.
    const testProbe = '__test_' + 'step';
    const uaProbe = '__test_' + 'user_agent';
    const originProbe = '__test_' + 'origin';
    expect(src.includes(testProbe)).toBe(false);
    expect(src.includes(uaProbe)).toBe(false);
    expect(src.includes(originProbe)).toBe(false);
  });

  it('the route sets prerender=true + ssr=false (adapter-static + no SSR for PI safety)', () => {
    expect(existsSync(PAGE_TS_PATH)).toBe(true);
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+prerender\s*=\s*true/);
    expect(src).toMatch(/export\s+const\s+ssr\s*=\s*false/);
  });

  it('the route has a noindex meta tag (onboarding pages are not search-indexed)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('the <title> resolves via t() — onboarding.page_title + common.app_name, no hardcoded "Set up — JHSC"', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Per ADR-0009 every visible string (including <title>) goes
    // through the i18n catalog. The other route mounts already follow
    // this pattern; /onboarding was the last hold-out with a hardcoded
    // English title.
    expect(src).toMatch(/import\s*{[^}]*\bt\b[^}]*}\s+from\s+['"]\$lib\/i18n['"]/);
    expect(src).toMatch(/<title>\{t\(['"]onboarding\.page_title['"]\)\}\s*—\s*\{t\(['"]common\.app_name['"]\)\}<\/title>/);
    // Defense pin: the hardcoded literal must NOT survive the refactor.
    expect(src).not.toMatch(/<title>Set up — JHSC<\/title>/);
  });

  it('onboarding.page_title is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.onboarding).toBeDefined();
    expect(typeof catalog.onboarding.page_title).toBe('string');
  });
});
