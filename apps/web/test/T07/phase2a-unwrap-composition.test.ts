/**
 * Phase 2a PR1 — `unwrapCommitteeDataKeyViaProduction` (ADR-0027 Decision 2,
 * the committee-key-unwrap composition shared by every Phase 2 E2EE feature).
 * RED-FIRST (TDD): written against a function + client method that do NOT
 * exist yet. The file MUST fail at import/binding time until the implementer
 * adds:
 *   - `SupabaseT07Client.getCommitteeKeyWrapForSelf()` (P2a-2), and
 *   - `unwrapCommitteeDataKeyViaProduction(...)` exported from
 *     `src/lib/crypto` (P2a-3).
 * The implementer treats this file as READ-ONLY.
 *
 * Surface under test (Decision 2 / Decision 7 / threat-model §3.16):
 *   unwrapCommitteeDataKeyViaProduction({ client, localIdentity, user_id })
 *     -> { status: 'ok'; data_key: Uint8Array(32); key_id; epoch }
 *      | { status: 'no_wrap' }            // probe says actor_has_wrap=false
 *      | { status: 'needs_recovery' }     // device has no identity privkey
 *      | { status: 'failed'; reason; http }
 *
 * Hermetic: a mock t07 transport with op-capture that faithfully simulates
 * the live committee key + the sealed wrap row; a real
 * BrowserLocalIdentityStore (SSR Map fallback); real libsodium. No real
 * clock, no real network, no seeded RNG (we capture the exact bytes
 * libsodium hands out / seal a KNOWN key as the stored wrap).
 *
 * ───────────────────────────────────────────────────────────────────────
 * TEST → AC / FINDING MAP
 * ───────────────────────────────────────────────────────────────────────
 *   AC-7  / F-144 — probe-first: actor_has_wrap=false ⇒ the disclosure RPC
 *                   (`get_key_wrap`) is NEVER hit; composition → 'no_wrap'.
 *   AC-3  / F-151 — the composition emits NO client-side audit (the unwrap
 *                   audit row is server-emitted by the fused RPC only).
 *   F-142         — happy unwrap round-trip: the bytes recovered === the
 *                   EXACT 32-byte key originally sealed into the stored wrap.
 *   F-142         — sealed-scope: a WRONG device privkey cannot open the wrap
 *                   (proves a server/A5 compromise sees only ciphertext).
 *   F-148         — leak sweep: across an unwrap, neither the plaintext data
 *                   key nor the device privkey appears in console.* / thrown
 *                   error messages / the structured-log surface.
 *   F-144         — needs_recovery: server wrap present, device privkey absent.
 *   AC-8  / F-130 — 401 mapped to a session-expiry failure; 403 distinct.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import {
  BrowserLocalIdentityStore,
  SupabaseT07Client,
  type T07OpTransport
} from '../../src/lib/crypto';
// RED-FIRST: these imports do not resolve yet — the implementer adds the
// function + re-export. Importing them here pins the public name + signature.
import { unwrapCommitteeDataKeyViaProduction } from '../../src/lib/crypto';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

await _sodium.ready;
const sodium = _sodium;

const USER = '9f4e9b40-0000-4000-8000-00000000001a'; // SYNTHETIC_USER_COCHAIR
const WRONG = '9f4e9b40-0000-4000-8000-00000000000b'; // SYNTHETIC_USER_B

function bytesToPgHex(b: Uint8Array): string {
  let s = '\\x';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
}

function silentStore(): BrowserLocalIdentityStore {
  return new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
}

/**
 * In-memory committee-key "server" the mock transport drives. It models
 * exactly the two reads the composition needs: the metadata probe
 * (`committee_key_state`, no key material) and the NEW key-material
 * disclosure RPC (`get_key_wrap` → the actor's own sealed wrap bytes).
 *
 * `liveWrap` is the SEALED-box of a KNOWN 32-byte plaintext (`plaintextKey`)
 * to the actor's device pubkey — i.e. exactly what `committee_key_wraps`
 * stores at rest. The round-trip test asserts the composition recovers
 * `plaintextKey` byte-for-byte.
 */
interface FakeKeyServer {
  liveKeyId: string | null;
  liveEpoch: number;
  actorHasWrap: boolean;
  liveWrap: Uint8Array | null; // sealed ciphertext for the actor
  plaintextKey: Uint8Array | null; // the 32 bytes the wrap seals (oracle)
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

/** Seal a fresh KNOWN 32-byte key to `pub` and stash it as the actor's wrap. */
function seedWrap(srv: FakeKeyServer, pub: Uint8Array): Uint8Array {
  const plaintext = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  srv.plaintextKey = plaintext;
  srv.liveWrap = sodium.crypto_box_seal(plaintext, pub);
  return plaintext;
}

function makeTransport(srv: FakeKeyServer): {
  transport: T07OpTransport;
  ops: string[];
  bodies: Record<string, unknown>[];
} {
  const ops: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const transport: T07OpTransport = async (body) => {
    ops.push(String(body.op));
    bodies.push(body);
    switch (body.op) {
      case 'committee_key_state': {
        if (!srv.liveKeyId) return { status: 200, body: { ok: true, data: null } };
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
      case 'get_key_wrap': {
        // The NEW disclosure RPC. Returns the actor's own sealed wrap ONLY.
        if (!srv.liveKeyId || !srv.liveWrap) {
          return { status: 200, body: { ok: true, data: null } };
        }
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
      default:
        throw new Error(`makeTransport: unexpected op ${String(body.op)}`);
    }
  };
  return { transport, ops, bodies };
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
// AC-7 / F-144 — probe-first: no-wrap actor NEVER hits the disclosure RPC
// ---------------------------------------------------------------------------

describe('Phase 2a — probe-first guard (AC-7 / F-144)', () => {
  it('AC-7: actor_has_wrap=false ⇒ get_key_wrap is NEVER called and the result is no_wrap', async () => {
    const srv = newServer();
    srv.actorHasWrap = false; // metadata probe says the actor holds no wrap
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    const r = await unwrapCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER
    });

    // The disclosure RPC must not be hit for a member with no wrap (Decision 7
    // probe-first; F-144). The metadata probe alone is allowed.
    expect(ops).not.toContain('get_key_wrap');
    expect(ops).toContain('committee_key_state');
    expect(r.status).toBe('no_wrap');
  });

  it('F-144 (no-wrap branch): the disclosure RPC returning null also maps to no_wrap and yields no data key', async () => {
    const srv = newServer();
    srv.actorHasWrap = true; // probe says yes …
    srv.liveWrap = null; // … but the disclosure RPC finds no row (race)
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    const r = await unwrapCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER
    });

    expect(r.status).toBe('no_wrap');
    if (r.status === 'ok') expect.unreachable('no_wrap branch must not produce a data key');
  });
});

// ---------------------------------------------------------------------------
// F-142 — happy unwrap: byte-exact round-trip of the originally-sealed key
// ---------------------------------------------------------------------------

describe('Phase 2a — unwrap round-trip (F-142 / AC-1 precondition)', () => {
  it('recovers the EXACT 32 bytes originally sealed into the stored wrap', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    // Seal a KNOWN key as the stored wrap; capture the oracle plaintext.
    const known = seedWrap(srv, kp.publicKey);

    const r = await unwrapCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER
    });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(ops).toContain('get_key_wrap');
    expect(r.data_key).toBeInstanceOf(Uint8Array);
    expect(r.data_key.length).toBe(32);
    expect(Array.from(r.data_key)).toEqual(Array.from(known));
    expect(r.key_id).toBe(srv.liveKeyId);
    expect(r.epoch).toBe(srv.liveEpoch);
  });

  it('does NOT zeroize the returned data key (the holder owns the lifecycle — Decision 2 step 5)', async () => {
    // Contrast with initCommitteeDataKeyViaProduction, which zeroizes. Here
    // the holder takes ownership by reference, so the composition MUST hand
    // back live bytes (a premature .fill(0) here would defeat the cache).
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    const known = seedWrap(srv, kp.publicKey);

    const r = await unwrapCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    // The returned buffer is the real key (not all-zero) — at least one
    // non-zero byte exists, and it matches the oracle.
    expect(Array.from(r.data_key).some((b) => b !== 0)).toBe(true);
    expect(Array.from(r.data_key)).toEqual(Array.from(known));
  });
});

// ---------------------------------------------------------------------------
// F-142 — sealed-scope: server/A5 compromise sees only ciphertext
// ---------------------------------------------------------------------------

describe('Phase 2a — sealed-scope of the disclosed wrap (F-142)', () => {
  it('a WRONG device privkey cannot open the wrap ⇒ failed/decrypt_failed (only the actor key opens it)', async () => {
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    // Seal the wrap to the ACTOR's pubkey …
    const actorKp = sodium.crypto_box_keypair();
    seedWrap(srv, actorKp.publicKey);
    // … but the device store holds a DIFFERENT (wrong) privkey for USER.
    const wrongKp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, wrongKp.privateKey);

    const r = await unwrapCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER
    });

    // The disclosed bytes are SEALED ciphertext: opening with the wrong key
    // fails (AEAD), it does not silently mis-decrypt. Surface as a typed
    // failure, never a thrown raw exception.
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('decrypt_failed');
  });

  it('the bytes that cross the wire are the SEALED wrap, not the 32-byte plaintext', async () => {
    const srv = newServer();
    const { transport, bodies } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    const known = seedWrap(srv, kp.publicKey);

    await unwrapCommitteeDataKeyViaProduction({ client, localIdentity, user_id: USER });

    // What the server returned (and the client transported) is SEALBYTES
    // longer than the 32-byte plaintext — proves it is ciphertext, never the
    // raw key. (Structural confirmation against the FakeKeyServer's wrap.)
    expect((srv.liveWrap as Uint8Array).length).toBe(32 + sodium.crypto_box_SEALBYTES);
    expect((srv.liveWrap as Uint8Array).length).not.toBe(32);
    // The disclosure op was a read with NO id parameter to abuse (no IDOR).
    const getWrapBody = bodies.find((b) => b.op === 'get_key_wrap');
    expect(getWrapBody).toBeDefined();
    for (const k of Object.keys(getWrapBody ?? {})) {
      expect(k).not.toMatch(/target|member|user_id|wrap_id|key_id/i);
    }
    // The plaintext oracle is 32 bytes; the wire artifact is not it.
    expect((srv.liveWrap as Uint8Array).length).not.toBe(known.length);
  });
});

// ---------------------------------------------------------------------------
// AC-3 / F-151 — the composition emits NO client-side audit
// ---------------------------------------------------------------------------

describe('Phase 2a — no client-side audit on unwrap (AC-3 / F-151)', () => {
  it('the composition does NOT call the client unwrap-audit op (record_unwrap) — the fused RPC owns the audit row', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    seedWrap(srv, kp.publicKey);

    const r = await unwrapCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER
    });

    expect(r.status).toBe('ok');
    // The audit row is emitted SERVER-SIDE inside get_committee_key_wrap_for_self
    // (audit-before-return). The client must NOT separately call the legacy
    // audit-only op — that would double-count and is the two-call dance the
    // fused RPC collapses (F-151).
    expect(ops).not.toContain('record_unwrap');
  });
});

// ---------------------------------------------------------------------------
// F-148 — leak sweep across an unwrap (data key + device privkey)
// ---------------------------------------------------------------------------

describe('Phase 2a — key-material leak sweep on unwrap (F-148 / AC-9)', () => {
  it('neither the plaintext data key nor the device privkey appears in console.* / thrown errors / structured logs', async () => {
    const errs: string[] = [];
    const warns: string[] = [];
    const logs: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      errs.push(a.map(String).join(' '));
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a) => {
      warns.push(a.map(String).join(' '));
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      logs.push(a.map(String).join(' '));
    });

    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    const known = seedWrap(srv, kp.publicKey);

    const r = await unwrapCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER
    });
    expect(r.status).toBe('ok');

    const keyHex = sodium.to_hex(known);
    const privHex = sodium.to_hex(kp.privateKey);
    const haystacks = [
      ...errs,
      ...warns,
      ...logs,
      ...__getCapturedLines().map((l) => JSON.stringify(l))
    ];
    for (const h of haystacks) {
      expect(h).not.toContain(keyHex);
      expect(h).not.toContain(privHex);
    }

    errSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('on a decrypt failure the thrown/returned surface carries no key material (typed failure, no raw exception)', async () => {
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const actorKp = sodium.crypto_box_keypair();
    seedWrap(srv, actorKp.publicKey);
    const wrongKp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, wrongKp.privateKey);

    // Must resolve to a typed failure, NOT throw (a thrown libsodium error
    // could carry buffer bytes in its message/stack — F-148).
    const r = await unwrapCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER
    }).catch((e: unknown) => {
      throw new Error(
        `unwrap must not throw on decrypt failure; got: ${e instanceof Error ? e.constructor.name : 'unknown'}`
      );
    });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    // The failure object is metadata only — no Uint8Array leaks into it.
    for (const v of Object.values(r as Record<string, unknown>)) {
      expect(v instanceof Uint8Array).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// F-144 — needs_recovery: server wrap present, device privkey absent
// ---------------------------------------------------------------------------

describe('Phase 2a — needs_recovery branch (F-144)', () => {
  it('a server-side wrap with NO device privkey returns needs_recovery (route to restore, never re-enroll)', async () => {
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    // Seal a wrap to SOME pubkey, but store NO privkey for USER on the device.
    const someKp = sodium.crypto_box_keypair();
    seedWrap(srv, someKp.publicKey);

    const r = await unwrapCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER
    });

    expect(r.status).toBe('needs_recovery');
    if (r.status === 'ok') expect.unreachable('needs_recovery must not produce a data key');
  });
});

// ---------------------------------------------------------------------------
// AC-8 / F-130 — 401 vs 403 split surfaced distinctly
// ---------------------------------------------------------------------------

describe('Phase 2a — 401 vs 403 split on the unwrap path (AC-8 / F-130)', () => {
  it('a 401 on the disclosure RPC surfaces failed/401 (session-expiry path)', async () => {
    const srv = newServer();
    srv.actorHasWrap = true;
    const transport: T07OpTransport = async (body) => {
      if (body.op === 'committee_key_state') {
        return {
          status: 200,
          body: {
            ok: true,
            data: { key_id: srv.liveKeyId, epoch: srv.liveEpoch, wrap_count: 1, actor_has_wrap: true }
          }
        };
      }
      if (body.op === 'get_key_wrap') {
        return { status: 401, body: { ok: false, error: 'rls_denied' } };
      }
      throw new Error(`unexpected op ${String(body.op)}`);
    };
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    const r = await unwrapCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER
    });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.http).toBe(401);
  });

  it('a 403 rls_denied is surfaced distinctly (different http on the result)', async () => {
    const srv = newServer();
    srv.actorHasWrap = true;
    const transport: T07OpTransport = async (body) => {
      if (body.op === 'committee_key_state') {
        return {
          status: 200,
          body: {
            ok: true,
            data: { key_id: srv.liveKeyId, epoch: srv.liveEpoch, wrap_count: 1, actor_has_wrap: true }
          }
        };
      }
      if (body.op === 'get_key_wrap') {
        return { status: 403, body: { ok: false, error: 'rls_denied' } };
      }
      throw new Error(`unexpected op ${String(body.op)}`);
    };
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    const r = await unwrapCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER
    });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.http).toBe(403);
    expect(r.reason).toBe('rls_denied');
  });
});

// ---------------------------------------------------------------------------
// P2a-2 — SupabaseT07Client.getCommitteeKeyWrapForSelf (client method)
// ---------------------------------------------------------------------------

describe('Phase 2a — SupabaseT07Client.getCommitteeKeyWrapForSelf (P2a-2)', () => {
  it('decodes the hex wrap to bytes and carries no id parameter on the wire (own-wrap-only)', async () => {
    const srv = newServer();
    const { transport, bodies } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    const known = seedWrap(srv, kp.publicKey);

    const r = await client.getCommitteeKeyWrapForSelf();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).not.toBeNull();
    if (!r.data) return;
    expect(r.data.wrapped_ciphertext).toBeInstanceOf(Uint8Array);
    expect(Array.from(r.data.wrapped_ciphertext)).toEqual(Array.from(srv.liveWrap as Uint8Array));
    expect(r.data.key_id).toBe(srv.liveKeyId);
    expect(r.data.epoch).toBe(srv.liveEpoch);
    // The wrap opens with the actor privkey to the oracle key.
    const opened = sodium.crypto_box_seal_open(
      r.data.wrapped_ciphertext,
      kp.publicKey,
      kp.privateKey
    );
    expect(Array.from(opened)).toEqual(Array.from(known));

    // No IDOR-able parameter is sent: the op carries no target/member/id field.
    const body = bodies.find((b) => b.op === 'get_key_wrap');
    expect(body).toBeDefined();
    for (const k of Object.keys(body ?? {})) {
      expect(k).not.toMatch(/target|member|other|wrap_id|user_id/i);
    }
    // The WRONG user's privkey cannot open the disclosed wrap.
    expect(() =>
      sodium.crypto_box_seal_open(
        r.data!.wrapped_ciphertext,
        sodium.crypto_box_keypair().publicKey,
        sodium.crypto_box_keypair().privateKey
      )
    ).toThrow();
    void WRONG;
  });

  it('returns { ok:true, data:null } when the actor has no wrap row (not an error)', async () => {
    const srv = newServer();
    srv.liveWrap = null;
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });

    const r = await client.getCommitteeKeyWrapForSelf();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toBeNull();
  });
});
