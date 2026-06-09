/**
 * T19.1 — InspectionsViewer + demo-inspections provider.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import InspectionsViewer from '../../src/lib/inspections/InspectionsViewer.svelte';
import {
  buildDemoInspections,
  fetchDemoInspectionsPage,
  type DemoInspectionRow
} from '../../src/lib/inspections/demo-inspections';

afterEach(() => {
  cleanup();
});

describe('T19.1 — buildDemoInspections / fetchDemoInspectionsPage', () => {
  it('builds exactly N rows', () => {
    expect(buildDemoInspections(20).length).toBe(20);
  });

  it('is deterministic for a given seed', () => {
    const a = buildDemoInspections(10, 4242);
    const b = buildDemoInspections(10, 4242);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(a.map((r) => r.area)).toEqual(b.map((r) => r.area));
    expect(a.map((r) => r.integrity_status)).toEqual(b.map((r) => r.integrity_status));
  });

  it('every row carries one of the two canonical integrity statuses', () => {
    const allowed = new Set(['verified', 'quarantined']);
    for (const row of buildDemoInspections(50)) {
      expect(allowed.has(row.integrity_status)).toBe(true);
    }
  });

  it('a 50-row dataset is dominated by verified rows (quarantined is the rare path)', () => {
    const rows = buildDemoInspections(50, 7);
    const verified = rows.filter((r) => r.integrity_status === 'verified').length;
    // Quarantined sampling rate is ~5%; in 50 rows we expect the majority verified.
    expect(verified).toBeGreaterThanOrEqual(40);
  });

  it('orders rows newest-first (descending conducted_at)', () => {
    const rows = buildDemoInspections(50);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.conducted_at >= rows[i]!.conducted_at).toBe(true);
    }
  });

  it('every row carries an area + pseudonymized actor', () => {
    for (const row of buildDemoInspections(50)) {
      expect(typeof row.area).toBe('string');
      expect(row.area.length).toBeGreaterThan(0);
      expect(typeof row.actor_pseudonym).toBe('string');
      expect(row.actor_pseudonym.length).toBeGreaterThan(0);
    }
  });

  it('checklist + photo counts are non-negative integers within demo bounds', () => {
    for (const row of buildDemoInspections(100)) {
      expect(Number.isInteger(row.checklist_item_count)).toBe(true);
      expect(row.checklist_item_count).toBeGreaterThanOrEqual(0);
      expect(row.checklist_item_count).toBeLessThanOrEqual(40);
      expect(Number.isInteger(row.photo_count)).toBe(true);
      expect(row.photo_count).toBeGreaterThanOrEqual(0);
      expect(row.photo_count).toBeLessThanOrEqual(20);
    }
  });

  it('fetchDemoInspectionsPage returns the right slice + total', async () => {
    const all = buildDemoInspections(35, 9);
    const p0 = await fetchDemoInspectionsPage(0, 10, all);
    expect(p0.rows.length).toBe(10);
    expect(p0.total).toBe(35);
    expect(p0.rows[0]?.id).toBe(all[0]?.id);
  });
});

describe('T19.1 — InspectionsViewer render states', () => {
  it('renders the offline note + loading state on mount', () => {
    const fetchPage = vi.fn(async () => new Promise<never>(() => {}));
    render(InspectionsViewer, { props: { fetchPage } });
    expect(screen.getByTestId('ins-offline-note')).toBeDefined();
    expect(screen.getByTestId('ins-loading')).toBeDefined();
  });

  it('renders the empty state when fetchPage returns no rows', async () => {
    const fetchPage = vi.fn(async () => ({ rows: [], total: 0, page: 0, page_size: 10 }));
    render(InspectionsViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('ins-empty')).toBeDefined();
    });
  });

  it('surfaces the load-error alert when fetchPage throws', async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error('boom');
    });
    render(InspectionsViewer, { props: { fetchPage } });
    await waitFor(() => {
      const err = screen.getByTestId('ins-load-error');
      expect(err.getAttribute('role')).toBe('alert');
    });
  });

  it('renders one row per inspection with integrity pin + area + counts', async () => {
    const sample: DemoInspectionRow[] = [
      {
        id: 'ins-001',
        area: 'Production floor — west bay',
        conducted_at: '2026-06-01T00:00:00.000Z',
        checklist_item_count: 18,
        photo_count: 4,
        integrity_status: 'verified',
        was_offline_queued: true,
        notes_preview: 'All guards present; one signage refresh queued.',
        actor_pseudonym: 'a1b2c3d4e5f6'
      },
      {
        id: 'ins-002',
        area: 'Cold storage area',
        conducted_at: '2026-05-01T00:00:00.000Z',
        checklist_item_count: 12,
        photo_count: 0,
        integrity_status: 'quarantined',
        was_offline_queued: false,
        notes_preview: 'Tag mismatch on drain; entry quarantined.',
        actor_pseudonym: 'feedfacebeef'
      }
    ];
    const fetchPage = vi.fn(async () => ({ rows: sample, total: 2, page: 0, page_size: 10 }));
    render(InspectionsViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getAllByTestId('ins-row').length).toBe(2);
    });
    const statuses = screen.getAllByTestId('ins-row').map((r) => r.getAttribute('data-status'));
    expect(statuses).toEqual(['verified', 'quarantined']);
    const areas = screen.getAllByTestId('ins-row-area').map((a) => a.textContent);
    expect(areas[0]).toMatch(/Production floor/);
    expect(areas[1]).toMatch(/Cold storage/);
    // Checklist + photos chips render on every row.
    expect(screen.getAllByTestId('ins-checklist-chip').length).toBe(2);
    expect(screen.getAllByTestId('ins-photos-chip').length).toBe(2);
  });

  it('Offline-queued chip renders only for rows that were queued offline', async () => {
    const sample: DemoInspectionRow[] = [
      {
        id: 'ins-001',
        area: 'A',
        conducted_at: '2026-06-01T00:00:00.000Z',
        checklist_item_count: 1,
        photo_count: 0,
        integrity_status: 'verified',
        was_offline_queued: true,
        notes_preview: 'x',
        actor_pseudonym: 'a1b2c3d4e5f6'
      },
      {
        id: 'ins-002',
        area: 'B',
        conducted_at: '2026-05-01T00:00:00.000Z',
        checklist_item_count: 1,
        photo_count: 0,
        integrity_status: 'verified',
        was_offline_queued: false,
        notes_preview: 'y',
        actor_pseudonym: 'a1b2c3d4e5f6'
      }
    ];
    const fetchPage = vi.fn(async () => ({ rows: sample, total: 2, page: 0, page_size: 10 }));
    render(InspectionsViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.queryAllByTestId('ins-offline-chip').length).toBe(1);
    });
  });
});

describe('T19.1 — InspectionsViewer pagination', () => {
  it('Next button calls fetchPage with the next page index', async () => {
    const all = buildDemoInspections(30, 9);
    const fetchPage = vi.fn(async (page: number, page_size: number) =>
      fetchDemoInspectionsPage(page, page_size, all)
    );
    render(InspectionsViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('ins-next')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('ins-next'));
    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(fetchPage.mock.calls[1]![0]).toBe(1);
    });
  });
});
