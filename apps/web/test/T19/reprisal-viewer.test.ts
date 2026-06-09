/**
 * T19.1 — ReprisalViewer + demo-reprisal provider.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import ReprisalViewer from '../../src/lib/reprisal/ReprisalViewer.svelte';
import {
  buildDemoReprisals,
  fetchDemoReprisalPage,
  type DemoReprisalRow
} from '../../src/lib/reprisal/demo-reprisal';

afterEach(() => {
  cleanup();
});

describe('T19.1 — buildDemoReprisals / fetchDemoReprisalPage', () => {
  it('builds exactly N rows', () => {
    expect(buildDemoReprisals(20).length).toBe(20);
  });

  it('is deterministic for a given seed', () => {
    const a = buildDemoReprisals(10, 1234);
    const b = buildDemoReprisals(10, 1234);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(a.map((r) => r.status)).toEqual(b.map((r) => r.status));
    expect(a.map((r) => r.title)).toEqual(b.map((r) => r.title));
  });

  it('every row carries one of the four canonical statuses', () => {
    const allowed = new Set(['filed', 'investigating', 'resolved', 'archived']);
    for (const row of buildDemoReprisals(50)) {
      expect(allowed.has(row.status)).toBe(true);
    }
  });

  it('a 100-row dataset is dominated by passphrase-sealed rows (C4 default)', () => {
    const rows = buildDemoReprisals(100, 7);
    const sealed = rows.filter((r) => r.per_entry_passphrase_required).length;
    // Sampling rate is ~95%; in 100 rows expect a very clear majority.
    expect(sealed).toBeGreaterThanOrEqual(85);
  });

  it('source-revealed is the rare exception, not the rule', () => {
    const rows = buildDemoReprisals(100, 7);
    const revealed = rows.filter((r) => r.source_revealed).length;
    // ~5% sampling — bound generously to allow seed variance.
    expect(revealed).toBeLessThanOrEqual(20);
  });

  it('orders rows newest-first (descending filed_at)', () => {
    const rows = buildDemoReprisals(50);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.filed_at >= rows[i]!.filed_at).toBe(true);
    }
  });

  it('days_since_filed is non-negative and within the 120-day window', () => {
    for (const row of buildDemoReprisals(100)) {
      expect(row.days_since_filed).toBeGreaterThanOrEqual(0);
      expect(row.days_since_filed).toBeLessThanOrEqual(120);
    }
  });

  it('fetchDemoReprisalPage returns the right slice + total', async () => {
    const all = buildDemoReprisals(35, 9);
    const p0 = await fetchDemoReprisalPage(0, 10, all);
    expect(p0.rows.length).toBe(10);
    expect(p0.total).toBe(35);
    expect(p0.rows[0]?.id).toBe(all[0]?.id);
  });
});

describe('T19.1 — ReprisalViewer render states', () => {
  it('renders the C4 badge + c4 note + loading on mount', () => {
    const fetchPage = vi.fn(async () => new Promise<never>(() => {}));
    render(ReprisalViewer, { props: { fetchPage } });
    expect(screen.getByTestId('rep-c4-badge')).toBeDefined();
    expect(screen.getByTestId('rep-c4-note')).toBeDefined();
    expect(screen.getByTestId('rep-loading')).toBeDefined();
  });

  it('renders the empty state when fetchPage returns no rows', async () => {
    const fetchPage = vi.fn(async () => ({ rows: [], total: 0, page: 0, page_size: 10 }));
    render(ReprisalViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('rep-empty')).toBeDefined();
    });
  });

  it('surfaces the load-error alert when fetchPage throws', async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error('boom');
    });
    render(ReprisalViewer, { props: { fetchPage } });
    await waitFor(() => {
      const err = screen.getByTestId('rep-load-error');
      expect(err.getAttribute('role')).toBe('alert');
    });
  });

  it('renders one row per reprisal with status pin + title + source chip', async () => {
    const sample: DemoReprisalRow[] = [
      {
        id: 'rep-001',
        filed_at: '2026-06-01T00:00:00.000Z',
        title: 'Schedule changed after raising a concern about lifting limits',
        status: 'investigating',
        per_entry_passphrase_required: true,
        source_revealed: false,
        days_since_filed: 8,
        actor_pseudonym: 'a1b2c3d4e5f6'
      },
      {
        id: 'rep-002',
        filed_at: '2026-05-01T00:00:00.000Z',
        title: 'Hours reduced after declining to operate the unguarded press',
        status: 'resolved',
        per_entry_passphrase_required: false,
        source_revealed: true,
        days_since_filed: 39,
        actor_pseudonym: 'feedfacebeef'
      }
    ];
    const fetchPage = vi.fn(async () => ({ rows: sample, total: 2, page: 0, page_size: 10 }));
    render(ReprisalViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getAllByTestId('rep-row').length).toBe(2);
    });
    const statuses = screen.getAllByTestId('rep-row').map((r) => r.getAttribute('data-status'));
    expect(statuses).toEqual(['investigating', 'resolved']);
    expect(screen.getAllByTestId('rep-status-pin').length).toBe(2);
    // Source chip reflects per-row protected/revealed state.
    const sourceTexts = screen.getAllByTestId('rep-source-chip').map((c) => c.textContent ?? '');
    expect(sourceTexts[0]).toMatch(/protected/i);
    expect(sourceTexts[1]).toMatch(/revealed/i);
  });

  it('Passphrase-sealed chip renders only on rows where required', async () => {
    const sample: DemoReprisalRow[] = [
      {
        id: 'rep-001',
        filed_at: '2026-06-01T00:00:00.000Z',
        title: 'a',
        status: 'filed',
        per_entry_passphrase_required: true,
        source_revealed: false,
        days_since_filed: 1,
        actor_pseudonym: 'a1b2c3d4e5f6'
      },
      {
        id: 'rep-002',
        filed_at: '2026-05-01T00:00:00.000Z',
        title: 'b',
        status: 'filed',
        per_entry_passphrase_required: false,
        source_revealed: false,
        days_since_filed: 31,
        actor_pseudonym: 'a1b2c3d4e5f6'
      }
    ];
    const fetchPage = vi.fn(async () => ({ rows: sample, total: 2, page: 0, page_size: 10 }));
    render(ReprisalViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.queryAllByTestId('rep-passphrase-chip').length).toBe(1);
    });
  });
});

describe('T19.1 — ReprisalViewer pagination', () => {
  it('Next button calls fetchPage with the next page index', async () => {
    const all = buildDemoReprisals(30, 9);
    const fetchPage = vi.fn(async (page: number, page_size: number) =>
      fetchDemoReprisalPage(page, page_size, all)
    );
    render(ReprisalViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('rep-next')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('rep-next'));
    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(fetchPage.mock.calls[1]![0]).toBe(1);
    });
  });
});
