/**
 * Retention library types (T16; library-only per ADR-0002 Amendment H).
 *
 * Closed enum + discriminated unions per ADR-0017 §2/§3/§6/§7. The library
 * never accepts a caller-supplied predicate or WHERE clause; the closed
 * allowlist + the discriminator on the schedule entry are the only inputs
 * that drive a delete (F-19/F-64 lineage).
 *
 * Source obligations (threat-model §3.9):
 *   F-55, F-56, F-57, F-58, F-59, F-60, F-61, F-62, F-63, F-64, F-65, F-66,
 *   F-67, F-68, F-69.
 */

/**
 * Closed `RetentionEventType` enum — verbatim from ADR-0017 §2.
 *
 * Adding an event type to the system requires a paired entry in
 * `RETENTION_SCHEDULE` (CI drift assertion: F-55).
 */
export type RetentionEventType =
  | 'alert.fired'
  | 'audit.forensic_reveal.4eyes_completed'
  | 'audit.forensic_reveal.4eyes_pending'
  | 'auth.passkey.enrolled'
  | 'auth.passkey.revoked'
  | 'client.cache_policy_violation'
  | 'client.identity_selftest_fail'
  | 'committee.key_rotated'
  | 'committee_data_key.member_revoked'
  | 'committee_data_key.rotation.completed'
  | 'committee_data_key.rotation.started'
  | 'committee_data_key.unwrap'
  | 'committee_data_key.wrapped_for_member'
  | 'concern.created'
  | 'concern.source_revealed'
  | 'concern.updated'
  | 'export.contained_concern_derived_items'
  | 'export.delivered'
  | 'export.generated'
  | 'identity_keypair.created'
  | 'identity_privkey.recovery_blob.restored'
  | 'identity_privkey.recovery_blob.viewed'
  | 'identity_privkey.recovery_blob.written'
  | 'inspection.synced'
  | 'member.added'
  | 'member.removed'
  | 'photo.sanitize.unsupported_format'
  | 'queue.integrity_fail'
  | 'recommendation.created'
  | 'recommendation.employer_response_logged'
  | 'recommendation.overdue.alert'
  | 'reprisal.created'
  | 'reprisal.read'
  | 'reprisal.status_changed.4eyes_completed'
  | 'reprisal.status_changed.4eyes_pending'
  | 'reprisal.update'
  | 'retention.deleted'
  | 's51_evidence.create.rejected'
  | 's51_evidence.created'
  | 's51_evidence.read'
  | 's51_evidence.update'
  | 'sensitive.access_attempt'
  | 'session.revoked'
  | 'work_refusal.created'
  | 'work_refusal.read'
  | 'work_refusal.update';

/**
 * Schedule entry discriminator (ADR-0017 §3).
 *
 * `retention.deleted` is fixed-years/7y + structural `no_target_id` carve-
 * out (F-62). `export.generated` is fixed-years/7y immutable (F-68; RA-1 #5).
 */
export type RetentionScheduleEntry =
  | { readonly kind: 'fixed_days'; readonly days: number }
  | { readonly kind: 'fixed_months'; readonly months: number }
  | { readonly kind: 'fixed_years'; readonly years: number; readonly no_target_id?: boolean }
  | { readonly kind: 'membership_plus_months'; readonly months: number }
  | { readonly kind: 'membership_plus_years'; readonly years: number }
  | { readonly kind: 'years_from_rotation'; readonly years: number }
  | { readonly kind: 'match_underlying' };

/**
 * Schedule entry for an operational (non-audit) table (ADR-0016 mirror).
 */
export type OperationalTableScheduleEntry =
  | { readonly kind: 'fixed_hours'; readonly hours: number }
  | { readonly kind: 'fixed_days'; readonly days: number };

/**
 * Pass-level configuration consumed by `runRetentionPass`.
 *
 * Every defaulted field has a closed allowlist semantic; there is no
 * caller-supplied WHERE / predicate / filter (F-64).
 *
 * Note: `confirmOverDeleteThreshold` is intentionally camelCase to match
 * the test contract (ADR-0017 acceptance criteria, test-writer §1).
 */
export interface RetentionPassConfig {
  /** Default: false (dry-run posture is the CI default per F-57). */
  readonly dry_run?: boolean;
  /** Default: 20 rows (F-57). */
  readonly alarm_threshold?: number;
  /** Default: false. Set true to proceed past the alarm threshold (F-57). */
  readonly confirmOverDeleteThreshold?: boolean;
  /** Default: 20000 rows (F-60). */
  readonly max_total_rows_per_pass?: number;
  /** Default: 5 minutes (F-59). */
  readonly lease_window_ms?: number;
}

/**
 * Result discriminated union (F-65; load-bearing keys pinned by tests).
 */
export type RetentionPassResult =
  | {
      readonly status: 'completed';
      readonly run_id: string;
      readonly alarm_fired: boolean;
      readonly deleted_total: number;
    }
  | {
      readonly status: 'capped';
      readonly run_id: string;
      readonly alarm_fired: boolean;
      readonly deleted_total: number;
      readonly truncated_to_row_cap: true;
    }
  | {
      readonly status: 'aborted_over_delete_threshold';
      readonly run_id: string;
      readonly alarm_fired: true;
      readonly would_delete_total: number;
    }
  | {
      readonly status: 'errored';
      readonly run_id: string;
      readonly error_code: 'audit_emit_failed';
    }
  | {
      readonly status: 'skipped';
      readonly reason: 'pass_already_in_window';
    };

/** Default values pulled out so neither magic numbers nor inline literals
 *  appear in the algorithm body. */
export const DEFAULT_ALARM_THRESHOLD = 20;
export const DEFAULT_MAX_TOTAL_ROWS_PER_PASS = 20000;
export const DEFAULT_LEASE_WINDOW_MS = 5 * 60 * 1000;
/** F-66 — clock floor for monotonic nowMs() advance per call. */
export const NOW_MS_MIN_INCREMENT = 1;
/** F-61 — underlying-record-ceiling buffer (ADR-0015 §3.5). */
export const UNDERLYING_RECORD_CEILING_DAYS = 30;
/** Days-per-year used by `fixed_years` cutoff arithmetic. */
export const DAYS_PER_YEAR_FOR_CUTOFF = 365.25;
/** Days-per-month used by `fixed_months` cutoff arithmetic. */
export const DAYS_PER_MONTH_FOR_CUTOFF = 30;

/** ms constants for cutoff arithmetic (no magic numbers in core). */
export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
