/**
 * Phase 2b PR1 / P2b-2 — worker-without-Phase-0a guard + holder-reuse +
 * 401/403 split (ADR-0028 AC-5 / AC-6 / AC-9; threat-model §3.17 F-163 probe-
 * first / 401-wipe-403-no-wipe).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
 *
 * The CONTRACT (mirrors the concerns guard, reprisal-tuned):
 *   - Every KEY-USING composition (submit, read, update) MUST consult the cheap
 *     state probe (getCommitteeKeyState) FIRST. If actor_has_wrap === false the
 *     composition short-circuits to { status: 'needs_setup' } and
 *       - does NOT call the disclosure RPC (get_key_wrap), and
 *       - does NOT call the reprisal-op transport at all.
 *   - A 401 from any reprisal-op call wipes the holder (buffer zeroized +
 *     reference nulled) + surfaces session_expiry. A 403 does NOT wipe.
 *   - Holder reuse: two sequential key-using ops in one session unwrap ONCE
 *     (one get_key_wrap); a sign-out wipe forces a re-unwrap on the next op.
 *
 * NOTE: the feed composition (listReprisalFeedViaProduction) deliberately does
 * NOT run the probe / hold a key (F-166 — no ciphertext on the feed); its
 * no-holder posture is asserted in phase2b-update-and-feed-production.test.ts,
 * NOT here.
 *
 * TEST → AC / FINDING MAP
 *   AC-5 / F-163 — submit / read / update short-circuit to needs_setup when
 *                  actor_has_wrap === false; disclosure RPC + reprisal-op NEVER
 *                  reached.
 *   AC-9        — holder reused across two ops (one unwrap); re-unwrap after a
 *                  sign-out wipe.
 *   AC-6        — 401 wipes; 403 does not (asserted across submit + read).
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
// RED-FIRST imports — implementer adds the compositions + re-exports.
import {
  readReprisalViaProduction,
  submitReprisalViaProduction,
  updateReprisalViaProduction
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

function makeT07TransportNoWrap(): { transport: T07OpTransport; ops: string[] } {
  const ops: string[] = [];
  const transport: T07OpTransport = async (body) => {
    ops.push(String(body.op));
    if (body.op === 'committee_key_state') {
      return {
        status: 200,
        body: {
          ok: true,
          data: { key_id: 'k-live-1', epoch: 3, wrap_count: 0, actor_has_wrap: false }
        }
      };
    }
    if (body.op === 'get_key_wrap') {
      throw new Error(
        'AC-5 / F-163 violation: get_key_wrap called even though the probe said actor_has_wrap=false'
      );
    }
    throw new Error(`unexpected op ${String(body.op)}`);
  };
  return { transport, ops };
}

function makeNoCallReprisalTransport(): {
  transport: ReprisalOpTransport;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  const transport: ReprisalOpTransport = async (body) => {
    bodies.push(body);
    throw new Error(
      `AC-5 / F-163 violation: reprisal-op called (${String(body.op)}) for a no-wrap actor`
    );
  };
  return { transport, bodies };
}

interface FullKeyServer {
  liveKeyId: string;
  liveEpoch: number;
  liveWrap: Uint8Array | null;
}
function makeT07TransportFull(srv: FullKeyServer): { transport: T07OpTransport; ops: string[] } {
  const ops: string[] = [];
  const transport: T07OpTransport = async (body) => {
    ops.push(String(body.op));
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
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            key_id: srv.liveKeyId,
            epoch: srv.liveEpoch,
            wrapped_ciphertext_hex: bytesToPgHex(srv.liveWrap!)
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

beforeEach(() => {
  __resetCapture();
  __setTestSink();
});

afterEach(() => {
  __resetCapture();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC-5 / F-163 — probe-first needs_setup short-circuit
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — worker-without-Phase-0a guard (AC-5 / F-163)', () => {
  it('submitReprisalViaProduction with actor_has_wrap=false ⇒ needs_setup; disclosure RPC + reprisal-op NEVER called', async () => {
    const { transport: t07Transport, ops } = makeT07TransportNoWrap();
    const localIdentity = silentStore();
    const t07Client = new SupabaseT07Client({ transport: t07Transport, localIdentity });
    const reprisal = makeNoCallReprisalTransport();
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });
    const keyHolder = new CommitteeKeyHolder();

    const r = await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: { title: 't', body: 'b', passphrase: 'p' }
    });
    expect(r.status).toBe('needs_setup');
    expect(ops).not.toContain('get_key_wrap');
    expect(reprisal.bodies.length).toBe(0);
    expect(keyHolder.isPopulated()).toBe(false);
  });

  it('readReprisalViaProduction with actor_has_wrap=false ⇒ needs_setup; disclosure RPC + reprisal-op NEVER called', async () => {
    const { transport: t07Transport, ops } = makeT07TransportNoWrap();
    const localIdentity = silentStore();
    const t07Client = new SupabaseT07Client({ transport: t07Transport, localIdentity });
    const reprisal = makeNoCallReprisalTransport();
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });
    const keyHolder = new CommitteeKeyHolder();

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-x',
      passphrase: null
    });
    expect(r.status).toBe('needs_setup');
    expect(ops).not.toContain('get_key_wrap');
    expect(reprisal.bodies.length).toBe(0);
    expect(keyHolder.isPopulated()).toBe(false);
  });

  it('updateReprisalViaProduction with actor_has_wrap=false ⇒ needs_setup; disclosure RPC + reprisal-op NEVER called', async () => {
    const { transport: t07Transport, ops } = makeT07TransportNoWrap();
    const localIdentity = silentStore();
    const t07Client = new SupabaseT07Client({ transport: t07Transport, localIdentity });
    const reprisal = makeNoCallReprisalTransport();
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });
    const keyHolder = new CommitteeKeyHolder();

    const r = await updateReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-x',
      body: 'b'
    });
    expect(r.status).toBe('needs_setup');
    expect(ops).not.toContain('get_key_wrap');
    expect(reprisal.bodies.length).toBe(0);
    expect(keyHolder.isPopulated()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-9 — holder reuse: one unwrap across two ops; re-unwrap after a wipe
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — holder reuse / single unwrap (AC-9)', () => {
  async function buildFull() {
    const localIdentity = silentStore();
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    const dataKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const srv: FullKeyServer = {
      liveKeyId: 'k-live-1',
      liveEpoch: 3,
      liveWrap: sodium.crypto_box_seal(dataKey, kp.publicKey)
    };
    const { transport, ops } = makeT07TransportFull(srv);
    const t07Client = new SupabaseT07Client({ transport, localIdentity });
    const keyHolder = new CommitteeKeyHolder();
    return { localIdentity, t07Client, keyHolder, ops, dataKey };
  }

  it('two sequential submits in one session hit get_key_wrap exactly ONCE (the holder is reused)', async () => {
    const { localIdentity, t07Client, keyHolder, ops } = await buildFull();
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { id: 'r-1' } } },
      { status: 200, body: { ok: true, data: { id: 'r-2' } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    for (const title of ['first', 'second']) {
      const r = await submitReprisalViaProduction({
        reprisalClient,
        t07Client,
        keyHolder,
        localIdentity,
        user_id: USER,
        intake: { title, body: 'b', passphrase: 'p' }
      });
      expect(r.status).toBe('ok');
    }
    const unwrapCount = ops.filter((o) => o === 'get_key_wrap').length;
    expect(unwrapCount).toBe(1);
  });

  it('a sign-out wipe between ops forces a SECOND get_key_wrap on the next op', async () => {
    const { localIdentity, t07Client, keyHolder, ops } = await buildFull();
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { id: 'r-1' } } },
      { status: 200, body: { ok: true, data: { id: 'r-2' } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: { title: 'first', body: 'b', passphrase: 'p' }
    });
    // Sign-out wipes the holder (trigger 1).
    keyHolder.onSignOut();
    expect(keyHolder.isPopulated()).toBe(false);

    await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: { title: 'second', body: 'b', passphrase: 'p' }
    });
    const unwrapCount = ops.filter((o) => o === 'get_key_wrap').length;
    expect(unwrapCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC-6 — 401 wipes; 403 does not (cross-composition)
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — 401 wipe / 403 no-wipe split (AC-6)', () => {
  async function buildPopulated() {
    const localIdentity = silentStore();
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
    const dataKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const srv: FullKeyServer = {
      liveKeyId: 'k-live-1',
      liveEpoch: 3,
      liveWrap: sodium.crypto_box_seal(dataKey, kp.publicKey)
    };
    const { transport } = makeT07TransportFull(srv);
    const t07Client = new SupabaseT07Client({ transport, localIdentity });
    const keyHolder = new CommitteeKeyHolder();
    keyHolder.set({ data_key: dataKey, key_id: 'k-live-1', epoch: 3 });
    return { localIdentity, t07Client, keyHolder, dataKey };
  }

  it('a 401 on read wipes the holder (buffer zeroized + reference nulled) and surfaces session_expiry', async () => {
    const { localIdentity, t07Client, keyHolder, dataKey } = await buildPopulated();
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
    expect(Array.from(dataKey).every((b) => b === 0)).toBe(true);
    expect(keyHolder.isPopulated()).toBe(false);
    expect(keyHolder.getDataKey()).toBeNull();
  });

  it('a 403 on submit does NOT wipe the holder and does NOT clear the cached key (the buffer is still non-zero)', async () => {
    const { localIdentity, t07Client, keyHolder, dataKey } = await buildPopulated();
    const reprisal = makeReprisalTransport([
      { status: 403, body: { ok: false, error: 'rls_denied' } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });
    const r = await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: { title: 't', body: 'b', passphrase: 'p' }
    });
    expect(r.status).toBe('rls_denied');
    expect(keyHolder.isPopulated()).toBe(true);
    expect(Array.from(dataKey).some((b) => b !== 0)).toBe(true);
  });
});
