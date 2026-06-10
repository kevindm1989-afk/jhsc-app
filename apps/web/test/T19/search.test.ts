/**
 * T19.1 — Cross-register search.
 *
 *   - `buildSearchIndex` produces records from every register (11
 *     register keys covered).
 *   - `search` filters case-insensitively across primaryText +
 *     secondaryText, groups by register in a canonical order, caps
 *     each group at `perGroupLimit` (default 5), and reports the
 *     pre-cap total per group.
 *   - The route page +page.svelte mounts the search input, reads
 *     `?q=` from the URL, and pins the i18n keys it references.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSearchIndex, search, PER_GROUP_LIMIT } from '../../src/lib/search/search';

describe('T19.1 — buildSearchIndex', () => {
  const index = buildSearchIndex();

  it('produces a non-empty index', () => {
    expect(index.length).toBeGreaterThan(0);
  });

  it('covers every register', () => {
    const registers = new Set(index.map((r) => r.register));
    const expected = [
      'concerns',
      'recommendations',
      'training',
      'work-refusal',
      's51-evidence',
      'reprisal',
      'minutes',
      'inspections',
      'library',
      'audit',
      'sensitive-feed'
    ];
    for (const e of expected) expect(registers.has(e as never)).toBe(true);
  });

  it('every record carries an id + primaryText + date + href', () => {
    for (const r of index.slice(0, 50)) {
      expect(typeof r.id).toBe('string');
      expect(r.id.length).toBeGreaterThan(0);
      expect(typeof r.primaryText).toBe('string');
      expect(r.primaryText.length).toBeGreaterThan(0);
      expect(typeof r.date).toBe('string');
      expect(r.href.startsWith('/')).toBe(true);
    }
  });
});

describe('T19.1 — search', () => {
  const index = buildSearchIndex();

  it('returns no groups for an empty query', () => {
    expect(search(index, '').length).toBe(0);
    expect(search(index, '   ').length).toBe(0);
  });

  it('matches case-insensitively on primaryText', () => {
    // "forklift" appears in the concerns + work-refusal title pools.
    const groups = search(index, 'forklift');
    expect(groups.length).toBeGreaterThan(0);
    const flat = groups.flatMap((g) => g.records);
    expect(flat.some((r) => /forklift/i.test(r.primaryText))).toBe(true);
  });

  it('matches case-insensitively on secondaryText', () => {
    // Training rows carry "expired" in their secondary text (validity).
    const groups = search(index, 'EXPIRED');
    const trainingGroup = groups.find((g) => g.register === 'training');
    if (trainingGroup) {
      for (const r of trainingGroup.records) {
        const text = (r.primaryText + ' ' + r.secondaryText).toLowerCase();
        expect(text.includes('expired')).toBe(true);
      }
    }
  });

  it('groups results by register in a canonical order', () => {
    const groups = search(index, 'a'); // very broad query
    // The first group, if there are multiple, should follow the
    // canonical order (concerns before audit / sensitive-feed).
    const registers = groups.map((g) => g.register);
    const order = [
      'concerns',
      'recommendations',
      'work-refusal',
      's51-evidence',
      'reprisal',
      'inspections',
      'minutes',
      'training',
      'library',
      'audit',
      'sensitive-feed'
    ];
    let last = -1;
    for (const r of registers) {
      const idx = order.indexOf(r);
      expect(idx).toBeGreaterThanOrEqual(last);
      last = idx;
    }
  });

  it('caps each group at PER_GROUP_LIMIT records and reports the pre-cap total', () => {
    const groups = search(index, 'a'); // broad enough to flood at least one group
    for (const g of groups) {
      expect(g.records.length).toBeLessThanOrEqual(PER_GROUP_LIMIT);
      expect(g.total).toBeGreaterThanOrEqual(g.records.length);
    }
  });

  it('within a group, records are sorted newest-first', () => {
    const groups = search(index, 'a');
    for (const g of groups) {
      for (let i = 1; i < g.records.length; i++) {
        expect(g.records[i - 1]!.date >= g.records[i]!.date).toBe(true);
      }
    }
  });
});

describe('T19.1 — /search route mount', () => {
  const PAGE_PATH = resolve(__dirname, '../../src/routes/search/+page.svelte');
  const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/search/+page.ts');

  it('the route exists', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
    expect(existsSync(PAGE_TS_PATH)).toBe(true);
  });

  it('+page.ts declares prerender + ssr posture (parity with the register routes)', () => {
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+prerender\s*=\s*true/);
    expect(src).toMatch(/export\s+const\s+ssr\s*=\s*false/);
  });

  it('renders the search input + back-to-home link', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid="search-input"/);
    expect(src).toMatch(/data-testid="search-page"/);
    expect(src).toMatch(/data-testid="search-back-to-home"/);
    expect(src).toMatch(/<a\s+href=["']\/["']/);
  });

  it('reads q from the URL via $page.url.searchParams', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/\$page\.url\.searchParams\.get\(['"]q['"]\)/);
  });

  it('carries a noindex meta', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });
});

describe('T19.1 — search.page.* i18n keys are present', () => {
  it('catalog has the key set', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    const p = catalog.search.page;
    for (const k of [
      'title',
      'heading',
      'intro',
      'label',
      'placeholder',
      'helper',
      'empty_state',
      'no_results',
      'summary',
      'group_total',
      'back_to_home_cta'
    ]) {
      expect(typeof p[k]).toBe('string');
    }
    for (const r of [
      'concerns',
      'recommendations',
      'training',
      'work-refusal',
      's51-evidence',
      'reprisal',
      'minutes',
      'inspections',
      'library',
      'audit',
      'sensitive-feed'
    ]) {
      expect(typeof p.register[r]).toBe('string');
    }
  });
});
