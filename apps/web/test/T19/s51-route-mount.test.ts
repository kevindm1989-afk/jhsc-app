/**
 * T19.1 — /s51-evidence coming-soon placeholder route mount.
 *
 * OHSA s. 51 critical-injury evidence surface (T14 sibling task).
 * T14 library scaffolding exists for the s51_evidence schema but no
 * intake component ships yet. The placeholder lands the URL + the
 * four-bullet contract so a worker who navigates here from a future
 * nav link doesn't 404.
 *
 * Sensitivity-tier-aware: the page carries the same 4px destructive-
 * red inline-start border as /reprisal and PanicWipeModal (the C4
 * accent the rest of the worker-hub language uses for high-
 * consequence surfaces). This test pins that visual signal lives on
 * the .s51-card class so a refactor can't silently drop it.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/s51-evidence/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/s51-evidence/+page.ts');

describe('T19.1 — /s51-evidence route mount (coming-soon placeholder)', () => {
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

  it('the page carries the s51-page data-testid + a heading via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']s51-page["']/);
    expect(src).toMatch(/t\(['"]common\.s51Page\.heading['"]\)/);
  });

  it('renders the coming-soon notice (so the user knows the surface is pending)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']s51-coming-soon-notice["']/);
    expect(src).toMatch(/t\(['"]common\.s51Page\.coming_soon_body['"]\)/);
  });

  it('surfaces the four "what this will do" bullets via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/t\(['"]common\.s51Page\.bullet_worker_member_present['"]\)/);
    expect(src).toMatch(/t\(['"]common\.s51Page\.bullet_scene_preservation['"]\)/);
    expect(src).toMatch(/t\(['"]common\.s51Page\.bullet_c4_encryption['"]\)/);
    expect(src).toMatch(/t\(['"]common\.s51Page\.bullet_photo_sanitize['"]\)/);
  });

  it('renders a back-to-home link so the user is not stranded', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']s51-back-to-home["']/);
    expect(src).toMatch(/t\(['"]common\.s51Page\.back_to_home_cta['"]\)/);
  });

  it('carries a noindex meta (placeholder route should not be indexed)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('the .s51-card class binds a destructive-red inline-start border (C4 sensitivity accent)', () => {
    // Defense pin: the visual gravity signal lives on the card border.
    // A refactor that strips the inline-start border would drop the
    // C4 accent that /reprisal + PanicWipeModal also carry.
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/\.s51-card\s*\{[^}]*border-inline-start:\s*4px\s+solid\s+var\(--color-destructive\)/);
  });

  it('every common.s51Page.* key referenced is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.common.s51Page).toBeDefined();
    expect(typeof catalog.common.s51Page.title).toBe('string');
    expect(typeof catalog.common.s51Page.heading).toBe('string');
    expect(typeof catalog.common.s51Page.coming_soon_body).toBe('string');
    expect(typeof catalog.common.s51Page.what_this_will_do_heading).toBe('string');
    expect(typeof catalog.common.s51Page.bullet_worker_member_present).toBe('string');
    expect(typeof catalog.common.s51Page.bullet_scene_preservation).toBe('string');
    expect(typeof catalog.common.s51Page.bullet_c4_encryption).toBe('string');
    expect(typeof catalog.common.s51Page.bullet_photo_sanitize).toBe('string');
    expect(typeof catalog.common.s51Page.back_to_home_cta).toBe('string');
  });
});
