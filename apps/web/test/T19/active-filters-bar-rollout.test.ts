/**
 * T19 — ActiveFiltersBar rollout to every register + audit + sensitive-feed.
 *
 * Pins that each of the 11 surfaces (10 here + /concerns from the
 * previous bundle) imports the bar, computes a reactive activeFilters
 * array, and mounts the component near the top of its markup.
 *
 * Single-axis surfaces all follow the same shape: { filter, date,
 * sort } pills with route-specific labels. The test asserts the
 * structural skeleton rather than every label so route refactors
 * don't ripple here.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SINGLE_AXIS_ROUTES = [
  'training',
  'work-refusal',
  's51-evidence',
  // 'reprisal' RETIRED — ADR-0028 Phase 2b PR1: live /reprisal has no demo
  // ActiveFiltersBar (no client-side filter axes over the E2EE feed).
  'minutes',
  'inspections',
  'library',
  'recommendations',
  'audit',
  'sensitive-feed'
] as const;

describe('T19 — ActiveFiltersBar rollout (single-axis surfaces)', () => {
  for (const route of SINGLE_AXIS_ROUTES) {
    describe(`/${route}`, () => {
      const src = readFileSync(
        resolve(__dirname, `../../src/routes/${route}/+page.svelte`),
        'utf8'
      );

      it('imports ActiveFiltersBar', () => {
        expect(src).toMatch(
          /import\s+ActiveFiltersBar\s+from\s+['"]\$lib\/ui\/ActiveFiltersBar\.svelte['"]/
        );
      });

      it('imports buildHref (needed to construct removeHref URLs)', () => {
        expect(src).toMatch(
          /import\s+\{\s*buildHref\s*\}\s+from\s+['"]\$lib\/ui\/url-state['"]/
        );
      });

      it('computes a reactive activeFilters array', () => {
        expect(src).toMatch(/\$:\s*activeFilters\s*=/);
      });

      it('mounts <ActiveFiltersBar /> with the active filters', () => {
        expect(src).toMatch(
          /<ActiveFiltersBar\s+baseHref=["']\/[a-z0-9-]+["']\s+filters=\{activeFilters\}\s*\/>/
        );
      });

      it('includes a date-range pill descriptor (key: "date")', () => {
        expect(src).toContain("key: 'date'");
      });

      it('includes a sort pill descriptor (key: "sort")', () => {
        expect(src).toContain("key: 'sort'");
      });

      it('includes a primary-axis filter pill descriptor (key: "filter")', () => {
        expect(src).toContain("key: 'filter'");
      });
    });
  }
});
