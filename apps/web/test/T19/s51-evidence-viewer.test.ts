/**
 * T19.1 — S51EvidenceViewer + demo-s51-evidence provider.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import S51EvidenceViewer from '../../src/lib/s51-evidence/S51EvidenceViewer.svelte';
import {
  buildDemoS51Evidence,
  fetchDemoS51EvidencePage,
  type DemoS51EvidenceRow
} from '../../src/lib/s51-evidence/demo-s51-evidence';

afterEach(() => {
  cleanup();
});

describe('T19.1 — buildDemoS51Evidence / fetchDemoS51EvidencePage', () => {
  it('builds exactly N rows', () => {
    expect(buildDemoS51Evidence(20).length).toBe(20);
  });

  it('is deterministic for a given seed', () => {
    const a = buildDemoS51Evidence(10, 1234);
    const b = buildDemoS51Evidence(10, 1234);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(a.map((r) => r.scene_state)).toEqual(b.map((r) => r.scene_state));
  });

  it('every row carries one of the three canonical scene states', () => {
    const allowed = new Set(['preserving', 'released_by_inspector', 'window_expired']);
    for (const row of buildDemoS51Evidence(50)) {
      expect(allowed.has(row.scene_state)).toBe(true);
    }
  });

  it('hours_remaining is set (1..47) exactly when preserving, null otherwise', () => {
    for (const row of buildDemoS51Evidence(100)) {
      if (row.scene_state === 'preserving') {
        expect(row.hours_remaining).not.toBeNull();
        expect(row.hours_remaining!).toBeGreaterThanOrEqual(1);
        expect(row.hours_remaining!).toBeLessThan(48);
      } else {
        expect(row.hours_remaining).toBeNull();
      }
    }
  });

  it('every row is passphrase-sealed (C4 default)', () => {
    for (const row of buildDemoS51Evidence(50)) {
      expect(row.per_entry_passphrase_required).toBe(true);
    }
  });

  it('worker_member_present is true for the overwhelming majority', () => {
    const rows = buildDemoS51Evidence(100, 7);
    const present = rows.filter((r) => r.worker_member_present).length;
    expect(present).toBeGreaterThanOrEqual(80);
  });

  it('orders rows newest-first (descending opened_at)', () => {
    const rows = buildDemoS51Evidence(50);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.opened_at >= rows[i]!.opened_at).toBe(true);
    }
  });

  it('fetchDemoS51EvidencePage returns the right slice + total', async () => {
    const all = buildDemoS51Evidence(35, 9);
    const p0 = await fetchDemoS51EvidencePage(0, 10, all);
    expect(p0.rows.length).toBe(10);
    expect(p0.total).toBe(35);
    expect(p0.rows[0]?.id).toBe(all[0]?.id);
  });
});

describe('T19.1 — S51EvidenceViewer render states', () => {
  it('renders the C4 badge + scene note + loading on mount', () => {
    const fetchPage = vi.fn(async () => new Promise<never>(() => {}));
    render(S51EvidenceViewer, { props: { fetchPage } });
    expect(screen.getByTestId('s51-c4-badge')).toBeDefined();
    expect(screen.getByTestId('s51-scene-note')).toBeDefined();
    expect(screen.getByTestId('s51-loading')).toBeDefined();
  });

  it('renders the empty state when fetchPage returns no rows', async () => {
    const fetchPage = vi.fn(async () => ({ rows: [], total: 0, page: 0, page_size: 10 }));
    render(S51EvidenceViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('s51-empty')).toBeDefined();
    });
  });

  it('surfaces the load-error alert when fetchPage throws', async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error('boom');
    });
    render(S51EvidenceViewer, { props: { fetchPage } });
    await waitFor(() => {
      const err = screen.getByTestId('s51-load-error');
      expect(err.getAttribute('role')).toBe('alert');
    });
  });

  it('renders scene pins per state, with the hour countdown on preserving rows', async () => {
    const sample: DemoS51EvidenceRow[] = [
      {
        id: 's51-001',
        opened_at: '2026-06-09T00:00:00.000Z',
        title: 'Crush injury at the palletizer cell',
        scene_state: 'preserving',
        hours_remaining: 31,
        photo_count: 6,
        witness_statement_count: 2,
        per_entry_passphrase_required: true,
        worker_member_present: true,
        actor_pseudonym: 'a1b2c3d4e5f6'
      },
      {
        id: 's51-002',
        opened_at: '2026-04-01T00:00:00.000Z',
        title: 'Fall from height at the mezzanine edge',
        scene_state: 'released_by_inspector',
        hours_remaining: null,
        photo_count: 11,
        witness_statement_count: 4,
        per_entry_passphrase_required: true,
        worker_member_present: false,
        actor_pseudonym: 'feedfacebeef'
      }
    ];
    const fetchPage = vi.fn(async () => ({ rows: sample, total: 2, page: 0, page_size: 10 }));
    render(S51EvidenceViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getAllByTestId('s51-row').length).toBe(2);
    });
    const states = screen
      .getAllByTestId('s51-row')
      .map((r) => r.getAttribute('data-scene-state'));
    expect(states).toEqual(['preserving', 'released_by_inspector']);
    // Preserving pin carries the hour countdown.
    const pins = screen.getAllByTestId('s51-scene-pin').map((p) => p.textContent ?? '');
    expect(pins[0]).toMatch(/31/);
    // Member chip reflects present/absent per row.
    const memberTexts = screen.getAllByTestId('s51-member-chip').map((c) => c.textContent ?? '');
    expect(memberTexts[0]).toMatch(/present/i);
    expect(memberTexts[1]).toMatch(/not present/i);
    // Both rows are passphrase-sealed.
    expect(screen.getAllByTestId('s51-passphrase-chip').length).toBe(2);
  });
});

describe('T19.1 — S51EvidenceViewer pagination', () => {
  it('Next button calls fetchPage with the next page index', async () => {
    const all = buildDemoS51Evidence(30, 9);
    const fetchPage = vi.fn(async (page: number, page_size: number) =>
      fetchDemoS51EvidencePage(page, page_size, all)
    );
    render(S51EvidenceViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('s51-next')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('s51-next'));
    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(fetchPage.mock.calls[1]![0]).toBe(1);
    });
  });
});
