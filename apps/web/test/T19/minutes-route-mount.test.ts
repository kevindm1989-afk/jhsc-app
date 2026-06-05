/**
 * T19.1 — /minutes coming-soon placeholder route mount.
 *
 * The minutes module is a follow-on product surface; library code is
 * partially scaffolded (audit-log enums for minutes events) but no
 * intake component ships yet. The placeholder lands the URL + the
 * four-bullet contract so a worker who navigates here from a future
 * nav link doesn't 404 and sees what's coming.
 *
 * Same pattern as the /concerns + /reprisal + /inspections placeholder
 * tests.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/minutes/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/minutes/+page.ts');

describe('T19.1 — /minutes route mount (coming-soon placeholder)', () => {
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

  it('the page carries the minutes-page data-testid + a heading via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']minutes-page["']/);
    expect(src).toMatch(/t\(['"]common\.minutesPage\.heading['"]\)/);
  });

  it('renders the coming-soon notice (so the user knows the surface is pending)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']minutes-coming-soon-notice["']/);
    expect(src).toMatch(/t\(['"]common\.minutesPage\.coming_soon_body['"]\)/);
  });

  it('surfaces the four "what this will do" bullets via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/t\(['"]common\.minutesPage\.bullet_worker_side_drafts['"]\)/);
    expect(src).toMatch(/t\(['"]common\.minutesPage\.bullet_approval_gated['"]\)/);
    expect(src).toMatch(/t\(['"]common\.minutesPage\.bullet_revision_history['"]\)/);
    expect(src).toMatch(/t\(['"]common\.minutesPage\.bullet_quoted_consent['"]\)/);
  });

  it('renders a back-to-home link so the user is not stranded', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']minutes-back-to-home["']/);
    expect(src).toMatch(/t\(['"]common\.minutesPage\.back_to_home_cta['"]\)/);
  });

  it('carries a noindex meta (placeholder route should not be indexed)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('every common.minutesPage.* key referenced is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.common.minutesPage).toBeDefined();
    expect(typeof catalog.common.minutesPage.title).toBe('string');
    expect(typeof catalog.common.minutesPage.heading).toBe('string');
    expect(typeof catalog.common.minutesPage.coming_soon_body).toBe('string');
    expect(typeof catalog.common.minutesPage.what_this_will_do_heading).toBe('string');
    expect(typeof catalog.common.minutesPage.bullet_worker_side_drafts).toBe('string');
    expect(typeof catalog.common.minutesPage.bullet_approval_gated).toBe('string');
    expect(typeof catalog.common.minutesPage.bullet_revision_history).toBe('string');
    expect(typeof catalog.common.minutesPage.bullet_quoted_consent).toBe('string');
    expect(typeof catalog.common.minutesPage.back_to_home_cta).toBe('string');
  });
});
