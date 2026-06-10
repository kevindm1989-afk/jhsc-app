/**
 * Cross-register search.
 *
 * Builds a flat list of `SearchableRecord`s from each register's
 * demo dataset, then filters by case-insensitive substring match on
 * the primary + secondary text fields. Results carry the source
 * register, an opaque id, a primary label, an optional preview, an
 * ISO date, and an href that deep-links back to the register
 * surface.
 *
 * The search index is rebuilt per call (cheap: demo data is small,
 * deterministic, and lives in memory). When the real backends land
 * each register can plug its own search adapter without changing
 * the consumer (the /search page).
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
import { buildDemoLibrary, type DemoLibraryRow } from '../library/demo-library';
import { buildDemoAuditRows, type DemoAuditRow } from '../audit/demo-audit-rows';
import { buildDemoSensitiveRows, type DemoSensitiveRow } from '../audit/demo-sensitive-feed';

export type RegisterKey =
  | 'concerns'
  | 'recommendations'
  | 'training'
  | 'work-refusal'
  | 's51-evidence'
  | 'reprisal'
  | 'minutes'
  | 'inspections'
  | 'library'
  | 'audit'
  | 'sensitive-feed';

export interface SearchableRecord {
  register: RegisterKey;
  id: string;
  /** The primary text shown in the result (title / certification /
   *  event_type / etc.). Matched by the search. */
  primaryText: string;
  /** A short secondary text shown below the primary; also matched
   *  by the search. May be empty. */
  secondaryText: string;
  /** ISO timestamp for the row (sort key + display). */
  date: string;
  /** Where clicking the result lands. */
  href: string;
}

export interface SearchResultGroup {
  register: RegisterKey;
  records: SearchableRecord[];
  /** Total matches for the register (before any per-group truncation). */
  total: number;
}

/** Group cap — keep result lists scannable. */
export const PER_GROUP_LIMIT = 5;

function map<T, R>(rows: readonly T[], fn: (row: T) => R): R[] {
  return rows.map(fn);
}

function fromConcerns(rows: readonly DemoConcernRow[]): SearchableRecord[] {
  return map(rows, (r) => ({
    register: 'concerns',
    id: r.id,
    primaryText: r.title,
    secondaryText: `${r.hazard_class} · ${r.severity}`,
    date: r.filed_at,
    href: '/concerns'
  }));
}
function fromRecommendations(rows: readonly DemoRecommendationRow[]): SearchableRecord[] {
  return map(rows, (r) => ({
    register: 'recommendations',
    id: r.id,
    primaryText: r.title,
    secondaryText: r.status,
    date: r.filed_at,
    href: '/recommendations'
  }));
}
function fromTraining(rows: readonly DemoTrainingRow[]): SearchableRecord[] {
  return map(rows, (r) => ({
    register: 'training',
    id: r.id,
    primaryText: r.certification,
    secondaryText: `${r.member_pseudonym} · ${r.validity}`,
    date: r.completed_at,
    href: '/training'
  }));
}
function fromWorkRefusals(rows: readonly DemoWorkRefusalRow[]): SearchableRecord[] {
  return map(rows, (r) => ({
    register: 'work-refusal',
    id: r.id,
    primaryText: r.title,
    secondaryText: r.stage,
    date: r.filed_at,
    href: '/work-refusal'
  }));
}
function fromS51Evidence(rows: readonly DemoS51EvidenceRow[]): SearchableRecord[] {
  return map(rows, (r) => ({
    register: 's51-evidence',
    id: r.id,
    primaryText: r.title,
    secondaryText: r.scene_state,
    date: r.opened_at,
    href: '/s51-evidence'
  }));
}
function fromReprisals(rows: readonly DemoReprisalRow[]): SearchableRecord[] {
  return map(rows, (r) => ({
    register: 'reprisal',
    id: r.id,
    primaryText: r.title,
    secondaryText: r.status,
    date: r.filed_at,
    href: '/reprisal'
  }));
}
function fromMinutes(rows: readonly DemoMinutesRow[]): SearchableRecord[] {
  return map(rows, (r) => ({
    register: 'minutes',
    id: r.id,
    primaryText: r.title,
    secondaryText: r.status,
    date: r.meeting_date,
    href: '/minutes'
  }));
}
function fromInspections(rows: readonly DemoInspectionRow[]): SearchableRecord[] {
  return map(rows, (r) => ({
    register: 'inspections',
    id: r.id,
    primaryText: r.area,
    secondaryText: r.notes_preview,
    date: r.conducted_at,
    href: '/inspections'
  }));
}
function fromLibrary(rows: readonly DemoLibraryRow[]): SearchableRecord[] {
  return map(rows, (r) => ({
    register: 'library',
    id: r.id,
    primaryText: r.title,
    secondaryText: `${r.category} · ${r.version}`,
    date: r.updated_at,
    href: '/library'
  }));
}
function fromAudit(rows: readonly DemoAuditRow[]): SearchableRecord[] {
  return map(rows, (r) => ({
    register: 'audit',
    id: r.id,
    primaryText: r.event_type,
    secondaryText: r.actor_pseudonym,
    date: r.ts,
    href: '/audit'
  }));
}
function fromSensitive(rows: readonly DemoSensitiveRow[]): SearchableRecord[] {
  return map(rows, (r) => ({
    register: 'sensitive-feed',
    id: r.id,
    primaryText: r.event_type,
    secondaryText: `${r.sensitivity.toUpperCase()} · ${r.actor_pseudonym}`,
    date: r.ts,
    href: '/sensitive-feed'
  }));
}

/**
 * Build the full searchable index over all 11 register demo
 * datasets. Cheap: deterministic, in-memory, lazy-built per call.
 */
export function buildSearchIndex(): SearchableRecord[] {
  return [
    ...fromConcerns(buildDemoConcerns(50)),
    ...fromRecommendations(buildDemoRecommendations(50)),
    ...fromTraining(buildDemoTraining(50)),
    ...fromWorkRefusals(buildDemoWorkRefusals(50)),
    ...fromS51Evidence(buildDemoS51Evidence(30)),
    ...fromReprisals(buildDemoReprisals(50)),
    ...fromMinutes(buildDemoMinutes(50)),
    ...fromInspections(buildDemoInspections(50)),
    ...fromLibrary(buildDemoLibrary(50)),
    ...fromAudit(buildDemoAuditRows(50)),
    ...fromSensitive(buildDemoSensitiveRows(50))
  ];
}

/**
 * Case-insensitive substring search over primary + secondary text.
 * Returns groups in a canonical order with at most `PER_GROUP_LIMIT`
 * records per register (newest-first within a group).
 */
export function search(
  index: readonly SearchableRecord[],
  query: string,
  perGroupLimit = PER_GROUP_LIMIT
): SearchResultGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const matches = index.filter(
    (r) => r.primaryText.toLowerCase().includes(q) || r.secondaryText.toLowerCase().includes(q)
  );

  const byRegister = new Map<RegisterKey, SearchableRecord[]>();
  for (const r of matches) {
    const list = byRegister.get(r.register);
    if (list) list.push(r);
    else byRegister.set(r.register, [r]);
  }

  const order: RegisterKey[] = [
    'concerns',
    'recommendations',
    'work-refusal',
    's51-evidence',
    'reprisal',
    'inspections',
    'minutes',
    'training',
    'library',
    'audit',
    'sensitive-feed'
  ];

  const groups: SearchResultGroup[] = [];
  for (const register of order) {
    const rs = byRegister.get(register);
    if (!rs || rs.length === 0) continue;
    rs.sort((a, b) => (a.date < b.date ? 1 : -1));
    groups.push({
      register,
      total: rs.length,
      records: rs.slice(0, perGroupLimit)
    });
  }
  return groups;
}
