/**
 * Export allowlists (T11/T12 — referenced by T13 negative assertion).
 *
 * Per F-19 the export pipeline accepts ONLY the closed-const allowlists
 * below. Any other column is structurally rejected at compile time
 * (TypeScript readonly tuple) and at run time (the ESLint rule forbids
 * spreading these constants).
 *
 * T13's negative assertion (`apps/web/test/T13/reprisal-log.test.ts`):
 * the reprisal_log table + body ciphertext columns MUST NOT appear in
 * either allowlist. The list is the canonical source of truth — if the
 * architect adds a column, the migration + the export pipeline + this
 * file all change in the same PR.
 *
 * Source: F-19 + ADR-0007 amendment + ADR-0003 Amendment B/D/E.
 */

export const EXPORT_ALLOWLIST_MINUTES = [
  'minutes_id',
  'meeting_date',
  'attendees_role_only',
  'agenda_items_text',
  'decisions_text',
  'recommendations_ids',
  'created_at',
  'finalized_at',
  'approver_actor_pseudonym'
] as const;

export const EXPORT_ALLOWLIST_RECOMMENDATION = [
  'recommendation_id',
  'minutes_id',
  'recommendation_text',
  'priority',
  'target_completion_date',
  'created_at',
  'status'
] as const;

export type ExportAllowlistMinutesKey = (typeof EXPORT_ALLOWLIST_MINUTES)[number];
export type ExportAllowlistRecommendationKey = (typeof EXPORT_ALLOWLIST_RECOMMENDATION)[number];
