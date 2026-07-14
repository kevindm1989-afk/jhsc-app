/**
 * F182-2 / F-183-R — the forward-secrecy recovery-path mitigations
 * (threat-model §3.18 Amendment A-8.10-R, finding F-183-R; HG-KEY-ROTATION
 * scope). These are the three "Testable mitigation (F182-2, vitest — must be
 * RED against the current uncommitted impl, GREEN before F182-4)" cases the
 * threat-modeler wrote into A-8.10-R.
 *
 * THE GAP (verified file:line, A-8.10-R). `onKeyRotationObserved(newKeyId)` is a
 * pure NO-OP when the observed key is NOT held, so it never demotes the current
 * live key. After a session cached at k-live-1 observes the server's rotation to
 * k-live-2 (via the probe), `hasLiveKey()` returns a FALSE POSITIVE and:
 *   (a) the SEAL path does NOT fail closed — a NEW concern/reprisal is sealed
 *       under the RETIRED k-live-1 (a forward-secrecy regression: a removed
 *       member who cached k-live-1 can read records filed AFTER the rotation);
 *   (b) the RECOVERY path never fires — the consumer re-populate is gated on
 *       `!hasLiveKey()`, which is a false positive, so the session is stuck.
 *
 * THE FIX (the contract these tests pin, A-8.10-R Ruling):
 *   1. Holder: on a PROBE-observed key_id that differs from the held live key
 *      and is NOT held, DEMOTE the current live key (`is_live=false`,
 *      `#liveKeyId=null`), RETAINING the buffer for reads → `hasLiveKey()`→false.
 *   2. Consumer: gate the re-populate on `getKeyId() !== probe.key_id` (NOT
 *      `!hasLiveKey()`), and re-populate via `unwrapAllCommitteeKeysViaProduction`
 *      + `holder.populate()` (NOT `.set()`, which discards the retained
 *      old-epoch read keys and re-introduces the F-183 historical-read lockout).
 *
 * RED-FIRST. Every mitigation below is RED against the CURRENT uncommitted impl
 * (the no-op `onKeyRotationObserved` + the `.set()`-based, `!hasLiveKey()`-gated
 * consumers) and MUST go GREEN when the F-183-R fix lands. The implementer
 * treats this file as READ-ONLY.
 *
 * Hermetic: real libsodium (secretbox + sealed-box, the exact primitives the
 * sealed registers share); a mock t07/concern/reprisal transport; a real
 * BrowserLocalIdentityStore (SSR-fallback Map); a real CommitteeKeyHolder. No
 * real clock, no real network, no seeded RNG (assertions are on the DECRYPT
 * round-trip / op-invocation outcome, never on raw ciphertext bytes).
 *
 * TEST → A-8.10-R MITIGATION MAP
 *   M1  seal-fails-closed-on-not-held-rotation — a NEW record is NEVER sealed
 *       under the retired k-live-1 (concern AND reprisal submit paths).
 *   M2  no-stuck-session / probe-driven re-populate fires — gated on
 *       getKeyId() !== probe.key_id (NOT !hasLiveKey()); the multi-epoch
 *       populate() path is invoked; a matching key_id does NOT churn.
 *   M3  retained-read survives re-populate — after populate(), a pre-rotation
 *       record STILL opens and BOTH epochs are held (size>=2); a .set()-based
 *       repopulate would discard the retained key (re-introducing F-183).
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
import { submitConcernViaProduction, listConcernsViaProduction } from '../../src/lib/concerns';
import {
  SupabaseReprisalClient,
  type ReprisalOpTransport
} from '../../src/lib/reprisal/supabase-reprisal-client';
import { submitReprisalViaProduction } from '../../src/lib/reprisal/production-flows';
import { openUtf8 } from '../../src/lib/concerns/seal';
import { pgHexToBytes } from '../../src/lib/server-client/pg-hex';
import { __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

await _sodium.ready;
const sodium = _sodium;

const USER = '9f4e9b40-0000-4000-8000-00000000001a';

function silentStore(): BrowserLocalIdentityStore {
  return new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
}

function bytesToPgHex(b: Uint8Array): string {
  let s = '\\x';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
}

/** Seal a UTF-8 plaintext under a secretbox key → on-wire `[nonce][ct]` hex. */
function sealHex(pt: string, key: Uint8Array): string {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ptBytes = new Uint8Array(new TextEncoder().encode(pt));
  const ct = sodium.crypto_secretbox_easy(ptBytes, nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return bytesToPgHex(out);
}

/**
 * A multi-epoch fake key server. `liveKeyId` is what the probe reports;
 * `allWraps` is what the re-populate path (`get_all_key_wraps`) returns — the
 * RETAINED retired epoch(s) + the NEW live epoch, each sealed to the actor pub.
 */
interface FakeKeyServer {
  liveKeyId: string;
  liveEpoch: number;
  actorHasWrap: boolean;
  liveWrap: Uint8Array | null;
  allWraps: Array<{ key_id: string; epoch: number; wrap: Uint8Array; is_live: boolean }> | null;
}

function makeT07Transport(srv: FakeKeyServer): { transport: T07OpTransport; ops: string[] } {
  const ops: string[] = [];
  const transport: T07OpTransport = async (body) => {
    ops.push(String(body.op));
    if (body.op === 'committee_key_state') {
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
    }
    if (body.op === 'get_key_wrap') {
      if (!srv.liveWrap) return { status: 200, body: { ok: true, data: null } };
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            key_id: srv.liveKeyId,
            epoch: srv.liveEpoch,
            wrapped_ciphertext_hex: bytesToPgHex(srv.liveWrap)
          }
        }
      };
    }
    if (body.op === 'get_all_key_wraps') {
      const rows = srv.allWraps ?? [];
      return {
        status: 200,
        body: {
          ok: true,
          data: rows.map((r) => ({
            key_id: r.key_id,
            epoch: r.epoch,
            wrapped_ciphertext_hex: bytesToPgHex(r.wrap),
            is_live: r.is_live
          }))
        }
      };
    }
    throw new Error(`unexpected op ${String(body.op)}`);
  };
  return { transport, ops };
}

function makeConcernTransport(queue: Array<{ status: number; body: unknown }>): {
  transport: ConcernOpTransport;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  let i = 0;
  const transport: ConcernOpTransport = async (body) => {
    bodies.push(body);
    const r = queue[i++];
    if (!r) throw new Error(`concern: no response queued (call #${i})`);
    return { status: r.status, body: r.body };
  };
  return { transport, bodies };
}

function makeReprisalTransport(queue: Array<{ status: number; body: unknown }>): {
  transport: ReprisalOpTransport;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  let i = 0;
  const transport: ReprisalOpTransport = async (body) => {
    bodies.push(body);
    const r = queue[i++];
    if (!r) throw new Error(`reprisal: no response queued (call #${i})`);
    return { status: r.status, body: r.body };
  };
  return { transport, bodies };
}

/**
 * Build a session cached at the RETIRED k-live-1 while the server has already
 * rotated to k-live-2. `retiredKey` (k-live-1) and `liveKey` (k-live-2) are
 * distinct 32-byte secretbox keys; `allWraps` carries BOTH sealed to the actor
 * pubkey (the realistic post-rotation holding state a remaining member fetches).
 */
async function buildRotatedSession() {
  const retiredKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const liveKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const localIdentity = silentStore();
  const kp = sodium.crypto_box_keypair();
  await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

  const srv: FakeKeyServer = {
    liveKeyId: 'k-live-2',
    liveEpoch: 4,
    actorHasWrap: true,
    liveWrap: sodium.crypto_box_seal(liveKey, kp.publicKey),
    allWraps: [
      { key_id: 'k-live-1', epoch: 3, wrap: sodium.crypto_box_seal(retiredKey, kp.publicKey), is_live: false },
      { key_id: 'k-live-2', epoch: 4, wrap: sodium.crypto_box_seal(liveKey, kp.publicKey), is_live: true }
    ]
  };
  const t07 = makeT07Transport(srv);
  const t07Client = new SupabaseT07Client({ transport: t07.transport, localIdentity });
  const keyHolder = new CommitteeKeyHolder();
  // The session cached the pre-rotation live key.
  keyHolder.set({ data_key: retiredKey, key_id: 'k-live-1', epoch: 3 });

  return { srv, t07, t07Client, localIdentity, keyHolder, retiredKey, liveKey };
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
// M1 — seal-fails-closed-on-not-held-rotation (A-8.10-R (a) / Q1(a)).
// A NEW record must NEVER be sealed under the RETIRED key.
// ===========================================================================
describe('F-183-R M1 — a new record is NEVER sealed under the retired key (forward secrecy)', () => {
  it('submitConcernViaProduction: the posted ciphertext NEVER opens under the retired k-live-1 (it seals under the live k-live-2 after re-populate)', async () => {
    const { t07Client, localIdentity, keyHolder, retiredKey, liveKey } = await buildRotatedSession();
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: { id: 'c-1' } } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    await submitConcernViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: {
        title: 'post-rotation-title',
        body: 'post-rotation-body',
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L-1',
        anonymous: true
      }
    });

    // The forward-secrecy invariant: NO posted ciphertext opens under the
    // RETIRED key. A removed member who exfiltrated k-live-1 must not be able to
    // read a concern filed AFTER the rotation.
    for (const b of concern.bodies) {
      const body = b as { title_ct?: string; body_ct?: string };
      if (typeof body.title_ct === 'string') {
        await expect(openUtf8(pgHexToBytes(body.title_ct), retiredKey)).rejects.toThrow();
        await expect(openUtf8(pgHexToBytes(body.title_ct), liveKey)).resolves.toBe(
          'post-rotation-title'
        );
      }
    }
    // A ciphertext WAS produced (the submit did not silently no-op) — and it is
    // under the live key.
    expect(concern.bodies.length).toBe(1);
  });

  it('submitReprisalViaProduction: the posted ciphertext NEVER opens under the retired k-live-1 (it seals under the live k-live-2 after re-populate)', async () => {
    const { t07Client, localIdentity, keyHolder, retiredKey, liveKey } = await buildRotatedSession();
    const reprisal = makeReprisalTransport([{ status: 200, body: { ok: true, data: { id: 'r-1' } } }]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: { title: 'post-rotation-reprisal-title', body: 'post-rotation-reprisal-body', passphrase: 'p' }
    });

    for (const b of reprisal.bodies) {
      const body = b as { title_ct?: string; body_ct?: string };
      if (typeof body.title_ct === 'string') {
        await expect(openUtf8(pgHexToBytes(body.title_ct), retiredKey)).rejects.toThrow();
        await expect(openUtf8(pgHexToBytes(body.title_ct), liveKey)).resolves.toBe(
          'post-rotation-reprisal-title'
        );
      }
    }
    expect(reprisal.bodies.length).toBe(1);
  });
});

// ===========================================================================
// M2 — no-stuck-session: the probe-driven re-populate fires, gated on
// getKeyId() !== probe.key_id (NOT !hasLiveKey()). (A-8.10-R (b) / Q1(b).)
// ===========================================================================
describe('F-183-R M2 — the probe-driven re-populate fires (gated on key_id mismatch, not !hasLiveKey())', () => {
  it('when the probe key_id differs from getKeyId() WHILE hasLiveKey() is true, the multi-epoch populate() path is invoked (a !hasLiveKey()-gate would never fire — the stuck session)', async () => {
    const { t07Client, localIdentity, keyHolder, t07 } = await buildRotatedSession();
    // Pre-condition: the holder DOES hold a (stale) live key — so a re-populate
    // gated on !hasLiveKey() would NEVER fire. The correct gate is the key_id
    // mismatch (getKeyId()='k-live-1' !== probe.key_id='k-live-2').
    expect(keyHolder.hasLiveKey()).toBe(true);
    expect(keyHolder.getKeyId()).toBe('k-live-1');

    const populateSpy = vi.spyOn(keyHolder, 'populate');
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: { id: 'c-2' } } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    await submitConcernViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: {
        title: 't',
        body: 'b',
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L-1',
        anonymous: true
      }
    });

    // The multi-epoch re-populate fired: the all-wraps RPC was hit AND the
    // holder's populate() (not .set()) was called.
    expect(t07.ops).toContain('get_all_key_wraps');
    expect(populateSpy).toHaveBeenCalled();
    // The holder self-healed onto the new live key.
    expect(keyHolder.getKeyId()).toBe('k-live-2');
    expect(keyHolder.hasLiveKey()).toBe(true);
  });

  it('when the probe key_id MATCHES getKeyId(), the re-populate does NOT fire (dwell policy preserved — no churn)', async () => {
    // Steady state: cached at k-live-1, the probe also reports k-live-1.
    const localIdentity = silentStore();
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    const liveKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const srv: FakeKeyServer = {
      liveKeyId: 'k-live-1',
      liveEpoch: 3,
      actorHasWrap: true,
      liveWrap: sodium.crypto_box_seal(liveKey, kp.publicKey),
      allWraps: [{ key_id: 'k-live-1', epoch: 3, wrap: sodium.crypto_box_seal(liveKey, kp.publicKey), is_live: true }]
    };
    const t07 = makeT07Transport(srv);
    const t07Client = new SupabaseT07Client({ transport: t07.transport, localIdentity });
    const keyHolder = new CommitteeKeyHolder();
    keyHolder.set({ data_key: liveKey, key_id: 'k-live-1', epoch: 3 });

    const populateSpy = vi.spyOn(keyHolder, 'populate');
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: { id: 'c-3' } } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    await submitConcernViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: {
        title: 't',
        body: 'b',
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L-1',
        anonymous: true
      }
    });

    // No rotation observed ⇒ no re-populate, no all-wraps RPC (one-unwrap-per-
    // session dwell policy is NOT regressed by the fix).
    expect(t07.ops).not.toContain('get_all_key_wraps');
    expect(populateSpy).not.toHaveBeenCalled();
    expect(keyHolder.getKeyId()).toBe('k-live-1');
  });
});

// ===========================================================================
// M3 — retained-read survives re-populate (anti-lockout). After populate(),
// a pre-rotation record STILL opens and BOTH epochs are held. A .set()-based
// repopulate would discard the retained key → the F-183 historical lockout.
// ===========================================================================
describe('F-183-R M3 — a retained old-epoch read survives the re-populate (populate(), not .set())', () => {
  it('after a rotation-driven re-populate, a pre-rotation concern (sealed under k-live-1) STILL opens AND both epochs are held (size >= 2)', async () => {
    const { t07Client, localIdentity, keyHolder, t07, retiredKey } = await buildRotatedSession();

    // A pre-rotation concern row, sealed under the RETIRED k-live-1. It must
    // still open after the re-populate — proof the re-populate used populate()
    // (retaining k-live-1), not .set() (which would drop it and lock out the
    // committee's own history, the exact F-183 hazard).
    const nowIso = new Date().toISOString();
    const rowsFromView = [
      {
        id: 'c-pre',
        title_ct: sealHex('history-title-under-retired-epoch', retiredKey),
        body_ct: sealHex('history-body-under-retired-epoch', retiredKey),
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L-1',
        created_at: nowIso,
        actor_pseudonym: 'p-pre',
        anonymous_default_kept: true,
        has_named_source: false
      }
    ];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rowsFromView } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    });

    // The re-populate fired via the multi-epoch path.
    expect(t07.ops).toContain('get_all_key_wraps');
    // Anti-lockout: the pre-rotation row STILL opens (retained k-live-1 read key).
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.items.length).toBe(1);
      expect(r.items[0]!.title).toBe('history-title-under-retired-epoch');
      expect(r.items[0]!.body).toBe('history-body-under-retired-epoch');
    }
    // BOTH epochs are held — a .set()-based repopulate would leave size 1 (only
    // the live key), re-introducing the historical-read lockout F-183 prevents.
    expect(keyHolder.size()).toBeGreaterThanOrEqual(2);
    expect(keyHolder.getKeyId()).toBe('k-live-2');
  });
});
