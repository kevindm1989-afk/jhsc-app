/**
 * F-VAL-1(b) Finding 1 (security + adversarial re-review, 2026-07-17) — the
 * UNLATCHED fetch-then-install resurrection site the wipe-generation latch
 * MISSED. `wrapMemberInViaProduction` (`crypto/production-flows.ts`) is a 7th
 * fetch-then-install path, and — unlike the 6 concerns/reprisal read+seal sites
 * closed at commit a655e60 — it has NO wipe-generation latch on its Step-1
 * unwrap → install window.
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE DEFECT (why this is WORSE than the read-path class)
 * ───────────────────────────────────────────────────────────────────────────
 * With an EMPTY holder, `wrapMemberInViaProduction` takes the
 * `if (!holder.hasLiveKey())` Step-1 branch (production-flows.ts:755):
 *
 *   :758  unwrapped = await unwrapCommitteeDataKeyViaProduction(...)   // FETCH
 *                       └─ dispatches committee_key_state, then get_key_wrap
 *   :771  holder.set({ data_key: unwrapped.data_key, ... })            // INSTALL
 *
 * A session-end wipe (panic-wipe / HTTP 401 / sign-out / page-unload) that lands
 * DURING the :758 unwrap await empties the holder AND advances the monotonic
 * `wipeGeneration()` latch (wipe() advances it even on an EMPTY holder). But the
 * resuming `holder.set()` at :771 does NOT re-check that latch — so it
 * RESURRECTS the live committee data key on a holder the session just wiped.
 *
 * This is strictly worse than the concerns/reprisal read-path resurrections:
 * the op does not merely re-cache the key for local reads — it then
 * `crypto_box_seal`s that resurrected key (:873) and POSTs a fresh wrap
 * OFF-DEVICE (:887, op `wrap_member`). A key that a session-end wipe was
 * supposed to destroy is re-materialised and shipped off the device.
 *
 * The existing F-190 seal-window guard (production-flows.ts:850,
 * `!holder.hasLiveKey()` before the seal) does NOT cover this: it guards the
 * LATER seal window, AFTER the :771 install has already resurrected the holder —
 * so `hasLiveKey()` is TRUE again by the time that guard runs. The EARLIER :758
 * unwrap window is unlatched.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE INVARIANT (load-bearing): a session-end wipe that lands during the Step-1
 * unwrap fetch must FAIL THE GRANT CLOSED — the holder stays empty (NOT
 * resurrected) and NO wrap is sealed / POSTed off-device.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * RED today: the holder is resurrected (`isPopulated() === true`) and a wrap is
 * POSTed. GREEN once the implementer snapshots `wipeGeneration()` before the
 * :758 unwrap and re-checks it before the :771 `holder.set()`, abandoning the
 * install (fail closed to `data_key_unwrap_failed`) when it advanced.
 *
 * DETERMINISM: the wipe is injected WITHOUT timers / real network / RNG-derived
 * timing. A transport hook fires the session-end wipe SYNCHRONOUSLY inside the
 * `get_key_wrap` handler while the composition is suspended at the :758 await —
 * strictly before the resurrecting :771 `holder.set()` and before any
 * `wrap_member` POST. Same deterministic-injection discipline as the
 * established mid-fetch tests; passes at any wall-clock time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import {
  BrowserLocalIdentityStore,
  CommitteeKeyHolder,
  SupabaseT07Client,
  pubkeyFingerprint,
  wrapMemberInViaProduction,
  type T07OpTransport
} from '../../src/lib/crypto';
import { __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

await _sodium.ready;
const sodium = _sodium;

const ACTOR = '9f4e9b40-0000-4000-8000-00000000001a'; // SYNTHETIC_USER_COCHAIR
const TARGET = '9f4e9b40-0000-4000-8000-00000000002b'; // SYNTHETIC_USER_MEMBER

function bytesToPgHex(b: Uint8Array): string {
  let s = '\\x';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
}

function pgHexToBytes(h: string): Uint8Array {
  const body = h.startsWith('\\x') ? h.slice(2) : h;
  return new Uint8Array(body.match(/.{1,2}/g)!.map((x) => parseInt(x, 16)));
}

function silentStore(): BrowserLocalIdentityStore {
  return new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
}

interface FakeKeyServer {
  liveKeyId: string;
  liveEpoch: number;
  actorHasWrap: boolean;
  actorWrapBytes: Uint8Array | null;
  actorDataKey: Uint8Array | null;
  wrapPosted:
    | null
    | { member_user_id: string; key_id: string; sealed_hex: string; rotation_id: string | null };
}

function newServer(): FakeKeyServer {
  return {
    liveKeyId: 'k-live-1',
    liveEpoch: 7,
    actorHasWrap: true,
    actorWrapBytes: null,
    actorDataKey: null,
    wrapPosted: null
  };
}

/**
 * Seed the actor's holder-side state: keypair for the ACTOR, device-local
 * privkey, the 32-byte data-key oracle, and its actor-sealed wrap (so the
 * Step-1 holder-unwrap path can open it and would populate the holder).
 */
async function seedActor(
  srv: FakeKeyServer,
  localIdentity: BrowserLocalIdentityStore
): Promise<{ pub: Uint8Array; priv: Uint8Array; dataKey: Uint8Array }> {
  const kp = sodium.crypto_box_keypair();
  await localIdentity.storeIdentityPrivateKey(ACTOR, kp.privateKey);
  const dataKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  srv.actorDataKey = dataKey;
  srv.actorWrapBytes = sodium.crypto_box_seal(dataKey, kp.publicKey);
  return { pub: kp.publicKey, priv: kp.privateKey, dataKey };
}

/**
 * A valid pre-disclosed `{public_key, fingerprint}` (real SHA-256 fingerprint,
 * so the composition's self-consistency re-derivation matches). Returns the
 * private half so a POSTed sealed box can be opened as a behavioural proof.
 */
async function makeDisclosed(): Promise<{
  disclosed: { public_key: Uint8Array; fingerprint: string };
  priv: Uint8Array;
}> {
  const kp = sodium.crypto_box_keypair();
  const fingerprint = await pubkeyFingerprint(kp.publicKey);
  return { disclosed: { public_key: kp.publicKey, fingerprint }, priv: kp.privateKey };
}

/**
 * The mock t07-op transport. `hooks.onGetKeyWrap` — when set — fires
 * SYNCHRONOUSLY inside the `get_key_wrap` handler (i.e. while the composition is
 * suspended at the Step-1 unwrap await), the deterministic mid-fetch injection
 * seam this suite uses to land a session-end wipe strictly before the :771
 * resurrecting `holder.set()`.
 */
function makeTransport(
  srv: FakeKeyServer,
  hooks: { onGetKeyWrap?: () => void } = {}
): { transport: T07OpTransport; ops: string[] } {
  const ops: string[] = [];
  const transport: T07OpTransport = async (body) => {
    ops.push(String(body.op));
    switch (body.op) {
      case 'committee_key_state':
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              key_id: srv.liveKeyId,
              epoch: srv.liveEpoch,
              wrap_count: srv.actorHasWrap ? 1 : 0,
              actor_has_wrap: srv.actorHasWrap
            }
          }
        };
      case 'get_key_wrap': {
        // Deterministic mid-fetch injection: fire the session-end wipe WHILE the
        // Step-1 disclosure fetch is in flight. The composition is parked on the
        // `await unwrapCommitteeDataKeyViaProduction(...)` at :758, so this lands
        // strictly BEFORE the resurrecting `holder.set()` at :771 (and before any
        // `wrap_member` POST). We still return a valid wrap so the unwrap resolves
        // `ok` — which is exactly what drives the :771 resurrection attempt.
        hooks.onGetKeyWrap?.();
        if (!srv.actorWrapBytes) return { status: 200, body: { ok: true, data: null } };
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              key_id: srv.liveKeyId,
              epoch: srv.liveEpoch,
              wrapped_ciphertext_hex: bytesToPgHex(srv.actorWrapBytes)
            }
          }
        };
      }
      case 'wrap_member': {
        srv.wrapPosted = {
          member_user_id: String(body.member_user_id),
          key_id: String(body.key_id),
          sealed_hex: String(body.wrapped_ciphertext_hex),
          rotation_id: (body.rotation_id as string | null) ?? null
        };
        return { status: 200, body: { ok: true, data: null } };
      }
      default:
        throw new Error(`makeTransport: unexpected op ${String(body.op)}`);
    }
  };
  return { transport, ops };
}

/** The two session-end triggers exercised as separate cases (both route to wipe()). */
const TRIGGERS: Array<{ label: string; fire: (h: CommitteeKeyHolder) => void }> = [
  { label: 'onPanicWipe (panic-wipe / lock-screen)', fire: (h) => h.onPanicWipe() },
  { label: 'onSessionRevoked (HTTP 401 / session revocation)', fire: (h) => h.onSessionRevoked() }
];

beforeEach(() => {
  __resetCapture();
  __setTestSink();
});

afterEach(() => {
  __resetCapture();
  vi.restoreAllMocks();
});

// ===========================================================================
// F-VAL-1(b) Finding 1 — a session-end wipe DURING the Step-1 unwrap fetch must
// NOT resurrect the holder and must NOT seal + POST a wrap off-device.
// ===========================================================================

describe('F-VAL-1(b) Finding 1 / wrapMemberInViaProduction — a mid-Step-1-unwrap session-end wipe must fail closed, never resurrect + POST off-device', () => {
  for (const trig of TRIGGERS) {
    it(`${trig.label}: a wipe landing during the get_key_wrap fetch neither resurrects the holder nor POSTs a wrap`, async () => {
      const srv = newServer();

      // Determinism-guard capture — snapshot state at the instant the wipe fires.
      let wipeCalls = 0;
      const guard = { holderEmptyAtWipe: false, wrapNotYetPostedAtWipe: false, genAtWipe: -1 };

      const hooks: { onGetKeyWrap?: () => void } = {};
      const { transport, ops } = makeTransport(srv, hooks);
      const localIdentity = silentStore();
      const client = new SupabaseT07Client({ transport, localIdentity });
      await seedActor(srv, localIdentity);
      const { disclosed, priv: disclosedPriv } = await makeDisclosed();

      // Start from an EMPTY holder → wrapMemberIn takes the `!hasLiveKey()`
      // Step-1 unwrap branch (:755) whose await is the unlatched window.
      const holder = new CommitteeKeyHolder();
      expect(holder.isPopulated(), 'precondition: the holder starts empty').toBe(false);
      expect(holder.hasLiveKey(), 'precondition: no live key at entry').toBe(false);
      expect(holder.wipeGeneration(), 'precondition: the wipe latch starts at 0').toBe(0);

      hooks.onGetKeyWrap = () => {
        wipeCalls += 1;
        // At this instant the composition is parked on the :758 unwrap await:
        // the holder has NOT yet been re-installed (:771) and the off-device
        // wrap_member POST has NOT been dispatched.
        guard.holderEmptyAtWipe = !holder.isPopulated();
        guard.wrapNotYetPostedAtWipe = !ops.includes('wrap_member');
        trig.fire(holder); // session-end wipe (advances wipeGeneration, even empty)
        guard.genAtWipe = holder.wipeGeneration();
      };

      const sealSpy = vi.spyOn(sodium, 'crypto_box_seal');

      const r = await wrapMemberInViaProduction({
        client,
        holder,
        localIdentity,
        user_id: ACTOR,
        target_user_id: TARGET,
        disclosed
      });

      // ---- Determinism guard: prove the wipe genuinely landed mid-unwrap ----
      expect(
        wipeCalls,
        'determinism: the injected session-end wipe hook never fired during the get_key_wrap fetch'
      ).toBe(1);
      expect(
        guard.holderEmptyAtWipe,
        'determinism: at wipe time the holder was already populated — the wipe did not land in the pre-:771-set() unwrap window'
      ).toBe(true);
      expect(
        guard.wrapNotYetPostedAtWipe,
        'determinism: at wipe time the wrap_member POST had already been dispatched — the wipe did not land during the Step-1 unwrap fetch'
      ).toBe(true);
      expect(
        guard.genAtWipe,
        'determinism: wipe() did not advance the monotonic wipe-generation latch (an empty-holder wipe must still tick it)'
      ).toBe(1);

      // Behavioural assertions use expect.soft so a SINGLE red run surfaces BOTH
      // failure modes together — the resurrection AND the off-device POST — for
      // maximal diagnosability. (Soft assertions are deterministic reporting, not
      // retries: every one is evaluated exactly once and the test fails at the end
      // if any did.) The determinism guards above stay HARD preconditions.

      // ---- (a) the holder is NOT resurrected ----
      expect.soft(
        holder.isPopulated(),
        `F-VAL-1(b) Finding 1: the holder was RESURRECTED — a session-end wipe (${trig.label}) ` +
          'landed during the Step-1 get_key_wrap fetch (:758), yet the resuming holder.set() at ' +
          'production-flows.ts:771 re-installed the live committee data key on the just-wiped ' +
          'holder. The :758 unwrap window has no wipe-generation latch.'
      ).toBe(false);
      expect.soft(
        holder.hasLiveKey(),
        `F-VAL-1(b) Finding 1: a LIVE sealing key was resurrected after a session-end wipe (${trig.label})`
      ).toBe(false);
      expect.soft(
        holder.getDataKey(),
        'F-VAL-1(b) Finding 1: a live committee data-key buffer is readable after the wipe (resurrected)'
      ).toBeNull();
      // The latch must still read exactly 1 at the end (no second wipe, no reset).
      expect.soft(
        holder.wipeGeneration(),
        'the wipe-generation latch must remain at 1 (the single session-end wipe)'
      ).toBe(1);

      // ---- (b) the grant fails closed — no off-device wrap POST ----
      expect.soft(
        r.status,
        `F-VAL-1(b) Finding 1: the grant SUCCEEDED after a mid-unwrap session-end wipe (${trig.label}); ` +
          'it must fail closed rather than seal + POST a resurrected key off-device'
      ).toBe('failed');
      if (r.status === 'failed') {
        expect.soft(
          r.reason,
          'a mid-unwrap wipe must map to the fail-closed data_key_unwrap_failed reason (the sibling of the F-190 seal-window guard)'
        ).toBe('data_key_unwrap_failed');
      }
      expect.soft(
        srv.wrapPosted,
        `F-VAL-1(b) Finding 1: a fresh wrap was crypto_box_seal'd from the RESURRECTED committee ` +
          `data key and POSTed OFF-DEVICE after a session-end wipe (${trig.label}) — the key that a ` +
          'session-end wipe was supposed to destroy left the device (worse than a local read-path resurrection).'
      ).toBeNull();
      expect.soft(
        ops,
        'no wrap_member op may be dispatched after a mid-unwrap session-end wipe'
      ).not.toContain('wrap_member');
      expect.soft(
        sealSpy,
        'crypto_box_seal must not run on a key resurrected after a session-end wipe'
      ).toHaveBeenCalledTimes(0);

      // Extra RED diagnostic: if a wrap DID escape, prove it carries a NON-ZERO
      // live committee data key (opens with the disclosed private half) — naming
      // the exact leak: a session-end-wiped key resurrected, sealed, and shipped.
      if (srv.wrapPosted) {
        const sealed = pgHexToBytes(srv.wrapPosted.sealed_hex);
        const opened = sodium.crypto_box_seal_open(sealed, disclosed.public_key, disclosedPriv);
        expect.soft(
          Array.from(opened).some((b) => b !== 0),
          'F-VAL-1(b) Finding 1: the off-device wrap opens to a NON-ZERO live committee data key — ' +
            'a session-end-wiped key was resurrected, sealed, and shipped off-device'
        ).toBe(false);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Positive control — the harness admits the happy path. A normal grant from
  // an EMPTY holder (Step-1 unwrap runs, NO mid-await wipe) still populates,
  // seals, and POSTs the wrap. Stays GREEN before AND after the latch lands
  // (entry snapshot == install-time snapshot ⇒ install proceeds).
  // -------------------------------------------------------------------------
  it('positive control: an unraced grant from an empty holder unwraps, populates, and POSTs the wrap', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv); // no onGetKeyWrap hook
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const actor = await seedActor(srv, localIdentity);
    const { disclosed, priv: disclosedPriv } = await makeDisclosed();

    const holder = new CommitteeKeyHolder();
    expect(holder.isPopulated()).toBe(false);

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed
    });

    // The grant completed.
    expect(r).toEqual({ status: 'ok' });
    // Step-1 fallback ran and the holder is now populated (unwrap side effect).
    expect(ops).toContain('committee_key_state');
    expect(ops).toContain('get_key_wrap');
    expect(ops).toContain('wrap_member');
    expect(holder.isPopulated()).toBe(true);
    expect(holder.hasLiveKey()).toBe(true);
    // No wipe happened → the latch never ticked.
    expect(holder.wipeGeneration()).toBe(0);
    // The wrap landed for the right target + live key, and opens to the data key.
    expect(srv.wrapPosted).not.toBeNull();
    expect(srv.wrapPosted?.member_user_id).toBe(TARGET);
    expect(srv.wrapPosted?.key_id).toBe(srv.liveKeyId);
    const opened = sodium.crypto_box_seal_open(
      pgHexToBytes((srv.wrapPosted as { sealed_hex: string }).sealed_hex),
      disclosed.public_key,
      disclosedPriv
    );
    expect(Array.from(opened)).toEqual(Array.from(actor.dataKey));
  });
});
