/**
 * T19 — /saved-views sort toggle + pinned-only filter chip +
 * per-row pinned badge.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(
  resolve(__dirname, '../../src/routes/saved-views/+page.svelte'),
  'utf8'
);

describe('T19 — /saved-views sort toggle', () => {
  it('declares a sortMode variable with the four canonical modes', () => {
    expect(SRC).toMatch(/let\s+sortMode\s*=\s*['"]newest['"]/);
    // Pin the union of the four modes appears in the source as a
    // jsdoc / persistence path so a refactor that drops a mode trips
    // the test.
    expect(SRC).toContain("'newest'");
    expect(SRC).toContain("'oldest'");
    expect(SRC).toContain("'name-asc'");
    expect(SRC).toContain("'name-desc'");
  });

  it('renders a <select> wired to sortMode with the four options', () => {
    expect(SRC).toMatch(/data-testid=["']saved-views-sort-select["']/);
    expect(SRC).toMatch(/bind:value=\{sortMode\}/);
    for (const v of ['newest', 'oldest', 'name-asc', 'name-desc']) {
      expect(SRC).toMatch(new RegExp(`<option\\s+value=["']${v}["']>`));
    }
  });

  it('declares a sortViews helper that branches on each mode', () => {
    expect(SRC).toMatch(/function\s+sortViews\(/);
    expect(SRC).toMatch(/case\s+['"]oldest['"]/);
    expect(SRC).toMatch(/case\s+['"]name-asc['"]/);
    expect(SRC).toMatch(/case\s+['"]name-desc['"]/);
    expect(SRC).toMatch(/localeCompare\(/);
  });

  it('the rendered list is sorted via sortViews(nameFilteredViews, sortMode)', () => {
    expect(SRC).toMatch(/filteredViews\s*=\s*sortViews\(nameFilteredViews,\s*sortMode\)/);
  });

  it('persists the chosen sort to localStorage + loads it on mount', () => {
    expect(SRC).toMatch(/SORT_STORAGE_KEY\s*=\s*['"]jhsc-saved-views-sort['"]/);
    expect(SRC).toMatch(/localStorage\.setItem\(SORT_STORAGE_KEY/);
    expect(SRC).toMatch(/localStorage\.getItem\(SORT_STORAGE_KEY/);
    expect(SRC).toMatch(/loadSort\(\)/);
  });
});

describe('T19 — /saved-views pinned-only filter chip', () => {
  it('declares a pinnedOnly toggle binding', () => {
    expect(SRC).toMatch(/let\s+pinnedOnly\s*=\s*false/);
  });

  it('narrowedViews drops unpinned rows when pinnedOnly is on', () => {
    expect(SRC).toMatch(
      /narrowedViews\s*=\s*pinnedOnly\s*\?\s*views\.filter\(\(v\)\s*=>\s*v\.pinnedToHome\)/
    );
  });

  it('renders an aria-pressed chip that toggles the filter', () => {
    expect(SRC).toMatch(/data-testid=["']saved-views-pinned-only["']/);
    expect(SRC).toMatch(/aria-pressed=\{pinnedOnly\s*\?\s*['"]true['"]/);
    expect(SRC).toMatch(/pinnedOnly\s*=\s*!pinnedOnly/);
  });
});

describe('T19 — per-row pinned indicator badge', () => {
  it('renders the badge inside each row when v.pinnedToHome is truthy', () => {
    expect(SRC).toMatch(/data-testid=["']saved-views-pinned-badge["']/);
    expect(SRC).toMatch(/{#if v\.pinnedToHome}/);
  });
});

describe('T19 — i18n keys for the new affordances', () => {
  const catalog = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
  );

  it('savedViewsPage carries sort + pinned strings', () => {
    expect(typeof catalog.common.savedViewsPage.sort_label).toBe('string');
    expect(typeof catalog.common.savedViewsPage.sort_aria).toBe('string');
    expect(typeof catalog.common.savedViewsPage.sort_newest).toBe('string');
    expect(typeof catalog.common.savedViewsPage.sort_oldest).toBe('string');
    expect(typeof catalog.common.savedViewsPage.sort_name_asc).toBe('string');
    expect(typeof catalog.common.savedViewsPage.sort_name_desc).toBe('string');
    expect(typeof catalog.common.savedViewsPage.pinned_only).toBe('string');
    expect(typeof catalog.common.savedViewsPage.pinned_badge).toBe('string');
    expect(typeof catalog.common.savedViewsPage.pinned_badge_aria).toBe('string');
  });
});
