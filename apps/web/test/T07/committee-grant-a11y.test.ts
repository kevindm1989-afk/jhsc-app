/**
 * ADR-0029 P1-8d — Surface K screen 3 co-chair grant: ACCESSIBILITY packet
 * (AODA / WCAG 2.0 AA / F-172). RED-FIRST (TDD). The implementer treats this
 * file as READ-ONLY. These tests are the accessibility-specialist's checklist
 * for the co-chair side; they MIRROR the P1-9 member a11y checklist
 * (phase0a-waiting-fingerprint-a11y.test.ts) because the SR fingerprint mirror
 * is the SAME technique on both sides.
 *
 * Load-bearing a11y items (design-system.md §4 screen-3 "Accessibility packet"):
 *   - The per-group SR mirror: <div role="group"> → <ol role="list"> → 16
 *     <li role="listitem"> → per-group <span role="img" aria-label>; the label
 *     is the SHARED "group N of 16, <NATO-spelled>" key; groups are the browse
 *     cursor's landmarks, NOT tab stops.
 *   - A leading polite role="status" "…ready to compare…" announcement.
 *   - Single deliberate focus move per transition (to a tabindex=-1 heading).
 *   - The granting → terminal live region: granted/not_ready POLITE, failed
 *     ASSERTIVE.
 *   - Every interactive control is a native <button> (keyboard reachable); the
 *     Copy affordance is the fullTarget (44px) ShareUrlButton.
 *   - An axe WCAG 2 AA structural sweep over confirm / granted / failed.
 *
 * HONEST SCOPE (mirrors the P1-9 note): touch targets ≥44px are a LAYOUT
 * property; jsdom does no layout, so pixel size is the accessibility-
 * specialist's real-browser pass. This file pins the STRUCTURAL posture
 * (native controls, no positive tabindex, role/aria/live-region categorisation,
 * the fullTarget copy affordance) + the axe structural sweep.
 *
 * Determinism: fixed byte fixtures + real libsodium; no clock/RNG/network; the
 * fingerprint surface reads no clock so real timers are used deliberately.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/svelte';
import _sodium from 'libsodium-wrappers-sumo';
import axeCheck from '../_helpers/axe-check';
import { setJwt, clearJwt } from '../../src/lib/auth/session-jwt-store';
import { t, hasKey } from '../../src/lib/i18n';
import { pubkeyFingerprint, CommitteeKeyHolder } from '../../src/lib/crypto';
import type { WrapMemberInResult } from '../../src/lib/crypto';

const { mockWrapMemberIn } = vi.hoisted(() => ({ mockWrapMemberIn: vi.fn() }));
vi.mock('../../src/lib/crypto/production-flows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/crypto/production-flows')>();
  return { ...actual, wrapMemberInViaProduction: mockWrapMemberIn };
});

// RED-FIRST import.
import CommitteeGrantCard from '../../src/lib/committee/CommitteeGrantCard.svelte';

await _sodium.ready;
const sodium = _sodium;

const ACTOR = '9f4e9b40-0000-4000-8000-00000000001a';
const MEMBER = '9f4e9b40-0000-4000-8000-00000000002b';
const MEMBER_NAME = 'Sam Rivera';

const DEVICE_PRIV = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const DEVICE_PUB = sodium.crypto_scalarmult_base(DEVICE_PRIV);
const EXPECTED_FP = await pubkeyFingerprint(DEVICE_PUB);

function makeJwt(sub: string): string {
  const seg = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${seg({ alg: 'ES256', typ: 'JWT' })}.${seg({ sub, iat: 1700000000, exp: 1700001000 })}.sig`;
}
function accName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function makeClient() {
  return {
    getMemberPubkey: vi.fn(async (_i: { target_user_id: string }) => ({
      ok: true as const,
      data: { public_key: DEVICE_PUB, fingerprint: EXPECTED_FP }
    })),
    // F-174 disclosure-ordering fix (ADV-1): the grant screen probes the actor's
    // committee-key state before disclosing. A provisioned co-chair (has a wrap)
    // proceeds to the confirm ceremony.
    getCommitteeKeyState: vi.fn(async (_i: { actor_user_id: string }) => ({
      ok: true as const,
      data: { key_id: 'k-1', epoch: 1, wrap_count: 1, actor_has_wrap: true }
    }))
  };
}

function renderGrant() {
  setJwt(makeJwt(ACTOR));
  const client = makeClient();
  render(CommitteeGrantCard, {
    props: {
      member: { user_id: MEMBER, display_name: MEMBER_NAME },
      client,
      holder: new CommitteeKeyHolder(),
      localIdentity: { getIdentityPrivateKey: vi.fn(async () => DEVICE_PRIV) }
    } as never
  });
  return { client };
}

async function toConfirm() {
  renderGrant();
  await fireEvent.click(screen.getByTestId(`committee-grant-cta-${MEMBER}`));
  return screen.findByTestId('committee-grant-confirm');
}
async function toGranted() {
  const panel = await toConfirm();
  await fireEvent.click(within(panel).getByRole('button', { name: t('committee.grant.confirm.cta') }));
  return screen.findByTestId('committee-grant-granted');
}
async function toFailed(reason: string = 'wrap_post_failed') {
  mockWrapMemberIn.mockResolvedValue({ status: 'failed', reason: reason as never });
  const panel = await toConfirm();
  await fireEvent.click(within(panel).getByRole('button', { name: t('committee.grant.confirm.cta') }));
  return screen.findByTestId('committee-grant-failed');
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
// SR STRUCTURE — the grouped, numbered, spelled, navigable fingerprint mirror
// ===========================================================================

describe('P1-8d [a11y/F-172] the disclosed-fingerprint block SR structure', () => {
  it('is a role="group" wrapping an <ol role="list"> of exactly 16 <li role="listitem">', async () => {
    const panel = await toConfirm();
    const box = within(panel).getByTestId('committee-grant-fingerprint');
    expect(box.querySelector('[role="group"]'), 'role="group" wrapper').not.toBeNull();
    const ol = box.querySelector('ol[role="list"]');
    expect(ol, '<ol role="list">').not.toBeNull();
    expect(ol!.querySelectorAll('li[role="listitem"]')).toHaveLength(16);
  });

  it('each group is a role="img" with the shared "group N of 16, <NATO-spelled>" label', async () => {
    const panel = await toConfirm();
    const box = within(panel).getByTestId('committee-grant-fingerprint');
    const imgs = Array.from(box.querySelectorAll('[role="img"]')) as HTMLElement[];
    expect(imgs).toHaveLength(16);

    const glyph = '(?:alpha|bravo|charlie|delta|echo|foxtrot|[0-9])';
    const format = new RegExp(`^group (?:[1-9]|1[0-6]) of 16, ${glyph} ${glyph} ${glyph} ${glyph}$`);
    imgs.forEach((img, i) => {
      const label = img.getAttribute('aria-label') ?? '';
      expect(label, `group ${i + 1} label format`).toMatch(format);
      expect(label.startsWith(`group ${i + 1} of 16, `), `group ${i + 1} numbered in order`).toBe(true);
    });
  });

  it('the region carries the "{name}\'s identity fingerprint — sixteen groups of four" aria-label', async () => {
    expect(hasKey('a11y.committee.grant.fingerprint.region_label')).toBe(true);
    const panel = await toConfirm();
    const box = within(panel).getByTestId('committee-grant-fingerprint');
    const region = box.querySelector('[role="group"]')!;
    expect(region.getAttribute('aria-label')).toBe(
      t('a11y.committee.grant.fingerprint.region_label', { name: MEMBER_NAME })
    );
  });

  // A11Y-3 (WCAG 4.1.3 Status Messages) — the load-bearing "ready to compare"
  // announcement must be a live-region MUTATION, not a region inserted already
  // populated (VoiceOver/TalkBack skip the latter). Mirroring
  // SetupCommitteeEncryptionCard.svelte `waitingReady` (:316 / :659-661), the
  // region mounts EMPTY on confirm's first paint and is filled a tick later.
  it('the polite "ready" region mounts EMPTY on confirm first paint and POPULATES a tick later (SR mutation)', async () => {
    expect(hasKey('a11y.committee.grant.fingerprint.ready')).toBe(true);
    const readyText = t('a11y.committee.grant.fingerprint.ready', { name: MEMBER_NAME });

    // `toConfirm()` returns the panel at the FIRST observable paint of confirm.
    const panel = await toConfirm();
    // RED against current code, which renders the ready copy inline (already
    // populated) the instant confirm mounts.
    expect(
      panel.textContent ?? '',
      'the ready region mounts EMPTY on confirm first paint (populated a tick later so it announces as a mutation)'
    ).not.toContain(readyText);

    // A tick later a polite role="status" region carries the ready announcement.
    await waitFor(() => {
      const statuses = Array.from(panel.querySelectorAll('[role="status"]'));
      expect(
        statuses.some((r) => (r.textContent ?? '').includes(readyText)),
        'a polite role="status" region is populated with the ready announcement after a tick'
      ).toBe(true);
    });
  });

  it('the groups are STATIC (not tab stops) and nothing in the panel has a positive tabindex', async () => {
    const panel = await toConfirm();
    const box = within(panel).getByTestId('committee-grant-fingerprint');
    for (const el of Array.from(box.querySelectorAll('[role="img"], li'))) {
      expect(el.getAttribute('tabindex') === '0', 'a group must not be a tab stop').toBe(false);
    }
    const positives = Array.from(panel.querySelectorAll('[tabindex]')).filter(
      (el) => Number(el.getAttribute('tabindex')) > 0
    );
    expect(positives).toEqual([]);
  });
});

// ===========================================================================
// COPY AFFORDANCE — one fullTarget "Copy fingerprint" control, copies the
// contiguous 64-hex, announces without stealing focus
// ===========================================================================

describe('P1-8d [a11y] Copy fingerprint control', () => {
  it('is exactly one native button named "Copy fingerprint" and carries the fullTarget (44px) class', async () => {
    expect(hasKey('committee.grant.confirm.copy')).toBe(true);
    const panel = await toConfirm();
    const copies = Array.from(panel.querySelectorAll('button,a')).filter((el) => /copy/i.test(accName(el)));
    expect(copies).toHaveLength(1);
    expect(copies[0]!.tagName.toLowerCase()).toBe('button');
    expect(accName(copies[0]!)).toBe(t('committee.grant.confirm.copy'));
    // Structural proxy for the ≥44px touch target (the ShareUrlButton fullTarget).
    expect(copies[0]!.classList.contains('full-target'), 'copy control uses the 44px fullTarget class').toBe(true);
  });

  it('copies the CONTIGUOUS 64-hex (public value) and announces via aria-live WITHOUT moving focus', async () => {
    expect(hasKey('a11y.committee.grant.fingerprint.copied')).toBe(true);
    const panel = await toConfirm();
    const copyBtn = within(panel).getByTestId('share-url-btn');
    const before = document.activeElement;
    await fireEvent.click(copyBtn);

    expect(clipboardWrites).toEqual([EXPECTED_FP]);
    expect(clipboardWrites[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(clipboardWrites[0]).not.toContain(' ');
    await waitFor(() => {
      const live = Array.from(panel.querySelectorAll('[aria-live="polite"]'));
      expect(
        live.some((r) => (r.textContent ?? '').includes(t('a11y.committee.grant.fingerprint.copied')))
      ).toBe(true);
    });
    expect(document.activeElement, 'copy does not steal focus').toBe(before);
  });
});

// ===========================================================================
// FOCUS DISCIPLINE — a single deliberate move per transition
// ===========================================================================

describe('P1-8d [a11y] single deliberate focus move per transition', () => {
  it('on entering confirm, focus rests on a single tabindex=-1 heading at the top of the panel', async () => {
    const panel = await toConfirm();
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active, 'focus landed on a deliberate target').not.toBeNull();
      expect(active!.getAttribute('tabindex'), 'the focus target is a programmatic -1 target').toBe('-1');
      expect(panel.contains(active), 'focus is inside the confirm panel').toBe(true);
      expect((active!.textContent ?? '').trim().length).toBeGreaterThan(0);
    });
  });

  it('every interactive control in confirm is a native <button> (keyboard reachable)', async () => {
    const panel = await toConfirm();
    // The three affordances: Copy, the affirmative CTA, Cancel — all native buttons.
    const cta = within(panel).getByRole('button', { name: t('committee.grant.confirm.cta') });
    const cancel = within(panel).getByRole('button', { name: t('committee.grant.confirm.cancel') });
    const copy = within(panel).getByTestId('share-url-btn');
    for (const el of [cta, cancel, copy]) {
      expect(el.tagName.toLowerCase()).toBe('button');
    }
  });
});

// ===========================================================================
// axe WCAG 2 AA structural sweep — confirm / granted / failed
// ===========================================================================

describe('P1-8d [a11y] axe WCAG 2 AA structural sweep', () => {
  it('the `confirm` state has no axe violations', async () => {
    await toConfirm();
    const r = await axeCheck(document.body, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });

  it('the `granted` terminal state has no axe violations', async () => {
    await toGranted();
    const r = await axeCheck(document.body, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });

  it('the `failed` terminal state has no axe violations', async () => {
    await toFailed();
    const r = await axeCheck(document.body, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });
});
