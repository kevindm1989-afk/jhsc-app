/**
 * T19.1 — /concerns coming-soon placeholder route mount.
 *
 * The intake component (`ConcernIntakeForm.svelte`) is shipped and
 * tested, but the production wire-up (T08.1 — submit handler bound to
 * `SupabaseConcernClient`, audit emission) is a separate focused PR.
 * Until then the /concerns route renders a placeholder card so a
 * worker who navigates here from a future nav link or a shared URL
 * doesn't 404 and sees what's coming.
 *
 * This test pins the placeholder's structural shape so a future
 * refactor (e.g. the T08.1 mount swap) is deliberate. When T08.1
 * lands and the form replaces the placeholder, this test will be
 * rewritten to assert the form-mount contract instead.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/concerns/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/concerns/+page.ts');

describe('T19.1 — /concerns route mount (coming-soon placeholder)', () => {
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

  it('the page carries the concerns-page data-testid + a heading via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']concerns-page["']/);
    expect(src).toMatch(/t\(['"]common\.concernsPage\.heading['"]\)/);
  });

  it('renders the coming-soon notice (so the user knows the intake is pending)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']concerns-coming-soon-notice["']/);
    expect(src).toMatch(/t\(['"]common\.concernsPage\.coming_soon_body['"]\)/);
  });

  it('surfaces the four "what this will do" bullets via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/t\(['"]common\.concernsPage\.bullet_anonymous_default['"]\)/);
    expect(src).toMatch(/t\(['"]common\.concernsPage\.bullet_encrypted['"]\)/);
    expect(src).toMatch(/t\(['"]common\.concernsPage\.bullet_audit_pseudonym['"]\)/);
    expect(src).toMatch(/t\(['"]common\.concernsPage\.bullet_no_employer_disclosure['"]\)/);
  });

  it('renders a back-to-home link so the user is not stranded', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']concerns-back-to-home["']/);
    expect(src).toMatch(/t\(['"]common\.concernsPage\.back_to_home_cta['"]\)/);
  });

  it('carries a noindex meta (placeholder route should not be indexed)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('every common.concernsPage.* key referenced is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.common.concernsPage).toBeDefined();
    expect(typeof catalog.common.concernsPage.title).toBe('string');
    expect(typeof catalog.common.concernsPage.heading).toBe('string');
    expect(typeof catalog.common.concernsPage.coming_soon_body).toBe('string');
    expect(typeof catalog.common.concernsPage.what_this_will_do_heading).toBe('string');
    expect(typeof catalog.common.concernsPage.bullet_anonymous_default).toBe('string');
    expect(typeof catalog.common.concernsPage.bullet_encrypted).toBe('string');
    expect(typeof catalog.common.concernsPage.bullet_audit_pseudonym).toBe('string');
    expect(typeof catalog.common.concernsPage.bullet_no_employer_disclosure).toBe('string');
    expect(typeof catalog.common.concernsPage.back_to_home_cta).toBe('string');
  });
});
