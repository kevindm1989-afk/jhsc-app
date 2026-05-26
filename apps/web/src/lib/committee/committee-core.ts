/**
 * Committee membership operations (T06).
 *
 * Per ADR-0002 Amendment H this is library code; the store is injected
 * (`MemoryCommitteeStore` in tests, `SupabaseCommitteeStore` (T06.1) in
 * production). Operations:
 *   - `inviteMember`       — co-chair-gated; creates a pending membership + invite
 *   - `activateMembership` — consume invite, activate, emit `member.added`
 *   - `setRoles`           — co-chair-gated; emit `member.role_changed`
 *   - `removeMember`       — co-chair-gated; mark inactive + grace; emit `member.removed`
 *   - `reactivateMember`   — co-chair-gated; re-activate within grace
 *
 * Invariants enforced (ADR-0021):
 *   - role mutations + invites require an ACTIVE worker_co_chair actor (RLS mirror);
 *   - a co-chair demoting/removing THEMSELVES needs a second active co-chair (4-eyes);
 *   - the LAST active co-chair cannot be demoted/removed (always ≥1 co-chair);
 *   - off_employer_contact emails on an employer domain are rejected;
 *   - roles are a de-duplicated SET; users.role auth mirror is reconciled.
 *
 * Source: ADR-0021 + JHSC-APP-PLAN.md §2.1 + observability/audit-log.md §1.
 */

import { randomUUID } from 'node:crypto';
import type { CommitteeStore } from './committee-store';
import { COMMITTEE_ROLES, type CommitteeMembershipRow, type CommitteeRole } from './types';

/** 90-day removal grace before the T07 key-destroy ripple (ADR-0021 §Decision 2). */
export const REMOVAL_GRACE_MS = 90 * 24 * 60 * 60 * 1000;
/** Default invite lifetime (7 days). */
const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CommitteeCoreOpts {
  store: CommitteeStore;
  now: () => number;
  /** Employer-controlled domains; off_employer_contact emails on these are rejected. */
  employerDomains?: string[];
  inviteTtlMs?: number;
}

export type CommitteeDenyReason =
  | 'rls_denied'
  | '4eyes_required'
  | 'last_co_chair'
  | 'invalid_role'
  | 'employer_contact_rejected'
  | 'not_found'
  | 'invite_invalid'
  | 'already_active';

export interface CommitteeDenied {
  ok: false;
  reason: CommitteeDenyReason;
  /** HTTP-shaped status for the route-mapper. Bodies carry NO PI. */
  status: 403 | 404 | 409 | 422;
  body: Record<string, unknown>;
}

const ROLE_PRECEDENCE: CommitteeRole[] = ['worker_co_chair', 'certified_member', 'worker_member'];

function deny(reason: CommitteeDenyReason, status: CommitteeDenied['status']): CommitteeDenied {
  return { ok: false, reason, status, body: { error: reason } };
}

/** De-duplicate, validate, and sort a role set. Returns null if any role is invalid or empty. */
function normalizeRoles(roles: CommitteeRole[]): CommitteeRole[] | null {
  if (!Array.isArray(roles) || roles.length === 0) return null;
  const set = new Set<CommitteeRole>();
  for (const r of roles) {
    if (!COMMITTEE_ROLES.includes(r)) return null;
    set.add(r);
  }
  return COMMITTEE_ROLES.filter((r) => set.has(r));
}

/** Representative single role for the T05 users.role auth mirror. */
function primaryRole(roles: CommitteeRole[]): CommitteeRole {
  for (const r of ROLE_PRECEDENCE) if (roles.includes(r)) return r;
  return roles[0] ?? 'worker_member';
}

/** Employer-domain rejection for off_employer_contact. Phones (no `@`) pass. */
function isEmployerContact(contact: string, employerDomains: string[]): boolean {
  const at = contact.lastIndexOf('@');
  if (at < 0) return false;
  const domain = contact
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return employerDomains.some((d) => d.trim().toLowerCase() === domain);
}

async function actorIsActiveCoChair(store: CommitteeStore, user_id: string): Promise<boolean> {
  const m = await store.getMembership(user_id);
  return !!m && m.active && m.roles.includes('worker_co_chair');
}

/** Invite a new member (pending until they complete enrollment). Co-chair-gated. */
export async function inviteMember(
  core: CommitteeCoreOpts,
  actor: { user_id: string },
  opts: {
    target_user_id: string;
    roles: CommitteeRole[];
    display_name?: string | null;
    off_employer_contact?: string | null;
  }
): Promise<{ ok: true; invite_id: string } | CommitteeDenied> {
  const { store, now } = core;
  if (!(await actorIsActiveCoChair(store, actor.user_id))) return deny('rls_denied', 403);

  const roles = normalizeRoles(opts.roles);
  if (!roles) return deny('invalid_role', 422);

  const contact = opts.off_employer_contact ?? null;
  if (contact && isEmployerContact(contact, core.employerDomains ?? [])) {
    return deny('employer_contact_rejected', 422);
  }

  const existing = await store.getMembership(opts.target_user_id);
  if (existing && existing.active) return deny('already_active', 409);

  const t = now();
  const membership: CommitteeMembershipRow = {
    user_id: opts.target_user_id,
    roles,
    active: false,
    display_name: opts.display_name ?? null,
    off_employer_contact: contact,
    invited_by: actor.user_id,
    invited_at: t,
    activated_at: null,
    deactivated_at: null,
    grace_until: null
  };
  await store.createMembership(membership);

  const invite_id = randomUUID();
  await store.issueInvite({
    invite_id,
    target_user_id: opts.target_user_id,
    issued_by: actor.user_id,
    issued_at: t,
    expires_at: t + (core.inviteTtlMs ?? DEFAULT_INVITE_TTL_MS),
    consumed_at: null
  });
  // No audit here — `member.added` fires on activation (ADR-0021 §Decision 4).
  return { ok: true, invite_id };
}

/** Consume an invite and activate the membership. Emits `member.added`. */
export async function activateMembership(
  core: CommitteeCoreOpts,
  opts: { invite_id: string }
): Promise<{ ok: true; user_id: string } | CommitteeDenied> {
  const { store, now } = core;
  const t = now();

  const invite = await store.getInvite(opts.invite_id);
  if (!invite || invite.consumed_at !== null || invite.expires_at < t) {
    return deny('invite_invalid', 422);
  }
  const membership = await store.getMembership(invite.target_user_id);
  if (!membership) return deny('not_found', 404);
  if (membership.active) return deny('already_active', 409);

  await store.setActive({ user_id: invite.target_user_id, active: true, grace_until: null, at: t });
  await store.markInviteConsumed(opts.invite_id, t);
  await store.setUserRoleMirror(invite.target_user_id, primaryRole(membership.roles));

  await store.recordCommitteeEvent({
    event_type: 'member.added',
    actor_pseudonym: store.pseudonymOf(invite.issued_by),
    target_pseudonym: store.pseudonymOf(invite.target_user_id),
    meta: { roles: membership.roles, invited_by_pseudonym: store.pseudonymOf(invite.issued_by) }
  });
  return { ok: true, user_id: invite.target_user_id };
}

/** Change a member's role SET. Co-chair-gated; emits `member.role_changed`. */
export async function setRoles(
  core: CommitteeCoreOpts,
  actor: { user_id: string },
  target_user_id: string,
  roles: CommitteeRole[],
  opts: { second_approver_id?: string } = {}
): Promise<{ ok: true } | CommitteeDenied> {
  const { store } = core;
  if (!(await actorIsActiveCoChair(store, actor.user_id))) return deny('rls_denied', 403);

  const next = normalizeRoles(roles);
  if (!next) return deny('invalid_role', 422);

  const membership = await store.getMembership(target_user_id);
  if (!membership) return deny('not_found', 404);

  const before = [...membership.roles];
  const losingCoChair =
    before.includes('worker_co_chair') && !next.includes('worker_co_chair') && membership.active;
  if (losingCoChair) {
    if ((await store.countActiveCoChairs()) <= 1) return deny('last_co_chair', 409);
    if (actor.user_id === target_user_id) {
      const seconded = await validSecondApprover(store, opts.second_approver_id, actor.user_id);
      if (!seconded) return deny('4eyes_required', 403);
    }
  }

  await store.setRoles({ user_id: target_user_id, roles: next });
  if (membership.active) await store.setUserRoleMirror(target_user_id, primaryRole(next));

  await store.recordCommitteeEvent({
    event_type: 'member.role_changed',
    actor_pseudonym: store.pseudonymOf(actor.user_id),
    target_pseudonym: store.pseudonymOf(target_user_id),
    meta: { roles_before: before, roles_after: next }
  });
  return { ok: true };
}

/** Remove a member: mark inactive + set the 90-day grace. Emits `member.removed`. */
export async function removeMember(
  core: CommitteeCoreOpts,
  actor: { user_id: string },
  target_user_id: string,
  opts: { second_approver_id?: string } = {}
): Promise<{ ok: true; grace_until: number } | CommitteeDenied> {
  const { store, now } = core;
  if (!(await actorIsActiveCoChair(store, actor.user_id))) return deny('rls_denied', 403);

  const membership = await store.getMembership(target_user_id);
  if (!membership) return deny('not_found', 404);
  // Idempotent: already-removed members return their existing grace, no new audit.
  if (!membership.active) return { ok: true, grace_until: membership.grace_until ?? now() };

  if (membership.roles.includes('worker_co_chair')) {
    if ((await store.countActiveCoChairs()) <= 1) return deny('last_co_chair', 409);
    if (actor.user_id === target_user_id) {
      const seconded = await validSecondApprover(store, opts.second_approver_id, actor.user_id);
      if (!seconded) return deny('4eyes_required', 403);
    }
  }

  const grace_until = now() + REMOVAL_GRACE_MS;
  await store.setActive({ user_id: target_user_id, active: false, grace_until, at: now() });
  await store.setUserRoleMirror(target_user_id, null);

  await store.recordCommitteeEvent({
    event_type: 'member.removed',
    actor_pseudonym: store.pseudonymOf(actor.user_id),
    target_pseudonym: store.pseudonymOf(target_user_id),
    meta: { grace_until }
  });
  return { ok: true, grace_until };
}

/** Re-activate a removed member (within or after grace). Emits `member.added`. */
export async function reactivateMember(
  core: CommitteeCoreOpts,
  actor: { user_id: string },
  target_user_id: string
): Promise<{ ok: true } | CommitteeDenied> {
  const { store, now } = core;
  if (!(await actorIsActiveCoChair(store, actor.user_id))) return deny('rls_denied', 403);

  const membership = await store.getMembership(target_user_id);
  if (!membership) return deny('not_found', 404);
  if (membership.active) return deny('already_active', 409);

  await store.setActive({ user_id: target_user_id, active: true, grace_until: null, at: now() });
  await store.setUserRoleMirror(target_user_id, primaryRole(membership.roles));

  await store.recordCommitteeEvent({
    event_type: 'member.added',
    actor_pseudonym: store.pseudonymOf(actor.user_id),
    target_pseudonym: store.pseudonymOf(target_user_id),
    meta: { roles: membership.roles, reactivated: true }
  });
  return { ok: true };
}

async function validSecondApprover(
  store: CommitteeStore,
  second_approver_id: string | undefined,
  actor_id: string
): Promise<boolean> {
  if (!second_approver_id || second_approver_id === actor_id) return false;
  return actorIsActiveCoChair(store, second_approver_id);
}
