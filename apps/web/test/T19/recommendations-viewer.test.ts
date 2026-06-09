/**
 * T19.1 — RecommendationsViewer + demo-recommendations provider.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import RecommendationsViewer from '../../src/lib/recommendations/RecommendationsViewer.svelte';
import {
  buildDemoRecommendations,
  fetchDemoRecommendationsPage,
  type DemoRecommendationRow
} from '../../src/lib/recommendations/demo-recommendations';

afterEach(() => {
  cleanup();
});

describe('T19.1 — buildDemoRecommendations / fetchDemoRecommendationsPage', () => {
  it('builds exactly N rows', () => {
    expect(buildDemoRecommendations(20).length).toBe(20);
  });

  it('is deterministic for a given seed', () => {
    const a = buildDemoRecommendations(10, 1234);
    const b = buildDemoRecommendations(10, 1234);
    expect(a.map((r) => r.status)).toEqual(b.map((r) => r.status));
    expect(a.map((r) => r.title)).toEqual(b.map((r) => r.title));
  });

  it('every row carries one of the four canonical statuses', () => {
    const allowed = new Set(['responded', 'pending', 'overdue', 'archived']);
    for (const row of buildDemoRecommendations(50)) {
      expect(allowed.has(row.status)).toBe(true);
    }
  });

  it('a 50-row dataset includes multiple statuses (mix is realistic)', () => {
    const rows = buildDemoRecommendations(50);
    const statuses = new Set(rows.map((r) => r.status));
    // Expect at least 2 different statuses across 50 rows.
    expect(statuses.size).toBeGreaterThan(1);
  });

  it('orders rows newest-first (descending filed_at)', () => {
    const rows = buildDemoRecommendations(50);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.filed_at >= rows[i]!.filed_at).toBe(true);
    }
  });

  it('every row carries traceability to a concern OR an inspection (never both null)', () => {
    for (const row of buildDemoRecommendations(50)) {
      expect(row.traceability_concern_id !== null || row.traceability_inspection_id !== null).toBe(
        true
      );
    }
  });

  it('overdue rows have days_elapsed > 21', () => {
    for (const row of buildDemoRecommendations(100)) {
      if (row.status === 'overdue') {
        expect(row.days_elapsed).toBeGreaterThan(21);
      }
    }
  });

  it('fetchDemoRecommendationsPage returns the right slice + total', async () => {
    const all = buildDemoRecommendations(35, 9);
    const p0 = await fetchDemoRecommendationsPage(0, 10, all);
    expect(p0.rows.length).toBe(10);
    expect(p0.total).toBe(35);
    expect(p0.rows[0]?.id).toBe(all[0]?.id);
  });
});

describe('T19.1 — RecommendationsViewer render states', () => {
  it('renders the timer note + loading state on mount', () => {
    const fetchPage = vi.fn(async () => new Promise<never>(() => {}));
    render(RecommendationsViewer, { props: { fetchPage } });
    expect(screen.getByTestId('recs-timer-note')).toBeDefined();
    expect(screen.getByTestId('recs-loading')).toBeDefined();
  });

  it('renders the empty state when fetchPage returns no rows', async () => {
    const fetchPage = vi.fn(async () => ({ rows: [], total: 0, page: 0, page_size: 10 }));
    render(RecommendationsViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('recs-empty')).toBeDefined();
    });
  });

  it('surfaces the load-error alert when fetchPage throws', async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error('boom');
    });
    render(RecommendationsViewer, { props: { fetchPage } });
    await waitFor(() => {
      const err = screen.getByTestId('recs-load-error');
      expect(err.getAttribute('role')).toBe('alert');
    });
  });

  it('renders one row per recommendation with status chip + title + traceability', async () => {
    const sample: DemoRecommendationRow[] = [
      {
        id: 'rec-001',
        title: 'Replace worn fall-arrest anchor on the upper catwalk',
        filed_at: '2026-06-01T00:00:00.000Z',
        days_elapsed: 8,
        status: 'pending',
        traceability_concern_id: 'con-42',
        traceability_inspection_id: null,
        actor_pseudonym: 'a1b2c3d4e5f6'
      },
      {
        id: 'rec-002',
        title: 'Resurface the loading-dock approach to fix the trip hazard',
        filed_at: '2026-05-01T00:00:00.000Z',
        days_elapsed: 39,
        status: 'overdue',
        traceability_concern_id: null,
        traceability_inspection_id: 'ins-7',
        actor_pseudonym: 'feedfacebeef'
      }
    ];
    const fetchPage = vi.fn(async () => ({ rows: sample, total: 2, page: 0, page_size: 10 }));
    render(RecommendationsViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getAllByTestId('recs-row').length).toBe(2);
    });
    const statuses = screen.getAllByTestId('recs-row').map((r) => r.getAttribute('data-status'));
    expect(statuses).toEqual(['pending', 'overdue']);
    const titles = screen.getAllByTestId('recs-row-title').map((t) => t.textContent);
    expect(titles[0]).toMatch(/fall-arrest/);
    expect(titles[1]).toMatch(/loading-dock/);
    // Traceability chips: concern on row 0, inspection on row 1.
    const traceChips = screen.getAllByTestId('recs-trace-chip');
    expect(traceChips.length).toBe(2);
  });

  it('Day-of-21 counter renders for pending + overdue but NOT for responded / archived', async () => {
    const sample: DemoRecommendationRow[] = [
      {
        id: 'rec-001',
        title: 'a',
        filed_at: '2026-06-01T00:00:00.000Z',
        days_elapsed: 8,
        status: 'pending',
        traceability_concern_id: 'con-1',
        traceability_inspection_id: null,
        actor_pseudonym: 'a1b2c3d4e5f6'
      },
      {
        id: 'rec-002',
        title: 'b',
        filed_at: '2026-05-01T00:00:00.000Z',
        days_elapsed: 3,
        status: 'responded',
        traceability_concern_id: 'con-2',
        traceability_inspection_id: null,
        actor_pseudonym: 'a1b2c3d4e5f6'
      },
      {
        id: 'rec-003',
        title: 'c',
        filed_at: '2026-04-01T00:00:00.000Z',
        days_elapsed: 60,
        status: 'archived',
        traceability_concern_id: 'con-3',
        traceability_inspection_id: null,
        actor_pseudonym: 'a1b2c3d4e5f6'
      }
    ];
    const fetchPage = vi.fn(async () => ({ rows: sample, total: 3, page: 0, page_size: 10 }));
    render(RecommendationsViewer, { props: { fetchPage } });
    await waitFor(() => {
      const counters = screen.queryAllByTestId('recs-day-counter');
      // Only the pending row has a counter.
      expect(counters.length).toBe(1);
    });
  });
});

describe('T19.1 — RecommendationsViewer pagination', () => {
  it('Next button calls fetchPage with the next page index', async () => {
    const all = buildDemoRecommendations(30, 9);
    const fetchPage = vi.fn(async (page: number, page_size: number) =>
      fetchDemoRecommendationsPage(page, page_size, all)
    );
    render(RecommendationsViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('recs-next')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('recs-next'));
    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(fetchPage.mock.calls[1]![0]).toBe(1);
    });
  });
});
