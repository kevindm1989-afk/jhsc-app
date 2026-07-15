/**
 * F-190 (T/I, ELEVATED 2026-07-15) — mid-seal liveness TOCTOU on the reprisal
 * seal paths `submitReprisalViaProduction` + `updateReprisalViaProduction`
 * (threat-model §3.18 Amendment A-8.10-R2, F-190 entry ~:4410, Finding-2 block
 * ~:4420, re-pass trigger #13 ~:4439).
 *
 * RED-FIRST (TDD): written to FAIL against the CURRENT worktree code and pass
 * ONLY once the implementer resolves `ready()` FIRST, re-checks liveness, then
 * RE-READs `getDataKey()` and seals SYNCHRONOUSLY. The implementer treats this
 * file as READ-ONLY; do not relax the assertions.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE DEFECT (confirmed on this worktree)
 * ───────────────────────────────────────────────────────────────────────────
 *   - submitReprisalViaProduction (`reprisal/production-flows.ts:269-282`):
 *       captures `dataKey = keyHolder.getDataKey()` (:269), null-checks once
 *       (:270), then `await sealUtf8(intake.title, dataKey)` (:281-282). NO
 *       liveness re-check before the synchronous secretbox.
 *   - updateReprisalViaProduction (`reprisal/production-flows.ts:416-427`):
 *       same shape — capture (:416), single null-check (:417), then
 *       `await sealUtf8(title, dataKey)` (:426). NO guard.
 *
 * `sealUtf8`'s internal `const s = await ready()` (`concerns/seal.ts:47`) is the
 * TOCTOU window: a concurrent event that zeroes the captured buffer BY REFERENCE
 * during that `await` makes the resuming `crypto_secretbox_easy` seal under an
 * ALL-ZERO key → a world-readable ciphertext is POSTed.
 *
 * TWO triggers (one per test, per composition):
 *   (a) SESSION-END WIPE — panic / 401 / page-unload zeroes the buffer mid-await.
 *   (b) ROTATION-OBSERVING SELF-HEAL `populate([...fresh])` — F-145-C's
 *       `#wipeOrphanedBuffers` zeroes the orphaned captured buffer while
 *       `hasLiveKey()` stays TRUE (so a boolean re-check does NOT catch it — the
 *       fix must RE-READ getDataKey(); Finding-2(b) / re-pass trigger #13).
 *
 * THE INVARIANT (load-bearing): NO ciphertext openable under an all-zero key is
 * ever POSTed.
 *
 * DETERMINISM: forced WITHOUT timers/network/RNG-assertions via a
 * `getDataKey()`-override subclass that schedules the trigger on a microtask,
 * landing inside the seal's `await ready()` gap strictly before the synchronous
 * secretbox (same mechanism as `test/T07/wrap-member-in-production.test.ts`
 * ADV-2). Passes at any wall-clock time.
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
  SupabaseReprisalClient,
  type ReprisalOpTransport
} from '../../src/lib/reprisal/supabase-reprisal-client';
import {
  submitReprisalViaProduction,
  updateReprisalViaProduction
} from '../../src/lib/reprisal/production-flows';
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

interface ReprisalResponse {
  status: number;
  body: unknown;
}

function makeReprisalTransport(queue: ReprisalResponse[]): {
  transport: ReprisalOpTransport;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  let i = 0;
  const transport: ReprisalOpTransport = async (body) => {
    bodies.push(body);
    const r = queue[i++];
    if (!r) throw new Error(`makeReprisalTransport: no response queued (call #${i})`);
    return { status: r.status, body: r.body };
  };
  return { transport, bodies };
}

/**
 * A `CommitteeKeyHolder` that fires ONE armed trigger the first time
 * `getDataKey()` is read — on a `queueMicrotask` so it lands inside the seal's
 * `await ready()` gap, strictly before the synchronous secretbox. Arm-ONCE: a
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
 * RESOLVES only when the bytes were genuinely sealed under zeros.
 */
async function expectNoZeroKeyCiphertextPosted(bodies: Record<string, unknown>[]): Promise<void> {
  const ZERO_KEY = new Uint8Array(32);
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];
    for (const field of ['title_ct', 'body_ct'] as const) {
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
// submitReprisalViaProduction
// ===========================================================================

describe('F-190 / submitReprisalViaProduction — session-end WIPE during the seal await', () => {
  it('a mid-seal onPanicWipe() (panic-wipe class) must NOT POST a ciphertext openable under an all-zero key', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    const reprisal = makeReprisalTransport([{ status: 200, body: { ok: true, data: { id: 'r-a' } } }]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    // A panic-wipe (the destroy-my-exposure safety feature) driven exactly into
    // the seal's await gap must NOT instead PRODUCE a world-readable seal.
    keyHolder.armOnFirstDataKeyRead(() => keyHolder.onPanicWipe());

    const r = await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: {
        title: 'F190-REPRISAL-WIPE-TITLE',
        body: 'F190-REPRISAL-WIPE-BODY',
        passphrase: 'friction-gate'
      }
    });

    expect(
      Array.from(plaintextKey).every((b) => b === 0),
      'race was not exercised: the captured data-key buffer was never zeroed mid-seal'
    ).toBe(true);

    await expectNoZeroKeyCiphertextPosted(reprisal.bodies);

    const postedASeal = reprisal.bodies.some(
      (b) => typeof b.title_ct === 'string' || typeof b.body_ct === 'string'
    );
    if (!postedASeal) {
      expect(['session_expiry', 'failed']).toContain(r.status);
    }
  });
});

describe('F-190 Finding-2 / submitReprisalViaProduction — rotation self-heal populate() during the seal await', () => {
  it('a mid-seal populate([...fresh]) that orphans (zeroes) the captured buffer must NOT POST a ciphertext openable under an all-zero key', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    const reprisal = makeReprisalTransport([{ status: 200, body: { ok: true, data: { id: 'r-b' } } }]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const freshLiveKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    keyHolder.armOnFirstDataKeyRead(() =>
      keyHolder.populate([{ data_key: freshLiveKey, key_id: 'k-live-2', epoch: 4, is_live: true }])
    );

    const r = await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: {
        title: 'F190-REPRISAL-POPULATE-TITLE',
        body: 'F190-REPRISAL-POPULATE-BODY',
        passphrase: 'friction-gate'
      }
    });

    expect(
      Array.from(plaintextKey).every((b) => b === 0),
      'race was not exercised: the orphaned captured buffer was never zeroed by populate()'
    ).toBe(true);
    expect(keyHolder.hasLiveKey(), 'post-populate the holder still reports a live key').toBe(true);

    await expectNoZeroKeyCiphertextPosted(reprisal.bodies);

    if (r.status === 'ok') {
      const submitBody = reprisal.bodies[0] as { title_ct?: string };
      expect(typeof submitBody.title_ct).toBe('string');
      await expect(openUtf8(pgHexToBytes(submitBody.title_ct as string), freshLiveKey)).resolves.toBe(
        'F190-REPRISAL-POPULATE-TITLE'
      );
    }
  });
});

// ===========================================================================
// updateReprisalViaProduction
// ===========================================================================

describe('F-190 / updateReprisalViaProduction — session-end WIPE during the seal await', () => {
  it('a mid-seal onPageUnload() (tab-close class) must NOT POST a ciphertext openable under an all-zero key', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    const reprisal = makeReprisalTransport([{ status: 200, body: { ok: true, data: null } }]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    keyHolder.armOnFirstDataKeyRead(() => keyHolder.onPageUnload());

    const r = await updateReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-1',
      title: 'F190-UPDATE-WIPE-TITLE',
      body: 'F190-UPDATE-WIPE-BODY'
    });

    expect(
      Array.from(plaintextKey).every((b) => b === 0),
      'race was not exercised: the captured data-key buffer was never zeroed mid-seal'
    ).toBe(true);

    await expectNoZeroKeyCiphertextPosted(reprisal.bodies);

    const postedASeal = reprisal.bodies.some(
      (b) => typeof b.title_ct === 'string' || typeof b.body_ct === 'string'
    );
    if (!postedASeal) {
      expect(['session_expiry', 'failed']).toContain(r.status);
    }
  });
});

describe('F-190 Finding-2 / updateReprisalViaProduction — rotation self-heal populate() during the seal await', () => {
  it('a mid-seal populate([...fresh]) that orphans (zeroes) the captured buffer must NOT POST a ciphertext openable under an all-zero key', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    const reprisal = makeReprisalTransport([{ status: 200, body: { ok: true, data: null } }]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const freshLiveKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    keyHolder.armOnFirstDataKeyRead(() =>
      keyHolder.populate([{ data_key: freshLiveKey, key_id: 'k-live-2', epoch: 4, is_live: true }])
    );

    const r = await updateReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-1',
      title: 'F190-UPDATE-POPULATE-TITLE',
      body: 'F190-UPDATE-POPULATE-BODY'
    });

    expect(
      Array.from(plaintextKey).every((b) => b === 0),
      'race was not exercised: the orphaned captured buffer was never zeroed by populate()'
    ).toBe(true);
    expect(keyHolder.hasLiveKey(), 'post-populate the holder still reports a live key').toBe(true);

    await expectNoZeroKeyCiphertextPosted(reprisal.bodies);

    if (r.status === 'ok') {
      const updateBody = reprisal.bodies[0] as { title_ct?: string };
      expect(typeof updateBody.title_ct).toBe('string');
      await expect(openUtf8(pgHexToBytes(updateBody.title_ct as string), freshLiveKey)).resolves.toBe(
        'F190-UPDATE-POPULATE-TITLE'
      );
    }
  });
});
