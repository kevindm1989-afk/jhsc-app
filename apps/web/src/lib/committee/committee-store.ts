/**
 * CommitteeStore — persistence boundary for T06, mirroring T08's ConcernStore.
 *
 * Per ADR-0002 Amendment H this is library code; the SupabaseCommitteeStore +
 * the `committee_membership` migration land in T06.1. RLS semantics are
 * mirrored at the interface (the core returns `{ ok: false, reason }` rather
 * than throwing); the production store maps Postgres RLS failures (42501)
 * onto the same shape.
 *
 * Audit emissions use the closed enum in `types.ts` via `recordCommitteeEvent`
 * — never a raw `audit_emit(` literal (keeps the call-site coverage gate
 * clean). Actor + target are pseudonymised (no raw user_id in audit rows,
 * per observability/logging.md §2 / ADR-0016).
 */

import type {
  CommitteeAuditEvent,
  CommitteeMembershipRow,
  CommitteeRole,
  MemberInvite
} from './types';

export interface CommitteeAuditEmission {
  event_type: CommitteeAuditEvent;
  actor_pseudonym: string;
  /** HMAC pseudonym of the member the event is about (never the raw user_id). */
  target_pseudonym: string;
  meta: Record<string, unknown>;
  request_id?: string | null;
}

export interface CommitteeStore {
  // ---- RLS / membership reads ----
  /** Mirrors `is_active_member(uid)` from the T06.1 SQL migration (the T08 contract). */
  isActiveMember(user_id: string): Promise<boolean>;
  getMembership(user_id: string): Promise<CommitteeMembershipRow | null>;
  listMemberships(): Promise<CommitteeMembershipRow[]>;
  /** Count of currently-active members holding `worker_co_chair`. */
  countActiveCoChairs(): Promise<number>;

  // ---- Membership mutations ----
  createMembership(row: CommitteeMembershipRow): Promise<void>;
  setActive(opts: {
    user_id: string;
    active: boolean;
    grace_until: number | null;
    at: number;
  }): Promise<{ ok: true } | { ok: false; reason: 'not_found' }>;
  setRoles(opts: {
    user_id: string;
    roles: CommitteeRole[];
  }): Promise<{ ok: true } | { ok: false; reason: 'not_found' }>;

  // ---- Invites ----
  issueInvite(invite: MemberInvite): Promise<void>;
  getInvite(invite_id: string): Promise<MemberInvite | null>;
  markInviteConsumed(invite_id: string, at: number): Promise<void>;

  // ---- T05 auth-mirror reconciliation (users.role) ----
  /**
   * Reconcile the single-valued T05 `users.role` enum to a representative
   * role derived from the authoritative `committee_membership.role[]` set
   * (ADR-0021 driver 2). `null` clears the mirror (member removed).
   */
  setUserRoleMirror(user_id: string, role: CommitteeRole | null): Promise<void>;
  getUserRoleMirror(user_id: string): Promise<CommitteeRole | null>;

  // ---- Audit ----
  recordCommitteeEvent(event: CommitteeAuditEmission): Promise<void>;

  // ---- Helpers ----
  pseudonymOf(uid: string): string;
}

export type { CommitteeMembershipRow, MemberInvite };
