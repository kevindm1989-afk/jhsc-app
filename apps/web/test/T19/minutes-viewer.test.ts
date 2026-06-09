/**
 * T19.1 — MinutesViewer + demo-minutes provider.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import MinutesViewer from '../../src/lib/minutes/MinutesViewer.svelte';
import {
  buildDemoMinutes,
  fetchDemoMinutesPage,
  type DemoMinutesRow
} from '../../src/lib/minutes/demo-minutes';

afterEach(() => {
  cleanup();
});

describe('T19.1 — buildDemoMinutes / fetchDemoMinutesPage', () => {
  it('builds exactly N rows', () => {
    expect(buildDemoMinutes(20).length).toBe(20);
  });

  it('is deterministic for a given seed', () => {
    const a = buildDemoMinutes(10, 1234);
    const b = buildDemoMinutes(10, 1234);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(a.map((r) => r.status)).toEqual(b.map((r) => r.status));
    expect(a.map((r) => r.title)).toEqual(b.map((r) => r.title));
  });

  it('every row carries one of the three canonical statuses', () => {
    const allowed = new Set(['draft', 'approved', 'archived']);
    for (const row of buildDemoMinutes(50)) {
      expect(allowed.has(row.status)).toBe(true);
    }
  });

  it('a 50-row dataset includes multiple statuses (mix is realistic)', () => {
    const rows = buildDemoMinutes(50);
    const statuses = new Set(rows.map((r) => r.status));
    expect(statuses.size).toBeGreaterThan(1);
  });

  it('orders rows newest-first (descending meeting_date)', () => {
    const rows = buildDemoMinutes(50);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.meeting_date >= rows[i]!.meeting_date).toBe(true);
    }
  });

  it('quorum_present is non-null only for approved rows', () => {
    for (const row of buildDemoMinutes(100)) {
      if (row.status === 'approved') {
        expect(row.quorum_present).not.toBeNull();
        expect(typeof row.quorum_present).toBe('number');
      } else {
        expect(row.quorum_present).toBeNull();
      }
    }
  });

  it('revision_count is at least 1 and quoted_concern_count is non-negative', () => {
    for (const row of buildDemoMinutes(100)) {
      expect(row.revision_count).toBeGreaterThanOrEqual(1);
      expect(row.revision_count).toBeLessThanOrEqual(10);
      expect(row.quoted_concern_count).toBeGreaterThanOrEqual(0);
      expect(row.quoted_concern_count).toBeLessThanOrEqual(5);
    }
  });

  it('fetchDemoMinutesPage returns the right slice + total', async () => {
    const all = buildDemoMinutes(35, 9);
    const p0 = await fetchDemoMinutesPage(0, 10, all);
    expect(p0.rows.length).toBe(10);
    expect(p0.total).toBe(35);
    expect(p0.rows[0]?.id).toBe(all[0]?.id);
  });
});

describe('T19.1 — MinutesViewer render states', () => {
  it('renders the approval note + loading state on mount', () => {
    const fetchPage = vi.fn(async () => new Promise<never>(() => {}));
    render(MinutesViewer, { props: { fetchPage } });
    expect(screen.getByTestId('min-approval-note')).toBeDefined();
    expect(screen.getByTestId('min-loading')).toBeDefined();
  });

  it('renders the empty state when fetchPage returns no rows', async () => {
    const fetchPage = vi.fn(async () => ({ rows: [], total: 0, page: 0, page_size: 10 }));
    render(MinutesViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('min-empty')).toBeDefined();
    });
  });

  it('surfaces the load-error alert when fetchPage throws', async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error('boom');
    });
    render(MinutesViewer, { props: { fetchPage } });
    await waitFor(() => {
      const err = screen.getByTestId('min-load-error');
      expect(err.getAttribute('role')).toBe('alert');
    });
  });

  it('renders one row per minute with status pin + title + chips', async () => {
    const sample: DemoMinutesRow[] = [
      {
        id: 'min-001',
        meeting_date: '2026-06-01T00:00:00.000Z',
        title: 'Monthly meeting — fall protection action plan',
        status: 'approved',
        revision_count: 3,
        quoted_concern_count: 2,
        quorum_present: 5,
        drafter_pseudonym: 'a1b2c3d4e5f6'
      },
      {
        id: 'min-002',
        meeting_date: '2026-05-01T00:00:00.000Z',
        title: 'Quarterly review — incident statistics',
        status: 'draft',
        revision_count: 1,
        quoted_concern_count: 0,
        quorum_present: null,
        drafter_pseudonym: 'feedfacebeef'
      }
    ];
    const fetchPage = vi.fn(async () => ({ rows: sample, total: 2, page: 0, page_size: 10 }));
    render(MinutesViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getAllByTestId('min-row').length).toBe(2);
    });
    const statuses = screen.getAllByTestId('min-row').map((r) => r.getAttribute('data-status'));
    expect(statuses).toEqual(['approved', 'draft']);
    const titles = screen.getAllByTestId('min-row-title').map((t) => t.textContent);
    expect(titles[0]).toMatch(/fall protection/);
    expect(titles[1]).toMatch(/incident statistics/);
  });

  it('Quorum chip renders only on approved rows; quoted chip only when count > 0', async () => {
    const sample: DemoMinutesRow[] = [
      {
        id: 'min-001',
        meeting_date: '2026-06-01T00:00:00.000Z',
        title: 'a',
        status: 'approved',
        revision_count: 2,
        quoted_concern_count: 3,
        quorum_present: 6,
        drafter_pseudonym: 'a1b2c3d4e5f6'
      },
      {
        id: 'min-002',
        meeting_date: '2026-05-01T00:00:00.000Z',
        title: 'b',
        status: 'draft',
        revision_count: 4,
        quoted_concern_count: 0,
        quorum_present: null,
        drafter_pseudonym: 'a1b2c3d4e5f6'
      },
      {
        id: 'min-003',
        meeting_date: '2026-04-01T00:00:00.000Z',
        title: 'c',
        status: 'archived',
        revision_count: 6,
        quoted_concern_count: 1,
        quorum_present: null,
        drafter_pseudonym: 'a1b2c3d4e5f6'
      }
    ];
    const fetchPage = vi.fn(async () => ({ rows: sample, total: 3, page: 0, page_size: 10 }));
    render(MinutesViewer, { props: { fetchPage } });
    await waitFor(() => {
      // Only the approved row has a quorum chip.
      expect(screen.queryAllByTestId('min-quorum-chip').length).toBe(1);
    });
    // Quoted-concerns chip appears on the approved row (3) and the archived row (1), not the draft (0).
    expect(screen.queryAllByTestId('min-quoted-chip').length).toBe(2);
    // Revision + drafter chips always render.
    expect(screen.queryAllByTestId('min-revision-chip').length).toBe(3);
    expect(screen.queryAllByTestId('min-drafter-chip').length).toBe(3);
  });
});

describe('T19.1 — MinutesViewer pagination', () => {
  it('Next button calls fetchPage with the next page index', async () => {
    const all = buildDemoMinutes(30, 9);
    const fetchPage = vi.fn(async (page: number, page_size: number) =>
      fetchDemoMinutesPage(page, page_size, all)
    );
    render(MinutesViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('min-next')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('min-next'));
    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(fetchPage.mock.calls[1]![0]).toBe(1);
    });
  });
});
