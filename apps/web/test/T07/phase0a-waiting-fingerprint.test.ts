/**
 * ADR-0029 P1-9-fingerprint — SetupCommitteeEncryptionCard `waiting` phase
 * (Surface L / F-172 / F-180). RED-FIRST (TDD). The implementer treats this
 * file as READ-ONLY.
 *
 * WHAT THIS PINS (member-side only — NOT the P1-8d co-chair grant):
 * the new `waiting` phase shows a member their OWN identity fingerprint while
 * they wait for a co-chair to grant committee-key access. The fingerprint the
 * member reads aloud IS the F-172 human-augment compare value the co-chair
 * re-derives via the SAME `pubkeyFingerprint()` and checks before wrapping the
 * member in. So the load-bearing property is BYTE-IDENTITY: the shown
 * fingerprint == pubkeyFingerprint(crypto_scalarmult_base(devicePrivkey)) —
 * the enrolled pubkey's SHA-256 fingerprint (Amendment A-6.1). If this drifts,
 * the P1-8d compare gate is meaningless.
 *
 * DECIDED contract (design-system.md §4 Surface L — do not reopen):
 *   - Entry gate (caught BEFORE the not_provisioned fall-through at :205-209):
 *       hasDevicePrivkey === true && state.actor_has_wrap === false
 *       && state.wrap_count > 0  →  `waiting`.
 *     Other routings UNCHANGED: wrap_count===0 + privkey → not_provisioned;
 *     no privkey (+ wrap_count>0) → foreign_held; actor_has_wrap + no privkey
 *     → restore_required.
 *   - Client-side derivation ONLY: NO server RPC for the fingerprint (no
 *     pubkey-disclosure op fires; the probe read is the ONLY client call).
 *   - Display: 16 groups of 4 hex; a "Copy fingerprint" control copies the
 *     CONTIGUOUS 64-hex (copy of a PUBLIC value IS allowed — deliberate
 *     contrast with the Surface K one-time code).
 *   - Sub-states: computing → shown → derive_error (fail-safe).
 *
 * HARNESS (no prior render harness existed for this card — built from the same
 * primitives the sibling component tests use):
 *   - `getCurrentUserId()` reads the in-memory session-jwt-store, so we seed a
 *     JWT whose `sub` claim is the synthetic user (mirrors sessions-list.test).
 *   - `client` mock: `getCommitteeKeyState({actor_user_id}) →
 *     { ok:true, data:{ key_id, epoch, wrap_count, actor_has_wrap } }`
 *     (drives the routing).
 *   - `localIdentity` mock: `getIdentityPrivateKey(uid)` returns a fixed 32-byte
 *     device privkey (present) or throws (withheld) — exactly the two device
 *     states probeState branches on.
 *   - real libsodium + real `pubkeyFingerprint` (so byte-identity is genuine).
 *
 * Determinism: the device privkey is a FIXED byte pattern, so the derived
 * fingerprint is a pure, reproducible function of it (no RNG, no clock, no
 * network, no date). The `computing→shown` ordering + `derive_error` tests
 * drive the derive deterministically by controlling `crypto.subtle.digest`
 * (the digest `pubkeyFingerprint()` uses) — no sleeps, no flakiness.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import _sodium from 'libsodium-wrappers-sumo';
import { setJwt, clearJwt } from '../../src/lib/auth/session-jwt-store';
import { pubkeyFingerprint } from '../../src/lib/crypto';

// RED-FIRST: the `waiting` phase / testids do not exist yet in this card.
import SetupCommitteeEncryptionCard from '../../src/lib/crypto/SetupCommitteeEncryptionCard.svelte';

await _sodium.ready;
const sodium = _sodium;

// ---------------------------------------------------------------------------
// Fixtures (this file owns them; nothing shared/mutable across tests).
// ---------------------------------------------------------------------------

const USER = '9f4e9b40-0000-4000-8000-00000000001a'; // SYNTHETIC member

/** A FIXED 32-byte X25519 scalar → deterministic pub + fingerprint. */
const DEVICE_PRIV = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const DEVICE_PUB = sodium.crypto_scalarmult_base(DEVICE_PRIV);
// The load-bearing expected value: the enrolled pubkey's SHA-256 fingerprint.
const EXPECTED_FP = await pubkeyFingerprint(DEVICE_PUB); // 64 lowercase hex
const PRIV_HEX = sodium.to_hex(DEVICE_PRIV);
const PRIV_B64 = sodium.to_base64(DEVICE_PRIV);

interface KeyState {
  key_id: string;
  epoch: number;
  wrap_count: number;
  actor_has_wrap: boolean;
}
function keyState(over: Partial<KeyState> = {}): KeyState {
  return { key_id: 'k-1', epoch: 1, wrap_count: 1, actor_has_wrap: false, ...over };
}

/** Mock t07 client exposing ONLY the read-only probe (the card's sole call). */
function makeClient(state: KeyState) {
  const getCommitteeKeyState = vi.fn(async (_input: { actor_user_id: string }) => ({
    ok: true as const,
    data: state
  }));
  return { getCommitteeKeyState };
}

/**
 * A recording client Proxy: every string property the card reads off the
 * client is logged, so a test can prove NO pubkey-disclosure op is ever
 * touched (client-side derivation only).
 */
function makeRecordingClient(state: KeyState) {
  const accessed: string[] = [];
  const getCommitteeKeyState = vi.fn(async () => ({ ok: true as const, data: state }));
  const base: Record<string, unknown> = { getCommitteeKeyState };
  const client = new Proxy(base, {
    get(target, prop, recv) {
      if (typeof prop === 'string') accessed.push(prop);
      return Reflect.get(target, prop, recv);
    }
  });
  return { client, accessed, getCommitteeKeyState };
}

/** Device holds the privkey (present) or the store throws (withheld). */
function localIdentityWith(priv: Uint8Array | 'throw') {
  return {
    getIdentityPrivateKey: vi.fn(async (_uid: string) => {
      if (priv === 'throw') throw new Error('device-local private key not found');
      return priv;
    })
  };
}

function makeJwt(sub: string): string {
  const seg = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = seg({ alg: 'ES256', typ: 'JWT' });
  const body = seg({ sub, iat: 1700000000, exp: 1700001000 });
  return `${header}.${body}.sig`;
}

function renderCard(client: unknown, localIdentity: unknown) {
  setJwt(makeJwt(USER));
  return render(SetupCommitteeEncryptionCard, {
    props: { client: client as never, localIdentity: localIdentity as never }
  });
}

/** The 16 per-group role="img" spans hold the fingerprint glyphs, in order. */
function groupImgs(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll('[role="img"]')) as HTMLElement[];
}

let clipboardWrites: string[] = [];

beforeEach(() => {
  clipboardWrites = [];
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (s: string) => void clipboardWrites.push(String(s)) }
  });
});

afterEach(() => {
  cleanup();
  clearJwt();
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: undefined
  });
  vi.restoreAllMocks();
});

// ===========================================================================
// ROUTING — the entry gate + the UNCHANGED sibling routings (F-180 / Surface L)
// ===========================================================================

describe('P1-9 [F-180] routing gate — waiting iff privkey && !actor_has_wrap && wrap_count>0', () => {
  it('privkey present + actor_has_wrap:false + wrap_count:1 → enters `waiting` (NOT not_provisioned/foreign_held/restore_required)', async () => {
    const { getCommitteeKeyState } = makeClient(keyState({ actor_has_wrap: false, wrap_count: 1 }));
    renderCard({ getCommitteeKeyState }, localIdentityWith(DEVICE_PRIV));

    // The load-bearing new branch: the waiting phase renders.
    await screen.findByTestId('setup-committee-waiting');

    // And it is NOT any of the pre-existing terminal routings.
    expect(screen.queryByTestId('setup-committee-start')).toBeNull(); // not_provisioned CTA
    expect(screen.queryByTestId('setup-committee-foreign-held')).toBeNull();
    expect(screen.queryByTestId('setup-committee-restore-required')).toBeNull();
  });

  it('REGRESSION: privkey present + wrap_count:0 → stays `not_provisioned` (no committee key exists yet)', async () => {
    renderCard(makeClient(keyState({ actor_has_wrap: false, wrap_count: 0 })), localIdentityWith(DEVICE_PRIV));

    await screen.findByTestId('setup-committee-start');
    expect(screen.queryByTestId('setup-committee-waiting')).toBeNull();
    expect(screen.queryByTestId('setup-committee-waiting-computing')).toBeNull();
  });

  it('REGRESSION: NO device privkey + wrap_count:1 → stays `foreign_held` (key held by others, this actor has none)', async () => {
    renderCard(makeClient(keyState({ actor_has_wrap: false, wrap_count: 1 })), localIdentityWith('throw'));

    await screen.findByTestId('setup-committee-foreign-held');
    expect(screen.queryByTestId('setup-committee-waiting')).toBeNull();
  });

  it('REGRESSION: NO device privkey + actor_has_wrap:true → stays `restore_required` (edge-B: restore, never a second enroll)', async () => {
    renderCard(makeClient(keyState({ actor_has_wrap: true, wrap_count: 2 })), localIdentityWith('throw'));

    await screen.findByTestId('setup-committee-restore-required');
    expect(screen.queryByTestId('setup-committee-waiting')).toBeNull();
  });
});

// ===========================================================================
// CLIENT-SIDE DERIVATION — no pubkey-disclosure RPC (F-172; identity_keys
// stays read-locked)
// ===========================================================================

describe('P1-9 [F-172] the fingerprint is derived client-side — no server disclosure op fires', () => {
  it('the ONLY client call is the read-only probe; no pubkey/member/wrap/disclosure op is touched', async () => {
    const { client, accessed, getCommitteeKeyState } = makeRecordingClient(
      keyState({ actor_has_wrap: false, wrap_count: 1 })
    );
    renderCard(client, localIdentityWith(DEVICE_PRIV));

    await screen.findByTestId('setup-committee-fingerprint');

    // The resume probe ran exactly once and nothing else.
    expect(getCommitteeKeyState).toHaveBeenCalledTimes(1);
    expect(accessed).toContain('getCommitteeKeyState');
    const disclosureShaped = accessed.filter((p) => /pubkey|member|disclos|reveal|wrap|fingerprint/i.test(p));
    expect(disclosureShaped, 'no pubkey-disclosure op is called for the fingerprint').toEqual([]);
  });

  it('[F-172 byte-identity] the shown contiguous fingerprint === pubkeyFingerprint(crypto_scalarmult_base(devicePrivkey))', async () => {
    renderCard(makeClient(keyState({ actor_has_wrap: false, wrap_count: 1 })), localIdentityWith(DEVICE_PRIV));

    const box = await screen.findByTestId('setup-committee-fingerprint');
    const reassembled = groupImgs(box)
      .map((g) => (g.textContent ?? '').trim())
      .join('');

    // It is the enrolled pubkey's SHA-256 fingerprint — the exact value the
    // co-chair's getMemberPubkey().fingerprint will disclose at P1-8d.
    expect(EXPECTED_FP).toMatch(/^[0-9a-f]{64}$/);
    expect(reassembled).toBe(EXPECTED_FP);
  });
});

// ===========================================================================
// computing → shown — the Surface-L waiting sub-state machine
// ===========================================================================

describe('P1-9 [Surface L] computing → shown sub-states', () => {
  it('renders `computing` first (fingerprint absent, aria-busy=true), then `shown` once the derive resolves', async () => {
    // Defer the SHA-256 digest `pubkeyFingerprint()` performs so the derive
    // parks in `computing` until we release it — a deterministic ordering
    // observation with no sleep.
    let releaseDigest: (() => void) | null = null;
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(
      (alg: AlgorithmIdentifier, data: BufferSource) =>
        new Promise<ArrayBuffer>((resolve, reject) => {
          releaseDigest = () => realDigest(alg, data as never).then(resolve, reject);
        })
    );

    renderCard(makeClient(keyState({ actor_has_wrap: false, wrap_count: 1 })), localIdentityWith(DEVICE_PRIV));

    // computing: the literal-action line is up; the fingerprint is NOT yet shown.
    await screen.findByTestId('setup-committee-waiting-computing');
    expect(screen.queryByTestId('setup-committee-fingerprint')).toBeNull();
    const section = screen.getByTestId('setup-committee-section');
    expect(section.getAttribute('aria-busy')).toBe('true');

    // Release the derive → shown.
    expect(releaseDigest).not.toBeNull();
    releaseDigest!();

    await screen.findByTestId('setup-committee-fingerprint');
    await waitFor(() => expect(screen.queryByTestId('setup-committee-waiting-computing')).toBeNull());
    await screen.findByTestId('setup-committee-waiting');
  });
});

// ===========================================================================
// GROUPED DISPLAY — 16 groups of 4 (matches Surface K screen-3 byte-for-byte)
// ===========================================================================

describe('P1-9 [Surface L] grouped display — 16 groups of 4 hex', () => {
  it('renders exactly 16 groups, each 4 chars, reassembling to the contiguous 64-hex', async () => {
    renderCard(makeClient(keyState({ actor_has_wrap: false, wrap_count: 1 })), localIdentityWith(DEVICE_PRIV));

    const box = await screen.findByTestId('setup-committee-fingerprint');
    const groups = groupImgs(box);
    expect(groups).toHaveLength(16);
    for (const g of groups) {
      expect((g.textContent ?? '').trim()).toMatch(/^[0-9a-f]{4}$/);
    }
    expect(groups.map((g) => (g.textContent ?? '').trim()).join('')).toBe(EXPECTED_FP);
  });
});

// ===========================================================================
// COPY — copies the CONTIGUOUS 64-hex (public value; deliberate contrast with
// Surface K where copy-of-the-code is forbidden)
// ===========================================================================

describe('P1-9 [Surface L] Copy fingerprint — copies the contiguous 64-hex (public value)', () => {
  it('the copy control writes the EXACT contiguous 64-hex (not the spaced form) to the clipboard', async () => {
    renderCard(makeClient(keyState({ actor_has_wrap: false, wrap_count: 1 })), localIdentityWith(DEVICE_PRIV));
    await screen.findByTestId('setup-committee-fingerprint');

    const copyBtn = screen.getByTestId('share-url-btn'); // reused ShareUrlButton
    await fireEvent.click(copyBtn);

    expect(clipboardWrites).toEqual([EXPECTED_FP]);
    // Contiguous, not spaced — the co-chair's paste-compare target.
    expect(clipboardWrites[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(clipboardWrites[0]).not.toContain(' ');
  });

  it('[privacy] only the PUBLIC fingerprint is ever exposed — the device private key never appears in the DOM or the clipboard', async () => {
    renderCard(makeClient(keyState({ actor_has_wrap: false, wrap_count: 1 })), localIdentityWith(DEVICE_PRIV));
    const box = await screen.findByTestId('setup-committee-fingerprint');

    await fireEvent.click(screen.getByTestId('share-url-btn'));

    const section = screen.getByTestId('setup-committee-section');
    const html = section.innerHTML;
    expect(html.includes(PRIV_HEX)).toBe(false);
    expect(html.includes(PRIV_B64)).toBe(false);
    expect(box.textContent ?? '').not.toContain(PRIV_HEX);
    const clip = clipboardWrites.join('\n');
    expect(clip.includes(PRIV_HEX)).toBe(false);
    expect(clip.includes(PRIV_B64)).toBe(false);
  });
});

// ===========================================================================
// derive_error — the fail-safe (Surface L: unreachable in the gated branch,
// but MUST fail closed if the digest/derivation ever throws)
// ===========================================================================

describe('P1-9 [Surface L] derive_error — fails safe with no fingerprint, no crash', () => {
  it('a throw inside the derive (pubkeyFingerprint digest fails) renders derive_error and NO fingerprint', async () => {
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('synthetic-digest-failure'));

    renderCard(makeClient(keyState({ actor_has_wrap: false, wrap_count: 1 })), localIdentityWith(DEVICE_PRIV));

    const errPanel = await screen.findByTestId('setup-committee-waiting-error');
    // Fail-safe posture: error is an alert, no fingerprint was rendered, and
    // the card did not crash out of its section.
    expect(errPanel.closest('[role="alert"]') ?? errPanel.querySelector('[role="alert"]')).not.toBeNull();
    expect(screen.queryByTestId('setup-committee-fingerprint')).toBeNull();
    expect(screen.getByTestId('setup-committee-section')).toBeInTheDocument();
  });

  it('Try again re-derives from the unchanged privkey and recovers to the shown fingerprint', async () => {
    // Fail the FIRST digest (the initial derive), then let the real digest run so
    // the retry succeeds. The privkey is unchanged in memory, so retry MUST
    // reproduce the byte-identical fingerprint and clear the error.
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    let digestCalls = 0;
    vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      digestCalls += 1;
      if (digestCalls === 1) return Promise.reject(new Error('synthetic-digest-failure'));
      return realDigest(algorithm, data);
    });

    renderCard(makeClient(keyState({ actor_has_wrap: false, wrap_count: 1 })), localIdentityWith(DEVICE_PRIV));

    // First derive fails closed — no fingerprint.
    await screen.findByTestId('setup-committee-waiting-error');
    expect(screen.queryByTestId('setup-committee-fingerprint')).toBeNull();

    // Retry re-derives in place.
    await fireEvent.click(screen.getByTestId('setup-committee-waiting-retry'));

    const box = await screen.findByTestId('setup-committee-fingerprint');
    const reassembled = groupImgs(box)
      .map((g) => g.textContent)
      .join('');
    expect(reassembled).toBe(EXPECTED_FP); // byte-identical recovery (F-172)
    // The error panel is gone and focus was moved to the lead (not lost to body).
    expect(screen.queryByTestId('setup-committee-waiting-error')).toBeNull();
    await waitFor(() =>
      expect(
        (document.activeElement as HTMLElement | null)?.classList.contains(
          'setup-committee-waiting-lead'
        )
      ).toBe(true)
    );
  });
});
