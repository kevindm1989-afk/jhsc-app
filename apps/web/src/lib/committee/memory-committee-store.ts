/**
 * In-memory implementation of CommitteeStore (T06).
 *
 * Mirrors the SQL semantics that will ship in T06.1 (the migration is
 * deferred per ADR-0002 Amendment H / ADR-0021). Deterministic: every
 * mutation is synchronous on the JS event loop (vitest singleThread).
 *
 * Pseudonymisation: HMAC-SHA-256 keyed by a per-store random key OR a
 * caller-supplied shared key — same approach as MemoryConcernStore /
 * MemoryAuthStore (ADR-0016 §Decision 1).
 */

import { createHmac, randomBytes } from 'node:crypto';
import type { CommitteeAuditEmission, CommitteeStore } from './committee-store';
import type {
  CommitteeAuditEvent,
  CommitteeMembershipRow,
  CommitteeRole,
  MemberInvite
} from './types';

interface AuditRow {
  id: number;
  ts: string;
  event_type: CommitteeAuditEvent;
  actor_pseudonym: string;
  target_pseudonym: string;
  request_id: string | null;
  meta: Record<string, unknown>;
}

export class MemoryCommitteeStore implements CommitteeStore {
  private memberships = new Map<string, CommitteeMembershipRow>();
  private invites = new Map<string, MemberInvite>();
  private roleMirror = new Map<string, CommitteeRole | null>();
  private auditRows: AuditRow[] = [];
  private auditSeq = 0;

  private hmacKey: Buffer;

  constructor(hmacKey?: Buffer) {
    this.hmacKey = hmacKey ?? randomBytes(32);
  }

  pseudonymOf(uid: string): string {
    return createHmac('sha256', this.hmacKey).update(uid).digest('hex').slice(0, 16);
  }

  async isActiveMember(user_id: string): Promise<boolean> {
    return this.memberships.get(user_id)?.active === true;
  }

  async getMembership(user_id: string): Promise<CommitteeMembershipRow | null> {
    const row = this.memberships.get(user_id);
    return row ? { ...row, roles: [...row.roles] } : null;
  }

  async listMemberships(): Promise<CommitteeMembershipRow[]> {
    return [...this.memberships.values()].map((r) => ({ ...r, roles: [...r.roles] }));
  }

  async countActiveCoChairs(): Promise<number> {
    let n = 0;
    for (const r of this.memberships.values()) {
      if (r.active && r.roles.includes('worker_co_chair')) n += 1;
    }
    return n;
  }

  async createMembership(row: CommitteeMembershipRow): Promise<void> {
    this.memberships.set(row.user_id, { ...row, roles: [...row.roles] });
  }

  async setActive(opts: {
    user_id: string;
    active: boolean;
    grace_until: number | null;
    at: number;
  }): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
    const row = this.memberships.get(opts.user_id);
    if (!row) return { ok: false, reason: 'not_found' };
    row.active = opts.active;
    row.grace_until = opts.grace_until;
    if (opts.active) row.activated_at = opts.at;
    else row.deactivated_at = opts.at;
    return { ok: true };
  }

  async setRoles(opts: {
    user_id: string;
    roles: CommitteeRole[];
  }): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
    const row = this.memberships.get(opts.user_id);
    if (!row) return { ok: false, reason: 'not_found' };
    row.roles = [...opts.roles];
    return { ok: true };
  }

  async issueInvite(invite: MemberInvite): Promise<void> {
    this.invites.set(invite.invite_id, { ...invite });
  }

  async getInvite(invite_id: string): Promise<MemberInvite | null> {
    const inv = this.invites.get(invite_id);
    return inv ? { ...inv } : null;
  }

  async markInviteConsumed(invite_id: string, at: number): Promise<void> {
    const inv = this.invites.get(invite_id);
    if (inv) inv.consumed_at = at;
  }

  async setUserRoleMirror(user_id: string, role: CommitteeRole | null): Promise<void> {
    this.roleMirror.set(user_id, role);
  }

  async getUserRoleMirror(user_id: string): Promise<CommitteeRole | null> {
    return this.roleMirror.get(user_id) ?? null;
  }

  async recordCommitteeEvent(event: CommitteeAuditEmission): Promise<void> {
    this.auditSeq += 1;
    this.auditRows.push({
      id: this.auditSeq,
      ts: new Date().toISOString(),
      event_type: event.event_type,
      actor_pseudonym: event.actor_pseudonym,
      target_pseudonym: event.target_pseudonym,
      request_id: event.request_id ?? null,
      meta: event.meta
    });
  }

  // -------- test-only inspectors --------
  __debugAuditRows(): readonly AuditRow[] {
    return this.auditRows;
  }
}
