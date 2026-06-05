/**
 * T19.1 — /recommendations coming-soon placeholder route mount.
 *
 * The T12 timer infrastructure is library-only today; production
 * wire-up (real recommendation store, employer-response capture,
 * auto-escalation alarm, export-deliberate flow into T11) is deferred.
 * This placeholder lands the URL + the four-bullet contract so a worker
 * who navigates here from a future nav link doesn't 404 and sees
 * what's coming.
 *
 * Same pattern as the /concerns + /reprisal + /inspections + /minutes
 * placeholder tests.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/recommendations/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/recommendations/+page.ts');

describe('T19.1 — /recommendations route mount (coming-soon placeholder)', () => {
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

  it('the page carries the recommendations-page data-testid + a heading via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']recommendations-page["']/);
    expect(src).toMatch(/t\(['"]common\.recommendationsPage\.heading['"]\)/);
  });

  it('renders the coming-soon notice (so the user knows the surface is pending)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']recommendations-coming-soon-notice["']/);
    expect(src).toMatch(/t\(['"]common\.recommendationsPage\.coming_soon_body['"]\)/);
  });

  it('surfaces the four "what this will do" bullets via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/t\(['"]common\.recommendationsPage\.bullet_21_day_timer['"]\)/);
    expect(src).toMatch(/t\(['"]common\.recommendationsPage\.bullet_auto_escalation['"]\)/);
    expect(src).toMatch(/t\(['"]common\.recommendationsPage\.bullet_traceability['"]\)/);
    expect(src).toMatch(/t\(['"]common\.recommendationsPage\.bullet_export_deliberate['"]\)/);
  });

  it('renders a back-to-home link so the user is not stranded', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']recommendations-back-to-home["']/);
    expect(src).toMatch(/t\(['"]common\.recommendationsPage\.back_to_home_cta['"]\)/);
  });

  it('carries a noindex meta (placeholder route should not be indexed)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('every common.recommendationsPage.* key referenced is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.common.recommendationsPage).toBeDefined();
    expect(typeof catalog.common.recommendationsPage.title).toBe('string');
    expect(typeof catalog.common.recommendationsPage.heading).toBe('string');
    expect(typeof catalog.common.recommendationsPage.coming_soon_body).toBe('string');
    expect(typeof catalog.common.recommendationsPage.what_this_will_do_heading).toBe('string');
    expect(typeof catalog.common.recommendationsPage.bullet_21_day_timer).toBe('string');
    expect(typeof catalog.common.recommendationsPage.bullet_auto_escalation).toBe('string');
    expect(typeof catalog.common.recommendationsPage.bullet_traceability).toBe('string');
    expect(typeof catalog.common.recommendationsPage.bullet_export_deliberate).toBe('string');
    expect(typeof catalog.common.recommendationsPage.back_to_home_cta).toBe('string');
  });
});
