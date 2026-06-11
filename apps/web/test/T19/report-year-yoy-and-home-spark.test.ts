/**
 * T19 — /report year-mode YoY tiles + year-mode sparkline window +
 * HomeDashboard /report tile sparkline.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import HomeDashboard from '../../src/lib/home/HomeDashboard.svelte';
import { ZERO_SUMMARY, type HomeSummary } from '../../src/lib/home/home-summary';

afterEach(() => {
  cleanup();
});

describe('T19 — /report year-mode YoY tiles', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/report/+page.svelte'),
    'utf8'
  );

  it('computes a priorYear when in year mode', () => {
    expect(src).toMatch(/priorYear\s*=\s*isYearView\s*\?\s*shiftYear\(year,\s*-1\)/);
  });

  it('loads the prior year via buildYearlyReport(priorYear)', () => {
    expect(src).toMatch(/priorYearlyReport\s*=\s*priorYear\s*\?\s*buildYearlyReport\(priorYear\)/);
  });

  it('exposes a yoyFor(key) helper that branches on mode', () => {
    expect(src).toMatch(/\$:\s*yoyFor\s*=\s*\(key\)\s*=>/);
    expect(src).toMatch(/if\s*\(isYearView\s*&&\s*priorYearlyReport\)/);
  });

  it('each tile uses yoy.current / yoy.prior / yoy.priorLabel', () => {
    expect(src).toMatch(/\{@const yoy = yoyFor\(r\.key\)\}/);
    expect(src).toMatch(/data-testid=["']report-tile-count["']>\{yoy\.current\}/);
    expect(src).toMatch(/title=\{t\(['"]report\.page\.yoy_tooltip['"],\s*\{\s*month:\s*yoy\.priorLabel/);
  });
});

describe('T19 — /report sparkline window in year mode', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/report/+page.svelte'),
    'utf8'
  );

  it('builds the 12 months of the active year in year mode', () => {
    expect(src).toMatch(/buildTrailingMonths\(`\$\{year\}-12`,\s*12\)/);
  });

  it('still builds the trailing 12 months ending at month in month mode', () => {
    expect(src).toMatch(/buildTrailingMonths\(month,\s*12\)/);
  });
});

describe('T19 — HomeDashboard /report tile sparkline', () => {
  it('renders nothing when monthlyActivityTrailing is empty', () => {
    render(HomeDashboard, { props: { summary: ZERO_SUMMARY } });
    expect(screen.queryByTestId('hd-tile-report-spark')).toBeNull();
  });

  it('renders an SVG sparkline when the trailing series is provided', () => {
    const summary: HomeSummary = {
      ...ZERO_SUMMARY,
      currentMonthActivity: 12,
      priorMonthActivity: 7,
      monthlyActivityTrailing: [3, 5, 8, 4, 6, 7, 9, 10, 11, 8, 7, 12]
    };
    render(HomeDashboard, { props: { summary } });
    const svg = screen.getByTestId('hd-tile-report-spark');
    expect(svg.getAttribute('viewBox')).toBe('0 0 60 12');
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.querySelectorAll('rect').length).toBe(12);
  });

  it('emphasizes the current-month bar with an is-current class', () => {
    const summary: HomeSummary = {
      ...ZERO_SUMMARY,
      currentMonthActivity: 12,
      priorMonthActivity: 7,
      monthlyActivityTrailing: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    };
    render(HomeDashboard, { props: { summary } });
    const svg = screen.getByTestId('hd-tile-report-spark');
    const bars = svg.querySelectorAll('rect');
    expect(bars[bars.length - 1]!.classList.contains('is-current')).toBe(true);
    expect(bars[0]!.classList.contains('is-current')).toBe(false);
  });

  it("the sparkline's aria-label spells out the series values", () => {
    const summary: HomeSummary = {
      ...ZERO_SUMMARY,
      currentMonthActivity: 4,
      priorMonthActivity: 2,
      monthlyActivityTrailing: [1, 2, 3, 4]
    };
    render(HomeDashboard, { props: { summary } });
    const svg = screen.getByTestId('hd-tile-report-spark');
    const aria = svg.getAttribute('aria-label') ?? '';
    expect(aria).toContain('1, 2, 3, 4');
  });
});

describe('T19 — home-summary carries monthlyActivityTrailing', () => {
  it('ZERO_SUMMARY defaults monthlyActivityTrailing to []', () => {
    expect(ZERO_SUMMARY.monthlyActivityTrailing).toEqual([]);
  });
});

describe('T19 — landing page wires the trailing series into HomeSummary', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/+page.svelte'),
    'utf8'
  );

  it('imports buildTrailingMonths from the report aggregator', () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bbuildTrailingMonths\b[^}]*\}\s+from\s+['"]\$lib\/report\/aggregate['"]/
    );
  });

  it('passes monthlyActivityTrailing into buildHomeSummary', () => {
    expect(src).toMatch(/monthlyActivityTrailing[\s\S]*buildHomeSummary/);
  });

  it('catalog carries the sparkline_aria placeholder', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(catalog.home.dashboard.tile.sparkline_aria).toContain('{values}');
  });
});
