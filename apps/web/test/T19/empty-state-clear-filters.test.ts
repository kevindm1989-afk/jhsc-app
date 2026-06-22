/**
 * T19 — viewers expose a clearHref prop and surface a "Clear filters"
 * link in their filter-empty state.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VIEWERS = [
  'concerns/ConcernsViewer.svelte',
  'recommendations/RecommendationsViewer.svelte',
  'training/TrainingViewer.svelte',
  'work-refusal/WorkRefusalViewer.svelte',
  's51-evidence/S51EvidenceViewer.svelte',
  'reprisal/ReprisalViewer.svelte',
  'minutes/MinutesViewer.svelte',
  'inspections/InspectionsViewer.svelte',
  'library/LibraryViewer.svelte',
  'audit/AuditLogViewer.svelte',
  'audit/SensitiveFeedViewer.svelte'
] as const;

describe('T19 — viewers expose clearHref prop + render Clear-filters link', () => {
  for (const v of VIEWERS) {
    describe(v, () => {
      const src = readFileSync(resolve(__dirname, '../../src/lib', v), 'utf8');

      it('declares a clearHref prop (default empty)', () => {
        expect(src).toMatch(/export\s+let\s+clearHref\s*=\s*['"]['"]/);
      });

      it('renders a Clear-filters link gated on filterActive && clearHref', () => {
        expect(src).toMatch(/#if\s+filterActive\s*&&\s*clearHref/);
        expect(src).toMatch(/data-testid=["'][a-z0-9-]+-empty-clear["']/);
        expect(src).toContain('common.filterEmptyState.clear_filters');
      });
    });
  }
});

const ROUTES = {
  training: '/training',
  'work-refusal': '/work-refusal',
  's51-evidence': '/s51-evidence',
  // 'reprisal' RETIRED — ADR-0028 Phase 2b PR1: the live /reprisal page no
  // longer mounts a viewer with a clearHref prop. Its post-cutover surface is
  // asserted by apps/web/test/T13b/phase2b-reprisal-page-cutover.test.ts.
  minutes: '/minutes',
  inspections: '/inspections',
  library: '/library',
  recommendations: '/recommendations',
  // 'concerns' RETIRED — ADR-0027 Phase 2a PR2: the live /concerns page no
  // longer mounts a viewer with a clearHref prop. Its post-cutover empty
  // state is asserted by the PR2 page-cutover test.
  audit: '/audit',
  'sensitive-feed': '/sensitive-feed'
} as const;

describe('T19 — register routes pass clearHref to their viewer', () => {
  for (const [route, base] of Object.entries(ROUTES)) {
    it(`/${route} passes clearHref="${base}"`, () => {
      const src = readFileSync(
        resolve(__dirname, `../../src/routes/${route}/+page.svelte`),
        'utf8'
      );
      expect(src).toMatch(new RegExp(`clearHref=["']${base}["']`));
    });
  }
});

describe('T19 — common.filterEmptyState.clear_filters i18n key', () => {
  it('catalog carries the Clear-filters label', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(typeof catalog.common.filterEmptyState.clear_filters).toBe('string');
  });
});
