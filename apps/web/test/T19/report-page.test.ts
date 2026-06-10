/**
 * T19 — /report route mount + monthly aggregator.
 *
 * Pins the structural shape of the new monthly-report surface:
 *   - aggregator exports + return shape
 *   - month-string helpers
 *   - +page.ts prerender/ssr declarations
 *   - +page.svelte mounts, testids, i18n keys, and the prev/next nav
 *
 * Tests are file-text / unit-shape (consistent with the rest of T19),
 * not full Svelte renders. The route surface is a thin reactive shell
 * over `buildMonthlyReport`, so pinning the aggregator + file shape
 * gives us enough coverage to catch regressions cheaply.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildMonthlyReport,
  reportToCsvRows,
  shiftMonth,
  toMonthString
} from '../../src/lib/report/aggregate';

const PAGE_PATH = resolve(__dirname, '../../src/routes/report/+page.svelte');
const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/report/+page.ts');
const AGG_PATH = resolve(__dirname, '../../src/lib/report/aggregate.ts');
const I18N_PATH = resolve(__dirname, '../../../../i18n/en-CA.json');
const MORE_PAGE_PATH = resolve(__dirname, '../../src/routes/more/+page.svelte');

describe('T19 — report aggregator (pure functions)', () => {
  it('toMonthString formats a Date as YYYY-MM in local time', () => {
    expect(toMonthString(new Date(2026, 4, 15))).toBe('2026-05');
    expect(toMonthString(new Date(2026, 0, 1))).toBe('2026-01');
    expect(toMonthString(new Date(2026, 11, 31))).toBe('2026-12');
  });

  it('shiftMonth moves forward and backward across year boundaries', () => {
    expect(shiftMonth('2026-06', 1)).toBe('2026-07');
    expect(shiftMonth('2026-06', -1)).toBe('2026-05');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-06', 0)).toBe('2026-06');
  });

  it('buildMonthlyReport returns the expected shape with non-negative integer totals', () => {
    const report = buildMonthlyReport('2026-06');
    expect(report.month).toBe('2026-06');
    expect(report.totals).toEqual(
      expect.objectContaining({
        concerns: expect.any(Number),
        recommendations: expect.any(Number),
        training: expect.any(Number),
        workRefusals: expect.any(Number),
        s51Evidence: expect.any(Number),
        reprisal: expect.any(Number),
        minutes: expect.any(Number),
        inspections: expect.any(Number)
      })
    );
    for (const v of Object.values(report.totals)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('concernsBySeverity covers all four severities and sums to the concerns total', () => {
    const report = buildMonthlyReport('2026-06');
    const sev = report.concernsBySeverity;
    expect(sev).toEqual(
      expect.objectContaining({
        low: expect.any(Number),
        medium: expect.any(Number),
        high: expect.any(Number),
        critical: expect.any(Number)
      })
    );
    const sum = sev.low + sev.medium + sev.high + sev.critical;
    expect(sum).toBe(report.totals.concerns);
  });

  it('recommendationsByStatus covers all four statuses and sums to the recommendations total', () => {
    const report = buildMonthlyReport('2026-06');
    const st = report.recommendationsByStatus;
    expect(st).toEqual(
      expect.objectContaining({
        responded: expect.any(Number),
        pending: expect.any(Number),
        overdue: expect.any(Number),
        archived: expect.any(Number)
      })
    );
    const sum = st.responded + st.pending + st.overdue + st.archived;
    expect(sum).toBe(report.totals.recommendations);
  });

  it('aggregator source imports the eight register demo providers', () => {
    const src = readFileSync(AGG_PATH, 'utf8');
    expect(src).toMatch(/buildDemoConcerns/);
    expect(src).toMatch(/buildDemoRecommendations/);
    expect(src).toMatch(/buildDemoTraining/);
    expect(src).toMatch(/buildDemoWorkRefusals/);
    expect(src).toMatch(/buildDemoS51Evidence/);
    expect(src).toMatch(/buildDemoReprisals/);
    expect(src).toMatch(/buildDemoMinutes/);
    expect(src).toMatch(/buildDemoInspections/);
  });
});

describe('T19 — reportToCsvRows', () => {
  it('emits one row per total + one row per breakdown bucket', () => {
    const report = buildMonthlyReport('2026-06');
    const rows = reportToCsvRows(report);
    // 8 totals + 4 severity + 4 status = 16 rows
    expect(rows.length).toBe(16);
  });

  it('every row carries the source month so a multi-month CSV stack pivots correctly', () => {
    const rows = reportToCsvRows(buildMonthlyReport('2026-06'));
    for (const r of rows) expect(r.month).toBe('2026-06');
  });

  it('groups rows under three sections: totals, concerns_severity, recs_status', () => {
    const rows = reportToCsvRows(buildMonthlyReport('2026-06'));
    const sections = new Set(rows.map((r) => r.section));
    expect(sections).toEqual(new Set(['totals', 'concerns_severity', 'recs_status']));
  });

  it('totals rows match the report.totals object', () => {
    const report = buildMonthlyReport('2026-06');
    const rows = reportToCsvRows(report);
    const totalsRows = rows.filter((r) => r.section === 'totals');
    expect(totalsRows.length).toBe(8);
    for (const r of totalsRows) {
      expect(r.count).toBe(
        report.totals[/** @type {keyof typeof report.totals} */ (r.key as keyof typeof report.totals)]
      );
    }
  });

  it('every count is a non-negative integer', () => {
    const rows = reportToCsvRows(buildMonthlyReport('2026-06'));
    for (const r of rows) {
      expect(Number.isInteger(r.count)).toBe(true);
      expect(r.count).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('T19 — /report route mount', () => {
  it('the +page.svelte component exists at the expected path', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('the +page.ts loader exists alongside the component', () => {
    expect(existsSync(PAGE_TS_PATH)).toBe(true);
  });

  it('+page.ts declares prerender = true', () => {
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+prerender\s*=\s*true/);
  });

  it('+page.ts declares ssr = false', () => {
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+ssr\s*=\s*false/);
  });

  it('the page carries the report-page data-testid', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']report-page["']/);
  });

  it('reads ?month=YYYY-MM from the URL and defaults to the current month', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/searchParams\.get\(['"]month['"]\)/);
    expect(src).toMatch(/toMonthString\(\s*new Date\(\)\s*\)/);
  });

  it('imports the aggregator helpers (buildMonthlyReport, shiftMonth, toMonthString)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s*\{[^}]*\bbuildMonthlyReport\b[^}]*\}\s+from\s+['"]\$lib\/report\/aggregate['"]/
    );
    expect(src).toMatch(/\bshiftMonth\b/);
    expect(src).toMatch(/\btoMonthString\b/);
  });

  it('renders prev/next month links with shiftMonth offsets', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']report-prev-month["']/);
    expect(src).toMatch(/data-testid=["']report-next-month["']/);
    expect(src).toMatch(/shiftMonth\(month,\s*-1\)/);
    expect(src).toMatch(/shiftMonth\(month,\s*1\)/);
  });

  it('renders the totals tile grid and the breakdown rows', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']report-tiles["']/);
    expect(src).toMatch(/data-testid=["']report-tile["']/);
    expect(src).toMatch(/data-testid=["']report-tile-count["']/);
    expect(src).toMatch(/data-testid=["']report-concerns-severity["']/);
    expect(src).toMatch(/data-testid=["']report-recs-status["']/);
  });

  it('renders the demo-note callout', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']report-demo-note["']/);
    expect(src).toMatch(/t\(['"]report\.page\.demo_note['"]\)/);
  });

  it('renders a back-to-home link so the user is not stranded', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/<a\s+href=["']\/["']/);
    expect(src).toMatch(/data-testid=["']report-back-to-home["']/);
  });

  it('mounts CsvDownloadButton + wires it to reportToCsvRows for the current month', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s+CsvDownloadButton\s+from\s+['"]\$lib\/ui\/CsvDownloadButton\.svelte['"]/
    );
    expect(src).toMatch(/<CsvDownloadButton/);
    expect(src).toMatch(/reportToCsvRows\(report\)/);
    expect(src).toMatch(/csvFilename\(`report-\$\{month\}`\)/);
  });

  it('carries a noindex meta', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });
});

describe('T19 — /report i18n keys', () => {
  it('en-CA carries the report.page block', () => {
    const cat = JSON.parse(readFileSync(I18N_PATH, 'utf8')) as Record<string, any>;
    expect(cat.report?.page?.title).toBeTruthy();
    expect(cat.report?.page?.heading).toBeTruthy();
    expect(cat.report?.page?.intro).toBeTruthy();
    expect(cat.report?.page?.month_nav_aria).toBeTruthy();
    expect(cat.report?.page?.prev_month).toBeTruthy();
    expect(cat.report?.page?.next_month).toBeTruthy();
    expect(cat.report?.page?.totals_heading).toBeTruthy();
    expect(cat.report?.page?.concerns_severity_heading).toBeTruthy();
    expect(cat.report?.page?.recs_status_heading).toBeTruthy();
    expect(cat.report?.page?.demo_note).toBeTruthy();
    expect(cat.report?.page?.back_to_home_cta).toBeTruthy();
  });

  it('en-CA carries a tile label for every register key the route renders', () => {
    const cat = JSON.parse(readFileSync(I18N_PATH, 'utf8')) as Record<string, any>;
    const tile = cat.report?.page?.tile ?? {};
    for (const k of [
      'concerns',
      'recommendations',
      'work_refusals',
      's51_evidence',
      'reprisal',
      'minutes',
      'inspections',
      'training'
    ]) {
      expect(tile[k]).toBeTruthy();
    }
  });

  it('en-CA carries the /more launcher link copy for /report', () => {
    const cat = JSON.parse(readFileSync(I18N_PATH, 'utf8')) as Record<string, any>;
    expect(cat.common?.morePage?.link_report_label).toBeTruthy();
    expect(cat.common?.morePage?.link_report_blurb).toBeTruthy();
  });
});

describe('T19 — /more launcher surfaces /report', () => {
  it('renders a /report row with the matching testid + label key', () => {
    const src = readFileSync(MORE_PAGE_PATH, 'utf8');
    expect(src).toMatch(/href=["']\/report["']/);
    expect(src).toMatch(/data-testid=["']more-link-report["']/);
    expect(src).toMatch(/t\(['"]common\.morePage\.link_report_label['"]\)/);
    expect(src).toMatch(/t\(['"]common\.morePage\.link_report_blurb['"]\)/);
  });
});
