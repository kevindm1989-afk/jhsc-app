/**
 * ADR-0029 P1-8d — Surface K screen 3 (co-chair grant + F-172 fingerprint
 * confirm) STATE MACHINE. RED-FIRST (TDD). The implementer treats this file as
 * READ-ONLY.
 *
 * RED SIGNAL: `CommitteeGrantCard.svelte` does not exist yet, so this file
 * fails at module resolution until the implementer lands the component. That
 * import failure is the correct primary red signal (mirrors committee-invite.test.ts).
 *
 * WHAT THIS PINS (design-system.md §4 "Surface K — screen 3", the 5-states table):
 *   idle → disclosing → confirm → granting → granted | failed | not_ready.
 *   - Each state renders its pinned data-testid + the right copy.
 *   - Transitions fire on the right events (Grant tap / Confirm tap / Cancel /
 *     Close / Done), and the SINGLE getMemberPubkey disclosure fires on the
 *     deliberate Grant tap, NOT on mount (ISSUE-5 / A-8.7 — no pre-fetch).
 *   - Loading states (disclosing, granting) carry aria-busy + a POLITE live
 *     region naming the LITERAL action (never bare "Loading…").
 *   - Terminal states move focus ONCE to their heading and announce
 *     (granted/not_ready POLITE; failed ASSERTIVE).
 *
 * SEAM (harness note for the implementer):
 *   - `client.getMemberPubkey({target_user_id})` is a vi.fn we control; a
 *     deferred Promise lets us observe the transient `disclosing` state with no
 *     sleep, then resolve to `confirm`/`not_ready`/`failed`.
 *   - `wrapMemberInViaProduction` is MOCKED at its production-flows module seam
 *     (the crypto barrel re-exports it from there, so the mock propagates
 *     whether the component imports the barrel or the leaf). We do NOT touch
 *     production-flows.ts. A deferred Promise lets us observe `granting`.
 *
 * Determinism: fixed byte fixtures → real-libsodium fingerprint is reproducible;
 * no clock/RNG/network; deferred Promises (never sleeps) drive the loading
 * observations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/svelte';
import _sodium from 'libsodium-wrappers-sumo';
import { setJwt, clearJwt } from '../../src/lib/auth/session-jwt-store';
import { t } from '../../src/lib/i18n';
import { pubkeyFingerprint, CommitteeKeyHolder } from '../../src/lib/crypto';
import type { WrapMemberInResult } from '../../src/lib/crypto';

// ---------------------------------------------------------------------------
// Mock the wrapMemberInViaProduction seam (owned/refactored by the parallel
// wrap-member-in-production suite; A-8.6 adds the required `disclosed` arg). We
// keep every OTHER production-flows export real via importOriginal.
// ---------------------------------------------------------------------------
const { mockWrapMemberIn } = vi.hoisted(() => ({ mockWrapMemberIn: vi.fn() }));
vi.mock('../../src/lib/crypto/production-flows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/crypto/production-flows')>();
  return { ...actual, wrapMemberInViaProduction: mockWrapMemberIn };
});

// RED-FIRST import — the implementer creates this lib component.
import CommitteeGrantCard from '../../src/lib/committee/CommitteeGrantCard.svelte';

await _sodium.ready;
const sodium = _sodium;

// ---------------------------------------------------------------------------
// Fixtures — this file owns them. Synthetic uids; no PII.
// ---------------------------------------------------------------------------
const ACTOR = '9f4e9b40-0000-4000-8000-00000000001a'; // co-chair (caller)
const MEMBER = '9f4e9b40-0000-4000-8000-00000000002b'; // target member
const MEMBER_NAME = 'Sam Rivera'; // synthetic display name

/** A FIXED 32-byte X25519 scalar → deterministic member pub + fingerprint. */
const DEVICE_PRIV = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const DEVICE_PUB = sodium.crypto_scalarmult_base(DEVICE_PRIV);
const EXPECTED_FP = await pubkeyFingerprint(DEVICE_PUB); // 64 lowercase hex

type DisclosureOk = { ok: true; data: { public_key: Uint8Array; fingerprint: string } };
type DisclosureErr = { ok: false; reason: string; status: number };
type Disclosure = DisclosureOk | DisclosureErr;

const OK_DISCLOSURE: DisclosureOk = { ok: true, data: { public_key: DEVICE_PUB, fingerprint: EXPECTED_FP } };

// ADV-1 / F-174 disclosure-ordering fix: the grant screen reads a pre-disclosure
// committee-key-state probe (mirrors the P1-9 getCommitteeKeyState shape) BEFORE
// it discloses the target pubkey. `actor_has_wrap:true` is the happy path (the
// co-chair can grant); `actor_has_wrap:false` short-circuits to the new
// `not_provisioned_actor` terminal WITHOUT any disclosure.
type KeyState =
  | { ok: true; data: { key_id: string; epoch: number; wrap_count: number; actor_has_wrap: boolean } | null }
  | { ok: false; reason: string; status: number };

const KEY_STATE_HAS_WRAP: KeyState = {
  ok: true,
  data: { key_id: 'k-1', epoch: 1, wrap_count: 1, actor_has_wrap: true }
};
const KEY_STATE_NO_WRAP: KeyState = {
  ok: true,
  data: { key_id: 'k-1', epoch: 1, wrap_count: 0, actor_has_wrap: false }
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Mock t07 client exposing the single disclosure this screen owns PLUS the
 * pre-disclosure `getCommitteeKeyState` probe the F-174 fix reads. The default
 * key-state HAS a wrap (the happy path); pass `KEY_STATE_NO_WRAP` for the
 * unprovisioned-co-chair short-circuit. Both resolve immediately so a deferred
 * `getMemberPubkey` still drives the transient `disclosing` observation.
 */
function makeClient(
  disclosure: Disclosure | Promise<Disclosure> = OK_DISCLOSURE,
  keyState: KeyState | Promise<KeyState> = KEY_STATE_HAS_WRAP
) {
  const getMemberPubkey = vi.fn(async (_input: { target_user_id: string }) => disclosure);
  const getCommitteeKeyState = vi.fn(async (_input: { actor_user_id: string }) => keyState);
  return { getMemberPubkey, getCommitteeKeyState };
}

function makeJwt(sub: string): string {
  const seg = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${seg({ alg: 'ES256', typ: 'JWT' })}.${seg({ sub, iat: 1700000000, exp: 1700001000 })}.sig`;
}

interface RenderOver {
  member?: { user_id: string; display_name: string | null };
  client?: ReturnType<typeof makeClient>;
  holder?: CommitteeKeyHolder;
  localIdentity?: { getIdentityPrivateKey: (uid: string) => Promise<Uint8Array> };
}

function renderGrant(over: RenderOver = {}) {
  setJwt(makeJwt(ACTOR)); // the grant component reads the actor uid from session
  const client = over.client ?? makeClient();
  const holder = over.holder ?? new CommitteeKeyHolder();
  const localIdentity =
    over.localIdentity ?? { getIdentityPrivateKey: vi.fn(async () => DEVICE_PRIV) };
  const member = over.member ?? { user_id: MEMBER, display_name: MEMBER_NAME };
  const utils = render(CommitteeGrantCard, {
    props: { member, client, holder, localIdentity } as never
  });
  return { ...utils, client, holder, localIdentity, member };
}

/** Click the per-row Grant-access CTA for the given member uid. */
async function tapGrant(uid: string = MEMBER) {
  const cta = screen.getByTestId(`committee-grant-cta-${uid}`);
  await fireEvent.click(cta);
  return cta;
}

/** Drive idle → confirm (disclosure resolves ok). Returns the confirm panel. */
async function toConfirm(over: RenderOver = {}) {
  const utils = renderGrant(over);
  await tapGrant(utils.member.user_id);
  const panel = await screen.findByTestId('committee-grant-confirm');
  return { ...utils, panel };
}

let clipboardWrites: string[] = [];

beforeEach(() => {
  clipboardWrites = [];
  mockWrapMemberIn.mockReset();
  mockWrapMemberIn.mockResolvedValue({ status: 'ok' } satisfies WrapMemberInResult);
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (s: string) => void clipboardWrites.push(String(s)) }
  });
});

afterEach(() => {
  cleanup();
  clearJwt();
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: undefined });
  vi.restoreAllMocks();
});

// ===========================================================================
// idle — the per-row Grant-access affordance; NO disclosure on mount (A-8.7)
// ===========================================================================

describe('P1-8d [idle] per-row Grant-access affordance', () => {
  it('renders the Grant-access CTA with the member-scoped testid + an unambiguous accessible name', () => {
    const { client } = renderGrant();
    const cta = screen.getByTestId(`committee-grant-cta-${MEMBER}`);
    expect(cta.tagName.toLowerCase(), 'the CTA is a native <button>').toBe('button');
    // Accessible name is unambiguous out of list context (design-system.md :765).
    expect(cta.getAttribute('aria-label') ?? cta.textContent ?? '').toBe(
      t('committee.grant.row.cta_aria', { name: MEMBER_NAME })
    );
    // A11Y-1 (WCAG 2.5.3 Label in Name): the VISIBLE label ("Grant access") must
    // be a substring of the accessible name so a speech-input user can activate it.
    const visibleLabel = t('committee.grant.row.cta');
    const accName = cta.getAttribute('aria-label') ?? cta.textContent ?? '';
    expect(accName, `accessible name must contain the visible label "${visibleLabel}"`).toContain(
      visibleLabel
    );
    // No disclosure has fired yet — the disclosure is deliberate-tap-only (A-8.7).
    expect(client.getMemberPubkey).not.toHaveBeenCalled();
    // Nor the pre-disclosure key-state probe (also deliberate-tap-only, F-174).
    expect(
      client.getCommitteeKeyState,
      'no key-state probe on mount (deliberate-tap only)'
    ).not.toHaveBeenCalled();
    expect(cta.getAttribute('aria-expanded')).toBe('false');
  });

  it('does NOT render the confirm panel or any terminal state before the Grant tap', () => {
    renderGrant();
    expect(screen.queryByTestId('committee-grant-confirm')).toBeNull();
    expect(screen.queryByTestId('committee-grant-disclosing')).toBeNull();
    expect(screen.queryByTestId('committee-grant-granted')).toBeNull();
    expect(screen.queryByTestId('committee-grant-failed')).toBeNull();
    expect(screen.queryByTestId('committee-grant-not-ready')).toBeNull();
  });
});

// ===========================================================================
// disclosing — transient loading; the single disclosure is in flight
// ===========================================================================

describe('P1-8d [disclosing] loading state while getMemberPubkey is in flight', () => {
  it('mounts the panel with aria-busy + a POLITE live region naming the literal action', async () => {
    const d = deferred<Disclosure>();
    const client = makeClient(d.promise);
    const { container } = renderGrant({ client });

    const cta = await tapGrant();
    // Transient disclosing state is visible while the disclosure is unresolved.
    const disclosing = await screen.findByTestId('committee-grant-disclosing');
    expect(disclosing).toBeTruthy();
    // aria-busy on the panel signals the async to assistive tech.
    expect(container.querySelector('[aria-busy="true"]'), 'panel is aria-busy while disclosing').not.toBeNull();
    // The live region names the LITERAL action, not a bare "Loading…".
    const statuses = Array.from(container.querySelectorAll('[role="status"]'));
    expect(
      statuses.some((r) => (r.textContent ?? '').includes(t('committee.grant.disclosing'))),
      'a role="status" region carries committee.grant.disclosing'
    ).toBe(true);
    // The CTA is disabled so a double-tap cannot fire a second disclosure.
    expect((cta as HTMLButtonElement).disabled, 'Grant CTA is disabled during disclose').toBe(true);

    // Resolve → confirm (drain the deferred so no dangling Promise).
    d.resolve(OK_DISCLOSURE);
    await screen.findByTestId('committee-grant-confirm');
  });

  it('resolves disclosing → confirm on a successful disclosure', async () => {
    const { panel } = await toConfirm();
    expect(panel).toBeTruthy();
    expect(screen.queryByTestId('committee-grant-disclosing')).toBeNull();
  });
});

// ===========================================================================
// confirm — the interactive resting state: identity line + fingerprint + copy
// ===========================================================================

describe('P1-8d [confirm] identity + disclosed-fingerprint + compare + actions', () => {
  it('renders the member-identity line, the fingerprint block, the compare callout, and both actions', async () => {
    const { panel } = await toConfirm();
    const text = panel.textContent ?? '';

    // (1) member-identity line — the named member.
    expect(text).toContain(MEMBER_NAME);
    // (2) lead teaching "check you're granting to the right person".
    expect(text).toContain(t('committee.grant.confirm.lead'));
    // (3) the disclosed-fingerprint block (the cross-surface mirror).
    const fpBox = within(panel).getByTestId('committee-grant-fingerprint');
    expect(fpBox).toBeTruthy();
    // (4) the compare callout heading.
    expect(text).toContain(t('committee.grant.compare.heading'));
    // (5) actions: the affirmative CTA + Cancel, both native buttons.
    const cta = within(panel).getByRole('button', { name: t('committee.grant.confirm.cta') });
    const cancel = within(panel).getByRole('button', { name: t('committee.grant.confirm.cancel') });
    expect(cta.tagName.toLowerCase()).toBe('button');
    expect(cancel.tagName.toLowerCase()).toBe('button');
  });

  it('the fingerprint block reassembles to the disclosed 64-hex (16 groups of 4)', async () => {
    const { panel } = await toConfirm();
    const fpBox = within(panel).getByTestId('committee-grant-fingerprint');
    const groups = Array.from(fpBox.querySelectorAll('[role="img"]')) as HTMLElement[];
    expect(groups).toHaveLength(16);
    expect(groups.map((g) => (g.textContent ?? '').trim()).join('')).toBe(EXPECTED_FP);
  });

  it('renders the uid-fragment disambiguator (never the full uid) for a nameless member', async () => {
    const { panel } = await toConfirm({ member: { user_id: MEMBER, display_name: null } });
    const text = panel.textContent ?? '';
    expect(text).toContain(t('committee.roster.row.unnamed'));
    expect(text).toContain(MEMBER.slice(0, 8)); // 8-char fragment
    expect(text, 'the full member uid is never rendered').not.toContain(MEMBER);
  });

  it('Cancel unmounts the panel and returns focus to the Grant-access CTA (ISSUE-5 benign cancel)', async () => {
    const { panel, member } = await toConfirm();
    const cancel = within(panel).getByRole('button', { name: t('committee.grant.confirm.cancel') });
    await fireEvent.click(cancel);

    await waitFor(() => expect(screen.queryByTestId('committee-grant-confirm')).toBeNull());
    const cta = screen.getByTestId(`committee-grant-cta-${member.user_id}`);
    await waitFor(() => expect(document.activeElement).toBe(cta));
    // wrapMemberInViaProduction was never called — Cancel does not seal.
    expect(mockWrapMemberIn).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// granting — loading; the seal + wrap POST is in flight (server-truthed only)
// ===========================================================================

describe('P1-8d [granting] loading state while wrapMemberInViaProduction is in flight', () => {
  it('shows the literal action + aria-busy + a polite live region, and Cancel is disabled', async () => {
    const wrap = deferred<WrapMemberInResult>();
    mockWrapMemberIn.mockReturnValue(wrap.promise);
    const { panel, container } = await toConfirm();

    await fireEvent.click(within(panel).getByRole('button', { name: t('committee.grant.confirm.cta') }));

    const granting = await screen.findByTestId('committee-grant-granting');
    expect(granting).toBeTruthy();
    expect(container.querySelector('[aria-busy="true"]'), 'panel is aria-busy while granting').not.toBeNull();
    const statuses = Array.from(container.querySelectorAll('[role="status"]'));
    expect(
      statuses.some((r) => (r.textContent ?? '').includes(t('a11y.committee.grant.granting'))),
      'a role="status" region carries a11y.committee.grant.granting'
    ).toBe(true);
    // Cancel remains present but disabled (the panel keeps a control set).
    const cancel = within(panel).getByRole('button', {
      name: t('committee.grant.confirm.cancel')
    }) as HTMLButtonElement;
    expect(cancel.disabled, 'Cancel is disabled during granting').toBe(true);

    wrap.resolve({ status: 'ok' });
    await screen.findByTestId('committee-grant-granted');
  });

  // A11Y-2 (WCAG 2.4.3 Focus Order) — the CTA the user just activated MUST NOT
  // be unmounted on confirm→granting (that orphans focus to <body>). design-
  // system.md:769 keeps the SAME <button> mounted as a disabled loading button
  // (spinner + "Granting access…" INSIDE the button). RED against current code,
  // which swaps the CTA <button> for a <div> and drops focus.
  it('keeps the confirm CTA MOUNTED as an aria-disabled aria-busy loading button and does NOT lose focus to <body>', async () => {
    const wrap = deferred<WrapMemberInResult>();
    mockWrapMemberIn.mockReturnValue(wrap.promise);
    const { panel } = await toConfirm();

    const cta = within(panel).getByRole('button', {
      name: t('committee.grant.confirm.cta')
    }) as HTMLButtonElement;
    // Model the browser's click-focuses-button behaviour (jsdom's fireEvent.click
    // does NOT move focus): the CTA holds focus at the moment of the transition.
    cta.focus();
    expect(document.activeElement, 'the CTA holds focus before the transition').toBe(cta);

    await fireEvent.click(cta);

    const granting = (await screen.findByTestId('committee-grant-granting')) as HTMLButtonElement;
    // The granting affordance IS an aria-disabled, aria-busy <button> (not a bare
    // <div>). aria-disabled (not native `disabled`) keeps it focusable so focus is
    // genuinely retained in a real browser (native disabled would blur to <body>).
    expect(granting.tagName.toLowerCase(), 'the granting affordance is a native <button>').toBe(
      'button'
    );
    expect(
      granting.getAttribute('aria-disabled'),
      'the loading button is aria-disabled (stays focusable → focus retained)'
    ).toBe('true');
    expect(granting.getAttribute('aria-busy'), 'the loading button is aria-busy').toBe('true');
    // The literal action is named in/with the button, never a bare spinner.
    expect(
      (granting.textContent ?? '') + ' ' + (panel.textContent ?? ''),
      'the loading state names the literal action'
    ).toContain(t('committee.grant.granting'));

    // WCAG 2.4.3: focus is NOT orphaned to <body>; it rests on the aria-disabled
    // loading button (which stays focusable, so focus is retained in a real
    // browser, not just jsdom).
    expect(document.activeElement, 'focus is not orphaned to <body>').not.toBe(document.body);
    expect(document.activeElement, 'focus stays on the aria-disabled loading button').toBe(granting);

    // Cancel is still present (a disabled escape hatch).
    expect(
      within(panel).getByRole('button', { name: t('committee.grant.confirm.cancel') })
    ).toBeTruthy();

    wrap.resolve({ status: 'ok' });
    await screen.findByTestId('committee-grant-granted');
  });
});

// ===========================================================================
// granted — terminal success; ONLY from { status:'ok' }
// ===========================================================================

describe('P1-8d [granted] terminal success', () => {
  it('renders the granted panel with the success copy, moves focus to the heading, announces politely', async () => {
    const { panel, container } = await toConfirm();
    await fireEvent.click(within(panel).getByRole('button', { name: t('committee.grant.confirm.cta') }));

    const granted = await screen.findByTestId('committee-grant-granted');
    const text = granted.textContent ?? '';
    expect(text).toContain(t('committee.grant.granted.heading'));
    expect(text).toContain(t('committee.grant.granted.body', { name: MEMBER_NAME }));

    // Focus moves ONCE to the granted heading (tabindex=-1 programmatic target).
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.getAttribute('tabindex')).toBe('-1');
      expect((active?.textContent ?? '').includes(t('committee.grant.granted.heading'))).toBe(true);
    });
    // Announced POLITELY (a success, not an interruption).
    const statuses = Array.from(container.querySelectorAll('[role="status"]'));
    expect(
      statuses.some((r) => (r.textContent ?? '').includes(t('a11y.committee.grant.granted', { name: MEMBER_NAME })))
    ).toBe(true);
    // No alert role for a success.
    expect(granted.closest('[role="alert"]')).toBeNull();
  });

  it('Done unmounts the panel and returns focus to the Grant-access CTA', async () => {
    const { panel, member } = await toConfirm();
    await fireEvent.click(within(panel).getByRole('button', { name: t('committee.grant.confirm.cta') }));
    const granted = await screen.findByTestId('committee-grant-granted');
    await fireEvent.click(within(granted).getByRole('button', { name: t('committee.grant.granted.done') }));

    await waitFor(() => expect(screen.queryByTestId('committee-grant-granted')).toBeNull());
    const cta = screen.getByTestId(`committee-grant-cta-${member.user_id}`);
    await waitFor(() => expect(document.activeElement).toBe(cta));
  });
});

// ===========================================================================
// failed — terminal error; ASSERTIVE announce, reason-mapped copy
// ===========================================================================

describe('P1-8d [failed] terminal error', () => {
  it('renders the failed panel as role="alert", moves focus to the heading, announces assertively', async () => {
    mockWrapMemberIn.mockResolvedValue({ status: 'failed', reason: 'wrap_post_failed', http: 500 });
    const { panel, container } = await toConfirm();
    await fireEvent.click(within(panel).getByRole('button', { name: t('committee.grant.confirm.cta') }));

    const failed = await screen.findByTestId('committee-grant-failed');
    expect(failed.textContent ?? '').toContain(t('committee.grant.failed.heading'));
    // role="alert" (assertive — a real failure needing action).
    expect(failed.closest('[role="alert"]') ?? failed.querySelector('[role="alert"]')).not.toBeNull();

    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.getAttribute('tabindex')).toBe('-1');
      expect((active?.textContent ?? '').includes(t('committee.grant.failed.heading'))).toBe(true);
    });
    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(alerts.some((r) => (r.textContent ?? '').includes(t('a11y.committee.grant.failed')))).toBe(true);
  });

  it('Close unmounts the panel and returns focus to the Grant-access CTA', async () => {
    mockWrapMemberIn.mockResolvedValue({ status: 'failed', reason: 'unknown' });
    const { panel, member } = await toConfirm();
    await fireEvent.click(within(panel).getByRole('button', { name: t('committee.grant.confirm.cta') }));
    const failed = await screen.findByTestId('committee-grant-failed');
    await fireEvent.click(within(failed).getByRole('button', { name: t('committee.grant.failed.close') }));

    await waitFor(() => expect(screen.queryByTestId('committee-grant-failed')).toBeNull());
    const cta = screen.getByTestId(`committee-grant-cta-${member.user_id}`);
    await waitFor(() => expect(document.activeElement).toBe(cta));
  });
});

// ===========================================================================
// not_ready — expected boundary; POLITE, no Retry (disclosure member_not_enrolled)
// ===========================================================================

describe('P1-8d [not_ready] the member has not finished enrolling', () => {
  it('a member_not_enrolled disclosure renders the calm not_ready stop — POLITE, no wrap, no Retry', async () => {
    const client = makeClient({ ok: false, reason: 'member_not_enrolled', status: 200 });
    const { container } = renderGrant({ client });
    await tapGrant();

    const notReady = await screen.findByTestId('committee-grant-not-ready');
    const text = notReady.textContent ?? '';
    expect(text).toContain(t('committee.grant.not_ready.heading'));
    expect(text).toContain(t('committee.grant.not_ready.body'));

    // POLITE (role="status"), NOT an alert — this is a normal "not yet".
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(notReady.closest('[role="alert"]')).toBeNull();
    // No wrap was attempted (nothing to seal to yet).
    expect(mockWrapMemberIn).not.toHaveBeenCalled();
    // A single Close (no Retry — retrying will not change the answer).
    expect(within(notReady).queryByRole('button', { name: t('committee.grant.failed.retry') })).toBeNull();
    expect(within(notReady).getByRole('button', { name: t('committee.grant.not_ready.close') })).toBeTruthy();
  });

  it('focuses the not_ready heading on entry; Close returns focus to the Grant-access CTA', async () => {
    const client = makeClient({ ok: false, reason: 'member_not_enrolled', status: 200 });
    renderGrant({ client });
    await tapGrant();
    const notReady = await screen.findByTestId('committee-grant-not-ready');
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.getAttribute('tabindex')).toBe('-1');
      expect((active?.textContent ?? '').includes(t('committee.grant.not_ready.heading'))).toBe(true);
    });
    await fireEvent.click(within(notReady).getByRole('button', { name: t('committee.grant.not_ready.close') }));
    const cta = screen.getByTestId(`committee-grant-cta-${MEMBER}`);
    await waitFor(() => expect(document.activeElement).toBe(cta));
  });
});

// ===========================================================================
// not_provisioned_actor — F-174 disclosure-ordering fix (ADV-1). The
// pre-disclosure getCommitteeKeyState probe stops an unprovisioned co-chair
// (actor_has_wrap:false) BEFORE any getMemberPubkey disclosure, so no
// `disclosed_for_wrap` audit row is written for a grant that would abort.
// ===========================================================================

describe('P1-8d [not_provisioned_actor / F-174] an unprovisioned co-chair is stopped BEFORE disclosing', () => {
  it('a no-wrap actor tapping Grant NEVER calls getMemberPubkey (no disclosure, no audit row)', async () => {
    const client = makeClient(OK_DISCLOSURE, KEY_STATE_NO_WRAP);
    renderGrant({ client });
    await tapGrant();

    // Settle to whatever the flow reaches — fixed code: not_provisioned; current
    // buggy code: confirm (it discloses unconditionally, THEN aborts later).
    await waitFor(() => {
      const settled =
        screen.queryByTestId('committee-grant-not-provisioned') ??
        screen.queryByTestId('committee-grant-confirm') ??
        screen.queryByTestId('committee-grant-failed');
      expect(settled, 'the grant flow reached a settled state').not.toBeNull();
    });

    // THE load-bearing F-174 ordering invariant: no pubkey disclosure for an
    // unprovisioned co-chair (so no disclosed_for_wrap audit row is written).
    expect(
      client.getMemberPubkey,
      'F-174: an unprovisioned co-chair must NOT disclose the target pubkey'
    ).toHaveBeenCalledTimes(0);
    // The key-state probe ran first, scoped to the session actor uid.
    expect(client.getCommitteeKeyState).toHaveBeenCalledWith({ actor_user_id: ACTOR });
  });

  it('renders the not_provisioned_actor terminal (POLITE, "finish your own setup" copy, no wrap, no Retry)', async () => {
    const client = makeClient(OK_DISCLOSURE, KEY_STATE_NO_WRAP);
    const { container } = renderGrant({ client });
    await tapGrant();

    const terminal = await screen.findByTestId('committee-grant-not-provisioned');
    const text = terminal.textContent ?? '';
    expect(text).toContain(t('committee.grant.not_provisioned.heading'));
    expect(text).toContain(t('committee.grant.not_provisioned.body'));

    // POLITE (role="status"), NOT an alert — a "finish your setup first" stop,
    // not a crypto failure (mirrors not_ready).
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(terminal.closest('[role="alert"]')).toBeNull();
    // Nothing was sealed — the ceremony aborted before any wrap.
    expect(mockWrapMemberIn).not.toHaveBeenCalled();
    // A single Close (retrying without provisioning cannot change the answer).
    expect(
      within(terminal).queryByRole('button', { name: t('committee.grant.failed.retry') })
    ).toBeNull();
    expect(
      within(terminal).getByRole('button', { name: t('committee.grant.not_provisioned.close') })
    ).toBeTruthy();
  });

  it('focuses the not_provisioned heading on entry; Close returns focus to the Grant-access CTA', async () => {
    const client = makeClient(OK_DISCLOSURE, KEY_STATE_NO_WRAP);
    renderGrant({ client });
    await tapGrant();
    const terminal = await screen.findByTestId('committee-grant-not-provisioned');
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.getAttribute('tabindex')).toBe('-1');
      expect(
        (active?.textContent ?? '').includes(t('committee.grant.not_provisioned.heading'))
      ).toBe(true);
    });
    await fireEvent.click(
      within(terminal).getByRole('button', { name: t('committee.grant.not_provisioned.close') })
    );
    const cta = screen.getByTestId(`committee-grant-cta-${MEMBER}`);
    await waitFor(() => expect(document.activeElement).toBe(cta));
  });

  it('an actor WITH a wrap (actor_has_wrap:true) still discloses EXACTLY ONCE and reaches confirm', async () => {
    const client = makeClient(OK_DISCLOSURE, KEY_STATE_HAS_WRAP);
    renderGrant({ client });
    await tapGrant();
    await screen.findByTestId('committee-grant-confirm');
    // The happy path is unchanged: one deliberate disclosure once the probe clears.
    expect(client.getMemberPubkey).toHaveBeenCalledTimes(1);
    expect(client.getMemberPubkey).toHaveBeenCalledWith({ target_user_id: MEMBER });
    expect(screen.queryByTestId('committee-grant-not-provisioned')).toBeNull();
  });
});

// ===========================================================================
// SO-3 — reason → retryable mapping. `invalid_pubkey` is NOT a live retry: a
// re-seal of identical bytes yields the identical failure, so "Try again" is a
// dead button there. Genuinely-transient reasons (wrap_post_failed / unknown)
// keep "Try again".
// ===========================================================================

describe('P1-8d [SO-3] failed reason → retryable mapping (invalid_pubkey is a dead retry)', () => {
  async function toFailed(reason: string) {
    mockWrapMemberIn.mockResolvedValue({ status: 'failed', reason: reason as never });
    const { panel } = await toConfirm();
    await fireEvent.click(
      within(panel).getByRole('button', { name: t('committee.grant.confirm.cta') })
    );
    return screen.findByTestId('committee-grant-failed');
  }

  it('invalid_pubkey offers NO "Try again" (re-seal is a dead retry) — only Close', async () => {
    const failed = await toFailed('invalid_pubkey');
    expect(
      within(failed).queryByRole('button', { name: t('committee.grant.failed.retry') }),
      'invalid_pubkey must NOT be retryable (retry re-seals identical bytes → identical failure)'
    ).toBeNull();
    expect(
      within(failed).getByRole('button', { name: t('committee.grant.failed.close') })
    ).toBeTruthy();
  });

  it('wrap_post_failed KEEPS "Try again" (a genuinely transient failure)', async () => {
    const failed = await toFailed('wrap_post_failed');
    expect(
      within(failed).getByRole('button', { name: t('committee.grant.failed.retry') })
    ).toBeTruthy();
  });

  it('unknown KEEPS "Try again"', async () => {
    const failed = await toFailed('unknown');
    expect(
      within(failed).getByRole('button', { name: t('committee.grant.failed.retry') })
    ).toBeTruthy();
  });

  it.each(['pubkey_disclosure_denied', 'actor_has_no_wrap', 'data_key_unwrap_failed', 'decrypt_failed'])(
    'non-retryable reason "%s" offers only Close (no Try again)',
    async (reason) => {
      const failed = await toFailed(reason);
      expect(
        within(failed).queryByRole('button', { name: t('committee.grant.failed.retry') })
      ).toBeNull();
      expect(
        within(failed).getByRole('button', { name: t('committee.grant.failed.close') })
      ).toBeTruthy();
    }
  );
});

// ===========================================================================
// ADV-4 — onRetry phase guard: a double-activated "Try again" must seal ONCE.
// onRetry currently lacks the phase guard its siblings have, so two synchronous
// activations fire two seals. Fix: `if (phase !== 'failed') return;` at the top.
// ===========================================================================

describe('P1-8d [ADV-4] "Try again" is idempotent under a synchronous double-activation', () => {
  it('double-activating Try again calls wrapMemberInViaProduction exactly once (one extra seal, not two)', async () => {
    // First attempt fails on a retryable reason so the Retry button renders …
    mockWrapMemberIn.mockResolvedValueOnce({ status: 'failed', reason: 'wrap_post_failed' });
    // … and the retry itself hangs (deferred) so both synchronous activations
    // race the phase GUARD, not the re-render.
    const retryWrap = deferred<WrapMemberInResult>();
    mockWrapMemberIn.mockReturnValueOnce(retryWrap.promise);

    const { panel } = await toConfirm();
    await fireEvent.click(
      within(panel).getByRole('button', { name: t('committee.grant.confirm.cta') })
    );
    const failed = await screen.findByTestId('committee-grant-failed');
    expect(mockWrapMemberIn, 'the initial (failed) seal').toHaveBeenCalledTimes(1);

    const retry = within(failed).getByRole('button', { name: t('committee.grant.failed.retry') });
    // Two SYNCHRONOUS activations of the SAME button reference, before Svelte can
    // re-render the failed terminal away. Without the guard both run onRetry →
    // two seals; with `if (phase !== 'failed') return` the second is a no-op.
    retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await screen.findByTestId('committee-grant-granting');
    // Exactly ONE additional seal (the retry) — total 2, never 3.
    expect(
      mockWrapMemberIn,
      'a double-activated Try again must seal exactly once (onRetry needs a phase guard)'
    ).toHaveBeenCalledTimes(2);

    retryWrap.resolve({ status: 'ok' });
    await screen.findByTestId('committee-grant-granted');
  });
});
