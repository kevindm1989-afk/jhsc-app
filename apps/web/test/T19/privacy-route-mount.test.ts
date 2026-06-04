/**
 * T19.1 — /privacy route mount.
 *
 * Before this PR, the D2 view rendered `<a href="/privacy">` to "Read
 * the full privacy policy" but no /privacy route existed — the link
 * 404'd. This test pins the structural contract for the placeholder
 * route:
 *   - The route exists at apps/web/src/routes/privacy/+page.svelte.
 *   - It declares prerender + ssr=false in +page.ts (parity with the
 *     rest of the app shell — no PI on the route surface).
 *   - All visible text resolves via t() per ADR-0009.
 *   - It carries a noindex meta (placeholder pages should not be
 *     indexed; the canonical policy lands later under HG-10 lawyer
 *     review).
 *   - It surfaces the four already-structurally-enforced contracts
 *     (no third-party JS, local-first encryption, pseudonymized audit
 *     log, PI-scrubbed crash logs) as a short bullet list so the user
 *     sees the posture even before the prose policy ships.
 *   - A back-to-home link gives the user a path out.
 *
 * The wording inside each bullet is placeholder text in the i18n
 * catalog; the lawyer-review-triggered finalization changes the
 * catalog entries only, not the structural shape this test pins.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/privacy/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/privacy/+page.ts');

describe('T19.1 — /privacy route mount', () => {
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

  it('the page carries the privacy-page data-testid + a heading via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']privacy-page["']/);
    expect(src).toMatch(/t\(['"]common\.privacyPage\.heading['"]\)/);
  });

  it('renders the placeholder notice (so the user knows the formal policy is pending)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']privacy-placeholder-notice["']/);
    expect(src).toMatch(/t\(['"]common\.privacyPage\.placeholder_body['"]\)/);
  });

  it('surfaces the four structural-contract bullets via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/t\(['"]common\.privacyPage\.bullet_no_third_party['"]\)/);
    expect(src).toMatch(/t\(['"]common\.privacyPage\.bullet_local_first['"]\)/);
    expect(src).toMatch(/t\(['"]common\.privacyPage\.bullet_audit['"]\)/);
    expect(src).toMatch(/t\(['"]common\.privacyPage\.bullet_no_pi_logs['"]\)/);
  });

  it('renders a back-to-home link so the user is not stranded', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']privacy-back-to-home["']/);
    expect(src).toMatch(/t\(['"]common\.privacyPage\.back_to_home_cta['"]\)/);
  });

  it('carries a noindex meta (placeholder route should not be indexed)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('every common.privacyPage.* key referenced is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.common.privacyPage).toBeDefined();
    expect(typeof catalog.common.privacyPage.title).toBe('string');
    expect(typeof catalog.common.privacyPage.heading).toBe('string');
    expect(typeof catalog.common.privacyPage.placeholder_body).toBe('string');
    expect(typeof catalog.common.privacyPage.summary_heading).toBe('string');
    expect(typeof catalog.common.privacyPage.summary_intro).toBe('string');
    expect(typeof catalog.common.privacyPage.bullet_no_third_party).toBe('string');
    expect(typeof catalog.common.privacyPage.bullet_local_first).toBe('string');
    expect(typeof catalog.common.privacyPage.bullet_audit).toBe('string');
    expect(typeof catalog.common.privacyPage.bullet_no_pi_logs).toBe('string');
    expect(typeof catalog.common.privacyPage.back_to_home_cta).toBe('string');
  });
});
