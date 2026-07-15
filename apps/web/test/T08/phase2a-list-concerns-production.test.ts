/**
 * Phase 2a PR2 / P2a-7 — `listConcernsViaProduction` (ADR-0027 Decision 3
 * + Decision 5 view-widening; threat-model §3.16 F-149 PI projection + F-150
 * source excluded from list).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
 *
 * Surface under test:
 *
 *   listConcernsViaProduction({
 *     client:        SupabaseT07Client,
 *     concernClient: SupabaseConcernClient,
 *     keyHolder:     CommitteeKeyHolder,
 *     localIdentity: LocalIdentityStore,
 *     user_id:       string
 *   }): Promise<ListConcernsViaProductionResult>
 *
 *   Result discriminator:
 *     { status: 'ok'; items: ListedConcern[] }
 *     | { status: 'needs_setup' }                 // actor_has_wrap === false
 *     | { status: 'needs_recovery' }
 *     | { status: 'session_expiry' }              // 401
 *     | { status: 'failed'; reason; http }
 *
 *   ListedConcern (the UI render shape — Decision 4/5/6):
 *     {
 *       id: string;
 *       title: string;                            // decrypted client-side
 *       body: string;                             // decrypted client-side
 *       hazard_class: string;
 *       severity: string;
 *       location_id: string;
 *       created_at: string;
 *       actor_pseudonym: string;                  // pseudonym, NOT raw actor_id
 *       has_named_source: boolean;
 *       anonymous_default_kept: boolean;
 *       days_since_filed: number;                 // CLIENT-derived from created_at
 *     }
 *
 *   FORBIDDEN keys on the rendered row: `actor_id`, `status`,
 *   `source_name_ct`. The first is the PI projection change (F-149); the
 *   second is Decision 6 (no status in Phase 2a); the third is F-18 +
 *   F-150 (the source is only obtainable via reveal).
 *
 * TEST → AC / FINDING MAP
 *   AC-2 (list decrypts)          — title/body decrypt round-trip;
 *                                   actor_pseudonym present, NO actor_id, NO
 *                                   status, days_since_filed client-derived.
 *   AC-4 (anonymous indicator)    — anonymous row carries
 *                                   has_named_source=false +
 *                                   anonymous_default_kept=true; named row
 *                                   the opposite.
 *   F-149 (PI projection)         — no raw `actor_id` key on the listed row.
 *   F-150 (source excluded list)  — no `source_name_ct` key on the listed
 *                                   row (F-18 carry-forward).
 *   AC-11 (rotation observed)     — a probe/list observation of a NEWER
 *                                   key_id wipes the holder + the NEXT op
 *                                   re-unwraps.
 *   AC-8 (401 wipes holder)       — a 401 on list ⇒ session_expiry + holder
 *                                   wiped.
 *   AC-7 (no committee key guard) — actor_has_wrap=false ⇒ needs_setup AND
 *                                   `get_key_wrap` is NEVER called.
 *
 * Hermetic: real libsodium; mock t07-op + concern-op; real
 * BrowserLocalIdentityStore SSR fallback; real CommitteeKeyHolder; structured-
 * log test sink.
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
import { listConcernsViaProduction, submitConcernViaProduction } from '../../src/lib/concerns';
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

function makeT07Transport(srv: FakeKeyServer): {
  transport: T07OpTransport;
  ops: string[];
} {
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
              wrapped_ciphertext_hex: bytesToPgHex(srv.liveWrap)
            }
          }
        };
      case 'get_all_key_wraps': {
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
      default:
        throw new Error(`unexpected op ${String(body.op)}`);
    }
  };
  return { transport, ops };
}

interface ConcernResponse {
  status: number;
  body: unknown;
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
    return { status: r.status, body: r.body };
  };
  return { transport, bodies };
}

/** Seal a UTF-8 plaintext under the key (the on-wire shape: nonce + ct). */
function seal(pt: string, key: Uint8Array): string {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ptBytes = new Uint8Array(Buffer.from(pt, 'utf8'));
  const ct = sodium.crypto_secretbox_easy(ptBytes, nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return bytesToPgHex(out);
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
// AC-2 — decryption + projection shape
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — listConcernsViaProduction decrypt + shape (AC-2 / F-149 / F-150)', () => {
  it('round-trips title + body decryption and exposes the rendered shape (pseudonym + has_named_source + days_since_filed); NO actor_id, NO status, NO source_name_ct', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });

    // Two seeded rows, both filed 7 days before the current Date.now().
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const rowsFromView = [
      {
        id: 'c-1',
        title_ct: seal('A — forklift incident', plaintextKey),
        body_ct: seal('No injuries; near miss.', plaintextKey),
        hazard_class: 'physical',
        severity: 'medium',
        location_id: 'L-1',
        created_at: sevenDaysAgo,
        actor_pseudonym: 'abc123def4567890',
        anonymous_default_kept: true,
        has_named_source: false
      },
      {
        id: 'c-2',
        title_ct: seal('B — chemical splash', plaintextKey),
        body_ct: seal('Minor irritation reported.', plaintextKey),
        hazard_class: 'chemical',
        severity: 'high',
        location_id: 'L-2',
        created_at: sevenDaysAgo,
        actor_pseudonym: 'fedcba0987654321',
        anonymous_default_kept: false,
        has_named_source: true
      }
    ];
    const concern = makeConcernTransport([
      { status: 200, body: { ok: true, data: rowsFromView } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.items.length).toBe(2);

    // (1) Decrypts to the original plaintexts.
    expect(r.items[0]!.title).toBe('A — forklift incident');
    expect(r.items[0]!.body).toBe('No injuries; near miss.');
    expect(r.items[1]!.title).toBe('B — chemical splash');
    expect(r.items[1]!.body).toBe('Minor irritation reported.');

    // (2) Required keys present.
    for (const item of r.items) {
      expect(typeof item.actor_pseudonym).toBe('string');
      expect(typeof item.has_named_source).toBe('boolean');
      expect(typeof item.anonymous_default_kept).toBe('boolean');
      expect(typeof item.days_since_filed).toBe('number');
      // days_since_filed derived client-side from created_at — for our 7-day
      // seed it must round to 7 (or 6/7 if the seal/await crossed a boundary).
      expect(item.days_since_filed).toBeGreaterThanOrEqual(6);
      expect(item.days_since_filed).toBeLessThanOrEqual(8);
    }

    // (3) FORBIDDEN keys absent (F-149 / Decision 6 / F-150 carry-forward).
    for (const item of r.items) {
      const keys = Object.keys(item);
      expect(keys).not.toContain('actor_id');
      expect(keys).not.toContain('status');
      expect(keys).not.toContain('source_name_ct');
      // The on-wire ciphertext columns are NOT re-exposed under the
      // *_ct names either — only the decrypted `title` / `body`.
      expect(keys).not.toContain('title_ct');
      expect(keys).not.toContain('body_ct');
    }
  });

  it('AC-4: an anonymous row reports has_named_source=false AND anonymous_default_kept=true; a named row reports the opposite', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const nowIso = new Date().toISOString();
    const rowsFromView = [
      {
        id: 'a',
        title_ct: seal('t', plaintextKey),
        body_ct: seal('b', plaintextKey),
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L',
        created_at: nowIso,
        actor_pseudonym: 'p1',
        anonymous_default_kept: true,
        has_named_source: false
      },
      {
        id: 'n',
        title_ct: seal('t', plaintextKey),
        body_ct: seal('b', plaintextKey),
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L',
        created_at: nowIso,
        actor_pseudonym: 'p2',
        anonymous_default_kept: false,
        has_named_source: true
      }
    ];
    const concern = makeConcernTransport([
      { status: 200, body: { ok: true, data: rowsFromView } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });
    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const anon = r.items.find((i) => i.id === 'a')!;
    const named = r.items.find((i) => i.id === 'n')!;
    expect(anon.has_named_source).toBe(false);
    expect(anon.anonymous_default_kept).toBe(true);
    expect(named.has_named_source).toBe(true);
    expect(named.anonymous_default_kept).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-7 — probe-first guard on the list path
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — list with no committee key (AC-7)', () => {
  it('actor_has_wrap=false ⇒ needs_setup; the disclosure RPC + concern-op list are NEVER called', async () => {
    const { t07Client, localIdentity, keyHolder, srv, t07 } = await buildWired();
    srv.actorHasWrap = false;
    const concern = makeConcernTransport([]); // unused; an unexpected call throws
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    });
    expect(r.status).toBe('needs_setup');
    expect(t07.ops).not.toContain('get_key_wrap');
    expect(concern.bodies.length).toBe(0);
    expect(keyHolder.isPopulated()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-8 — 401 wipes the holder
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — list 401 wipes holder (AC-8)', () => {
  it('a 401 on list ⇒ session_expiry AND the cached key is zeroized; 403 does NOT wipe', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const concern401 = makeConcernTransport([
      { status: 401, body: { ok: false, error: 'rls_denied' } }
    ]);
    const concernClient401 = new SupabaseConcernClient({ transport: concern401.transport });
    const r401 = await listConcernsViaProduction({
      client: t07Client,
      concernClient: concernClient401,
      keyHolder,
      localIdentity,
      user_id: USER
    });
    expect(r401.status).toBe('session_expiry');
    expect(Array.from(plaintextKey).every((b) => b === 0)).toBe(true);
    expect(keyHolder.isPopulated()).toBe(false);
  });

  it('a 403 on list does NOT wipe the holder (rls_denied is not a session event)', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const concern = makeConcernTransport([
      { status: 403, body: { ok: false, error: 'rls_denied' } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });
    await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    });
    expect(keyHolder.isPopulated()).toBe(true);
    expect(Array.from(plaintextKey).some((b) => b !== 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-11 / C2 / A-8.10-R item 3 — rotation observation on the list path is
// ADD-not-wipe. SUPERSEDES the old "probe observing a NEWER key_id WIPES the
// holder" case: the stale key is RETAINED for reads, a NEW live key is added
// via the multi-epoch re-populate, and a pre-rotation row STILL opens.
// [requires F-183-R fix]
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — rotation observation on list is add-not-wipe (AC-11 / A-8.10-R)', () => {
  it('the probe observing a NEWER key_id (holder cached the OLD key, not held) RETAINS the stale key, re-populates the new live key via get_all_key_wraps, and a pre-rotation row still opens', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey, srv, t07, kp } = await buildWired();
    // Cache the OLD key_id on the holder; the probe will report k-live-2 (which
    // the holder does NOT hold).
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-OLD', epoch: 2 });
    srv.liveKeyId = 'k-live-2';
    srv.liveEpoch = 5;

    // The re-populate path fetches ALL wraps: the RETAINED old epoch (k-live-OLD,
    // still opens pre-rotation rows) + the NEW live epoch (k-live-2). Both sealed
    // to the actor pubkey.
    const newKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    srv.allWraps = [
      {
        key_id: 'k-live-OLD',
        epoch: 2,
        wrap: sodium.crypto_box_seal(plaintextKey, kp.publicKey),
        is_live: false
      },
      { key_id: 'k-live-2', epoch: 5, wrap: sodium.crypto_box_seal(newKey, kp.publicKey), is_live: true }
    ];

    // A pre-rotation concern row, sealed under the OLD epoch key — it MUST still
    // open after the re-populate (the retained old-epoch key survives; a
    // `.set()`-based repopulate would discard it → F-183 lockout).
    const nowIso = new Date().toISOString();
    const rowsFromView = [
      {
        id: 'c-pre',
        title_ct: seal('pre-rotation title', plaintextKey),
        body_ct: seal('pre-rotation body', plaintextKey),
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

    // F-145-C (A-8.10-R2-a): the ORIGINAL .set() buffer reference IS zeroized once
    // populate() orphans it (identity-compare orphan-wipe). Anti-lockout is NOT
    // proven by this buffer's bytes surviving — it is a property of the holder's
    // MAP, proven at map granularity by the pre-rotation-row round-trip below
    // (:524-531): the retired k-live-OLD epoch is re-installed as a FRESH buffer
    // and STILL opens the pre-rotation row. That round-trip is the correct proof;
    // the byte proxy here was redundant AND wrong under F-145-C.
    expect(Array.from(plaintextKey).every((b) => b === 0)).toBe(true);
    // The multi-epoch re-populate fired (NOT a no-op) — gated on
    // getKeyId() !== probe.key_id, via `get_all_key_wraps` + `populate()`.
    expect(t07.ops).toContain('get_all_key_wraps');
    // The holder ended under the NEW live key, with a live sealing key.
    expect(keyHolder.getKeyId()).toBe('k-live-2');
    expect(keyHolder.hasLiveKey()).toBe(true);
    // Anti-lockout: the pre-rotation row STILL opens via trial-decrypt over the
    // RETAINED old-epoch key.
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.items.length).toBe(1);
      expect(r.items[0]!.title).toBe('pre-rotation title');
      expect(r.items[0]!.body).toBe('pre-rotation body');
    }
  });
});

// ---------------------------------------------------------------------------
// Wire posture — list rows MUST NOT carry source_name_ct (F-150 / F-18)
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — list wire posture (F-150 / F-18)', () => {
  it('even if the server somehow returned source_name_ct on a list row, the composition strips it (defense-in-depth — the source is reveal-only)', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const nowIso = new Date().toISOString();
    const rogueRow = {
      id: 'c-rogue',
      title_ct: seal('t', plaintextKey),
      body_ct: seal('b', plaintextKey),
      hazard_class: 'physical',
      severity: 'low',
      location_id: 'L',
      created_at: nowIso,
      actor_pseudonym: 'p',
      anonymous_default_kept: false,
      has_named_source: true,
      // ROGUE — must not propagate.
      source_name_ct: seal('CANARY-SOURCE-NAME', plaintextKey)
    };
    const concern = makeConcernTransport([
      { status: 200, body: { ok: true, data: [rogueRow] } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const keys = Object.keys(r.items[0]!);
    expect(keys).not.toContain('source_name_ct');
    expect(JSON.stringify(r.items[0])).not.toContain('CANARY-SOURCE-NAME');
  });
});

// ---------------------------------------------------------------------------
// Finding-1 (F182-2 panel, HIGH) — the per-row hint on the list path must NOT
// demote the live key to an OLDER epoch.
// ---------------------------------------------------------------------------
// `listConcernsViaProduction` feeds every row's `key_id` to
// `keyHolder.redesignateLiveIfHeld` (production-flows.ts:433-435). Lists are
// newest-first, so the OLDEST (pre-rotation, RETIRED-epoch) row is processed
// LAST. Because `redesignateLiveIfHeld` ignores `epoch` today
// (committee-key-holder.ts:328-337), that last row deterministically demotes
// the live designation onto the RETIRED epoch whenever ≥1 pre-rotation row is
// present — so the holder ends the list with a retired sealing key (forward-
// secrecy regression; threat-model re-pass trigger #8).
//
// RED expectation against b891cf5:
//   - Test 1 FAILS — after a list whose oldest row carries k-epoch-1, the
//     holder's live key is wrongly k-epoch-1 (getKeyId/getEpoch/getDataKey).
//   - Test 2 FAILS — a subsequent submit is forced to burn a self-heal round
//     trip (`get_all_key_wraps`) to recover the live epoch the list corrupted;
//     the fixed impl leaves the holder correct so the submit needs no re-fetch.
//
// Determinism: fixed 32-byte fill keys (no seeded-RNG dependence for the epoch
// keys); assertions are on holder state / decrypt round-trips / op-invocation,
// never on raw ciphertext bytes. created_at uses the harness's Date.now() seed
// exactly as the sibling tests do (no clock control needed — days_since_filed
// is not asserted here). No real network (mock t07 + concern transports).
// ---------------------------------------------------------------------------

/** A fixed, deterministic 32-byte secretbox key (never asserted on raw bytes). */
function mkEpochKey(byte: number): Uint8Array {
  return new Uint8Array(sodium.crypto_secretbox_KEYBYTES).fill(byte);
}

describe('Phase 2a PR2 — Finding-1: a pre-rotation (retired-epoch) list row never demotes the live key (F182-2 / A-8.10-R)', () => {
  it('after a newest-first list whose OLDEST row carries the RETIRED k-epoch-1, the holder live key stays k-epoch-2 (never demotes to the retired epoch)', async () => {
    const { t07Client, localIdentity, keyHolder, srv, t07, kp } = await buildWired();
    // The server (authoritative probe) reports epoch-2 live — matches the
    // holder's live below, so the list's own ensure does NOT self-heal.
    srv.liveKeyId = 'k-epoch-2';
    srv.liveEpoch = 2;

    // The realistic post-rotation holding state (the self-heal result): the
    // RETIRED epoch-1 read key + the LIVE epoch-2 key, held by reference.
    const kE1 = mkEpochKey(0x11);
    const kE2 = mkEpochKey(0x22);
    keyHolder.populate([
      { data_key: kE1, key_id: 'k-epoch-1', epoch: 1, is_live: false },
      { data_key: kE2, key_id: 'k-epoch-2', epoch: 2, is_live: true }
    ]);

    // Newest-first list: a NEW (epoch-2) row first, then a PRE-ROTATION (epoch-1)
    // row LAST — the row order that deterministically triggers the demote bug.
    const nowIso = new Date().toISOString();
    const rowsNewestFirst = [
      {
        id: 'c-new',
        title_ct: seal('post-rotation title', kE2),
        body_ct: seal('post-rotation body', kE2),
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L-2',
        created_at: nowIso,
        actor_pseudonym: 'p-new',
        anonymous_default_kept: true,
        has_named_source: false,
        key_id: 'k-epoch-2'
      },
      {
        id: 'c-pre',
        title_ct: seal('pre-rotation title', kE1),
        body_ct: seal('pre-rotation body', kE1),
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L-1',
        created_at: nowIso,
        actor_pseudonym: 'p-pre',
        anonymous_default_kept: true,
        has_named_source: false,
        key_id: 'k-epoch-1' // the RETIRED epoch — processed LAST
      }
    ];
    const concern = makeConcernTransport([
      { status: 200, body: { ok: true, data: rowsNewestFirst } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    });

    // Both rows open (anti-lockout via trial-decrypt over both epochs).
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.items.length).toBe(2);

    // Finding-1: the live sealing key MUST remain the NEWEST held epoch. The
    // retired-epoch row hint processed last must NOT have demoted it.
    expect(keyHolder.getKeyId()).toBe('k-epoch-2');
    expect(keyHolder.getEpoch()).toBe(2);
    expect(keyHolder.getDataKey()).toBe(kE2); // the epoch-2 buffer, by reference
    expect(keyHolder.hasLiveKey()).toBe(true);
    // The list did not trigger any self-heal re-fetch (probe matched live).
    expect(t07.ops).not.toContain('get_all_key_wraps');
    void kp; // (kp is only exercised by the submit sibling test)
  });

  it('a submit issued right after that list seals under the LIVE k-epoch-2 (never the retired k-epoch-1) WITHOUT burning a self-heal re-fetch', async () => {
    const { t07Client, localIdentity, keyHolder, srv, t07, kp } = await buildWired();
    srv.liveKeyId = 'k-epoch-2';
    srv.liveEpoch = 2;

    const kE1 = mkEpochKey(0x11);
    const kE2 = mkEpochKey(0x22);
    keyHolder.populate([
      { data_key: kE1, key_id: 'k-epoch-1', epoch: 1, is_live: false },
      { data_key: kE2, key_id: 'k-epoch-2', epoch: 2, is_live: true }
    ]);
    // Back the potential (buggy-path) self-heal so it reconstructs the SAME
    // epoch bytes — this keeps the forward-secrecy assertion meaningful whether
    // or not a self-heal fires; the RED signal is that a self-heal fires AT ALL.
    srv.allWraps = [
      { key_id: 'k-epoch-1', epoch: 1, wrap: sodium.crypto_box_seal(kE1, kp.publicKey), is_live: false },
      { key_id: 'k-epoch-2', epoch: 2, wrap: sodium.crypto_box_seal(kE2, kp.publicKey), is_live: true }
    ];

    const nowIso = new Date().toISOString();
    const rowsNewestFirst = [
      {
        id: 'c-pre',
        title_ct: seal('pre-rotation title', kE1),
        body_ct: seal('pre-rotation body', kE1),
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L-1',
        created_at: nowIso,
        actor_pseudonym: 'p-pre',
        anonymous_default_kept: true,
        has_named_source: false,
        key_id: 'k-epoch-1' // retired-epoch hint — corrupts live under the bug
      }
    ];
    const concern = makeConcernTransport([
      { status: 200, body: { ok: true, data: rowsNewestFirst } },
      { status: 200, body: { ok: true, data: { id: 'c-created' } } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    });

    // Ops recorded strictly DURING the submit (isolate the submit-phase probe).
    const opsBeforeSubmit = t07.ops.length;
    const submitRes = await submitConcernViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: {
        title: 'brand-new-concern-title',
        body: 'brand-new-concern-body',
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L-3',
        anonymous: true
      }
    });
    const submitOps = t07.ops.slice(opsBeforeSubmit);

    expect(submitRes.status).toBe('ok');

    // RED discriminator: the submit must NOT need a self-heal re-fetch. A correct
    // list leaves the holder on the live epoch, so the submit's probe matches and
    // `get_all_key_wraps` is never hit. Under the bug the list demoted live to
    // epoch-1, forcing the submit to burn a recovery round trip.
    expect(submitOps).not.toContain('get_all_key_wraps');

    // Forward-secrecy invariant (must hold regardless): the posted ciphertext
    // seals under the LIVE epoch-2 key and NEVER opens under the retired epoch-1.
    const submitBody = concern.bodies.find(
      (b) => typeof (b as { title_ct?: unknown }).title_ct === 'string'
    ) as { title_ct: string } | undefined;
    expect(submitBody).toBeDefined();
    if (submitBody) {
      await expect(openUtf8(pgHexToBytes(submitBody.title_ct), kE2)).resolves.toBe(
        'brand-new-concern-title'
      );
      await expect(openUtf8(pgHexToBytes(submitBody.title_ct), kE1)).rejects.toThrow();
    }
  });
});
