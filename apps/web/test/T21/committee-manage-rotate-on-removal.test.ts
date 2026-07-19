/**
 * F182-6 / ADR-0030 Amendment C — the removal-ceremony UI: member removal now
 * AUTO-RUNS the forward-secrecy key rotation in the same action.
 *
 * HG-KEY-ROTATION. RED-FIRST (TDD). The implementer treats this file as
 * READ-ONLY. It pins Decisions C1–C6 + AC-C1…AC-C15 + the threat-modeler
 * refinements VC-1/VC-2/VC-3 + re-pass triggers #26–#31, at the CARD seam.
 *
 * ── THE SEAM (ADR Decision C4, verified ground truth) ──────────────────────
 * The card injects a structural `ManageClient`; F182-6 adds ONE method:
 *   rotateOnRemoval(input: {
 *     removed_member_id: string;
 *     remaining_members: ReadonlyArray<{ user_id: string }>;
 *     resume?: { rotation_id: string; new_key_id: string };
 *   }) => Promise<RotateCommitteeKeyOnRemovalResult>
 * and a new prop `remainingMembers: ReadonlyArray<{ user_id: string }>` (the
 * roster-derived set, Decision C3). `submitRemove()` becomes:
 *   removeMember(...) → on `ok` set removalCommitted=true, phase='rotating' →
 *   client.rotateOnRemoval({ removed_member_id, remaining_members }) → map the
 *   union to a Decision-C2 terminal. Tests inject a FAKE rotateOnRemoval
 *   returning each union member and assert the resulting terminal — NO real
 *   crypto in this suite.
 *
 * ── NEW Phase terminals (Decision C2 table) ────────────────────────────────
 *   'rotating'              (submitting sub-phase; removeMember ok, rotation in flight)
 *   'rotationDone'          (ok | ok_with_pending          — role="status", green)
 *   'rotationIncomplete'    (incomplete                    — role="alert" + Resume)
 *   'rotationOrphaned'      (orphaned                      — role="alert" + Re-run FRESH)
 *   'rotationCannotResume'  (cannot_resume_not_holder      — role="alert", Close only)
 *   'rotationFailed'        (failed{reason}                — role="alert", reason-mapped)
 *
 * ── data-testid CONTRACT the implementer must wire (named here so the seam is
 *    unambiguous; mirror the existing `committee-manage-*` convention) ───────
 *   committee-manage-rotating              (the rotating CTA <button>; aria-busy="true")
 *   committee-manage-rotation-done         (rotationDone terminal;      role="status")
 *   committee-manage-rotation-pending-note (ok_with_pending info note;  role="status", NOT alert)
 *   committee-manage-rotation-incomplete   (incomplete terminal;        role="alert")
 *   committee-manage-rotation-orphaned     (orphaned terminal;          role="alert")
 *   committee-manage-rotation-cannot-resume(cannot_resume terminal;     role="alert")
 *   committee-manage-rotation-failed       (failed terminal;            role="alert")
 *   committee-manage-rotation-resume       (Resume CTA — incomplete)
 *   committee-manage-rotation-rerun        (Re-run CTA — orphaned / retryable failed FRESH)
 *   committee-manage-rotation-retry        (Retry CTA — transient failed FRESH)
 *   committee-manage-rotation-signin       (<a href="/sign-in"> — session_expiry/401)
 *   committee-manage-rotation-recovery     (Restore-access CTA — needs_recovery/no_wrap)
 *
 * DETERMINISM: frozen clock; a fake client that RECORDS inputs + returns queued
 * results (deferred Promises drive the in-flight `rotating` state); fixtures
 * owned by this file; no sleeps, no `.only`, no real network/RNG. Canary
 * rotation_id/new_key_id prove they are NEVER rendered (AC-C13).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/svelte';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
import { setJwt, clearJwt } from '../../src/lib/auth/session-jwt-store';
import { t } from '../../src/lib/i18n';
import type { RosterRow, CommitteeOpReason } from '../../src/lib/committee/supabase-committee-client';
// Value namespace import (the module EXISTS) — the AC-C15 derivation guard checks
// for the `deriveRemainingMembers` export without a missing-module resolution
// failure (mirrors the f182-4b `getComposition()` guard pattern).
import * as committeeClient from '../../src/lib/committee/supabase-committee-client';

// RED-FIRST import — the component exists (P1-8e) but has NO rotation seam yet,
// so the file loads and each test fails at its OWN assertion (specific + named).
import CommitteeManageMemberCard from '../../src/lib/committee/CommitteeManageMemberCard.svelte';

// ---------------------------------------------------------------------------
// Fixtures — synthetic, no PII. This file OWNS them (no shared global state).
// ---------------------------------------------------------------------------

type OpOk<T> = { ok: true; data: T };
type OpErr = { ok: false; reason: CommitteeOpReason; status: number };
type RemoveResult = OpOk<string> | OpErr;

// The rotation union (mirrors production-flows.ts RotateCommitteeKeyOnRemovalResult).
// NOTE: it carries OPAQUE handles + a uid[] only — NEVER key BYTES (AC-C13).
type RotateResult =
  | { status: 'ok'; rotation_id: string; new_key_id: string; members_rewrapped_count: number; pending_members: string[] }
  | { status: 'ok_with_pending'; rotation_id: string; new_key_id: string; members_rewrapped_count: number; pending_members: string[] }
  | { status: 'orphaned'; rotation_id: string; new_key_id: string }
  | { status: 'incomplete'; rotation_id: string; new_key_id: string; pending_members: string[] }
  | { status: 'cannot_resume_not_holder'; rotation_id: string; new_key_id: string }
  | { status: 'failed'; reason: string; http?: number };

const ACTOR = 'aaaa1111-0000-4000-8000-00000000self';
const OTHER = 'bbbb2222-0000-4000-8000-0000000other';
const REMAIN_1 = 'dddd4444-0000-4000-8000-0remain1aaaa';
const REMAIN_2 = 'eeee5555-0000-4000-8000-0remain2bbbb';
const APPROVER_B = 'ffff6666-0000-4000-8000-0approverbbb';
const GRACE_ISO = '2026-10-12T09:00:00.000Z';

// Distinctive canaries: opaque handles the card must NEVER render or log (AC-C13).
const ROTID = 'ROTID-CANARY-9a7f';
const NEWKID = 'NEWKEY-CANARY-3c2e';

// The roster-derived remaining set the roster threads to the card (Decision C3).
const REMAINING: ReadonlyArray<{ user_id: string }> = [{ user_id: REMAIN_1 }, { user_id: REMAIN_2 }];

function makeRow(over: Partial<RosterRow>): RosterRow {
  return {
    user_id: OTHER,
    roles: ['worker_member'],
    active: true,
    invited_at: '2026-01-05T09:00:00.000Z',
    activated_at: '2026-02-10T09:00:00.000Z',
    deactivated_at: null,
    grace_until: null,
    display_name: 'Otto Other',
    off_employer_contact: null,
    has_identity_key: true,
    has_live_wrap: true,
    ...over
  };
}

const ROW_OTHER_MEMBER = makeRow({ user_id: OTHER, roles: ['worker_member'], display_name: 'Otto Other' });
const ROW_SELF_COCHAIR = makeRow({
  user_id: ACTOR,
  roles: ['worker_member', 'worker_co_chair'],
  display_name: 'Cara Cochair'
});
const ROW_REMOVED = makeRow({
  user_id: 'cccc3333-0000-4000-8000-000000removd',
  active: false,
  deactivated_at: '2026-03-15T09:00:00.000Z',
  grace_until: '2026-06-13T09:00:00.000Z',
  display_name: 'Rita Removed'
});
const APPROVER_ROW_B = makeRow({
  user_id: APPROVER_B,
  roles: ['worker_member', 'worker_co_chair'],
  display_name: 'Bianca Bystander'
});

// ---------------------------------------------------------------------------
// Fake management client — records inputs + call ORDER, returns queued results.
// omitRotate → a governance-only client (VC-1): no rotateOnRemoval method.
// ---------------------------------------------------------------------------

interface RotateCalls {
  removeMember: Array<{ target_user_id: string; second_approver_id?: string | null }>;
  rotateOnRemoval: Array<{
    removed_member_id: string;
    remaining_members: ReadonlyArray<{ user_id: string }>;
    resume?: { rotation_id: string; new_key_id: string };
  }>;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

function fakeClient(opts: {
  remove?: Array<RemoveResult | Promise<RemoveResult>>;
  rotate?: Array<RotateResult | Promise<RotateResult>>;
  omitRotate?: boolean;
  throwOnRotate?: boolean;
} = {}) {
  const calls: RotateCalls = { removeMember: [], rotateOnRemoval: [] };
  const order: string[] = [];
  let ri = 0;
  let roti = 0;
  const remQ = opts.remove ?? [{ ok: true, data: GRACE_ISO }];
  const rotQ: Array<RotateResult | Promise<RotateResult>> = opts.rotate ?? [
    { status: 'ok', rotation_id: ROTID, new_key_id: NEWKID, members_rewrapped_count: 2, pending_members: [] }
  ];
  const client: Record<string, unknown> = {
    setRoles: async () => ({ ok: true, data: null }),
    reactivateMember: async () => ({ ok: true, data: null }),
    removeMember: async (input: RotateCalls['removeMember'][number]) => {
      calls.removeMember.push(input);
      order.push('removeMember');
      return remQ[Math.min(ri++, remQ.length - 1)];
    }
  };
  if (!opts.omitRotate) {
    client.rotateOnRemoval = async (input: RotateCalls['rotateOnRemoval'][number]) => {
      calls.rotateOnRemoval.push(input);
      order.push('rotateOnRemoval');
      if (opts.throwOnRotate) throw new Error('boom');
      return rotQ[Math.min(roti++, rotQ.length - 1)];
    };
  }
  return { client, calls, order };
}

function makeJwt(sub: string): string {
  const seg = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${seg({ alg: 'ES256', typ: 'JWT' })}.${seg({ sub, iat: 1700000000, exp: 1700001000 })}.sig`;
}

function renderCard(over: {
  member?: RosterRow;
  isSelf?: boolean;
  eligibleApprovers?: RosterRow[];
  remainingMembers?: ReadonlyArray<{ user_id: string }>;
  client?: Record<string, unknown>;
  calls?: RotateCalls;
  order?: string[];
  onChanged?: () => void;
} = {}) {
  clearJwt();
  setJwt(makeJwt(ACTOR));
  const built = over.client
    ? { client: over.client, calls: over.calls!, order: over.order! }
    : fakeClient({});
  const member = over.member ?? ROW_OTHER_MEMBER;
  const onChanged = over.onChanged ?? vi.fn();
  const props = {
    member,
    isSelf: over.isSelf ?? member.user_id === ACTOR,
    eligibleApprovers: over.eligibleApprovers ?? [],
    remainingMembers: over.remainingMembers ?? REMAINING,
    client: built.client,
    onChanged
  };
  const utils = render(CommitteeManageMemberCard, { props: props as never });
  return { ...utils, calls: built.calls, order: built.order, onChanged, member };
}

// ---------------------------------------------------------------------------
// DOM helpers.
// ---------------------------------------------------------------------------

async function openRemoveModal(uid: string) {
  await fireEvent.click(await screen.findByTestId(`committee-manage-remove-cta-${uid}`));
  return screen.findByTestId('committee-remove-modal');
}
function removeConfirm(modal: HTMLElement): HTMLButtonElement {
  return (within(modal).queryByRole('button', { name: t('committee.remove.modal.confirm_self') }) ??
    within(modal).getByRole('button', { name: t('committee.remove.modal.confirm') })) as HTMLButtonElement;
}
function pickerIn(modal: HTMLElement): HTMLSelectElement | null {
  return within(modal).queryByRole('combobox') as HTMLSelectElement | null;
}

/** Open the remove modal, confirm, and settle on the `rotating` sub-phase. */
async function removeToRotating(uid: string) {
  const modal = await openRemoveModal(uid);
  await fireEvent.click(removeConfirm(modal));
  return modal;
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

beforeEach(() => {
  freezeClock();
  __resetCapture();
  __setTestSink();
  clearJwt();
});
afterEach(() => {
  cleanup();
  clearJwt();
  __resetCapture();
  vi.restoreAllMocks();
  restoreClock();
});

// ===========================================================================
// AC-C1 (guard) — rotation NEVER runs unless removeMember returned `ok`.
//
// RED/GUARD NOTE: these are REGRESSION GUARDS. With today's card (no rotation
// seam) rotateOnRemoval is never called at all, so the zero-call assertions are
// green-by-construction; they become load-bearing the instant AC-C2 lands (they
// forbid a removal-less rotation, re-pass #26 / STRIDE-E :4923). Each still pins
// that a non-ok governance result takes the EXISTING governance terminal and
// enters NO rotation phase.
// ===========================================================================

describe('F182-6 [AC-C1 / re-pass #26] rotation never runs on a non-ok governance result', () => {
  for (const { label, err, testid } of [
    { label: '4eyes_required', err: { reason: '4eyes_required' as CommitteeOpReason, status: 403 }, testid: 'committee-manage-4eyes' },
    { label: 'last_co_chair', err: { reason: 'last_co_chair' as CommitteeOpReason, status: 409 }, testid: 'committee-manage-last-co-chair' },
    { label: 'a hard failure', err: { reason: 'unknown' as CommitteeOpReason, status: 500 }, testid: 'committee-manage-failed' }
  ]) {
    it(`removeMember → ${label} enters the governance terminal and calls rotateOnRemoval ZERO times`, async () => {
      const built = fakeClient({ remove: [{ ok: false, ...err }] });
      const { calls } = renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
      const modal = await openRemoveModal(OTHER);
      await fireEvent.click(removeConfirm(modal));
      await screen.findByTestId(testid);
      expect(calls.rotateOnRemoval.length, 'no removal happened → rotation must NOT run').toBe(0);
      expect(screen.queryByTestId('committee-manage-rotating')).toBeNull();
      expect(screen.queryByTestId('committee-manage-rotation-done')).toBeNull();
    });
  }
});

// ===========================================================================
// AC-C2 — ordering + args: removeMember ok (other-member) → rotateOnRemoval
// called EXACTLY ONCE, AFTER removeMember, with the right args.
// RED: today the card never calls rotateOnRemoval → zero calls.
// ===========================================================================

describe('F182-6 [AC-C2] on removeMember ok the rotation runs once, after removeMember, with correct args', () => {
  it('rotateOnRemoval is called exactly once, ordered after removeMember', async () => {
    const built = fakeClient({ remove: [{ ok: true, data: GRACE_ISO }] });
    const { calls, order } = renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    const modal = await openRemoveModal(OTHER);
    await fireEvent.click(removeConfirm(modal));
    await waitFor(() => expect(calls.rotateOnRemoval.length).toBe(1));
    expect(calls.removeMember.length).toBe(1);
    expect(order).toEqual(['removeMember', 'rotateOnRemoval']);
  });

  it('forwards { removed_member_id: member.user_id, remaining_members, resume: undefined }', async () => {
    const built = fakeClient({ remove: [{ ok: true, data: GRACE_ISO }] });
    const { calls } = renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, remainingMembers: REMAINING, client: built.client, calls: built.calls, order: built.order });
    const modal = await openRemoveModal(OTHER);
    await fireEvent.click(removeConfirm(modal));
    await waitFor(() => expect(calls.rotateOnRemoval.length).toBe(1));
    const sent = calls.rotateOnRemoval[0]!;
    expect(sent.removed_member_id).toBe(OTHER);
    expect(sent.remaining_members).toEqual(REMAINING);
    expect(sent.resume, 'the initial submit is a FRESH rotation — no resume handle').toBeUndefined();
  });
});

// ===========================================================================
// AC-C3 — `ok` → rotationDone (role="status"); onChanged once; no optimistic
// flip before the union returns (F-181).
// RED: today an other-member ok goes to `committee-manage-done`, never
//      `committee-manage-rotation-done`.
// ===========================================================================

describe('F182-6 [AC-C3] rotation ok → rotationDone success terminal', () => {
  it('reaches rotationDone with role="status" (not the old membership-grace `done`)', async () => {
    const built = fakeClient({ remove: [{ ok: true, data: GRACE_ISO }], rotate: [{ status: 'ok', rotation_id: ROTID, new_key_id: NEWKID, members_rewrapped_count: 2, pending_members: [] }] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    const modal = await removeToRotating(OTHER);
    const done = await screen.findByTestId('committee-manage-rotation-done');
    expect(done.getAttribute('role')).toBe('status');
    // A rotationDone is NOT the governance `done` (self-removal-only) terminal.
    expect(within(modal).queryByTestId('committee-manage-done')).toBeNull();
  });

  it('onChanged fires exactly once, only after the union returns (no optimistic flip)', async () => {
    const onChanged = vi.fn();
    const d = deferred<RotateResult>();
    const built = fakeClient({ remove: [{ ok: true, data: GRACE_ISO }], rotate: [d.promise] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order, onChanged });
    await removeToRotating(OTHER);
    // In flight: rotating shown, union NOT yet returned → NO refetch, NO terminal.
    await screen.findByTestId('committee-manage-rotating');
    expect(screen.queryByTestId('committee-manage-rotation-done')).toBeNull();
    expect(onChanged, 'F-181: no refetch mid-flight').not.toHaveBeenCalled();
    d.resolve({ status: 'ok', rotation_id: ROTID, new_key_id: NEWKID, members_rewrapped_count: 2, pending_members: [] });
    await screen.findByTestId('committee-manage-rotation-done');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });
});

// ===========================================================================
// AC-C4 — `ok_with_pending` is INFORMATIONAL, not an error.
// RED: the pending-note node + rotationDone terminal do not exist yet.
// ===========================================================================

describe('F182-6 [AC-C4] ok_with_pending → rotationDone + an informational (role="status") pending note', () => {
  it('renders the success terminal with a role="status" pending note that is NOT role="alert"', async () => {
    const built = fakeClient({
      remove: [{ ok: true, data: GRACE_ISO }],
      rotate: [{ status: 'ok_with_pending', rotation_id: ROTID, new_key_id: NEWKID, members_rewrapped_count: 1, pending_members: [REMAIN_2] }]
    });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    await removeToRotating(OTHER);
    await screen.findByTestId('committee-manage-rotation-done');
    const note = await screen.findByTestId('committee-manage-rotation-pending-note');
    expect(note.getAttribute('role'), 'the pending note is informational, NOT an alert (F-181/AC-C4)').toBe('status');
    // It must NOT be surfaced as an error/alert anywhere in the terminal.
    expect(screen.queryByTestId('committee-manage-rotation-incomplete')).toBeNull();
    expect(screen.queryByTestId('committee-manage-rotation-failed')).toBeNull();
  });

  it('the pending note names NO member (count-only, F-160) and fires onChanged', async () => {
    const onChanged = vi.fn();
    const built = fakeClient({
      remove: [{ ok: true, data: GRACE_ISO }],
      rotate: [{ status: 'ok_with_pending', rotation_id: ROTID, new_key_id: NEWKID, members_rewrapped_count: 1, pending_members: [REMAIN_2] }]
    });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order, onChanged });
    await removeToRotating(OTHER);
    const note = await screen.findByTestId('committee-manage-rotation-pending-note');
    // The pending member's uid is never rendered (F-160/F-176) — count-only copy.
    expect(note.textContent ?? '').not.toContain(REMAIN_2);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });
});

// ===========================================================================
// AC-C5 — `incomplete` LOUD + Resume (resume handle + remaining = pending_members).
// re-pass #27: Resume re-invokes rotateOnRemoval ONLY, never removeMember.
// RED: the incomplete terminal + Resume CTA do not exist yet.
// ===========================================================================

describe('F182-6 [AC-C5 / re-pass #27] incomplete → LOUD alert + Resume (no re-removeMember)', () => {
  it('incomplete → rotationIncomplete with role="alert"', async () => {
    const built = fakeClient({
      remove: [{ ok: true, data: GRACE_ISO }],
      rotate: [{ status: 'incomplete', rotation_id: ROTID, new_key_id: NEWKID, pending_members: [REMAIN_1] }]
    });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    await removeToRotating(OTHER);
    const term = await screen.findByTestId('committee-manage-rotation-incomplete');
    expect(term.getAttribute('role')).toBe('alert');
  });

  it('Resume calls rotateOnRemoval with resume:{rotation_id,new_key_id} + remaining = pending_members; removeMember NOT re-called', async () => {
    const built = fakeClient({
      remove: [{ ok: true, data: GRACE_ISO }],
      rotate: [
        { status: 'incomplete', rotation_id: ROTID, new_key_id: NEWKID, pending_members: [REMAIN_1] },
        { status: 'ok', rotation_id: ROTID, new_key_id: NEWKID, members_rewrapped_count: 2, pending_members: [] }
      ]
    });
    const { calls } = renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    await removeToRotating(OTHER);
    await screen.findByTestId('committee-manage-rotation-incomplete');
    await fireEvent.click(await screen.findByTestId('committee-manage-rotation-resume'));
    await waitFor(() => expect(calls.rotateOnRemoval.length).toBe(2));
    const resume = calls.rotateOnRemoval[1]!;
    expect(resume.resume).toEqual({ rotation_id: ROTID, new_key_id: NEWKID });
    // remaining_members === the pending_members from the incomplete result (mapped to {user_id}).
    expect(resume.remaining_members.map((m) => m.user_id)).toEqual([REMAIN_1]);
    expect(calls.removeMember.length, 're-pass #27: Resume must not re-run governance').toBe(1);
  });
});

// ===========================================================================
// AC-C6 — `orphaned` LOUD + Re-run FRESH (resume undefined, full remaining).
// re-pass #27: Re-run re-invokes rotateOnRemoval ONLY.
// RED: the orphaned terminal + Re-run CTA do not exist yet.
// ===========================================================================

describe('F182-6 [AC-C6 / re-pass #27] orphaned → LOUD alert + Re-run FRESH (no re-removeMember)', () => {
  it('orphaned → rotationOrphaned with role="alert"', async () => {
    const built = fakeClient({
      remove: [{ ok: true, data: GRACE_ISO }],
      rotate: [{ status: 'orphaned', rotation_id: ROTID, new_key_id: NEWKID }]
    });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    await removeToRotating(OTHER);
    const term = await screen.findByTestId('committee-manage-rotation-orphaned');
    expect(term.getAttribute('role')).toBe('alert');
  });

  it('Re-run calls rotateOnRemoval FRESH (resume undefined, full remaining_members); removeMember NOT re-called', async () => {
    const built = fakeClient({
      remove: [{ ok: true, data: GRACE_ISO }],
      rotate: [
        { status: 'orphaned', rotation_id: ROTID, new_key_id: NEWKID },
        { status: 'ok', rotation_id: 'ROTID-NEXT', new_key_id: 'NEWKEY-NEXT', members_rewrapped_count: 2, pending_members: [] }
      ]
    });
    const { calls } = renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, remainingMembers: REMAINING, client: built.client, calls: built.calls, order: built.order });
    await removeToRotating(OTHER);
    await screen.findByTestId('committee-manage-rotation-orphaned');
    await fireEvent.click(await screen.findByTestId('committee-manage-rotation-rerun'));
    await waitFor(() => expect(calls.rotateOnRemoval.length).toBe(2));
    const rerun = calls.rotateOnRemoval[1]!;
    expect(rerun.resume, 're-run of an orphan mints the NEXT epoch — never resumes the orphan (F-137)').toBeUndefined();
    expect(rerun.remaining_members).toEqual(REMAINING);
    expect(calls.removeMember.length).toBe(1);
  });
});

// ===========================================================================
// AC-C7 / re-pass #31 — `cannot_resume_not_holder` LOUD, no cross-session control.
// RED: the cannot-resume terminal does not exist yet.
// ===========================================================================

describe('F182-6 [AC-C7 / re-pass #31] cannot_resume_not_holder → LOUD alert, Close only, NO cross-session control', () => {
  it('renders rotationCannotResume (role="alert") with NO resume/re-run/retry control and no re-removeMember', async () => {
    const built = fakeClient({
      remove: [{ ok: true, data: GRACE_ISO }],
      rotate: [{ status: 'cannot_resume_not_holder', rotation_id: ROTID, new_key_id: NEWKID }]
    });
    const { calls } = renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    await removeToRotating(OTHER);
    const term = await screen.findByTestId('committee-manage-rotation-cannot-resume');
    expect(term.getAttribute('role')).toBe('alert');
    // F182-5 deferred: v1 offers NO in-session completion of a rotation this
    // device cannot hold — no resume/re-run/retry affordance is rendered.
    expect(screen.queryByTestId('committee-manage-rotation-resume')).toBeNull();
    expect(screen.queryByTestId('committee-manage-rotation-rerun')).toBeNull();
    expect(screen.queryByTestId('committee-manage-rotation-retry')).toBeNull();
    // Close is the primary affordance.
    expect(within(term).queryByRole('button', { name: t('committee.manage.close') })).not.toBeNull();
    expect(calls.removeMember.length).toBe(1);
  });

  it('renders NO second-approver picker on the cannot-resume terminal (re-pass #31: no single-co-chair veto)', async () => {
    const built = fakeClient({
      remove: [{ ok: true, data: GRACE_ISO }],
      rotate: [{ status: 'cannot_resume_not_holder', rotation_id: ROTID, new_key_id: NEWKID }]
    });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    await removeToRotating(OTHER);
    const term = await screen.findByTestId('committee-manage-rotation-cannot-resume');
    expect(pickerIn(term)).toBeNull();
  });
});

// ===========================================================================
// AC-C8 — `failed{reason}` LOUD, reason-mapped, 401/403 split, F-176 no raw enum.
// RED: the rotationFailed terminal + its per-reason affordances do not exist yet.
// ===========================================================================

describe('F182-6 [AC-C8] failed{reason} → rotationFailed, reason-mapped affordances', () => {
  async function toFailed(reason: string, http?: number) {
    const built = fakeClient({
      remove: [{ ok: true, data: GRACE_ISO }],
      rotate: [{ status: 'failed', reason, http }]
    });
    const r = renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    await removeToRotating(OTHER);
    const term = await screen.findByTestId('committee-manage-rotation-failed');
    return { term, ...r };
  }

  it('rotationFailed is VISUALLY/structurally DISTINCT from the governance failed terminal', async () => {
    const { term } = await toFailed('decrypt_failed');
    expect(term.getAttribute('role')).toBe('alert');
    // The governance failure terminal id is NOT reused for the crypto failure.
    expect(screen.queryByTestId('committee-manage-failed')).toBeNull();
  });

  it('session_expiry / http 401 → sign-in route, NOT an in-place retry', async () => {
    const { term } = await toFailed('session_expiry', 401);
    const signin = within(term).getByTestId('committee-manage-rotation-signin');
    // Route to sign-in (an anchor), never a same-place retry (the session is gone).
    if (signin.tagName.toLowerCase() === 'a') {
      expect(signin.getAttribute('href') ?? '').toMatch(/\/sign-in/);
    }
    expect(within(term).queryByTestId('committee-manage-rotation-retry')).toBeNull();
  });

  it('rls_denied / http 403 → co-chair-lost copy, no retry (another co-chair must finish)', async () => {
    const { term } = await toFailed('rls_denied', 403);
    expect(within(term).queryByTestId('committee-manage-rotation-retry')).toBeNull();
    expect(within(term).queryByTestId('committee-manage-rotation-signin')).toBeNull();
    expect(within(term).queryByRole('button', { name: t('committee.manage.close') })).not.toBeNull();
  });

  for (const reason of ['needs_recovery', 'no_wrap']) {
    it(`${reason} → MESSAGE-ONLY recovery terminal (body + Close), NO mis-targeted /sign-in link, NOT an in-place retry`, async () => {
      const { term } = await toFailed(reason);
      // Adversarial F1 (round-1 closure fix): the recovery affordance is MESSAGE-ONLY,
      // mirroring the app's Concern/Reprisal needs_recovery pattern — the body already
      // tells the user to restore committee-key access on this device. It must NOT be
      // an `<a href="/sign-in">` (that destination belongs to the session_expiry
      // sign-in affordance, NOT recovery). RED today: the recovery affordance renders
      // `<a href="/sign-in" data-testid="committee-manage-rotation-recovery">`.
      const signinLinks = within(term)
        .queryAllByRole('link')
        .filter((a) => (a.getAttribute('href') ?? '').includes('/sign-in'));
      expect(signinLinks, 'the recovery terminal must render NO /sign-in link (message-only)').toHaveLength(0);
      // The needs_recovery body message is shown; Close is the affordance — not a retry.
      expect(term.textContent ?? '', 'the recovery terminal shows its body message').toContain(
        t('committee.remove.rotationFailed.needs_recovery_body')
      );
      expect(within(term).queryByRole('button', { name: t('committee.manage.close') })).not.toBeNull();
      expect(within(term).queryByTestId('committee-manage-rotation-retry')).toBeNull();
    });
  }

  it('invalid_input / http 422 → unrecoverable, Close-only (NON-retryable — orchestrator ruling)', async () => {
    const { term } = await toFailed('invalid_input', 422);
    // A retry re-seals identical bytes → identical failure; so NO retry, NO recovery.
    expect(within(term).queryByTestId('committee-manage-rotation-retry')).toBeNull();
    expect(within(term).queryByTestId('committee-manage-rotation-recovery')).toBeNull();
    expect(within(term).queryByTestId('committee-manage-rotation-signin')).toBeNull();
    expect(within(term).queryByRole('button', { name: t('committee.manage.close') })).not.toBeNull();
  });

  for (const reason of ['rotation_in_progress', 'decrypt_failed']) {
    it(`${reason} → transient: Retry (FRESH) enabled`, async () => {
      const { term } = await toFailed(reason);
      expect(within(term).getByTestId('committee-manage-rotation-retry')).not.toBeNull();
    });
  }

  it('a transient Retry re-invokes rotateOnRemoval FRESH; removeMember NOT re-called (re-pass #27)', async () => {
    const built = fakeClient({
      remove: [{ ok: true, data: GRACE_ISO }],
      rotate: [
        { status: 'failed', reason: 'decrypt_failed' },
        { status: 'ok', rotation_id: ROTID, new_key_id: NEWKID, members_rewrapped_count: 2, pending_members: [] }
      ]
    });
    const { calls } = renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, remainingMembers: REMAINING, client: built.client, calls: built.calls, order: built.order });
    await removeToRotating(OTHER);
    await screen.findByTestId('committee-manage-rotation-failed');
    await fireEvent.click(await screen.findByTestId('committee-manage-rotation-retry'));
    await waitFor(() => expect(calls.rotateOnRemoval.length).toBe(2));
    const retry = calls.rotateOnRemoval[1]!;
    expect(retry.resume).toBeUndefined();
    expect(retry.remaining_members).toEqual(REMAINING);
    expect(calls.removeMember.length).toBe(1);
  });

  it('a THROWN rotateOnRemoval → rotationFailed (never a false success, no crash)', async () => {
    const built = fakeClient({ remove: [{ ok: true, data: GRACE_ISO }], throwOnRotate: true });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    await removeToRotating(OTHER);
    await screen.findByTestId('committee-manage-rotation-failed');
    expect(screen.queryByTestId('committee-manage-rotation-done')).toBeNull();
  });

  it('F-176: no rotationFailed terminal echoes the raw reason enum', async () => {
    for (const reason of ['session_expiry', 'rls_denied', 'needs_recovery', 'invalid_input', 'decrypt_failed', 'no_wrap']) {
      const { container } = await toFailed(reason);
      expect(container.textContent ?? '', `raw reason "${reason}" must never render (F-176)`).not.toContain(reason);
      cleanup();
    }
  });
});

// ===========================================================================
// Adversarial F1 (round-1 closure fix) — the sign-in and recovery affordances must
// point at DIFFERENT destinations. session_expiry/401 → the correct <a href="/sign-in">
// (UNCHANGED — that one is right). needs_recovery/no_wrap → message-only, NO /sign-in
// link (the mis-targeted link is removed; the body already says "restore your access").
// This pins that the two affordances no longer share the /sign-in destination.
// ===========================================================================

describe('F182-6 [Adversarial F1] sign-in and recovery affordances resolve to DIFFERENT destinations', () => {
  async function failedTerm(reason: string, http?: number): Promise<HTMLElement> {
    const built = fakeClient({
      remove: [{ ok: true, data: GRACE_ISO }],
      rotate: [{ status: 'failed', reason, http }]
    });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    await removeToRotating(OTHER);
    return screen.findByTestId('committee-manage-rotation-failed');
  }

  it('session_expiry/401 keeps the correct <a href="/sign-in"> sign-in affordance (unchanged, correct)', async () => {
    const term = await failedTerm('session_expiry', 401);
    const signin = within(term).getByTestId('committee-manage-rotation-signin');
    expect(signin.tagName.toLowerCase(), 'the sign-in affordance is an anchor').toBe('a');
    expect(signin.getAttribute('href') ?? '', 'the sign-in affordance routes to /sign-in').toContain('/sign-in');
  });

  it('needs_recovery does NOT reuse the /sign-in destination (message-only recovery affordance)', async () => {
    const term = await failedTerm('needs_recovery');
    // If a recovery testid survives the message-only rewrite, it must NOT be an
    // <a href="/sign-in">. Either shape is acceptable; borrowing /sign-in is not.
    const recovery = within(term).queryByTestId('committee-manage-rotation-recovery');
    if (recovery) {
      const isSigninAnchor =
        recovery.tagName.toLowerCase() === 'a' && (recovery.getAttribute('href') ?? '').includes('/sign-in');
      expect(isSigninAnchor, 'the recovery affordance must not borrow the /sign-in destination').toBe(false);
    }
    const signinLinks = within(term)
      .queryAllByRole('link')
      .filter((a) => (a.getAttribute('href') ?? '').includes('/sign-in'));
    expect(signinLinks, 'the recovery terminal is message-only — no /sign-in link').toHaveLength(0);
  });
});

// ===========================================================================
// VC-2 (threat-model refinement) — a RESUME that returns failed{needs_recovery}
// routes to restore-from-recovery, NOT the cannot_resume dead-end.
// RED: the resume path + needs_recovery→recovery branch do not exist yet.
// ===========================================================================

describe('F182-6 [VC-2] a Resume that yields failed{needs_recovery} routes to recovery, not cannot_resume', () => {
  it('incomplete → Resume → failed{needs_recovery} → rotationFailed w/ recovery route (NOT cannot-resume)', async () => {
    const built = fakeClient({
      remove: [{ ok: true, data: GRACE_ISO }],
      rotate: [
        { status: 'incomplete', rotation_id: ROTID, new_key_id: NEWKID, pending_members: [REMAIN_1] },
        { status: 'failed', reason: 'needs_recovery' }
      ]
    });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    await removeToRotating(OTHER);
    await screen.findByTestId('committee-manage-rotation-incomplete');
    await fireEvent.click(await screen.findByTestId('committee-manage-rotation-resume'));
    const failed = await screen.findByTestId('committee-manage-rotation-failed');
    // Routed to the needs_recovery MESSAGE-ONLY terminal (Adversarial F1): the body
    // says to restore committee-key access on this device — no mis-targeted /sign-in
    // link. RED today: the recovery affordance renders `<a href="/sign-in">`.
    expect(failed.textContent ?? '', 'the resumed recovery terminal shows its body message').toContain(
      t('committee.remove.rotationFailed.needs_recovery_body')
    );
    const signinLinks = within(failed)
      .queryAllByRole('link')
      .filter((a) => (a.getAttribute('href') ?? '').includes('/sign-in'));
    expect(signinLinks, 'the resumed recovery terminal must render NO /sign-in link').toHaveLength(0);
    // The needs_recovery resumer must NOT be dead-ended into the cannot-resume copy.
    expect(screen.queryByTestId('committee-manage-rotation-cannot-resume')).toBeNull();
  });
});

// ===========================================================================
// AC-C9 — self-removal SKIPS the in-session rotation.
// RED: today the self-removal `done.body` copy is the OLD membership-grace text;
//      it must be reconciled (VC-3) to say a remaining co-chair must still rotate.
// ===========================================================================

describe('F182-6 [AC-C9 / VC-3] self-removal skips rotateOnRemoval and says a remaining co-chair must rotate', () => {
  async function selfRemove() {
    const built = fakeClient({ remove: [{ ok: true, data: GRACE_ISO }] });
    const r = renderCard({
      member: ROW_SELF_COCHAIR,
      isSelf: true,
      eligibleApprovers: [APPROVER_ROW_B],
      client: built.client,
      calls: built.calls,
      order: built.order
    });
    const modal = await openRemoveModal(ACTOR);
    // Self-drop of worker_co_chair requires the 4-eyes approver pick.
    const select = pickerIn(modal)!;
    await fireEvent.change(select, { target: { value: APPROVER_B } });
    await fireEvent.click(removeConfirm(modal));
    return { modal, ...r };
  }

  it('a self-remove ok does NOT call rotateOnRemoval (the leaver cannot run it)', async () => {
    const { calls } = await selfRemove();
    await screen.findByTestId('committee-manage-done');
    expect(calls.rotateOnRemoval.length, 'AC-C9: self-removal must never call rotateOnRemoval').toBe(0);
    // It stays on the (self-only) governance `done` terminal — no rotation phase.
    expect(screen.queryByTestId('committee-manage-rotating')).toBeNull();
    expect(screen.queryByTestId('committee-manage-rotation-done')).toBeNull();
  });

  it('the self-removal terminal states a remaining worker co-chair must still rotate the key', async () => {
    const { modal } = await selfRemove();
    const done = await screen.findByTestId('committee-manage-done');
    const text = `${done.textContent ?? ''} ${modal.textContent ?? ''}`;
    // VC-3: the done.body MEANING changed from a pure membership grace to the
    // self-removal "a remaining co-chair must still rotate" honesty.
    expect(text).toMatch(/remaining .*co-?chair.*rotate|co-?chair.*must .*rotate/i);
  });
});

// ===========================================================================
// AC-C10 — server-truthed: no terminal / refetch before BOTH returns.
// RED: the rotating phase + onChanged-at-rotation-terminal wiring do not exist.
// ===========================================================================

describe('F182-6 [AC-C10] server-truthed — onChanged fires only at a terminal, never mid-flight', () => {
  it('no refetch after removeMember ok while the rotation is still in flight', async () => {
    const onChanged = vi.fn();
    const removeD = deferred<RemoveResult>();
    const rotateD = deferred<RotateResult>();
    const built = fakeClient({ remove: [removeD.promise], rotate: [rotateD.promise] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order, onChanged });
    const modal = await openRemoveModal(OTHER);
    await fireEvent.click(removeConfirm(modal));
    // removeMember in flight (submitting) — no refetch.
    await screen.findByTestId('committee-manage-submitting');
    expect(onChanged).not.toHaveBeenCalled();
    // removeMember returns ok → rotating; still NO refetch (rotation not done).
    removeD.resolve({ ok: true, data: GRACE_ISO });
    await screen.findByTestId('committee-manage-rotating');
    expect(onChanged, 'F-181: onChanged must not fire between the two returns').not.toHaveBeenCalled();
    // Rotation returns → terminal → exactly one refetch.
    rotateD.resolve({ status: 'ok', rotation_id: ROTID, new_key_id: NEWKID, members_rewrapped_count: 2, pending_members: [] });
    await screen.findByTestId('committee-manage-rotation-done');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('onChanged fires once when a LOUD rotation terminal is reached (governance is server-truth)', async () => {
    const onChanged = vi.fn();
    const built = fakeClient({
      remove: [{ ok: true, data: GRACE_ISO }],
      rotate: [{ status: 'incomplete', rotation_id: ROTID, new_key_id: NEWKID, pending_members: [REMAIN_1] }]
    });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order, onChanged });
    await removeToRotating(OTHER);
    await screen.findByTestId('committee-manage-rotation-incomplete');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });
});

// ===========================================================================
// AC-C11 — a11y packet preserved (portal, protected Escape, focus move, aria-busy).
// RED: the rotating phase + terminals are unreachable today.
// ===========================================================================

describe('F182-6 [AC-C11] a11y packet — protected Escape, portal, aria-busy, focus move', () => {
  it('the rotating CTA carries aria-busy="true" and is portaled under <body>', async () => {
    const d = deferred<RotateResult>();
    const built = fakeClient({ remove: [{ ok: true, data: GRACE_ISO }], rotate: [d.promise] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    await removeToRotating(OTHER);
    const busy = await screen.findByTestId('committee-manage-rotating');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    // The modal is portaled to <body> (background inert-able behind it).
    const modal = screen.getByTestId('committee-remove-modal');
    expect(document.body.contains(modal)).toBe(true);
    d.resolve({ status: 'ok', rotation_id: ROTID, new_key_id: NEWKID, members_rewrapped_count: 2, pending_members: [] });
    await screen.findByTestId('committee-manage-rotation-done');
  });

  it('Escape is PROTECTED (swallowed) while rotating and does not close the modal', async () => {
    const d = deferred<RotateResult>();
    const built = fakeClient({ remove: [{ ok: true, data: GRACE_ISO }], rotate: [d.promise] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    const modal = await removeToRotating(OTHER);
    await screen.findByTestId('committee-manage-rotating');
    await fireEvent.keyDown(modal, { key: 'Escape' });
    expect(screen.queryByTestId('committee-remove-modal'), 'rotating is Escape-protected').not.toBeNull();
    d.resolve({ status: 'ok', rotation_id: ROTID, new_key_id: NEWKID, members_rewrapped_count: 2, pending_members: [] });
    await screen.findByTestId('committee-manage-rotation-done');
  });

  for (const { label, rotate, testid } of [
    { label: 'rotationDone', rotate: { status: 'ok', rotation_id: ROTID, new_key_id: NEWKID, members_rewrapped_count: 2, pending_members: [] } as RotateResult, testid: 'committee-manage-rotation-done' },
    { label: 'rotationIncomplete', rotate: { status: 'incomplete', rotation_id: ROTID, new_key_id: NEWKID, pending_members: [REMAIN_1] } as RotateResult, testid: 'committee-manage-rotation-incomplete' },
    { label: 'rotationOrphaned', rotate: { status: 'orphaned', rotation_id: ROTID, new_key_id: NEWKID } as RotateResult, testid: 'committee-manage-rotation-orphaned' },
    { label: 'rotationCannotResume', rotate: { status: 'cannot_resume_not_holder', rotation_id: ROTID, new_key_id: NEWKID } as RotateResult, testid: 'committee-manage-rotation-cannot-resume' },
    { label: 'rotationFailed', rotate: { status: 'failed', reason: 'decrypt_failed' } as RotateResult, testid: 'committee-manage-rotation-failed' }
  ]) {
    it(`Escape is protected on the ${label} terminal (explicit Close required)`, async () => {
      const built = fakeClient({ remove: [{ ok: true, data: GRACE_ISO }], rotate: [rotate] });
      renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
      const modal = await removeToRotating(OTHER);
      await screen.findByTestId(testid);
      await fireEvent.keyDown(modal, { key: 'Escape' });
      expect(screen.queryByTestId('committee-remove-modal'), `${label} must require an explicit Close`).not.toBeNull();
    });

    it(`focus moves to the ${label} terminal heading (one deliberate move)`, async () => {
      const built = fakeClient({ remove: [{ ok: true, data: GRACE_ISO }], rotate: [rotate] });
      renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
      await removeToRotating(OTHER);
      const term = await screen.findByTestId(testid);
      const heading = within(term).getByRole('heading');
      await waitFor(() => expect(document.activeElement).toBe(heading));
    });
  }
});

// ===========================================================================
// Accessibility F2 (round-1 closure fix) / AC-C11 — the `rotating` SUB-PHASE must
// (a) keep the dialog NAMED and (b) move focus off <body>. Today the rotating block
// carries NO element with id={dialogHeadingId}, so the dialog's aria-labelledby
// dangles (transiently unnamed), and runRotation() moves NO focus, so focus strands
// on <body> when the submitting Confirm unmounts. The fix adds a heading to the
// rotating block: id={dialogHeadingId} + tabindex="-1" + bind:this={rotatingHeadingEl}
// (suggested data-testid="committee-manage-rotating-heading"), focused in
// runRotation() after the tick (mirrors enterRotationDone's focusEl move).
//
// RED today: (a) no element carries the aria-labelledby id during rotating;
//            (b) document.activeElement is <body> (no focus move on entering rotating).
// ===========================================================================

describe('F182-6 [AC-C11 / Accessibility F2] the rotating sub-phase names the dialog and moves focus off <body>', () => {
  /** Render + drive to a HELD `rotating` phase (deferred rotation stays in flight). */
  function toHeldRotating() {
    const d = deferred<RotateResult>();
    const built = fakeClient({ remove: [{ ok: true, data: GRACE_ISO }], rotate: [d.promise] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    return d;
  }
  const RESOLVE_OK: RotateResult = {
    status: 'ok',
    rotation_id: ROTID,
    new_key_id: NEWKID,
    members_rewrapped_count: 2,
    pending_members: []
  };

  it('the dialog stays NAMED during rotating (an element carries the aria-labelledby id)', async () => {
    const d = toHeldRotating();
    await removeToRotating(OTHER);
    await screen.findByTestId('committee-manage-rotating');
    const modal = screen.getByTestId('committee-remove-modal');
    const labelledBy = modal.getAttribute('aria-labelledby');
    expect(labelledBy, 'the rotating dialog must keep an aria-labelledby target').toBeTruthy();
    const named = labelledBy ? document.getElementById(labelledBy) : null;
    expect(
      named,
      'an element with id === aria-labelledby must exist during rotating — the dialog must not be transiently unnamed (Accessibility F2)'
    ).not.toBeNull();
    expect(modal.contains(named), 'the naming element lives inside the dialog').toBe(true);
    d.resolve(RESOLVE_OK);
    await screen.findByTestId('committee-manage-rotation-done');
  });

  it('entering rotating moves focus to the rotating heading, NOT stranded on <body>', async () => {
    const d = toHeldRotating();
    await removeToRotating(OTHER);
    await screen.findByTestId('committee-manage-rotating');
    const modal = screen.getByTestId('committee-remove-modal');
    const labelledBy = modal.getAttribute('aria-labelledby') ?? '';
    await waitFor(() =>
      expect(document.activeElement, 'focus must not strand on <body> when rotation begins').not.toBe(
        document.body
      )
    );
    expect(document.activeElement, 'focus lands on the rotating heading (id === aria-labelledby)').toBe(
      document.getElementById(labelledBy)
    );
    d.resolve(RESOLVE_OK);
    await screen.findByTestId('committee-manage-rotation-done');
  });
});

// ===========================================================================
// AC-C13 — no key BYTES in the union; rotation_id / new_key_id never rendered.
// RED: the terminals that would (wrongly) render the handles are unreachable
//      today, so findByTestId fails first — a specific red.
// ===========================================================================

describe('F182-6 [AC-C13] opaque handles never render; the union carries no key bytes', () => {
  for (const { label, rotate, testid } of [
    { label: 'rotationDone', rotate: { status: 'ok', rotation_id: ROTID, new_key_id: NEWKID, members_rewrapped_count: 2, pending_members: [] } as RotateResult, testid: 'committee-manage-rotation-done' },
    { label: 'rotationIncomplete', rotate: { status: 'incomplete', rotation_id: ROTID, new_key_id: NEWKID, pending_members: [REMAIN_1] } as RotateResult, testid: 'committee-manage-rotation-incomplete' },
    { label: 'rotationOrphaned', rotate: { status: 'orphaned', rotation_id: ROTID, new_key_id: NEWKID } as RotateResult, testid: 'committee-manage-rotation-orphaned' },
    { label: 'rotationCannotResume', rotate: { status: 'cannot_resume_not_holder', rotation_id: ROTID, new_key_id: NEWKID } as RotateResult, testid: 'committee-manage-rotation-cannot-resume' },
    { label: 'rotationFailed', rotate: { status: 'failed', reason: 'decrypt_failed' } as RotateResult, testid: 'committee-manage-rotation-failed' }
  ]) {
    it(`${label} never renders the opaque rotation_id / new_key_id handles`, async () => {
      const built = fakeClient({ remove: [{ ok: true, data: GRACE_ISO }], rotate: [rotate] });
      const { container } = renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
      await removeToRotating(OTHER);
      await screen.findByTestId(testid);
      const html = container.ownerDocument.body.innerHTML;
      expect(html, 'rotation_id must never reach the DOM (F-176/AC-C13)').not.toContain(ROTID);
      expect(html, 'new_key_id must never reach the DOM (F-176/AC-C13)').not.toContain(NEWKID);
    });
  }
});

// ===========================================================================
// AC-C14 / VC-1 / re-pass #26 (mirror) — no silent no-rotate removal: the Remove
// CTA is gated on rotateOnRemoval presence; Change-role / Reactivate survive.
// RED: today the Remove CTA renders regardless of rotateOnRemoval.
// ===========================================================================

describe('F182-6 [AC-C14 / VC-1] a governance-only client offers NO Remove, but keeps Change-role / Reactivate', () => {
  it('an active row + governance-only client → NO Remove CTA, but Change-role IS rendered', async () => {
    const built = fakeClient({ omitRotate: true });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    expect(await screen.findByTestId(`committee-manage-role-cta-${OTHER}`)).toBeDefined();
    expect(
      screen.queryByTestId(`committee-manage-remove-cta-${OTHER}`),
      'VC-1: never a membership-only removal under the deleted dishonest copy'
    ).toBeNull();
  });

  it('a removed row + governance-only client → Reactivate STILL renders (not gated on crypto deps)', async () => {
    const built = fakeClient({ omitRotate: true });
    renderCard({ member: ROW_REMOVED, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    expect(await screen.findByTestId(`committee-manage-reactivate-cta-${ROW_REMOVED.user_id}`)).toBeDefined();
  });

  it('when rotateOnRemoval IS wired → the Remove CTA renders (the rotation-capable path)', async () => {
    const built = fakeClient({});
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, order: built.order });
    expect(await screen.findByTestId(`committee-manage-remove-cta-${OTHER}`)).toBeDefined();
  });
});

// ===========================================================================
// AC-C15 / re-pass #29 — remaining_members = active + has_live_wrap − removed;
// pending_grant / awaiting_identity EXCLUDED (no silent grant without a human
// fingerprint confirm). Pinned at BOTH the card-forwarding level AND the
// roster-derivation level (Decision C3).
//
// REQUIRED EXPORT (implementer): a pure `deriveRemainingMembers(rows, removed_id)`
// exported from `$lib/committee/supabase-committee-client` (the roster's reactive
// block calls it), so the Decision-C3 predicate is unit-testable off the render tree.
// ===========================================================================

describe('F182-6 [AC-C15] the card forwards the roster-derived remaining set verbatim; removed member never in it', () => {
  it('forwards exactly the injected remainingMembers and never adds the removed member', async () => {
    const built = fakeClient({ remove: [{ ok: true, data: GRACE_ISO }] });
    const { calls } = renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, remainingMembers: REMAINING, client: built.client, calls: built.calls, order: built.order });
    const modal = await openRemoveModal(OTHER);
    await fireEvent.click(removeConfirm(modal));
    await waitFor(() => expect(calls.rotateOnRemoval.length).toBe(1));
    const sent = calls.rotateOnRemoval[0]!;
    expect(sent.remaining_members).toEqual(REMAINING);
    expect(sent.remaining_members.map((m) => m.user_id)).not.toContain(OTHER);
  });
});

describe('F182-6 [AC-C15 / re-pass #29] deriveRemainingMembers — active+has_live_wrap, pending_grant excluded', () => {
  function derive(): (rows: RosterRow[], removed_id: string) => ReadonlyArray<{ user_id: string }> {
    const fn = (committeeClient as Record<string, unknown>).deriveRemainingMembers;
    expect(
      typeof fn,
      'AC-C15: $lib/committee/supabase-committee-client must export `deriveRemainingMembers(rows, ' +
        'removed_id)` — the Decision-C3 pure predicate (active && has_live_wrap && !== removed) the ' +
        'roster reactive block calls. It does not exist yet.'
    ).toBe('function');
    return fn as (rows: RosterRow[], removed_id: string) => ReadonlyArray<{ user_id: string }>;
  }

  const R = (over: Partial<RosterRow>) => makeRow(over);
  const ACTIVE_LIVE = R({ user_id: REMAIN_1, active: true, has_identity_key: true, has_live_wrap: true });
  const ACTIVE_LIVE_2 = R({ user_id: REMAIN_2, active: true, has_identity_key: true, has_live_wrap: true });
  const PENDING_GRANT = R({ user_id: 'pg000000-0000-4000-8000-00pendinggrn', active: true, has_identity_key: true, has_live_wrap: false });
  const AWAITING_ID = R({ user_id: 'ai000000-0000-4000-8000-0awaitingidk', active: true, has_identity_key: false, has_live_wrap: false });
  const INACTIVE = R({ user_id: 'in000000-0000-4000-8000-0inactiverow', active: false, deactivated_at: '2026-03-15T09:00:00.000Z', has_live_wrap: true });
  const REMOVED_ROW = R({ user_id: OTHER, active: true, has_identity_key: true, has_live_wrap: true });

  it('includes active members that hold a live wrap, minus the removed member', async () => {
    const deriveRemaining = derive();
    const out = deriveRemaining([ACTIVE_LIVE, ACTIVE_LIVE_2, REMOVED_ROW], OTHER);
    expect(new Set(out.map((m) => m.user_id))).toEqual(new Set([REMAIN_1, REMAIN_2]));
    expect(out.map((m) => m.user_id)).not.toContain(OTHER);
  });

  it('EXCLUDES a never-granted pending_grant member (has_live_wrap===false) — no silent grant (re-pass #29)', async () => {
    const deriveRemaining = derive();
    const out = deriveRemaining([ACTIVE_LIVE, PENDING_GRANT, REMOVED_ROW], OTHER);
    expect(out.map((m) => m.user_id)).not.toContain(PENDING_GRANT.user_id);
  });

  it('EXCLUDES an awaiting_identity member and an inactive member', async () => {
    const deriveRemaining = derive();
    const out = deriveRemaining([ACTIVE_LIVE, AWAITING_ID, INACTIVE, REMOVED_ROW], OTHER);
    const ids = out.map((m) => m.user_id);
    expect(ids).not.toContain(AWAITING_ID.user_id);
    expect(ids).not.toContain(INACTIVE.user_id);
    expect(ids).toEqual([REMAIN_1]);
  });
});
