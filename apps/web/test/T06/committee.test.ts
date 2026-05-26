/**
 * T06 — committee membership + roles + invite (library-only).
 *
 * Covers ADR-0021:
 *   - co-chair-gated invite → activation → `member.added`;
 *   - role[] is an authoritative, de-duplicated SET; users.role mirror reconciled;
 *   - `setRoles` co-chair-gated → `member.role_changed`;
 *   - removal marks inactive + 90-day grace → `member.removed`;
 *   - last-co-chair protection + 4-eyes co-chair self-demotion/removal;
 *   - off_employer_contact employer-domain rejection;
 *   - single-tenant (no `committee_id` anywhere in lib/committee/);
 *   - audit events stay within the closed enum.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { WEB_ROOT } from '../_helpers/paths';
import {
  MemoryCommitteeStore,
  activateMembership,
  inviteMember,
  reactivateMember,
  removeMember,
  setRoles,
  COMMITTEE_AUDIT_EVENTS,
  REMOVAL_GRACE_MS,
  type CommitteeCoreOpts
} from '../../src/lib/committee';

const FOUNDER = 'user-cochair-1';
const COCHAIR2 = 'user-cochair-2';
const INVITEE = 'user-invitee-1';

let clock: number;
let store: MemoryCommitteeStore;
let core: CommitteeCoreOpts;

function tick(ms = 1) {
  clock += ms;
}

beforeEach(async () => {
  clock = 1_000_000;
  store = new MemoryCommitteeStore();
  core = { store, now: () => clock, employerDomains: ['employer.example'] };
  // Seed a founding active co-chair directly (the bootstrap co-chair predates
  // the invite flow; in production this is the first enrolled member).
  await store.createMembership({
    user_id: FOUNDER,
    roles: ['worker_member', 'worker_co_chair'],
    active: true,
    display_name: null,
    off_employer_contact: null,
    invited_by: null,
    invited_at: clock,
    activated_at: clock,
    deactivated_at: null,
    grace_until: null
  });
});

async function inviteAndActivate(
  target: string,
  roles: Parameters<typeof inviteMember>[2]['roles'],
  extra: { off_employer_contact?: string | null } = {}
) {
  const inv = await inviteMember(core, { user_id: FOUNDER }, {
    target_user_id: target,
    roles,
    ...extra
  });
  if (inv.ok === false) return inv;
  return activateMembership(core, { invite_id: inv.invite_id });
}

describe('T06 / invite + activation', () => {
  it('co-chair invites, member activates, emits member.added and becomes active', async () => {
    const res = await inviteAndActivate(INVITEE, ['worker_member']);
    expect(res.ok).toBe(true);
    expect(await store.isActiveMember(INVITEE)).toBe(true);
    const rows = store.__debugAuditRows();
    expect(rows.map((r) => r.event_type)).toEqual(['member.added']);
    // No raw user_id in the audit row — target is pseudonymised.
    expect(JSON.stringify(rows[0])).not.toContain(INVITEE);
    expect(rows[0].target_pseudonym).toBe(store.pseudonymOf(INVITEE));
  });

  it('a non-co-chair cannot invite (rls_denied)', async () => {
    await inviteAndActivate(INVITEE, ['worker_member']);
    const res = await inviteMember(core, { user_id: INVITEE }, {
      target_user_id: 'user-x',
      roles: ['worker_member']
    });
    expect(res).toMatchObject({ ok: false, reason: 'rls_denied', status: 403 });
    if (res.ok === false) expect(res.body).toEqual({ error: 'rls_denied' }); // no PI in body
  });

  it('rejects an off_employer_contact on an employer domain', async () => {
    const res = await inviteMember(core, { user_id: FOUNDER }, {
      target_user_id: INVITEE,
      roles: ['worker_member'],
      off_employer_contact: 'worker@employer.example'
    });
    expect(res).toMatchObject({ ok: false, reason: 'employer_contact_rejected', status: 422 });
  });

  it('accepts a non-employer email and a phone number', async () => {
    const a = await inviteMember(core, { user_id: FOUNDER }, {
      target_user_id: INVITEE,
      roles: ['worker_member'],
      off_employer_contact: 'me@personal.example'
    });
    expect(a.ok).toBe(true);
    const b = await inviteMember(core, { user_id: FOUNDER }, {
      target_user_id: 'user-phone',
      roles: ['worker_member'],
      off_employer_contact: '+1-555-0100'
    });
    expect(b.ok).toBe(true);
  });

  it('rejects an invalid role and an empty role set', async () => {
    const bad = await inviteMember(core, { user_id: FOUNDER }, {
      target_user_id: INVITEE,
      // @ts-expect-error — deliberately invalid role
      roles: ['supervisor']
    });
    expect(bad).toMatchObject({ ok: false, reason: 'invalid_role' });
    const empty = await inviteMember(core, { user_id: FOUNDER }, {
      target_user_id: INVITEE,
      roles: []
    });
    expect(empty).toMatchObject({ ok: false, reason: 'invalid_role' });
  });

  it('an expired invite cannot be activated', async () => {
    const inv = await inviteMember(core, { user_id: FOUNDER }, {
      target_user_id: INVITEE,
      roles: ['worker_member']
    });
    if (inv.ok === false) throw new Error('invite failed');
    clock += REMOVAL_GRACE_MS; // far beyond the 7-day TTL
    const res = await activateMembership(core, { invite_id: inv.invite_id });
    expect(res).toMatchObject({ ok: false, reason: 'invite_invalid' });
    expect(await store.isActiveMember(INVITEE)).toBe(false);
  });

  it('an invite cannot be consumed twice', async () => {
    const inv = await inviteMember(core, { user_id: FOUNDER }, {
      target_user_id: INVITEE,
      roles: ['worker_member']
    });
    if (inv.ok === false) throw new Error('invite failed');
    expect((await activateMembership(core, { invite_id: inv.invite_id })).ok).toBe(true);
    const second = await activateMembership(core, { invite_id: inv.invite_id });
    expect(second).toMatchObject({ ok: false, reason: 'invite_invalid' });
  });
});

describe('T06 / roles as a set + auth mirror', () => {
  it('de-duplicates the role set and reconciles users.role to the highest-precedence role', async () => {
    await inviteAndActivate(INVITEE, ['worker_member']);
    const res = await setRoles(core, { user_id: FOUNDER }, INVITEE, [
      'worker_member',
      'certified_member',
      'worker_member'
    ]);
    expect(res.ok).toBe(true);
    const m = await store.getMembership(INVITEE);
    expect(m?.roles).toEqual(['worker_member', 'certified_member']); // sorted, unique
    // certified_member outranks worker_member for the single-valued mirror.
    expect(await store.getUserRoleMirror(INVITEE)).toBe('certified_member');
    const rows = store.__debugAuditRows();
    expect(rows.at(-1)?.event_type).toBe('member.role_changed');
    expect(rows.at(-1)?.meta).toMatchObject({
      roles_before: ['worker_member'],
      roles_after: ['worker_member', 'certified_member']
    });
  });

  it('setRoles by a non-co-chair is rls_denied', async () => {
    await inviteAndActivate(INVITEE, ['worker_member']);
    const res = await setRoles(core, { user_id: INVITEE }, FOUNDER, ['worker_member']);
    expect(res).toMatchObject({ ok: false, reason: 'rls_denied' });
  });
});

describe('T06 / removal + grace + key-rotation ripple hook', () => {
  it('removal marks inactive, sets a 90-day grace, clears the mirror, emits member.removed', async () => {
    await inviteAndActivate(INVITEE, ['worker_member']);
    const before = clock;
    const res = await removeMember(core, { user_id: FOUNDER }, INVITEE);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.grace_until).toBe(before + REMOVAL_GRACE_MS);
    expect(await store.isActiveMember(INVITEE)).toBe(false);
    expect(await store.getUserRoleMirror(INVITEE)).toBeNull();
    expect(store.__debugAuditRows().at(-1)?.event_type).toBe('member.removed');
  });

  it('removal is idempotent (no second audit row)', async () => {
    await inviteAndActivate(INVITEE, ['worker_member']);
    await removeMember(core, { user_id: FOUNDER }, INVITEE);
    const n = store.__debugAuditRows().length;
    const again = await removeMember(core, { user_id: FOUNDER }, INVITEE);
    expect(again.ok).toBe(true);
    expect(store.__debugAuditRows().length).toBe(n);
  });

  it('a removed member can be reactivated (member.added, mirror restored)', async () => {
    await inviteAndActivate(INVITEE, ['certified_member']);
    await removeMember(core, { user_id: FOUNDER }, INVITEE);
    tick();
    const res = await reactivateMember(core, { user_id: FOUNDER }, INVITEE);
    expect(res.ok).toBe(true);
    expect(await store.isActiveMember(INVITEE)).toBe(true);
    expect(await store.getUserRoleMirror(INVITEE)).toBe('certified_member');
    expect(store.__debugAuditRows().at(-1)?.event_type).toBe('member.added');
  });
});

describe('T06 / co-chair protections (last-co-chair + 4-eyes)', () => {
  it('the last active co-chair cannot be removed', async () => {
    const res = await removeMember(core, { user_id: FOUNDER }, FOUNDER);
    expect(res).toMatchObject({ ok: false, reason: 'last_co_chair', status: 409 });
    expect(await store.isActiveMember(FOUNDER)).toBe(true);
  });

  it('the last active co-chair cannot be demoted out of worker_co_chair', async () => {
    const res = await setRoles(core, { user_id: FOUNDER }, FOUNDER, ['worker_member']);
    expect(res).toMatchObject({ ok: false, reason: 'last_co_chair' });
  });

  it('a co-chair self-removal requires a second co-chair (4-eyes)', async () => {
    // Add a second co-chair so the last-co-chair guard does not pre-empt.
    await inviteAndActivate(COCHAIR2, ['worker_co_chair']);
    const noSecond = await removeMember(core, { user_id: FOUNDER }, FOUNDER);
    expect(noSecond).toMatchObject({ ok: false, reason: '4eyes_required', status: 403 });
    // The approver must be a DIFFERENT active co-chair.
    const selfApprove = await removeMember(core, { user_id: FOUNDER }, FOUNDER, {
      second_approver_id: FOUNDER
    });
    expect(selfApprove).toMatchObject({ ok: false, reason: '4eyes_required' });
    const ok = await removeMember(core, { user_id: FOUNDER }, FOUNDER, {
      second_approver_id: COCHAIR2
    });
    expect(ok.ok).toBe(true);
    expect(await store.isActiveMember(FOUNDER)).toBe(false);
  });

  it('a co-chair self-demotion requires a second co-chair (4-eyes)', async () => {
    await inviteAndActivate(COCHAIR2, ['worker_co_chair']);
    const noSecond = await setRoles(core, { user_id: FOUNDER }, FOUNDER, ['worker_member']);
    expect(noSecond).toMatchObject({ ok: false, reason: '4eyes_required' });
    const ok = await setRoles(core, { user_id: FOUNDER }, FOUNDER, ['worker_member'], {
      second_approver_id: COCHAIR2
    });
    expect(ok.ok).toBe(true);
  });

  it('a co-chair can remove a DIFFERENT member without 4-eyes', async () => {
    await inviteAndActivate(INVITEE, ['worker_member']);
    const res = await removeMember(core, { user_id: FOUNDER }, INVITEE);
    expect(res.ok).toBe(true);
  });
});

describe('T06 / structural invariants', () => {
  it('emits ONLY events on the closed committee enum', async () => {
    await inviteAndActivate(INVITEE, ['worker_member']);
    await setRoles(core, { user_id: FOUNDER }, INVITEE, ['certified_member']);
    await removeMember(core, { user_id: FOUNDER }, INVITEE);
    for (const row of store.__debugAuditRows()) {
      expect(COMMITTEE_AUDIT_EVENTS).toContain(row.event_type);
    }
  });

  it('single-tenant: no `committee_id` appears anywhere in lib/committee/', () => {
    const dir = nodePath.join(WEB_ROOT, 'src/lib/committee');
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue;
      const src = readFileSync(nodePath.join(dir, f), 'utf8');
      expect(src, `${f} must not reference committee_id (single-tenant)`).not.toMatch(
        /committee_id/
      );
    }
  });
});
