/**
 * T19.1 — /inspections coming-soon placeholder route mount.
 *
 * The T10 inspection queue library is shipped (offline-first queue,
 * per-entry HMAC integrity tags, photo sanitize) but production wire-up
 * is deferred to T10.1 (real IndexedDB-backed store, PhotoCaptureSurface
 * UI, ServiceWorker integration, real-canvas EXIF re-encode). Until then
 * the /inspections route renders a placeholder card so a worker who
 * navigates here from a future nav link doesn't 404 and sees what's
 * coming.
 *
 * Same pattern as the /concerns + /reprisal placeholder tests
 * (concerns-route-mount.test.ts, reprisal-route-mount.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/inspections/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/inspections/+page.ts');

describe('T19.1 — /inspections route mount (coming-soon placeholder)', () => {
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

  it('the page carries the inspections-page data-testid + a heading via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']inspections-page["']/);
    expect(src).toMatch(/t\(['"]common\.inspectionsPage\.heading['"]\)/);
  });

  it('renders the coming-soon notice (so the user knows the surface is pending)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']inspections-coming-soon-notice["']/);
    expect(src).toMatch(/t\(['"]common\.inspectionsPage\.coming_soon_body['"]\)/);
  });

  it('surfaces the four "what this will do" bullets via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/t\(['"]common\.inspectionsPage\.bullet_ohsa_monthly['"]\)/);
    expect(src).toMatch(/t\(['"]common\.inspectionsPage\.bullet_offline_first['"]\)/);
    expect(src).toMatch(/t\(['"]common\.inspectionsPage\.bullet_integrity_tag['"]\)/);
    expect(src).toMatch(/t\(['"]common\.inspectionsPage\.bullet_photo_sanitize['"]\)/);
  });

  it('renders a back-to-home link so the user is not stranded', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']inspections-back-to-home["']/);
    expect(src).toMatch(/t\(['"]common\.inspectionsPage\.back_to_home_cta['"]\)/);
  });

  it('carries a noindex meta (placeholder route should not be indexed)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('every common.inspectionsPage.* key referenced is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.common.inspectionsPage).toBeDefined();
    expect(typeof catalog.common.inspectionsPage.title).toBe('string');
    expect(typeof catalog.common.inspectionsPage.heading).toBe('string');
    expect(typeof catalog.common.inspectionsPage.coming_soon_body).toBe('string');
    expect(typeof catalog.common.inspectionsPage.what_this_will_do_heading).toBe('string');
    expect(typeof catalog.common.inspectionsPage.bullet_ohsa_monthly).toBe('string');
    expect(typeof catalog.common.inspectionsPage.bullet_offline_first).toBe('string');
    expect(typeof catalog.common.inspectionsPage.bullet_integrity_tag).toBe('string');
    expect(typeof catalog.common.inspectionsPage.bullet_photo_sanitize).toBe('string');
    expect(typeof catalog.common.inspectionsPage.back_to_home_cta).toBe('string');
  });
});
