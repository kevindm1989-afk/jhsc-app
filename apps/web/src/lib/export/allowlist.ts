/**
 * Export allowlists (T11/T12 — referenced by T13 negative assertion).
 *
 * Per F-19 (LAUNCH BLOCKER) the export pipeline accepts ONLY the closed-const
 * allowlists below. Any other column is structurally rejected at compile time
 * (TypeScript readonly tuple) and at run time (the ESLint rule forbids
 * spreading these constants).
 *
 * T13's negative assertion (`apps/web/test/T13/reprisal-log.test.ts`):
 * the reprisal_log table + body ciphertext columns MUST NOT appear in
 * either allowlist. The list is the canonical source of truth — if the
 * architect adds a column, the migration + the export pipeline + this
 * file all change in the same PR.
 *
 * RA-1 compensating control #3 (concern-derived flag): the
 * `CONCERN_DERIVED_FIELD_ANNOTATIONS` set names every allowlist entry that
 * MAY carry concern-derived content; the interstitial reads this set when
 * the export's `derived_from_concerns` array is non-empty.
 *
 * Source: F-19 + RA-1 + ADR-0007 amendment + ADR-0003 Amendment B/D/E.
 */

import { createHash } from 'node:crypto';

/**
 * Closed allowlist for `minutes.final` exports (T11).
 *
 * Frozen at module load; the test asserts `Object.isFrozen(...) === true`.
 * The snapshot in the test pins the exact list — any addition is a reviewer
 * event.
 */
export const EXPORT_ALLOWLIST_MINUTES = Object.freeze([
  'minutes_id',
  'finalized_at',
  'agenda_items',
  'decisions',
  'recommendations_summary',
  'attendees_present',
  'next_meeting_at',
  'co_chair_signature_block'
] as const);

/**
 * Closed allowlist for `recommendation` exports (T12).
 *
 * Frozen at module load; the test asserts `Object.isFrozen(...) === true`.
 */
export const EXPORT_ALLOWLIST_RECOMMENDATION = Object.freeze([
  'recommendation_id',
  'title',
  'body',
  'rationale',
  'created_at',
  'sent_at',
  'twentyone_day_due_at',
  'co_chair_signature_block'
] as const);

export type ExportAllowlistMinutesKey = (typeof EXPORT_ALLOWLIST_MINUTES)[number];
export type ExportAllowlistRecommendationKey = (typeof EXPORT_ALLOWLIST_RECOMMENDATION)[number];

/**
 * Fields in the closed allowlist that MAY carry concern-derived content.
 *
 * RA-1 compensating control #3 — when an export carries any
 * `derived_from_concerns` provenance, the interstitial renders a visibly
 * flagged warning that names these fields specifically.
 *
 * Concern provenance flows through the discussion record (`agenda_items`,
 * `decisions`, `recommendations_summary`) for minutes, and through the
 * recommendation body itself for recommendations.
 */
export const CONCERN_DERIVED_FIELD_ANNOTATIONS = Object.freeze({
  'minutes.final': Object.freeze(['agenda_items', 'decisions', 'recommendations_summary'] as const),
  recommendation: Object.freeze(['title', 'body', 'rationale'] as const)
} as const);

/**
 * Compute the SHA-256 hash of an allowlist for the F-27 audit-binding
 * check.
 *
 * The audit row's `field_set_hash` is computed at runtime against the
 * SAME constant the renderer reads; a monkey-patched renderer that
 * substitutes a different allowlist trips the integrity check and aborts
 * the export with an `export.integrity_fail` audit row (per F-27).
 */
export function computeAllowlistHash(allowlist: readonly string[]): string {
  // Stable serialization: hash the JSON of the array (insertion-order
  // preserved by `Object.freeze`). Matching test: identical JSON serialization
  // both ends, identical hex digest.
  const serialized = JSON.stringify([...allowlist]);
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}
