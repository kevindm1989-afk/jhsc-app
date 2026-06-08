/**
 * T19.1 — /library coming-soon placeholder route mount.
 *
 * The library module is a follow-on product surface; no intake or
 * viewer component ships yet. The placeholder lands the URL so a
 * worker who navigates here from a future nav link doesn't 404.
 * Same pattern as the rest of the placeholder route tests.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/library/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/library/+page.ts');

describe('T19.1 — /library route mount (coming-soon placeholder)', () => {
  it('the +page.svelte component exists at the expected path', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('the +page.ts loader exists alongside the component', () => {
    expect(existsSync(PAGE_TS_PATH)).toBe(true);
  });

  it('+page.ts declares prerender = true (parity with the rest of the app shell)', () => {
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+prerender\s*=\s*true/);
  });

  it('+page.ts declares ssr = false (no PI on the route surface)', () => {
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+ssr\s*=\s*false/);
  });

  it('the page carries the library-page data-testid + a heading via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']library-page["']/);
    expect(src).toMatch(/t\(['"]common\.libraryPage\.heading['"]\)/);
  });

  it('renders the coming-soon notice (so the user knows the surface is pending)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']library-coming-soon-notice["']/);
    expect(src).toMatch(/t\(['"]common\.libraryPage\.coming_soon_body['"]\)/);
  });

  it('surfaces the four "what this will do" bullets via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/t\(['"]common\.libraryPage\.bullet_versioned['"]\)/);
    expect(src).toMatch(/t\(['"]common\.libraryPage\.bullet_offline_cache['"]\)/);
    expect(src).toMatch(/t\(['"]common\.libraryPage\.bullet_search['"]\)/);
    expect(src).toMatch(/t\(['"]common\.libraryPage\.bullet_committee_scoped['"]\)/);
  });

  it('renders a back-to-home link so the user is not stranded', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']library-back-to-home["']/);
    expect(src).toMatch(/t\(['"]common\.libraryPage\.back_to_home_cta['"]\)/);
  });

  it('carries a noindex meta (placeholder route should not be indexed)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('every common.libraryPage.* key referenced is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.common.libraryPage).toBeDefined();
    expect(typeof catalog.common.libraryPage.title).toBe('string');
    expect(typeof catalog.common.libraryPage.heading).toBe('string');
    expect(typeof catalog.common.libraryPage.coming_soon_body).toBe('string');
    expect(typeof catalog.common.libraryPage.what_this_will_do_heading).toBe('string');
    expect(typeof catalog.common.libraryPage.bullet_versioned).toBe('string');
    expect(typeof catalog.common.libraryPage.bullet_offline_cache).toBe('string');
    expect(typeof catalog.common.libraryPage.bullet_search).toBe('string');
    expect(typeof catalog.common.libraryPage.bullet_committee_scoped).toBe('string');
    expect(typeof catalog.common.libraryPage.back_to_home_cta).toBe('string');
  });
});
