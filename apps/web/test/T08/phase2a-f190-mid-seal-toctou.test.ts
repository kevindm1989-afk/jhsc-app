/**
 * F-190 (T/I, ELEVATED 2026-07-15) — mid-seal liveness TOCTOU on
 * `submitConcernViaProduction` (threat-model §3.18 Amendment A-8.10-R2,
 * F-190 entry ~:4410, Finding-2 block ~:4420, re-pass trigger #13 ~:4439).
 *
 * RED-FIRST (TDD): written to FAIL against the CURRENT worktree code and pass
 * ONLY once the implementer resolves `ready()` FIRST, re-checks liveness, then
 * RE-READs `getDataKey()` and seals SYNCHRONOUSLY. The implementer treats this
 * file as READ-ONLY; do not relax the assertions.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE DEFECT (confirmed on this worktree)
 * ───────────────────────────────────────────────────────────────────────────
 * `submitConcernViaProduction` captures the live data-key buffer BY REFERENCE
 * (`concerns/production-flows.ts:274` — `const dataKey = keyHolder.getDataKey()`),
 * null-checks it ONCE (:275), then `await sealUtf8(intake.title, dataKey)` (:288).
 * `sealUtf8` does `const s = await ready()` (`concerns/seal.ts:47`) BEFORE the
 * synchronous `crypto_secretbox_easy(ptBytes, nonce, key)` (:56). That internal
 * `await` is a TOCTOU window: a concurrent event that zeroes the captured buffer
 * BY REFERENCE during the `await` makes the resuming secretbox seal under an
 * ALL-ZERO key → a world-readable ciphertext is POSTed. There is NO liveness
 * re-check before the primitive (contrast `crypto/production-flows.ts:842-852`,
 * `wrapMemberInViaProduction`, which at least re-checks `hasLiveKey()`).
 *
 * TWO triggers, one per test:
 *   (a) SESSION-END WIPE — a panic / 401 / page-unload fires `wipe()` mid-await
 *       (here via `onSessionRevoked()`), zeroing the captured buffer.
 *   (b) ROTATION-OBSERVING SELF-HEAL `populate([...fresh])` — a concurrent op
 *       observes a rotation and installs FRESH buffers; F-145-C's
 *       `#wipeOrphanedBuffers` zeroes the orphaned captured buffer. NOTE: a
 *       boolean `hasLiveKey()` re-check does NOT catch (b) — post-`populate()`
 *       `hasLiveKey()` is TRUE while the captured buffer is zeroed — which is why
 *       the fix must RE-READ `getDataKey()` (Finding-2(b) / re-pass trigger #13).
 *
 * THE INVARIANT (load-bearing): NO ciphertext openable under an all-zero key is
 * ever POSTed. Acceptable outcomes: a typed failure with NO POST, OR a POST
 * whose ciphertext seals under a REAL live key (opaque to the zero key).
 *
 * DETERMINISM: the race is forced WITHOUT timers/network/RNG-assertions. A
 * `getDataKey()`-override subclass schedules the trigger on a `queueMicrotask`
 * at the capture point; that microtask (queued before any await-continuation)
 * runs FIFO at the FIRST suspension — the seal's `await ready()` — strictly
 * before the synchronous secretbox. Same proven mechanism as the ADV-2 test in
 * `test/T07/wrap-member-in-production.test.ts`. Passes at any wall-clock time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import {
  BrowserLocalIdentityStore,
  CommitteeKeyHolder,
  SupabaseT07Client,
  type T07OpTransport
} from '../../src/lib/crypto';
import {
  SupabaseConcernClient,
  type ConcernOpTransport
} from '../../src/lib/concerns/supabase-concern-client';
import { submitConcernViaProduction } from '../../src/lib/concerns/production-flows';
import { openUtf8 } from '../../src/lib/concerns/seal';
import { __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
import { pgHexToBytes } from '../../src/lib/server-client/pg-hex';

await _sodium.ready;
const sodium = _sodium;

const USER = '9f4e9b40-0000-4000-8000-00000000001a'; // SYNTHETIC_USER_COCHAIR

function silentStore(): BrowserLocalIdentityStore {
  return new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
}

function bytesToPgHexLocal(b: Uint8Array): string {
  let s = '\\x';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
}

interface FakeKeyServer {
  liveKeyId: string;
  liveEpoch: number;
  actorHasWrap: boolean;
  liveWrap: Uint8Array | null;
  plaintextKey: Uint8Array | null;
}

function newServer(): FakeKeyServer {
  return {
    liveKeyId: 'k-live-1',
    liveEpoch: 3,
    actorHasWrap: true,
    liveWrap: null,
    plaintextKey: null
  };
}

function seedWrap(srv: FakeKeyServer, pub: Uint8Array): Uint8Array {
  const plaintext = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  srv.plaintextKey = plaintext;
  srv.liveWrap = sodium.crypto_box_seal(plaintext, pub);
  return plaintext;
}

function makeT07Transport(srv: FakeKeyServer): { transport: T07OpTransport; ops: string[] } {
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
        if (!srv.liveWrap) return { status: 200, body: { ok: true, data: null } };
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              key_id: srv.liveKeyId,
              epoch: srv.liveEpoch,
              wrapped_ciphertext_hex: bytesToPgHexLocal(srv.liveWrap)
            }
          }
        };
      default:
        throw new Error(`makeT07Transport: unexpected op ${String(body.op)}`);
    }
  };
  return { transport, ops };
}

interface ConcernResponse {
  status: number;
  body: unknown;
}

function makeConcernTransport(queue: ConcernResponse[]): {
  transport: ConcernOpTransport;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  let i = 0;
  const transport: ConcernOpTransport = async (body) => {
    bodies.push(body);
    const r = queue[i++];
    if (!r) throw new Error(`makeConcernTransport: no response queued (call #${i})`);
    return { status: r.status, body: r.body };
  };
  return { transport, bodies };
}

/**
 * A `CommitteeKeyHolder` that fires ONE armed trigger the first time
 * `getDataKey()` is read — on a `queueMicrotask` so it lands inside the seal's
 * `await` window, strictly before the synchronous secretbox. Arm-ONCE: a
 * fixed re-read of `getDataKey()` after the liveness re-check does NOT re-arm.
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

async function buildWired() {
  const srv = newServer();
  const t07 = makeT07Transport(srv);
  const localIdentity = silentStore();
  const t07Client = new SupabaseT07Client({ transport: t07.transport, localIdentity });
  const kp = sodium.crypto_box_keypair();
  await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
  const plaintextKey = seedWrap(srv, kp.publicKey);
  const keyHolder = new MidSealRaceHolder();
  keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
  return { srv, t07, localIdentity, t07Client, keyHolder, kp, plaintextKey };
}

/**
 * THE load-bearing F-190 assertion: no POSTed ciphertext is openable under an
 * all-zero key. `openUtf8` fails-closed (AEAD MAC) for a real-key seal; it
 * RESOLVES only when the bytes were genuinely sealed under zeros — the exact
 * world-readable disclosure F-190 forbids.
 */
async function expectNoZeroKeyCiphertextPosted(bodies: Record<string, unknown>[]): Promise<void> {
  const ZERO_KEY = new Uint8Array(32);
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];
    for (const field of ['title_ct', 'body_ct', 'source_name_ct'] as const) {
      const v = body[field];
      if (typeof v !== 'string' || !v.startsWith('\\x')) continue;
      const bytes = pgHexToBytes(v);
      let openedUnderZeroKey: string | null = null;
      try {
        openedUnderZeroKey = await openUtf8(bytes, ZERO_KEY);
      } catch {
        openedUnderZeroKey = null; // sealed under a REAL key — opaque to zeros (good).
      }
      expect(
        openedUnderZeroKey,
        `F-190 mid-seal TOCTOU: POSTed body #${i} field \`${field}\` is openable under an ` +
          `ALL-ZERO key → "${openedUnderZeroKey ?? ''}". A wipe/populate zeroed the captured ` +
          `data-key buffer during the seal's \`await\`, and the resuming secretbox sealed under ` +
          `zeros (world-readable). The seal path must re-read getDataKey() after a liveness ` +
          `re-check and seal synchronously.`
      ).toBeNull();
    }
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

// ===========================================================================
// F-190 trigger (a) — a SESSION-END WIPE mid-seal must not POST a zero-key seal
// ===========================================================================

describe('F-190 / submitConcernViaProduction — session-end WIPE during the seal await', () => {
  it('a mid-seal onSessionRevoked() (401/panic/unload class) must NOT POST a ciphertext openable under an all-zero key', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    // The submit succeeds at the wire IF the composition reaches the POST; an
    // empty queue would throw, so we queue one 200 to let a (buggy) zero-key
    // POST land and be inspected.
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: { id: 'c-a' } } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    // Arm: the first getDataKey() read (the capture at :274) schedules a wipe on
    // the next microtask — it lands inside `sealUtf8`'s `await ready()` gap.
    keyHolder.armOnFirstDataKeyRead(() => keyHolder.onSessionRevoked());

    const r = await submitConcernViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: {
        title: 'F190-WIPE-CANARY-TITLE',
        body: 'F190-WIPE-CANARY-BODY',
        hazard_class: 'physical',
        severity: 'high',
        location_id: 'L-1',
        anonymous: true
      }
    });

    // Determinism guard — the mid-await trigger genuinely fired: the captured
    // live buffer (== plaintextKey by reference) was zeroed by the wipe.
    expect(
      Array.from(plaintextKey).every((b) => b === 0),
      'race was not exercised: the captured data-key buffer was never zeroed mid-seal'
    ).toBe(true);

    // THE invariant: no all-zero-key ciphertext reached the wire.
    await expectNoZeroKeyCiphertextPosted(concern.bodies);

    // Outcome coherence: a wipe leaves NO live key, so the correct behavior is a
    // typed failure with NO seal POST. If the composition posted a seal at all,
    // the invariant above already proves it was not a zero-key seal.
    const postedASeal = concern.bodies.some(
      (b) => typeof b.title_ct === 'string' || typeof b.body_ct === 'string'
    );
    if (!postedASeal) {
      expect(['session_expiry', 'failed']).toContain(r.status);
    }
  });
});

// ===========================================================================
// F-190 Finding-2 trigger (b) — a rotation-observing SELF-HEAL populate() mid-
// seal must not POST a zero-key seal. A boolean hasLiveKey() re-check is
// INSUFFICIENT here (post-populate it is TRUE) — the fix must RE-READ getDataKey().
// ===========================================================================

describe('F-190 Finding-2 / submitConcernViaProduction — rotation self-heal populate() during the seal await', () => {
  it('a mid-seal populate([...fresh]) that orphans (zeroes) the captured buffer must NOT POST a ciphertext openable under an all-zero key', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: { id: 'c-b' } } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    // The fresh live buffer a concurrent rotation self-heal would install. It is
    // a DISTINCT object, so F-145-C's identity-compare orphan-wipe zeroes the
    // captured original while hasLiveKey() stays TRUE.
    const freshLiveKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    keyHolder.armOnFirstDataKeyRead(() =>
      keyHolder.populate([{ data_key: freshLiveKey, key_id: 'k-live-2', epoch: 4, is_live: true }])
    );

    const r = await submitConcernViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: {
        title: 'F190-POPULATE-CANARY-TITLE',
        body: 'F190-POPULATE-CANARY-BODY',
        hazard_class: 'physical',
        severity: 'high',
        location_id: 'L-1',
        anonymous: true
      }
    });

    // Determinism guard — the self-heal genuinely fired: the ORPHANED original
    // buffer is zeroed (F-145-C) while the holder still has a live key.
    expect(
      Array.from(plaintextKey).every((b) => b === 0),
      'race was not exercised: the orphaned captured buffer was never zeroed by populate()'
    ).toBe(true);
    expect(keyHolder.hasLiveKey(), 'post-populate the holder still reports a live key').toBe(true);

    // THE invariant: no all-zero-key ciphertext reached the wire.
    await expectNoZeroKeyCiphertextPosted(concern.bodies);

    // Outcome coherence: a correct fix RE-READs getDataKey() → seals under the
    // FRESH live key. If it posted, the ciphertext must open under freshLiveKey
    // (a real key), never under zeros (already asserted above).
    if (r.status === 'ok') {
      const submitBody = concern.bodies[0] as { title_ct?: string; body_ct?: string };
      expect(typeof submitBody.title_ct).toBe('string');
      await expect(openUtf8(pgHexToBytes(submitBody.title_ct as string), freshLiveKey)).resolves.toBe(
        'F190-POPULATE-CANARY-TITLE'
      );
    }
  });
});
