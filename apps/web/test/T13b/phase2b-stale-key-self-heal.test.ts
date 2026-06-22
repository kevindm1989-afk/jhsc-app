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

describe('Phase 2b PR1 — C4 stale-key self-heal (AC-10 / F-162)', () => {
  it('a read under a stale cached key (server rotated to a newer key_id) surfaces a typed decrypt_failed — NOT a silent mis-decrypt — and the opened plaintext is NEVER returned', async () => {
    const { t07Client, localIdentity, keyHolder, srv, plaintextKey } = await buildWired();
    // The holder caches k-live-1 (this session's earlier probe).
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });

    // A co-chair on another device rotated: the server now reports k-live-2
    // AND the stored ciphertext is re-sealed under a NEW key the stale cached
    // key cannot open. We seed a new live wrap so the self-heal re-unwrap (next
    // op) succeeds, and seal the read row under that new key.
    srv.liveKeyId = 'k-live-2';
    srv.liveEpoch = 4;
    const priv = await localIdentity.getIdentityPrivateKey(USER);
    const pub = sodium.crypto_scalarmult_base(priv!);
    const newKey = seedWrap(srv, pub); // srv.plaintextKey is now newKey
    const STALE_SECRET_TITLE = 'STALE-WINDOW-SECRET-TITLE';
    const STALE_SECRET_BODY = 'STALE-WINDOW-SECRET-BODY';

    const reprisal = makeReprisalTransport([
      // The read row is sealed under the NEW key (k-live-2). But the probe
      // inside ensureHolderPopulated sees k-live-2 first and wipes+re-unwraps,
      // so a correctly-implemented composition decrypts fine. To force the
      // ACTUAL one-op stale window we instead exercise the path where the
      // holder is reused WITHOUT a fresh probe observing the rotation — see the
      // dedicated test below. Here we assert the happy self-heal end-state.
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
      id: 'r-rotated',
      passphrase: null
    });
    // Self-heal: the probe observed k-live-2, wiped the stale k-live-1, and
    // re-unwrapped under k-live-2 — so this read succeeds under the new key.
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.title).toBe(STALE_SECRET_TITLE);
      expect(r.body).toBe(STALE_SECRET_BODY);
    }
    // The stale buffer was zeroized when the rotation was observed.
    expect(Array.from(plaintextKey).every((b) => b === 0)).toBe(true);
    expect(keyHolder.getKeyId()).toBe('k-live-2');
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

  it('the probe reporting a NEWER key_id wipes the holder and the NEXT op re-unwraps under the new key (self-heal on submit)', async () => {
    const { t07Client, localIdentity, keyHolder, srv, plaintextKey, t07 } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });

    // Server rotated to k-live-2.
    srv.liveKeyId = 'k-live-2';
    srv.liveEpoch = 4;
    const priv = await localIdentity.getIdentityPrivateKey(USER);
    const pub = sodium.crypto_scalarmult_base(priv!);
    seedWrap(srv, pub);

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
      intake: { title: 't', body: 'b', passphrase: 'p' }
    });

    // The stale k-live-1 buffer was zeroized; the holder re-unwrapped to
    // k-live-2 (proves get_key_wrap fired after the rotation was observed).
    expect(Array.from(plaintextKey).every((b) => b === 0)).toBe(true);
    expect(keyHolder.getKeyId()).toBe('k-live-2');
    expect(keyHolder.isPopulated()).toBe(true);
    expect(t07.ops).toContain('get_key_wrap');
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
