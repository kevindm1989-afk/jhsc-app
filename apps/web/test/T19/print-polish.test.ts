/**
 * T19 — Print polish sweep.
 *
 * Covers:
 *   - ActiveFiltersBar emits a print-only summary block when there
 *     are active filters (the paper handout carries the scope).
 *   - Each register viewer stamps `data-print="row"` on its row
 *     element so the global print CSS prevents mid-row page breaks.
 *   - app.html print CSS supports `data-print="print-only"` reveal
 *     and `data-print="row"` break-protection rules.
 *   - i18n key for the summary label is present.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ActiveFiltersBar from '../../src/lib/ui/ActiveFiltersBar.svelte';

afterEach(() => {
  cleanup();
});

describe('T19 — ActiveFiltersBar print summary', () => {
  it('renders nothing when no filters are active (so prints are quiet)', () => {
    render(ActiveFiltersBar, { props: { baseHref: '/concerns', filters: [] } });
    expect(screen.queryByTestId('active-filters-print-summary')).toBeNull();
  });

  it('renders a print-only summary block when filters are active', () => {
    render(ActiveFiltersBar, {
      props: {
        baseHref: '/concerns',
        filters: [
          { key: 'status', label: 'Status: Open', removeHref: '/concerns?severity=high' },
          { key: 'severity', label: 'Severity: High', removeHref: '/concerns?filter=open' }
        ]
      }
    });
    const summary = screen.getByTestId('active-filters-print-summary');
    expect(summary.getAttribute('data-print')).toBe('print-only');
    expect(summary.textContent).toContain('Status: Open');
    expect(summary.textContent).toContain('Severity: High');
  });
});

describe('T19 — register viewers stamp data-print="row" on each row', () => {
  const VIEWERS = [
    'concerns/ConcernsViewer.svelte',
    'recommendations/RecommendationsViewer.svelte',
    'training/TrainingViewer.svelte',
    'work-refusal/WorkRefusalViewer.svelte',
    's51-evidence/S51EvidenceViewer.svelte',
    'reprisal/ReprisalViewer.svelte',
    'minutes/MinutesViewer.svelte',
    'inspections/InspectionsViewer.svelte',
    'library/LibraryViewer.svelte',
    'audit/AuditLogViewer.svelte',
    'audit/SensitiveFeedViewer.svelte'
  ];

  for (const v of VIEWERS) {
    it(`${v} stamps data-print="row" on the row opening tag`, () => {
      const src = readFileSync(resolve(__dirname, '../../src/lib', v), 'utf8');
      // The row opening tag is the line with data-testid="*-row" (the row
      // itself, not row-ts/row-head/etc). It must carry data-print="row".
      expect(src).toMatch(/data-testid="[a-z0-9-]+-row"[^>]*data-print="row"/);
    });
  }
});

describe('T19 — app.html print CSS supports print-only + row break protection', () => {
  const html = readFileSync(
    resolve(__dirname, '../../src/app.html'),
    'utf8'
  );

  it('reveals data-print="print-only" elements in print', () => {
    expect(html).toMatch(/\[data-print=['"]print-only['"]\]\s*\{\s*display:\s*block/);
  });

  it('protects data-print="row" elements from mid-row page breaks', () => {
    expect(html).toMatch(/\[data-print=['"]row['"]\][\s\S]*break-inside:\s*avoid/);
  });
});

describe('T19 — common.activeFilters.print_summary_label i18n key', () => {
  it('catalog carries the summary label', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(typeof catalog.common.activeFilters.print_summary_label).toBe('string');
  });
});
