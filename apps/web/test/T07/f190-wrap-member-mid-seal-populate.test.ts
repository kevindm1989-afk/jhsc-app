/**
 * F-190 Finding-2 (T/I, ELEVATED 2026-07-15) — the rotation-observing self-heal
 * `populate()` mid-seal TOCTOU applied to `wrapMemberInViaProduction`
 * (threat-model §3.18 Amendment A-8.10-R2, F-190 entry ~:4410, Finding-2 block
 * ~:4420, re-pass trigger #13 ~:4439).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE EXISTING GUARD IS INSUFFICIENT (the smoking gun)
 * ───────────────────────────────────────────────────────────────────────────
 * `wrapMemberInViaProduction` (`crypto/production-flows.ts`) captures the live
 * data-key buffer BY REFERENCE at :792 (`const dataKey = holder.getDataKey()`),
 * then `await`s (`pubkeyFingerprint(...)` :826, `ready()` :842), then re-checks
 * `holder.hasLiveKey()` :849 before the synchronous `crypto_box_seal(dataKey,
 * targetPubkey)` :852. That boolean re-check catches a session-END WIPE (covered
 * by the ADV-2 test in `wrap-member-in-production.test.ts`) — but it does NOT
 * catch a rotation-observing self-heal `populate([...fresh])`: after `populate()`,
 * `hasLiveKey()` is TRUE (a fresh live buffer exists) while the CAPTURED `dataKey`
 * reference (:792) has been ZEROED by F-145-C's identity-compare
 * `#wipeOrphanedBuffers`. The re-check PASSES and `crypto_box_seal` then seals
 * the all-zero captured buffer → a WORLD-READABLE distributed wrap.
 *
 * THE FIX this test forces: after the liveness re-check, RE-READ `getDataKey()`
 * (fetch the CURRENT live buffer afresh, never reuse the captured reference) and
 * seal that. So this test is RED against the current code AND against the
 * insufficient boolean-only re-check; it goes GREEN only once the composition
 * re-reads getDataKey() here too.
 *
 * THE INVARIANT (load-bearing): the distributed wrap that reaches the server is
 * NOT `crypto_box_seal` of an all-zero data key.
 *
 * DETERMINISM: forced WITHOUT timers/network/RNG-assertions via a
 * `getDataKey()`-override subclass that schedules the `populate()` on a
 * microtask, landing inside the `await pubkeyFingerprint(...)` / `await ready()`
 * gap strictly before the synchronous `crypto_box_seal`. Same mechanism as the
 * ADV-2 wipe test in `wrap-member-in-production.test.ts`. Passes at any
 * wall-clock time.
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
  serverTargetPubkey: Uint8Array | null;
  serverTargetFingerprint: string | null;
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
    serverTargetPubkey: null,
    serverTargetFingerprint: null,
    wrapPosted: null
  };
}

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

function seedServerTarget(srv: FakeKeyServer): void {
  const kp = sodium.crypto_box_keypair();
  srv.serverTargetPubkey = kp.publicKey;
  srv.serverTargetFingerprint = sodium.to_hex(sodium.crypto_generichash(32, kp.publicKey));
}

async function makeDisclosed(): Promise<{
  disclosed: { public_key: Uint8Array; fingerprint: string };
  priv: Uint8Array;
}> {
  const kp = sodium.crypto_box_keypair();
  const fingerprint = await pubkeyFingerprint(kp.publicKey);
  return { disclosed: { public_key: kp.publicKey, fingerprint }, priv: kp.privateKey };
}

function makeTransport(srv: FakeKeyServer): { transport: T07OpTransport; ops: string[] } {
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
      case 'get_key_wrap':
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

/**
 * A `CommitteeKeyHolder` that fires ONE armed trigger the first time
 * `getDataKey()` is read — on a `queueMicrotask` so it lands inside the seal's
 * `await` window (pubkeyFingerprint / ready) strictly before `crypto_box_seal`.
 * Arm-ONCE: a fixed re-read of `getDataKey()` after the liveness re-check does
 * NOT re-arm, so the fix's re-read fetches the FRESH buffer cleanly.
 */
class MidSealRaceHolder extends CommitteeKeyHolder {
  #armed = false;
  #trigger: (() => void) | null = null;
  armOnFirstDataKeyRead(trigger: () => void): void {
    this.#armed = true;
    this.#trigger = trigger;
  }
  override getDataKey(): Uint8Array | null {
    const k = super.getDataKey();
    if (this.#armed && this.#trigger) {
      this.#armed = false;
      const t = this.#trigger;
      this.#trigger = null;
      queueMicrotask(t);
    }
    return k;
  }
}

beforeEach(() => {
  __resetCapture();
  __setTestSink();
});

afterEach(() => {
  __resetCapture();
  vi.restoreAllMocks();
});

describe('F-190 Finding-2 / wrapMemberInViaProduction — rotation self-heal populate() during the seal window', () => {
  it('a mid-seal populate([...fresh]) that orphans (zeroes) the captured data key must NOT distribute a wrap that is crypto_box_seal of an all-zero key', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const actor = await seedActor(srv, localIdentity);
    seedServerTarget(srv);
    const { disclosed, priv: disclosedPriv } = await makeDisclosed();

    const holder = new MidSealRaceHolder();
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    // The fresh live buffer a concurrent rotation self-heal would install. It is
    // a DISTINCT object, so F-145-C's identity-compare orphan-wipe zeroes the
    // captured original (actor.dataKey) while hasLiveKey() stays TRUE — defeating
    // the boolean-only re-check at :849.
    const freshLiveKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    holder.armOnFirstDataKeyRead(() =>
      holder.populate([{ data_key: freshLiveKey, key_id: 'k-live-2', epoch: 8, is_live: true }])
    );

    const sealSpy = vi.spyOn(sodium, 'crypto_box_seal');

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed
    });

    // Determinism guard — the self-heal genuinely fired mid-seal: the orphaned
    // ORIGINAL captured buffer is zeroed (F-145-C) while the holder still reports
    // a live key (so the boolean :849 re-check would NOT abort).
    expect(
      Array.from(actor.dataKey).every((b) => b === 0),
      'race was not exercised: the orphaned captured buffer was never zeroed by populate()'
    ).toBe(true);
    expect(holder.hasLiveKey(), 'post-populate the holder still reports a live key').toBe(true);

    // THE invariant: the distributed wrap is NOT a seal of an all-zero data key.
    // If a wrap was POSTed, open it with the disclosed private half and require
    // the recovered data key to be non-zero (i.e. the FRESH live key, never the
    // zeroed captured buffer). If NO wrap was POSTed, the composition typed-failed
    // safely — also acceptable.
    if (srv.wrapPosted) {
      const sealed = pgHexToBytes(srv.wrapPosted.sealed_hex);
      const opened = sodium.crypto_box_seal_open(sealed, disclosed.public_key, disclosedPriv);
      expect(
        Array.from(opened).some((b) => b !== 0),
        'F-190 Finding-2: the distributed wrap is crypto_box_seal of an ALL-ZERO data key ' +
          '(world-readable). A rotation self-heal populate() zeroed the captured buffer mid-seal ' +
          'and the boolean hasLiveKey() re-check let it seal under zeros — the guard must RE-READ ' +
          'getDataKey() after the liveness re-check.'
      ).toBe(true);
      // A correct fix re-reads getDataKey() → seals the FRESH live key. Prove it
      // recovers exactly freshLiveKey (never actor.dataKey, which is now zeros).
      expect(Array.from(opened)).toEqual(Array.from(freshLiveKey));
      // F-190 Finding-1 / re-pass trigger #13: a distributed wrap must NEVER
      // straddle a rotation — the (key_id, ciphertext-epoch) pair MUST be
      // consistent. The seal above re-read getDataKey() and sealed the FRESH
      // (k-live-2, epoch 8) buffer, but the POSTed key_id is captured BEFORE the
      // awaits (production-flows.ts:793) and still reads the STALE, pre-rotation
      // 'k-live-1' → an epoch-mislabeled wrap (F-183-class anti-lockout hazard).
      // The fix must re-read getKeyId() ATOMICALLY with getDataKey() after the
      // liveness re-check and POST the fresh key_id so the label matches the
      // sealed epoch.
      expect(srv.wrapPosted.key_id).toBe('k-live-2');
    } else {
      expect(r.status).toBe('failed');
      expect(ops).not.toContain('wrap_member');
      // Sanity: a seal of the zeroed captured buffer must not have happened either.
      const zeroSeal = sealSpy.mock.calls.some((call) => {
        const arg0 = call[0] as Uint8Array;
        return arg0 instanceof Uint8Array && arg0.length === 32 && arg0.every((b) => b === 0);
      });
      expect(zeroSeal, 'crypto_box_seal was called on an all-zero data key').toBe(false);
    }
  });
});
