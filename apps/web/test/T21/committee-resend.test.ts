/**
 * ADR-0029 P1-8c — /committee co-chair RE-SEND-CODE surface (Surface K, screen 4).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY. It pins the
 * behavioral + custody + privacy contract of the "Pending invites" section +
 * per-row re-send BEFORE the component exists, so the suite MUST fail at import
 * (`PendingInvites.svelte` is missing) until the implementer ships it.
 *
 * Why a `PendingInvites.svelte` lib component: same repo convention as
 * CommitteeRoster / CommitteeInvite (the route composes lib components; the shell
 * is pinned structurally). Pending invites is a DISTINCT section rendered BELOW
 * the roster on /committee (A-8.2 read-boundary: B2 `listPendingInvites`, NOT
 * interleaved into the B1 roster list). The route wires the client + forwards it.
 *
 * Injection style mirrors CommitteeRoster/CommitteeInvite (real Svelte props):
 *   - `client` — an object exposing
 *       listPendingInvites(): Promise<CommitteeOpResult<PendingInvite[]>>
 *       reissueTotp({invite_id,code}): Promise<CommitteeOpResult<ReissueTotpData>>
 *     Tests inject a fake that RECORDS call inputs + returns queued results.
 *   - `onReinvite?` — an optional callback the EXPIRED-row "Invite again" action /
 *     the invite_invalid "Invite again" link fire (they open the screen-2 panel;
 *     the cross-component mount is route-composition, out of scope here).
 *
 * RESOLVED CONTRACT (DECIDED — orchestrator 2026-07-13; do NOT reopen):
 *   - Pending invites is a DISTINCT section from `listPendingInvites`, not the
 *     roster (RESOLVED contract #5).
 *   - Per-row "Re-send code" → confirm → reissueTotp({invite_id, code}) with a
 *     FRESH crypto 6-digit code → the SAME one-time-code custody card as screen 2.
 *   - invite_invalid(422) → a SINGLE normalized "this invite is no longer valid"
 *     message (consumed ≡ expired oracle defense; no sub-condition split).
 *   - Any other/unexpected INCLUDING a 429 → generic error; raw reason NEVER shown.
 *   - Same F-170 (copy the LINK only) + F-176 (code/secret never leaks) posture on
 *     the re-send code display as screen 2.
 *   - An EXPIRED row (expires_at <= now) switches its action to "Invite again" and
 *     does NOT call reissueTotp (a past-TTL invite only returns invite_invalid).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
import { setJwt, __resetForTest } from '../../src/lib/auth/session-jwt-store';
import { t } from '../../src/lib/i18n';
import type {
  PendingInvite,
  ReissueTotpData,
  CommitteeOpResult,
  CommitteeOpReason
} from '../../src/lib/committee/supabase-committee-client';

// RED-FIRST import — the implementer creates this lib component.
import PendingInvites from '../../src/lib/committee/PendingInvites.svelte';

// ---------------------------------------------------------------------------
// Fixtures — frozen clock "now" is 2026-05-22 (FROZEN_NOW). expires_at is the
// 7-day INVITE TTL, never a TOTP window. This file owns its fixtures.
// ---------------------------------------------------------------------------

type ListResult = CommitteeOpResult<PendingInvite[]>;
type ReissueResult = CommitteeOpResult<ReissueTotpData>;

const INVITE_WAITING = '11111111-0000-4000-8000-00000000aaaa';
const INVITE_EXPIRED = '22222222-0000-4000-8000-00000000bbbb';
const INVITE_NULLNAME = '33333333-0000-4000-8000-00000000cccc';
const UID_WAITING = 'aaaaaaaa-1111-4111-8111-1111aaaa1111';
const UID_EXPIRED = 'bbbbbbbb-2222-4222-8222-2222bbbb2222';
const UID_NULLNAME = '0f0f0f0f-3333-4333-8333-3333cccc3333';
const BOOTSTRAP_ID = 'b0075242-4444-4444-8444-deadbeef4444';

const ROW_WAITING: PendingInvite = {
  invite_id: INVITE_WAITING,
  target_user_id: UID_WAITING,
  display_name: 'Pending Paula',
  roles: ['worker_member'],
  issued_at: '2026-05-20T09:00:00.000Z',
  expires_at: '2026-05-27T09:00:00.000Z' // > now (2026-05-22) → "Waiting to be redeemed"
};
const ROW_EXPIRED: PendingInvite = {
  invite_id: INVITE_EXPIRED,
  target_user_id: UID_EXPIRED,
  display_name: 'Expired Ed',
  roles: ['certified_member'],
  issued_at: '2026-04-01T09:00:00.000Z',
  expires_at: '2026-05-01T09:00:00.000Z' // <= now → "Expired — invite again"
};
const ROW_NULLNAME: PendingInvite = {
  invite_id: INVITE_NULLNAME,
  target_user_id: UID_NULLNAME,
  display_name: null, // LEFT JOIN users yields no PI → fallback label + uid fragment
  roles: ['worker_member'],
  issued_at: '2026-05-19T09:00:00.000Z',
  expires_at: '2026-05-26T09:00:00.000Z'
};

const OK_LIST = (rows: PendingInvite[]): ListResult => ({ ok: true, data: rows });
const OK_REISSUE = (over: Partial<ReissueTotpData> = {}): ReissueResult => ({
  ok: true,
  data: { invite_id: INVITE_WAITING, bootstrap_id: BOOTSTRAP_ID, ...over }
});
// The error variant is structurally T-independent, so a bare error object is
// assignable to CommitteeOpResult<PendingInvite[]> AND <ReissueTotpData> without
// generic-inference ambiguity.
const ERR = (
  reason: CommitteeOpReason,
  status: number
): { ok: false; reason: CommitteeOpReason; status: number } => ({ ok: false, reason, status });

// ---------------------------------------------------------------------------
// Fake client + gated (in-flight) client.
// ---------------------------------------------------------------------------

interface ResendCalls {
  listPendingInvites: number;
  reissueTotp: Array<{ invite_id: string; code: string }>;
  reinvite: number;
}

function fakeClient(opts: { list?: ListResult[]; reissue?: ReissueResult[] }) {
  const calls: ResendCalls = { listPendingInvites: 0, reissueTotp: [], reinvite: 0 };
  let listI = 0;
  let reissueI = 0;
  const list = opts.list ?? [OK_LIST([])];
  const reissue = opts.reissue ?? [OK_REISSUE()];
  const client = {
    listPendingInvites: async () => {
      calls.listPendingInvites++;
      return list[Math.min(listI++, list.length - 1)];
    },
    reissueTotp: async (input: { invite_id: string; code: string }) => {
      calls.reissueTotp.push(input);
      return reissue[Math.min(reissueI++, reissue.length - 1)];
    }
  };
  return { client, calls };
}

/** A client whose listPendingInvites stays pending until `release(result)`. */
function gatedListClient() {
  const calls: ResendCalls = { listPendingInvites: 0, reissueTotp: [], reinvite: 0 };
  let release!: (r: ListResult) => void;
  const pending = new Promise<ListResult>((res) => (release = res));
  const client = {
    listPendingInvites: async () => {
      calls.listPendingInvites++;
      return pending;
    },
    reissueTotp: async () => OK_REISSUE()
  };
  return { client, calls, release };
}

function renderPending(opts: {
  list?: ListResult[];
  reissue?: ReissueResult[];
  client?: unknown;
  onReinvite?: () => void;
}) {
  __resetForTest();
  setJwt('test-jwt');
  const built = opts.client
    ? { client: opts.client, calls: { listPendingInvites: 0, reissueTotp: [], reinvite: 0 } as ResendCalls }
    : fakeClient({ list: opts.list, reissue: opts.reissue });
  const utils = render(PendingInvites, {
    props: { client: built.client as never, onReinvite: (opts.onReinvite ?? (() => {})) as never }
  });
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
function pendingRows(): HTMLElement[] {
  return screen.queryAllByTestId('committee-pending-row');
}
function rowContaining(text: string): HTMLElement {
  const r = pendingRows().find((el) => (el.textContent ?? '').includes(text));
  if (!r) throw new Error(`no pending-invite row containing "${text}"`);
  return r;
}
/** The per-row action button ("Re-send code" or "Invite again"). */
function actionButton(row: HTMLElement): HTMLElement {
  const b = Array.from(row.querySelectorAll('button')).find((el) =>
    /re-?send|invite again/i.test(accName(el))
  );
  if (!b) throw new Error('row has no re-send / invite-again action button');
  return b;
}
function copyControls(card: HTMLElement): HTMLElement[] {
  return Array.from(card.querySelectorAll('button,a')).filter((el) => /copy/i.test(accName(el))) as HTMLElement[];
}
function shownResendDigits(): string {
  return (screen.getByTestId('committee-resend-code-value').textContent ?? '').replace(/\D/g, '');
}
function attrValues(root: Element): string[] {
  const out: string[] = [];
  const walk = (el: Element) => {
    for (const a of Array.from(el.attributes)) out.push(a.value);
    for (const c of Array.from(el.children)) walk(c);
  };
  walk(root);
  return out;
}
function storageHaystacks(): string[] {
  const h: string[] = [];
  if (typeof window !== 'undefined' && window.location) {
    h.push(window.location.href, window.location.search, window.location.hash);
  }
  for (const store of [
    typeof sessionStorage !== 'undefined' ? sessionStorage : null,
    typeof localStorage !== 'undefined' ? localStorage : null
  ]) {
    if (!store) continue;
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k) h.push(k + '=' + (store.getItem(k) ?? ''));
    }
  }
  return h;
}
/** The non-interpolated prefix of a "{date}" catalog string (copy-decoupled). */
const datePrefix = (key: string): string => {
  const SENT = String.fromCharCode(1);
  return t(key, { date: SENT }).split(SENT)[0]!.trim();
};

/** Drive a WAITING row through re-send confirm → send → code_shown. */
async function resendWaitingToCodeShown() {
  const row = rowContaining('Pending Paula');
  await fireEvent.click(actionButton(row));
  await screen.findByTestId('committee-resend-confirm');
  await fireEvent.click(screen.getByRole('button', { name: t('committee.resend.confirm.go') }));
  return screen.findByTestId('committee-resend-code');
}

// ---------------------------------------------------------------------------
// Clipboard stub.
// ---------------------------------------------------------------------------

let clipboardWrites: string[] = [];

beforeEach(() => {
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
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: undefined });
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  if (typeof localStorage !== 'undefined') localStorage.clear();
  vi.restoreAllMocks();
  restoreClock();
});

// ===========================================================================
// PENDING-INVITES LIST LADDER — loading / empty / list / error (a distinct section)
// ===========================================================================

describe('P1-8c Surface K screen 4 [pending-list] — a distinct section, its own list ladder', () => {
  it('[screen4: loading] shows the LITERAL action ("Loading pending invites…"), not bare "Loading…"', async () => {
    const { client } = gatedListClient();
    renderPending({ client });
    const loading = await screen.findByTestId('committee-pending-loading');
    expect(loading.getAttribute('role')).toBe('status');
    expect(loading.textContent?.trim()).toBe(t('committee.resend.loading'));
    expect(loading.textContent?.trim()).not.toBe('Loading…');
  });

  it('[screen4: empty] ok+[] renders the empty state (role="status") with the section chrome retained', async () => {
    renderPending({ list: [OK_LIST([])] });
    const empty = await screen.findByTestId('committee-pending-empty');
    expect(empty.getAttribute('role')).toBe('status');
    // The "Pending invites" section heading + blurb still frame the empty state.
    expect(screen.getByText(t('committee.resend.section.heading'))).toBeDefined();
    expect(screen.getByText(t('committee.resend.section.blurb'))).toBeDefined();
  });

  it('[screen4: list] ok+rows renders a distinct <ul> (its own aria-label), NOT the roster list', async () => {
    renderPending({ list: [OK_LIST([ROW_WAITING, ROW_EXPIRED])] });
    const list = await screen.findByTestId('committee-pending-list');
    expect(list.tagName.toLowerCase()).toBe('ul');
    expect(list.getAttribute('aria-label')).toBe(t('committee.resend.list_aria'));
    expect(pendingRows().length).toBe(2);
    // It is the Pending-invites projection, not the B1 roster list.
    expect(screen.queryByTestId('committee-roster-list')).toBeNull();
  });

  it('[screen4: list] rows render in SERVER order — the component does NOT re-sort', async () => {
    // A-8.2 pins issued_at DESC server-side; provide a fixed order and assert the
    // DOM preserves it (waiting fixture first, expired second).
    renderPending({ list: [OK_LIST([ROW_WAITING, ROW_EXPIRED])] });
    await screen.findByTestId('committee-pending-list');
    const order = pendingRows().map((r) => r.textContent ?? '');
    expect(order[0]).toContain('Pending Paula');
    expect(order[1]).toContain('Expired Ed');
  });

  it('[screen4: error] a failed listPendingInvites renders an assertive error + Retry; raw reason hidden', async () => {
    const { container } = renderPending({ list: [ERR('unknown', 500)] });
    const err = await screen.findByTestId('committee-pending-error');
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.querySelector('button'), 'the list error offers a Retry button').not.toBeNull();
    expect(container.textContent ?? '').not.toContain('unknown');
  });
});

// ===========================================================================
// PER-ROW LAYOUT — status pill (icon+text), roles, dates (expires = 7-day TTL)
// ===========================================================================

describe('P1-8c screen 4 [row-layout] — status pill, roles, INVITE-TTL dates, null-PI fallback', () => {
  it('[screen4: row] a not-yet-expired invite shows the "Waiting to be redeemed" status', async () => {
    renderPending({ list: [OK_LIST([ROW_WAITING])] });
    await screen.findByTestId('committee-pending-list');
    expect(rowContaining('Pending Paula').textContent ?? '').toContain(t('committee.resend.status.waiting'));
  });

  it('[screen4: row] a past-TTL invite shows the "Expired — invite again" status', async () => {
    renderPending({ list: [OK_LIST([ROW_EXPIRED])] });
    await screen.findByTestId('committee-pending-list');
    expect(rowContaining('Expired Ed').textContent ?? '').toContain(t('committee.resend.status.expired'));
  });

  it('[screen4: row] dates render as "Sent {date}" + "Link expires {date}" (the 7-day INVITE TTL)', async () => {
    renderPending({ list: [OK_LIST([ROW_WAITING])] });
    await screen.findByTestId('committee-pending-list');
    const row = rowContaining('Pending Paula');
    expect(row.textContent ?? '').toContain(datePrefix('committee.resend.row.issued'));
    expect(row.textContent ?? '').toContain('2026-05-20');
    expect(row.textContent ?? '').toContain(datePrefix('committee.resend.row.expires'));
    expect(row.textContent ?? '').toContain('2026-05-27');
  });

  it('[screen4: row] a NULL display_name falls back to the unnamed label + an 8-char uid fragment', async () => {
    const { container } = renderPending({ list: [OK_LIST([ROW_NULLNAME])] });
    await screen.findByTestId('committee-pending-list');
    const row = pendingRows()[0]!;
    expect(row.textContent ?? '').toContain(t('committee.roster.row.unnamed'));
    expect(row.textContent ?? '').toContain(UID_NULLNAME.slice(0, 8));
    // The FULL uid is never dumped.
    expect(container.textContent ?? '').not.toContain(UID_NULLNAME);
  });

  it('[screen4: row] the Re-send action names the member so it is unambiguous out of list context', async () => {
    renderPending({ list: [OK_LIST([ROW_WAITING])] });
    await screen.findByTestId('committee-pending-list');
    const btn = actionButton(rowContaining('Pending Paula'));
    // aria-label = "Re-send code for {name}".
    expect(btn.getAttribute('aria-label')).toBe(
      t('committee.resend.row.action_aria', { name: 'Pending Paula' })
    );
  });
});

// ===========================================================================
// PER-ROW RE-SEND — confirm → reissueTotp(fresh 6-digit) → code_shown
// ===========================================================================

describe('P1-8c screen 4 [re-send] — confirm gate → fresh code → the shared custody card', () => {
  it('[screen4: confirm] tapping Re-send opens the confirm gate and does NOT mint yet', async () => {
    const { calls } = renderPending({ list: [OK_LIST([ROW_WAITING])] });
    await screen.findByTestId('committee-pending-list');
    await fireEvent.click(actionButton(rowContaining('Pending Paula')));
    const confirm = await screen.findByTestId('committee-resend-confirm');
    // The consequence ("old code stops working") is named before minting.
    expect(confirm.textContent ?? '').toContain(t('committee.resend.confirm.heading'));
    // No reissue has fired — the confirm is a gate, not the action.
    expect(calls.reissueTotp.length).toBe(0);
  });

  it('[screen4: confirm] Cancel dismisses the gate and never mints a code', async () => {
    const { calls } = renderPending({ list: [OK_LIST([ROW_WAITING])] });
    await screen.findByTestId('committee-pending-list');
    await fireEvent.click(actionButton(rowContaining('Pending Paula')));
    await screen.findByTestId('committee-resend-confirm');
    await fireEvent.click(screen.getByRole('button', { name: t('committee.resend.confirm.cancel') }));
    await waitFor(() => expect(screen.queryByTestId('committee-resend-confirm')).toBeNull());
    expect(calls.reissueTotp.length).toBe(0);
  });

  it('[screen4: submitting→code_shown] confirming calls reissueTotp with THIS invite_id + a fresh 6-digit code', async () => {
    const { calls } = renderPending({ list: [OK_LIST([ROW_WAITING])], reissue: [OK_REISSUE()] });
    await screen.findByTestId('committee-pending-list');
    await resendWaitingToCodeShown();
    expect(calls.reissueTotp.length).toBe(1);
    expect(calls.reissueTotp[0]!.invite_id).toBe(INVITE_WAITING);
    expect(calls.reissueTotp[0]!.code).toMatch(/^\d{6}$/);
    // The displayed fresh code IS the code sent to reissueTotp.
    expect(shownResendDigits()).toBe(calls.reissueTotp[0]!.code);
  });

  it('[screen4: code_shown] the fresh code is minted via crypto.getRandomValues — not Math.random', async () => {
    renderPending({ list: [OK_LIST([ROW_WAITING])], reissue: [OK_REISSUE()] });
    await screen.findByTestId('committee-pending-list');
    await fireEvent.click(actionButton(rowContaining('Pending Paula')));
    await screen.findByTestId('committee-resend-confirm');
    // Probe only the generation window (the confirm-"go" click).
    const cryptoSpy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const mathSpy = vi.spyOn(Math, 'random');
    await fireEvent.click(screen.getByRole('button', { name: t('committee.resend.confirm.go') }));
    await screen.findByTestId('committee-resend-code');
    expect(cryptoSpy).toHaveBeenCalled();
    expect(mathSpy).not.toHaveBeenCalled();
  });

  it('[screen4: code_shown] the custody card carries the re-send headings ("the old one has stopped working")', async () => {
    renderPending({ list: [OK_LIST([ROW_WAITING])], reissue: [OK_REISSUE()] });
    await screen.findByTestId('committee-pending-list');
    const card = await resendWaitingToCodeShown();
    expect(card.textContent ?? '').toContain(t('committee.resend.code.heading'));
    // Same custody-split instruction as screen 2.
    expect(card.textContent ?? '').toContain(t('committee.invite.custody.heading'));
  });

  it('[screen4: code_shown] the redeem link is unchanged (same invite_id); only the code is new', async () => {
    renderPending({ list: [OK_LIST([ROW_WAITING])], reissue: [OK_REISSUE()] });
    await screen.findByTestId('committee-pending-list');
    const card = await resendWaitingToCodeShown();
    expect(card.textContent ?? '').toContain(`/redeem?invite_id=${INVITE_WAITING}`);
  });
});

// ===========================================================================
// F-170 — the re-send code display copies the LINK only, never the code
// ===========================================================================

describe('P1-8c screen 4 [F-170] the re-send custody card splits code + link', () => {
  it('[F-170] exactly ONE copy affordance ("Copy link"); the code has no copy control', async () => {
    renderPending({ list: [OK_LIST([ROW_WAITING])], reissue: [OK_REISSUE()] });
    await screen.findByTestId('committee-pending-list');
    const card = await resendWaitingToCodeShown();
    const copies = copyControls(card);
    expect(copies.length).toBe(1);
    expect(accName(copies[0]!)).toMatch(/link/i);
    expect(accName(copies[0]!)).not.toMatch(/code/i);
    // The code element is static text, not an input/button, with no copy affordance.
    const codeEl = screen.getByTestId('committee-resend-code-value');
    expect(codeEl.tagName.toLowerCase()).not.toBe('input');
    expect(codeEl.querySelector('button,a')).toBeNull();
  });

  it('[F-170] clicking copy writes ONLY the redeem link to the clipboard — never the fresh code', async () => {
    const { calls } = renderPending({ list: [OK_LIST([ROW_WAITING])], reissue: [OK_REISSUE()] });
    await screen.findByTestId('committee-pending-list');
    const card = await resendWaitingToCodeShown();
    const code = calls.reissueTotp[0]!.code;
    await fireEvent.click(copyControls(card)[0]!);
    await waitFor(() => expect(clipboardWrites.length).toBe(1));
    expect(clipboardWrites[0]).toContain(`/redeem?invite_id=${INVITE_WAITING}`);
    for (const w of clipboardWrites) expect(w).not.toContain(code);
  });
});

// ===========================================================================
// F-176 — the fresh code + bootstrap_id never leak (URL/storage/logs/attrs)
// ===========================================================================

describe('P1-8c screen 4 [F-176] leak sweep on the re-send code display', () => {
  it('[F-176] the fresh code is absent from URL / storage / DOM attributes', async () => {
    const { calls, container } = renderPending({ list: [OK_LIST([ROW_WAITING])], reissue: [OK_REISSUE()] });
    await screen.findByTestId('committee-pending-list');
    await resendWaitingToCodeShown();
    const code = calls.reissueTotp[0]!.code;
    for (const h of storageHaystacks()) expect(h).not.toContain(code);
    for (const v of attrValues(container)) expect(v).not.toContain(code);
  });

  it('[F-176] the fresh code + bootstrap_id never reach a log surface', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.map(String).join(' ')));

    const { calls } = renderPending({ list: [OK_LIST([ROW_WAITING])], reissue: [OK_REISSUE()] });
    await screen.findByTestId('committee-pending-list');
    await resendWaitingToCodeShown();
    const code = calls.reissueTotp[0]!.code;

    const haystacks = [...logs, ...__getCapturedLines().map((l) => JSON.stringify(l))];
    for (const h of haystacks) {
      expect(h).not.toContain(code);
      expect(h).not.toContain(BOOTSTRAP_ID);
    }
  });

  it('[F-176] bootstrap_id from the reissue response is never rendered', async () => {
    const { container } = renderPending({ list: [OK_LIST([ROW_WAITING])], reissue: [OK_REISSUE()] });
    await screen.findByTestId('committee-pending-list');
    await resendWaitingToCodeShown();
    expect(container.textContent ?? '').not.toContain(BOOTSTRAP_ID);
  });
});

// ===========================================================================
// ERROR — invite_invalid (normalized) + generic (any other incl. 429)
// ===========================================================================

describe('P1-8c screen 4 [error] — invite_invalid oracle + generic collapse', () => {
  it('[screen4: invite_invalid] a 422 invite_invalid shows the SINGLE normalized "no longer valid" message', async () => {
    const { container } = renderPending({
      list: [OK_LIST([ROW_WAITING])],
      reissue: [ERR('invite_invalid', 422)]
    });
    await screen.findByTestId('committee-pending-list');
    await fireEvent.click(actionButton(rowContaining('Pending Paula')));
    await screen.findByTestId('committee-resend-confirm');
    await fireEvent.click(screen.getByRole('button', { name: t('committee.resend.confirm.go') }));
    const invalid = await screen.findByTestId('committee-resend-invalid');
    expect(invalid.getAttribute('role')).toBe('alert');
    expect(invalid.textContent ?? '').toContain(t('committee.resend.invalid.heading'));
    // Oracle defense (F-169/F-170): the raw reason enum is never surfaced.
    expect(container.textContent ?? '').not.toContain('invite_invalid');
    // It offers "Invite again" rather than a re-send (a spent/expired invite can't re-send).
    expect(screen.getByText(t('committee.resend.invalid.reinvite'))).toBeDefined();
    // No code_shown for an invalid invite.
    expect(screen.queryByTestId('committee-resend-code')).toBeNull();
  });

  it('[screen4: generic] a 500 on reissue shows the generic error; raw reason hidden', async () => {
    const { container } = renderPending({
      list: [OK_LIST([ROW_WAITING])],
      reissue: [ERR('unknown', 500)]
    });
    await screen.findByTestId('committee-pending-list');
    await fireEvent.click(actionButton(rowContaining('Pending Paula')));
    await screen.findByTestId('committee-resend-confirm');
    await fireEvent.click(screen.getByRole('button', { name: t('committee.resend.confirm.go') }));
    const err = await screen.findByTestId('committee-resend-error');
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent ?? '').toContain(t('committee.resend.error.generic.heading'));
    expect(container.textContent ?? '').not.toContain('unknown');
  });

  it('[screen4: generic / F-175] a 429 on reissue is DEFENSIVE-ONLY — it collapses to the SAME generic error', async () => {
    const { container } = renderPending({
      list: [OK_LIST([ROW_WAITING])],
      reissue: [ERR('unknown', 429)]
    });
    await screen.findByTestId('committee-pending-list');
    await fireEvent.click(actionButton(rowContaining('Pending Paula')));
    await screen.findByTestId('committee-resend-confirm');
    await fireEvent.click(screen.getByRole('button', { name: t('committee.resend.confirm.go') }));
    await screen.findByTestId('committee-resend-error');
    expect(container.textContent ?? '').not.toMatch(/\b429\b/);
    expect(container.textContent ?? '').not.toContain('unknown');
  });

  it('[screen4: authz / F-176] a 403 on reissue surfaces an assertive error and NEVER echoes rls_denied', async () => {
    const { container } = renderPending({
      list: [OK_LIST([ROW_WAITING])],
      reissue: [ERR('rls_denied', 403)]
    });
    await screen.findByTestId('committee-pending-list');
    await fireEvent.click(actionButton(rowContaining('Pending Paula')));
    await screen.findByTestId('committee-resend-confirm');
    await fireEvent.click(screen.getByRole('button', { name: t('committee.resend.confirm.go') }));
    // Whatever the exact banner, it is assertive and never leaks the raw enum.
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
    expect(container.textContent ?? '').not.toContain('rls_denied');
    // The code was not shown for a denied reissue.
    expect(screen.queryByTestId('committee-resend-code')).toBeNull();
  });
});

// ===========================================================================
// EXPIRED ROW — action switches to "Invite again" and does NOT call reissueTotp
// ===========================================================================

describe('P1-8c screen 4 [expired] — a past-TTL invite re-invites instead of re-sending', () => {
  it('[screen4: expired] the action label is "Invite again", not "Re-send code"', async () => {
    renderPending({ list: [OK_LIST([ROW_EXPIRED])] });
    await screen.findByTestId('committee-pending-list');
    const btn = actionButton(rowContaining('Expired Ed'));
    expect(accName(btn)).toMatch(/invite again/i);
  });

  it('[screen4: expired] activating "Invite again" does NOT call reissueTotp (a past-TTL invite only returns invite_invalid)', async () => {
    const onReinvite = vi.fn();
    const { calls } = renderPending({ list: [OK_LIST([ROW_EXPIRED])], onReinvite });
    await screen.findByTestId('committee-pending-list');
    await fireEvent.click(actionButton(rowContaining('Expired Ed')));
    // It never mints against an expired invite; it hands off to the screen-2 panel.
    expect(calls.reissueTotp.length).toBe(0);
    expect(onReinvite).toHaveBeenCalled();
  });
});
