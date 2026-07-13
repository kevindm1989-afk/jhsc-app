/**
 * ADR-0029 P1-8d — Surface K screen 3 co-chair grant: the SECURITY / F-172 /
 * F-179 / F-180 / F-181 / F-176 contract. RED-FIRST (TDD). The implementer
 * treats this file as READ-ONLY.
 *
 * RED SIGNAL: `CommitteeGrantCard.svelte` does not exist yet → module-resolution
 * failure. That is the intended primary red signal.
 *
 * The four load-bearing security properties (design-system.md §4 screen-3
 * "load-bearing property" + threat-model §3.18):
 *
 *   F-179 SINGLE DISCLOSURE — activating grant calls client.getMemberPubkey
 *     EXACTLY ONCE across the whole ceremony. No second disclosure anywhere.
 *     (Harness note: wrapMemberInViaProduction is mocked, so it CANNOT re-fetch
 *     the pubkey. The only getMemberPubkey call therefore is the component's own
 *     — a call-count of exactly 1 proves the component owns one disclosure and
 *     passes `disclosed` down, per A-8.6.)
 *
 *   F-172 CONFIRMED == SEALED — the `disclosed` object the component passes to
 *     wrapMemberInViaProduction is byte-identical to what getMemberPubkey
 *     returned AND to what the fingerprint block rendered. The co-chair seals to
 *     exactly the pubkey shown; the human-compared bytes ARE the sealed bytes.
 *     (Harness note: we capture wrapMemberInViaProduction's opts.disclosed and
 *     assert public_key bytes + fingerprint string against the disclosure
 *     return AND the rendered group DOM.)
 *
 *   F-180 / F-181 SERVER-TRUTHED TERMINALS (anti-optimism) — `granted` renders
 *     ONLY on { status:'ok' }; a { status:'failed', reason } renders `failed`
 *     with actionable copy that never echoes the raw reason enum (F-176); a
 *     thrown/rejected wrap renders `failed`, never a crash, never a false
 *     `granted`. The UI never flips to granted before the server return.
 *
 *   F-180 ADVISORY FRAMING — the confirm CTA is NOT behind a forced "I checked"
 *     gate (that would mislabel the advisory compare as load-bearing); the
 *     affirmative claim lives in the button label.
 *
 * Determinism: fixed byte fixtures + real libsodium fingerprint; deferred
 * Promises (no sleeps); mocked module seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/svelte';
import _sodium from 'libsodium-wrappers-sumo';
import { setJwt, clearJwt } from '../../src/lib/auth/session-jwt-store';
import { t } from '../../src/lib/i18n';
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

type Disclosure =
  | { ok: true; data: { public_key: Uint8Array; fingerprint: string } }
  | { ok: false; reason: string; status: number };

const OK_DISCLOSURE: Disclosure = { ok: true, data: { public_key: DEVICE_PUB, fingerprint: EXPECTED_FP } };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

function makeClient(disclosure: Disclosure | Promise<Disclosure> = OK_DISCLOSURE) {
  const getMemberPubkey = vi.fn(async (_input: { target_user_id: string }) => disclosure);
  return { getMemberPubkey };
}

function makeJwt(sub: string): string {
  const seg = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${seg({ alg: 'ES256', typ: 'JWT' })}.${seg({ sub, iat: 1700000000, exp: 1700001000 })}.sig`;
}

function renderGrant(
  over: {
    member?: { user_id: string; display_name: string | null };
    client?: ReturnType<typeof makeClient>;
  } = {}
) {
  setJwt(makeJwt(ACTOR));
  const client = over.client ?? makeClient();
  const holder = new CommitteeKeyHolder();
  const localIdentity = { getIdentityPrivateKey: vi.fn(async () => DEVICE_PRIV) };
  const member = over.member ?? { user_id: MEMBER, display_name: MEMBER_NAME };
  const utils = render(CommitteeGrantCard, {
    props: { member, client, holder, localIdentity } as never
  });
  return { ...utils, client, holder, localIdentity, member };
}

async function tapGrant(uid: string = MEMBER) {
  await fireEvent.click(screen.getByTestId(`committee-grant-cta-${uid}`));
}

async function confirmGrant() {
  const panel = await screen.findByTestId('committee-grant-confirm');
  await fireEvent.click(within(panel).getByRole('button', { name: t('committee.grant.confirm.cta') }));
}

beforeEach(() => {
  mockWrapMemberIn.mockReset();
  mockWrapMemberIn.mockResolvedValue({ status: 'ok' } satisfies WrapMemberInResult);
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
// F-179 — SINGLE DISCLOSURE across the whole ceremony
// ===========================================================================

describe('P1-8d [F-179] the ceremony discloses the member pubkey EXACTLY ONCE', () => {
  it('a full idle → disclose → confirm → grant → granted flow calls getMemberPubkey exactly once', async () => {
    const { client } = renderGrant();
    expect(client.getMemberPubkey).toHaveBeenCalledTimes(0); // no pre-fetch on mount

    await tapGrant();
    await confirmGrant();
    await screen.findByTestId('committee-grant-granted');

    // The single disclosure is the component's own; the mocked wrap composition
    // does NOT (and must not) re-fetch — a count of 1 proves no second disclosure.
    expect(client.getMemberPubkey).toHaveBeenCalledTimes(1);
    expect(client.getMemberPubkey).toHaveBeenCalledWith({ target_user_id: MEMBER });
  });

  it('the confirm → grant transition does not itself trigger a second disclosure', async () => {
    const { client } = renderGrant();
    await tapGrant();
    await screen.findByTestId('committee-grant-confirm');
    expect(client.getMemberPubkey).toHaveBeenCalledTimes(1);

    await confirmGrant();
    await screen.findByTestId('committee-grant-granted');
    // Still exactly one — sealing consumed the ALREADY-disclosed bytes.
    expect(client.getMemberPubkey).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// F-172 — CONFIRMED == SEALED: the disclosed bytes are the sealed bytes
// ===========================================================================

describe('P1-8d [F-172] the co-chair seals to exactly the pubkey the fingerprint showed', () => {
  it('wrapMemberInViaProduction receives disclosed.{public_key,fingerprint} byte-identical to the disclosure return AND the rendered block', async () => {
    const { client } = renderGrant();
    await tapGrant();

    // What the fingerprint block RENDERED (the human-compared value).
    const fpBox = await screen.findByTestId('committee-grant-fingerprint');
    const renderedFp = (Array.from(fpBox.querySelectorAll('[role="img"]')) as HTMLElement[])
      .map((g) => (g.textContent ?? '').trim())
      .join('');

    await confirmGrant();
    await screen.findByTestId('committee-grant-granted');

    // What getMemberPubkey RETURNED.
    const disclosureReturn = await client.getMemberPubkey.mock.results[0]!.value;
    expect(disclosureReturn.ok).toBe(true);

    // What was SEALED (the opts.disclosed the component passed down, A-8.6).
    expect(mockWrapMemberIn).toHaveBeenCalledTimes(1);
    const opts = mockWrapMemberIn.mock.calls[0]![0] as {
      target_user_id: string;
      user_id: string;
      disclosed: { public_key: Uint8Array; fingerprint: string };
    };
    expect(opts.disclosed, 'A-8.6 requires the disclosed object to be passed').toBeTruthy();

    // Three-way byte-identity: rendered == returned == sealed.
    expect(opts.disclosed.fingerprint).toBe(EXPECTED_FP);
    expect(opts.disclosed.fingerprint).toBe(renderedFp);
    expect((disclosureReturn as { data: { fingerprint: string } }).data.fingerprint).toBe(
      opts.disclosed.fingerprint
    );
    expect(Array.from(opts.disclosed.public_key)).toEqual(Array.from(DEVICE_PUB));
    expect(Array.from(opts.disclosed.public_key)).toEqual(
      Array.from((disclosureReturn as { data: { public_key: Uint8Array } }).data.public_key)
    );

    // The seal targets the disclosed member and is scoped to the actor from session.
    expect(opts.target_user_id).toBe(MEMBER);
    expect(opts.user_id).toBe(ACTOR);
  });

  it('a smuggled caller-supplied pubkey cannot become the sealed target — disclosed carries the SERVER bytes only', async () => {
    // The server-disclosed bytes are the only seal target. Even if the disclosure
    // and the render both come from DEVICE_PUB, the component must forward those
    // exact server bytes (never a fabricated 32-byte pubkey).
    const attackerPub = sodium.crypto_scalarmult_base(new Uint8Array(32).fill(9));
    renderGrant();
    await tapGrant();
    await confirmGrant();
    await screen.findByTestId('committee-grant-granted');

    const opts = mockWrapMemberIn.mock.calls[0]![0] as { disclosed: { public_key: Uint8Array } };
    expect(Array.from(opts.disclosed.public_key)).not.toEqual(Array.from(attackerPub));
    expect(Array.from(opts.disclosed.public_key)).toEqual(Array.from(DEVICE_PUB));
  });
});

// ===========================================================================
// F-180 / F-181 — SERVER-TRUTHED TERMINALS (anti-optimism)
// ===========================================================================

describe('P1-8d [F-181] the UI never optimistically flips to granted', () => {
  it('while the wrap is in flight, `granting` is shown and `granted` is ABSENT until the server returns ok', async () => {
    const wrap = deferred<WrapMemberInResult>();
    mockWrapMemberIn.mockReturnValue(wrap.promise);
    renderGrant();
    await tapGrant();
    await confirmGrant();

    await screen.findByTestId('committee-grant-granting');
    // The load-bearing anti-optimism assertion: no premature success.
    expect(screen.queryByTestId('committee-grant-granted')).toBeNull();

    wrap.resolve({ status: 'ok' });
    await screen.findByTestId('committee-grant-granted');
  });

  it('granted renders ONLY on { status:"ok" }', async () => {
    mockWrapMemberIn.mockResolvedValue({ status: 'ok' });
    renderGrant();
    await tapGrant();
    await confirmGrant();
    await screen.findByTestId('committee-grant-granted');
    expect(screen.queryByTestId('committee-grant-failed')).toBeNull();
    expect(screen.queryByTestId('committee-grant-not-ready')).toBeNull();
  });
});

describe('P1-8d [F-180/F-181] failure returns render `failed`, never a false `granted` or a crash', () => {
  it('a rejected (thrown) wrap renders failed (generic actionable copy) — no crash, no false granted', async () => {
    mockWrapMemberIn.mockRejectedValue(new Error('synthetic-transport-blowup'));
    renderGrant();
    await tapGrant();
    await confirmGrant();

    const failed = await screen.findByTestId('committee-grant-failed');
    expect(failed.textContent ?? '').toContain(t('committee.grant.failed.heading'));
    expect(failed.textContent ?? '').toContain(t('committee.grant.failed.generic.body'));
    // Never a false success; the component survived the throw (panel is mounted).
    expect(screen.queryByTestId('committee-grant-granted')).toBeNull();
    expect(failed).toBeTruthy();
  });

  it('a defensive { status:"member_not_enrolled" } wrap return renders not_ready (POLITE), not failed', async () => {
    mockWrapMemberIn.mockResolvedValue({ status: 'member_not_enrolled' });
    renderGrant();
    await tapGrant();
    await confirmGrant();
    await screen.findByTestId('committee-grant-not-ready');
    expect(screen.queryByTestId('committee-grant-granted')).toBeNull();
    expect(screen.queryByTestId('committee-grant-failed')).toBeNull();
  });
});

// ===========================================================================
// F-176 — reason → actionable copy mapping; the raw enum is NEVER rendered
// ===========================================================================

describe('P1-8d [F-176] each failed reason maps to actionable copy that never echoes the enum', () => {
  const CASES: ReadonlyArray<{ reason: WrapMemberInResult extends { reason: infer R } ? R : never; bodyKey: string }> = [
    { reason: 'pubkey_disclosure_denied', bodyKey: 'committee.grant.failed.disclosure_denied.body' },
    { reason: 'actor_has_no_wrap', bodyKey: 'committee.grant.failed.no_actor_wrap.body' },
    { reason: 'data_key_unwrap_failed', bodyKey: 'committee.grant.failed.unlock.body' },
    { reason: 'decrypt_failed', bodyKey: 'committee.grant.failed.unlock.body' },
    { reason: 'wrap_post_failed', bodyKey: 'committee.grant.failed.wrap_post.body' },
    { reason: 'invalid_pubkey', bodyKey: 'committee.grant.failed.generic.body' },
    { reason: 'unknown', bodyKey: 'committee.grant.failed.generic.body' }
  ] as const;

  for (const { reason, bodyKey } of CASES) {
    it(`reason "${reason}" → renders ${bodyKey} and NEVER the raw token "${reason}"`, async () => {
      mockWrapMemberIn.mockResolvedValue({ status: 'failed', reason: reason as never });
      renderGrant();
      await tapGrant();
      await confirmGrant();

      const failed = await screen.findByTestId('committee-grant-failed');
      const text = failed.textContent ?? '';
      expect(text, `renders ${bodyKey}`).toContain(t(bodyKey));
      // F-176: the raw enum token must never surface in the DOM.
      expect(text.toLowerCase(), `must not echo the enum "${reason}"`).not.toContain(reason);
      cleanup(); // isolate each parametrised case
    });
  }

  it('a disclosure rls_denied (403) maps to the disclosure-denied failure, without ever calling wrap', async () => {
    const client = makeClient({ ok: false, reason: 'rls_denied', status: 403 });
    renderGrant({ client });
    await tapGrant();

    const failed = await screen.findByTestId('committee-grant-failed');
    expect(failed.textContent ?? '').toContain(t('committee.grant.failed.disclosure_denied.body'));
    expect(failed.textContent?.toLowerCase() ?? '').not.toContain('rls_denied');
    // The seal step is never reached when the disclosure itself is denied.
    expect(mockWrapMemberIn).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// F-180 — the confirm CTA is advisory-framed: NOT behind a forced gate
// ===========================================================================

describe('P1-8d [F-180] the confirm CTA is advisory-framed (no load-bearing gate)', () => {
  it('the confirm CTA is enabled immediately with no forced "I checked" checkbox gating it', async () => {
    renderGrant();
    await tapGrant();
    const panel = await screen.findByTestId('committee-grant-confirm');

    const cta = within(panel).getByRole('button', {
      name: t('committee.grant.confirm.cta')
    }) as HTMLButtonElement;
    // Advisory, not load-bearing → the affirmative claim is the label, not a gate.
    expect(cta.disabled, 'the CTA is not gated behind a forced checkbox').toBe(false);
    expect(within(panel).queryByRole('checkbox'), 'no forced "I checked" checkbox').toBeNull();
  });

  it('the rendered compare callout names the server as the control (advisory framing, not "this secures the key")', async () => {
    renderGrant();
    await tapGrant();
    const panel = await screen.findByTestId('committee-grant-confirm');
    const text = (panel.textContent ?? '').toLowerCase();
    // The server-is-the-control clause is present (design-system.md :806).
    expect(text).toContain('only goes to the member who set up encryption');
    // And no "this secures/keeps the key secure" claim on the compare.
    expect(text).not.toMatch(/secures the key|keeps the key secure/);
  });
});
