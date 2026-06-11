/**
 * T19 — /report trailing-12-month sparkline tiles.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildTrailingMonths } from '../../src/lib/report/aggregate';

describe('T19 — buildTrailingMonths', () => {
  it('returns count monthly reports ending at month, oldest first', () => {
    const series = buildTrailingMonths('2026-06', 12);
    expect(series.length).toBe(12);
    expect(series[0]!.month).toBe('2025-07');
    expect(series[11]!.month).toBe('2026-06');
  });

  it('count=1 returns just the current month', () => {
    const series = buildTrailingMonths('2026-06', 1);
    expect(series.length).toBe(1);
    expect(series[0]!.month).toBe('2026-06');
  });

  it('wraps across year boundaries cleanly', () => {
    const series = buildTrailingMonths('2026-01', 3);
    expect(series.map((s) => s.month)).toEqual(['2025-11', '2025-12', '2026-01']);
  });
});

describe('T19 — /report sparkline tile markup', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/report/+page.svelte'),
    'utf8'
  );

  it('imports buildTrailingMonths from the aggregator', () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bbuildTrailingMonths\b[^}]*\}\s+from\s+['"]\$lib\/report\/aggregate['"]/
    );
  });

  it('computes trailingMonths in both modes (year mode targets the active year, month mode the trailing window ending at month)', () => {
    // Month mode: 12 months ending at `month`.
    expect(src).toContain('buildTrailingMonths(month, 12)');
    // Year mode: 12 months of `year`, anchored at December.
    expect(src).toMatch(/buildTrailingMonths\(`\$\{year\}-12`,\s*12\)/);
  });

  it('renders an SVG sparkline per tile when trailingSeries is present', () => {
    expect(src).toMatch(/data-testid=["']report-tile-spark["']/);
    expect(src).toMatch(/viewBox=["']0 0 60 12["']/);
    expect(src).toMatch(/role=["']img["']/);
  });

  it("the sparkline's last bar carries an is-current class", () => {
    expect(src).toMatch(/class:is-current=\{i\s*===\s*series\.length\s*-\s*1\}/);
  });

  it("the sparkline reads sparkline_aria with the series joined as values", () => {
    expect(src).toContain('report.page.sparkline_aria');
  });

  it('the catalog carries sparkline_aria with a {values} placeholder', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(catalog.report.page.sparkline_aria).toContain('{values}');
  });
});
