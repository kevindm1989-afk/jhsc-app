/**
 * Committee membership types (T06).
 *
 * Source obligations:
 *   - ADR-0021 — committee membership + roles + invite (library-only, Amendment H).
 *   - JHSC-APP-PLAN.md §2.1 — roles are a SET, not a tier; a person may hold several.
 *   - observability/audit-log.md §1 — `member.added`, `member.removed`,
 *     `member.role_changed` (the last reserved by ADR-0021; SQL CHECK +
 *     retention-schedule half lands in T06.1).
 *
 * Per ADR-0002 Amendment H this file ships in T06 (library only). The
 * `committee_membership` migration + RLS + `SupabaseCommitteeStore` land in
 * T06.1 (sibling task). Shape mirrors the T08 ConcernStore split:
 *   - persistent rows typed here;
 *   - `CommitteeStore` is the persistence boundary;
 *   - `MemoryCommitteeStore` satisfies it for tests;
 *   - production `SupabaseCommitteeStore` ships in T06.1.
 */

/** Worker-side roles. A membership holds a SET of these (ADR-0021 driver 2). */
export type CommitteeRole = 'worker_member' | 'worker_co_chair' | 'certified_member';

export const COMMITTEE_ROLES: readonly CommitteeRole[] = [
  'worker_member',
  'worker_co_chair',
  'certified_member'
] as const;

/**
 * Closed audit enum for committee membership ops (ADR-0003 Amendment A).
 * `member.role_changed` is reserved by ADR-0021 — the TS const + audit-log.md
 * + enum-coverage script land in T06; the SQL CHECK + retention-schedule row
 * land in T06.1.
 */
export type CommitteeAuditEvent = 'member.added' | 'member.removed' | 'member.role_changed';

export const COMMITTEE_AUDIT_EVENTS: readonly CommitteeAuditEvent[] = [
  'member.added',
  'member.removed',
  'member.role_changed'
] as const;

/**
 * Committee membership row. Single-tenant by construction — there is no
 * per-committee identifier column or parameter (a CI test asserts that
 * literal is absent from lib/committee/).
 */
export interface CommitteeMembershipRow {
  user_id: string;
  /** Role SET — stored sorted + de-duplicated. */
  roles: CommitteeRole[];
  active: boolean;
  /** C2 PI — added to `users` in T06.1; modeled here for the library. */
  display_name: string | null;
  /** C2 PI — off-employer email/phone; employer-domain emails rejected on entry. */
  off_employer_contact: string | null;
  invited_by: string | null;
  invited_at: number | null;
  activated_at: number | null;
  deactivated_at: number | null;
  /**
   * ms-epoch; set on removal. The T07 committee-key-destroy ripple waits
   * until the clock is past this before excluding the member from rotation.
   */
  grace_until: number | null;
}

/** A one-time invite. Production binds this to a T05 `auth_totp_bootstraps` row. */
export interface MemberInvite {
  invite_id: string;
  target_user_id: string;
  issued_by: string;
  issued_at: number;
  expires_at: number;
  consumed_at: number | null;
}
