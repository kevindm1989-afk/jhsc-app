/**
 * ADR-0029 P1-8b — /committee read-only roster surface (Surface K).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY. It pins the
 * behavioral + state-completeness + privacy contract of the renderable roster
 * surface BEFORE the component exists, so the suite MUST fail at import
 * (`CommitteeRoster.svelte` is missing) until the implementer ships it. That
 * import failure is the correct primary red signal (component/route/i18n do not
 * exist yet).
 *
 * Why a `CommitteeRoster.svelte` lib component (not `/committee/+page.svelte`
 * directly): route shells import `$app/*` + `$env/dynamic/public`, which the
 * vitest runner does not mount cleanly (repo convention — see
 * phase2a-concerns-page-cutover.test.ts / redeem-route-mount.test.ts). Every
 * behavioral route test in this repo renders the underlying lib component the
 * route composes and pins the shell structurally (committee-route-mount.test.ts).
 * CommitteeRoster is that component; the route shell constructs the committee
 * client and passes it down.
 *
 * Injection style mirrors RedeemCard (real Svelte props, production-safe wire):
 *   - `client`  — an object exposing `listRoster(): Promise<CommitteeOpResult<
 *                 RosterRow[]>>` (the route wires `createSupabaseCommitteeClient`).
 *                 Tests inject a fake that records calls + returns queued results.
 * The signed-in gate reads the production `$isSignedIn` store
 * (`$lib/auth/session-jwt-svelte`); tests drive it via the real
 * `session-jwt-store` (`setJwt` / `__resetForTest`) — the production
 * signed-in source of truth, hermetic + deterministic.
 *
 * RESOLVED CONTRACT (Amendment A-8.1 / A-8.4 + Surface K; DECIDED — not reopened):
 *   - P1-8b renders the B1 roster ONLY (`listRoster()`); pending members surface
 *     via the `pending-invite` badge derived from the RosterRow. No
 *     `listPendingInvites`, no invite/grant/resend/role actions (P1-8c/d/e).
 *   - Role-gate via the roster read: `{ok:false,reason:'rls_denied',status:403}`
 *     → not-a-co-chair stop (polite role="status", info NOT red error, no retry).
 *     `status:401` → session-expired (assertive role="alert"). Any other failure
 *     → generic error (assertive; raw reason enum NEVER rendered, F-176).
 *     `{ok:true,data:[]}` → empty. `{ok:true,data:[rows]}` → roster list.
 *   - 5 badges derived CLIENT-SIDE from the RosterRow (icon+text, color never
 *     alone): active / pending-grant (amber, the single actionable cue) /
 *     awaiting-identity / pending-invite / inactive-removed.
 *   - Null-PI rows (display_name/off_employer_contact NULL) → fallback label +
 *     an 8-char user_id fragment (stable, non-PI); the full uid is never dumped.
 *   - F-178/F-176: no member PI + no raw uid in URL / history / storage / logs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { freezeClock, restoreClock, END_OF_DAY_UTC } from '../_helpers/clock';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
import { setJwt, __resetForTest } from '../../src/lib/auth/session-jwt-store';
import { t, hasKey } from '../../src/lib/i18n';
import type {
  RosterRow,
  CommitteeOpResult,
  CommitteeOpReason
} from '../../src/lib/committee/supabase-committee-client';

// RED-FIRST import — the implementer creates this lib component. Until it
// exists, every test in this file fails at module resolution.
import CommitteeRoster from '../../src/lib/committee/CommitteeRoster.svelte';

// ---------------------------------------------------------------------------
// Fixtures — deterministic ISO dates; distinctive PI canaries for the leak
// sweep. No real PII (synthetic names / addresses / uuids).
// ---------------------------------------------------------------------------

type RosterResult = CommitteeOpResult<RosterRow[]>;
const OK = (rows: RosterRow[]): RosterResult => ({ ok: true, data: rows });
const ERR = (reason: CommitteeOpReason, status: number): RosterResult => ({
  ok: false,
  reason,
  status
});

// Distinctive uuids (full uid must NEVER reach the DOM/URL/storage/logs; only
// the first 8 chars are a legitimate disambiguator).
const UID_ACTIVE = 'aaaaaaaa-1111-4111-8111-1111aaaa1111';
const UID_GRANT = 'bbbbbbbb-2222-4222-8222-2222bbbb2222';
const UID_AWAIT = 'cccccccc-3333-4333-8333-3333cccc3333';
const UID_INVITE = 'dddddddd-4444-4444-8444-4444dddd4444';
const UID_REMOVED = 'eeeeeeee-5555-4555-8555-5555eeee5555';
const UID_NULL_A = '01234567-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UID_NULL_B = '89abcdef-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const D = {
  invited: '2026-01-05T09:00:00.000Z',
  memberSince: '2026-02-10T09:00:00.000Z',
  grantJoined: '2026-04-01T09:00:00.000Z',
  awaitJoined: '2026-04-02T09:00:00.000Z',
  removed: '2026-03-15T09:00:00.000Z',
  grace: '2026-06-13T09:00:00.000Z'
};

function makeRow(over: Partial<RosterRow>): RosterRow {
  return {
    user_id: UID_ACTIVE,
    roles: ['worker_member'],
    active: true,
    invited_at: D.invited,
    activated_at: D.memberSince,
    deactivated_at: null,
    grace_until: null,
    display_name: 'Fixture Member',
    off_employer_contact: null,
    has_identity_key: true,
    has_live_wrap: true,
    ...over
  };
}

// One row per badge derivation (A-8.1 pinned predicates).
const ROW_ACTIVE = makeRow({
  user_id: UID_ACTIVE,
  roles: ['worker_co_chair', 'certified_member'],
  active: true,
  activated_at: D.memberSince,
  has_identity_key: true,
  has_live_wrap: true,
  display_name: 'Active Alice',
  off_employer_contact: 'alice.personal@example.test'
});
const ROW_PENDING_GRANT = makeRow({
  user_id: UID_GRANT,
  roles: ['worker_member'],
  active: true,
  activated_at: D.grantJoined,
  has_identity_key: true,
  has_live_wrap: false, // has_identity_key && !has_live_wrap → pending-grant
  display_name: 'Grant Gordon',
  off_employer_contact: null
});
const ROW_AWAITING_IDENTITY = makeRow({
  user_id: UID_AWAIT,
  roles: ['worker_member'],
  active: true,
  activated_at: D.awaitJoined,
  has_identity_key: false, // active && !has_identity_key → awaiting-identity
  has_live_wrap: false,
  display_name: 'Await Avery',
  off_employer_contact: null
});
const ROW_PENDING_INVITE = makeRow({
  user_id: UID_INVITE,
  roles: ['worker_member'],
  active: false,
  invited_at: D.invited,
  activated_at: null, // !active && activated_at==null && deactivated_at==null
  deactivated_at: null,
  has_identity_key: false,
  has_live_wrap: false,
  display_name: 'Invite Ivan',
  off_employer_contact: null
});
const ROW_REMOVED = makeRow({
  user_id: UID_REMOVED,
  roles: ['worker_member'],
  active: false,
  activated_at: D.memberSince,
  deactivated_at: D.removed, // !active && deactivated_at!=null → inactive/removed
  grace_until: D.grace,
  has_identity_key: true,
  has_live_wrap: true,
  display_name: 'Removed Rita',
  off_employer_contact: null
});

const ALL_FIVE = [
  ROW_ACTIVE,
  ROW_PENDING_GRANT,
  ROW_AWAITING_IDENTITY,
  ROW_PENDING_INVITE,
  ROW_REMOVED
];

// ---------------------------------------------------------------------------
// Fake committee client — records calls, returns queued results. Hermetic:
// no real transport, no network, deterministic. Mirrors RedeemCard's
// recordingTransport.
// ---------------------------------------------------------------------------

function fakeClient(results: RosterResult[]) {
  const calls: unknown[][] = [];
  let i = 0;
  const client = {
    listRoster: async (...args: unknown[]) => {
      calls.push(args);
      const r = results[Math.min(i, results.length - 1)];
      i++;
      return r;
    }
  };
  return { client, calls };
}

/** A client whose listRoster stays pending until `release(result)` is called. */
function gatedClient() {
  const calls: unknown[][] = [];
  let release!: (r: RosterResult) => void;
  const pending = new Promise<RosterResult>((res) => (release = res));
  const client = {
    listRoster: async (...args: unknown[]) => {
      calls.push(args);
      return pending;
    }
  };
  return { client, calls, release };
}

function renderRoster(opts: { results?: RosterResult[]; signedIn?: boolean; client?: unknown }) {
  __resetForTest();
  if (opts.signedIn !== false) setJwt('test-jwt'); // default: signed in
  const built = opts.client
    ? { client: opts.client, calls: [] as unknown[][] }
    : fakeClient(opts.results ?? [OK([])]);
  const utils = render(CommitteeRoster, { props: { client: built.client as never } });
  return { ...utils, calls: built.calls };
}

// ---------------------------------------------------------------------------
// Small DOM helpers.
// ---------------------------------------------------------------------------

function rows(): HTMLElement[] {
  return screen.queryAllByTestId('committee-roster-row');
}
function rowContaining(text: string): HTMLElement {
  const r = rows().find((el) => (el.textContent ?? '').includes(text));
  if (!r) throw new Error(`no roster row containing "${text}"`);
  return r;
}
function badgeOf(row: HTMLElement): HTMLElement {
  const b = row.querySelector('[data-testid="committee-badge"]') as HTMLElement | null;
  if (!b) throw new Error('row has no [data-testid="committee-badge"]');
  return b;
}
/** The SR/programmatic label of a badge — aria-label OR a visually-hidden child. */
function programmaticLabel(badge: HTMLElement): string {
  const aria = badge.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const hidden = badge.querySelector('.sr-only, [data-testid="committee-badge-sr"]');
  return (hidden?.textContent ?? '').trim();
}
/** The non-interpolated prefix of a "{date}" catalog string (copy-decoupled). */
function datePrefix(key: string): string {
  const SENT = '\u0001';
  return t(key, { date: SENT }).split(SENT)[0]!.trim();
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Frozen clock — the roster must render identically at any instant (dates are
  // server-provided ISO, absolute; no Date.now() branching). Determinism rule.
  freezeClock();
  __resetCapture();
  __setTestSink();
  __resetForTest();
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

afterEach(() => {
  cleanup();
  __resetCapture();
  __resetForTest();
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  if (typeof localStorage !== 'undefined') localStorage.clear();
  vi.restoreAllMocks();
  restoreClock();
});

// ===========================================================================
// SURFACE-K STATE 1 — signed-out gate (short-circuits BEFORE any read)
// ===========================================================================

describe('P1-8b Surface K [signed-out] — gate short-circuits before listRoster', () => {
  it('[Surface K: signed-out] renders the sign-in prompt (polite role="status") when not signed in', async () => {
    renderRoster({ signedIn: false, results: [OK(ALL_FIVE)] });
    const gate = await screen.findByTestId('committee-signed-out');
    expect(gate.getAttribute('role')).toBe('status');
    // A real keyboard/SR-operable link to /sign-in.
    const link = gate.querySelector('a[href="/sign-in"]');
    expect(link, 'signed-out state must offer a real <a href="/sign-in">').not.toBeNull();
  });

  it('[Surface K: signed-out / F-178] does NOT call listRoster at all when signed out', async () => {
    const { calls } = renderRoster({ signedIn: false, results: [OK(ALL_FIVE)] });
    await screen.findByTestId('committee-signed-out');
    // The read is short-circuited BEFORE the RPC — no roster PI is even fetched.
    expect(calls.length).toBe(0);
    // And no roster chrome leaks into the signed-out state.
    expect(screen.queryByTestId('committee-roster-list')).toBeNull();
  });
});

// ===========================================================================
// SURFACE-K STATE 2 — loading
// ===========================================================================

describe('P1-8b Surface K [loading] — aria-busy + literal action text', () => {
  it('[Surface K: loading] shows the loading line with the LITERAL action (not bare "Loading…")', async () => {
    const { client } = gatedClient();
    renderRoster({ client });
    const loading = await screen.findByTestId('committee-loading');
    expect(loading.getAttribute('role')).toBe('status');
    // Literal action — "Loading the committee roster…", never bare "Loading…".
    expect(loading.textContent?.trim()).toBe(t('committee.roster.loading'));
    expect(loading.textContent?.trim()).not.toBe('Loading…');
    expect(loading.textContent ?? '').toMatch(/roster/i);
  });

  it('[Surface K: loading] the roster container carries aria-busy="true" while in flight, "false" after', async () => {
    const { client, release } = gatedClient();
    renderRoster({ client });
    await screen.findByTestId('committee-loading');
    expect(screen.getByTestId('committee-page').getAttribute('aria-busy')).toBe('true');
    release(OK(ALL_FIVE));
    await screen.findByTestId('committee-roster-list');
    expect(screen.getByTestId('committee-page').getAttribute('aria-busy')).toBe('false');
  });
});

// ===========================================================================
// SURFACE-K STATE 3 — not-a-co-chair stop (403 → polite, info, NO retry)
// ===========================================================================

describe('P1-8b Surface K [not-co-chair] — 403 rls_denied is a calm authz boundary', () => {
  it('[Surface K: not-co-chair / F-178] a 403 rls_denied renders the POLITE stop (role="status", NOT alert)', async () => {
    renderRoster({ results: [ERR('rls_denied', 403)] });
    const stop = await screen.findByTestId('committee-not-co-chair');
    // Polite — a coerced/curious member must NOT be alarmed. This is the
    // load-bearing a11y distinction from session-expired/error.
    expect(stop.getAttribute('role')).toBe('status');
    expect(stop.getAttribute('role')).not.toBe('alert');
  });

  it('[Surface K: not-co-chair] offers a back-to-/more link and NO retry button (retrying cannot change the answer)', async () => {
    renderRoster({ results: [ERR('rls_denied', 403)] });
    const stop = await screen.findByTestId('committee-not-co-chair');
    expect(stop.querySelector('a[href="/more"]'), 'back-to-/more link').not.toBeNull();
    // No retry affordance anywhere on the stop surface.
    expect(screen.queryByTestId('committee-list-error')).toBeNull();
    expect(stop.querySelector('button')).toBeNull();
  });

  it('[Surface K: not-co-chair / F-176] never echoes the raw reason enum "rls_denied"', async () => {
    const { container } = renderRoster({ results: [ERR('rls_denied', 403)] });
    await screen.findByTestId('committee-not-co-chair');
    expect(container.textContent ?? '').not.toContain('rls_denied');
  });

  it('[Surface K: not-co-chair] does NOT render the roster list or the generic error panel', async () => {
    renderRoster({ results: [ERR('rls_denied', 403)] });
    await screen.findByTestId('committee-not-co-chair');
    expect(screen.queryByTestId('committee-roster-list')).toBeNull();
    expect(screen.queryByTestId('committee-list-error')).toBeNull();
  });
});

// ===========================================================================
// SURFACE-K STATE 4 — session-expired (401 → assertive)
// ===========================================================================

describe('P1-8b Surface K [session-expired] — 401 is an assertive interruption', () => {
  it('[Surface K: session-expired] a 401 renders role="alert" + a /sign-in link', async () => {
    renderRoster({ results: [ERR('rls_denied', 401)] });
    const expired = await screen.findByTestId('committee-session-expired');
    expect(expired.getAttribute('role')).toBe('alert');
    expect(expired.querySelector('a[href="/sign-in"]'), 'sign-in link').not.toBeNull();
  });

  it('[Surface K: role-gate] the component branches on STATUS, not the reason enum (401 ≠ 403 despite same reason)', async () => {
    // Same reason string, different status → different terminal state. Proves
    // the gate keys off `status`, per the resolved contract.
    renderRoster({ results: [ERR('rls_denied', 401)] });
    await screen.findByTestId('committee-session-expired');
    expect(screen.queryByTestId('committee-not-co-chair')).toBeNull();
  });
});

// ===========================================================================
// SURFACE-K STATE 5 — generic error (any other failure → assertive, generic)
// ===========================================================================

describe('P1-8b Surface K [error] — generic, never echoes the raw reason (F-176)', () => {
  it('[Surface K: error] a 500 renders role="alert" + a Retry button', async () => {
    renderRoster({ results: [ERR('unknown', 500)] });
    const err = await screen.findByTestId('committee-list-error');
    expect(err.getAttribute('role')).toBe('alert');
    const retry = err.querySelector('button');
    expect(retry, 'error state must offer a Retry <button>').not.toBeNull();
    expect((retry as HTMLButtonElement).disabled).toBe(false);
  });

  it('[Surface K: error / F-176] never renders the raw reason enum for a non-401/403 failure', async () => {
    const { container } = renderRoster({ results: [ERR('membership_exists', 500)] });
    await screen.findByTestId('committee-list-error');
    // Generic copy only — the raw enum is mapped away (F-176 posture).
    expect(container.textContent ?? '').not.toContain('membership_exists');
    expect(container.textContent ?? '').not.toContain('rls_denied');
  });

  it('[Surface K: error] Retry re-runs listRoster and recovers to the roster list', async () => {
    const { calls } = renderRoster({ results: [ERR('unknown', 500), OK(ALL_FIVE)] });
    const err = await screen.findByTestId('committee-list-error');
    await fireEvent.click(err.querySelector('button') as HTMLButtonElement);
    await screen.findByTestId('committee-roster-list');
    expect(calls.length).toBe(2);
  });

  it('[Surface K: error] a network-shaped failure (status 0) also maps to the generic error', async () => {
    // The edge-fn transport surfaces a network error as status 0; it is neither
    // 401 nor 403, so it is the generic error branch (not session-expired/stop).
    renderRoster({ results: [ERR('unknown', 0)] });
    await screen.findByTestId('committee-list-error');
    expect(screen.queryByTestId('committee-session-expired')).toBeNull();
    expect(screen.queryByTestId('committee-not-co-chair')).toBeNull();
  });
});

// ===========================================================================
// SURFACE-K STATE 6 — empty (ok + [])
// ===========================================================================

describe('P1-8b Surface K [empty] — degenerate empty roster, chrome retained', () => {
  it('[Surface K: empty] ok+[] renders the empty state (role="status") with the section chrome still present', async () => {
    renderRoster({ results: [OK([])] });
    const empty = await screen.findByTestId('committee-empty');
    expect(empty.getAttribute('role')).toBe('status');
    // Chrome (the roster title) is retained around the empty state.
    expect(screen.getByText(t('committee.roster.title'))).toBeDefined();
    expect(screen.queryByTestId('committee-roster-list')).toBeNull();
  });
});

// ===========================================================================
// SURFACE-K STATE 7 — roster list (rows in server order; no re-sort)
// ===========================================================================

describe('P1-8b Surface K [roster-list] — server order, non-interactive rows', () => {
  it('[Surface K: roster-list] ok+rows renders a <ul> with one <li> per member', async () => {
    renderRoster({ results: [OK(ALL_FIVE)] });
    const list = await screen.findByTestId('committee-roster-list');
    expect(list.tagName.toLowerCase()).toBe('ul');
    expect(rows().length).toBe(ALL_FIVE.length);
  });

  it('[Surface K: roster-list] renders rows in the SERVER-provided order — the component does NOT re-sort', async () => {
    // Server pins `active DESC, display_name NULLS LAST` (A-8.1). Provide rows
    // in an order a naive client sort would REORDER (inactive-first, then
    // active) and assert the DOM preserves the given order exactly.
    const provided = [ROW_REMOVED, ROW_ACTIVE]; // inactive Rita BEFORE active Alice
    renderRoster({ results: [OK(provided)] });
    await screen.findByTestId('committee-roster-list');
    const order = rows().map((r) => r.textContent ?? '');
    expect(order[0]).toContain('Removed Rita');
    expect(order[1]).toContain('Active Alice');
  });

  it('[Surface K: roster-list] rows are NON-interactive in P1-8b (no per-row tab stop / click target)', async () => {
    renderRoster({ results: [OK(ALL_FIVE)] });
    await screen.findByTestId('committee-roster-list');
    for (const row of rows()) {
      // No anchor, no button, no positive/zero tabindex on the row itself.
      expect(row.querySelector('a[href]:not([href="/more"]):not([href="/sign-in"])')).toBeNull();
      expect(row.getAttribute('tabindex')).toBeNull();
      expect(row.tagName.toLowerCase()).toBe('li');
    }
  });

  it('[Surface K: roster-list] the roles[] map through committee.roster.role.* and comma-join', async () => {
    renderRoster({ results: [OK([ROW_ACTIVE])] });
    await screen.findByTestId('committee-roster-list');
    const row = rowContaining('Active Alice');
    expect(row.textContent ?? '').toContain(t('committee.roster.role.worker_co_chair'));
    expect(row.textContent ?? '').toContain(t('committee.roster.role.certified_member'));
  });

  it('[Surface K: roster-list] an empty roles[] omits the roles line entirely', async () => {
    const noRoles = makeRow({ user_id: UID_ACTIVE, roles: [], display_name: 'Roleless Robin' });
    renderRoster({ results: [OK([noRoles])] });
    await screen.findByTestId('committee-roster-list');
    const row = rowContaining('Roleless Robin');
    // None of the role labels should appear for a row with no roles.
    expect(row.textContent ?? '').not.toContain(t('committee.roster.role.worker_co_chair'));
    expect(row.textContent ?? '').not.toContain(t('committee.roster.role.worker_member'));
    expect(row.textContent ?? '').not.toContain(t('committee.roster.role.certified_member'));
  });
});

// ===========================================================================
// CONTEXTUAL DATE per badge (§ Per-row layout item 5)
// ===========================================================================

describe('P1-8b [roster-list] contextual date is keyed off the badge', () => {
  it('[Surface K: roster-list] active → "Member since {activated_at}"', async () => {
    renderRoster({ results: [OK([ROW_ACTIVE])] });
    await screen.findByTestId('committee-roster-list');
    const row = rowContaining('Active Alice');
    expect(row.textContent ?? '').toContain(datePrefix('committee.roster.row.date_member_since'));
    expect(row.textContent ?? '').toContain('2026-02-10');
  });

  it('[Surface K: roster-list] pending-grant → "Joined {activated_at}" (not "Member since")', async () => {
    renderRoster({ results: [OK([ROW_PENDING_GRANT])] });
    await screen.findByTestId('committee-roster-list');
    const row = rowContaining('Grant Gordon');
    expect(row.textContent ?? '').toContain(datePrefix('committee.roster.row.date_joined'));
    expect(row.textContent ?? '').toContain('2026-04-01');
    expect(row.textContent ?? '').not.toContain(datePrefix('committee.roster.row.date_member_since'));
  });

  it('[Surface K: roster-list] pending-invite → "Invited {invited_at}"', async () => {
    renderRoster({ results: [OK([ROW_PENDING_INVITE])] });
    await screen.findByTestId('committee-roster-list');
    const row = rowContaining('Invite Ivan');
    expect(row.textContent ?? '').toContain(datePrefix('committee.roster.row.date_invited'));
    expect(row.textContent ?? '').toContain('2026-01-05');
  });

  it('[Surface K: roster-list] inactive/removed → "Removed {deactivated_at}" AND "Access ends {grace_until}"', async () => {
    renderRoster({ results: [OK([ROW_REMOVED])] });
    await screen.findByTestId('committee-roster-list');
    const row = rowContaining('Removed Rita');
    expect(row.textContent ?? '').toContain(datePrefix('committee.roster.row.date_removed'));
    expect(row.textContent ?? '').toContain('2026-03-15');
    // grace_until is set → the second "Access ends" line appears.
    expect(row.textContent ?? '').toContain(datePrefix('committee.roster.row.date_grace_until'));
    expect(row.textContent ?? '').toContain('2026-06-13');
  });
});

// ===========================================================================
// THE 5 BADGES — derived client-side from the RosterRow columns
// ===========================================================================

describe('P1-8b [badges] — the 5-badge grant-state taxonomy, icon+text, color never alone', () => {
  interface BadgeCase {
    name: string;
    row: RosterRow;
    findBy: string;
    textKey: string;
    srKey: string;
  }
  const cases: BadgeCase[] = [
    {
      name: 'active',
      row: ROW_ACTIVE,
      findBy: 'Active Alice',
      textKey: 'committee.roster.badge.active.text',
      srKey: 'committee.roster.badge.active.sr'
    },
    {
      name: 'pending-grant',
      row: ROW_PENDING_GRANT,
      findBy: 'Grant Gordon',
      textKey: 'committee.roster.badge.pending_grant.text',
      srKey: 'committee.roster.badge.pending_grant.sr'
    },
    {
      name: 'awaiting-identity',
      row: ROW_AWAITING_IDENTITY,
      findBy: 'Await Avery',
      textKey: 'committee.roster.badge.awaiting_identity.text',
      srKey: 'committee.roster.badge.awaiting_identity.sr'
    },
    {
      name: 'pending-invite',
      row: ROW_PENDING_INVITE,
      findBy: 'Invite Ivan',
      textKey: 'committee.roster.badge.pending_invite.text',
      srKey: 'committee.roster.badge.pending_invite.sr'
    },
    {
      name: 'inactive/removed',
      row: ROW_REMOVED,
      findBy: 'Removed Rita',
      textKey: 'committee.roster.badge.inactive.text',
      srKey: 'committee.roster.badge.inactive.sr'
    }
  ];

  for (const c of cases) {
    it(`[Surface K: badge=${c.name}] the RosterRow derives the ${c.name} badge with icon + visible text + SR label`, async () => {
      renderRoster({ results: [OK([c.row])] });
      await screen.findByTestId('committee-roster-list');
      const badge = badgeOf(rowContaining(c.findBy));

      // Color never alone (anti-pattern #3): a decorative icon + visible text.
      expect(
        badge.querySelector('[aria-hidden="true"]'),
        'badge must carry a decorative (aria-hidden) icon, not color alone'
      ).not.toBeNull();
      // Guard against a false-green from an unresolved i18n key.
      expect(hasKey(c.textKey), `${c.textKey} must resolve`).toBe(true);
      expect(hasKey(c.srKey), `${c.srKey} must resolve`).toBe(true);
      // Visible micro-text carries the meaning.
      expect(badge.textContent ?? '').toContain(t(c.textKey));
      // Programmatic (SR) label carries the fuller, unambiguous status.
      expect(programmaticLabel(badge)).toBe(t(c.srKey));
    });
  }

  it('[Surface K: badge] pending-grant is the SINGLE visually-distinct actionable (amber) badge', async () => {
    renderRoster({ results: [OK(ALL_FIVE)] });
    await screen.findByTestId('committee-roster-list');

    const grantBadge = badgeOf(rowContaining('Grant Gordon'));
    // The spec pins the amber variant class `.badge-pending` for pending-grant.
    expect(grantBadge.classList.contains('badge-pending')).toBe(true);

    // It is the ONLY amber badge across the whole roster (the co-chair's one
    // actionable cue is the one that draws the eye).
    const amber = rows()
      .map((r) => badgeOf(r))
      .filter((b) => b.classList.contains('badge-pending'));
    expect(amber.length).toBe(1);

    // awaiting-identity + pending-invite share the calm/info tint — distinct
    // from pending-grant's amber (proves pending-grant is visually distinct).
    const awaitBadge = badgeOf(rowContaining('Await Avery'));
    const inviteBadge = badgeOf(rowContaining('Invite Ivan'));
    expect(awaitBadge.classList.contains('badge-pending')).toBe(false);
    expect(inviteBadge.classList.contains('badge-pending')).toBe(false);
  });

  it('[Surface K: badge] awaiting-identity and pending-invite are NOT confused despite sharing a tint (distinct text + SR label)', async () => {
    renderRoster({ results: [OK([ROW_AWAITING_IDENTITY, ROW_PENDING_INVITE])] });
    await screen.findByTestId('committee-roster-list');
    const awaitLabel = programmaticLabel(badgeOf(rowContaining('Await Avery')));
    const inviteLabel = programmaticLabel(badgeOf(rowContaining('Invite Ivan')));
    expect(awaitLabel).not.toBe(inviteLabel);
    expect(awaitLabel).toBe(t('committee.roster.badge.awaiting_identity.sr'));
    expect(inviteLabel).toBe(t('committee.roster.badge.pending_invite.sr'));
  });

  it('[Surface K: badge] pending-grant is READ-ONLY signage in P1-8b — no grant button on the badge/row', async () => {
    renderRoster({ results: [OK([ROW_PENDING_GRANT])] });
    await screen.findByTestId('committee-roster-list');
    const row = rowContaining('Grant Gordon');
    // The grant ACTION is screen 3 (P1-8d); this pass renders signage only.
    expect(row.querySelector('button')).toBeNull();
  });
});

// ===========================================================================
// NULL-PI ROW (LEFT JOIN yields NULL display_name / off_employer_contact)
// ===========================================================================

describe('P1-8b [null-PI] — fallback label + stable 8-char uid fragment, full uid never dumped', () => {
  it('[Surface K: null-PI] a NULL display_name renders the fallback label + an 8-char uid fragment', async () => {
    const nullRow = makeRow({ user_id: UID_NULL_A, display_name: null, off_employer_contact: null });
    const { container } = renderRoster({ results: [OK([nullRow])] });
    await screen.findByTestId('committee-roster-list');
    const row = rows()[0]!;
    // Fallback label, never a blank cell / crash (A-8.1 pinned).
    expect(row.textContent ?? '').toContain(t('committee.roster.row.unnamed'));
    // The stable 8-char disambiguator (user_id.slice(0,8)).
    expect(row.textContent ?? '').toContain(UID_NULL_A.slice(0, 8));
    // The FULL uid is never dumped anywhere in the DOM (F-178).
    expect(container.textContent ?? '').not.toContain(UID_NULL_A);
  });

  it('[Surface K: null-PI] two nameless rows are DISTINGUISHABLE by their uid fragments', async () => {
    const a = makeRow({ user_id: UID_NULL_A, display_name: null });
    const b = makeRow({ user_id: UID_NULL_B, display_name: null });
    renderRoster({ results: [OK([a, b])] });
    await screen.findByTestId('committee-roster-list');
    const fragA = UID_NULL_A.slice(0, 8);
    const fragB = UID_NULL_B.slice(0, 8);
    expect(fragA).not.toBe(fragB);
    expect(rows()[0]!.textContent ?? '').toContain(fragA);
    expect(rows()[1]!.textContent ?? '').toContain(fragB);
  });

  it('[Surface K: null-PI] a NULL off_employer_contact omits the contact line (no label with an empty value)', async () => {
    const nullContact = makeRow({
      user_id: UID_NULL_A,
      display_name: 'Has Name No Contact',
      off_employer_contact: null
    });
    renderRoster({ results: [OK([nullContact])] });
    await screen.findByTestId('committee-roster-list');
    const row = rowContaining('Has Name No Contact');
    expect(row.textContent ?? '').not.toContain(t('committee.roster.row.contact_label'));
  });

  it('[Surface K: roster-list] a PRESENT off_employer_contact renders behind its visible label', async () => {
    renderRoster({ results: [OK([ROW_ACTIVE])] });
    await screen.findByTestId('committee-roster-list');
    const row = rowContaining('Active Alice');
    expect(row.textContent ?? '').toContain(t('committee.roster.row.contact_label'));
    expect(row.textContent ?? '').toContain('alice.personal@example.test');
  });
});

// ===========================================================================
// PRIVACY — F-178 / F-176: no PI + no raw uid in URL / history / storage / logs
// ===========================================================================

describe('P1-8b [privacy] F-178/F-176 — roster PI never leaks off the DOM surface', () => {
  it('[F-178] display_name / off_employer_contact / full uid are absent from URL, history, sessionStorage, localStorage', async () => {
    const { container } = renderRoster({ results: [OK(ALL_FIVE)] });
    await screen.findByTestId('committee-roster-list');

    // The co-chair legitimately SEES PI in the DOM — sanity that it rendered.
    expect(container.textContent ?? '').toContain('Active Alice');
    expect(container.textContent ?? '').toContain('alice.personal@example.test');

    const secrets = [
      'Active Alice',
      'Grant Gordon',
      'alice.personal@example.test',
      UID_ACTIVE,
      UID_GRANT,
      UID_REMOVED
    ];
    const haystacks: string[] = [];
    if (typeof window !== 'undefined' && window.location) {
      haystacks.push(window.location.href, window.location.search, window.location.hash);
    }
    if (typeof sessionStorage !== 'undefined') {
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k) haystacks.push(k + '=' + (sessionStorage.getItem(k) ?? ''));
      }
    }
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) haystacks.push(k + '=' + (localStorage.getItem(k) ?? ''));
      }
    }
    for (const h of haystacks) {
      for (const s of secrets) expect(h).not.toContain(s);
    }
  });

  it('[F-178] no member PI or raw uid reaches a log surface (console.* + structured log sink)', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.map(String).join(' ')));

    renderRoster({ results: [OK(ALL_FIVE)] });
    await screen.findByTestId('committee-roster-list');

    const haystacks = [...logs, ...__getCapturedLines().map((l) => JSON.stringify(l))];
    const secrets = ['Active Alice', 'alice.personal@example.test', UID_ACTIVE, UID_REMOVED];
    for (const h of haystacks) {
      for (const s of secrets) expect(h).not.toContain(s);
    }
  });

  it('[F-178] the roster read is parameterless — listRoster carries no PI-bearing arguments, and no query string is set', async () => {
    const { calls } = renderRoster({ results: [OK(ALL_FIVE)] });
    await screen.findByTestId('committee-roster-list');
    // The B1 read is whole-committee + JWT-bound — no target uid / filter / PI
    // rides the call (A-8.3 parameterless op).
    expect(calls.length).toBe(1);
    expect(calls[0]!.length).toBe(0);
    // The roster read never pushes PI into the URL.
    expect(window.location.search).toBe('');
  });
});

// ===========================================================================
// DETERMINISM — identical render regardless of the (frozen) wall clock
// ===========================================================================

describe('P1-8b [determinism] — absolute ISO dates, no time-of-day branching', () => {
  it('renders byte-identical row text at END_OF_DAY_UTC and at the default frozen instant', async () => {
    // First render at the default frozen clock.
    renderRoster({ results: [OK(ALL_FIVE)] });
    await screen.findByTestId('committee-roster-list');
    const first = rows().map((r) => (r.textContent ?? '').replace(/\s+/g, ' ').trim());
    cleanup();

    // Second render with the clock parked at 23:59:59.999 UTC (edge of day).
    restoreClock();
    freezeClock(END_OF_DAY_UTC);
    renderRoster({ results: [OK(ALL_FIVE)] });
    await screen.findByTestId('committee-roster-list');
    const second = rows().map((r) => (r.textContent ?? '').replace(/\s+/g, ' ').trim());

    expect(second).toEqual(first);
  });
});
