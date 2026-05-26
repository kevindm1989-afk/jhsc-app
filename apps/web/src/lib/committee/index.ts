/**
 * Committee membership library (T06).
 *
 * Per ADR-0002 Amendment H / ADR-0021 this module ships library code only:
 *   - Types + CommitteeStore interface
 *   - MemoryCommitteeStore (test wiring)
 *   - inviteMember / activateMembership / setRoles / removeMember / reactivateMember
 *
 * The SupabaseCommitteeStore + the `committee_membership` migration + RLS
 * land in T06.1 (sibling task).
 */

export type {
  CommitteeAuditEvent,
  CommitteeMembershipRow,
  CommitteeRole,
  MemberInvite
} from './types';
export { COMMITTEE_AUDIT_EVENTS, COMMITTEE_ROLES } from './types';
export type { CommitteeAuditEmission, CommitteeStore } from './committee-store';
export { MemoryCommitteeStore } from './memory-committee-store';
export {
  activateMembership,
  inviteMember,
  reactivateMember,
  removeMember,
  setRoles,
  REMOVAL_GRACE_MS
} from './committee-core';
export type { CommitteeCoreOpts, CommitteeDenied, CommitteeDenyReason } from './committee-core';
