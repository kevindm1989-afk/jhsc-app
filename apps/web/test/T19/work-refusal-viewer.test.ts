/**
 * T19.1 — WorkRefusalViewer + demo-work-refusal provider.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import WorkRefusalViewer from '../../src/lib/work-refusal/WorkRefusalViewer.svelte';
import {
  buildDemoWorkRefusals,
  fetchDemoWorkRefusalPage,
  type DemoWorkRefusalRow
} from '../../src/lib/work-refusal/demo-work-refusal';

afterEach(() => {
  cleanup();
});

describe('T19.1 — buildDemoWorkRefusals / fetchDemoWorkRefusalPage', () => {
  it('builds exactly N rows', () => {
    expect(buildDemoWorkRefusals(20).length).toBe(20);
  });

  it('is deterministic for a given seed', () => {
    const a = buildDemoWorkRefusals(10, 1234);
    const b = buildDemoWorkRefusals(10, 1234);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(a.map((r) => r.stage)).toEqual(b.map((r) => r.stage));
    expect(a.map((r) => r.title)).toEqual(b.map((r) => r.title));
  });

  it('every row carries one of the four canonical stages', () => {
    const allowed = new Set(['worker_refusal', 's43_4_investigation', 's43_8_mol', 'resolved']);
    for (const row of buildDemoWorkRefusals(50)) {
      expect(allowed.has(row.stage)).toBe(true);
    }
  });

  it('resolved_at_stage is non-null exactly when stage is resolved', () => {
    for (const row of buildDemoWorkRefusals(100)) {
      if (row.stage === 'resolved') {
        expect(row.resolved_at_stage).not.toBeNull();
        expect(['worker_refusal', 's43_4_investigation', 's43_8_mol']).toContain(
          row.resolved_at_stage
        );
      } else {
        expect(row.resolved_at_stage).toBeNull();
      }
    }
  });

  it('alternative_work_assigned is never true on resolved rows', () => {
    for (const row of buildDemoWorkRefusals(100)) {
      if (row.stage === 'resolved') {
        expect(row.alternative_work_assigned).toBe(false);
      }
    }
  });

  it('orders rows newest-first (descending filed_at)', () => {
    const rows = buildDemoWorkRefusals(50);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.filed_at >= rows[i]!.filed_at).toBe(true);
    }
  });

  it('fetchDemoWorkRefusalPage returns the right slice + total', async () => {
    const all = buildDemoWorkRefusals(35, 9);
    const p0 = await fetchDemoWorkRefusalPage(0, 10, all);
    expect(p0.rows.length).toBe(10);
    expect(p0.total).toBe(35);
    expect(p0.rows[0]?.id).toBe(all[0]?.id);
  });
});

describe('T19.1 — WorkRefusalViewer render states', () => {
  it('renders the C4 badge + stages note + loading on mount', () => {
    const fetchPage = vi.fn(async () => new Promise<never>(() => {}));
    render(WorkRefusalViewer, { props: { fetchPage } });
    expect(screen.getByTestId('wr-c4-badge')).toBeDefined();
    expect(screen.getByTestId('wr-stages-note')).toBeDefined();
    expect(screen.getByTestId('wr-loading')).toBeDefined();
  });

  it('renders the empty state when fetchPage returns no rows', async () => {
    const fetchPage = vi.fn(async () => ({ rows: [], total: 0, page: 0, page_size: 10 }));
    render(WorkRefusalViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('wr-empty')).toBeDefined();
    });
  });

  it('surfaces the load-error alert when fetchPage throws', async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error('boom');
    });
    render(WorkRefusalViewer, { props: { fetchPage } });
    await waitFor(() => {
      const err = screen.getByTestId('wr-load-error');
      expect(err.getAttribute('role')).toBe('alert');
    });
  });

  it('renders the stage gauge with the right fill depth per row', async () => {
    const sample: DemoWorkRefusalRow[] = [
      {
        id: 'wr-001',
        filed_at: '2026-06-01T00:00:00.000Z',
        title: 'Refused roof work without fall-arrest anchor points',
        stage: 'worker_refusal',
        resolved_at_stage: null,
        alternative_work_assigned: true,
        days_since_filed: 2,
        actor_pseudonym: 'a1b2c3d4e5f6'
      },
      {
        id: 'wr-002',
        filed_at: '2026-05-15T00:00:00.000Z',
        title: 'Refused confined-space entry without atmosphere test',
        stage: 's43_8_mol',
        resolved_at_stage: null,
        alternative_work_assigned: false,
        days_since_filed: 19,
        actor_pseudonym: 'feedfacebeef'
      },
      {
        id: 'wr-003',
        filed_at: '2026-05-01T00:00:00.000Z',
        title: 'Refused forklift with failing brakes on the dock ramp',
        stage: 'resolved',
        resolved_at_stage: 's43_4_investigation',
        alternative_work_assigned: false,
        days_since_filed: 33,
        actor_pseudonym: '7890abcdef12'
      }
    ];
    const fetchPage = vi.fn(async () => ({ rows: sample, total: 3, page: 0, page_size: 10 }));
    render(WorkRefusalViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getAllByTestId('wr-row').length).toBe(3);
    });
    const depths = screen.getAllByTestId('wr-gauge').map((g) => g.getAttribute('data-depth'));
    // worker_refusal → 1; s43_8_mol → 3; resolved-at-investigation → 2.
    expect(depths).toEqual(['1', '3', '2']);
    // Alternative-work chip only on the row that has it assigned.
    expect(screen.queryAllByTestId('wr-altwork-chip').length).toBe(1);
    // Resolved-at chip only on the resolved row.
    expect(screen.queryAllByTestId('wr-resolved-at-chip').length).toBe(1);
  });
});

describe('T19.1 — WorkRefusalViewer pagination', () => {
  it('Next button calls fetchPage with the next page index', async () => {
    const all = buildDemoWorkRefusals(30, 9);
    const fetchPage = vi.fn(async (page: number, page_size: number) =>
      fetchDemoWorkRefusalPage(page, page_size, all)
    );
    render(WorkRefusalViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('wr-next')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('wr-next'));
    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(fetchPage.mock.calls[1]![0]).toBe(1);
    });
  });
});
