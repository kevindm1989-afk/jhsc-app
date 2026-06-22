/**
 * Phase 2a PR2 / P2a-7 — `revealConcernSourceViaProduction` (ADR-0027 Decision
 * 3 / Decision 4 ceremony 3; threat-model §3.16 F-150 — reveal audit-before-
 * decrypt + AC-3/AC-4/AC-5).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
 *
 * Surface under test:
 *
 *   revealConcernSourceViaProduction({
 *     client:        SupabaseT07Client,
 *     concernClient: SupabaseConcernClient,
 *     keyHolder:     CommitteeKeyHolder,
 *     localIdentity: LocalIdentityStore,
 *     user_id:       string,
 *     id:            string,
 *     passphrase?:   string
 *   }): Promise<RevealConcernSourceViaProductionResult>
 *
 *   Result discriminator:
 *     { status: 'ok'; source_name: string }
 *     | { status: 'anonymous' }                     // server returned null ct
 *     | { status: 'invalid_passphrase' }            // 422 from reveal
 *     | { status: 'rls_denied' }                    // 403 (not session)
 *     | { status: 'session_expiry' }                // 401
 *     | { status: 'needs_setup' }                   // actor_has_wrap === false
 *     | { status: 'needs_recovery' }
 *     | { status: 'failed'; reason; http }
 *
 * Order of operations (binding; the LOAD-BEARING contract):
 *   1. Ensure holder populated (unwrap if null).
 *   2. AWAIT concernClient.revealConcernSource({ id, passphrase }) —
 *      the SERVER emits `concern.source_revealed` (audit-BEFORE-return,
 *      `00000000000004_concerns.sql:317-330`) BEFORE returning the
 *      ciphertext. The CLIENT must NOT decrypt anything until this await
 *      resolves (F-150: no eager decrypt of cached/sniffed ct before the
 *      RPC roundtrip completes — the audit is the gate).
 *   3. Then openUtf8 the returned source_name_ct under the data key.
 *   4. Observe key_id on the response → onKeyRotationObserved (C2).
 *
 * TEST → AC / FINDING MAP
 *   AC-3 / F-150 (audit-before-decrypt) — the composition does NOT openUtf8
 *                                         until the awaited RPC response
 *                                         resolves; reveal RPC is the only
 *                                         path to source_name_ct.
 *   AC-4 (anonymous)                    — null ct ⇒ { status: 'anonymous' };
 *                                         NO decrypt attempted.
 *   AC-5 (named)                        — ciphertext ⇒ openUtf8 ⇒ plaintext;
 *                                         result.source_name is the original.
 *   AC-3 (passphrase forwarded)         — the passphrase the caller supplied
 *                                         is on the wire verbatim.
 *   AC-8 (401 wipes holder)             — 401 on reveal ⇒ session_expiry +
 *                                         holder wiped.
 *   AC-11 (rotation observed)           — observed_key_id on the response ⇒
 *                                         holder.onKeyRotationObserved(...).
 *   F-148 (no plaintext in logs)        — the revealed source_name does NOT
 *                                         appear in any structured-log line.
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
// RED-FIRST: this import does not resolve yet.
import { revealConcernSourceViaProduction } from '../../src/lib/concerns';
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

function makeT07Transport(srv: FakeKeyServer): {
  transport: T07OpTransport;
  ops: string[];
} {
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

interface ConcernResponse {
  status: number;
  body: unknown;
  /**
   * If set, the response will be DELAYED until the test's resolver fires.
   * Lets us pin "the client does not decrypt before the RPC resolves".
   */
  gate?: () => Promise<void>;
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
// AC-5 — happy reveal: ciphertext returned, decrypts to original source name
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — revealConcernSourceViaProduction happy path (AC-5)', () => {
  it('returns the decrypted source_name; forwards id + passphrase verbatim on the wire', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const sourcePlaintext = 'CANARY-FIXTURE-NAME-DO-NOT-USE';
    const concern = makeConcernTransport([
      {
        status: 200,
        body: { ok: true, data: { source_name_ct: sealHex(sourcePlaintext, plaintextKey) } }
      }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await revealConcernSourceViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'c-named',
      passphrase: 'open-sesame'
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.source_name).toBe(sourcePlaintext);
    expect(concern.bodies[0]).toEqual({
      op: 'reveal',
      id: 'c-named',
      passphrase: 'open-sesame'
    });
  });
});

// ---------------------------------------------------------------------------
// AC-3 / F-150 — audit-before-decrypt: NO openUtf8 before the RPC resolves
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — audit-before-decrypt invariant (AC-3 / F-150)', () => {
  it('the composition does NOT decrypt the source until the reveal RPC has resolved (no eager decrypt; the server audit row is the gate)', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const sourcePlaintext = 'GATED-CANARY-SOURCE-NAME';

    // Track whether the data key got read by any path before the gated
    // response fires. The composition is supposed to AWAIT the response
    // first, so getDataKey should NOT be called until after we release
    // the gate.
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

    const concern = makeConcernTransport([
      {
        status: 200,
        body: { ok: true, data: { source_name_ct: sealHex(sourcePlaintext, plaintextKey) } },
        gate: () => gate
      }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const revealPromise = revealConcernSourceViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'c-named',
      passphrase: null
    });

    // Yield to the microtask queue so the composition has a chance to
    // schedule any eager decrypt. The gate is still closed → the reveal
    // RPC has not yet resolved.
    await Promise.resolve();
    await Promise.resolve();
    // If the composition's contract holds, the composition is BLOCKED on
    // the awaited reveal — and has not yet read the data key off the
    // holder to decrypt anything.
    expect(getDataKeyCallsBeforeResolve).toBe(0);

    // Now release the gate; the composition resolves the RPC + then
    // opens the ct under the data key.
    gateOpen = true;
    releaseGate();
    const r = await revealPromise;
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.source_name).toBe(sourcePlaintext);
  });

  it('the reveal RPC is the ONLY transport call the composition makes against concern-op (no list / no submit) — confirms source_name is reveal-only', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const concern = makeConcernTransport([
      {
        status: 200,
        body: { ok: true, data: { source_name_ct: sealHex('s', plaintextKey) } }
      }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    await revealConcernSourceViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'c-id',
      passphrase: 'x'
    });
    // Exactly one concern-op call, and it was the reveal.
    expect(concern.bodies.length).toBe(1);
    expect(concern.bodies[0]?.op).toBe('reveal');
  });
});

// ---------------------------------------------------------------------------
// AC-4 — anonymous: null ct ⇒ status='anonymous'; NO decrypt
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — anonymous reveal (AC-4)', () => {
  it('a null source_name_ct ⇒ status=anonymous AND no openUtf8 is attempted (no key read)', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });

    let getDataKeyCalls = 0;
    const origGet = keyHolder.getDataKey.bind(keyHolder);
    vi.spyOn(keyHolder, 'getDataKey').mockImplementation(() => {
      getDataKeyCalls++;
      return origGet();
    });

    const concern = makeConcernTransport([
      { status: 200, body: { ok: true, data: { source_name_ct: null } } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await revealConcernSourceViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'c-anon',
      passphrase: null
    });
    expect(r.status).toBe('anonymous');
    // No decrypt path ran — the holder's data key was not consulted to
    // open a (non-existent) ciphertext.
    expect(getDataKeyCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-3 (invalid passphrase) — server 422 maps to invalid_passphrase
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — invalid passphrase surface (AC-3)', () => {
  it('a 422 invalid_input from reveal ⇒ status=invalid_passphrase; no decrypt attempted', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const concern = makeConcernTransport([
      { status: 422, body: { ok: false, error: 'invalid_input' } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });
    const r = await revealConcernSourceViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'c-x',
      passphrase: 'wrong'
    });
    expect(r.status).toBe('invalid_passphrase');
    // Holder remains populated (a wrong passphrase is not a session event).
    expect(keyHolder.isPopulated()).toBe(true);
    expect(Array.from(plaintextKey).some((b) => b !== 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-8 — 401 wipes holder
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — reveal 401 wipes holder (AC-8)', () => {
  it('a 401 on reveal ⇒ session_expiry AND the cached data key is zeroized', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const concern = makeConcernTransport([
      { status: 401, body: { ok: false, error: 'rls_denied' } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });
    const r = await revealConcernSourceViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'c-x',
      passphrase: null
    });
    expect(r.status).toBe('session_expiry');
    expect(Array.from(plaintextKey).every((b) => b === 0)).toBe(true);
    expect(keyHolder.isPopulated()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F-148 — the revealed plaintext source MUST NOT land in any log surface
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — leak sweep on reveal plaintext (F-148 / AC-9)', () => {
  it('the decrypted source_name does not appear in console.* / structured-log captures across a happy reveal', async () => {
    const errs: string[] = [];
    const warns: string[] = [];
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => {
      errs.push(a.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation((...a) => {
      warns.push(a.map(String).join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation((...a) => {
      logs.push(a.map(String).join(' '));
    });

    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const SOURCE = 'CANARY-LEAK-SWEEP-NAME-9X4';
    const concern = makeConcernTransport([
      {
        status: 200,
        body: { ok: true, data: { source_name_ct: sealHex(SOURCE, plaintextKey) } }
      }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });
    const r = await revealConcernSourceViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'c-x',
      passphrase: null
    });
    expect(r.status).toBe('ok');

    const haystacks = [
      ...errs,
      ...warns,
      ...logs,
      ...__getCapturedLines().map((l) => JSON.stringify(l))
    ];
    for (const h of haystacks) {
      expect(h).not.toContain(SOURCE);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-11 / C2 — rotation observation on reveal
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — rotation observation on reveal (AC-11 / C2)', () => {
  it('observed_key_id on the reveal response ⇒ keyHolder.onKeyRotationObserved called BEFORE the next op', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });

    const rotSpy = vi.spyOn(keyHolder, 'onKeyRotationObserved');

    const concern = makeConcernTransport([
      {
        status: 200,
        body: {
          ok: true,
          data: {
            source_name_ct: sealHex('s', plaintextKey),
            key_id: 'k-live-2'
          }
        }
      }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });
    await revealConcernSourceViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'c-x',
      passphrase: null
    });
    // The composition must have surfaced the observed key_id to the holder.
    expect(rotSpy).toHaveBeenCalledWith('k-live-2');
  });
});
