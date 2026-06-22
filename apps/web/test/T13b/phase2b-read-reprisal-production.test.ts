/**
 * Phase 2b PR1 / P2b-2 — `readReprisalViaProduction`: the audited C4 read
 * (ADR-0028 Decision 3 — the LOAD-BEARING composition; threat-model §3.17
 * F-165 audit-before-decrypt + never-decrypt-on-null, F-164 passphrase-is-
 * friction-not-crypto, F-161/F-167 decrypt-fail surfaces typed).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
 *
 * Surface under test:
 *
 *   readReprisalViaProduction({
 *     reprisalClient: SupabaseReprisalClient,
 *     t07Client:      SupabaseT07Client,
 *     keyHolder:      CommitteeKeyHolder,
 *     localIdentity:  LocalIdentityStore,
 *     user_id:        string,
 *     id:             string,
 *     passphrase?:    string | null
 *   }): Promise<ReadReprisalViaProductionResult>
 *
 *   Result discriminator (ADR-0028 Decision 3):
 *     { status: 'ok'; title: string; body: string }
 *     | { status: 'unavailable' }                   // data === null (wrong
 *                                                   // passphrase OR not-found —
 *                                                   // the wire cannot tell;
 *                                                   // NEVER decrypt — F-165)
 *     | { status: 'rls_denied' }                    // 403 (not a session event)
 *     | { status: 'session_expiry' }                // 401
 *     | { status: 'needs_setup' }                   // actor_has_wrap === false
 *     | { status: 'needs_recovery' }
 *     | { status: 'failed'; reason: string; http: number }  // incl. decrypt_failed
 *
 * The LOAD-BEARING contract (ADR-0028 Decision 3 / F-165):
 *   1. ensureHolderPopulated (probe-first).
 *   2. AWAIT reprisalClient.readReprisal({ id, passphrase }) — the SERVER
 *      emits `reprisal.read` BEFORE returning ciphertext
 *      (00000000000005_reprisal.sql:222-226). The CLIENT must NOT openUtf8
 *      anything until this await resolves (audit-before-decrypt; no eager
 *      decrypt of cached/sniffed ct).
 *   3. If `data === null` ⇒ return { status: 'unavailable' } and NEVER call
 *      openUtf8 (the null covers BOTH wrong-passphrase AND not-found, which
 *      the wire collapses — supabase-reprisal-client.ts:148-149). NOT an
 *      invented `invalid_passphrase` the wire can't substantiate.
 *   4. Else openUtf8(title_ct) + openUtf8(body_ct) under the cached committee
 *      key in try/catch ⇒ typed decrypt_failed on AEAD failure (never a thrown
 *      libsodium error carrying buffer bytes).
 *
 * TEST → AC / FINDING MAP
 *   AC-2 (audited read happy)     — readable record ⇒ { ok, title, body }
 *                                   decrypting to the submitted plaintext;
 *                                   read RPC is the only reprisal-op call.
 *   AC-2 / F-165 (audit-before-   — the composition does NOT openUtf8 until
 *         decrypt)                  the read RPC resolves (gated transport;
 *                                   getDataKey not consulted before resolve).
 *   AC-3 / F-165 (null⇒unavailable)— data===null ⇒ unavailable, NO openUtf8;
 *                                   wrong-passphrase AND not-found map
 *                                   IDENTICALLY; NEVER 'invalid_passphrase'.
 *   F-164 (passphrase = friction) — the composition does NOT derive a key from
 *                                   the passphrase / gate openUtf8 on it; it is
 *                                   forwarded to the transport only.
 *   F-148 / F-161 / F-167         — corrupt/tampered/wrong-key ciphertext ⇒
 *                                   typed decrypt_failed with NO Uint8Array /
 *                                   no libsodium bytes in the surface.
 *   AC-6 (401 vs 403)             — 401 ⇒ session_expiry + holder wiped;
 *                                   403 ⇒ rls_denied + holder NOT wiped.
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
// RED-FIRST: this import does not resolve yet.
import { readReprisalViaProduction } from '../../src/lib/reprisal/production-flows';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

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

/** Seal a plaintext to PostgREST hex under `key` — emulates the stored ct. */
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
  /** If set, the response is DELAYED until this gate resolves. */
  gate?: () => Promise<void>;
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
    if (r.gate) await r.gate();
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
// AC-2 — happy read: ct round-trips back to the submitted plaintext
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — readReprisalViaProduction happy path (AC-2)', () => {
  it('returns the decrypted title + body; forwards id + passphrase verbatim; read is the only reprisal-op call', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const TITLE = 'retaliation: shift reassignment';
    const BODY = 'full account of the reprisal incident';
    const reprisal = makeReprisalTransport([
      {
        status: 200,
        body: {
          ok: true,
          data: { title_ct: sealHex(TITLE, plaintextKey), body_ct: sealHex(BODY, plaintextKey) }
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
      passphrase: 'friction-pass'
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.title).toBe(TITLE);
    expect(r.body).toBe(BODY);

    expect(reprisal.bodies.length).toBe(1);
    expect(reprisal.bodies[0]).toEqual({ op: 'read', id: 'r-1', passphrase: 'friction-pass' });
  });
});

// ---------------------------------------------------------------------------
// AC-2 / F-165 — audit-before-decrypt: NO openUtf8 before the read RPC resolves
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — audit-before-decrypt invariant (AC-2 / F-165)', () => {
  it('does NOT read the data key to decrypt until the read RPC has resolved (the server reprisal.read audit row is the gate)', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const TITLE = 'GATED-CANARY-TITLE';
    const BODY = 'GATED-CANARY-BODY';

    let getDataKeyCallsBeforeResolve = 0;
    let gateOpen = false;
    const origGet = keyHolder.getDataKey.bind(keyHolder);
    vi.spyOn(keyHolder, 'getDataKey').mockImplementation(() => {
      if (!gateOpen) getDataKeyCallsBeforeResolve++;
      return origGet();
    });

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const reprisal = makeReprisalTransport([
      {
        status: 200,
        body: {
          ok: true,
          data: { title_ct: sealHex(TITLE, plaintextKey), body_ct: sealHex(BODY, plaintextKey) }
        },
        gate: () => gate
      }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const readPromise = readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-1',
      passphrase: null
    });

    // Yield microtasks; the gate is still closed so the read RPC has not
    // resolved. The composition must be BLOCKED on the awaited read and must
    // NOT have read the data key to decrypt yet (audit-before-decrypt).
    await Promise.resolve();
    await Promise.resolve();
    expect(getDataKeyCallsBeforeResolve).toBe(0);

    gateOpen = true;
    releaseGate();
    const r = await readPromise;
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.title).toBe(TITLE);
    expect(r.body).toBe(BODY);
  });
});

// ---------------------------------------------------------------------------
// AC-3 / F-165 — null data ⇒ unavailable; NEVER decrypt on null; wrong-pass
// and not-found map IDENTICALLY; never an invented invalid_passphrase
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — null read ⇒ unavailable, never decrypt on null (AC-3 / F-165)', () => {
  it('a null data response (wrong/absent passphrase) ⇒ unavailable AND no openUtf8 (the data key is never read)', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });

    let getDataKeyCalls = 0;
    const origGet = keyHolder.getDataKey.bind(keyHolder);
    vi.spyOn(keyHolder, 'getDataKey').mockImplementation(() => {
      getDataKeyCalls++;
      return origGet();
    });

    const reprisal = makeReprisalTransport([{ status: 200, body: { ok: true, data: null } }]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-protected',
      passphrase: 'wrong-passphrase'
    });
    expect(r.status).toBe('unavailable');
    // The decrypt path was NEVER entered — the holder's key was not consulted.
    expect(getDataKeyCalls).toBe(0);
  });

  it('not-found (also null on the wire) ⇒ the SAME unavailable — the composition cannot and does not distinguish it from wrong-passphrase', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const reprisal = makeReprisalTransport([{ status: 200, body: { ok: true, data: null } }]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-missing',
      passphrase: null
    });
    expect(r.status).toBe('unavailable');
  });

  it('NEVER returns an invented invalid_passphrase discriminant on a null read (the wire cannot substantiate it)', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const reprisal = makeReprisalTransport([{ status: 200, body: { ok: true, data: null } }]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-x',
      passphrase: 'whatever'
    });
    // The only honest surface for a null read is `unavailable`.
    expect(r.status).toBe('unavailable');
    expect(JSON.stringify(r)).not.toContain('invalid_passphrase');
  });
});

// ---------------------------------------------------------------------------
// F-164 — the passphrase is a server-side FRICTION gate, NOT the crypto gate
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — passphrase is friction, not the decrypt key (F-164)', () => {
  it('decrypts with the committee key REGARDLESS of the passphrase value — the passphrase is forwarded to the transport only, never derived into a key', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const TITLE = 'committee-key-decrypts-this';
    const BODY = 'not-the-passphrase';
    // The server already gated on the passphrase (it returned ciphertext, so
    // the passphrase was accepted). The CLIENT decrypts with the committee key
    // ONLY — the passphrase string here is unrelated to the seal key.
    const reprisal = makeReprisalTransport([
      {
        status: 200,
        body: {
          ok: true,
          data: { title_ct: sealHex(TITLE, plaintextKey), body_ct: sealHex(BODY, plaintextKey) }
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
      passphrase: 'a-completely-unrelated-string'
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.title).toBe(TITLE);
    expect(r.body).toBe(BODY);
    // The passphrase was forwarded verbatim to the transport (friction gate).
    expect(reprisal.bodies[0]?.passphrase).toBe('a-completely-unrelated-string');
  });
});

// ---------------------------------------------------------------------------
// F-148 / F-161 / F-167 — corrupt/wrong-key ciphertext ⇒ typed decrypt_failed
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — decrypt failure is fail-closed + typed (F-148 / F-161 / F-167)', () => {
  it('a too-short / corrupt title_ct ⇒ typed decrypt_failed; NEVER a thrown raw libsodium error; no Uint8Array in the surface', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const reprisal = makeReprisalTransport([
      {
        status: 200,
        body: { ok: true, data: { title_ct: '\\xdeadbeef', body_ct: '\\xdeadbeef' } }
      }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-bad',
      passphrase: null
    }).catch((e: unknown) => {
      throw new Error(
        `read must not throw on a decrypt failure; got: ${e instanceof Error ? e.constructor.name : 'unknown'}`
      );
    });
    expect(r.status).not.toBe('ok');
    if (r.status === 'failed') {
      expect(r.reason).toBe('decrypt_failed');
    }
    // The failure surface must not carry buffer bytes.
    for (const v of Object.values(r as Record<string, unknown>)) {
      expect(v instanceof Uint8Array).toBe(false);
    }
  });

  it('a title_ct sealed under a DIFFERENT key (wrong-key) ⇒ typed decrypt_failed (AEAD verify fails, fail-closed), opened plaintext is NEVER returned', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const wrongKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const reprisal = makeReprisalTransport([
      {
        status: 200,
        body: {
          ok: true,
          data: {
            title_ct: sealHex('SECRET-UNDER-WRONG-KEY', wrongKey),
            body_ct: sealHex('SECRET-BODY-UNDER-WRONG-KEY', wrongKey)
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
      id: 'r-wk',
      passphrase: null
    });
    expect(r.status).not.toBe('ok');
    // Even the surface must not echo the (unopenable) plaintext fixtures.
    const blob = JSON.stringify(r) + JSON.stringify(__getCapturedLines());
    expect(blob).not.toContain('SECRET-UNDER-WRONG-KEY');
    expect(blob).not.toContain('SECRET-BODY-UNDER-WRONG-KEY');
  });
});

// ---------------------------------------------------------------------------
// AC-6 — read 401 wipes the holder; 403 does NOT
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — read 401 vs 403 split (AC-6)', () => {
  it('a 401 on read ⇒ session_expiry AND the cached data key is zeroized', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const reprisal = makeReprisalTransport([
      { status: 401, body: { ok: false, error: 'rls_denied' } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-x',
      passphrase: null
    });
    expect(r.status).toBe('session_expiry');
    expect(Array.from(plaintextKey).every((b) => b === 0)).toBe(true);
    expect(keyHolder.isPopulated()).toBe(false);
  });

  it('a 403 on read ⇒ rls_denied AND the holder is NOT wiped', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const reprisal = makeReprisalTransport([
      { status: 403, body: { ok: false, error: 'rls_denied' } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-x',
      passphrase: null
    });
    expect(r.status).toBe('rls_denied');
    expect(keyHolder.isPopulated()).toBe(true);
    expect(Array.from(plaintextKey).some((b) => b !== 0)).toBe(true);
  });
});
