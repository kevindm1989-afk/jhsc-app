/**
 * T19.1 — /work-refusal coming-soon placeholder route mount.
 *
 * OHSA s. 43 work-refusal capture surface. Library scaffolding for
 * the stage machine (refusal → s. 43(4) joint investigation →
 * s. 43(8) Ministry escalation) doesn't ship yet; until then the
 * route renders a placeholder so a worker who navigates here from
 * a future nav link doesn't 404. Same pattern as the rest of the
 * placeholder route tests.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/work-refusal/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/work-refusal/+page.ts');

describe('T19.1 — /work-refusal route mount (coming-soon placeholder)', () => {
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

  it('the page carries the work-refusal-page data-testid + a heading via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']work-refusal-page["']/);
    expect(src).toMatch(/t\(['"]common\.workRefusalPage\.heading['"]\)/);
  });

  it('renders the coming-soon notice (so the user knows the surface is pending)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']work-refusal-coming-soon-notice["']/);
    expect(src).toMatch(/t\(['"]common\.workRefusalPage\.coming_soon_body['"]\)/);
  });

  it('surfaces the four "what this will do" bullets via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/t\(['"]common\.workRefusalPage\.bullet_right_to_refuse['"]\)/);
    expect(src).toMatch(/t\(['"]common\.workRefusalPage\.bullet_stage_gated['"]\)/);
    expect(src).toMatch(/t\(['"]common\.workRefusalPage\.bullet_certified_member_visibility['"]\)/);
    expect(src).toMatch(/t\(['"]common\.workRefusalPage\.bullet_audit_full_chain['"]\)/);
  });

  it('renders a back-to-home link so the user is not stranded', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']work-refusal-back-to-home["']/);
    expect(src).toMatch(/t\(['"]common\.workRefusalPage\.back_to_home_cta['"]\)/);
  });

  it('carries a noindex meta (placeholder route should not be indexed)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('every common.workRefusalPage.* key referenced is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.common.workRefusalPage).toBeDefined();
    expect(typeof catalog.common.workRefusalPage.title).toBe('string');
    expect(typeof catalog.common.workRefusalPage.heading).toBe('string');
    expect(typeof catalog.common.workRefusalPage.coming_soon_body).toBe('string');
    expect(typeof catalog.common.workRefusalPage.what_this_will_do_heading).toBe('string');
    expect(typeof catalog.common.workRefusalPage.bullet_right_to_refuse).toBe('string');
    expect(typeof catalog.common.workRefusalPage.bullet_stage_gated).toBe('string');
    expect(typeof catalog.common.workRefusalPage.bullet_certified_member_visibility).toBe('string');
    expect(typeof catalog.common.workRefusalPage.bullet_audit_full_chain).toBe('string');
    expect(typeof catalog.common.workRefusalPage.back_to_home_cta).toBe('string');
  });
});
