/**
 * ADR-0029 P1-8c — /committee co-chair INVITE-A-MEMBER surface (Surface K, screen 2).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY. It pins the
 * behavioral + custody + privacy contract of the invite panel + one-time-code
 * display BEFORE the component exists, so the suite MUST fail at import
 * (`CommitteeInvite.svelte` is missing) until the implementer ships it. That
 * import failure is the correct primary red signal.
 *
 * Why a `CommitteeInvite.svelte` lib component (not `/committee/+page.svelte`):
 * route shells import `$app/*` + `$env/dynamic/public`, which the vitest runner
 * does not mount cleanly — the repo convention (CommitteeRoster / RedeemCard) is
 * to render the underlying lib component the route composes and pin the shell
 * structurally (committee-route-mount.test.ts). CommitteeInvite is the screen-2
 * component the /committee route mounts at the top of the roster section; the
 * route wires `createSupabaseCommitteeClient` and forwards the client.
 *
 * Injection style mirrors CommitteeRoster (real Svelte props, production-safe):
 *   - `client` — an object exposing
 *       issueInvite({roles,code,ttl_minutes}): Promise<CommitteeOpResult<IssueInviteData>>
 *       reissueTotp({invite_id,code}):        Promise<CommitteeOpResult<ReissueTotpData>>
 *     Tests inject a fake that RECORDS call inputs + returns queued results. The
 *     6-digit code is CLIENT-generated (crypto) inside the component; the test
 *     reads the generated code back off the recorded `issueInvite` input.
 *
 * RESOLVED CONTRACT (Amendment A-8.4 + Surface K screens 2/4; DECIDED — orchestrator
 * resolutions 2026-07-13; do NOT reopen):
 *   - F-170 (custody, load-bearing): exactly ONE clipboard affordance and it copies
 *     the REDEEM LINK only (/redeem?invite_id=<id>), NEVER the code. The code is
 *     selectable static text with NO copy/share control; no single control copies
 *     code+link together.
 *   - F-176: the client generates the 6-digit code (crypto-random) held in ONE
 *     in-memory variable; it NEVER appears in URL/history/sessionStorage/
 *     localStorage/log-sink/DOM attribute. The server response fields
 *     invitee_user_id / bootstrap_id are NEVER rendered.
 *   - issueInvite is called with ttl_minutes === 10080 (the 7-day INVITE TTL, a
 *     lib/committee constant — NOT 15, NOT the 15-min TOTP window) + the selected
 *     roles[] + a 6-digit code.
 *   - Roles-only form (worker_member | worker_co_chair | certified_member); NO
 *     display_name field. worker_member pre-checked.
 *   - Error mapping: rls_denied(403) → not-a-co-chair; invalid_role → role error;
 *     any other/unexpected INCLUDING a 429 → generic error (429 is defensive-only).
 *     The raw reason enum is NEVER rendered.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
import { setJwt, __resetForTest } from '../../src/lib/auth/session-jwt-store';
import { t } from '../../src/lib/i18n';
import type {
  IssueInviteData,
  ReissueTotpData,
  CommitteeOpResult,
  CommitteeOpReason
} from '../../src/lib/committee/supabase-committee-client';

// RED-FIRST import — the implementer creates this lib component. Until it exists,
// every test in this file fails at module resolution (the correct red signal).
import CommitteeInvite from '../../src/lib/committee/CommitteeInvite.svelte';

// ---------------------------------------------------------------------------
// Fixtures — this file owns them (no shared global fixtures). Distinctive
// canaries for the F-176 leak sweep. No real PII.
// ---------------------------------------------------------------------------

type IssueResult = CommitteeOpResult<IssueInviteData>;
type ReissueResult = CommitteeOpResult<ReissueTotpData>;

const INVITE_ID = '7b1d3f00-0000-4000-8000-0000000000aa';
// invitee_user_id + bootstrap_id ride the server response but MUST NEVER be
// rendered (F-176). Distinctive canaries so a leak is unambiguous.
const INVITEE_UID = 'facade00-1111-4111-8111-invitee00uid'.replace('invitee00uid', 'aaaabbbbcccc');
const BOOTSTRAP_ID = 'b0075242-2222-4222-8222-bootstrapiddd'.replace('bootstrapiddd', 'ddddeeeeffff');

const OK_ISSUE = (over: Partial<IssueInviteData> = {}): IssueResult => ({
  ok: true,
  data: { invite_id: INVITE_ID, invitee_user_id: INVITEE_UID, bootstrap_id: BOOTSTRAP_ID, ...over }
});
const OK_REISSUE = (over: Partial<ReissueTotpData> = {}): ReissueResult => ({
  ok: true,
  data: { invite_id: INVITE_ID, bootstrap_id: BOOTSTRAP_ID, ...over }
});
// The error variant is structurally T-independent, so a bare error object is
// assignable to CommitteeOpResult<IssueInviteData> AND <ReissueTotpData> without
// generic-inference ambiguity.
const ERR = (
  reason: CommitteeOpReason,
  status: number
): { ok: false; reason: CommitteeOpReason; status: number } => ({ ok: false, reason, status });

// ---------------------------------------------------------------------------
// Fake committee client — records call inputs, returns queued results.
// Hermetic: no transport, no network, deterministic.
// ---------------------------------------------------------------------------

interface InviteCalls {
  issueInvite: Array<{ roles: string[]; code: string; ttl_minutes: number }>;
  reissueTotp: Array<{ invite_id: string; code: string }>;
}

function fakeClient(opts: { issue?: IssueResult[]; reissue?: ReissueResult[] }) {
  const calls: InviteCalls = { issueInvite: [], reissueTotp: [] };
  let issueI = 0;
  let reissueI = 0;
  const issue = opts.issue ?? [OK_ISSUE()];
  const reissue = opts.reissue ?? [OK_REISSUE()];
  const client = {
    issueInvite: async (input: { roles: string[]; code: string; ttl_minutes: number }) => {
      calls.issueInvite.push(input);
      return issue[Math.min(issueI++, issue.length - 1)];
    },
    reissueTotp: async (input: { invite_id: string; code: string }) => {
      calls.reissueTotp.push(input);
      return reissue[Math.min(reissueI++, reissue.length - 1)];
    }
  };
  return { client, calls };
}

function renderInvite(opts: { issue?: IssueResult[]; reissue?: ReissueResult[] } = {}) {
  __resetForTest();
  setJwt('test-jwt'); // co-chair confirmed upstream by the roster read; keep signed-in
  const built = fakeClient(opts);
  const utils = render(CommitteeInvite, { props: { client: built.client as never } });
  return { ...utils, calls: built.calls };
}

// ---------------------------------------------------------------------------
// DOM helpers.
// ---------------------------------------------------------------------------

function accName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Every attribute VALUE across the subtree (for the F-176 attribute sweep). */
function attrValues(root: Element): string[] {
  const out: string[] = [];
  const walk = (el: Element) => {
    for (const a of Array.from(el.attributes)) out.push(a.value);
    for (const c of Array.from(el.children)) walk(c);
  };
  walk(root);
  return out;
}

/** URL + storage haystacks (the F-176 leak sweep). */
function storageHaystacks(): string[] {
  const h: string[] = [];
  if (typeof window !== 'undefined' && window.location) {
    h.push(window.location.href, window.location.search, window.location.hash);
  }
  if (typeof sessionStorage !== 'undefined') {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k) h.push(k + '=' + (sessionStorage.getItem(k) ?? ''));
    }
  }
  if (typeof localStorage !== 'undefined') {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) h.push(k + '=' + (localStorage.getItem(k) ?? ''));
    }
  }
  return h;
}

/** The digits shown in the code display, stripped of any visual grouping. */
function shownCodeDigits(): string {
  const el = screen.getByTestId('committee-invite-code-value');
  return (el.textContent ?? '').replace(/\D/g, '');
}

/** All copy/clipboard affordances inside the custody card (name contains "copy"). */
function copyControls(card: HTMLElement): HTMLElement[] {
  return Array.from(card.querySelectorAll('button,a')).filter((el) =>
    /copy/i.test(accName(el))
  ) as HTMLElement[];
}

// ---------------------------------------------------------------------------
// Flow helpers.
// ---------------------------------------------------------------------------

async function openForm() {
  const cta = await screen.findByTestId('committee-invite-cta');
  await fireEvent.click(cta);
  return screen.findByTestId('committee-invite-form');
}

/** Toggle a role checkbox by its accessible (label) name. */
async function toggleRole(roleKey: 'worker_member' | 'worker_co_chair' | 'certified_member') {
  const box = screen.getByRole('checkbox', { name: t(`committee.invite.role.${roleKey}`) });
  await fireEvent.click(box);
  return box as HTMLInputElement;
}

async function submitForm() {
  const submit = screen.getByRole('button', { name: t('committee.invite.form.submit') });
  await fireEvent.click(submit);
}

/** Open the form + submit with the default role selection → resolve at code_shown. */
async function inviteToCodeShown() {
  await openForm();
  await submitForm();
  return screen.findByTestId('committee-invite-code');
}

// ---------------------------------------------------------------------------
// Clipboard stub — records every writeText payload.
// ---------------------------------------------------------------------------

let clipboardWrites: string[] = [];

beforeEach(() => {
  // Frozen clock — the panel must render identically at any instant. Determinism.
  freezeClock();
  __resetCapture();
  __setTestSink();
  __resetForTest();
  clipboardWrites = [];
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (s: string) => void clipboardWrites.push(String(s)) }
  });
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

afterEach(() => {
  cleanup();
  __resetCapture();
  __resetForTest();
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: undefined
  });
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  if (typeof localStorage !== 'undefined') localStorage.clear();
  vi.restoreAllMocks();
  restoreClock();
});

// ===========================================================================
// HAPPY PATH — Surface K screen 2: idle → form → submitting → code_shown
// ===========================================================================

describe('P1-8c Surface K screen 2 [happy] — idle → form → code_shown', () => {
  it('[screen2: idle] renders ONLY the "Invite a member" CTA (no form, no code yet)', async () => {
    renderInvite();
    const cta = await screen.findByTestId('committee-invite-cta');
    expect(cta.tagName.toLowerCase()).toBe('button');
    expect(accName(cta)).toBe(t('committee.invite.cta'));
    // The panel is not mounted until the CTA is tapped (toggle-to-mount).
    expect(screen.queryByTestId('committee-invite-form')).toBeNull();
    expect(screen.queryByTestId('committee-invite-code')).toBeNull();
  });

  it('[screen2: form] tapping the CTA mounts the ROLES-ONLY form — no display_name field', async () => {
    renderInvite();
    const form = await openForm();
    // The three role checkboxes, worker_member pre-checked (the default).
    const worker = screen.getByRole('checkbox', { name: t('committee.invite.role.worker_member') });
    expect((worker as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('checkbox', { name: t('committee.invite.role.worker_co_chair') })).toBeDefined();
    expect(screen.getByRole('checkbox', { name: t('committee.invite.role.certified_member') })).toBeDefined();
    // RESOLVED: roles-only. No display-name / name / email input anywhere.
    expect(form.querySelector('input[type="text"], input[type="email"], input[name*="name" i]')).toBeNull();
  });

  it('[screen2: code_shown] a successful issue swaps the form for the one-time-code custody card', async () => {
    renderInvite({ issue: [OK_ISSUE()] });
    const card = await inviteToCodeShown();
    expect(card).toBeDefined();
    // The form is gone; the code card owns the surface now.
    expect(screen.queryByTestId('committee-invite-form')).toBeNull();
    // The 6-digit code is displayed as static text (NOT an <input>).
    const codeEl = screen.getByTestId('committee-invite-code-value');
    expect(codeEl.tagName.toLowerCase()).not.toBe('input');
    expect(shownCodeDigits()).toMatch(/^\d{6}$/);
  });
});

// ===========================================================================
// THE ISSUE CALL — ttl_minutes === 10080, a 6-digit crypto code, the roles[]
// ===========================================================================

describe('P1-8c screen 2 [issueInvite contract] — ttl 10080 + crypto 6-digit code + roles', () => {
  it('[screen2] issueInvite is called with ttl_minutes === 10080 (the 7-day INVITE TTL, NOT 15)', async () => {
    const { calls } = renderInvite({ issue: [OK_ISSUE()] });
    await inviteToCodeShown();
    expect(calls.issueInvite.length).toBe(1);
    expect(calls.issueInvite[0]!.ttl_minutes).toBe(10080);
    // Guard against the 15-min TOTP window being mistaken for the invite TTL.
    expect(calls.issueInvite[0]!.ttl_minutes).not.toBe(15);
  });

  it('[screen2] issueInvite is called with a 6-digit code the CLIENT generated (/^\\d{6}$/)', async () => {
    const { calls } = renderInvite({ issue: [OK_ISSUE()] });
    await inviteToCodeShown();
    expect(calls.issueInvite[0]!.code).toMatch(/^\d{6}$/);
    // The displayed code IS the code that was sent to issueInvite (one variable).
    expect(shownCodeDigits()).toBe(calls.issueInvite[0]!.code);
  });

  it('[screen2 / F-176] the code is drawn from crypto.getRandomValues — NOT Math.random, NOT a constant', async () => {
    renderInvite({ issue: [OK_ISSUE()] });
    await openForm();
    // Install the RNG probes RIGHT BEFORE the generation window (submit) so only
    // the code-generation work is observed, not framework mount internals.
    const cryptoSpy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const mathSpy = vi.spyOn(Math, 'random');
    await submitForm();
    await screen.findByTestId('committee-invite-code');
    // Positive proof: the CSPRNG was consulted to mint the code.
    expect(cryptoSpy, 'the 6-digit code must be minted via crypto.getRandomValues').toHaveBeenCalled();
    // Negative proof: Math.random is NOT the entropy source for the code.
    expect(mathSpy, 'Math.random must NOT be used to mint the invite code').not.toHaveBeenCalled();
  });

  it('[screen2] the default submit sends exactly the pre-checked worker_member role', async () => {
    const { calls } = renderInvite({ issue: [OK_ISSUE()] });
    await inviteToCodeShown();
    expect(calls.issueInvite[0]!.roles).toEqual(['worker_member']);
  });

  it('[screen2] multi-select sends every checked role (role is a text[] set, not a tier)', async () => {
    const { calls } = renderInvite({ issue: [OK_ISSUE()] });
    await openForm();
    await toggleRole('worker_co_chair'); // add to the pre-checked worker_member
    await submitForm();
    await screen.findByTestId('committee-invite-code');
    const roles = calls.issueInvite[0]!.roles;
    expect(new Set(roles)).toEqual(new Set(['worker_member', 'worker_co_chair']));
  });
});

// ===========================================================================
// EDGE — role validation (batch-on-submit): "choose at least one role"
// ===========================================================================

describe('P1-8c screen 2 [edge] — at-least-one-role validation (batch on submit)', () => {
  it('[screen2] submitting with NO role checked shows the required error + does NOT call issueInvite', async () => {
    const { calls } = renderInvite({ issue: [OK_ISSUE()] });
    await openForm();
    await toggleRole('worker_member'); // uncheck the pre-checked default → zero roles
    await submitForm();
    const err = await screen.findByText(t('committee.invite.roles.required'));
    expect(err.closest('[role="alert"]'), 'the role-required error is assertive').not.toBeNull();
    // No network op fires with an empty role set (client pre-validates).
    expect(calls.issueInvite.length).toBe(0);
    // No code was minted / shown for a rejected submit.
    expect(screen.queryByTestId('committee-invite-code')).toBeNull();
  });
});

// ===========================================================================
// F-170 — the ONE clipboard affordance copies the LINK only, never the code
// ===========================================================================

describe('P1-8c screen 2 [F-170] custody split — copy the LINK only, the code is read out of band', () => {
  it('[F-170] the redeem link is shown and points at /redeem?invite_id=<id> (NO code param)', async () => {
    const { calls } = renderInvite({ issue: [OK_ISSUE()] });
    const card = await inviteToCodeShown();
    const code = calls.issueInvite[0]!.code;
    // The link is visible somewhere in the card and carries ONLY the invite_id.
    expect(card.textContent ?? '').toContain(`/redeem?invite_id=${INVITE_ID}`);
    // The link must NOT carry the 6-digit code (custody split).
    const linkText = (card.textContent ?? '').match(/\/redeem\?[^\s"']*/)?.[0] ?? '';
    expect(linkText).not.toContain(code);
    expect(linkText).not.toMatch(/(?:^|[?&])(?:code|totp|totp_code)=/);
  });

  it('[F-170] there is EXACTLY ONE copy affordance and its accessible name is "Copy link" (not "copy code")', async () => {
    const card = await inviteToCodeShown();
    const copies = copyControls(card);
    expect(copies.length, 'exactly one clipboard affordance in the custody card').toBe(1);
    const name = accName(copies[0]!);
    expect(name).toMatch(/link/i);
    expect(name).not.toMatch(/code/i);
    expect(name).toBe(t('committee.invite.link.copy'));
  });

  it('[F-170] the code element is selectable static text with NO copy/share affordance of its own', async () => {
    await inviteToCodeShown();
    const codeEl = screen.getByTestId('committee-invite-code-value');
    // Never an <input> (paste-history / autocomplete leak), never a button.
    expect(codeEl.tagName.toLowerCase()).not.toBe('input');
    expect(codeEl.tagName.toLowerCase()).not.toBe('button');
    expect(codeEl.getAttribute('role')).not.toBe('button');
    // No copy/share control lives inside or wraps the code element.
    expect(codeEl.closest('button')).toBeNull();
    expect(codeEl.querySelector('button,a')).toBeNull();
  });

  it('[F-170] clicking the copy control writes ONLY the redeem link to the clipboard — never the code', async () => {
    const { calls } = renderInvite({ issue: [OK_ISSUE()] });
    const card = await inviteToCodeShown();
    const code = calls.issueInvite[0]!.code;
    await fireEvent.click(copyControls(card)[0]!);
    await waitFor(() => expect(clipboardWrites.length).toBe(1));
    // The single write is the link, and it never contains the code.
    expect(clipboardWrites[0]).toContain(`/redeem?invite_id=${INVITE_ID}`);
    for (const w of clipboardWrites) expect(w).not.toContain(code);
  });

  it('[F-170] NO affordance in the whole card copies the code (sweep every button; the code never reaches the clipboard)', async () => {
    const { calls } = renderInvite({ issue: [OK_ISSUE()] });
    const card = await inviteToCodeShown();
    const code = calls.issueInvite[0]!.code;
    // Click every button EXCEPT the controls that dismiss / replace the card
    // (Done, "Send a different code") — those transition state; the rest must
    // never hand the 6-digit code to the clipboard.
    const dismissNames = [t('committee.invite.code.done'), t('committee.invite.code.resend_now')];
    const buttons = Array.from(card.querySelectorAll('button')).filter(
      (b) => !dismissNames.includes(accName(b))
    );
    for (const b of buttons) await fireEvent.click(b);
    // Whatever was clicked, the 6-digit code was never handed to the clipboard.
    for (const w of clipboardWrites) expect(w).not.toContain(code);
    // And there is no control named "copy code" / "copy both" anywhere in the card.
    for (const el of Array.from(card.querySelectorAll('button,a'))) {
      const n = accName(el).toLowerCase();
      expect(n.includes('copy') && n.includes('code')).toBe(false);
    }
  });

  it('[F-170] the custody-split guidance ("send the code and the link separately") is present', async () => {
    const card = await inviteToCodeShown();
    expect(card.textContent ?? '').toContain(t('committee.invite.custody.heading'));
    expect(card.textContent ?? '').toContain(t('committee.invite.custody.body'));
  });
});

// ===========================================================================
// F-176 — the code never leaks to URL / history / storage / logs / DOM attrs;
//         invitee_user_id + bootstrap_id are never rendered
// ===========================================================================

describe('P1-8c screen 2 [F-176] leak sweep — code + response secrets stay in memory only', () => {
  it('[F-176] across the full flow the code is absent from URL, history, sessionStorage, localStorage', async () => {
    const { calls } = renderInvite({ issue: [OK_ISSUE()] });
    const card = await inviteToCodeShown();
    const code = calls.issueInvite[0]!.code;
    // Also click copy (the one legitimate egress) — it must still not persist the code.
    await fireEvent.click(copyControls(card)[0]!);
    await waitFor(() => expect(clipboardWrites.length).toBe(1));
    for (const h of storageHaystacks()) expect(h).not.toContain(code);
  });

  it('[F-176] the code never appears in any DOM ATTRIBUTE (visible text is fine; attributes are not)', async () => {
    const { calls, container } = renderInvite({ issue: [OK_ISSUE()] });
    await inviteToCodeShown();
    const code = calls.issueInvite[0]!.code;
    // The contiguous code is the visible text content (allowed) — but must not be
    // reflected into any attribute (id, value, data-*, aria-*). The digit-by-digit
    // aria-label ("4 8 2 9 1 7") is a DIFFERENT string and does not contain it.
    for (const v of attrValues(container)) expect(v).not.toContain(code);
  });

  it('[F-176] the code never reaches a log surface (console.* + structured log sink)', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.map(String).join(' ')));

    const { calls } = renderInvite({ issue: [OK_ISSUE()] });
    await inviteToCodeShown();
    const code = calls.issueInvite[0]!.code;

    const haystacks = [...logs, ...__getCapturedLines().map((l) => JSON.stringify(l))];
    for (const h of haystacks) expect(h).not.toContain(code);
  });

  it('[F-176] invitee_user_id + bootstrap_id from the server response are NEVER rendered', async () => {
    const { container } = renderInvite({ issue: [OK_ISSUE()] });
    await inviteToCodeShown();
    // Both are operator-/TOTP-adjacent; the co-chair never needs them at invite time.
    expect(container.textContent ?? '').not.toContain(INVITEE_UID);
    expect(container.textContent ?? '').not.toContain(BOOTSTRAP_ID);
    for (const v of attrValues(container)) {
      expect(v).not.toContain(INVITEE_UID);
      expect(v).not.toContain(BOOTSTRAP_ID);
    }
  });

  it('[F-176] invitee_user_id + bootstrap_id never reach a log surface either', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.map(String).join(' ')));

    renderInvite({ issue: [OK_ISSUE()] });
    await inviteToCodeShown();

    const haystacks = [...logs, ...__getCapturedLines().map((l) => JSON.stringify(l))];
    for (const h of haystacks) {
      expect(h).not.toContain(INVITEE_UID);
      expect(h).not.toContain(BOOTSTRAP_ID);
    }
  });
});

// ===========================================================================
// RE-ISSUE SAFETY — the code is shown ONCE; dismissing loses it (unrecoverable)
// ===========================================================================

describe('P1-8c screen 2 [shown-once] — the code is not recoverable after Done', () => {
  it('[shown-once] Done clears the code, closes the panel, and returns to the CTA', async () => {
    renderInvite({ issue: [OK_ISSUE()] });
    const card = await inviteToCodeShown();
    const done = screen.getByRole('button', { name: t('committee.invite.code.done') });
    await fireEvent.click(done);
    // The code card is gone; the idle CTA is back.
    await waitFor(() => expect(screen.queryByTestId('committee-invite-code')).toBeNull());
    expect(screen.getByTestId('committee-invite-cta')).toBeDefined();
    void card;
  });

  it('[shown-once] after Done the code is gone from the DOM and was never persisted to any store', async () => {
    const { calls } = renderInvite({ issue: [OK_ISSUE()] });
    const card = await inviteToCodeShown();
    const code = calls.issueInvite[0]!.code;
    await fireEvent.click(screen.getByRole('button', { name: t('committee.invite.code.done') }));
    await waitFor(() => expect(screen.queryByTestId('committee-invite-code-value')).toBeNull());
    // Not recoverable: not in storage/URL, not in a lingering attribute.
    for (const h of storageHaystacks()) expect(h).not.toContain(code);
    void card;
  });

  it('[shown-once] re-opening the panel shows a FRESH empty form — never the previous code', async () => {
    const { calls } = renderInvite({ issue: [OK_ISSUE(), OK_ISSUE()] });
    await inviteToCodeShown();
    const firstCode = calls.issueInvite[0]!.code;
    await fireEvent.click(screen.getByRole('button', { name: t('committee.invite.code.done') }));
    await waitFor(() => expect(screen.queryByTestId('committee-invite-code')).toBeNull());
    // Re-open: a fresh form instance, no code visible, the old code is not resurfaced.
    await openForm();
    expect(screen.queryByTestId('committee-invite-code')).toBeNull();
    expect(shownCodeAbsent(firstCode)).toBe(true);
  });
});

function shownCodeAbsent(code: string): boolean {
  const val = screen.queryByTestId('committee-invite-code-value');
  return val === null || !(val.textContent ?? '').replace(/\D/g, '').includes(code);
}

// ===========================================================================
// ERROR MAPPING — 403 / invalid_role / (any other incl. 429) → generic
//                 the raw reason enum is NEVER rendered (F-176)
// ===========================================================================

describe('P1-8c screen 2 [error] — mapped states, raw reason never rendered', () => {
  it('[screen2: not-co-chair] a 403 rls_denied shows the calm "co-chair access changed" boundary (no code minted)', async () => {
    const { calls } = renderInvite({ issue: [ERR('rls_denied', 403)] });
    await openForm();
    await submitForm();
    const err = await screen.findByTestId('committee-invite-error-authz');
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent ?? '').toContain(t('committee.invite.error.not_co_chair.heading'));
    // No code_shown for a rejected issue.
    expect(screen.queryByTestId('committee-invite-code')).toBeNull();
    // The single failed attempt still recorded the call, but nothing leaked.
    expect(calls.issueInvite.length).toBe(1);
  });

  it('[screen2: not-co-chair / F-176] the raw enum "rls_denied" is never rendered', async () => {
    const { container } = renderInvite({ issue: [ERR('rls_denied', 403)] });
    await openForm();
    await submitForm();
    await screen.findByTestId('committee-invite-error-authz');
    expect(container.textContent ?? '').not.toContain('rls_denied');
  });

  it('[screen2: invalid-role] an invalid_role reason shows the role error (assertive), raw enum hidden', async () => {
    const { container } = renderInvite({ issue: [ERR('invalid_role', 422)] });
    await openForm();
    await submitForm();
    const heading = await screen.findByText(t('committee.invite.error.invalid_role.heading'));
    expect(heading.closest('[role="alert"]')).not.toBeNull();
    expect(container.textContent ?? '').not.toContain('invalid_role');
  });

  it('[screen2: generic] a 500 maps to the generic error; the reason enum is never echoed', async () => {
    const { container } = renderInvite({ issue: [ERR('unknown', 500)] });
    await openForm();
    await submitForm();
    const err = await screen.findByTestId('committee-invite-error');
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent ?? '').toContain(t('committee.invite.error.generic.heading'));
    expect(container.textContent ?? '').not.toContain('unknown');
  });

  it('[screen2: generic / F-175] a 429 is DEFENSIVE-ONLY — it maps to the SAME generic error, not a distinct state', async () => {
    // Orchestrator resolution: rate_limited is not a CommitteeOpReason; a bare 429
    // surfaces as reason:'unknown' + status 429 and maps to the generic error.
    const { container } = renderInvite({ issue: [ERR('unknown', 429)] });
    await openForm();
    await submitForm();
    const err = await screen.findByTestId('committee-invite-error');
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent ?? '').toContain(t('committee.invite.error.generic.heading'));
    // No status code / reason enum leaks into the copy.
    expect(container.textContent ?? '').not.toMatch(/\b429\b/);
    expect(container.textContent ?? '').not.toContain('unknown');
  });

  it('[screen2: generic] a membership_exists reason also collapses to the generic error (any-other rule)', async () => {
    const { container } = renderInvite({ issue: [ERR('membership_exists', 409)] });
    await openForm();
    await submitForm();
    await screen.findByTestId('committee-invite-error');
    expect(container.textContent ?? '').not.toContain('membership_exists');
  });

  it('[screen2: generic] a network-shaped failure (status 0) also maps to the generic error', async () => {
    renderInvite({ issue: [ERR('unknown', 0)] });
    await openForm();
    await submitForm();
    await screen.findByTestId('committee-invite-error');
    expect(screen.queryByTestId('committee-invite-error-authz')).toBeNull();
    expect(screen.queryByTestId('committee-invite-code')).toBeNull();
  });
});
