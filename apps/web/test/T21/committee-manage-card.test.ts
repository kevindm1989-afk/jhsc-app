/**
 * ADR-0029 P1-8e — Surface K screen 5: CommitteeManageMemberCard
 * (role change / remove / reactivate — 4-eyes governance UI).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
 *
 * RED SIGNAL: `CommitteeManageMemberCard.svelte` does not exist yet → module
 * resolution failure. That is the intended primary red signal; once the
 * component exists, the per-finding assertions below become the gate.
 *
 * The load-bearing properties (design-system.md "Surface K — screen 5"; threat-
 * model §3.18 F-181 :4037-4049 + F-182 :4077-4114):
 *
 *   F-181 (anti-optimism) — the TERMINAL state is rendered ONLY from the server
 *     return. `done` iff the RPC returns with NO raised reason; a 4eyes_required
 *     return → the 4eyes state (NOT done); a last_co_chair return → the explained
 *     block (NOT done); a thrown/failed return → failed (never a false done). The
 *     card never optimistically signals success before the server confirms.
 *
 *   F-181 (self-approve suppression, defense-in-depth) — the second-approver
 *     picker appears ONLY on a self-action that drops the actor's own co-chair
 *     role; it lists only the eligible approvers (self excluded, distinct); on an
 *     other-member action there is NO picker; on an empty eligible list there is
 *     NO picker and Confirm stays ENABLED (self-removal must not dead-end — the
 *     server truths last_co_chair).
 *
 *   F-181 (last_co_chair keyed off the SERVER reason, never a client count) —
 *     the block renders from `reason === 'last_co_chair'`, never from a local
 *     "am I the last co-chair" computation.
 *
 *   F-181 (reasons discriminated; F-160 names no other member) — 4eyes_required /
 *     last_co_chair / invalid_role / not_found render DISTINCT copy, never
 *     collapsed to a generic rls_denied/unknown; blocking/error copy names no
 *     other member.
 *
 *   F-182 (honest copy) — the remove-confirm copy states the non-cryptographic
 *     limit and contains NO data-access-revocation claim; the reactivate-confirm
 *     copy states access returns via the RETAINED wrap, not a fresh grant.
 *
 * Card contract pinned here (design-system.md "screen 5", the attach block):
 *   props { member: RosterRow, isSelf: boolean, eligibleApprovers: RosterRow[],
 *           client: { setRoles, removeMember, reactivateMember },
 *           onChanged?: () => void }
 * The parent (CommitteeRoster) derives isSelf (= member.user_id ===
 * getCurrentUserId()) and eligibleApprovers (= rows.filter(active &&
 * roles.includes('worker_co_chair') && user_id !== getCurrentUserId())) and
 * re-runs listRoster() when the card signals a successful mutation.
 *
 * Determinism: frozen clock; a fake client that RECORDS inputs + returns queued
 * results (deferred Promises drive the `submitting` state); fixed fixtures owned
 * by this file; no sleeps, no `.only`, no real network/RNG.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/svelte';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
import { setJwt, clearJwt } from '../../src/lib/auth/session-jwt-store';
import { t } from '../../src/lib/i18n';
import type { RosterRow, CommitteeOpReason } from '../../src/lib/committee/supabase-committee-client';

// RED-FIRST import — the implementer creates this lib component.
import CommitteeManageMemberCard from '../../src/lib/committee/CommitteeManageMemberCard.svelte';

// ---------------------------------------------------------------------------
// Fixtures (this file owns them — no shared global fixtures). Distinctive
// canary names/uids power the F-160 "names no other member" sweeps. Synthetic —
// no real PII.
// ---------------------------------------------------------------------------

type OpOk<T> = { ok: true; data: T };
type OpErr = { ok: false; reason: CommitteeOpReason; status: number };
type SetRolesResult = OpOk<null> | OpErr;
type RemoveResult = OpOk<string> | OpErr;
type ReactivateResult = OpOk<null> | OpErr;

// F182-6 / ADR-0030 Amendment C — the rotation status union the rotation-capable
// client returns (structural MIRROR of the card's local RotationResult). The card
// only reads `.status` on the `ok` case, so the handle/count fields are optional
// here. Its mere PRESENCE on the client un-gates the Remove CTA (VC-1 pure-presence
// gate — CommitteeManageMemberCard.svelte:258); production ALWAYS wires the crypto
// deps on the /committee route, so these sibling fakes are rotation-capable too.
type RotationResult =
  | {
      status: 'ok';
      rotation_id?: string;
      new_key_id?: string;
      members_rewrapped_count?: number;
      pending_members?: string[];
    }
  | {
      status: 'ok_with_pending';
      rotation_id: string;
      new_key_id: string;
      members_rewrapped_count: number;
      pending_members: string[];
    }
  | { status: 'orphaned'; rotation_id: string; new_key_id: string }
  | { status: 'incomplete'; rotation_id: string; new_key_id: string; pending_members: string[] }
  | { status: 'cannot_resume_not_holder'; rotation_id: string; new_key_id: string }
  | { status: 'failed'; reason: string; http?: number };

const ACTOR = 'aaaa1111-0000-4000-8000-00000000self';
const OTHER = 'bbbb2222-0000-4000-8000-0000000other';
const REMOVED = 'cccc3333-0000-4000-8000-000000removd';
const APPROVER_B = 'dddd4444-0000-4000-8000-0approverbbb';
const APPROVER_C = 'eeee5555-0000-4000-8000-0approverccc';

const NAME_SELF = 'Cara Cochair';
const NAME_OTHER = 'Otto Other';
const NAME_REMOVED = 'Rita Removed';
const NAME_APPROVER_B = 'Bianca Bystander';
const NAME_APPROVER_C = 'Cy Pendinggrant';
const GRACE_ISO = '2026-10-12T09:00:00.000Z';

function makeRow(over: Partial<RosterRow>): RosterRow {
  return {
    user_id: OTHER,
    roles: ['worker_member'],
    active: true,
    invited_at: '2026-01-05T09:00:00.000Z',
    activated_at: '2026-02-10T09:00:00.000Z',
    deactivated_at: null,
    grace_until: null,
    display_name: 'Fixture Member',
    off_employer_contact: null,
    has_identity_key: true,
    has_live_wrap: true,
    ...over
  };
}

// The acting co-chair's OWN active row (worker_co_chair + worker_member).
const ROW_SELF_COCHAIR = makeRow({
  user_id: ACTOR,
  roles: ['worker_member', 'worker_co_chair'],
  display_name: NAME_SELF
});
// An OTHER active member (not a co-chair) — no picker on actions against them.
const ROW_OTHER_MEMBER = makeRow({ user_id: OTHER, roles: ['worker_member'], display_name: NAME_OTHER });
// A REMOVED member (inactive, in grace) — the Reactivate affordance target.
const ROW_REMOVED = makeRow({
  user_id: REMOVED,
  active: false,
  activated_at: '2026-02-10T09:00:00.000Z',
  deactivated_at: '2026-03-15T09:00:00.000Z',
  grace_until: '2026-06-13T09:00:00.000Z',
  display_name: NAME_REMOVED
});
// A pending-invite row (inactive, NEVER joined) — NO management affordance.
const ROW_PENDING_INVITE = makeRow({
  user_id: 'ffff6666-0000-4000-8000-00pendinginv',
  active: false,
  activated_at: null,
  deactivated_at: null,
  has_identity_key: false,
  has_live_wrap: false,
  display_name: 'Ivan Invited'
});

// Eligible approvers (already self-excluded + active worker-co-chairs, as the
// parent derives). APPROVER_C is a `pending_grant` co-chair (active===true but
// has_live_wrap===false) — the picker MUST still offer them (keyed off the
// active boolean + role, NOT the badge), or it would falsely block an action
// the server allows.
const APPROVER_ROW_B = makeRow({
  user_id: APPROVER_B,
  roles: ['worker_member', 'worker_co_chair'],
  has_live_wrap: true,
  display_name: NAME_APPROVER_B
});
const APPROVER_ROW_C = makeRow({
  user_id: APPROVER_C,
  roles: ['worker_co_chair'],
  has_identity_key: true,
  has_live_wrap: false, // pending_grant co-chair — valid approver per the SQL
  display_name: NAME_APPROVER_C
});

// ---------------------------------------------------------------------------
// Fake management client — records inputs, returns queued results. A queued
// entry may be a Promise (drives the deferred `submitting` state).
// ---------------------------------------------------------------------------

interface ManageCalls {
  setRoles: Array<{ target_user_id: string; roles: string[]; second_approver_id?: string | null }>;
  removeMember: Array<{ target_user_id: string; second_approver_id?: string | null }>;
  reactivateMember: Array<{ target_user_id: string }>;
  rotateOnRemoval: Array<{
    removed_member_id: string;
    remaining_members: ReadonlyArray<{ user_id: string }>;
    resume?: { rotation_id: string; new_key_id: string };
  }>;
}

function fakeClient(opts: {
  setRoles?: Array<SetRolesResult | Promise<SetRolesResult>>;
  remove?: Array<RemoveResult | Promise<RemoveResult>>;
  reactivate?: Array<ReactivateResult | Promise<ReactivateResult>>;
  rotate?: Array<RotationResult | Promise<RotationResult>>;
  throwOn?: 'setRoles' | 'remove' | 'reactivate';
}) {
  const calls: ManageCalls = {
    setRoles: [],
    removeMember: [],
    reactivateMember: [],
    rotateOnRemoval: []
  };
  let si = 0;
  let ri = 0;
  let ai = 0;
  let roti = 0;
  const setQ = opts.setRoles ?? [{ ok: true, data: null }];
  const remQ = opts.remove ?? [{ ok: true, data: GRACE_ISO }];
  const reaQ = opts.reactivate ?? [{ ok: true, data: null }];
  // F182-6 (ADR-0030 Amd C / VC-1) — a rotation-capable client. Its PRESENCE
  // un-gates the Remove CTA (the card's pure-presence gate), matching production:
  // the /committee route ALWAYS wires the crypto deps. Default: a clean
  // `{ status: 'ok' }` so a successful NON-SELF removal auto-rotates and reaches
  // the `committee-manage-rotation-done` terminal.
  const rotQ = opts.rotate ?? [{ status: 'ok' } as RotationResult];
  const client = {
    setRoles: async (input: ManageCalls['setRoles'][number]) => {
      calls.setRoles.push(input);
      if (opts.throwOn === 'setRoles') throw new Error('boom');
      return setQ[Math.min(si++, setQ.length - 1)];
    },
    removeMember: async (input: ManageCalls['removeMember'][number]) => {
      calls.removeMember.push(input);
      if (opts.throwOn === 'remove') throw new Error('boom');
      return remQ[Math.min(ri++, remQ.length - 1)];
    },
    reactivateMember: async (input: ManageCalls['reactivateMember'][number]) => {
      calls.reactivateMember.push(input);
      if (opts.throwOn === 'reactivate') throw new Error('boom');
      return reaQ[Math.min(ai++, reaQ.length - 1)];
    },
    rotateOnRemoval: async (input: ManageCalls['rotateOnRemoval'][number]) => {
      calls.rotateOnRemoval.push(input);
      return rotQ[Math.min(roti++, rotQ.length - 1)];
    }
  };
  return { client, calls };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
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
  client?: ReturnType<typeof fakeClient>['client'];
  calls?: ManageCalls;
  onChanged?: () => void;
} = {}) {
  clearJwt();
  setJwt(makeJwt(ACTOR)); // getCurrentUserId() === ACTOR
  const built = over.client ? { client: over.client, calls: over.calls! } : fakeClient({});
  const member = over.member ?? ROW_OTHER_MEMBER;
  const onChanged = over.onChanged ?? vi.fn();
  const props = {
    member,
    isSelf: over.isSelf ?? member.user_id === ACTOR,
    eligibleApprovers: over.eligibleApprovers ?? [],
    client: built.client,
    onChanged
  };
  const utils = render(CommitteeManageMemberCard, { props: props as never });
  return { ...utils, calls: built.calls, onChanged, member };
}

// ---------------------------------------------------------------------------
// DOM helpers.
// ---------------------------------------------------------------------------

async function openRemoveModal(uid: string) {
  await fireEvent.click(await screen.findByTestId(`committee-manage-remove-cta-${uid}`));
  return screen.findByTestId('committee-remove-modal');
}
async function openRoleModal(uid: string) {
  await fireEvent.click(await screen.findByTestId(`committee-manage-role-cta-${uid}`));
  return screen.findByTestId('committee-role-modal');
}
async function openReactivateModal(uid: string) {
  await fireEvent.click(await screen.findByTestId(`committee-manage-reactivate-cta-${uid}`));
  return screen.findByTestId('committee-reactivate-modal');
}

/** The remove-modal Confirm — labelled confirm_self on the self-row, else confirm. */
function removeConfirm(modal: HTMLElement): HTMLButtonElement {
  return (within(modal).queryByRole('button', { name: t('committee.remove.modal.confirm_self') }) ??
    within(modal).getByRole('button', { name: t('committee.remove.modal.confirm') })) as HTMLButtonElement;
}
function reactivateConfirm(modal: HTMLElement): HTMLButtonElement {
  return within(modal).getByRole('button', { name: t('committee.reactivate.modal.confirm') }) as HTMLButtonElement;
}

/**
 * A control is GATED when it is aria-disabled="true".
 *
 * A11Y-3 corrected expectation (review-fix batch): the gated (pre-submit /
 * submitting) Confirm is gated via `aria-disabled`, NEVER native `disabled`
 * (native disabled drops it from tab order and hides the gating hint). This
 * helper therefore no longer accepts native `disabled` as "gated" — a
 * regression that gated via native `disabled` only would now (correctly) read
 * as ungated. The mechanism itself (aria-disabled, no native disabled, a
 * discoverable aria-describedby hint) is pinned in
 * committee-manage-review-fixes.test.ts.
 */
function isGated(btn: HTMLElement): boolean {
  return btn.getAttribute('aria-disabled') === 'true';
}

/** The picker (native <select>) inside a modal, or null when not rendered. */
function pickerIn(modal: HTMLElement): HTMLSelectElement | null {
  return within(modal).queryByRole('combobox') as HTMLSelectElement | null;
}

/** Eligible option VALUES in the picker (excluding the disabled placeholder). */
function pickerOptionValues(select: HTMLSelectElement): string[] {
  return Array.from(select.querySelectorAll('option'))
    .map((o) => (o as HTMLOptionElement).value)
    .filter((v) => v !== '');
}

async function selectApprover(select: HTMLSelectElement, uid: string) {
  await fireEvent.change(select, { target: { value: uid } });
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
// AFFORDANCE-BY-BADGE (state matrix) — which row gets which control.
// ===========================================================================

describe('P1-8e [edge] per-row affordances keyed off badgeKind', () => {
  it('an ACTIVE member row shows Change role + Remove, and NO Reactivate', async () => {
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false });
    expect(await screen.findByTestId(`committee-manage-role-cta-${OTHER}`)).toBeDefined();
    expect(screen.getByTestId(`committee-manage-remove-cta-${OTHER}`)).toBeDefined();
    expect(screen.queryByTestId(`committee-manage-reactivate-cta-${OTHER}`)).toBeNull();
  });

  it('an INACTIVE (removed, in grace) row shows Reactivate only — no Change role / Remove', async () => {
    renderCard({ member: ROW_REMOVED, isSelf: false });
    expect(await screen.findByTestId(`committee-manage-reactivate-cta-${REMOVED}`)).toBeDefined();
    expect(screen.queryByTestId(`committee-manage-role-cta-${REMOVED}`)).toBeNull();
    expect(screen.queryByTestId(`committee-manage-remove-cta-${REMOVED}`)).toBeNull();
  });

  it('a PENDING-INVITE row (never joined) shows NO management control', async () => {
    const { container } = renderCard({ member: ROW_PENDING_INVITE, isSelf: false });
    const uid = ROW_PENDING_INVITE.user_id;
    expect(screen.queryByTestId(`committee-manage-role-cta-${uid}`)).toBeNull();
    expect(screen.queryByTestId(`committee-manage-remove-cta-${uid}`)).toBeNull();
    expect(screen.queryByTestId(`committee-manage-reactivate-cta-${uid}`)).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('the acting co-chair OWN row still shows Change role + Remove and a "You" chip', async () => {
    renderCard({ member: ROW_SELF_COCHAIR, isSelf: true, eligibleApprovers: [APPROVER_ROW_B] });
    expect(await screen.findByTestId(`committee-manage-role-cta-${ACTOR}`)).toBeDefined();
    expect(screen.getByTestId(`committee-manage-remove-cta-${ACTOR}`)).toBeDefined();
    // Self is unmistakable — a TEXT chip, never color-only.
    expect(screen.getByText(t('committee.manage.you_chip'))).toBeDefined();
  });
});

// ===========================================================================
// FINDING 1 (F-181, threat-model :4046) — TERMINAL only from the server return.
// ===========================================================================

describe('P1-8e [F-181 :4046] terminal `done` renders ONLY on a clean server return', () => {
  it('a clean NON-SELF success → the rotation-done terminal, and NOT any denial/failed state', async () => {
    const built = fakeClient({ remove: [{ ok: true, data: GRACE_ISO }] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls });
    const modal = await openRemoveModal(OTHER);
    await fireEvent.click(removeConfirm(modal));
    // F182-6 (ADR-0030 Amd C): a clean OTHER-member removal AUTO-ROTATES the
    // committee key in the same action, so the server-truthed success terminal is
    // the rotation-done state — NOT the governance `done` (self-removal-only) one.
    await screen.findByTestId('committee-manage-rotation-done');
    expect(screen.queryByTestId('committee-manage-done')).toBeNull();
    expect(screen.queryByTestId('committee-manage-4eyes')).toBeNull();
    expect(screen.queryByTestId('committee-manage-last-co-chair')).toBeNull();
    expect(screen.queryByTestId('committee-manage-failed')).toBeNull();
  });

  it('a `4eyes_required` return → the 4eyes state, NEVER `done`', async () => {
    const built = fakeClient({ remove: [{ ok: false, reason: '4eyes_required', status: 403 }] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls });
    const modal = await openRemoveModal(OTHER);
    await fireEvent.click(removeConfirm(modal));
    await screen.findByTestId('committee-manage-4eyes');
    expect(screen.queryByTestId('committee-manage-done')).toBeNull();
  });

  it('a `last_co_chair` return → the blocked state, NEVER `done`', async () => {
    const built = fakeClient({ remove: [{ ok: false, reason: 'last_co_chair', status: 409 }] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls });
    const modal = await openRemoveModal(OTHER);
    await fireEvent.click(removeConfirm(modal));
    await screen.findByTestId('committee-manage-last-co-chair');
    expect(screen.queryByTestId('committee-manage-done')).toBeNull();
  });

  it('a discriminated failure (500) → `failed`, NEVER a false `done`', async () => {
    const built = fakeClient({ remove: [{ ok: false, reason: 'unknown', status: 500 }] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls });
    const modal = await openRemoveModal(OTHER);
    await fireEvent.click(removeConfirm(modal));
    await screen.findByTestId('committee-manage-failed');
    expect(screen.queryByTestId('committee-manage-done')).toBeNull();
  });

  it('a THROWN client op → `failed` (no crash, no false `done`)', async () => {
    const built = fakeClient({ throwOn: 'remove' });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls });
    const modal = await openRemoveModal(OTHER);
    await fireEvent.click(removeConfirm(modal));
    await screen.findByTestId('committee-manage-failed');
    expect(screen.queryByTestId('committee-manage-done')).toBeNull();
  });

  it('while the RPC is in flight the card is `submitting`, NOT optimistically a success terminal', async () => {
    const d = deferred<RemoveResult>();
    const built = fakeClient({ remove: [d.promise] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls });
    const modal = await openRemoveModal(OTHER);
    await fireEvent.click(removeConfirm(modal));
    // Pending: the loading state is shown, but there is NO premature success.
    await screen.findByTestId('committee-manage-submitting');
    expect(screen.queryByTestId('committee-manage-rotation-done')).toBeNull();
    expect(screen.queryByTestId('committee-manage-done')).toBeNull();
    // Only once the server confirms (removeMember ok → auto-rotation ok) does the
    // rotation-done success terminal appear (F182-6 auto-rotate on NON-SELF removal).
    d.resolve({ ok: true, data: GRACE_ISO });
    await screen.findByTestId('committee-manage-rotation-done');
  });

  it('a clean success signals the parent to re-fetch the roster (no optimistic local flip)', async () => {
    const onChanged = vi.fn();
    const built = fakeClient({ remove: [{ ok: true, data: GRACE_ISO }] });
    const { component } = renderCard({
      member: ROW_OTHER_MEMBER,
      isSelf: false,
      client: built.client,
      calls: built.calls,
      onChanged
    });
    let eventFired = 0;
    try {
      (component as unknown as { $on?: (e: string, cb: () => void) => void })?.$on?.('changed', () => {
        eventFired += 1;
      });
    } catch {
      /* Svelte-5 legacy $on may be unavailable — the callback prop is the pin */
    }
    const modal = await openRemoveModal(OTHER);
    await fireEvent.click(removeConfirm(modal));
    // F182-6: a clean NON-SELF removal auto-rotates → the rotation-done terminal is
    // where the server-truthed refetch signal fires (never mid-flight, F-181).
    await screen.findByTestId('committee-manage-rotation-done');
    // The refetch signal fired (callback prop OR the `changed` event).
    await waitFor(() => expect(onChanged.mock.calls.length + eventFired).toBeGreaterThanOrEqual(1));
  });

  it('a DENIAL does NOT signal a roster re-fetch (no success event on a rejected op)', async () => {
    const onChanged = vi.fn();
    const built = fakeClient({ remove: [{ ok: false, reason: 'last_co_chair', status: 409 }] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls, onChanged });
    const modal = await openRemoveModal(OTHER);
    await fireEvent.click(removeConfirm(modal));
    await screen.findByTestId('committee-manage-last-co-chair');
    expect(onChanged).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// FINDING 2 (F-181 :4047) — the second-approver picker: self-action-only,
// exclude-self, distinct-eligible, no dead-end on an empty list.
// ===========================================================================

describe('P1-8e [F-181 :4047] second-approver picker — self-action-only + exclude-self', () => {
  it('SELF-remove (drops co-chair) reveals the picker; Confirm stays gated until an approver is chosen', async () => {
    const built = fakeClient({ remove: [{ ok: true, data: GRACE_ISO }] });
    renderCard({
      member: ROW_SELF_COCHAIR,
      isSelf: true,
      eligibleApprovers: [APPROVER_ROW_B, APPROVER_ROW_C],
      client: built.client,
      calls: built.calls
    });
    const modal = await openRemoveModal(ACTOR);
    const select = pickerIn(modal);
    expect(select, 'the 4-eyes picker is shown on a self-remove').not.toBeNull();
    // Confirm is gated until a distinct approver is selected.
    expect(isGated(removeConfirm(modal)), 'Confirm gated before an approver is chosen').toBe(true);
    // Clicking the gated Confirm must NOT fire the op (defense-in-depth).
    await fireEvent.click(removeConfirm(modal));
    expect(built.calls.removeMember.length).toBe(0);
    // Choose a distinct approver → Confirm ungated.
    await selectApprover(select!, APPROVER_B);
    await waitFor(() => expect(isGated(removeConfirm(modal))).toBe(false));
  });

  it("the picker lists ONLY the eligible approvers and NEVER the acting co-chair (self excluded)", async () => {
    renderCard({
      member: ROW_SELF_COCHAIR,
      isSelf: true,
      eligibleApprovers: [APPROVER_ROW_B, APPROVER_ROW_C]
    });
    const modal = await openRemoveModal(ACTOR);
    const select = pickerIn(modal)!;
    const values = pickerOptionValues(select);
    expect(new Set(values)).toEqual(new Set([APPROVER_B, APPROVER_C]));
    // The acting co-chair (== the self target) is NEVER a selectable approver.
    expect(values).not.toContain(ACTOR);
  });

  it('a `pending_grant` co-chair (active, no live wrap) IS offered as an approver (keyed off active+role, NOT the badge)', async () => {
    renderCard({
      member: ROW_SELF_COCHAIR,
      isSelf: true,
      eligibleApprovers: [APPROVER_ROW_C] // active worker_co_chair, has_live_wrap === false
    });
    const modal = await openRemoveModal(ACTOR);
    const values = pickerOptionValues(pickerIn(modal)!);
    expect(values).toContain(APPROVER_C);
  });

  it('a self-remove forwards the CHOSEN distinct approver (≠ actor) to the client', async () => {
    const built = fakeClient({ remove: [{ ok: true, data: GRACE_ISO }] });
    renderCard({
      member: ROW_SELF_COCHAIR,
      isSelf: true,
      eligibleApprovers: [APPROVER_ROW_B],
      client: built.client,
      calls: built.calls
    });
    const modal = await openRemoveModal(ACTOR);
    await selectApprover(pickerIn(modal)!, APPROVER_B);
    await fireEvent.click(removeConfirm(modal));
    await waitFor(() => expect(built.calls.removeMember.length).toBe(1));
    const sent = built.calls.removeMember[0]!;
    expect(sent.second_approver_id).toBe(APPROVER_B);
    expect(sent.second_approver_id).not.toBe(ACTOR); // never self-approval
  });

  it('an OTHER-member action shows NO picker and Confirm is enabled immediately', async () => {
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, eligibleApprovers: [APPROVER_ROW_B] });
    const modal = await openRemoveModal(OTHER);
    expect(pickerIn(modal), 'no picker on an other-member removal').toBeNull();
    expect(isGated(removeConfirm(modal))).toBe(false);
  });

  it('an EMPTY eligible list shows NO picker and leaves Confirm ENABLED (self-removal must not dead-end)', async () => {
    const built = fakeClient({ remove: [{ ok: false, reason: 'last_co_chair', status: 409 }] });
    renderCard({
      member: ROW_SELF_COCHAIR,
      isSelf: true,
      eligibleApprovers: [], // actor is the only active worker co-chair
      client: built.client,
      calls: built.calls
    });
    const modal = await openRemoveModal(ACTOR);
    expect(pickerIn(modal), 'no picker when no eligible approver can exist').toBeNull();
    // Confirm is NOT gated on an approver that cannot exist — the server truths it.
    expect(isGated(removeConfirm(modal))).toBe(false);
    await fireEvent.click(removeConfirm(modal));
    // The server-truthed last_co_chair block renders (from the reason, not the count).
    await screen.findByTestId('committee-manage-last-co-chair');
  });

  it('Change role: a self-drop of worker_co_chair reveals the picker; keeping co-chair does NOT', async () => {
    renderCard({
      member: ROW_SELF_COCHAIR,
      isSelf: true,
      eligibleApprovers: [APPROVER_ROW_B]
    });
    const modal = await openRoleModal(ACTOR);
    // Current selection keeps worker_co_chair → no self-drop → no picker.
    expect(pickerIn(modal)).toBeNull();
    // Uncheck worker_co_chair (self-drop) → the picker appears.
    const coChairBox = within(modal).getByRole('checkbox', {
      name: t('committee.roster.role.worker_co_chair')
    });
    await fireEvent.click(coChairBox);
    await waitFor(() => expect(pickerIn(modal)).not.toBeNull());
    // Re-check worker_co_chair → no longer a self-drop → the picker disappears.
    await fireEvent.click(coChairBox);
    await waitFor(() => expect(pickerIn(modal)).toBeNull());
  });
});

// ===========================================================================
// FINDING 3 (F-181 :4048) — last_co_chair is SERVER-truthed, never a client count.
// ===========================================================================

describe('P1-8e [F-181 :4048] last_co_chair is keyed off the SERVER reason, not a client count', () => {
  it('an empty eligible list does NOT render the last_co_chair block until the server returns it', async () => {
    const built = fakeClient({ remove: [{ ok: false, reason: 'last_co_chair', status: 409 }] });
    renderCard({
      member: ROW_SELF_COCHAIR,
      isSelf: true,
      eligibleApprovers: [],
      client: built.client,
      calls: built.calls
    });
    const modal = await openRemoveModal(ACTOR);
    // BEFORE the server call: no last_co_chair block (the empty list alone must
    // NOT trigger the block — that would be a client-side count gate).
    expect(within(modal).queryByTestId('committee-manage-last-co-chair')).toBeNull();
    // AFTER Confirm → the server reason drives the block.
    await fireEvent.click(removeConfirm(modal));
    await screen.findByTestId('committee-manage-last-co-chair');
  });

  it('a NON-empty eligible list that the server nonetheless rejects last_co_chair still renders the block', async () => {
    // Server-truthed: even though the UI has an approver to offer, only the
    // server decides last_co_chair (e.g. concurrent demotion).
    const built = fakeClient({ remove: [{ ok: false, reason: 'last_co_chair', status: 409 }] });
    renderCard({
      member: ROW_SELF_COCHAIR,
      isSelf: true,
      eligibleApprovers: [APPROVER_ROW_B],
      client: built.client,
      calls: built.calls
    });
    const modal = await openRemoveModal(ACTOR);
    await selectApprover(pickerIn(modal)!, APPROVER_B);
    await fireEvent.click(removeConfirm(modal));
    await screen.findByTestId('committee-manage-last-co-chair');
    expect(screen.queryByTestId('committee-manage-done')).toBeNull();
  });
});

// ===========================================================================
// FINDING 4 (F-181 :4049) — reasons discriminated, never collapsed to generic.
// ===========================================================================

describe('P1-8e [F-181 :4049] reasons discriminated — distinct copy per reason', () => {
  it('4eyes_required vs last_co_chair render DISTINCT blocks with distinct headings', async () => {
    const built4 = fakeClient({ remove: [{ ok: false, reason: '4eyes_required', status: 403 }] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built4.client, calls: built4.calls });
    let modal = await openRemoveModal(OTHER);
    await fireEvent.click(removeConfirm(modal));
    const fourEyes = await screen.findByTestId('committee-manage-4eyes');
    expect(fourEyes.textContent ?? '').toContain(t('committee.manage.fourEyes.heading'));
    cleanup();

    const builtL = fakeClient({ remove: [{ ok: false, reason: 'last_co_chair', status: 409 }] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: builtL.client, calls: builtL.calls });
    modal = await openRemoveModal(OTHER);
    await fireEvent.click(removeConfirm(modal));
    const lastCoChair = await screen.findByTestId('committee-manage-last-co-chair');
    expect(lastCoChair.textContent ?? '').toContain(t('committee.manage.lastCoChair.heading'));
  });

  it('invalid_role and not_found render DISTINCT failed bodies (never the same generic string)', async () => {
    const builtIR = fakeClient({ setRoles: [{ ok: false, reason: 'invalid_role', status: 422 }] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: builtIR.client, calls: builtIR.calls });
    let modal = await openRoleModal(OTHER);
    // Make a change so Confirm isn't a no-op, then submit → invalid_role.
    await fireEvent.click(within(modal).getByRole('checkbox', { name: t('committee.roster.role.certified_member') }));
    await fireEvent.click(within(modal).getByRole('button', { name: t('committee.role.modal.confirm') }));
    const failedIR = await screen.findByTestId('committee-manage-failed');
    const invalidRoleText = failedIR.textContent ?? '';
    expect(invalidRoleText).toContain(t('committee.role.failed.invalid_role.body'));
    cleanup();

    const builtNF = fakeClient({ remove: [{ ok: false, reason: 'not_found', status: 404 }] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: builtNF.client, calls: builtNF.calls });
    modal = await openRemoveModal(OTHER);
    await fireEvent.click(removeConfirm(modal));
    const failedNF = await screen.findByTestId('committee-manage-failed');
    const notFoundText = failedNF.textContent ?? '';
    expect(notFoundText).toContain(t('committee.manage.failed.not_found_body'));
    // The two failure bodies are genuinely discriminated (not one shared string).
    expect(notFoundText).not.toBe(invalidRoleText);
  });

  it('no discriminated state echoes the raw reason enum (F-176 posture)', async () => {
    for (const reason of ['4eyes_required', 'last_co_chair', 'not_found'] as CommitteeOpReason[]) {
      const built = fakeClient({ remove: [{ ok: false, reason, status: 409 }] });
      const { container } = renderCard({
        member: ROW_OTHER_MEMBER,
        isSelf: false,
        client: built.client,
        calls: built.calls
      });
      const modal = await openRemoveModal(OTHER);
      await fireEvent.click(removeConfirm(modal));
      await waitFor(() =>
        expect(
          screen.queryByTestId('committee-manage-4eyes') ??
            screen.queryByTestId('committee-manage-last-co-chair') ??
            screen.queryByTestId('committee-manage-failed')
        ).not.toBeNull()
      );
      expect(container.textContent ?? '').not.toContain(reason);
      expect(container.textContent ?? '').not.toContain('rls_denied');
      cleanup();
    }
  });
});

// ===========================================================================
// FINDING 5 (F-160) — blocking/error copy names NO other member.
// ===========================================================================

describe('P1-8e [F-160] blocking/error copy names no other member', () => {
  const OTHER_NAMES = [NAME_OTHER, NAME_APPROVER_B, NAME_APPROVER_C];
  const OTHER_UIDS = [OTHER, APPROVER_B, APPROVER_C];

  it('the last_co_chair block names no member (not the self target, not any approver)', async () => {
    const built = fakeClient({ remove: [{ ok: false, reason: 'last_co_chair', status: 409 }] });
    renderCard({
      member: ROW_SELF_COCHAIR,
      isSelf: true,
      eligibleApprovers: [],
      client: built.client,
      calls: built.calls
    });
    const modal = await openRemoveModal(ACTOR);
    await fireEvent.click(removeConfirm(modal));
    const block = await screen.findByTestId('committee-manage-last-co-chair');
    const text = block.textContent ?? '';
    for (const n of [NAME_SELF, ...OTHER_NAMES]) expect(text).not.toContain(n);
    for (const u of [ACTOR, ...OTHER_UIDS]) expect(text).not.toContain(u);
  });

  it('the 4eyes_required block names no approver / no target', async () => {
    // Stale-approver path: an approver was chosen but the server returned 4eyes.
    const built = fakeClient({ remove: [{ ok: false, reason: '4eyes_required', status: 403 }] });
    renderCard({
      member: ROW_SELF_COCHAIR,
      isSelf: true,
      eligibleApprovers: [APPROVER_ROW_B, APPROVER_ROW_C],
      client: built.client,
      calls: built.calls
    });
    const modal = await openRemoveModal(ACTOR);
    await selectApprover(pickerIn(modal)!, APPROVER_B);
    await fireEvent.click(removeConfirm(modal));
    const block = await screen.findByTestId('committee-manage-4eyes');
    const text = block.textContent ?? '';
    for (const n of [NAME_SELF, ...OTHER_NAMES]) expect(text).not.toContain(n);
    for (const u of [ACTOR, ...OTHER_UIDS]) expect(text).not.toContain(u);
  });

  it('the failed block names no other member', async () => {
    const built = fakeClient({ remove: [{ ok: false, reason: 'not_found', status: 404 }] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls });
    const modal = await openRemoveModal(OTHER);
    await fireEvent.click(removeConfirm(modal));
    const block = await screen.findByTestId('committee-manage-failed');
    const text = block.textContent ?? '';
    expect(text).not.toContain(NAME_OTHER);
    expect(text).not.toContain(OTHER);
  });
});

// ===========================================================================
// FINDING 6 — remove-confirm copy honesty.
//
// RECONCILED for F182-6 (ADR-0030 Amd C / AC-C12): under AUTO-ROTATE the OLD
// assertion ("does not rotate the shared key") is now FALSE — removal DOES rotate
// the committee key. This render-level assertion is the sibling of the stale
// i18n-catalog assertion the ADR calls the live-contradiction BLOCKER; it is
// replaced here with the F-189 forward-secrecy contract so the implementer's copy
// rewrite is not blocked by an unsatisfiable test. RED until the copy is rewritten:
// the current en-CA.json still renders "does not rotate …", so the "from now on"
// match fails until F182-6 lands.
// ===========================================================================

const FORBIDDEN_REVOCATION_RENDER =
  /revokes? access to committee data|can no longer decrypt|loses? access to (the )?data|cryptographically remove|removes? access to (existing|all) committee data/i;

describe('P1-8e [F-189/AC-C12] remove-confirm copy states forward-secrecy ("from now on"), never absolute revocation', () => {
  it('the rendered remove-confirm UI states the forward-secrecy cutover + the retroactive limit', async () => {
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false });
    const modal = await openRemoveModal(OTHER);
    const text = modal.textContent ?? '';
    // Honest forward-secrecy: rotating the key protects data filed FROM NOW ON,
    // and cannot retroactively protect earlier records.
    expect(text).toMatch(/from now on/i);
    expect(text).toMatch(/cannot retroactively protect earlier records/i);
  });

  it('the rendered remove-confirm UI contains NO absolute/retroactive data-access-revocation claim', async () => {
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false });
    const modal = await openRemoveModal(OTHER);
    const text = modal.textContent ?? '';
    expect(text).not.toMatch(FORBIDDEN_REVOCATION_RENDER);
  });
});

// ===========================================================================
// Adversarial F2 (F-189 honest-copy BLOCKER, round-1 closure fix). `submitRemove`
// SKIPS the key rotation for a SELF removal (the leaver cannot run it), yet the
// remove-confirm modal renders `committee.remove.modal.limit` ("Removing {name}
// rotates the committee key … from now on …") UNCONDITIONALLY — promising a
// rotation the self path never performs. The fix renders a self variant
// `committee.remove.modal.limit_self` when `isSelf` (key NOT rotated from this
// device; a remaining worker co-chair must rotate it). RED today: the isSelf=true
// modal still renders the forward-secrecy `modal.limit`, so the "rotates the
// committee key" / "from now on" / "protected from" claims are present.
//
// This is the RENDER-level check the context-free i18n-catalog test cannot make.
// ===========================================================================

describe('P1-8e [Adversarial F2/F-189] self-removal confirm copy does not over-claim a rotation the self path skips', () => {
  // A self member (worker_member only) — a self-remove of a non-co-chair reveals no
  // 4-eyes picker, keeping the modal copy under test uncluttered. This describe owns
  // this fixture.
  const ROW_SELF_MEMBER = makeRow({ user_id: ACTOR, roles: ['worker_member'], display_name: NAME_SELF });

  it('isSelf=true remove-confirm copy makes NO rotation claim, and says a remaining co-chair must rotate', async () => {
    renderCard({ member: ROW_SELF_MEMBER, isSelf: true });
    const modal = await openRemoveModal(ACTOR);
    const text = modal.textContent ?? '';
    // The self path rotates nothing from this device — the confirm step must not promise it.
    expect(text, 'self-confirm must not claim the removal rotates the key').not.toMatch(
      /rotates the committee key/i
    );
    expect(text, 'self-confirm must not claim a forward-secrecy cutover ("from now on")').not.toMatch(
      /from now on/i
    );
    expect(text, 'self-confirm must not claim the removed device is "protected from" anything').not.toMatch(
      /protected from/i
    );
    // It DOES convey a remaining worker co-chair must still rotate the key.
    expect(text, 'self-confirm must say a remaining co-chair still needs to rotate').toMatch(
      /remaining .*co-?chair.*rotate|co-?chair.*must .*rotate/i
    );
  });

  it('CONTROL — isSelf=false remove-confirm copy is UNCHANGED (still states the "from now on" forward-secrecy cutover)', async () => {
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false });
    const modal = await openRemoveModal(OTHER);
    const text = modal.textContent ?? '';
    expect(text, 'the non-self path still gets the forward-secrecy modal.limit copy').toMatch(/from now on/i);
    expect(text, 'the non-self path still frames the removal as rotating the committee key').toMatch(
      /rotates the committee key/i
    );
  });
});

// ===========================================================================
// FINDING 7 (F-182 :4092) — reactivate copy states RETAINED-wrap honesty.
// ===========================================================================

describe('P1-8e [F-182 :4092] reactivate-confirm copy surfaces the retained wrap (no fresh-grant claim)', () => {
  it('the rendered reactivate-confirm UI states access returns via the RETAINED wrap', async () => {
    renderCard({ member: ROW_REMOVED, isSelf: false });
    const modal = await openReactivateModal(REMOVED);
    const text = modal.textContent ?? '';
    expect(text).toMatch(/already had|retained|nothing is re-issued|not re-issued/i);
  });

  it('the rendered reactivate-confirm UI does NOT present reactivation as a fresh grant / re-grant ceremony', async () => {
    renderCard({ member: ROW_REMOVED, isSelf: false });
    const modal = await openReactivateModal(REMOVED);
    const text = modal.textContent ?? '';
    expect(text).not.toMatch(/fresh grant|re-?grant\b|grant ceremony|ceremony 4|re-?issues (the |their )?key/i);
  });

  it('a clean reactivate returns `done` only from the server (no optimistic restore)', async () => {
    const d = deferred<ReactivateResult>();
    const built = fakeClient({ reactivate: [d.promise] });
    renderCard({ member: ROW_REMOVED, isSelf: false, client: built.client, calls: built.calls });
    const modal = await openReactivateModal(REMOVED);
    await fireEvent.click(reactivateConfirm(modal));
    await screen.findByTestId('committee-manage-submitting');
    expect(screen.queryByTestId('committee-manage-done')).toBeNull();
    d.resolve({ ok: true, data: null });
    await screen.findByTestId('committee-manage-done');
  });

  it('a reactivate `already_active` return → the discriminated failed body (not done)', async () => {
    const built = fakeClient({ reactivate: [{ ok: false, reason: 'already_active', status: 409 }] });
    renderCard({ member: ROW_REMOVED, isSelf: false, client: built.client, calls: built.calls });
    const modal = await openReactivateModal(REMOVED);
    await fireEvent.click(reactivateConfirm(modal));
    const failed = await screen.findByTestId('committee-manage-failed');
    expect(failed.textContent ?? '').toContain(t('committee.reactivate.failed.already_active.body'));
    expect(screen.queryByTestId('committee-manage-done')).toBeNull();
  });
});
