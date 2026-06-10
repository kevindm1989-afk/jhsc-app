/**
 * T19.1 — Polish bundle pins.
 *
 *   - SkeletonRows renders N placeholder rows + carries
 *     aria-hidden="true" (the surrounding wrapper carries the
 *     loading-status semantics).
 *   - Every register viewer imports SkeletonRows and uses it in
 *     the loading branch.
 *   - Every register viewer's page indicator now includes the
 *     `pagination-total` element so workers read both "Page 1 of N"
 *     and the total entry count.
 *   - common.pagination.total_entries is present in the catalog.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import SkeletonRows from '../../src/lib/ui/SkeletonRows.svelte';
import ConcernsViewer from '../../src/lib/concerns/ConcernsViewer.svelte';
import { buildDemoConcerns } from '../../src/lib/concerns/demo-concerns';

afterEach(() => {
  cleanup();
});

const VIEWERS = [
  ['concerns', 'ConcernsViewer'],
  ['recommendations', 'RecommendationsViewer'],
  ['training', 'TrainingViewer'],
  ['work-refusal', 'WorkRefusalViewer'],
  ['s51-evidence', 'S51EvidenceViewer'],
  ['reprisal', 'ReprisalViewer'],
  ['minutes', 'MinutesViewer'],
  ['inspections', 'InspectionsViewer'],
  ['library', 'LibraryViewer']
] as const;

const AUDIT_VIEWERS = [
  ['audit', 'AuditLogViewer'],
  ['audit', 'SensitiveFeedViewer']
] as const;

function viewerSrc(dir: string, name: string): string {
  return readFileSync(
    resolve(__dirname, '../../src/lib', dir, `${name}.svelte`),
    'utf8'
  );
}

describe('T19.1 — SkeletonRows', () => {
  it('renders three rows by default', () => {
    render(SkeletonRows, { props: {} });
    expect(screen.getAllByTestId('skeleton-row').length).toBe(3);
  });

  it('honours an explicit count prop', () => {
    render(SkeletonRows, { props: { count: 6 } });
    expect(screen.getAllByTestId('skeleton-row').length).toBe(6);
  });

  it('wrapper carries aria-hidden="true" (surrounding container owns the announcement)', () => {
    render(SkeletonRows, { props: {} });
    const wrap = screen.getByTestId('skeleton-rows');
    expect(wrap.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('T19.1 — each register viewer imports and mounts SkeletonRows', () => {
  for (const [dir, name] of VIEWERS) {
    it(`${name} (${dir})`, () => {
      const src = viewerSrc(dir, name);
      expect(src).toMatch(
        /import\s+SkeletonRows\s+from\s+['"]\$lib\/ui\/SkeletonRows\.svelte['"]/
      );
      expect(src).toContain('<SkeletonRows');
    });
  }
  for (const [dir, name] of AUDIT_VIEWERS) {
    it(`${name} (${dir})`, () => {
      const src = viewerSrc(dir, name);
      expect(src).toMatch(
        /import\s+SkeletonRows\s+from\s+['"]\$lib\/ui\/SkeletonRows\.svelte['"]/
      );
      expect(src).toContain('<SkeletonRows');
    });
  }
});

describe('T19.1 — each register viewer renders the pagination-total element', () => {
  for (const [dir, name] of VIEWERS) {
    it(`${name} (${dir})`, () => {
      const src = viewerSrc(dir, name);
      expect(src).toContain('data-testid="pagination-total"');
      expect(src).toContain('common.pagination.total_entries');
    });
  }
  for (const [dir, name] of AUDIT_VIEWERS) {
    it(`${name} (${dir})`, () => {
      const src = viewerSrc(dir, name);
      expect(src).toContain('data-testid="pagination-total"');
      expect(src).toContain('common.pagination.total_entries');
    });
  }
});

describe('T19.1 — ConcernsViewer renders skeleton during loading and total after load', () => {
  it('initial render shows the skeleton (rather than the legacy text)', async () => {
    // A fetchPage that never resolves keeps the viewer in the loading branch.
    const fetchPage = vi.fn(() => new Promise<never>(() => {}));
    render(ConcernsViewer, { props: { fetchPage } });
    // The con-loading container exists, but its content is the skeleton.
    expect(screen.getByTestId('con-loading')).toBeDefined();
    expect(screen.getByTestId('skeleton-rows')).toBeDefined();
    // The loading container surfaces the loading text as aria-label
    // for assistive tech rather than visible text.
    expect(screen.getByTestId('con-loading').getAttribute('aria-label')).toMatch(
      /loading/i
    );
  });

  it('after load, the pagination-total element shows the row count', async () => {
    const all = buildDemoConcerns(35, 9);
    const fetchPage = vi.fn(async (page: number, page_size: number) => ({
      rows: all.slice(page * page_size, page * page_size + page_size),
      total: all.length,
      page,
      page_size
    }));
    render(ConcernsViewer, { props: { fetchPage } });
    await waitFor(() => {
      expect(screen.getByTestId('pagination-total')).toBeDefined();
    });
    const text = screen.getByTestId('pagination-total').textContent ?? '';
    expect(text).toMatch(/35/);
    expect(text).toMatch(/total/i);
  });
});

describe('T19.1 — common.pagination.total_entries is in the catalog', () => {
  it('catalog has the key', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(typeof catalog.common.pagination.total_entries).toBe('string');
    // The key uses the {count} placeholder.
    expect(catalog.common.pagination.total_entries).toMatch(/\{count\}/);
  });
});
