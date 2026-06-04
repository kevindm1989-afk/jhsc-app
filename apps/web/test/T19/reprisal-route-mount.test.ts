/**
 * T19.1 — /reprisal coming-soon placeholder route mount.
 *
 * The intake component (`ReprisalIntakeForm.svelte`) is shipped and
 * tested, but the production wire-up (T13.1 — submit handler bound to
 * `SupabaseReprisalClient`, per-entry passphrase derivation, audit
 * emission) is a separate focused PR. Until then the /reprisal route
 * renders a placeholder card so a worker who navigates here from a
 * future nav link or a shared URL doesn't 404 and sees what's coming.
 *
 * Worse than other placeholder surfaces because reprisal entries are
 * sensitivity C4 (the highest tier) — mounting an unwired form would
 * be a data-loss risk for the most sensitive content type the app
 * handles. Placeholder posture is the safer interim.
 *
 * This test pins the placeholder's structural shape so a future
 * refactor (e.g. the T13.1 mount swap) is deliberate.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/reprisal/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/reprisal/+page.ts');

describe('T19.1 — /reprisal route mount (coming-soon placeholder)', () => {
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

  it('the page carries the reprisal-page data-testid + a heading via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']reprisal-page["']/);
    expect(src).toMatch(/t\(['"]common\.reprisalPage\.heading['"]\)/);
  });

  it('renders the coming-soon notice (so the user knows the intake is pending)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']reprisal-coming-soon-notice["']/);
    expect(src).toMatch(/t\(['"]common\.reprisalPage\.coming_soon_body['"]\)/);
  });

  it('surfaces the four "what this will do" bullets via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/t\(['"]common\.reprisalPage\.bullet_consent_per_intake['"]\)/);
    expect(src).toMatch(/t\(['"]common\.reprisalPage\.bullet_per_entry_passphrase['"]\)/);
    expect(src).toMatch(/t\(['"]common\.reprisalPage\.bullet_actor_visible_to_author['"]\)/);
    expect(src).toMatch(/t\(['"]common\.reprisalPage\.bullet_ohsa_reminder['"]\)/);
  });

  it('renders a back-to-home link so the user is not stranded', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']reprisal-back-to-home["']/);
    expect(src).toMatch(/t\(['"]common\.reprisalPage\.back_to_home_cta['"]\)/);
  });

  it('carries a noindex meta (placeholder route should not be indexed)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('every common.reprisalPage.* key referenced is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.common.reprisalPage).toBeDefined();
    expect(typeof catalog.common.reprisalPage.title).toBe('string');
    expect(typeof catalog.common.reprisalPage.heading).toBe('string');
    expect(typeof catalog.common.reprisalPage.coming_soon_body).toBe('string');
    expect(typeof catalog.common.reprisalPage.what_this_will_do_heading).toBe('string');
    expect(typeof catalog.common.reprisalPage.bullet_consent_per_intake).toBe('string');
    expect(typeof catalog.common.reprisalPage.bullet_per_entry_passphrase).toBe('string');
    expect(typeof catalog.common.reprisalPage.bullet_actor_visible_to_author).toBe('string');
    expect(typeof catalog.common.reprisalPage.bullet_ohsa_reminder).toBe('string');
    expect(typeof catalog.common.reprisalPage.back_to_home_cta).toBe('string');
  });
});
