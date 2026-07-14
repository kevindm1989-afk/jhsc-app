/**
 * ADR-0029 P1-8e review-fix batch — CommitteeManageMemberCard a11y + governance
 * corrections (card-level).
 *
 * RED-FIRST. The implementer treats this file as READ-ONLY. Each describe pins a
 * DECIDED fix as an OUTCOME the current 0e2045e card fails:
 *
 *   ADV-3 (stale-roster 4eyes dead-end) — when eligibleApprovers is empty (a
 *     stale snapshot) but the server returns `4eyes_required` (a co-chair was
 *     added elsewhere), the card enters `fourEyes` with no picker AND shows BOTH
 *     "choose an approving co-chair" and "no other co-chair available", with an
 *     UNGATED Confirm that resubmits `null` in a loop. Decided fix: render a
 *     single coherent "refetch to pick an approver" affordance
 *     (data-testid `committee-manage-refetch-approver`) that calls onChanged(),
 *     GATE Confirm, and DROP the contradictory empty-note.
 *
 *   A11Y-1 (focus-trap boundary) — the modal keydown trap only wraps when focus
 *     is exactly on `first`/`last`; from the dialog/heading boundary it lets Tab
 *     escape. Decided fix: treat "activeElement is the dialog/heading or not in
 *     the focusables set" as a boundary → Shift+Tab focuses `last`.
 *
 *   A11Y-2 (body scroll lock) — decided fix: lock `document.body.style.overflow`
 *     to 'hidden' on open, restore on close.
 *
 *   A11Y-3 (gated Confirm focusable + discoverable hint) — the gated Confirm uses
 *     NATIVE `disabled` (removed from tab order; hint undiscoverable) and the
 *     empty-role-selection gate has no hint at all. Decided fix: use
 *     `aria-disabled="true"` (never native `disabled`) for the gated pre-submit
 *     state and wire `aria-describedby` to a non-empty hint for BOTH the
 *     approver-required and the empty-role-selection cases.
 *
 *   A11Y-4 (submitting live region outside the aria-busy subtree) — the
 *     `role="status"` submitting announce sits inside the `aria-busy="true"`
 *     dialog. Decided fix: render it OUTSIDE any aria-busy subtree.
 *
 * Determinism: frozen clock; closure fake recording inputs (+ deferred promises
 * for the submitting state); fixed fixtures owned by this file; no sleeps, no
 * real network/RNG/clock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/svelte';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
import { setJwt, clearJwt } from '../../src/lib/auth/session-jwt-store';
import { t } from '../../src/lib/i18n';
import type { RosterRow, CommitteeOpReason } from '../../src/lib/committee/supabase-committee-client';

import CommitteeManageMemberCard from '../../src/lib/committee/CommitteeManageMemberCard.svelte';

// ---------------------------------------------------------------------------
// Fixtures (this file owns them). Synthetic — no real PII.
// ---------------------------------------------------------------------------

type OpOk<T> = { ok: true; data: T };
type OpErr = { ok: false; reason: CommitteeOpReason; status: number };
type SetRolesResult = OpOk<null> | OpErr;
type RemoveResult = OpOk<string> | OpErr;
type ReactivateResult = OpOk<null> | OpErr;

const ACTOR = 'aaaa1111-0000-4000-8000-00000000self';
const OTHER = 'bbbb2222-0000-4000-8000-0000000other';
const APPROVER_B = 'dddd4444-0000-4000-8000-0approverbbb';
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

const ROW_SELF_COCHAIR = makeRow({
  user_id: ACTOR,
  roles: ['worker_member', 'worker_co_chair'],
  display_name: 'Cara Cochair'
});
const ROW_OTHER_MEMBER = makeRow({ user_id: OTHER, roles: ['worker_member'], display_name: 'Otto Other' });
const APPROVER_ROW_B = makeRow({
  user_id: APPROVER_B,
  roles: ['worker_member', 'worker_co_chair'],
  has_live_wrap: true,
  display_name: 'Bianca Bystander'
});

// ---------------------------------------------------------------------------
// Closure fake client — records inputs, returns queued results (may be a Promise
// to drive the deferred `submitting` state).
// ---------------------------------------------------------------------------

interface ManageCalls {
  setRoles: Array<{ target_user_id: string; roles: string[]; second_approver_id?: string | null }>;
  removeMember: Array<{ target_user_id: string; second_approver_id?: string | null }>;
  reactivateMember: Array<{ target_user_id: string }>;
}

function fakeClient(opts: {
  setRoles?: Array<SetRolesResult | Promise<SetRolesResult>>;
  remove?: Array<RemoveResult | Promise<RemoveResult>>;
  reactivate?: Array<ReactivateResult | Promise<ReactivateResult>>;
}) {
  const calls: ManageCalls = { setRoles: [], removeMember: [], reactivateMember: [] };
  let si = 0;
  let ri = 0;
  let ai = 0;
  const setQ = opts.setRoles ?? [{ ok: true, data: null }];
  const remQ = opts.remove ?? [{ ok: true, data: GRACE_ISO }];
  const reaQ = opts.reactivate ?? [{ ok: true, data: null }];
  const client = {
    setRoles: async (input: ManageCalls['setRoles'][number]) => {
      calls.setRoles.push(input);
      return setQ[Math.min(si++, setQ.length - 1)];
    },
    removeMember: async (input: ManageCalls['removeMember'][number]) => {
      calls.removeMember.push(input);
      return remQ[Math.min(ri++, remQ.length - 1)];
    },
    reactivateMember: async (input: ManageCalls['reactivateMember'][number]) => {
      calls.reactivateMember.push(input);
      return reaQ[Math.min(ai++, reaQ.length - 1)];
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

function removeConfirm(modal: HTMLElement): HTMLButtonElement {
  return (within(modal).queryByRole('button', { name: t('committee.remove.modal.confirm_self') }) ??
    within(modal).getByRole('button', {
      name: t('committee.remove.modal.confirm')
    })) as HTMLButtonElement;
}

/** A11Y-3 corrected expectation: a gated Confirm is gated via aria-disabled — the
 *  native `disabled` acceptance is intentionally NOT honoured here. */
function isGated(btn: HTMLElement): boolean {
  return btn.getAttribute('aria-disabled') === 'true';
}

/** The dialog's focusable set (the component's own focus-trap selector). */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  const sel =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => el.getAttribute('aria-hidden') !== 'true'
  );
}

/** The concatenated text of every element aria-describedby points at. */
function describedByText(btn: HTMLElement): string {
  const ids = (btn.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  return ids
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();
}

async function flushMicrotasks() {
  for (let i = 0; i < 4; i++) await tick();
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

beforeEach(() => {
  freezeClock();
  __resetCapture();
  __setTestSink();
  clearJwt();
  document.body.style.overflow = '';
});
afterEach(() => {
  cleanup();
  clearJwt();
  // NOTE: intentionally do NOT reset document.body.style.overflow here — cleanup()
  // unmounts the card, whose onDestroy() must itself release the scroll-lock. A
  // reset here would mask a stranded-lock regression (the exact tell that hid the
  // original bug). The beforeEach reset guarantees a clean start per test.
  __resetCapture();
  vi.restoreAllMocks();
  restoreClock();
});

// ===========================================================================
// FINDING 3 (ADV-3) — stale-roster 4eyes dead-end is a single coherent refetch
// path, gated, no null resubmit loop.
// ===========================================================================

describe('P1-8e review-fix [ADV-3] stale-roster 4eyes is a single coherent refetch path (no dead-end loop)', () => {
  // Self co-chair, empty eligible snapshot, server returns 4eyes_required (a
  // co-chair was added elsewhere). Enter the stale state via a null-approver
  // submit, then assert the corrected behavior.
  async function enterStaleFourEyes() {
    const built = fakeClient({
      remove: [
        { ok: false, reason: '4eyes_required', status: 403 },
        { ok: false, reason: '4eyes_required', status: 403 }
      ]
    });
    const onChanged = vi.fn();
    renderCard({
      member: ROW_SELF_COCHAIR,
      isSelf: true,
      eligibleApprovers: [],
      client: built.client,
      calls: built.calls,
      onChanged
    });
    const modal = await openRemoveModal(ACTOR);
    // Empty eligible + self-drop → no picker → Confirm submits with null approver.
    await fireEvent.click(removeConfirm(modal));
    await waitFor(() => expect(built.calls.removeMember.length).toBe(1));
    return { modal, calls: built.calls, onChanged };
  }

  it('renders the single "refetch to pick an approver" affordance, NOT the contradictory empty-approver note', async () => {
    await enterStaleFourEyes();
    // The coherent recovery path — refetch the roster to reveal the new co-chair.
    expect(
      screen.queryByTestId('committee-manage-refetch-approver'),
      'the stale-4eyes state offers a refetch affordance'
    ).not.toBeNull();
    // The contradictory "no other co-chair available" note must NOT show at the
    // same time as the "needs a second co-chair" 4eyes alert.
    expect(
      screen.queryByText(t('committee.approver.none_heading')),
      'the contradictory empty-approver note is dropped in the stale-4eyes state'
    ).toBeNull();
  });

  it('GATES Confirm in the stale-4eyes state (no ungated null resubmit)', async () => {
    const { modal } = await enterStaleFourEyes();
    expect(
      isGated(removeConfirm(modal)),
      'Confirm is gated once the stale-4eyes dead-end is reached'
    ).toBe(true);
  });

  it('does NOT resubmit `null` in a loop — a Confirm click in the stale state fires no second op', async () => {
    const { modal, calls } = await enterStaleFourEyes();
    await fireEvent.click(removeConfirm(modal));
    await flushMicrotasks();
    expect(calls.removeMember.length, 'a gated Confirm must not resubmit the null-approver op').toBe(1);
  });

  it('the refetch affordance re-fetches the roster (invokes onChanged)', async () => {
    const { onChanged } = await enterStaleFourEyes();
    const refetch = await screen.findByTestId('committee-manage-refetch-approver');
    await fireEvent.click(refetch);
    expect(onChanged, 'activating the refetch affordance re-runs the roster read').toHaveBeenCalled();
  });
});

// ===========================================================================
// FINDING 4 (A11Y-1) — focus-trap boundary: Shift+Tab from the dialog boundary
// wraps to the LAST focusable, never escaping the dialog.
// ===========================================================================

describe('P1-8e review-fix [A11Y-1] focus-trap boundary keeps focus inside the dialog', () => {
  it('Shift+Tab while focus is on the dialog heading wraps to the last focusable (does not escape)', async () => {
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false });
    const modal = await openRemoveModal(OTHER);
    const heading = within(modal).getByRole('heading', { level: 2 });
    heading.focus();
    expect(document.activeElement, 'precondition: the dialog heading holds focus').toBe(heading);

    const focusables = focusablesIn(modal);
    const last = focusables[focusables.length - 1]!;
    // RED at 0e2045e: the heading (tabindex=-1) is neither `first` nor `last`, so
    // no branch fires — focus stays on the heading and a real Shift+Tab would
    // escape to a per-row CTA.
    await fireEvent.keyDown(heading, { key: 'Tab', shiftKey: true });
    expect(
      document.activeElement,
      'Shift+Tab from the boundary wraps to the last focusable inside the dialog'
    ).toBe(last);
    expect(modal.contains(document.activeElement)).toBe(true);
  });
});

// ===========================================================================
// FINDING 5 (A11Y-2) — body scroll lock while a modal is open.
// Pinned mechanism: document.body.style.overflow === 'hidden'.
// ===========================================================================

describe('P1-8e review-fix [A11Y-2] body scroll is locked while a modal is open', () => {
  it('locks body scroll on open and restores it on close', async () => {
    const prior = document.body.style.overflow;
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false });
    const modal = await openRemoveModal(OTHER);
    expect(document.body.style.overflow, 'body scroll is locked while the modal is open').toBe('hidden');

    await fireEvent.click(within(modal).getByRole('button', { name: t('committee.remove.modal.cancel') }));
    await waitFor(() => expect(screen.queryByTestId('committee-remove-modal')).toBeNull());
    expect(document.body.style.overflow, 'body scroll lock is released after close').toBe(prior);
  });

  it('releases the scroll-lock when the card is DESTROYED while a modal is still open (no stranded lock)', async () => {
    // Guaranteed on the self-governance flow: a co-chair self-removes/self-demotes
    // → the success refetch 403s (they are no longer an active co-chair) → the
    // roster unmounts this card mid-modal, so closePanel() never runs. onDestroy()
    // must still release the body scroll-lock, or the app is left unscrollable.
    const prior = document.body.style.overflow;
    const { unmount } = renderCard({ member: ROW_OTHER_MEMBER, isSelf: false });
    await openRemoveModal(OTHER);
    expect(document.body.style.overflow, 'locked while the modal is open').toBe('hidden');

    unmount(); // destroy the card WITHOUT closing the modal
    expect(
      document.body.style.overflow,
      'scroll-lock released on destroy-while-open, never stranded'
    ).toBe(prior);
  });
});

// ===========================================================================
// FINDING 6 (A11Y-3) — gated Confirm is aria-disabled (focusable), never native
// `disabled`, and exposes a discoverable hint via aria-describedby. BOTH gates.
// ===========================================================================

describe('P1-8e review-fix [A11Y-3] gated Confirm stays focusable (aria-disabled) with a discoverable hint', () => {
  it('the APPROVER-REQUIRED gate: aria-disabled, NOT native disabled, with an aria-describedby hint', async () => {
    renderCard({ member: ROW_SELF_COCHAIR, isSelf: true, eligibleApprovers: [APPROVER_ROW_B] });
    const modal = await openRemoveModal(ACTOR);
    const confirm = removeConfirm(modal);
    // Gated: the picker is shown but no approver is chosen yet.
    expect(confirm.getAttribute('aria-disabled'), 'gated Confirm carries aria-disabled').toBe('true');
    // RED at 0e2045e: the gated Confirm ALSO carries native `disabled`.
    expect(
      (confirm as HTMLButtonElement).disabled,
      'gated Confirm must NOT be natively disabled (stays in tab order)'
    ).toBe(false);
    expect(confirm.hasAttribute('disabled')).toBe(false);
    // RED at 0e2045e: no aria-describedby is wired for the approver-required gate.
    expect(
      describedByText(confirm).length,
      'gated Confirm exposes a discoverable hint via aria-describedby'
    ).toBeGreaterThan(0);
  });

  it('the EMPTY-ROLE-SELECTION gate: aria-disabled, NOT native disabled, with an aria-describedby hint', async () => {
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false });
    const modal = await openRoleModal(OTHER);
    // Uncheck the only role → empty selection → gated.
    await fireEvent.click(
      within(modal).getByRole('checkbox', { name: t('committee.roster.role.worker_member') })
    );
    const confirm = within(modal).getByRole('button', {
      name: t('committee.role.modal.confirm')
    }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.getAttribute('aria-disabled')).toBe('true'));
    // RED at 0e2045e: empty-selection gate uses native `disabled` and has NO hint.
    expect(
      confirm.disabled,
      'empty-selection gated Confirm must NOT be natively disabled'
    ).toBe(false);
    expect(confirm.hasAttribute('disabled')).toBe(false);
    expect(
      describedByText(confirm).length,
      'empty-selection gate exposes a discoverable hint via aria-describedby'
    ).toBeGreaterThan(0);
  });
});

// ===========================================================================
// FINDING 7 (A11Y-4) — the submitting live region is OUTSIDE the aria-busy
// subtree (a live region inside aria-busy="true" may be suppressed by AT).
// ===========================================================================

describe('P1-8e review-fix [A11Y-4] submitting live region sits outside the aria-busy subtree', () => {
  it('the submitting role="status" announce is not a descendant of an aria-busy="true" element', async () => {
    const d = deferred<RemoveResult>();
    const built = fakeClient({ remove: [d.promise] });
    renderCard({ member: ROW_OTHER_MEMBER, isSelf: false, client: built.client, calls: built.calls });
    const modal = await openRemoveModal(OTHER);
    await fireEvent.click(removeConfirm(modal));
    await screen.findByTestId('committee-manage-submitting');

    // The submitting ANNOUNCE is the role="status" live region (its text can
    // coincide with the visible button label, so select it by role, not text).
    const region = within(modal).getByRole('status');
    expect(region.textContent ?? '', 'precondition: the status region carries the submitting announce').toContain(
      t('a11y.committee.remove.submitting')
    );
    // RED at 0e2045e: the announce sits inside the dialog, which is aria-busy while
    // submitting.
    expect(
      region.closest('[aria-busy="true"]'),
      'the submitting live region must not be inside an aria-busy subtree'
    ).toBeNull();

    d.resolve({ ok: true, data: GRACE_ISO });
    await screen.findByTestId('committee-manage-done');
  });
});
