/**
 * ADR-0029 P1-8d — Surface K screen 3: the CROSS-SURFACE F-172 byte-match
 * invariant (THE reason this screen exists). RED-FIRST (TDD). The implementer
 * treats this file as READ-ONLY.
 *
 * THE LOAD-BEARING TEST (design-system.md §4 "Cross-surface invariant" :790):
 * the member's P1-9 waiting screen (Surface L) and the co-chair's grant
 * `confirm` state MUST render the SAME fingerprint the SAME way — identical 16
 * groups of 4, identical group text, and — critically — identical per-group SR
 * aria-labels (the SHARED a11y.settings.setup.fingerprint.group_label key +
 * NATO-hex fill). If they diverge, the two humans are no longer comparing the
 * same thing group-for-group and the out-of-band compare is meaningless.
 *
 * The architecture that guarantees this "by construction" is the shared
 * `FingerprintCompareBlock.svelte` consumed by BOTH surfaces (design-system.md
 * :792). This file pins the OUTPUT invariant (what the two humans see/hear) AND
 * the shared block's contract directly.
 *
 * RED SIGNAL: `CommitteeGrantCard.svelte` + `FingerprintCompareBlock.svelte` do
 * not exist yet → module-resolution failure. The member side
 * (SetupCommitteeEncryptionCard `waiting` phase) already ships and is green, so
 * the byte-match asserts a real cross-surface property once the co-chair side
 * lands.
 *
 * Determinism: ONE fixed 32-byte member device scalar → the member DERIVES the
 * fingerprint (real libsodium) and the co-chair's getMemberPubkey RETURNS the
 * byte-identical value (A-6.1). No clock/RNG/network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/svelte';
import _sodium from 'libsodium-wrappers-sumo';
import { setJwt, clearJwt } from '../../src/lib/auth/session-jwt-store';
import { t } from '../../src/lib/i18n';
import { pubkeyFingerprint, CommitteeKeyHolder } from '../../src/lib/crypto';

const { mockWrapMemberIn } = vi.hoisted(() => ({ mockWrapMemberIn: vi.fn() }));
vi.mock('../../src/lib/crypto/production-flows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/crypto/production-flows')>();
  return { ...actual, wrapMemberInViaProduction: mockWrapMemberIn };
});

// The member side (already shipped + green).
import SetupCommitteeEncryptionCard from '../../src/lib/crypto/SetupCommitteeEncryptionCard.svelte';
// RED-FIRST — the co-chair side + the shared block the implementer will create.
import CommitteeGrantCard from '../../src/lib/committee/CommitteeGrantCard.svelte';
import FingerprintCompareBlock from '../../src/lib/crypto/FingerprintCompareBlock.svelte';

await _sodium.ready;
const sodium = _sodium;

const MEMBER = '9f4e9b40-0000-4000-8000-00000000002b';
const ACTOR = '9f4e9b40-0000-4000-8000-00000000001a';
const MEMBER_NAME = 'Sam Rivera';

/** ONE fixed member device scalar; the member derives, the co-chair discloses. */
const DEVICE_PRIV = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const DEVICE_PUB = sodium.crypto_scalarmult_base(DEVICE_PRIV);
const EXPECTED_FP = await pubkeyFingerprint(DEVICE_PUB);

function makeJwt(sub: string): string {
  const seg = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${seg({ alg: 'ES256', typ: 'JWT' })}.${seg({ sub, iat: 1700000000, exp: 1700001000 })}.sig`;
}

/** Structural read of a rendered fingerprint region: group text + per-group SR label. */
function readFingerprint(region: HTMLElement): { groups: string[]; labels: string[] } {
  const imgs = Array.from(region.querySelectorAll('[role="img"]')) as HTMLElement[];
  return {
    groups: imgs.map((g) => (g.textContent ?? '').trim()),
    labels: imgs.map((g) => g.getAttribute('aria-label') ?? '')
  };
}

// --- member side (Surface L waiting phase) ---
function renderMemberWaiting(): Promise<HTMLElement> {
  setJwt(makeJwt(MEMBER));
  const client = {
    getCommitteeKeyState: vi.fn(async () => ({
      ok: true as const,
      data: { key_id: 'k-1', epoch: 1, wrap_count: 1, actor_has_wrap: false }
    }))
  };
  const localIdentity = { getIdentityPrivateKey: vi.fn(async () => DEVICE_PRIV) };
  render(SetupCommitteeEncryptionCard, { props: { client, localIdentity } as never });
  return screen.findByTestId('setup-committee-fingerprint');
}

// --- co-chair side (grant confirm) ---
async function renderCoChairConfirm(): Promise<HTMLElement> {
  setJwt(makeJwt(ACTOR));
  const client = {
    getMemberPubkey: vi.fn(async (_i: { target_user_id: string }) => ({
      ok: true as const,
      data: { public_key: DEVICE_PUB, fingerprint: EXPECTED_FP }
    })),
    // F-174 disclosure-ordering fix (ADV-1): a provisioned co-chair (has a wrap)
    // clears the pre-disclosure probe and proceeds to the confirm ceremony.
    getCommitteeKeyState: vi.fn(async (_i: { actor_user_id: string }) => ({
      ok: true as const,
      data: { key_id: 'k-1', epoch: 1, wrap_count: 1, actor_has_wrap: true }
    }))
  };
  render(CommitteeGrantCard, {
    props: {
      member: { user_id: MEMBER, display_name: MEMBER_NAME },
      client,
      holder: new CommitteeKeyHolder(),
      localIdentity: { getIdentityPrivateKey: vi.fn(async () => DEVICE_PRIV) }
    } as never
  });
  await fireEvent.click(screen.getByTestId(`committee-grant-cta-${MEMBER}`));
  const panel = await screen.findByTestId('committee-grant-confirm');
  return within(panel).getByTestId('committee-grant-fingerprint');
}

beforeEach(() => {
  mockWrapMemberIn.mockReset();
  mockWrapMemberIn.mockResolvedValue({ status: 'ok' });
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async () => undefined }
  });
});
afterEach(() => {
  cleanup();
  clearJwt();
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: undefined });
  vi.restoreAllMocks();
});

// ===========================================================================
// THE CROSS-SURFACE BYTE-MATCH — member waiting vs co-chair confirm
// ===========================================================================

describe('P1-8d [F-172 cross-surface] the two humans compare the SAME fingerprint the SAME way', () => {
  it('member (Surface L) and co-chair (grant confirm) render identical group text for the same pubkey', async () => {
    const memberRegion = await renderMemberWaiting();
    const cochairRegion = await renderCoChairConfirm();

    const member = readFingerprint(memberRegion);
    const cochair = readFingerprint(cochairRegion);

    // Both are the same 64-hex, split into 16 atomic groups of 4, same order.
    expect(member.groups).toHaveLength(16);
    expect(cochair.groups).toHaveLength(16);
    expect(member.groups.join('')).toBe(EXPECTED_FP);
    expect(cochair.groups).toEqual(member.groups); // group-for-group identical
  });

  it('the 16 per-group SR aria-labels are IDENTICAL across the two surfaces (shared group_label key)', async () => {
    const memberRegion = await renderMemberWaiting();
    const cochairRegion = await renderCoChairConfirm();

    const member = readFingerprint(memberRegion);
    const cochair = readFingerprint(cochairRegion);

    // This is the load-bearing invariant: a blind co-chair and a blind member
    // must HEAR the same words for the same group (design-system.md :757,:790).
    expect(cochair.labels).toEqual(member.labels);
    // And the labels are the shared-key shape ("group N of 16, <spelled>").
    cochair.labels.forEach((label, i) => {
      expect(label, `group ${i + 1} label`).toMatch(/^group \d+ of 16, /);
    });
  });

  it('a specific group carries the NATO-spelled a-f + plain-digit label on BOTH surfaces', async () => {
    const memberRegion = await renderMemberWaiting();
    const cochairRegion = await renderCoChairConfirm();

    const NATO: Record<string, string> = {
      a: 'alpha',
      b: 'bravo',
      c: 'charlie',
      d: 'delta',
      e: 'echo',
      f: 'foxtrot'
    };
    const spell = (g: string) =>
      g
        .split('')
        .map((ch) => NATO[ch] ?? ch)
        .join(' ');
    const g3 = EXPECTED_FP.slice(8, 12); // group 3 (0-indexed 2)
    const expectedG3 = t('a11y.settings.setup.fingerprint.group_label', { index: 3, chars: spell(g3) });

    expect(readFingerprint(memberRegion).labels[2]).toBe(expectedG3);
    expect(readFingerprint(cochairRegion).labels[2]).toBe(expectedG3);
  });
});

// ===========================================================================
// THE SHARED BLOCK — FingerprintCompareBlock renders the mirror by construction
// ===========================================================================

describe('P1-8d [shared block] FingerprintCompareBlock is the single mirror both surfaces consume', () => {
  it('given a 64-hex fingerprint prop, it renders the <ol role="list"> of 16 <li role="listitem"> / per-group role="img"', () => {
    const { container } = render(FingerprintCompareBlock, { props: { fingerprint: EXPECTED_FP } as never });
    const region = container.querySelector('[role="group"]');
    expect(region, 'the block wraps its list in a role="group"').not.toBeNull();
    const ol = container.querySelector('ol[role="list"]');
    expect(ol, 'the groups are an <ol role="list">').not.toBeNull();
    const items = container.querySelectorAll('li[role="listitem"]');
    expect(items).toHaveLength(16);
    const imgs = Array.from(container.querySelectorAll('[role="img"]')) as HTMLElement[];
    expect(imgs).toHaveLength(16);
    expect(imgs.map((g) => (g.textContent ?? '').trim()).join('')).toBe(EXPECTED_FP);
  });

  it('its per-group labels equal the member waiting-phase labels (proves the block IS the shared mirror)', async () => {
    const { container } = render(FingerprintCompareBlock, { props: { fingerprint: EXPECTED_FP } as never });
    const blockLabels = readFingerprint(container as unknown as HTMLElement).labels;

    const memberRegion = await renderMemberWaiting();
    const memberLabels = readFingerprint(memberRegion).labels;

    expect(blockLabels).toEqual(memberLabels);
  });
});

// ===========================================================================
// ADV-3 — the shared block must NOT announce a fingerprint region for a
// non-64-hex input. A role="group" carrying the "{name}'s identity fingerprint"
// aria-label but with NO groups tells a screen-reader user a fingerprint is
// present when there is none (an empty / partial derive). Guard: only emit the
// region when fingerprint.length === 64.
// ===========================================================================

describe('P1-8d [ADV-3] FingerprintCompareBlock emits NO fingerprint region for a non-64-hex input', () => {
  const REGION_LABEL = "Sam Rivera's identity fingerprint";

  it('an EMPTY fingerprint renders no role="group" region and no groups', () => {
    const { container } = render(FingerprintCompareBlock, {
      props: { fingerprint: '', regionLabel: REGION_LABEL, testid: 'fp-empty' } as never
    });
    expect(
      container.querySelector('[role="group"]'),
      'no role="group" fingerprint region is announced for an empty fingerprint'
    ).toBeNull();
    expect(container.querySelectorAll('[role="img"]')).toHaveLength(0);
    expect(container.querySelector('ol[role="list"]')).toBeNull();
  });

  it('a 40-char (non-64) fingerprint renders no role="group" region and no groups', () => {
    const forty = 'a'.repeat(40);
    const { container } = render(FingerprintCompareBlock, {
      props: { fingerprint: forty, regionLabel: REGION_LABEL, testid: 'fp-40' } as never
    });
    expect(
      container.querySelector('[role="group"]'),
      'no role="group" fingerprint region is announced for a 40-char fingerprint'
    ).toBeNull();
    expect(container.querySelectorAll('[role="img"]')).toHaveLength(0);
  });

  it('a valid 64-hex fingerprint DOES emit the role="group" region (control — the guard is not over-broad)', () => {
    const { container } = render(FingerprintCompareBlock, {
      props: { fingerprint: EXPECTED_FP, regionLabel: REGION_LABEL, testid: 'fp-ok' } as never
    });
    expect(container.querySelector('[role="group"]')).not.toBeNull();
    expect(container.querySelectorAll('[role="img"]')).toHaveLength(16);
  });
});
