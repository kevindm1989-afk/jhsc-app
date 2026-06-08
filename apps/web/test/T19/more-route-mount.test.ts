/**
 * T19.1 — /more launcher route mount.
 *
 * The /more route surfaces every product surface in the app in one
 * directory, grouped by purpose (Field intake / Deliberation /
 * Reference / Monitoring / Account). Bridges the discoverability gap
 * between the small bottom tab bar and the 11+ placeholder + real
 * routes that have shipped.
 *
 * This test pins:
 *   - The route exists at /more (prerender + ssr=false per app shell).
 *   - The five group sections are present (Field intake, Deliberation,
 *     Reference, Monitoring, Account).
 *   - Every product-surface link is present and points to the canonical
 *     URL (drift-proof — if a route is renamed, the launcher link
 *     needs to follow).
 *   - The catalog has every key the page references.
 *   - The back-to-home link is present.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../../src/routes/more/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/more/+page.ts');

describe('T19.1 — /more route mount (launcher)', () => {
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

  it('the page carries the more-page data-testid + a heading via t()', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']more-page["']/);
    expect(src).toMatch(/t\(['"]common\.morePage\.heading['"]\)/);
  });

  it('renders the five group sections (intake, deliberation, reference, monitoring, account)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']more-group-intake["']/);
    expect(src).toMatch(/data-testid=["']more-group-deliberation["']/);
    expect(src).toMatch(/data-testid=["']more-group-reference["']/);
    expect(src).toMatch(/data-testid=["']more-group-monitoring["']/);
    expect(src).toMatch(/data-testid=["']more-group-account["']/);
  });

  it('field-intake links point to /concerns, /reprisal, /work-refusal, /s51-evidence, /inspections', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/concerns["'][^>]*data-testid=["']more-link-concerns["']/);
    expect(src).toMatch(/<a\s+href=["']\/reprisal["'][^>]*data-testid=["']more-link-reprisal["']/);
    expect(src).toMatch(/<a\s+href=["']\/work-refusal["'][^>]*data-testid=["']more-link-work-refusal["']/);
    expect(src).toMatch(/<a\s+href=["']\/s51-evidence["'][^>]*data-testid=["']more-link-s51["']/);
    expect(src).toMatch(/<a\s+href=["']\/inspections["'][^>]*data-testid=["']more-link-inspections["']/);
  });

  it('deliberation links point to /minutes + /recommendations', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/minutes["'][^>]*data-testid=["']more-link-minutes["']/);
    expect(src).toMatch(/<a\s+href=["']\/recommendations["'][^>]*data-testid=["']more-link-recommendations["']/);
  });

  it('reference links point to /library + /training', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/library["'][^>]*data-testid=["']more-link-library["']/);
    expect(src).toMatch(/<a\s+href=["']\/training["'][^>]*data-testid=["']more-link-training["']/);
  });

  it('monitoring links point to /audit + /sensitive-feed', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/audit["'][^>]*data-testid=["']more-link-audit["']/);
    expect(src).toMatch(/<a\s+href=["']\/sensitive-feed["'][^>]*data-testid=["']more-link-sensitive-feed["']/);
  });

  it('account links point to /settings + /privacy', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/settings["'][^>]*data-testid=["']more-link-settings["']/);
    expect(src).toMatch(/<a\s+href=["']\/privacy["'][^>]*data-testid=["']more-link-privacy["']/);
  });

  it('renders a back-to-home link so the user is not stranded', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']more-back-to-home["']/);
    expect(src).toMatch(/t\(['"]common\.morePage\.back_to_home_cta['"]\)/);
  });

  it('carries a noindex meta (launcher should not be indexed)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });

  it('every common.morePage.* key referenced is present in the root catalog', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const more = catalog.common.morePage;
    expect(more).toBeDefined();
    // Spot-check the structural keys.
    expect(typeof more.title).toBe('string');
    expect(typeof more.heading).toBe('string');
    expect(typeof more.intro).toBe('string');
    expect(typeof more.back_to_home_cta).toBe('string');
    // Spot-check each group + each link's label + blurb.
    for (const group of ['intake', 'deliberation', 'reference', 'monitoring', 'account']) {
      expect(typeof more[`group_${group}_heading`]).toBe('string');
      expect(typeof more[`group_${group}_blurb`]).toBe('string');
    }
    for (const link of [
      'concerns',
      'reprisal',
      'work_refusal',
      's51',
      'inspections',
      'minutes',
      'recommendations',
      'library',
      'training',
      'audit',
      'sensitive_feed',
      'settings',
      'privacy'
    ]) {
      expect(typeof more[`link_${link}_label`]).toBe('string');
      expect(typeof more[`link_${link}_blurb`]).toBe('string');
    }
  });
});
