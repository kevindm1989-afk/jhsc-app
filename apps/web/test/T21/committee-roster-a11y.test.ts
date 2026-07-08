/**
 * ADR-0029 P1-8b — /committee roster ACCESSIBILITY contract (Surface K a11y packet).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY. These tests
 * become the accessibility-specialist's checklist: every mandatory a11y behavior
 * the designer pinned in Surface K §accessibility (AODA / WCAG 2.0 AA) is an
 * assertion here.
 *
 * Surface K a11y packet:
 *   - list semantics: <ul aria-label="Committee members">; each <li> is
 *     role="group" + aria-labelledby → its own name element (SR reads each member
 *     as one unit).
 *   - badges: never color-only — decorative icon (aria-hidden) + visible micro-
 *     text + a programmatic (SR) label carrying the full status.
 *   - not-a-co-chair announced POLITELY (role="status"); session-expired + error
 *     announced ASSERTIVELY (role="alert").
 *   - loading via aria-busy + a role="status" live region announcing the literal
 *     action; on success, a role="status" region announces the member count
 *     (a11y.committee.roster.loaded).
 *   - focus order = DOM order, no positive tabindex; every interactive element is
 *     a native <a>/<button>; roster rows are NON-interactive in P1-8b.
 *   - axe WCAG 2 AA structural sweep for the resting states.
 *
 * Mirrors redeem-card-a11y.test.ts (role/aria-busy/aria-describedby/focus
 * assertions + the project axe helper for the WCAG 2 AA sweep).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { freezeClock, restoreClock } from '../_helpers/clock';
import axeCheck from '../_helpers/axe-check';
import { __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
import { setJwt, __resetForTest } from '../../src/lib/auth/session-jwt-store';
import { t } from '../../src/lib/i18n';
import type {
  RosterRow,
  CommitteeOpResult,
  CommitteeOpReason
} from '../../src/lib/committee/supabase-committee-client';

// RED-FIRST import — created by the implementer.
import CommitteeRoster from '../../src/lib/committee/CommitteeRoster.svelte';

// ---------------------------------------------------------------------------
// Fixtures (this file owns them — no shared global fixtures).
// ---------------------------------------------------------------------------

type RosterResult = CommitteeOpResult<RosterRow[]>;
const OK = (rows: RosterRow[]): RosterResult => ({ ok: true, data: rows });
const ERR = (reason: CommitteeOpReason, status: number): RosterResult => ({
  ok: false,
  reason,
  status
});

function makeRow(over: Partial<RosterRow>): RosterRow {
  return {
    user_id: 'aaaaaaaa-1111-4111-8111-1111aaaa1111',
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

const ROW_ACTIVE = makeRow({
  user_id: 'aaaaaaaa-1111-4111-8111-1111aaaa1111',
  roles: ['worker_co_chair'],
  has_identity_key: true,
  has_live_wrap: true,
  display_name: 'Active Alice'
});
const ROW_PENDING_GRANT = makeRow({
  user_id: 'bbbbbbbb-2222-4222-8222-2222bbbb2222',
  has_identity_key: true,
  has_live_wrap: false,
  display_name: 'Grant Gordon'
});
const ROW_AWAITING = makeRow({
  user_id: 'cccccccc-3333-4333-8333-3333cccc3333',
  has_identity_key: false,
  has_live_wrap: false,
  display_name: 'Await Avery'
});
const ROW_INVITE = makeRow({
  user_id: 'dddddddd-4444-4444-8444-4444dddd4444',
  active: false,
  activated_at: null,
  deactivated_at: null,
  has_identity_key: false,
  has_live_wrap: false,
  display_name: 'Invite Ivan'
});
const ROW_REMOVED = makeRow({
  user_id: 'eeeeeeee-5555-4555-8555-5555eeee5555',
  active: false,
  activated_at: '2026-02-10T09:00:00.000Z',
  deactivated_at: '2026-03-15T09:00:00.000Z',
  grace_until: '2026-06-13T09:00:00.000Z',
  display_name: 'Removed Rita'
});
const ALL_FIVE = [ROW_ACTIVE, ROW_PENDING_GRANT, ROW_AWAITING, ROW_INVITE, ROW_REMOVED];

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
  if (opts.signedIn !== false) setJwt('test-jwt');
  const client = opts.client ?? fakeClient(opts.results ?? [OK([])]).client;
  return render(CommitteeRoster, { props: { client: client as never } });
}

function rows(): HTMLElement[] {
  return screen.queryAllByTestId('committee-roster-row');
}
function badgeOf(row: HTMLElement): HTMLElement {
  return row.querySelector('[data-testid="committee-badge"]') as HTMLElement;
}
function programmaticLabel(badge: HTMLElement): string {
  const aria = badge.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const hidden = badge.querySelector('.sr-only, [data-testid="committee-badge-sr"]');
  return (hidden?.textContent ?? '').trim();
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

beforeEach(() => {
  freezeClock();
  __resetCapture();
  __setTestSink();
  __resetForTest();
});

afterEach(() => {
  cleanup();
  __resetCapture();
  __resetForTest();
  vi.restoreAllMocks();
  restoreClock();
});

// ===========================================================================
// LIST / GROUP semantics
// ===========================================================================

describe('P1-8b [a11y] list semantics — <ul aria-label> + per-row role="group"', () => {
  it('the roster is a <ul> with aria-label = "Committee members"', async () => {
    renderRoster({ results: [OK(ALL_FIVE)] });
    const list = await screen.findByTestId('committee-roster-list');
    expect(list.tagName.toLowerCase()).toBe('ul');
    expect(list.getAttribute('aria-label')).toBe(t('committee.roster.list_aria'));
  });

  it('each row exposes a role="group" element with aria-labelledby → its OWN name element', async () => {
    renderRoster({ results: [OK(ALL_FIVE)] });
    await screen.findByTestId('committee-roster-list');
    for (const row of rows()) {
      // Each member is a labelled GROUP the SR reads as one self-contained unit
      // (name → badge → roles → contact → date). NOTE (Surface-K a11y conflict,
      // flagged to the designer): `role="group"` placed DIRECTLY on an <li>
      // strips the <li>'s implicit listitem role and fails axe's `list` structure
      // rule. The axe-clean realization keeps each <li> a listitem and carries
      // the group+aria-labelledby on the <li> OR a wrapper inside it — either
      // satisfies "announced as a named unit" while keeping the <ul>/<li> valid.
      const group =
        row.getAttribute('role') === 'group'
          ? row
          : (row.querySelector('[role="group"]') as HTMLElement | null);
      expect(group, 'each row exposes a role="group" element').not.toBeNull();
      const labelledby = group!.getAttribute('aria-labelledby');
      expect(labelledby, 'the group carries aria-labelledby').toBeTruthy();
      const nameEl = document.getElementById((labelledby ?? '').split(/\s+/)[0]!);
      expect(nameEl, 'aria-labelledby must point at an existing name element').not.toBeNull();
      expect((nameEl?.textContent ?? '').trim().length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// BADGES — programmatic label, color never alone
// ===========================================================================

describe('P1-8b [a11y] badges — decorative icon + visible text + programmatic label', () => {
  it('every badge carries an aria-hidden icon AND a non-empty programmatic SR label', async () => {
    renderRoster({ results: [OK(ALL_FIVE)] });
    await screen.findByTestId('committee-roster-list');
    for (const row of rows()) {
      const badge = badgeOf(row);
      expect(badge, 'each row has a status badge').not.toBeNull();
      // Icon is decorative (aria-hidden) so the badge is not color/icon-only —
      // the visible text + the SR label carry the meaning.
      expect(badge.querySelector('[aria-hidden="true"]')).not.toBeNull();
      expect((badge.textContent ?? '').trim().length).toBeGreaterThan(0);
      expect(programmaticLabel(badge).length).toBeGreaterThan(0);
    }
  });

  it('the pending-grant badge announces the actionable "grant" status to a screen reader', async () => {
    renderRoster({ results: [OK([ROW_PENDING_GRANT])] });
    await screen.findByTestId('committee-roster-list');
    const badge = badgeOf(rows()[0]!);
    expect(programmaticLabel(badge)).toBe(t('committee.roster.badge.pending_grant.sr'));
  });
});

// ===========================================================================
// ROLE SPLIT — polite (status) vs assertive (alert)
// ===========================================================================

describe('P1-8b [a11y] live-region role split — polite vs assertive', () => {
  it('not-a-co-chair is POLITE (role="status") — a calm authz boundary, never alarming', async () => {
    renderRoster({ results: [ERR('rls_denied', 403)] });
    const stop = await screen.findByTestId('committee-not-co-chair');
    expect(stop.getAttribute('role')).toBe('status');
  });

  it('session-expired is ASSERTIVE (role="alert")', async () => {
    renderRoster({ results: [ERR('rls_denied', 401)] });
    const expired = await screen.findByTestId('committee-session-expired');
    expect(expired.getAttribute('role')).toBe('alert');
  });

  it('the generic error is ASSERTIVE (role="alert")', async () => {
    renderRoster({ results: [ERR('unknown', 500)] });
    const err = await screen.findByTestId('committee-list-error');
    expect(err.getAttribute('role')).toBe('alert');
  });

  it('empty + signed-out are POLITE (role="status")', async () => {
    renderRoster({ results: [OK([])] });
    const empty = await screen.findByTestId('committee-empty');
    expect(empty.getAttribute('role')).toBe('status');
    cleanup();
    renderRoster({ signedIn: false, results: [OK(ALL_FIVE)] });
    const signedOut = await screen.findByTestId('committee-signed-out');
    expect(signedOut.getAttribute('role')).toBe('status');
  });
});

// ===========================================================================
// LOADING — aria-busy + live region; SUCCESS — count announcement
// ===========================================================================

describe('P1-8b [a11y] loading + loaded live regions', () => {
  it('while loading, the container is aria-busy and a role="status" region announces the literal action', async () => {
    const { client, release } = gatedClient();
    renderRoster({ client });
    const loading = await screen.findByTestId('committee-loading');
    expect(loading.getAttribute('role')).toBe('status');
    expect(screen.getByTestId('committee-page').getAttribute('aria-busy')).toBe('true');
    release(OK(ALL_FIVE));
    await screen.findByTestId('committee-roster-list');
  });

  it('on a successful load, a role="status" region announces the member count (a11y.committee.roster.loaded)', async () => {
    renderRoster({ results: [OK(ALL_FIVE)] });
    await screen.findByTestId('committee-roster-list');
    const loaded = await screen.findByTestId('committee-roster-loaded');
    expect(loaded.getAttribute('role')).toBe('status');
    // The announcement carries the count (5 members in the fixture).
    expect(loaded.textContent ?? '').toContain('5');
  });
});

// ===========================================================================
// FOCUS ORDER / KEYBOARD OPERABILITY
// ===========================================================================

describe('P1-8b [a11y] focus order + keyboard operability', () => {
  it('no element carries a positive tabindex (DOM order only)', async () => {
    renderRoster({ results: [OK(ALL_FIVE)] });
    const container = await screen.findByTestId('committee-page');
    const positives = Array.from(container.querySelectorAll('[tabindex]')).filter(
      (el) => Number(el.getAttribute('tabindex')) > 0
    );
    expect(positives).toEqual([]);
  });

  it('roster rows are NON-interactive — not tab stops, no click handler affordance', async () => {
    renderRoster({ results: [OK(ALL_FIVE)] });
    await screen.findByTestId('committee-roster-list');
    for (const row of rows()) {
      expect(row.getAttribute('tabindex')).toBeNull();
      expect(row.querySelector('a[href], button')).toBeNull();
    }
  });

  it('the error Retry control is a native <button> (Enter/Space operable) and re-runs the read', async () => {
    const fc = fakeClient([ERR('unknown', 500), OK(ALL_FIVE)]);
    renderRoster({ client: fc.client });
    const err = await screen.findByTestId('committee-list-error');
    const retry = err.querySelector('button') as HTMLButtonElement;
    expect(retry.tagName.toLowerCase()).toBe('button');
    await fireEvent.click(retry);
    await screen.findByTestId('committee-roster-list');
    expect(fc.calls.length).toBe(2);
  });

  it('the back link (not-co-chair) and the sign-in link (session-expired) are real anchors', async () => {
    renderRoster({ results: [ERR('rls_denied', 403)] });
    const stop = await screen.findByTestId('committee-not-co-chair');
    const back = stop.querySelector('a[href="/more"]') as HTMLAnchorElement;
    expect(back.tagName.toLowerCase()).toBe('a');
    cleanup();
    renderRoster({ results: [ERR('rls_denied', 401)] });
    const expired = await screen.findByTestId('committee-session-expired');
    const signIn = expired.querySelector('a[href="/sign-in"]') as HTMLAnchorElement;
    expect(signIn.tagName.toLowerCase()).toBe('a');
  });
});

// ===========================================================================
// axe WCAG 2 AA structural sweep — the resting states
// ===========================================================================

describe('P1-8b [a11y] axe WCAG 2 AA structural sweep', () => {
  it('the roster-list state has no axe violations', async () => {
    const { container } = renderRoster({ results: [OK(ALL_FIVE)] });
    await screen.findByTestId('committee-roster-list');
    const r = await axeCheck(container, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });

  it('the not-a-co-chair state has no axe violations', async () => {
    const { container } = renderRoster({ results: [ERR('rls_denied', 403)] });
    await screen.findByTestId('committee-not-co-chair');
    const r = await axeCheck(container, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });

  it('the session-expired state has no axe violations', async () => {
    const { container } = renderRoster({ results: [ERR('rls_denied', 401)] });
    await screen.findByTestId('committee-session-expired');
    const r = await axeCheck(container, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });

  it('the generic-error state has no axe violations', async () => {
    const { container } = renderRoster({ results: [ERR('unknown', 500)] });
    await screen.findByTestId('committee-list-error');
    const r = await axeCheck(container, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });

  it('the empty state has no axe violations', async () => {
    const { container } = renderRoster({ results: [OK([])] });
    await screen.findByTestId('committee-empty');
    const r = await axeCheck(container, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });
});
