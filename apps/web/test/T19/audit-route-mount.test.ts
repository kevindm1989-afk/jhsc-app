/**
 * T19.1 — /audit coming-soon placeholder route mount.
 *
 * The append-only audit log itself is shipped server-side; the viewer
 * surface (scrollable feed, Merkle integrity verification UI,
 * retention-aware filtering) is a follow-on. The placeholder lands
 * the URL so a worker who navigates here from a future nav link
 * doesn't 404. Same pattern as the rest of the placeholder route tests.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/audit/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/audit/+page.ts');

describe('T19.1 — /audit route mount (coming-soon placeholder)', () => {
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

  it('the page carries the audit-page data-testid + a heading via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']audit-page["']/);
    expect(src).toMatch(/t\(['"]common\.auditPage\.heading['"]\)/);
  });

  it('renders the coming-soon notice (so the user knows the surface is pending)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']audit-coming-soon-notice["']/);
    expect(src).toMatch(/t\(['"]common\.auditPage\.coming_soon_body['"]\)/);
  });

  it('surfaces the four "what this will do" bullets via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/t\(['"]common\.auditPage\.bullet_append_only['"]\)/);
    expect(src).toMatch(/t\(['"]common\.auditPage\.bullet_pseudonymized['"]\)/);
    expect(src).toMatch(/t\(['"]common\.auditPage\.bullet_merkle_integrity['"]\)/);
    expect(src).toMatch(/t\(['"]common\.auditPage\.bullet_retention_aware['"]\)/);
  });

  it('renders a back-to-home link so the user is not stranded', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']audit-back-to-home["']/);
    expect(src).toMatch(/t\(['"]common\.auditPage\.back_to_home_cta['"]\)/);
  });

  it('carries a noindex meta (placeholder route should not be indexed)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('every common.auditPage.* key referenced is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.common.auditPage).toBeDefined();
    expect(typeof catalog.common.auditPage.title).toBe('string');
    expect(typeof catalog.common.auditPage.heading).toBe('string');
    expect(typeof catalog.common.auditPage.coming_soon_body).toBe('string');
    expect(typeof catalog.common.auditPage.what_this_will_do_heading).toBe('string');
    expect(typeof catalog.common.auditPage.bullet_append_only).toBe('string');
    expect(typeof catalog.common.auditPage.bullet_pseudonymized).toBe('string');
    expect(typeof catalog.common.auditPage.bullet_merkle_integrity).toBe('string');
    expect(typeof catalog.common.auditPage.bullet_retention_aware).toBe('string');
    expect(typeof catalog.common.auditPage.back_to_home_cta).toBe('string');
  });
});
