/**
 * F182-2 — `unwrapAllCommitteeKeysViaProduction` (the multi-epoch POPULATE
 * flow; ADR-0030 Decision 6; threat-model §3.18 Amendment A-8.10, finding
 * F-183 — the anti-lockout keystone).
 *
 * RED-FIRST (TDD). The composition does NOT exist on `main`; `requireUnwrapAll()`
 * throws a self-documenting RED until the implementer exports it from
 * src/lib/crypto. The implementer treats this file as READ-ONLY.
 *
 * This is the sibling of `unwrapCommitteeDataKeyViaProduction` (which unwraps
 * the SINGLE live wrap). The multi-epoch version fetches ALL of the caller's
 * wraps via the F182-1 client method `getAllCommitteeKeyWrapsForSelf()`, opens
 * each SEALED wrap with the device-local identity privkey via
 * `crypto_box_seal_open`, and returns the decrypted entries for the holder's
 * `populate()` to install into its Map<key_id,{data_key,epoch,is_live}>.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * CONTRACT UNDER TEST
 * ───────────────────────────────────────────────────────────────────────────
 *   unwrapAllCommitteeKeysViaProduction({ client, localIdentity, user_id })
 *     -> { status: 'ok'; entries: Array<{ data_key: Uint8Array; key_id: string;
 *                                         epoch: number; is_live: boolean }> }
 *      | { status: 'needs_recovery' }               // device holds no identity privkey
 *      | { status: 'failed'; reason; http }         // server denial / transport fault
 *
 *   - Calls client.getAllCommitteeKeyWrapsForSelf() (op 'get_all_key_wraps', NO
 *     id parameter — F-183 (i) own-wrap-only / no-IDOR).
 *   - Opens EACH wrapped_ciphertext with the device privkey (crypto_box_seal_open,
 *     pub derived via crypto_scalarmult_base) into the entry's data_key.
 *   - Preserves key_id / epoch / is_live per row.
 *   - Empty SETOF ⇒ { status:'ok', entries:[] } (holding state — never a throw).
 *   - A wrap that FAILS to open (wrong device / corrupt bytes) is FAIL-CLOSED:
 *     SKIPPED from the entries (never a partial-garbage key in the map); the good
 *     wraps still land. NEVER an uncaught throw.
 *   - No device privkey at all ⇒ needs_recovery (route to restore, never re-enroll).
 *   - An { ok:false } server denial ⇒ { status:'failed', reason, http }.
 *   - NEVER logs key material / plaintext (F-148 carry-forward).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import {
  BrowserLocalIdentityStore,
  SupabaseT07Client,
  bytesToPgHex,
  type T07OpTransport
} from '../../src/lib/crypto';
import * as cryptoLib from '../../src/lib/crypto';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

await _sodium.ready;
const sodium = _sodium;

const USER = '9f4e9b40-0000-4000-8000-00000000001a'; // SYNTHETIC_USER_COCHAIR

// The composition's expected shape (pinned locally; the real export is absent
// on `main`, so requireUnwrapAll() produces a clean RED).
type Entry = { data_key: Uint8Array; key_id: string; epoch: number; is_live: boolean };
type UnwrapAllResult =
  | { status: 'ok'; entries: Entry[] }
  | { status: 'needs_recovery' }
  | { status: 'failed'; reason: string; http: number };
type UnwrapAllFn = (opts: {
  client: SupabaseT07Client;
  localIdentity: BrowserLocalIdentityStore;
  user_id: string;
}) => Promise<UnwrapAllResult>;

function requireUnwrapAll(): UnwrapAllFn {
  const fn = (cryptoLib as Record<string, unknown>).unwrapAllCommitteeKeysViaProduction;
  if (typeof fn !== 'function') {
    throw new Error(
      'RED (F182-2 not implemented): `unwrapAllCommitteeKeysViaProduction` is not ' +
        'exported from src/lib/crypto — the multi-epoch populate flow does not exist yet. ' +
        'It must fetch getAllCommitteeKeyWrapsForSelf() and crypto_box_seal_open each wrap ' +
        'with the device privkey into { data_key, key_id, epoch, is_live } entries.'
    );
  }
  return fn as UnwrapAllFn;
}

/** A fixed device keypair (deterministic via a fixed seed). */
function deviceKeypair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  const seed = new Uint8Array(sodium.crypto_box_SEEDBYTES).fill(9);
  return sodium.crypto_box_seed_keypair(seed);
}

/** A fresh, deterministic 32-byte committee data key. */
function mkKey(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function silentStore(): BrowserLocalIdentityStore {
  return new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
}

interface WrapRow {
  key_id: string;
  epoch: number;
  wrapped_ciphertext_hex: string;
  is_live: boolean;
}

/** Seal `dataKey` to `pub` and shape the server row the SETOF returns. */
function wrapRow(dataKey: Uint8Array, pub: Uint8Array, key_id: string, epoch: number, is_live: boolean): WrapRow {
  return {
    key_id,
    epoch,
    wrapped_ciphertext_hex: bytesToPgHex(sodium.crypto_box_seal(dataKey, pub)),
    is_live
  };
}

function makeTransport(
  responder: (body: Record<string, unknown>) => { status: number; body: unknown }
): { transport: T07OpTransport; ops: string[]; bodies: Record<string, unknown>[] } {
  const ops: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const transport: T07OpTransport = async (body) => {
    ops.push(String(body.op));
    bodies.push(body);
    return responder(body);
  };
  return { transport, ops, bodies };
}

function okAllWraps(rows: WrapRow[]) {
  return (body: Record<string, unknown>): { status: number; body: unknown } => {
    if (body.op === 'get_all_key_wraps') return { status: 200, body: { ok: true, data: rows } };
    throw new Error(`unexpected op ${String(body.op)}`);
  };
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
// KAT-6 happy — each wrap crypto_box_seal_open'd into the map, is_live preserved
// ===========================================================================
describe('F182-2 KAT-6 — populate flow opens every epoch wrap (anti-lockout retention)', () => {
  it('opens each wrap with the device privkey into { data_key, key_id, epoch, is_live } — both epochs land, is_live preserved', async () => {
    const unwrapAll = requireUnwrapAll();
    const kp = deviceKeypair();
    const dkE1 = mkKey(0x11); // retired-epoch data key
    const dkE2 = mkKey(0x22); // live-epoch data key
    const rows = [
      wrapRow(dkE1, kp.publicKey, 'k-epoch-1', 1, false),
      wrapRow(dkE2, kp.publicKey, 'k-epoch-2', 2, true)
    ];
    const { transport } = makeTransport(okAllWraps(rows));
    const localIdentity = silentStore();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    const client = new SupabaseT07Client({ transport, localIdentity });

    const r = await unwrapAll({ client, localIdentity, user_id: USER });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.entries).toHaveLength(2);
    const e1 = r.entries.find((e) => e.key_id === 'k-epoch-1');
    const e2 = r.entries.find((e) => e.key_id === 'k-epoch-2');
    // Byte-exact recovery of the ORIGINAL committee data keys (not ciphertext).
    expect(e1).toBeDefined();
    expect(Array.from(e1!.data_key)).toEqual(Array.from(dkE1));
    expect(e1!.epoch).toBe(1);
    expect(e1!.is_live).toBe(false);
    expect(e2).toBeDefined();
    expect(Array.from(e2!.data_key)).toEqual(Array.from(dkE2));
    expect(e2!.epoch).toBe(2);
    expect(e2!.is_live).toBe(true);
  });

  it('sends op get_all_key_wraps with NO id/target parameter (own-wrap-only, no IDOR)', async () => {
    const unwrapAll = requireUnwrapAll();
    const kp = deviceKeypair();
    const rows = [wrapRow(mkKey(0x22), kp.publicKey, 'k-epoch-2', 2, true)];
    const { transport, ops, bodies } = makeTransport(okAllWraps(rows));
    const localIdentity = silentStore();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    const client = new SupabaseT07Client({ transport, localIdentity });

    await unwrapAll({ client, localIdentity, user_id: USER });

    expect(ops).toContain('get_all_key_wraps');
    const body = bodies.find((b) => b.op === 'get_all_key_wraps');
    expect(body).toBeDefined();
    for (const k of Object.keys(body ?? {})) {
      expect(k).not.toMatch(/target|member|other|wrap_id|user_id|key_id/i);
    }
  });
});

// ===========================================================================
// KAT-6 fail-closed per-wrap — a corrupt / wrong-device wrap is SKIPPED
// ===========================================================================
describe('F182-2 KAT-6 — per-wrap fail-closed (no partial-garbage key in the map)', () => {
  it('a wrap that fails to open (sealed to a DIFFERENT device) is SKIPPED; the good wraps still land — never a garbage key', async () => {
    const unwrapAll = requireUnwrapAll();
    const kp = deviceKeypair();
    const otherKp = sodium.crypto_box_seed_keypair(new Uint8Array(sodium.crypto_box_SEEDBYTES).fill(7));
    const dkGood = mkKey(0x22);
    const dkUnopenable = mkKey(0x33);
    const rows = [
      wrapRow(dkGood, kp.publicKey, 'k-epoch-2', 2, true), // opens with device priv
      wrapRow(dkUnopenable, otherKp.publicKey, 'k-epoch-1', 1, false) // sealed to WRONG device
    ];
    const { transport } = makeTransport(okAllWraps(rows));
    const localIdentity = silentStore();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    const client = new SupabaseT07Client({ transport, localIdentity });

    const r = await unwrapAll({ client, localIdentity, user_id: USER });

    // Must NOT throw, must NOT include a garbage key for the unopenable wrap.
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.key_id).toBe('k-epoch-2');
    expect(Array.from(r.entries[0]!.data_key)).toEqual(Array.from(dkGood));
    // The skipped key_id never produced an entry (no partial-garbage key).
    expect(r.entries.some((e) => e.key_id === 'k-epoch-1')).toBe(false);
  });

  it('a corrupt (truncated) wrap ciphertext is SKIPPED without throwing', async () => {
    const unwrapAll = requireUnwrapAll();
    const kp = deviceKeypair();
    const dkGood = mkKey(0x22);
    const goodRow = wrapRow(dkGood, kp.publicKey, 'k-epoch-2', 2, true);
    const corruptRow: WrapRow = {
      key_id: 'k-epoch-1',
      epoch: 1,
      wrapped_ciphertext_hex: bytesToPgHex(new Uint8Array([0x00, 0x01, 0x02])), // too short to open
      is_live: false
    };
    const { transport } = makeTransport(okAllWraps([goodRow, corruptRow]));
    const localIdentity = silentStore();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    const client = new SupabaseT07Client({ transport, localIdentity });

    const r = await unwrapAll({ client, localIdentity, user_id: USER });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.entries.map((e) => e.key_id)).toEqual(['k-epoch-2']);
  });
});

// ===========================================================================
// KAT-6 edge/error — holding state, needs_recovery, server denial
// ===========================================================================
describe('F182-2 KAT-6 — holding state / recovery / denial', () => {
  it('an EMPTY SETOF ⇒ { status: ok, entries: [] } (holding state — never a throw)', async () => {
    const unwrapAll = requireUnwrapAll();
    const kp = deviceKeypair();
    const { transport } = makeTransport(okAllWraps([]));
    const localIdentity = silentStore();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    const client = new SupabaseT07Client({ transport, localIdentity });

    const r = await unwrapAll({ client, localIdentity, user_id: USER });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.entries).toEqual([]);
  });

  it('a server-side wrap with NO device privkey ⇒ needs_recovery (route to restore, never re-enroll)', async () => {
    const unwrapAll = requireUnwrapAll();
    const kp = deviceKeypair();
    const rows = [wrapRow(mkKey(0x22), kp.publicKey, 'k-epoch-2', 2, true)];
    const { transport } = makeTransport(okAllWraps(rows));
    const localIdentity = silentStore(); // NO privkey stored for USER
    const client = new SupabaseT07Client({ transport, localIdentity });

    const r = await unwrapAll({ client, localIdentity, user_id: USER });

    expect(r.status).toBe('needs_recovery');
    if (r.status === 'ok') expect.unreachable('needs_recovery must not produce entries');
  });

  it('an { ok:false } server denial (403 rls_denied) ⇒ typed failure, never throws', async () => {
    const unwrapAll = requireUnwrapAll();
    const kp = deviceKeypair();
    const { transport } = makeTransport((body) => {
      if (body.op === 'get_all_key_wraps') {
        return { status: 403, body: { ok: false, error: 'rls_denied' } };
      }
      throw new Error(`unexpected op ${String(body.op)}`);
    });
    const localIdentity = silentStore();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    const client = new SupabaseT07Client({ transport, localIdentity });

    const r = await unwrapAll({ client, localIdentity, user_id: USER });

    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('rls_denied');
    expect(r.http).toBe(403);
  });
});

// ===========================================================================
// KAT-6 privacy — the populate flow leaks no key material (F-148)
// ===========================================================================
describe('F182-2 KAT-6 — populate flow leaks no key material (F-148)', () => {
  it('neither the recovered committee data keys nor the device privkey appear in console.* / structured logs', async () => {
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

    const unwrapAll = requireUnwrapAll();
    const kp = deviceKeypair();
    const dkE1 = mkKey(0x11);
    const dkE2 = mkKey(0x22);
    const rows = [
      wrapRow(dkE1, kp.publicKey, 'k-epoch-1', 1, false),
      wrapRow(dkE2, kp.publicKey, 'k-epoch-2', 2, true)
    ];
    const { transport } = makeTransport(okAllWraps(rows));
    const localIdentity = silentStore();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    const client = new SupabaseT07Client({ transport, localIdentity });

    const r = await unwrapAll({ client, localIdentity, user_id: USER });
    expect(r.status).toBe('ok');

    const haystacks = [
      ...errs,
      ...warns,
      ...logs,
      ...__getCapturedLines().map((l) => JSON.stringify(l))
    ];
    for (const h of haystacks) {
      expect(h).not.toContain(sodium.to_hex(dkE1));
      expect(h).not.toContain(sodium.to_hex(dkE2));
      expect(h).not.toContain(sodium.to_hex(kp.privateKey));
    }

    errSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });
});
