/**
 * T19 — csvFilename now encodes the active filter axes so distinct
 * filtered exports get distinct filenames; per-route call sites pass
 * the active filter axes; and i18n / aggregator additions are sound.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { csvFilename } from '../../src/lib/ui/csv';

describe('T19 — csvFilename with axes', () => {
  const DATE = new Date(Date.UTC(2026, 5, 11, 12, 0, 0));

  it('returns prefix-YYYY-MM-DD.csv when no axes are supplied', () => {
    expect(csvFilename('concerns', DATE)).toBe('concerns-2026-06-11.csv');
    expect(csvFilename('concerns', DATE, [])).toBe('concerns-2026-06-11.csv');
  });

  it('encodes axes into the middle of the filename', () => {
    expect(csvFilename('concerns', DATE, ['open', 'high'])).toBe(
      'concerns-open-high-2026-06-11.csv'
    );
  });

  it('sanitizes non-alphanumeric characters to dashes', () => {
    expect(csvFilename('audit', DATE, ['Status: Open', 'Severity / high'])).toBe(
      'audit-status-open-severity-high-2026-06-11.csv'
    );
  });

  it('lowercases axis values', () => {
    expect(csvFilename('audit', DATE, ['SESSIONS'])).toBe('audit-sessions-2026-06-11.csv');
  });

  it('drops empty axes after sanitization', () => {
    expect(csvFilename('audit', DATE, ['', '  ', '!@#'])).toBe('audit-2026-06-11.csv');
  });

  it('caps a single axis at 32 characters', () => {
    const longish = 'x'.repeat(60);
    const out = csvFilename('audit', DATE, [longish]);
    // The middle portion (axis) is 32 chars of x.
    expect(out).toBe(`audit-${'x'.repeat(32)}-2026-06-11.csv`);
  });
});

describe('T19 — register routes pass active filter axes into csvFilename', () => {
  const ROUTES = [
    'training',
    'work-refusal',
    's51-evidence',
    'reprisal',
    'minutes',
    'inspections',
    'library',
    'recommendations',
    // 'concerns' RETIRED — ADR-0027 Phase 2a PR2: the live /concerns surface
    // does not ship CSV export in Phase 2a (Decision 8 future scope).
    'audit',
    'sensitive-feed'
  ] as const;

  for (const route of ROUTES) {
    it(`/${route} calls csvFilename with the new Date() + activeFilters map`, () => {
      const src = readFileSync(
        resolve(__dirname, `../../src/routes/${route}/+page.svelte`),
        'utf8'
      );
      expect(src).toMatch(
        /csvFilename\(\s*['"][a-z0-9-]+['"]\s*,\s*new Date\(\)\s*,\s*activeFilters\.map\(/
      );
    });
  }
});
