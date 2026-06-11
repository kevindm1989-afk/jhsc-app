/**
 * Cross-register monthly aggregator.
 *
 * Given a YYYY-MM month string, walks every register's demo dataset
 * and counts the rows whose primary date falls inside the month.
 * Produces a `MonthlyReport` shape with per-register totals + a few
 * targeted breakdowns (concerns by severity, recommendations by
 * status).
 *
 * Backend-agnostic: when the real backends land they can plug in
 * their own row sources; the aggregator operates on plain rows.
 */

import { buildDemoConcerns, type DemoConcernRow } from '../concerns/demo-concerns';
import {
  buildDemoRecommendations,
  type DemoRecommendationRow
} from '../recommendations/demo-recommendations';
import { buildDemoTraining, type DemoTrainingRow } from '../training/demo-training';
import { buildDemoWorkRefusals, type DemoWorkRefusalRow } from '../work-refusal/demo-work-refusal';
import { buildDemoS51Evidence, type DemoS51EvidenceRow } from '../s51-evidence/demo-s51-evidence';
import { buildDemoReprisals, type DemoReprisalRow } from '../reprisal/demo-reprisal';
import { buildDemoMinutes, type DemoMinutesRow } from '../minutes/demo-minutes';
import { buildDemoInspections, type DemoInspectionRow } from '../inspections/demo-inspections';

export type MonthString = `${number}-${number}` | string;
export type YearString = `${number}` | string;

export interface MonthlyReport {
  month: MonthString;
  totals: {
    concerns: number;
    recommendations: number;
    training: number;
    workRefusals: number;
    s51Evidence: number;
    reprisal: number;
    minutes: number;
    inspections: number;
  };
  concernsBySeverity: { low: number; medium: number; high: number; critical: number };
  recommendationsByStatus: {
    responded: number;
    pending: number;
    overdue: number;
    archived: number;
  };
}

function inMonth(iso: string, month: MonthString): boolean {
  return iso.startsWith(month);
}

/**
 * Returns the YYYY year string for `date`. Local time, matching
 * `toMonthString`.
 */
export function toYearString(date: Date): YearString {
  return String(date.getFullYear());
}

/**
 * Returns the YYYY year that is `offset` years from `year`.
 */
export function shiftYear(year: YearString, offset: number): YearString {
  const y = parseInt(year, 10);
  return String(y + offset);
}

/**
 * Returns the YYYY-MM month string for `date`. Uses local time so
 * the worker's "this month" matches their wall clock.
 */
export function toMonthString(date: Date): MonthString {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Returns the YYYY-MM that is `offset` months from `month`. Positive
 * offset moves forward, negative moves back. Wraps year boundaries.
 */
export function shiftMonth(month: MonthString, offset: number): MonthString {
  const [y, m] = month.split('-').map((n) => parseInt(n, 10));
  const d = new Date(y!, m! - 1 + offset, 1);
  return toMonthString(d);
}

function countConcernsBy(rows: readonly DemoConcernRow[]) {
  const by = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const r of rows) by[r.severity] += 1;
  return by;
}

function countRecsBy(rows: readonly DemoRecommendationRow[]) {
  const by = { responded: 0, pending: 0, overdue: 0, archived: 0 };
  for (const r of rows) by[r.status] += 1;
  return by;
}

/**
 * Build a monthly report from the demo datasets. `month` is the
 * YYYY-MM the worker chose; rows whose primary date sits in that
 * month are counted.
 */
export function buildMonthlyReport(month: MonthString): MonthlyReport {
  const concerns = buildDemoConcerns(50).filter((r: DemoConcernRow) => inMonth(r.filed_at, month));
  const recommendations = buildDemoRecommendations(50).filter((r: DemoRecommendationRow) =>
    inMonth(r.filed_at, month)
  );
  const training = buildDemoTraining(50).filter((r: DemoTrainingRow) =>
    inMonth(r.completed_at, month)
  );
  const workRefusals = buildDemoWorkRefusals(50).filter((r: DemoWorkRefusalRow) =>
    inMonth(r.filed_at, month)
  );
  const s51Evidence = buildDemoS51Evidence(30).filter((r: DemoS51EvidenceRow) =>
    inMonth(r.opened_at, month)
  );
  const reprisal = buildDemoReprisals(50).filter((r: DemoReprisalRow) =>
    inMonth(r.filed_at, month)
  );
  const minutes = buildDemoMinutes(50).filter((r: DemoMinutesRow) =>
    inMonth(r.meeting_date, month)
  );
  const inspections = buildDemoInspections(50).filter((r: DemoInspectionRow) =>
    inMonth(r.conducted_at, month)
  );

  return {
    month,
    totals: {
      concerns: concerns.length,
      recommendations: recommendations.length,
      training: training.length,
      workRefusals: workRefusals.length,
      s51Evidence: s51Evidence.length,
      reprisal: reprisal.length,
      minutes: minutes.length,
      inspections: inspections.length
    },
    concernsBySeverity: countConcernsBy(concerns),
    recommendationsByStatus: countRecsBy(recommendations)
  };
}

export interface YearlyReport {
  year: YearString;
  totals: MonthlyReport['totals'];
  concernsBySeverity: MonthlyReport['concernsBySeverity'];
  recommendationsByStatus: MonthlyReport['recommendationsByStatus'];
  months: MonthlyReport[];
}

/**
 * Build a yearly report by summing the 12 monthly snapshots of
 * `year`. The returned `months` array is in calendar order
 * (Jan → Dec) so consumers can show a per-month sparkline / strip
 * without re-sorting.
 */
export function buildYearlyReport(year: YearString): YearlyReport {
  const months: MonthlyReport[] = [];
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    months.push(buildMonthlyReport(`${year}-${mm}`));
  }
  const totals = {
    concerns: 0,
    recommendations: 0,
    training: 0,
    workRefusals: 0,
    s51Evidence: 0,
    reprisal: 0,
    minutes: 0,
    inspections: 0
  };
  const concernsBySeverity = { low: 0, medium: 0, high: 0, critical: 0 };
  const recommendationsByStatus = { responded: 0, pending: 0, overdue: 0, archived: 0 };
  for (const m of months) {
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += m.totals[k];
    for (const k of Object.keys(concernsBySeverity) as (keyof typeof concernsBySeverity)[])
      concernsBySeverity[k] += m.concernsBySeverity[k];
    for (const k of Object.keys(
      recommendationsByStatus
    ) as (keyof typeof recommendationsByStatus)[])
      recommendationsByStatus[k] += m.recommendationsByStatus[k];
  }
  return { year, totals, concernsBySeverity, recommendationsByStatus, months };
}

/**
 * Flatten a MonthlyReport into row-shaped records for CSV export. One
 * row per metric, with `section`, `key`, and `count` columns so a
 * spreadsheet can pivot by section. The month itself goes in column 0
 * so each row carries its period.
 */
export function reportToCsvRows(
  report: MonthlyReport
): Array<{ month: string; section: string; key: string; count: number }> {
  const rows: Array<{ month: string; section: string; key: string; count: number }> = [];
  for (const [key, count] of Object.entries(report.totals)) {
    rows.push({ month: report.month, section: 'totals', key, count });
  }
  for (const [key, count] of Object.entries(report.concernsBySeverity)) {
    rows.push({ month: report.month, section: 'concerns_severity', key, count });
  }
  for (const [key, count] of Object.entries(report.recommendationsByStatus)) {
    rows.push({ month: report.month, section: 'recs_status', key, count });
  }
  return rows;
}

/**
 * Build `count` consecutive monthly reports ending at `month`, in
 * calendar order (oldest first). Powers the /report sparkline.
 */
export function buildTrailingMonths(month: MonthString, count: number): MonthlyReport[] {
  const out: MonthlyReport[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push(buildMonthlyReport(shiftMonth(month, -i)));
  }
  return out;
}

/**
 * Flatten a YearlyReport into row-shaped records for CSV export.
 * Each underlying month contributes its own rows (so the CSV stays
 * a strict superset of the per-month CSV shape — paste into the same
 * sheet and pivot). Year-level totals carry the literal year string
 * in the `month` column with `_year` as a suffix so a pivot can tell
 * them apart.
 */
export function yearlyReportToCsvRows(
  report: YearlyReport
): Array<{ month: string; section: string; key: string; count: number }> {
  const rows: Array<{ month: string; section: string; key: string; count: number }> = [];
  for (const m of report.months) rows.push(...reportToCsvRows(m));
  const yearTag = `${report.year}_year`;
  for (const [key, count] of Object.entries(report.totals)) {
    rows.push({ month: yearTag, section: 'totals', key, count });
  }
  for (const [key, count] of Object.entries(report.concernsBySeverity)) {
    rows.push({ month: yearTag, section: 'concerns_severity', key, count });
  }
  for (const [key, count] of Object.entries(report.recommendationsByStatus)) {
    rows.push({ month: yearTag, section: 'recs_status', key, count });
  }
  return rows;
}
