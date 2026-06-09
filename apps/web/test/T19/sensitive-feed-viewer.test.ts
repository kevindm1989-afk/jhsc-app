/**
 * T19.1 — SensitiveFeedViewer + demo-sensitive-feed provider.
 *
 * Pins:
 *   - The demo generator emits a mix of C3 + C4 rows; the C4 fraction
 *     is bounded (so the surface always shows both tiers in a 50-row
 *     dataset).
 *   - The generator is deterministic (same seed → same rows).
 *   - Rows are ordered newest-first by `ts`.
 *   - Page slicer returns the right shape + windows.
 *   - The viewer renders the role-gating note, loading, empty, error,
 *     and row-list states with the right testids.
 *   - Per-row badge surfaces the sensitivity tier (C3 / C4); rows
 *     carry a `data-sensitivity` attribute equal to 'c3' or 'c4'.
 *   - Pagination buttons advance / retreat the provider.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import SensitiveFeedViewer from '../../src/lib/audit/SensitiveFeedViewer.svelte';
import {
  buildDemoSensitiveRows,
  fetchDemoSensitivePage,
  type DemoSensitiveRow
} from '../../src/lib/audit/demo-sensitive-feed';

afterEach(() => {
  cleanup();
});

describe('T19.1 — buildDemoSensitiveRows / fetchDemoSensitivePage', () => {
  it('builds exactly N rows', () => {
    const rows = buildDemoSensitiveRows(20);
    expect(rows.length).toBe(20);
  });

  it('is deterministic for a given seed', () => {
    const a = buildDemoSensitiveRows(10, 1234);
    const b = buildDemoSensitiveRows(10, 1234);
    expect(a.map((r) => r.event_type)).toEqual(b.map((r) => r.event_type));
    expect(a.map((r) => r.sensitivity)).toEqual(b.map((r) => r.sensitivity));
  });

  it('a 50-row dataset includes both C3 AND C4 rows', () => {
    const rows = buildDemoSensitiveRows(50);
    const tiers = new Set(rows.map((r) => r.sensitivity));
    expect(tiers.has('c3')).toBe(true);
    expect(tiers.has('c4')).toBe(true);
  });

  it('orders rows newest-first (descending ts)', () => {
    const rows = buildDemoSensitiveRows(50);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.ts >= rows[i]!.ts).toBe(true);
    }
  });

  it('every row event_type is one of the canonical C3/C4 event lists', () => {
    const allowed = new Set([
      'concern.created',
      'concern.updated',
      'minutes.draft_created',
      'minutes.draft_updated',
      'inspection.submitted',
      'recommendation.created',
      'recommendation.responded',
      'reprisal.created',
      'reprisal.updated',
      'reprisal.source_revealed',
      'work_refusal.created',
      'work_refusal.stage_advanced',
      's51_evidence.created',
      's51_evidence.scene_preserved'
    ]);
    const rows = buildDemoSensitiveRows(50);
    for (const row of rows) {
      expect(allowed.has(row.event_type)).toBe(true);
    }
  });

  it('fetchDemoSensitivePage returns the correct slice + total', async () => {
    const all = buildDemoSensitiveRows(35, 7);
    const p0 = await fetchDemoSensitivePage(0, 10, all);
    expect(p0.rows.length).toBe(10);
    expect(p0.total).toBe(35);
    expect(p0.page).toBe(0);
    expect(p0.rows[0]?.id).toBe(all[0]?.id);

    const last = await fetchDemoSensitivePage(3, 10, all);
    expect(last.rows.length).toBe(5);
  });
});

describe('T19.1 — SensitiveFeedViewer render states', () => {
  it('renders the role-gating note + loading state on mount', () => {
    const fetchPage = vi.fn(async () => new Promise<never>(() => {}));
    render(SensitiveFeedViewer, { props: { fetchPage } });
    expect(screen.getByTestId('sensitive-feed-role-note')).toBeDefined();
    expect(screen.getByTestId('sensitive-feed-loading')).toBeDefined();
  });

  it('renders the empty state when fetchPage returns no rows', async () => {
    const fetchPage = vi.fn(async () => ({ rows: [], total: 0, page: 0, page_size: 10 }));
    render(SensitiveFeedViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('sensitive-feed-empty')).toBeDefined();
    });
  });

  it('surfaces the load-error alert when fetchPage throws', async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error('boom');
    });
    render(SensitiveFeedViewer, { props: { fetchPage } });
    await waitFor(() => {
      const err = screen.getByTestId('sensitive-feed-load-error');
      expect(err.getAttribute('role')).toBe('alert');
    });
  });

  it('renders one row per result with a per-row sensitivity badge + data-sensitivity attr', async () => {
    const sample: DemoSensitiveRow[] = [
      {
        id: 'srow-001',
        ts: '2026-06-09T12:00:00.000Z',
        event_type: 'concern.created',
        actor_pseudonym: 'a1b2c3d4e5f6',
        meta: { hazard_class: 'physical' },
        sensitivity: 'c3'
      },
      {
        id: 'srow-002',
        ts: '2026-06-08T08:30:00.000Z',
        event_type: 'reprisal.created',
        actor_pseudonym: 'feedfacebeef',
        meta: { reprisal_id: 'rep-7' },
        sensitivity: 'c4'
      }
    ];
    const fetchPage = vi.fn(async () => ({ rows: sample, total: 2, page: 0, page_size: 10 }));
    render(SensitiveFeedViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getAllByTestId('sensitive-row').length).toBe(2);
    });
    const tiers = screen.getAllByTestId('sensitive-row').map((r) => r.getAttribute('data-sensitivity'));
    expect(tiers).toEqual(['c3', 'c4']);
    const badges = screen.getAllByTestId('sensitivity-badge').map((b) => b.textContent);
    expect(badges).toEqual(['C3', 'C4']);
  });
});

describe('T19.1 — SensitiveFeedViewer pagination', () => {
  it('Next button calls fetchPage with the next page index', async () => {
    const all = buildDemoSensitiveRows(30, 9);
    const fetchPage = vi.fn(async (page: number, page_size: number) =>
      fetchDemoSensitivePage(page, page_size, all)
    );
    render(SensitiveFeedViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('sensitive-feed-next')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('sensitive-feed-next'));
    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(fetchPage.mock.calls[1]![0]).toBe(1);
    });
  });

  it('Prev button is disabled on the first page', async () => {
    const all = buildDemoSensitiveRows(30, 9);
    const fetchPage = vi.fn(async (page: number, page_size: number) =>
      fetchDemoSensitivePage(page, page_size, all)
    );
    render(SensitiveFeedViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect((screen.getByTestId('sensitive-feed-prev') as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
