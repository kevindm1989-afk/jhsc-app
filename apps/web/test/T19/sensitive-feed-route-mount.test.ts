/**
 * T19.1 — /sensitive-feed coming-soon placeholder route mount.
 *
 * Worker co-chair + worker certified member C3/C4 activity feed. The
 * placeholder lands the URL so an authorized member who navigates here
 * from a future nav link doesn't 404. Same pattern as the rest of the
 * placeholder route tests.
 *
 * Sensitivity-tier-aware: the page carries the same 4px destructive-
 * red inline-start border as /reprisal, /s51-evidence, and
 * PanicWipeModal. This test pins that binding so a refactor can't
 * silently drop the C3/C4 gravity signal.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/sensitive-feed/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/sensitive-feed/+page.ts');

describe('T19.1 — /sensitive-feed route mount (coming-soon placeholder)', () => {
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

  it('the page carries the sensitive-feed-page data-testid + a heading via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']sensitive-feed-page["']/);
    expect(src).toMatch(/t\(['"]common\.sensitiveFeedPage\.heading['"]\)/);
  });

  it('renders the coming-soon notice (so the user knows the surface is pending)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']sensitive-feed-coming-soon-notice["']/);
    expect(src).toMatch(/t\(['"]common\.sensitiveFeedPage\.coming_soon_body['"]\)/);
  });

  it('surfaces the four "what this will do" bullets via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/t\(['"]common\.sensitiveFeedPage\.bullet_metadata_only['"]\)/);
    expect(src).toMatch(/t\(['"]common\.sensitiveFeedPage\.bullet_c3_c4_scoped['"]\)/);
    expect(src).toMatch(/t\(['"]common\.sensitiveFeedPage\.bullet_export_deliberate['"]\)/);
    expect(src).toMatch(/t\(['"]common\.sensitiveFeedPage\.bullet_role_gated['"]\)/);
  });

  it('renders a back-to-home link so the user is not stranded', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']sensitive-feed-back-to-home["']/);
    expect(src).toMatch(/t\(['"]common\.sensitiveFeedPage\.back_to_home_cta['"]\)/);
  });

  it('carries a noindex meta (placeholder route should not be indexed)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('the .sensitive-feed-card class binds a destructive-red inline-start border (C3/C4 sensitivity accent)', () => {
    // Defense pin: the visual gravity signal lives on the card border.
    // Mirrors the s51-route-mount.test.ts pin — every C3/C4 surface in
    // the worker-hub language must carry the destructive accent.
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/\.sensitive-feed-card\s*\{[^}]*border-inline-start:\s*4px\s+solid\s+var\(--color-destructive\)/);
  });

  it('every common.sensitiveFeedPage.* key referenced is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.common.sensitiveFeedPage).toBeDefined();
    expect(typeof catalog.common.sensitiveFeedPage.title).toBe('string');
    expect(typeof catalog.common.sensitiveFeedPage.heading).toBe('string');
    expect(typeof catalog.common.sensitiveFeedPage.coming_soon_body).toBe('string');
    expect(typeof catalog.common.sensitiveFeedPage.what_this_will_do_heading).toBe('string');
    expect(typeof catalog.common.sensitiveFeedPage.bullet_metadata_only).toBe('string');
    expect(typeof catalog.common.sensitiveFeedPage.bullet_c3_c4_scoped).toBe('string');
    expect(typeof catalog.common.sensitiveFeedPage.bullet_export_deliberate).toBe('string');
    expect(typeof catalog.common.sensitiveFeedPage.bullet_role_gated).toBe('string');
    expect(typeof catalog.common.sensitiveFeedPage.back_to_home_cta).toBe('string');
  });
});
