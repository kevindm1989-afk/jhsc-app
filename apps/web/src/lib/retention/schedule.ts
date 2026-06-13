/**
 * Frozen retention schedules + drift check + schedule_hash (T16; F-55, F-63, F-68).
 *
 * Two frozen constants live here:
 *   - `RETENTION_SCHEDULE` — audit_log per-event_type retention (ADR-0017 §3).
 *   - `OPERATIONAL_TABLE_SCHEDULE` — non-audit operational tables (ADR-0016 mirror).
 *
 * `computeScheduleHash()` is the F-63 binding hash on every `retention.deleted`
 * summary row; sorted-keys canonical-JSON over both schedules, SHA-256 hex.
 *
 * Test-only override hooks (`__setScheduleOverrideForTest`,
 * `__resetScheduleOverrideForTest`) are deep-imported by tests; the barrel
 * never re-exports them (T11/T12 F-1 BLOCK lineage).
 *
 * Source: ADR-0017 §3/§7/§9; threat-model §3.9 F-55/F-63/F-68.
 */

import { createHash } from 'node:crypto';
import type {
  OperationalTableScheduleEntry,
  RetentionEventType,
  RetentionScheduleEntry
} from './types';

/**
 * Closed-allowlist schedule — every entry pinned at module load. The
 * `Object.freeze` is the runtime defense against the F-19 "spread-then-mutate"
 * attack (see test cross-cutting (a)).
 *
 * F-68 anchor: `export.generated` is `fixed_years` / 7 / structural. Any
 * override-config attempting to lower this is rejected by tsc (the
 * `RetentionPassConfig` interface has no per-event override field).
 */
export const RETENTION_SCHEDULE = Object.freeze({
  'alert.fired': { kind: 'fixed_months', months: 24 },
  // ADR-0019 §"Optional audit_chain_anchors table": load-bearing
  // forensic anchor; 7y per the off-app weekly-email backstop policy.
  'audit.chain_anchor.weekly': { kind: 'fixed_years', years: 7, no_target_id: true },
  'audit.forensic_reveal.4eyes_completed': { kind: 'fixed_years', years: 7 },
  'audit.forensic_reveal.4eyes_pending': { kind: 'fixed_years', years: 7 },
  // ADR-0019 Decision §10: mismatch is load-bearing forensic (7y),
  // ran is operational telemetry (24mo) — mirrors retention_sweep_runs.
  'audit.integrity_check.mismatch': { kind: 'fixed_years', years: 7, no_target_id: true },
  'audit.integrity_check.ran': { kind: 'fixed_months', months: 24, no_target_id: true },
  'auth.passkey.enrolled': { kind: 'fixed_days', days: 90 },
  'auth.passkey.revoked': { kind: 'fixed_days', days: 90 },
  // M8.A.3b — ADR-0018 §"Option H": manifest_written is the durable audit
  // anchor for each backup pass; mirrors retention.deleted at 7y. NO target_id.
  'backup.manifest_written': { kind: 'fixed_years', years: 7, no_target_id: true },
  'client.cache_policy_violation': { kind: 'fixed_months', months: 12 },
  'client.identity_selftest_fail': { kind: 'fixed_months', months: 12 },
  'committee.key_rotated': { kind: 'years_from_rotation', years: 7 },
  'committee_data_key.member_revoked': { kind: 'fixed_years', years: 7 },
  'committee_data_key.rotation.completed': { kind: 'years_from_rotation', years: 7 },
  'committee_data_key.rotation.started': { kind: 'years_from_rotation', years: 7 },
  'committee_data_key.unwrap': { kind: 'fixed_months', months: 24 },
  'committee_data_key.wrapped_for_member': { kind: 'fixed_years', years: 7 },
  'concern.created': { kind: 'match_underlying' },
  'concern.source_revealed': { kind: 'fixed_years', years: 7 },
  'concern.updated': { kind: 'match_underlying' },
  'export.contained_concern_derived_items': { kind: 'fixed_years', years: 7 },
  'export.delivered': { kind: 'fixed_years', years: 7 },
  // F-68 / RA-1 control #5: immutable 7y. No config path widens this.
  'export.generated': { kind: 'fixed_years', years: 7 },
  'identity_keypair.created': { kind: 'membership_plus_years', years: 7 },
  'identity_privkey.recovery_blob.restored': { kind: 'fixed_years', years: 7 },
  'identity_privkey.recovery_blob.viewed': { kind: 'fixed_years', years: 7 },
  'identity_privkey.recovery_blob.written': { kind: 'fixed_years', years: 7 },
  'inspection.synced': { kind: 'fixed_months', months: 24 },
  'member.added': { kind: 'membership_plus_years', years: 7 },
  'member.removed': { kind: 'membership_plus_years', years: 7 },
  'photo.sanitize.unsupported_format': { kind: 'fixed_months', months: 12 },
  'queue.integrity_fail': { kind: 'fixed_months', months: 24 },
  'recommendation.created': { kind: 'fixed_years', years: 7 },
  'recommendation.employer_response_logged': { kind: 'fixed_years', years: 7 },
  'recommendation.overdue.alert': { kind: 'fixed_years', years: 7 },
  'reprisal.created': { kind: 'fixed_years', years: 7 },
  'reprisal.read': { kind: 'fixed_years', years: 7 },
  'reprisal.status_changed.4eyes_completed': { kind: 'fixed_years', years: 7 },
  'reprisal.status_changed.4eyes_pending': { kind: 'fixed_years', years: 7 },
  'reprisal.update': { kind: 'fixed_years', years: 7 },
  // F-62: structural carve-out from the underlying-record-ceiling. The
  // `no_target_id: true` flag tells the sweep these rows are exempt from the
  // 30d ceiling — they have no linked record to chase.
  'retention.deleted': { kind: 'fixed_years', years: 7, no_target_id: true },
  's51_evidence.create.rejected': { kind: 'fixed_years', years: 7 },
  's51_evidence.created': { kind: 'fixed_years', years: 7 },
  's51_evidence.read': { kind: 'fixed_years', years: 7 },
  's51_evidence.update': { kind: 'fixed_years', years: 7 },
  'sensitive.access_attempt': { kind: 'fixed_months', months: 24 },
  'session.revoked': { kind: 'fixed_days', days: 90 },
  'work_refusal.created': { kind: 'fixed_years', years: 7 },
  'work_refusal.read': { kind: 'fixed_years', years: 7 },
  'work_refusal.update': { kind: 'fixed_years', years: 7 }
} as const) as Readonly<Record<RetentionEventType, RetentionScheduleEntry>>;

/**
 * Non-audit operational table sweep schedule.
 *
 * F-56 anchor: `auth_totp_consumed_log` retention is 24h.
 */
export const OPERATIONAL_TABLE_SCHEDULE = Object.freeze({
  auth_totp_consumed_log: { kind: 'fixed_hours', hours: 24 }
} as const) as Readonly<Record<string, OperationalTableScheduleEntry>>;

// ---------------------------------------------------------------------------
// Test-only override hook (deep-import surface; NOT re-exported from barrel).
// ---------------------------------------------------------------------------

let _scheduleOverride: Readonly<Record<string, unknown>> | null = null;

/**
 * Test-only — install a divergent schedule for drift-check + hash tests.
 *
 * The override is a separate state lane; production callers consume the
 * frozen `RETENTION_SCHEDULE` const directly. The drift-check + hash helpers
 * read this override when set (mirroring how the renderer-allowlist override
 * works in T11/T12 export-core).
 */
export function __setScheduleOverrideForTest(
  override: Readonly<Record<string, unknown>> | null
): void {
  _scheduleOverride = override;
}

/** Test-only — clear any installed override. Called in beforeEach/afterEach. */
export function __resetScheduleOverrideForTest(): void {
  _scheduleOverride = null;
}

function effectiveRetentionSchedule(): Readonly<Record<string, unknown>> {
  return _scheduleOverride ?? (RETENTION_SCHEDULE as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// F-63 — schedule_hash (sorted-keys canonical-JSON, SHA-256 hex).
// ---------------------------------------------------------------------------

function canonicalJsonSortedKeys(obj: Readonly<Record<string, unknown>>): string {
  const sortedKeys = Object.keys(obj).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    canonical[k] = obj[k];
  }
  return JSON.stringify(canonical);
}

/**
 * SHA-256 over the concatenated canonical-JSON of both schedules. Deterministic.
 * Returned as 64-char lowercase hex.
 *
 * F-63: every `retention.deleted` summary row carries this hex; the SQL
 * half of T16.1 stores it on `retention_sweep_runs.schedule_hash` too so the
 * pair joins for the audit-replay use case.
 */
export function computeScheduleHash(): string {
  const r = canonicalJsonSortedKeys(effectiveRetentionSchedule());
  const o = canonicalJsonSortedKeys(
    OPERATIONAL_TABLE_SCHEDULE as unknown as Record<string, unknown>
  );
  return createHash('sha256')
    .update(JSON.stringify({ retention: JSON.parse(r), operational: JSON.parse(o) }))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// F-55 — drift-check helper. CI calls this; library calls it defensively
// before a pass too.
// ---------------------------------------------------------------------------

/**
 * The closed enum lives in `types.ts`; this is the runtime mirror used by
 * the drift-check + the closed-allowlist defensive lookup. Order is
 * irrelevant — every comparison is set-based.
 */
const RETENTION_EVENT_TYPES_RUNTIME: readonly RetentionEventType[] = [
  'alert.fired',
  // M8.B.2 — ADR-0019 §"Optional audit_chain_anchors table".
  'audit.chain_anchor.weekly',
  'audit.forensic_reveal.4eyes_completed',
  'audit.forensic_reveal.4eyes_pending',
  // M8.B.2 — ADR-0019 §3 integrity-check event types.
  'audit.integrity_check.mismatch',
  'audit.integrity_check.ran',
  'auth.passkey.enrolled',
  'auth.passkey.revoked',
  // M8.A.3b — ADR-0018 §"Option H".
  'backup.manifest_written',
  'client.cache_policy_violation',
  'client.identity_selftest_fail',
  'committee.key_rotated',
  'committee_data_key.member_revoked',
  'committee_data_key.rotation.completed',
  'committee_data_key.rotation.started',
  'committee_data_key.unwrap',
  'committee_data_key.wrapped_for_member',
  'concern.created',
  'concern.source_revealed',
  'concern.updated',
  'export.contained_concern_derived_items',
  'export.delivered',
  'export.generated',
  'identity_keypair.created',
  'identity_privkey.recovery_blob.restored',
  'identity_privkey.recovery_blob.viewed',
  'identity_privkey.recovery_blob.written',
  'inspection.synced',
  'member.added',
  'member.removed',
  'photo.sanitize.unsupported_format',
  'queue.integrity_fail',
  'recommendation.created',
  'recommendation.employer_response_logged',
  'recommendation.overdue.alert',
  'reprisal.created',
  'reprisal.read',
  'reprisal.status_changed.4eyes_completed',
  'reprisal.status_changed.4eyes_pending',
  'reprisal.update',
  'retention.deleted',
  's51_evidence.create.rejected',
  's51_evidence.created',
  's51_evidence.read',
  's51_evidence.update',
  'sensitive.access_attempt',
  'session.revoked',
  'work_refusal.created',
  'work_refusal.read',
  'work_refusal.update'
];

export interface ScheduleDriftVerdict {
  readonly ok: boolean;
  readonly missing_schedule_for: readonly string[];
  readonly orphan_schedule_entries: readonly string[];
}

/**
 * Set-equality check between the enum and the (possibly-overridden) schedule.
 * Returns a structured verdict whose error list names the drifted keys so
 * CI can print a useful diagnostic.
 */
export function runScheduleDriftCheck(): ScheduleDriftVerdict {
  const scheduleKeys = new Set(Object.keys(effectiveRetentionSchedule()));
  const enumKeys = new Set<string>(RETENTION_EVENT_TYPES_RUNTIME);
  const missing_schedule_for: string[] = [];
  for (const e of enumKeys) {
    if (!scheduleKeys.has(e)) missing_schedule_for.push(e);
  }
  const orphan_schedule_entries: string[] = [];
  for (const s of scheduleKeys) {
    if (!enumKeys.has(s)) orphan_schedule_entries.push(s);
  }
  return {
    ok: missing_schedule_for.length === 0 && orphan_schedule_entries.length === 0,
    missing_schedule_for,
    orphan_schedule_entries
  };
}

/**
 * Closed-allowlist defensive lookup. Returns the schedule entry for an
 * event_type or throws a structured `closed enum` error if the value is
 * outside the closed set (F-19/F-55 defense-in-depth).
 */
export function getRetentionScheduleEntry(et: RetentionEventType): RetentionScheduleEntry {
  const entry = (RETENTION_SCHEDULE as Record<string, unknown>)[et] as
    | RetentionScheduleEntry
    | undefined;
  if (entry === undefined) {
    throw new Error(`event_type outside closed enum: ${et}`);
  }
  return entry;
}

/** Compile-time exhaustiveness anchor. Calling this with `et: never` is the
 *  closed-switch terminator pattern. */
export function __assertEventTypeExhaustive(et: never): never {
  throw new Error(`closed enum exhausted by unexpected value: ${String(et)}`);
}

/** Read-only access to the runtime enum list (used by the library's
 *  candidate-iteration loop). */
export function listRetentionEventTypes(): readonly RetentionEventType[] {
  return RETENTION_EVENT_TYPES_RUNTIME;
}
