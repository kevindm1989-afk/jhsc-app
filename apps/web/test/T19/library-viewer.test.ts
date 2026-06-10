/**
 * T19.1 — LibraryViewer + demo-library provider.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import LibraryViewer from '../../src/lib/library/LibraryViewer.svelte';
import {
  buildDemoLibrary,
  fetchDemoLibraryPage,
  type DemoLibraryRow
} from '../../src/lib/library/demo-library';

afterEach(() => {
  cleanup();
});

describe('T19.1 — buildDemoLibrary / fetchDemoLibraryPage', () => {
  it('builds exactly N rows', () => {
    expect(buildDemoLibrary(20).length).toBe(20);
  });

  it('is deterministic for a given seed', () => {
    const a = buildDemoLibrary(10, 1234);
    const b = buildDemoLibrary(10, 1234);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(a.map((r) => r.category)).toEqual(b.map((r) => r.category));
    expect(a.map((r) => r.title)).toEqual(b.map((r) => r.title));
  });

  it('every row carries one of the five canonical categories', () => {
    const allowed = new Set(['policy', 'procedure', 'training', 'legislation', 'template']);
    for (const row of buildDemoLibrary(50)) {
      expect(allowed.has(row.category)).toBe(true);
    }
  });

  it('every row carries one of the three canonical languages', () => {
    const allowed = new Set(['en', 'fr', 'both']);
    for (const row of buildDemoLibrary(50)) {
      expect(allowed.has(row.language)).toBe(true);
    }
  });

  it('versions look like v1..v6', () => {
    for (const row of buildDemoLibrary(100)) {
      expect(row.version).toMatch(/^v[1-6]$/);
    }
  });

  it('orders rows newest-first (descending updated_at)', () => {
    const rows = buildDemoLibrary(50);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.updated_at >= rows[i]!.updated_at).toBe(true);
    }
  });

  it('fetchDemoLibraryPage returns the right slice + total', async () => {
    const all = buildDemoLibrary(35, 9);
    const p0 = await fetchDemoLibraryPage(0, 10, all);
    expect(p0.rows.length).toBe(10);
    expect(p0.total).toBe(35);
    expect(p0.rows[0]?.id).toBe(all[0]?.id);
  });
});

describe('T19.1 — LibraryViewer render states', () => {
  it('renders the offline note + loading on mount', () => {
    const fetchPage = vi.fn(async () => new Promise<never>(() => {}));
    render(LibraryViewer, { props: { fetchPage } });
    expect(screen.getByTestId('lib-offline-note')).toBeDefined();
    expect(screen.getByTestId('lib-loading')).toBeDefined();
  });

  it('renders the empty state when fetchPage returns no rows', async () => {
    const fetchPage = vi.fn(async () => ({ rows: [], total: 0, page: 0, page_size: 10 }));
    render(LibraryViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('lib-empty')).toBeDefined();
    });
  });

  it('surfaces the load-error alert when fetchPage throws', async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error('boom');
    });
    render(LibraryViewer, { props: { fetchPage } });
    await waitFor(() => {
      const err = screen.getByTestId('lib-load-error');
      expect(err.getAttribute('role')).toBe('alert');
    });
  });

  it('renders one row per document with category pin + version + language chips', async () => {
    const sample: DemoLibraryRow[] = [
      {
        id: 'doc-001',
        title: 'Lockout-tagout procedure',
        category: 'procedure',
        version: 'v3',
        updated_at: '2026-06-01T00:00:00.000Z',
        language: 'both',
        offline_cached: true
      },
      {
        id: 'doc-002',
        title: 'OHSA — Occupational Health and Safety Act (current consolidation)',
        category: 'legislation',
        version: 'v1',
        updated_at: '2026-05-01T00:00:00.000Z',
        language: 'en',
        offline_cached: false
      }
    ];
    const fetchPage = vi.fn(async () => ({ rows: sample, total: 2, page: 0, page_size: 10 }));
    render(LibraryViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getAllByTestId('lib-row').length).toBe(2);
    });
    const categories = screen.getAllByTestId('lib-row').map((r) => r.getAttribute('data-category'));
    expect(categories).toEqual(['procedure', 'legislation']);
    const versions = screen.getAllByTestId('lib-version-chip').map((v) => v.textContent?.trim());
    expect(versions).toEqual(['v3', 'v1']);
    // Offline chip only on the cached row.
    expect(screen.queryAllByTestId('lib-offline-chip').length).toBe(1);
  });
});

describe('T19.1 — LibraryViewer pagination', () => {
  it('Next button calls fetchPage with the next page index', async () => {
    const all = buildDemoLibrary(30, 9);
    const fetchPage = vi.fn(async (page: number, page_size: number) =>
      fetchDemoLibraryPage(page, page_size, all)
    );
    render(LibraryViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('lib-next')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('lib-next'));
    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(fetchPage.mock.calls[1]![0]).toBe(1);
    });
  });
});
