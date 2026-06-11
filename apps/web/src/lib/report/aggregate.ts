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
