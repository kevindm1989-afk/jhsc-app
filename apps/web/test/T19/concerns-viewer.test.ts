/**
 * T19.1 — ConcernsViewer + demo-concerns provider.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import ConcernsViewer from '../../src/lib/concerns/ConcernsViewer.svelte';
import {
  buildDemoConcerns,
  fetchDemoConcernsPage,
  type DemoConcernRow
} from '../../src/lib/concerns/demo-concerns';

afterEach(() => {
  cleanup();
});

describe('T19.1 — buildDemoConcerns / fetchDemoConcernsPage', () => {
  it('builds exactly N rows', () => {
    expect(buildDemoConcerns(20).length).toBe(20);
  });

  it('is deterministic for a given seed', () => {
    const a = buildDemoConcerns(10, 1234);
    const b = buildDemoConcerns(10, 1234);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(a.map((r) => r.status)).toEqual(b.map((r) => r.status));
    expect(a.map((r) => r.severity)).toEqual(b.map((r) => r.severity));
    expect(a.map((r) => r.hazard_class)).toEqual(b.map((r) => r.hazard_class));
  });

  it('every row carries one of the four canonical statuses', () => {
    const allowed = new Set(['open', 'triaged', 'resolved', 'archived']);
    for (const row of buildDemoConcerns(50)) {
      expect(allowed.has(row.status)).toBe(true);
    }
  });

  it('every row carries one of the four canonical severities', () => {
    const allowed = new Set(['low', 'medium', 'high', 'critical']);
    for (const row of buildDemoConcerns(50)) {
      expect(allowed.has(row.severity)).toBe(true);
    }
  });

  it('every row carries one of the five canonical hazard classes', () => {
    const allowed = new Set(['physical', 'chemical', 'biological', 'ergonomic', 'psychosocial']);
    for (const row of buildDemoConcerns(50)) {
      expect(allowed.has(row.hazard_class)).toBe(true);
    }
  });

  it('a 100-row dataset is dominated by source_protected (F-17 anonymous default)', () => {
    const rows = buildDemoConcerns(100, 7);
    const protectedCount = rows.filter((r) => r.source_protected).length;
    // Sampling rate is ~70%; in 100 rows expect a clear majority.
    expect(protectedCount).toBeGreaterThanOrEqual(55);
  });

  it('orders rows newest-first (descending filed_at)', () => {
    const rows = buildDemoConcerns(50);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.filed_at >= rows[i]!.filed_at).toBe(true);
    }
  });

  it('days_since_filed is non-negative and within the 90-day window', () => {
    for (const row of buildDemoConcerns(100)) {
      expect(row.days_since_filed).toBeGreaterThanOrEqual(0);
      expect(row.days_since_filed).toBeLessThanOrEqual(90);
    }
  });

  it('fetchDemoConcernsPage returns the right slice + total', async () => {
    const all = buildDemoConcerns(35, 9);
    const p0 = await fetchDemoConcernsPage(0, 10, all);
    expect(p0.rows.length).toBe(10);
    expect(p0.total).toBe(35);
    expect(p0.rows[0]?.id).toBe(all[0]?.id);
  });
});

describe('T19.1 — ConcernsViewer render states', () => {
  it('renders the anonymous-default note + loading on mount', () => {
    const fetchPage = vi.fn(async () => new Promise<never>(() => {}));
    render(ConcernsViewer, { props: { fetchPage } });
    expect(screen.getByTestId('con-anon-note')).toBeDefined();
    expect(screen.getByTestId('con-loading')).toBeDefined();
  });

  it('renders the empty state when fetchPage returns no rows', async () => {
    const fetchPage = vi.fn(async () => ({ rows: [], total: 0, page: 0, page_size: 10 }));
    render(ConcernsViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('con-empty')).toBeDefined();
    });
  });

  it('surfaces the load-error alert when fetchPage throws', async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error('boom');
    });
    render(ConcernsViewer, { props: { fetchPage } });
    await waitFor(() => {
      const err = screen.getByTestId('con-load-error');
      expect(err.getAttribute('role')).toBe('alert');
    });
  });

  it('renders one row per concern with status pin + severity + hazard + source chips', async () => {
    const sample: DemoConcernRow[] = [
      {
        id: 'con-001',
        filed_at: '2026-06-01T00:00:00.000Z',
        title: 'Slip hazard near the loading-dock ramp after rain',
        status: 'open',
        severity: 'critical',
        hazard_class: 'physical',
        source_protected: true,
        days_since_filed: 3,
        actor_pseudonym: 'a1b2c3d4e5f6'
      },
      {
        id: 'con-002',
        filed_at: '2026-05-01T00:00:00.000Z',
        title: 'WHMIS labelling missing on the dye-transfer caddy',
        status: 'resolved',
        severity: 'medium',
        hazard_class: 'chemical',
        source_protected: false,
        days_since_filed: 34,
        actor_pseudonym: 'feedfacebeef'
      }
    ];
    const fetchPage = vi.fn(async () => ({ rows: sample, total: 2, page: 0, page_size: 10 }));
    render(ConcernsViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getAllByTestId('con-row').length).toBe(2);
    });
    const statuses = screen.getAllByTestId('con-row').map((r) => r.getAttribute('data-status'));
    expect(statuses).toEqual(['open', 'resolved']);
    // Every row has its primary pins + hazard + source + days chips.
    expect(screen.getAllByTestId('con-status-pin').length).toBe(2);
    expect(screen.getAllByTestId('con-severity-chip').length).toBe(2);
    expect(screen.getAllByTestId('con-hazard-chip').length).toBe(2);
    expect(screen.getAllByTestId('con-source-chip').length).toBe(2);
    // Source chip text reflects per-row protected/revealed state.
    const sourceTexts = screen.getAllByTestId('con-source-chip').map((c) => c.textContent ?? '');
    expect(sourceTexts[0]).toMatch(/protected/i);
    expect(sourceTexts[1]).toMatch(/revealed/i);
  });
});

describe('T19.1 — ConcernsViewer pagination', () => {
  it('Next button calls fetchPage with the next page index', async () => {
    const all = buildDemoConcerns(30, 9);
    const fetchPage = vi.fn(async (page: number, page_size: number) =>
      fetchDemoConcernsPage(page, page_size, all)
    );
    render(ConcernsViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('con-next')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('con-next'));
    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(fetchPage.mock.calls[1]![0]).toBe(1);
    });
  });
});
