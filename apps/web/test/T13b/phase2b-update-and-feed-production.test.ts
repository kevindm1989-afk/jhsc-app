/**
 * Phase 2b PR1 / P2b-2 — `updateReprisalViaProduction` + `listReprisalFeedVia
 * Production` (ADR-0028 Decision 3; threat-model §3.17 F-166 feed-has-no-
 * ciphertext-no-actor / C3 trivial, F-161 leak carry-forward).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
 *
 * Surfaces under test:
 *
 *   updateReprisalViaProduction({
 *     reprisalClient, t07Client, keyHolder, localIdentity, user_id,
 *     id, title?, body?
 *   }): Promise<UpdateReprisalViaProductionResult>
 *     { status: 'ok' }
 *     | { status: 'rate_limited' } | { status: 'rls_denied' }
 *     | { status: 'session_expiry' } | { status: 'needs_setup' }
 *     | { status: 'needs_recovery' }
 *     | { status: 'failed'; reason: string; http: number }
 *
 *   listReprisalFeedViaProduction({ reprisalClient }):
 *     Promise<ListReprisalFeedViaProductionResult>
 *     { status: 'ok'; items: ReprisalFeedRow[] }
 *     | { status: 'session_expiry' }
 *     | { status: 'failed'; reason: string; http: number }
 *
 * Feed contract (ADR-0028 Decision 3 / F-166): the reprisal_feed view is
 * ALREADY pseudonymized — NO actor_pseudonym, NO ciphertext, ts bucketed to the
 * hour. So the feed composition:
 *   - does NOT call ensureHolderPopulated (no key needed);
 *   - never hits the disclosure RPC (get_key_wrap);
 *   - never calls openUtf8;
 *   - the returned shape structurally MUST NOT contain a raw actor_id or any
 *     *_ct ciphertext field.
 *
 * TEST → AC / FINDING MAP
 *   AC (update happy)        — update seals only the provided fields, POSTs
 *                              { op:'update' }, returns { status:'ok' }.
 *   AC (update typed fails)  — 404 ⇒ failed/not_found; 401 ⇒ session_expiry +
 *                              holder wiped; 403 ⇒ rls_denied + holder kept.
 *   AC-4 / F-166 (feed shape)— feed returns ReprisalFeedRow[] with
 *                              ts_bucketed_to_hour, NO actor_pseudonym/actor_id,
 *                              NO ciphertext; no openUtf8; no holder/unwrap;
 *                              get_key_wrap NOT hit.
 *   AC-4 (feed typed fail)   — a non-200 surfaces a typed failure (not a throw).
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
  type ReprisalFeedRow,
  type ReprisalOpTransport
} from '../../src/lib/reprisal/supabase-reprisal-client';
// RED-FIRST: these imports do not resolve yet.
import {
  listReprisalFeedViaProduction,
  updateReprisalViaProduction
} from '../../src/lib/reprisal/production-flows';
import { __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
import { pgHexToBytes } from '../../src/lib/server-client/pg-hex';

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
// update — happy: seals only the provided fields, POSTs update
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — updateReprisalViaProduction happy path', () => {
  it('seals only the provided body field and POSTs { op: update } with sealed body_ct that decrypts back', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const reprisal = makeReprisalTransport([{ status: 200, body: { ok: true, data: null } }]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await updateReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-1',
      body: 'corrected reprisal account'
    });
    expect(r.status).toBe('ok');

    const updateBody = reprisal.bodies[0]!;
    expect(updateBody.op).toBe('update');
    expect(updateBody.id).toBe('r-1');
    // Only body was provided → title_ct must be omitted (NULL = unchanged).
    expect(updateBody.title_ct).toBeUndefined();
    expect(typeof updateBody.body_ct).toBe('string');

    const bytes = pgHexToBytes(updateBody.body_ct as string);
    const NONCE = sodium.crypto_secretbox_NONCEBYTES;
    const pt = sodium.crypto_secretbox_open_easy(
      bytes.slice(NONCE),
      bytes.slice(0, NONCE),
      plaintextKey
    );
    expect(Buffer.from(pt).toString('utf8')).toBe('corrected reprisal account');
  });

  it('seals BOTH title and body when both are provided', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const reprisal = makeReprisalTransport([{ status: 200, body: { ok: true, data: null } }]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    await updateReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-1',
      title: 'new title',
      body: 'new body'
    });
    const updateBody = reprisal.bodies[0]!;
    expect(typeof updateBody.title_ct).toBe('string');
    expect(typeof updateBody.body_ct).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// update — typed failure surfaces
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — updateReprisalViaProduction typed failures', () => {
  it('a 404 not_found ⇒ a typed failure (never a thrown error)', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const reprisal = makeReprisalTransport([
      { status: 404, body: { ok: false, error: 'not_found' } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await updateReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'missing',
      body: 'x'
    });
    expect(r.status).not.toBe('ok');
    if (r.status === 'failed') {
      expect(r.http).toBe(404);
    }
  });

  it('a 401 ⇒ session_expiry AND the holder is wiped', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const reprisal = makeReprisalTransport([
      { status: 401, body: { ok: false, error: 'rls_denied' } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await updateReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-1',
      body: 'x'
    });
    expect(r.status).toBe('session_expiry');
    expect(Array.from(plaintextKey).every((b) => b === 0)).toBe(true);
    expect(keyHolder.isPopulated()).toBe(false);
  });

  it('a 403 ⇒ rls_denied AND the holder is NOT wiped', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const reprisal = makeReprisalTransport([
      { status: 403, body: { ok: false, error: 'rls_denied' } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await updateReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-1',
      body: 'x'
    });
    expect(r.status).toBe('rls_denied');
    expect(keyHolder.isPopulated()).toBe(true);
    expect(Array.from(plaintextKey).some((b) => b !== 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-4 / F-166 — feed: pseudonymized, no ciphertext, no holder/unwrap
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — listReprisalFeedViaProduction shape + C3 (AC-4 / F-166)', () => {
  it('returns ReprisalFeedRow[] with ts_bucketed_to_hour and NO actor_pseudonym/actor_id and NO ciphertext field; no openUtf8; no holder/unwrap (disclosure RPC NOT hit)', async () => {
    // No t07 transport calls expected at all for a feed read — wire a t07
    // transport that throws if touched, to prove the feed needs no key.
    const localIdentity = silentStore();
    const t07ThrowingOps: string[] = [];
    const t07Client = new SupabaseT07Client({
      transport: async (body) => {
        t07ThrowingOps.push(String(body.op));
        throw new Error(`AC-4 / F-166 violation: t07-op ${String(body.op)} hit on a feed read`);
      },
      localIdentity
    });
    const keyHolder = new CommitteeKeyHolder();

    const sample: ReprisalFeedRow = {
      id: 1,
      event_type: 'reprisal.created',
      ts_bucketed_to_hour: 1748400000000,
      target_id: '00000000-0000-0000-0000-000000000001',
      target_class: 'C4',
      prev_hash: 'aabb',
      hash: 'ccdd'
    };
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: [sample] } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await listReprisalFeedViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.items.length).toBe(1);

    // The feed read must not have touched the key surface at all.
    expect(t07ThrowingOps.length).toBe(0);
    expect(keyHolder.isPopulated()).toBe(false);

    // Structural privacy assertions over EVERY returned row.
    for (const row of r.items) {
      expect(row.ts_bucketed_to_hour).toBeTypeOf('number');
      const keys = Object.keys(row as Record<string, unknown>);
      // NO raw actor identity of any spelling.
      expect(keys).not.toContain('actor_pseudonym');
      expect(keys).not.toContain('actor_id');
      // NO ciphertext columns.
      for (const k of keys) {
        expect(k.endsWith('_ct')).toBe(false);
      }
    }
  });

  it('the feed makes exactly ONE reprisal-op call ({ op: feed }) and decrypts nothing', async () => {
    const { t07Client, localIdentity, keyHolder } = await buildWired();
    const reprisal = makeReprisalTransport([{ status: 200, body: { ok: true, data: [] } }]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    await listReprisalFeedViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER
    });
    expect(reprisal.bodies.length).toBe(1);
    expect(reprisal.bodies[0]).toEqual({ op: 'feed' });
  });

  it('a non-200 feed response surfaces a typed failure (not a thrown error); a 401 surfaces session_expiry', async () => {
    const { t07Client, localIdentity, keyHolder } = await buildWired();
    const reprisalErr = makeReprisalTransport([
      { status: 403, body: { ok: false, error: 'rls_denied' } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisalErr.transport });

    const r = await listReprisalFeedViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER
    }).catch((e: unknown) => {
      throw new Error(
        `feed must not throw on an error response; got ${e instanceof Error ? e.constructor.name : 'unknown'}`
      );
    });
    expect(r.status).not.toBe('ok');

    const { t07Client: c2, localIdentity: li2, keyHolder: kh2 } = await buildWired();
    const reprisal401 = makeReprisalTransport([
      { status: 401, body: { ok: false, error: 'rls_denied' } }
    ]);
    const r401 = await listReprisalFeedViaProduction({
      reprisalClient: new SupabaseReprisalClient({ transport: reprisal401.transport }),
      t07Client: c2,
      keyHolder: kh2,
      localIdentity: li2,
      user_id: USER
    });
    expect(r401.status).toBe('session_expiry');
  });
});
