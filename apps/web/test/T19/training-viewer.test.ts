/**
 * T19.1 — TrainingViewer + demo-training provider.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import TrainingViewer from '../../src/lib/training/TrainingViewer.svelte';
import {
  buildDemoTraining,
  fetchDemoTrainingPage,
  type DemoTrainingRow
} from '../../src/lib/training/demo-training';

afterEach(() => {
  cleanup();
});

describe('T19.1 — buildDemoTraining / fetchDemoTrainingPage', () => {
  it('builds exactly N rows', () => {
    expect(buildDemoTraining(20).length).toBe(20);
  });

  it('is deterministic for a given seed', () => {
    const a = buildDemoTraining(10, 1234);
    const b = buildDemoTraining(10, 1234);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(a.map((r) => r.validity)).toEqual(b.map((r) => r.validity));
    expect(a.map((r) => r.certification)).toEqual(b.map((r) => r.certification));
  });

  it('every row carries one of the three canonical validity states', () => {
    const allowed = new Set(['valid', 'expiring', 'expired']);
    for (const row of buildDemoTraining(50)) {
      expect(allowed.has(row.validity)).toBe(true);
    }
  });

  it('days_to_expiry respects the per-state bounds', () => {
    for (const row of buildDemoTraining(200)) {
      expect(row.days_to_expiry).toBeGreaterThanOrEqual(1);
      if (row.validity === 'valid') {
        expect(row.days_to_expiry).toBeGreaterThan(60);
      } else if (row.validity === 'expiring') {
        expect(row.days_to_expiry).toBeLessThanOrEqual(60);
      } else {
        // expired — days SINCE expiry, capped at 180 in the demo.
        expect(row.days_to_expiry).toBeLessThanOrEqual(180);
      }
    }
  });

  it('a 50-row dataset includes multiple validity states (mix is realistic)', () => {
    const rows = buildDemoTraining(50);
    const states = new Set(rows.map((r) => r.validity));
    expect(states.size).toBeGreaterThan(1);
  });

  it('orders rows newest-first (descending completed_at)', () => {
    const rows = buildDemoTraining(50);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.completed_at >= rows[i]!.completed_at).toBe(true);
    }
  });

  it('fetchDemoTrainingPage returns the right slice + total', async () => {
    const all = buildDemoTraining(35, 9);
    const p0 = await fetchDemoTrainingPage(0, 10, all);
    expect(p0.rows.length).toBe(10);
    expect(p0.total).toBe(35);
    expect(p0.rows[0]?.id).toBe(all[0]?.id);
  });
});

describe('T19.1 — TrainingViewer render states', () => {
  it('renders the refresher note + loading on mount', () => {
    const fetchPage = vi.fn(async () => new Promise<never>(() => {}));
    render(TrainingViewer, { props: { fetchPage } });
    expect(screen.getByTestId('trn-refresher-note')).toBeDefined();
    expect(screen.getByTestId('trn-loading')).toBeDefined();
  });

  it('renders the empty state when fetchPage returns no rows', async () => {
    const fetchPage = vi.fn(async () => ({ rows: [], total: 0, page: 0, page_size: 10 }));
    render(TrainingViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('trn-empty')).toBeDefined();
    });
  });

  it('surfaces the load-error alert when fetchPage throws', async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error('boom');
    });
    render(TrainingViewer, { props: { fetchPage } });
    await waitFor(() => {
      const err = screen.getByTestId('trn-load-error');
      expect(err.getAttribute('role')).toBe('alert');
    });
  });

  it('renders validity pins + expiry text per state, evidence chip only where attached', async () => {
    const sample: DemoTrainingRow[] = [
      {
        id: 'trn-001',
        certification: 'Certification Part One (basic)',
        member_pseudonym: 'a1b2c3d4e5f6',
        completed_at: '2026-05-01T00:00:00.000Z',
        validity: 'valid',
        days_to_expiry: 300,
        evidence_attached: true
      },
      {
        id: 'trn-002',
        certification: 'WHMIS 2015',
        member_pseudonym: 'feedfacebeef',
        completed_at: '2025-07-01T00:00:00.000Z',
        validity: 'expiring',
        days_to_expiry: 21,
        evidence_attached: false
      },
      {
        id: 'trn-003',
        certification: 'Working at Heights',
        member_pseudonym: '7890abcdef12',
        completed_at: '2023-06-01T00:00:00.000Z',
        validity: 'expired',
        days_to_expiry: 45,
        evidence_attached: true
      }
    ];
    const fetchPage = vi.fn(async () => ({ rows: sample, total: 3, page: 0, page_size: 10 }));
    render(TrainingViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getAllByTestId('trn-row').length).toBe(3);
    });
    const validities = screen.getAllByTestId('trn-row').map((r) => r.getAttribute('data-validity'));
    expect(validities).toEqual(['valid', 'expiring', 'expired']);
    // Expiry chips: "left" for valid + expiring, "overdue" for expired.
    const expiries = screen.getAllByTestId('trn-expiry-chip').map((c) => c.textContent ?? '');
    expect(expiries[0]).toMatch(/300/);
    expect(expiries[0]).toMatch(/left/i);
    expect(expiries[2]).toMatch(/45/);
    expect(expiries[2]).toMatch(/overdue/i);
    // Evidence chip on 2 of 3 rows.
    expect(screen.queryAllByTestId('trn-evidence-chip').length).toBe(2);
  });
});

describe('T19.1 — TrainingViewer pagination', () => {
  it('Next button calls fetchPage with the next page index', async () => {
    const all = buildDemoTraining(30, 9);
    const fetchPage = vi.fn(async (page: number, page_size: number) =>
      fetchDemoTrainingPage(page, page_size, all)
    );
    render(TrainingViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('trn-next')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('trn-next'));
    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(fetchPage.mock.calls[1]![0]).toBe(1);
    });
  });
});
