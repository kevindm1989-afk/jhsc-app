/**
 * ADR-0029 P1-8e review-fix batch — CommitteeRoster ↔ CommitteeManageMemberCard
 * INTEGRATION (the class of test the P1-8e suite structurally lacked).
 *
 * RED-FIRST. The implementer treats this file as READ-ONLY; it pins the wiring
 * contract between the roster and the per-row management card that the existing
 * card/roster suites never exercised together. Every unit-level card test drives
 * a `this`-independent CLOSURE fake, so the real class-instance `this`-binding
 * bug (ADV-1) and the roster-refresh unmount bug (ADV-2) both slipped past.
 *
 * The two integration findings this file pins:
 *
 *   ADV-1 (this-binding) — CommitteeRoster wires the card with a DESTRUCTURED
 *     object literal `{ setRoles: client.setRoles!, … }`. That detaches `this`
 *     from the SupabaseCommitteeClient instance, so every op throws
 *     "Cannot read 'transport' of undefined" BEFORE any fetch — swallowed to a
 *     generic `failed`. Proof: mount the roster with a REAL
 *     `new SupabaseCommitteeClient({ transport })` and assert the STUBBED
 *     transport actually receives the op (only possible if `this` is bound) AND
 *     the card reaches `committee-manage-done`. Decided fix: wrap at the wiring
 *     site — `setRoles: (i) => client.setRoles!(i)` (idem remove/reactivate).
 *
 *   ADV-2 + A11Y-6 (success terminal survives the refresh; focus not orphaned) —
 *     on success `enterDone` calls `onChanged()` → the parent `load()` drops to
 *     `phase='loading'`, which unmounts the whole list (row + card + done modal),
 *     so the done modal flashes away and focus falls to <body>. Decided fix:
 *     `load()` must NOT unmount an existing list (guard on the initial/empty
 *     case, or swap `rows` in place behind a non-unmounting "refreshing" flag so
 *     the keyed {#each} preserves the open card); AND Close after a remove (which
 *     flips the row's affordance remove→reactivate) must return focus to a STABLE
 *     in-DOM target, never the now-detached CTA.
 *
 * A11Y-1 (inert background) is also pinned here (it needs the roster as the
 * background behind the card's modal): sibling app content is marked
 * inert/aria-hidden while a modal is open.
 *
 * Determinism: frozen clock; a stub transport / closure fake that RECORDS calls;
 * fixed fixtures owned by this file; no sleeps, no real network/RNG/clock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/svelte';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
import { setJwt, clearJwt, __resetForTest } from '../../src/lib/auth/session-jwt-store';
import { t } from '../../src/lib/i18n';
import {
  SupabaseCommitteeClient,
  type RosterRow,
  type CommitteeOpResult,
  type CommitteeOpTransport
} from '../../src/lib/committee/supabase-committee-client';

import CommitteeRoster from '../../src/lib/committee/CommitteeRoster.svelte';

// ---------------------------------------------------------------------------
// F182-6 / ADR-0030 Amendment C — mock the crypto ROTATION BOUNDARY only.
//
// Under AUTO-ROTATE the roster threads `rotateOnRemoval` onto the manage card
// ONLY when the three crypto deps are wired, and the card's Remove CTA is gated on
// that method's presence (VC-1). This integration suite pins the roster↔card
// WIRING (ADV-1 this-binding of the GOVERNANCE ops, ADV-2 success-terminal refresh
// survival + focus, A11Y-1 inert background) — NOT crypto correctness (owned by
// T07 f182-4b) nor the card's terminal mapping (owned by
// committee-manage-rotate-on-removal). So we replace the REAL crypto orchestration
// builder with a deterministic clean-ok rotate: the roster still derives a non-null
// `rotateOnRemovalFn` (→ Remove CTA renders, `remainingMembers` threads, the
// rotation-done terminal + server-truthed refetch fire) with NO real RNG/keys and
// without loading libsodium. The governance client (SupabaseCommitteeClient) is
// NOT mocked, so ADV-1's this-binding proof stays real.
vi.mock('../../src/lib/committee/remove-rotation-orchestration', () => ({
  makeRemoveRotationOrchestration: () => async () => ({
    status: 'ok',
    rotation_id: 'rot-int-test',
    new_key_id: 'key-int-test',
    members_rewrapped_count: 1,
    pending_members: []
  })
}));

// ---------------------------------------------------------------------------
// Fixtures (this file owns them). Synthetic — no real PII.
// ---------------------------------------------------------------------------

const ACTOR = 'aaaa1111-0000-4000-8000-00000000self';
const OTHER = 'bbbb2222-0000-4000-8000-0000000other';
const REMOVED = 'cccc3333-0000-4000-8000-000000removd';
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

// An OTHER active member (not a co-chair) — actions against them need no picker,
// so Confirm is enabled immediately.
const ROW_OTHER_ACTIVE = makeRow({ user_id: OTHER, roles: ['worker_member'], display_name: 'Otto Other' });
// The SAME member as the server would return AFTER a successful remove — inactive
// + in grace. Its per-row affordance is Reactivate (remove→reactivate flip).
const ROW_OTHER_REMOVED = makeRow({
  user_id: OTHER,
  active: false,
  activated_at: '2026-02-10T09:00:00.000Z',
  deactivated_at: '2026-03-15T09:00:00.000Z',
  grace_until: GRACE_ISO,
  display_name: 'Otto Other'
});
// A removed member (for the reactivate op path).
const ROW_REMOVED_MEMBER = makeRow({
  user_id: REMOVED,
  active: false,
  activated_at: '2026-02-10T09:00:00.000Z',
  deactivated_at: '2026-03-15T09:00:00.000Z',
  grace_until: GRACE_ISO,
  display_name: 'Rita Removed'
});

// ---------------------------------------------------------------------------
// A REAL SupabaseCommitteeClient over a stub transport (drives ADV-1). The
// transport dispatches on `body.op` + RECORDS every posted body, so a call that
// reaches it proves `this.opts.transport` resolved (i.e. `this` was bound).
// ---------------------------------------------------------------------------

function realClientHarness(opts: {
  roster: RosterRow[][];
  remove?: { status: number; body: unknown };
  setRoles?: { status: number; body: unknown };
  reactivate?: { status: number; body: unknown };
}) {
  const bodies: Array<Record<string, unknown>> = [];
  let listIdx = 0;
  const transport: CommitteeOpTransport = async (body) => {
    bodies.push(body);
    switch (body.op) {
      case 'list_roster': {
        const snap = opts.roster[Math.min(listIdx, opts.roster.length - 1)]!;
        listIdx += 1;
        return { status: 200, body: { ok: true, data: snap } };
      }
      case 'remove':
        return opts.remove ?? { status: 200, body: { ok: true, data: GRACE_ISO } };
      case 'set_roles':
        return opts.setRoles ?? { status: 200, body: { ok: true, data: null } };
      case 'reactivate':
        return opts.reactivate ?? { status: 200, body: { ok: true, data: null } };
      default:
        return { status: 200, body: { ok: true, data: null } };
    }
  };
  const client = new SupabaseCommitteeClient({ transport });
  const opsFor = (op: string) => bodies.filter((b) => b.op === op);
  return { client, bodies, opsFor };
}

// ---------------------------------------------------------------------------
// A CLOSURE fake (this-independent) — isolates ADV-2 from ADV-1 so the
// roster-refresh unmount bug can be pinned WITHOUT the this-binding confound.
// `listRoster` returns queued SNAPSHOTS (the server-truthed post-mutation state).
// ---------------------------------------------------------------------------

function fakeRosterClient(snapshots: RosterRow[][]) {
  const calls = {
    listRoster: 0,
    setRoles: [] as unknown[],
    removeMember: [] as unknown[],
    reactivateMember: [] as unknown[]
  };
  const client = {
    listRoster: async (): Promise<CommitteeOpResult<RosterRow[]>> => {
      const snap = snapshots[Math.min(calls.listRoster, snapshots.length - 1)]!;
      calls.listRoster += 1;
      return { ok: true, data: snap };
    },
    setRoles: async (i: unknown): Promise<CommitteeOpResult<null>> => {
      calls.setRoles.push(i);
      return { ok: true, data: null };
    },
    removeMember: async (i: unknown): Promise<CommitteeOpResult<string>> => {
      calls.removeMember.push(i);
      return { ok: true, data: GRACE_ISO };
    },
    reactivateMember: async (i: unknown): Promise<CommitteeOpResult<null>> => {
      calls.reactivateMember.push(i);
      return { ok: true, data: null };
    }
  };
  return { client, calls };
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

function makeJwt(sub: string): string {
  const seg = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${seg({ alg: 'ES256', typ: 'JWT' })}.${seg({ sub, iat: 1700000000, exp: 1700001000 })}.sig`;
}

/** Mount the roster with manage enabled + a signed-in ACTOR (so isSelf/eligible
 *  derivations run). The card mounts per active/removed row.
 *
 *  F182-6 (VC-1): the Remove CTA is gated on the card's `rotateOnRemoval`, which
 *  the roster threads ONLY when the three crypto deps are present (mirrors
 *  production — the /committee route ALWAYS wires them). We pass truthy crypto-dep
 *  stubs so the roster derives a non-null `rotateOnRemovalFn`; the mocked
 *  orchestration above ignores the stubs' contents (their PRESENCE is the whole
 *  point), so removal exercises the real roster→card rotation path deterministically. */
function renderManagedRoster(client: unknown) {
  __resetForTest();
  setJwt(makeJwt(ACTOR)); // getCurrentUserId() === ACTOR, $isSignedIn === true
  return render(CommitteeRoster, {
    props: {
      client: client as never,
      manageEnabled: true as never,
      grantClient: {} as never,
      grantHolder: {} as never,
      grantLocalIdentity: {} as never
    }
  });
}

function removeConfirm(modal: HTMLElement): HTMLButtonElement {
  return (within(modal).queryByRole('button', { name: t('committee.remove.modal.confirm_self') }) ??
    within(modal).getByRole('button', {
      name: t('committee.remove.modal.confirm')
    })) as HTMLButtonElement;
}

beforeEach(() => {
  freezeClock();
  __resetCapture();
  __setTestSink();
  __resetForTest();
  document.body.style.overflow = ''; // clean start; the leak must surface in its own test
});
afterEach(() => {
  cleanup();
  clearJwt();
  __resetForTest();
  // NOTE: do NOT reset document.body.style.overflow here — cleanup() must unmount
  // the card and let its onDestroy() release the scroll-lock. Resetting here masked
  // the original stranded-lock leak (ADV re-verify). beforeEach handles clean start.
  __resetCapture();
  vi.restoreAllMocks();
  restoreClock();
});

// ===========================================================================
// PRECONDITION — the manage card actually mounts on a real-client roster.
// ===========================================================================

describe('P1-8e review-fix [integration] manage card mounts on a real-client roster', () => {
  it('an active row exposes the per-row management CTAs when manageEnabled + a real client are wired', async () => {
    const { client } = realClientHarness({ roster: [[ROW_OTHER_ACTIVE]] });
    renderManagedRoster(client);
    await screen.findByTestId('committee-roster-list');
    expect(await screen.findByTestId(`committee-manage-remove-cta-${OTHER}`)).toBeDefined();
    expect(screen.getByTestId(`committee-manage-role-cta-${OTHER}`)).toBeDefined();
  });
});

// ===========================================================================
// FINDING 1 (ADV-1 this-binding) — the wired op MUST reach the real transport.
// ===========================================================================

describe('P1-8e review-fix [ADV-1] manage ops reach the transport when wired with a real class instance', () => {
  it('REMOVE via the roster posts the `remove` op to the real transport and reaches the rotation-done terminal (proves `this` is bound)', async () => {
    const h = realClientHarness({ roster: [[ROW_OTHER_ACTIVE]] });
    renderManagedRoster(h.client);
    await screen.findByTestId('committee-roster-list');

    await fireEvent.click(await screen.findByTestId(`committee-manage-remove-cta-${OTHER}`));
    const modal = await screen.findByTestId('committee-remove-modal');
    await fireEvent.click(removeConfirm(modal));

    // The op reached the real transport → `this.opts.transport` resolved → the
    // destructured wiring did NOT detach `this`. (RED at 0e2045e: the op throws
    // "Cannot read 'transport' of undefined" and never reaches the transport.)
    await waitFor(() =>
      expect(h.opsFor('remove').length, 'the remove op must reach the stubbed transport').toBe(1)
    );
    expect(h.opsFor('remove')[0]!.target_user_id).toBe(OTHER);

    // And the server-truthed terminal renders — never the swallowed generic fail.
    // F182-6: a NON-SELF removal auto-rotates in the same action, so the clean
    // terminal is `committee-manage-rotation-done` (not the governance `done`).
    await screen.findByTestId('committee-manage-rotation-done');
    expect(screen.queryByTestId('committee-manage-failed')).toBeNull();
  });

  it('CHANGE-ROLE via the roster posts the `set_roles` op to the real transport and reaches `done`', async () => {
    const h = realClientHarness({ roster: [[ROW_OTHER_ACTIVE]] });
    renderManagedRoster(h.client);
    await screen.findByTestId('committee-roster-list');

    await fireEvent.click(await screen.findByTestId(`committee-manage-role-cta-${OTHER}`));
    const modal = await screen.findByTestId('committee-role-modal');
    // Make a real change (add certified_member) so Confirm is not a no-op.
    await fireEvent.click(
      within(modal).getByRole('checkbox', { name: t('committee.roster.role.certified_member') })
    );
    await fireEvent.click(within(modal).getByRole('button', { name: t('committee.role.modal.confirm') }));

    await waitFor(() =>
      expect(h.opsFor('set_roles').length, 'the set_roles op must reach the stubbed transport').toBe(1)
    );
    await screen.findByTestId('committee-manage-done');
    expect(screen.queryByTestId('committee-manage-failed')).toBeNull();
  });

  it('REACTIVATE via the roster posts the `reactivate` op to the real transport and reaches `done`', async () => {
    const h = realClientHarness({ roster: [[ROW_REMOVED_MEMBER]] });
    renderManagedRoster(h.client);
    await screen.findByTestId('committee-roster-list');

    await fireEvent.click(await screen.findByTestId(`committee-manage-reactivate-cta-${REMOVED}`));
    const modal = await screen.findByTestId('committee-reactivate-modal');
    await fireEvent.click(
      within(modal).getByRole('button', { name: t('committee.reactivate.modal.confirm') })
    );

    await waitFor(() =>
      expect(h.opsFor('reactivate').length, 'the reactivate op must reach the stubbed transport').toBe(1)
    );
    await screen.findByTestId('committee-manage-done');
    expect(screen.queryByTestId('committee-manage-failed')).toBeNull();
  });
});

// ===========================================================================
// FINDING 2 (ADV-2 + A11Y-6) — the success terminal survives the roster refresh
// and focus is not orphaned. Isolated with a CLOSURE fake so the mutation
// SUCCEEDS (ADV-1 does not bite) and the refresh-unmount bug can surface.
// ===========================================================================

describe('P1-8e review-fix [ADV-2] the success terminal survives the server-truthed roster refresh', () => {
  async function removeThroughRoster() {
    // list #1 = active row; list #2 (the onChanged refetch) = the same member,
    // now server-truthed REMOVED (its per-row affordance flips remove→reactivate).
    const { client, calls } = fakeRosterClient([[ROW_OTHER_ACTIVE], [ROW_OTHER_REMOVED]]);
    renderManagedRoster(client);
    await screen.findByTestId('committee-roster-list');
    await fireEvent.click(await screen.findByTestId(`committee-manage-remove-cta-${OTHER}`));
    const modal = await screen.findByTestId('committee-remove-modal');
    await fireEvent.click(removeConfirm(modal));
    // Settle on the server-truthed refetch: the row's affordance has flipped to
    // Reactivate (proves load() re-ran + re-rendered). Present in both the buggy
    // and fixed builds — a stable sync point.
    await waitFor(() =>
      expect(screen.queryByTestId(`committee-manage-reactivate-cta-${OTHER}`)).not.toBeNull()
    );
    return { calls };
  }

  it('the success (rotation-done) terminal is STILL present after the refetch resolves (it does not flash away)', async () => {
    await removeThroughRoster();
    // RED at 0e2045e: load() drops to phase='loading', unmounting the list (and
    // the terminal modal); the refetched list remounts FRESH cards with no modal.
    // F182-6: a NON-SELF removal's success terminal is `committee-manage-rotation-done`.
    expect(
      screen.queryByTestId('committee-manage-rotation-done'),
      'the success terminal must survive the roster refetch'
    ).not.toBeNull();
  });

  it('focus stays INSIDE the dialog after the refetch resolves (not orphaned to <body>)', async () => {
    await removeThroughRoster();
    const dialog = screen.queryByTestId('committee-remove-modal');
    expect(dialog, 'the dialog must survive the refetch').not.toBeNull();
    expect(
      dialog!.contains(document.activeElement),
      'focus must remain within the surviving dialog after the refetch'
    ).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('A11Y-6: Close after a remove→reactivate flip returns focus to a STABLE in-DOM target, not <body>', async () => {
    await removeThroughRoster();
    // Precondition (ADV-2): the done terminal survived, so there is a Close to hit.
    const dialog = screen.getByTestId('committee-remove-modal');
    const close = within(dialog).getByRole('button', { name: t('committee.manage.close') });
    await fireEvent.click(close);
    await waitFor(() => expect(screen.queryByTestId('committee-remove-modal')).toBeNull());
    // The original Remove CTA is gone (row is now Reactivate) — focus must NOT
    // fall to <body>. It lands on a stable, still-connected element (the row
    // group / roster heading), never the detached CTA.
    expect(document.activeElement, 'Close must not orphan focus to <body>').not.toBe(document.body);
    expect(
      document.body.contains(document.activeElement),
      'the focus-return target must be a connected, in-DOM element'
    ).toBe(true);
  });
});

// ===========================================================================
// FINDING 4 (A11Y-1) — sibling/background app content is inert/aria-hidden while
// a modal is open (the dialog itself must remain operable, so a background
// container that is NOT an ancestor of the dialog must carry the flag).
// ===========================================================================

describe('P1-8e review-fix [A11Y-1] background app content is inert/aria-hidden while a modal is open', () => {
  it('while a manage modal is open, a background container holding roster content is inert or aria-hidden', async () => {
    const { client } = fakeRosterClient([[ROW_OTHER_ACTIVE]]);
    renderManagedRoster(client);
    await screen.findByTestId('committee-roster-list');
    await fireEvent.click(await screen.findByTestId(`committee-manage-remove-cta-${OTHER}`));
    const dialog = await screen.findByTestId('committee-remove-modal');

    // A background container that (a) carries inert or aria-hidden="true",
    // (b) actually holds roster member content, and (c) is NOT an ancestor of the
    // open dialog (so the dialog stays operable). RED at 0e2045e: nothing outside
    // the decorative icons is inert/aria-hidden.
    const flagged = Array.from(
      document.querySelectorAll<HTMLElement>('[inert], [aria-hidden="true"]')
    )
      .filter((el) => !el.contains(dialog))
      .filter((el) => el.querySelector('[data-testid="committee-roster-row"]'));
    expect(
      flagged.length,
      'background app content (roster) must be inert/aria-hidden while a modal is open, without inerting the dialog'
    ).toBeGreaterThan(0);
  });
});
