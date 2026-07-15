/**
 * Phase 2b PR1 / P2b-2 — AC-10 C4-body stale-key self-heal (the Decision 1
 * residual; threat-model §3.17 F-162, the architect's explicit (a)-vs-(b)
 * co-sign edge — RULED option (a), probe-first parity, NO migration).
 *
 * **This finding MUST be red first** (per the threat-model handoff: "F-162
 * (AC-10) is the C4-body co-sign edge and MUST be red first at PR1").
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
 *
 * The residual being pinned: a single-op stale-key window. If a co-chair on
 * another device rotates the committee key AFTER this session's
 * ensureHolderPopulated probe but BEFORE a reprisal_read in the SAME already-
 * populated session, the read opens ciphertext re-sealed under the NEW key with
 * the STALE cached key. Required behaviour (F-162 ruling):
 *
 *   (1) The probe reading a NEWER key_id ⇒ onKeyRotationObserved ⇒ holder wiped
 *       ⇒ the NEXT op re-unwraps under the new key (self-heal).
 *   (2) A read under a stale key surfaces a typed `decrypt_failed` — NOT a
 *       silent mis-decrypt (libsodium secretbox is AEAD and throws on a wrong
 *       key; the open is wrapped → typed failure). The opened plaintext is
 *       NEVER returned.
 *   (3) The defensive optional `key_id?` passthrough on the read response is
 *       routed through onKeyRotationObserved and is a NO-OP today (the read RPC
 *       carries no key_id under option (a)) — proving the (b) upgrade path is
 *       wired but inert.
 *
 * Surface under test: readReprisalViaProduction + submitReprisalViaProduction
 * (see phase2b-read/submit-*.test.ts for the full signatures).
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
// RED-FIRST: these imports do not resolve yet.
import {
  readReprisalViaProduction,
  submitReprisalViaProduction
} from '../../src/lib/reprisal/production-flows';
import { __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
import { pgHexToBytes } from '../../src/lib/server-client/pg-hex';
// Real secretbox open — proves a re-populated submit seals under the LIVE
// (rotated-to) key ONLY, never the retired key (forward secrecy, A-8.10-R).
import { openUtf8 } from '../../src/lib/concerns/seal';

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

function sealHex(pt: string, key: Uint8Array): string {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ptBytes = new Uint8Array(Buffer.from(pt, 'utf8'));
  const ct = sodium.crypto_secretbox_easy(ptBytes, nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return bytesToPgHex(out);
}

interface FakeKeyServer {
  liveKeyId: string;
  liveEpoch: number;
  actorHasWrap: boolean;
  liveWrap: Uint8Array | null;
  plaintextKey: Uint8Array | null;
  // A-8.10-R: the multi-epoch wrap set the re-populate path
  // (`unwrapAllCommitteeKeysViaProduction` → `get_all_key_wraps`) fetches. Each
  // `wrap` is a sealed-box of the epoch's data key to the actor pubkey. When
  // unset, `get_all_key_wraps` derives a single live row from `liveWrap`.
  allWraps?: Array<{ key_id: string; epoch: number; wrap: Uint8Array; is_live: boolean }>;
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
      // A-8.10-R re-populate path (F-183 (i) own-wrap-only, no id parameter).
      const rows =
        srv.allWraps ??
        (srv.liveWrap
          ? [{ key_id: srv.liveKeyId, epoch: srv.liveEpoch, wrap: srv.liveWrap, is_live: true }]
          : []);
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
    if (!r) throw new Error(`no response queued (call #${i})`);
    return { status: r.status, body: r.body };
  };
  return { transport, bodies };
}

async function buildWired() {
  const srv = newServer();
  const t07 = makeT07Transport(srv);
  const localIdentity = silentStore();
  const t07Client = new SupabaseT07Client({ transport: t07.transport, localIdentity });
  const kp = sodium.crypto_box_keypair();
  await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
  const plaintextKey = seedWrap(srv, kp.publicKey);
  const keyHolder = new CommitteeKeyHolder();
  return { srv, t07, localIdentity, t07Client, keyHolder, kp, plaintextKey };
}

beforeEach(() => {
  __resetCapture();
  __setTestSink();
});

afterEach(() => {
  __resetCapture();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC-10 (1)+(2) — a one-op stale window surfaces typed decrypt_failed
// (non-silent), then the NEXT op's probe self-heals.
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — C4 stale-key self-heal (AC-10 / F-162 / A-8.10-R item 5)', () => {
  it('a read whose row is sealed under the rotated-to key while the holder holds ONLY the pre-rotation key (probe not yet advanced) FAILS CLOSED to decrypt_failed, RETAINS the stale key (not zeroized), and NEVER returns the opened plaintext', async () => {
    const { t07Client, localIdentity, keyHolder, srv, plaintextKey } = await buildWired();
    // The holder caches k-live-1 (this session's earlier probe). The probe STILL
    // reports k-live-1 (the genuine one-op window: the rotation is not yet
    // visible via the probe), so there is no re-populate this op.
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    expect(srv.liveKeyId).toBe('k-live-1');

    // The stored ciphertext was already re-sealed under a NEW key the stale
    // cached key cannot open.
    const newKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const STALE_SECRET_TITLE = 'STALE-WINDOW-SECRET-TITLE';
    const STALE_SECRET_BODY = 'STALE-WINDOW-SECRET-BODY';

    const reprisal = makeReprisalTransport([
      {
        status: 200,
        body: {
          ok: true,
          data: {
            title_ct: sealHex(STALE_SECRET_TITLE, newKey),
            body_ct: sealHex(STALE_SECRET_BODY, newKey)
          }
        }
      }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-stale-window',
      passphrase: null
    });
    // Fail-closed: trial-decrypt over {k-live-1} cannot open a k-live-2 row.
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.reason).toBe('decrypt_failed');
    // The opened plaintext is NEVER returned (no silent mis-decrypt).
    const blob = JSON.stringify(r);
    expect(blob).not.toContain(STALE_SECRET_TITLE);
    expect(blob).not.toContain(STALE_SECRET_BODY);
    // A-8.10-R: the stale key is RETAINED (add-not-wipe), NOT zeroized — the read
    // failure alone must not destroy the still-valid retained read material.
    expect(Array.from(plaintextKey).some((b) => b !== 0)).toBe(true);
    expect(keyHolder.isPopulated()).toBe(true);
  });

  it('recovery self-heal: a SUBSEQUENT read whose probe observes the newer key_id re-populates via get_all_key_wraps and then SUCCEEDS under the new key; the stale key stays RETAINED [requires F-183-R fix]', async () => {
    const { t07Client, localIdentity, keyHolder, srv, t07, plaintextKey, kp } = await buildWired();
    // The holder is cached at the pre-rotation k-live-1.
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });

    // A-8.10-R2-a anti-lockout proof at MAP granularity (a read round-trip over
    // the RETAINED epoch), not a buffer-byte proxy. Capture a COPY of k-live-1's
    // bytes and seal a probe under them BEFORE the self-heal fires — F-145-C's
    // populate() orphan-wipe will zeroize the original .set() buffer.
    const k1Bytes = Uint8Array.from(plaintextKey);
    const probe = pgHexToBytes(sealHex('PROBE-RETAINED-K1', k1Bytes));

    // The rotation is now VISIBLE via the probe: the server reports k-live-2 and
    // the multi-epoch wrap set carries the RETAINED k-live-1 + the NEW k-live-2,
    // both sealed to the actor pubkey.
    srv.liveKeyId = 'k-live-2';
    srv.liveEpoch = 4;
    const newKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    srv.allWraps = [
      { key_id: 'k-live-1', epoch: 3, wrap: sodium.crypto_box_seal(plaintextKey, kp.publicKey), is_live: false },
      { key_id: 'k-live-2', epoch: 4, wrap: sodium.crypto_box_seal(newKey, kp.publicKey), is_live: true }
    ];
    const REC_TITLE = 'RECOVERED-UNDER-NEW-KEY';
    const REC_BODY = 'RECOVERED-BODY-UNDER-NEW-KEY';

    const reprisal = makeReprisalTransport([
      {
        status: 200,
        body: { ok: true, data: { title_ct: sealHex(REC_TITLE, newKey), body_ct: sealHex(REC_BODY, newKey) } }
      }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-recovered',
      passphrase: null
    });

    // Self-heal via the multi-epoch re-populate (NOT the single-key wipe path):
    // the probe observed k-live-2, the holder re-populated ALL wraps, and the
    // read now succeeds under the new key.
    expect(t07.ops).toContain('get_all_key_wraps');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.title).toBe(REC_TITLE);
      expect(r.body).toBe(REC_BODY);
    }
    expect(keyHolder.getKeyId()).toBe('k-live-2');
    // F-145-C (A-8.10-R2-a): the ORIGINAL .set() buffer reference IS zeroized once
    // populate() orphans it (identity-compare orphan-wipe). Anti-lockout is NOT
    // proven by this buffer's bytes surviving — it is a property of the holder's
    // MAP: the retired k-live-1 epoch is re-installed as a FRESH buffer (unsealed
    // from the server's own-wrap set) and STILL opens k-live-1 ciphertext.
    expect(Array.from(plaintextKey).every((b) => b === 0)).toBe(true);
    const probeOpen = await keyHolder.trialOpen((dk) => openUtf8(probe, dk));
    expect(probeOpen).toEqual({ status: 'ok', value: 'PROBE-RETAINED-K1' });
  });

  it('a genuine stale-key decrypt (ciphertext under a key the cached key cannot open, no rotation observed on the probe) ⇒ typed decrypt_failed, opened plaintext NEVER returned', async () => {
    const { t07Client, localIdentity, keyHolder } = await buildWired();
    // The holder caches k-live-1; the server's probe ALSO reports k-live-1
    // (no rotation observed) — but the stored ciphertext was sealed under a
    // different key (the genuine one-op window the threat-model accepts). The
    // open MUST fail closed: typed decrypt_failed, never a silent mis-decrypt
    // and never the opened plaintext.
    const cachedKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    keyHolder.set({ data_key: cachedKey, key_id: 'k-live-1', epoch: 3 });
    const otherKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);

    const reprisal = makeReprisalTransport([
      {
        status: 200,
        body: {
          ok: true,
          data: {
            title_ct: sealHex('RESEALED-UNDER-NEW-KEY', otherKey),
            body_ct: sealHex('RESEALED-BODY-UNDER-NEW-KEY', otherKey)
          }
        }
      }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-stale',
      passphrase: null
    });
    expect(r.status).not.toBe('ok');
    if (r.status === 'failed') {
      expect(r.reason).toBe('decrypt_failed');
    }
    // The opened plaintext (if AEAD had wrongly succeeded) must never surface.
    const blob = JSON.stringify(r);
    expect(blob).not.toContain('RESEALED-UNDER-NEW-KEY');
    expect(blob).not.toContain('RESEALED-BODY-UNDER-NEW-KEY');
  });

  it('the submit, observing k-live-2 while cached at k-live-1, re-populates and seals under the LIVE k-live-2 (NEVER the retired k-live-1); k-live-1 is RETAINED [requires F-183-R fix]', async () => {
    const { t07Client, localIdentity, keyHolder, srv, plaintextKey, t07, kp } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });

    // A-8.10-R2-a anti-lockout proof at MAP granularity (a read round-trip over
    // the RETAINED epoch), not a buffer-byte proxy. Capture a COPY of k-live-1's
    // bytes and seal a probe under them BEFORE the self-heal fires — F-145-C's
    // populate() orphan-wipe will zeroize the original .set() buffer.
    const k1Bytes = Uint8Array.from(plaintextKey);
    const probe = pgHexToBytes(sealHex('PROBE-RETAINED-K1', k1Bytes));

    // Server rotated to k-live-2; the multi-epoch wrap set carries the RETAINED
    // k-live-1 (retired) + the NEW live k-live-2, both sealed to the actor pubkey.
    srv.liveKeyId = 'k-live-2';
    srv.liveEpoch = 4;
    const newKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    srv.allWraps = [
      { key_id: 'k-live-1', epoch: 3, wrap: sodium.crypto_box_seal(plaintextKey, kp.publicKey), is_live: false },
      { key_id: 'k-live-2', epoch: 4, wrap: sodium.crypto_box_seal(newKey, kp.publicKey), is_live: true }
    ];

    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { id: 'r-after-rot' } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: { title: 'reprisal-title', body: 'reprisal-body', passphrase: 'p' }
    });

    // Forward secrecy: the posted ciphertext opens under the LIVE k-live-2 ONLY,
    // NEVER the retired k-live-1 (F-183-R seal-under-retired regression).
    const submitBody = reprisal.bodies[0] as { title_ct: string; body_ct: string };
    const postedTitle = pgHexToBytes(submitBody.title_ct);
    const postedBody = pgHexToBytes(submitBody.body_ct);
    await expect(openUtf8(postedTitle, newKey)).resolves.toBe('reprisal-title');
    await expect(openUtf8(postedBody, newKey)).resolves.toBe('reprisal-body');
    await expect(openUtf8(postedTitle, plaintextKey)).rejects.toThrow();

    // The multi-epoch re-populate fired; the holder ends under the new live key.
    expect(t07.ops).toContain('get_all_key_wraps');
    expect(keyHolder.getKeyId()).toBe('k-live-2');
    expect(keyHolder.isPopulated()).toBe(true);
    // F-145-C (A-8.10-R2-a): the ORIGINAL .set() buffer reference IS zeroized once
    // populate() orphans it (identity-compare orphan-wipe). Anti-lockout is NOT
    // proven by this buffer's bytes surviving — it is a property of the holder's
    // MAP: the retired k-live-1 epoch is re-installed as a FRESH buffer (unsealed
    // from the server's own-wrap set) and STILL opens k-live-1 ciphertext.
    expect(Array.from(plaintextKey).every((b) => b === 0)).toBe(true);
    const probeOpen = await keyHolder.trialOpen((dk) => openUtf8(probe, dk));
    expect(probeOpen).toEqual({ status: 'ok', value: 'PROBE-RETAINED-K1' });
  });
});

// ---------------------------------------------------------------------------
// AC-10 (3) — the defensive key_id? passthrough is wired but inert under (a)
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — defensive key_id? passthrough is a no-op today (AC-10 / F-162 option (b) seam)', () => {
  it('a read response WITHOUT a key_id field does NOT trigger a holder wipe (the passthrough is inert under option (a))', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const rotSpy = vi.spyOn(keyHolder, 'onKeyRotationObserved');

    const reprisal = makeReprisalTransport([
      {
        status: 200,
        body: {
          ok: true,
          // NO key_id on the read response — option (a) ground truth
          // (reprisal_read RETURNS TABLE(title_ct, body_ct) only).
          data: { title_ct: sealHex('x', plaintextKey), body_ct: sealHex('y', plaintextKey) }
        }
      }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-1',
      passphrase: null
    });
    expect(r.status).toBe('ok');
    // The holder was NOT wiped by a phantom rotation — it still holds k-live-1.
    expect(keyHolder.getKeyId()).toBe('k-live-1');
    expect(keyHolder.isPopulated()).toBe(true);
    // If the composition calls onKeyRotationObserved at all (the defensive
    // passthrough or the probe), it must only ever be with the live key_id —
    // never a value that wipes the still-valid holder.
    for (const call of rotSpy.mock.calls) {
      expect(call[0]).toBe('k-live-1');
    }
  });

  it('a read response that DOES carry a newer key_id (forward-compat option (b)) is routed through onKeyRotationObserved (the seam receives the value)', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const rotSpy = vi.spyOn(keyHolder, 'onKeyRotationObserved');

    const reprisal = makeReprisalTransport([
      {
        status: 200,
        body: {
          ok: true,
          // A future (option (b)) migration could add key_id to the response.
          // The composition's defensive passthrough must route it to the
          // holder — proving the (b) upgrade path is wired (mirrors
          // concerns/production-flows.ts:490-493).
          data: {
            title_ct: sealHex('x', plaintextKey),
            body_ct: sealHex('y', plaintextKey),
            key_id: 'k-live-2'
          }
        }
      }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-1',
      passphrase: null
    });
    expect(rotSpy).toHaveBeenCalledWith('k-live-2');
  });
});
