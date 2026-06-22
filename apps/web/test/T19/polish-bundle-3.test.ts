/**
 * T19.1 — Polish bundle 3: active filter echoed in each viewer's h1.
 *
 *   - Each viewer accepts a `filterLabel` prop (default null) and
 *     renders ` — {filterLabel}` after its heading when set.
 *   - Each register route computes `activeFilterLabel` and passes it
 *     to the viewer alongside the existing `filterActive` prop.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ConcernsViewer from '../../src/lib/concerns/ConcernsViewer.svelte';
import RecommendationsViewer from '../../src/lib/recommendations/RecommendationsViewer.svelte';

afterEach(() => {
  cleanup();
});

const ROUTES = [
  // 'concerns' RETIRED — ADR-0027 Phase 2a PR2: live /concerns no longer
  // exposes a viewer-side activeFilterLabel chain.
  'recommendations',
  'training',
  'work-refusal',
  's51-evidence',
  // 'reprisal' RETIRED — ADR-0028 Phase 2b PR1: live /reprisal no longer
  // exposes a viewer-side activeFilterLabel chain.
  'minutes',
  'inspections',
  'library',
  'audit',
  'sensitive-feed'
] as const;

const VIEWERS: ReadonlyArray<readonly [string, string]> = [
  ['concerns', 'ConcernsViewer'],
  ['recommendations', 'RecommendationsViewer'],
  ['training', 'TrainingViewer'],
  ['work-refusal', 'WorkRefusalViewer'],
  ['s51-evidence', 'S51EvidenceViewer'],
  ['reprisal', 'ReprisalViewer'],
  ['minutes', 'MinutesViewer'],
  ['inspections', 'InspectionsViewer'],
  ['library', 'LibraryViewer'],
  ['audit', 'AuditLogViewer'],
  ['audit', 'SensitiveFeedViewer']
];

const ROOT = resolve(__dirname, '../..');

function viewerSrc(dir: string, name: string): string {
  return readFileSync(resolve(ROOT, 'src/lib', dir, `${name}.svelte`), 'utf8');
}

function routeSrc(route: string): string {
  return readFileSync(resolve(ROOT, 'src/routes', route, '+page.svelte'), 'utf8');
}

describe('T19.1 — each viewer declares the filterLabel prop and renders the heading-echo block', () => {
  for (const [dir, name] of VIEWERS) {
    it(`${name}`, () => {
      const src = viewerSrc(dir, name);
      expect(src).toMatch(/export\s+let\s+filterLabel\s*=\s*null/);
      expect(src).toMatch(/data-testid="viewer-heading-filter"/);
      // The h1 wraps the echo in {#if filterLabel}…{/if}
      expect(src).toMatch(/\{#if\s+filterLabel\}/);
    });
  }
});

describe('T19.1 — each register route computes activeFilterLabel + passes it to the viewer', () => {
  for (const route of ROUTES) {
    it(`/${route}/+page.svelte`, () => {
      const src = routeSrc(route);
      expect(src).toMatch(/\$:\s*activeFilterLabel\s*=/);
      expect(src).toMatch(/filterLabel=\{activeFilterLabel\}/);
    });
  }
});

describe('T19.1 — ConcernsViewer renders the heading echo only when filterLabel is set', () => {
  it('without filterLabel, the echo span is absent', async () => {
    const fetchPage = vi.fn(async () => ({ rows: [], total: 0, page: 0, page_size: 10 }));
    render(ConcernsViewer, { props: { fetchPage } });
    expect(screen.queryByTestId('viewer-heading-filter')).toBeNull();
  });

  it('with filterLabel, the echo span appears and contains the label', async () => {
    const fetchPage = vi.fn(async () => ({ rows: [], total: 0, page: 0, page_size: 10 }));
    render(ConcernsViewer, { props: { fetchPage, filterLabel: 'Open' } });
    const echo = screen.getByTestId('viewer-heading-filter');
    expect(echo.textContent ?? '').toMatch(/Open/);
    expect(echo.textContent ?? '').toMatch(/—/);
  });
});

describe('T19.1 — RecommendationsViewer renders the heading echo too', () => {
  it('with filterLabel, the echo span appears', async () => {
    const fetchPage = vi.fn(async () => ({ rows: [], total: 0, page: 0, page_size: 10 }));
    render(RecommendationsViewer, { props: { fetchPage, filterLabel: 'Overdue' } });
    expect(screen.getByTestId('viewer-heading-filter').textContent ?? '').toMatch(/Overdue/);
  });
});
