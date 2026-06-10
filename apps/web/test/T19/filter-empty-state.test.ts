/**
 * T19.1 — Filter-aware empty state across the 9 register viewers.
 *
 * Each viewer accepts a `filterActive` prop (default false) that
 * swaps the empty-state copy from "No <X> on file yet" to a generic
 * "No matches for this filter…" message. The route page passes
 * `filterActive={filterParam !== null}` so the macro filters and
 * chip filters both surface the right message.
 *
 * This test covers the two extreme cases on a representative viewer
 * (ConcernsViewer) — without filterActive the existing copy renders;
 * with filterActive the new common copy renders — plus a structural
 * pin that every route page passes the prop through.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ConcernsViewer from '../../src/lib/concerns/ConcernsViewer.svelte';
import RecommendationsViewer from '../../src/lib/recommendations/RecommendationsViewer.svelte';

afterEach(() => {
  cleanup();
});

const ROUTES = [
  'concerns',
  'recommendations',
  'training',
  'work-refusal',
  's51-evidence',
  'reprisal',
  'minutes',
  'inspections',
  'library'
] as const;

describe('T19.1 — filter-aware empty state (ConcernsViewer)', () => {
  it('renders the legacy empty copy when filterActive is false (back-compat)', async () => {
    const fetchPage = vi.fn(async () => ({ rows: [], total: 0, page: 0, page_size: 10 }));
    render(ConcernsViewer, { props: { fetchPage, filterActive: false } });
    await waitFor(() => {
      expect(screen.getByTestId('con-empty')).toBeDefined();
    });
    const text = screen.getByTestId('con-empty').textContent ?? '';
    expect(text).toMatch(/No concerns on file/i);
    expect(text).not.toMatch(/no matches/i);
  });

  it('renders the "no matches" copy when filterActive is true', async () => {
    const fetchPage = vi.fn(async () => ({ rows: [], total: 0, page: 0, page_size: 10 }));
    render(ConcernsViewer, { props: { fetchPage, filterActive: true } });
    await waitFor(() => {
      expect(screen.getByTestId('con-empty')).toBeDefined();
    });
    const text = screen.getByTestId('con-empty').textContent ?? '';
    expect(text).toMatch(/no matches/i);
  });
});

describe('T19.1 — filter-aware empty state (RecommendationsViewer)', () => {
  it('renders the "no matches" copy when filterActive is true', async () => {
    const fetchPage = vi.fn(async () => ({ rows: [], total: 0, page: 0, page_size: 10 }));
    render(RecommendationsViewer, { props: { fetchPage, filterActive: true } });
    await waitFor(() => {
      expect(screen.getByTestId('recs-empty')).toBeDefined();
    });
    const text = screen.getByTestId('recs-empty').textContent ?? '';
    expect(text).toMatch(/no matches/i);
  });
});

describe('T19.1 — every register route passes filterActive to its viewer', () => {
  for (const route of ROUTES) {
    it(`/${route} passes filterActive=<truthy-when-filtered>`, () => {
      const src = readFileSync(
        resolve(__dirname, '../../src/routes', route, '+page.svelte'),
        'utf8'
      );
      // Most routes pass `filterParam !== null`. /concerns supports
      // multi-axis filtering and passes the OR of all axes instead.
      const ok =
        /filterActive=\{filterParam\s*!==\s*null\}/.test(src) ||
        /filterActive=\{anyAxisActive\}/.test(src);
      expect(ok).toBe(true);
    });
  }
});

describe('T19.1 — common.filterEmptyState.* i18n keys are in the catalog', () => {
  it('catalog has the no_matches string', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(catalog.common.filterEmptyState).toBeDefined();
    expect(typeof catalog.common.filterEmptyState.no_matches).toBe('string');
  });
});
