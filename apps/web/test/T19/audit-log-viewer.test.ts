/**
 * T19.1 — AuditLogViewer + demo-audit-rows provider.
 *
 * Pins:
 *   - The demo-rows generator returns deterministic content for a
 *     given seed (so the demo viewer is stable across renders).
 *   - The page slicer (fetchDemoAuditPage) returns the right shape +
 *     correct row windows.
 *   - The viewer component renders the loading, empty, error, and
 *     row-list states with the right testids.
 *   - The viewer's pagination buttons load the next/prev page via
 *     the injected provider.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import AuditLogViewer from '../../src/lib/audit/AuditLogViewer.svelte';
import {
  buildDemoAuditRows,
  fetchDemoAuditPage,
  type DemoAuditRow
} from '../../src/lib/audit/demo-audit-rows';

afterEach(() => {
  cleanup();
});

describe('T19.1 — buildDemoAuditRows / fetchDemoAuditPage', () => {
  it('builds exactly N rows', () => {
    const rows = buildDemoAuditRows(20);
    expect(rows.length).toBe(20);
  });

  it('is deterministic for a given seed (same seed → same rows)', () => {
    const a = buildDemoAuditRows(10, 1234);
    const b = buildDemoAuditRows(10, 1234);
    expect(a.map((r) => r.event_type)).toEqual(b.map((r) => r.event_type));
    expect(a.map((r) => r.actor_pseudonym)).toEqual(b.map((r) => r.actor_pseudonym));
  });

  it('different seeds produce different row sequences', () => {
    const a = buildDemoAuditRows(20, 1);
    const b = buildDemoAuditRows(20, 2);
    // At least one position differs across the sequences.
    const same = a.every((row, i) => row.event_type === b[i]!.event_type && row.actor_pseudonym === b[i]!.actor_pseudonym);
    expect(same).toBe(false);
  });

  it('orders rows newest-first (descending ts)', () => {
    const rows = buildDemoAuditRows(50);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.ts >= rows[i]!.ts).toBe(true);
    }
  });

  it('every row carries event_type in the canonical dot-separated form', () => {
    const rows = buildDemoAuditRows(50);
    for (const row of rows) {
      expect(row.event_type).toMatch(/^[a-z0-9_]+\.[a-z0-9_]+$/);
    }
  });

  it('every row carries a 12-char actor_pseudonym (truncated HMAC shape)', () => {
    const rows = buildDemoAuditRows(50);
    for (const row of rows) {
      expect(row.actor_pseudonym).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it('fetchDemoAuditPage returns the correct slice + total', async () => {
    const all = buildDemoAuditRows(35);
    const p0 = await fetchDemoAuditPage(0, 10, all);
    expect(p0.rows.length).toBe(10);
    expect(p0.total).toBe(35);
    expect(p0.page).toBe(0);
    expect(p0.page_size).toBe(10);
    expect(p0.rows[0]?.id).toBe(all[0]?.id);

    const p1 = await fetchDemoAuditPage(1, 10, all);
    expect(p1.rows.length).toBe(10);
    expect(p1.rows[0]?.id).toBe(all[10]?.id);

    const p3 = await fetchDemoAuditPage(3, 10, all);
    // Last page has the leftovers (35 - 30 = 5).
    expect(p3.rows.length).toBe(5);
  });
});

describe('T19.1 — AuditLogViewer render states', () => {
  it('renders the loading state on mount', () => {
    const fetchPage = vi.fn(async () => new Promise<never>(() => {}));
    render(AuditLogViewer, { props: { fetchPage } });
    expect(screen.getByTestId('audit-viewer-loading')).toBeDefined();
  });

  it('renders the empty state when fetchPage returns no rows', async () => {
    const fetchPage = vi.fn(async () => ({ rows: [], total: 0, page: 0, page_size: 10 }));
    render(AuditLogViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('audit-viewer-empty')).toBeDefined();
    });
  });

  it('surfaces the load-error alert when fetchPage throws', async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error('boom');
    });
    render(AuditLogViewer, { props: { fetchPage } });
    await waitFor(() => {
      const err = screen.getByTestId('audit-viewer-load-error');
      expect(err.getAttribute('role')).toBe('alert');
    });
  });

  it('renders one row per audit row with timestamp + event_type + actor', async () => {
    const sample: DemoAuditRow[] = [
      {
        id: 'row-001',
        ts: '2026-06-09T12:00:00.000Z',
        event_type: 'concern.created',
        actor_pseudonym: 'a1b2c3d4e5f6',
        meta: { hazard_class: 'physical', severity: 'medium' }
      },
      {
        id: 'row-002',
        ts: '2026-06-08T08:30:00.000Z',
        event_type: 'session.revoked',
        actor_pseudonym: 'feedfacebeef',
        meta: { session_id: 'sess-42' }
      }
    ];
    const fetchPage = vi.fn(async () => ({ rows: sample, total: 2, page: 0, page_size: 10 }));
    render(AuditLogViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-row').length).toBe(2);
    });
    const events = screen.getAllByTestId('audit-row-event').map((e) => e.textContent);
    expect(events).toEqual(['concern.created', 'session.revoked']);
    const actors = screen.getAllByTestId('audit-row-actor').map((e) => e.textContent);
    expect(actors).toEqual(['a1b2c3d4e5f6', 'feedfacebeef']);
  });
});

describe('T19.1 — AuditLogViewer pagination', () => {
  it('Next button calls fetchPage with the next page index', async () => {
    const rows = buildDemoAuditRows(30, 9);
    const fetchPage = vi.fn(async (page: number, page_size: number) =>
      fetchDemoAuditPage(page, page_size, rows)
    );
    render(AuditLogViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('audit-viewer-next')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('audit-viewer-next'));
    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(fetchPage.mock.calls[1]![0]).toBe(1);
    });
  });

  it('Prev button is disabled on the first page', async () => {
    const rows = buildDemoAuditRows(30, 9);
    const fetchPage = vi.fn(async (page: number, page_size: number) =>
      fetchDemoAuditPage(page, page_size, rows)
    );
    render(AuditLogViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect((screen.getByTestId('audit-viewer-prev') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('Next button is disabled on the last page', async () => {
    const rows = buildDemoAuditRows(5, 9); // single page worth
    const fetchPage = vi.fn(async (page: number, page_size: number) =>
      fetchDemoAuditPage(page, page_size, rows)
    );
    render(AuditLogViewer, { props: { fetchPage, pageSize: 10 } });
    await waitFor(() => {
      expect((screen.getByTestId('audit-viewer-next') as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
