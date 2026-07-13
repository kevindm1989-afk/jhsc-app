/**
 * ADR-0029 P1-8c — /committee invite + re-send ACCESSIBILITY contract
 * (Surface K screen-2/4 a11y packet — AODA / WCAG 2.0 AA).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY. These tests
 * become the accessibility-specialist's checklist: every mandatory a11y behavior
 * the designer pinned in Surface K §accessibility (screens 2 + 4) is an assertion.
 *
 * Surface K screen-2/4 a11y packet (design-system.md §4 Surface K, P1-8c):
 *   - the code is ANNOUNCED, not focus-stolen: focus moves ONCE to the custody-card
 *     heading (tabindex=-1); the code_ready note fires via role="status" (POLITE),
 *     NOT an assertive re-announce that would talk over a co-chair reading aloud.
 *   - the 6-digit code carries a digit-by-digit aria-label ("4 8 2 9 1 7") so a
 *     screen reader spells it, not "four hundred…".
 *   - EXACTLY ONE clipboard affordance in the a11y tree, named "Copy link"; there
 *     is NO "Copy code" accessible name anywhere (F-170 + axe/manual checkpoint).
 *   - the copy-link control announces "Link copied" via aria-live without moving focus.
 *   - the custody-split callout is role="alert" (assertive security instruction).
 *   - the role picker is a <fieldset>/<legend> checkbox group with real labels;
 *     worker_co_chair's helper is aria-describedby-linked; the "at least one role"
 *     error is role="alert".
 *   - focus order = DOM order, no positive tabindex; every interactive control is a
 *     native <button>/<a>/<input>.
 *   - the Pending-invites list matches the roster: <ul aria-label> + per-row
 *     role="group"; the Re-send button names the member.
 *   - axe WCAG 2 AA structural sweep over the form / code_shown / pending-list states.
 *
 * NOTE (honest scope): touch targets ≥44px are a LAYOUT property (min-height 2.75rem
 * via the button token). jsdom performs no layout, so pixel size is verified in the
 * accessibility-specialist's real-browser axe/visual pass, not here; this file pins
 * the STRUCTURAL a11y posture (native controls, keyboard reachability, no positive
 * tabindex). Flagged in the report.
 *
 * Mirrors redeem-card-a11y.test.ts + committee-roster-a11y.test.ts (role / aria-busy
 * / aria-describedby / focus assertions + the project axe helper).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { freezeClock, restoreClock } from '../_helpers/clock';
import axeCheck from '../_helpers/axe-check';
import { __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
import { setJwt, __resetForTest } from '../../src/lib/auth/session-jwt-store';
import { t } from '../../src/lib/i18n';
import type {
  IssueInviteData,
  ReissueTotpData,
  PendingInvite,
  CommitteeOpResult
} from '../../src/lib/committee/supabase-committee-client';

// RED-FIRST imports — created by the implementer.
import CommitteeInvite from '../../src/lib/committee/CommitteeInvite.svelte';
import PendingInvites from '../../src/lib/committee/PendingInvites.svelte';

// ---------------------------------------------------------------------------
// Fixtures (this file owns them).
// ---------------------------------------------------------------------------

const INVITE_ID = '7b1d3f00-0000-4000-8000-0000000000aa';
const OK_ISSUE: CommitteeOpResult<IssueInviteData> = {
  ok: true,
  data: {
    invite_id: INVITE_ID,
    invitee_user_id: 'aaaa1111-2222-4333-8444-555566667777',
    bootstrap_id: 'b0075242-2222-4222-8222-ddddeeeeffff'
  }
};
const OK_REISSUE: CommitteeOpResult<ReissueTotpData> = {
  ok: true,
  data: { invite_id: INVITE_ID, bootstrap_id: 'b0075242-2222-4222-8222-ddddeeeeffff' }
};

const ROW_WAITING: PendingInvite = {
  invite_id: INVITE_ID,
  target_user_id: 'aaaaaaaa-1111-4111-8111-1111aaaa1111',
  display_name: 'Pending Paula',
  roles: ['worker_member'],
  issued_at: '2026-05-20T09:00:00.000Z',
  expires_at: '2026-05-27T09:00:00.000Z'
};

// ---------------------------------------------------------------------------
// Fake clients that record the client-generated code so the digit-by-digit
// aria-label can be derived.
// ---------------------------------------------------------------------------

function inviteClient() {
  const calls: Array<{ roles: string[]; code: string; ttl_minutes: number }> = [];
  const client = {
    issueInvite: async (input: { roles: string[]; code: string; ttl_minutes: number }) => {
      calls.push(input);
      return OK_ISSUE;
    },
    reissueTotp: async () => OK_REISSUE
  };
  return { client, calls };
}
function pendingClient() {
  const calls: Array<{ invite_id: string; code: string }> = [];
  const client = {
    listPendingInvites: async () => ({ ok: true as const, data: [ROW_WAITING] }),
    reissueTotp: async (input: { invite_id: string; code: string }) => {
      calls.push(input);
      return OK_REISSUE;
    }
  };
  return { client, calls };
}

function accName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

async function openInviteForm() {
  await fireEvent.click(await screen.findByTestId('committee-invite-cta'));
  return screen.findByTestId('committee-invite-form');
}
async function inviteToCodeShown() {
  await openInviteForm();
  await fireEvent.click(screen.getByRole('button', { name: t('committee.invite.form.submit') }));
  return screen.findByTestId('committee-invite-code');
}
async function resendToCodeShown() {
  await screen.findByTestId('committee-pending-list');
  const row = screen.getAllByTestId('committee-pending-row')[0]!;
  const btn = Array.from(row.querySelectorAll('button')).find((b) => /re-?send/i.test(accName(b)))!;
  await fireEvent.click(btn);
  await screen.findByTestId('committee-resend-confirm');
  await fireEvent.click(screen.getByRole('button', { name: t('committee.resend.confirm.go') }));
  return screen.findByTestId('committee-resend-code');
}

let clipboardWrites: string[] = [];

beforeEach(() => {
  freezeClock();
  __resetCapture();
  __setTestSink();
  __resetForTest();
  setJwt('test-jwt');
  clipboardWrites = [];
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (s: string) => void clipboardWrites.push(String(s)) }
  });
});

afterEach(() => {
  cleanup();
  __resetCapture();
  __resetForTest();
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: undefined });
  vi.restoreAllMocks();
  restoreClock();
});

// ===========================================================================
// FORM — role picker fieldset/legend + labels + describedby + validation role
// ===========================================================================

describe('P1-8c [a11y] invite form — fieldset/legend checkbox group, labels, error association', () => {
  it('the role picker is a <fieldset> with a <legend> and native checkboxes (multi-select, not radios)', async () => {
    const { client } = inviteClient();
    render(CommitteeInvite, { props: { client: client as never } });
    const form = await openInviteForm();
    const fieldset = form.querySelector('fieldset');
    expect(fieldset, 'the role picker is a <fieldset>').not.toBeNull();
    expect(fieldset!.querySelector('legend')?.textContent ?? '').toContain(
      t('committee.invite.roles.legend')
    );
    for (const key of ['worker_member', 'worker_co_chair', 'certified_member'] as const) {
      const box = screen.getByRole('checkbox', { name: t(`committee.invite.role.${key}`) });
      expect((box as HTMLInputElement).type).toBe('checkbox');
    }
  });

  it("the worker_co_chair option's caution helper is aria-describedby-linked to its checkbox", async () => {
    const { client } = inviteClient();
    render(CommitteeInvite, { props: { client: client as never } });
    await openInviteForm();
    const box = screen.getByRole('checkbox', { name: t('committee.invite.role.worker_co_chair') });
    const describedBy = box.getAttribute('aria-describedby') ?? '';
    expect(describedBy.trim().length, 'worker_co_chair checkbox has aria-describedby').toBeGreaterThan(0);
    const described = describedBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(described).toContain(t('committee.invite.role.co_chair_note'));
  });

  it('the "choose at least one role" error is role="alert" (batch on submit)', async () => {
    const { client } = inviteClient();
    render(CommitteeInvite, { props: { client: client as never } });
    await openInviteForm();
    // Uncheck the pre-checked default so the submit has zero roles.
    await fireEvent.click(screen.getByRole('checkbox', { name: t('committee.invite.role.worker_member') }));
    await fireEvent.click(screen.getByRole('button', { name: t('committee.invite.form.submit') }));
    const err = await screen.findByText(t('committee.invite.roles.required'));
    expect(err.closest('[role="alert"]')).not.toBeNull();
  });
});

// ===========================================================================
// CODE_SHOWN — focus moves ONCE (polite announce), digit-by-digit aria-label
// ===========================================================================

describe('P1-8c [a11y] code_shown — announced-not-stolen, digit-by-digit code, assertive custody', () => {
  it('focus moves ONCE to the custody-card heading (tabindex=-1) on transition', async () => {
    const { client } = inviteClient();
    render(CommitteeInvite, { props: { client: client as never } });
    await inviteToCodeShown();
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active, 'focus is on the code-card heading').not.toBeNull();
      expect(active!.getAttribute('tabindex')).toBe('-1');
      expect(active!.textContent ?? '').toContain(t('committee.invite.code.heading'));
    });
  });

  it('the code_ready announcement is POLITE (role="status"), never an assertive re-announce over the read', async () => {
    const { client } = inviteClient();
    const { container } = render(CommitteeInvite, { props: { client: client as never } });
    await inviteToCodeShown();
    // Somewhere a polite status region carries the code-ready copy.
    const politeRegions = Array.from(container.querySelectorAll('[role="status"]'));
    const announced = politeRegions.some((r) =>
      (r.textContent ?? '').includes(t('a11y.committee.invite.code_ready'))
    );
    expect(announced, 'a role="status" region announces a11y.committee.invite.code_ready').toBe(true);
  });

  it('the 6-digit code carries a digit-by-digit aria-label so a screen reader spells it', async () => {
    const { client, calls } = inviteClient();
    const { container } = render(CommitteeInvite, { props: { client: client as never } });
    const card = await inviteToCodeShown();
    const code = calls[0]!.code; // e.g. "482917"
    const spaced = code.split('').join(' '); // "4 8 2 9 1 7"
    // Some element in the card exposes the spaced digits as its accessible name.
    const hasSpacedLabel = Array.from(card.querySelectorAll('*')).some(
      (el) => (el.getAttribute('aria-label') ?? '').trim() === spaced
    );
    expect(hasSpacedLabel, `an element exposes the code as a spaced aria-label "${spaced}"`).toBe(true);
    void container;
  });

  it('the code region is a named group (aria-label = "One-time code")', async () => {
    const { client } = inviteClient();
    render(CommitteeInvite, { props: { client: client as never } });
    const shown = await inviteToCodeShown();
    const group = Array.from(shown.querySelectorAll('[role="group"]')).find(
      (g) => (g.getAttribute('aria-label') ?? '') === t('committee.invite.code.label')
    );
    expect(group, 'the code sits in a role="group" labelled "One-time code"').toBeTruthy();
  });

  it('the custody-split callout is role="status" (polite — reached via reading order, not assertive)', async () => {
    // Accessibility review Finding 5: the callout is warning-tier guidance, not a
    // danger-tier alert. Assertive here would PREEMPT/truncate the code
    // announcement the co-chair needs on mount; focus lands on the card heading
    // directly above the callout, so a polite region is reached in reading order.
    const { client } = inviteClient();
    render(CommitteeInvite, { props: { client: client as never } });
    const card = await inviteToCodeShown();
    const callout = Array.from(card.querySelectorAll('[role="status"]')).find((el) =>
      (el.textContent ?? '').includes(t('committee.invite.custody.heading'))
    );
    expect(callout, 'the custody-split guidance is announced politely, not assertively').toBeTruthy();
  });
});

// ===========================================================================
// F-170 in the a11y tree — one "Copy link" affordance, NO "Copy code"
// ===========================================================================

describe('P1-8c [a11y] F-170 — the a11y tree has one "Copy link" and no "Copy code"', () => {
  it('exactly one clipboard affordance, accessible name "Copy link"', async () => {
    const { client } = inviteClient();
    render(CommitteeInvite, { props: { client: client as never } });
    const card = await inviteToCodeShown();
    const copies = Array.from(card.querySelectorAll('button,a')).filter((el) => /copy/i.test(accName(el)));
    expect(copies.length).toBe(1);
    expect(accName(copies[0]!)).toBe(t('committee.invite.link.copy'));
  });

  it('no interactive element anywhere in the card has a "copy code" accessible name', async () => {
    const { client } = inviteClient();
    render(CommitteeInvite, { props: { client: client as never } });
    const card = await inviteToCodeShown();
    for (const el of Array.from(card.querySelectorAll('button,a,[role="button"]'))) {
      const n = accName(el).toLowerCase();
      expect(n.includes('copy') && n.includes('code')).toBe(false);
    }
  });

  it('the copy-link control announces "Link copied" via aria-live without moving focus', async () => {
    const { client } = inviteClient();
    render(CommitteeInvite, { props: { client: client as never } });
    const card = await inviteToCodeShown();
    const copy = Array.from(card.querySelectorAll('button,a')).find((el) => /copy/i.test(accName(el)))!;
    const before = document.activeElement;
    await fireEvent.click(copy);
    // A polite live region reflects the copied state.
    await waitFor(() => {
      const live = Array.from(card.querySelectorAll('[aria-live="polite"]'));
      expect(live.some((r) => (r.textContent ?? '').includes(t('committee.invite.link.copied')))).toBe(true);
    });
    // Focus is NOT stolen by the copy result (verbatim ShareUrlButton behaviour).
    expect(document.activeElement).toBe(before);
  });
});

// ===========================================================================
// KEYBOARD / FOCUS ORDER — DOM order, no positive tabindex, native controls
// ===========================================================================

describe('P1-8c [a11y] keyboard operability — native controls, no positive tabindex', () => {
  it('the form + code_shown carry NO positive tabindex (DOM order only)', async () => {
    const { client } = inviteClient();
    const { container } = render(CommitteeInvite, { props: { client: client as never } });
    await inviteToCodeShown();
    const positives = Array.from(container.querySelectorAll('[tabindex]')).filter(
      (el) => Number(el.getAttribute('tabindex')) > 0
    );
    expect(positives).toEqual([]);
  });

  it('every interactive control (CTA, checkboxes, submit, copy-link, done) is a native element', async () => {
    const { client } = inviteClient();
    render(CommitteeInvite, { props: { client: client as never } });
    // idle CTA
    expect((await screen.findByTestId('committee-invite-cta')).tagName.toLowerCase()).toBe('button');
    const card = await inviteToCodeShown();
    const interactive = Array.from(card.querySelectorAll('button,a,input'));
    expect(interactive.length).toBeGreaterThan(0);
    for (const el of interactive) {
      expect(['button', 'a', 'input']).toContain(el.tagName.toLowerCase());
    }
  });
});

// ===========================================================================
// PENDING LIST a11y — list/group semantics + member-named Re-send button
// ===========================================================================

describe('P1-8c [a11y] pending-invites list — <ul aria-label> + per-row role="group"', () => {
  it('the pending list is a <ul> with aria-label = "Pending invites"', async () => {
    const { client } = pendingClient();
    render(PendingInvites, { props: { client: client as never, onReinvite: (() => {}) as never } });
    const list = await screen.findByTestId('committee-pending-list');
    expect(list.tagName.toLowerCase()).toBe('ul');
    expect(list.getAttribute('aria-label')).toBe(t('committee.resend.list_aria'));
  });

  it('each row exposes a role="group" element with aria-labelledby → its own name element', async () => {
    const { client } = pendingClient();
    render(PendingInvites, { props: { client: client as never, onReinvite: (() => {}) as never } });
    await screen.findByTestId('committee-pending-list');
    for (const row of screen.getAllByTestId('committee-pending-row')) {
      const group =
        row.getAttribute('role') === 'group'
          ? row
          : (row.querySelector('[role="group"]') as HTMLElement | null);
      expect(group, 'each row exposes a role="group" element').not.toBeNull();
      const labelledby = group!.getAttribute('aria-labelledby');
      expect(labelledby, 'the group carries aria-labelledby').toBeTruthy();
      const nameEl = document.getElementById((labelledby ?? '').split(/\s+/)[0]!);
      expect(nameEl, 'aria-labelledby points at a real name element').not.toBeNull();
      expect((nameEl?.textContent ?? '').trim().length).toBeGreaterThan(0);
    }
  });

  it('the per-row Re-send button is a native <button> whose accessible name names the member', async () => {
    const { client } = pendingClient();
    render(PendingInvites, { props: { client: client as never, onReinvite: (() => {}) as never } });
    await screen.findByTestId('committee-pending-list');
    const row = screen.getAllByTestId('committee-pending-row')[0]!;
    const btn = Array.from(row.querySelectorAll('button')).find((b) => /re-?send/i.test(accName(b)))!;
    expect(btn.tagName.toLowerCase()).toBe('button');
    expect(btn.getAttribute('aria-label')).toBe(
      t('committee.resend.row.action_aria', { name: 'Pending Paula' })
    );
  });

  it('the re-send code_shown carries a digit-by-digit aria-label + one "Copy link" affordance', async () => {
    const { client, calls } = pendingClient();
    render(PendingInvites, { props: { client: client as never, onReinvite: (() => {}) as never } });
    const card = await resendToCodeShown();
    const spaced = calls[0]!.code.split('').join(' ');
    const hasSpaced = Array.from(card.querySelectorAll('*')).some(
      (el) => (el.getAttribute('aria-label') ?? '').trim() === spaced
    );
    expect(hasSpaced).toBe(true);
    const copies = Array.from(card.querySelectorAll('button,a')).filter((el) => /copy/i.test(accName(el)));
    expect(copies.length).toBe(1);
    expect(accName(copies[0]!)).toMatch(/link/i);
  });
});

// ===========================================================================
// axe WCAG 2 AA structural sweep — form / code_shown / pending-list
// ===========================================================================

describe('P1-8c [a11y] axe WCAG 2 AA structural sweep', () => {
  it('the invite FORM state has no axe violations', async () => {
    const { client } = inviteClient();
    const { container } = render(CommitteeInvite, { props: { client: client as never } });
    await openInviteForm();
    const r = await axeCheck(container, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });

  it('the invite CODE_SHOWN state has no axe violations', async () => {
    const { client } = inviteClient();
    const { container } = render(CommitteeInvite, { props: { client: client as never } });
    await inviteToCodeShown();
    const r = await axeCheck(container, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });

  it('the PENDING-INVITES list state has no axe violations', async () => {
    const { client } = pendingClient();
    const { container } = render(PendingInvites, {
      props: { client: client as never, onReinvite: (() => {}) as never }
    });
    await screen.findByTestId('committee-pending-list');
    const r = await axeCheck(container, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });

  it('the re-send CODE_SHOWN state has no axe violations', async () => {
    const { client } = pendingClient();
    const { container } = render(PendingInvites, {
      props: { client: client as never, onReinvite: (() => {}) as never }
    });
    await resendToCodeShown();
    const r = await axeCheck(container, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });
});
