/**
 * Phase 2a PR2 / P2a-7 — `submitConcernViaProduction` (ADR-0027 Decision 3).
 * RED-FIRST (TDD): written against a composition that does NOT exist yet.
 * The implementer treats this file as READ-ONLY.
 *
 * Surface under test (the contract the implementer must satisfy):
 *
 *   submitConcernViaProduction({
 *     client:        SupabaseT07Client,        // for unwrap (if holder empty)
 *     concernClient: SupabaseConcernClient,    // for the seal-and-post
 *     keyHolder:     CommitteeKeyHolder,       // session-scoped data-key cache
 *     localIdentity: LocalIdentityStore,
 *     user_id:       string,
 *     intake:        ConcernIntake
 *   }): Promise<SubmitConcernViaProductionResult>
 *
 * Result discriminator (the union the UI pattern-matches):
 *   { status: 'ok'; id: string }
 *   | { status: 'rate_limited' }
 *   | { status: 'rls_denied' }
 *   | { status: 'session_expiry' }              // HTTP 401 path
 *   | { status: 'needs_setup' }                 // actor_has_wrap === false
 *   | { status: 'needs_recovery' }              // device privkey absent
 *   | { status: 'failed'; reason; http }
 *
 * Order of operations (binding, ADR-0027 Decision 4 / threat-model §3.16):
 *   1. If holder empty → unwrapCommitteeDataKeyViaProduction; populate via
 *      holder.set(...). Probe-FIRST guard is the unwrap composition's own
 *      invariant (never call the disclosure RPC for actor_has_wrap===false).
 *   2. Seal title + body. Seal source_name iff anonymous === false (anon
 *      default-lock, mirror concern-core.ts:133-144 server-side defense).
 *   3. POST submit. Bytea hex-encoded title_ct / body_ct (+ optional
 *      source_name_ct + source_passphrase). NO source_name_ct on the wire
 *      for anonymous submissions.
 *   4. Observe `key_id` on any op that returns one → `keyHolder
 *      .onKeyRotationObserved(returnedKeyId)` BEFORE reuse — wipes the
 *      holder when the server's key_id differs from the cached one (C2 +
 *      F-154 rotation guard). Phase 2a does not rotate, but a co-chair on
 *      another device might.
 *
 * TEST → AC / FINDING MAP
 *   AC-1 (submit round-trip)   — title/body ciphertext on the wire decrypts
 *                                back to the originals under the SAME key.
 *   AC-3 (anonymous-vs-named)  — anonymous=true ⇒ NO source_name_ct on the
 *                                wire; anonymous=false + passphrase ⇒
 *                                source_name_ct present + decrypts to name.
 *   AC-5 (named, empty name)   — anonymous=false with an empty
 *                                source_name_plaintext is REJECTED by the
 *                                composition BEFORE any submit POST (no
 *                                ciphertext crosses the wire).
 *   AC-6 (rate-limit 429)      — surfaces { status: 'rate_limited' } with NO
 *                                PI body, does NOT wipe the holder, does NOT
 *                                clear the JWT, does NOT reveal which window
 *                                tripped (no "hourly"/"daily" in the surface).
 *   AC-8 (session-expiry 401)  — 401 on submit ⇒ { status: 'session_expiry' }
 *                                AND the holder is wiped (the key buffer is
 *                                zeroized + reference nulled).
 *   AC-11 (rotation observed)  — every op that returns a key_id MUST call
 *                                keyHolder.onKeyRotationObserved(returnedKeyId);
 *                                rotation observed mid-session ⇒ the holder is
 *                                wiped + the NEXT op re-unwraps.
 *   F-149                      — the client does not put raw actor_id on the
 *                                wire — server-side `actor_id = auth.uid()`
 *                                is what we rely on; the submit body must NOT
 *                                carry an actor_id field (no client-side lie).
 *   F-148 (server-side audit)  — composition emits NO client-side audit
 *                                (the `concern.created` row is server-emitted
 *                                inside concern_submit).
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
// RED-FIRST: this import does not resolve yet. The implementer adds the
// composition + re-export from `$lib/concerns`. The exact module path is
// either `src/lib/concerns/production-flows.ts` or
// `src/lib/concerns/concern-flows.ts`; the index re-export pins the public
// name.
import { submitConcernViaProduction } from '../../src/lib/concerns';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
import { pgHexToBytes } from '../../src/lib/server-client/pg-hex';
// Real secretbox open — proves the posted ciphertext seals under the LIVE
// (rotated-to) key ONLY, never the retired key (forward secrecy, A-8.10-R).
import { openUtf8 } from '../../src/lib/concerns/seal';

await _sodium.ready;
const sodium = _sodium;

const USER = '9f4e9b40-0000-4000-8000-00000000001a'; // SYNTHETIC_USER_COCHAIR

function silentStore(): BrowserLocalIdentityStore {
  return new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
}

function bytesToPgHexLocal(b: Uint8Array): string {
  let s = '\\x';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
}

/**
 * A minimal fake "server" the mock t07 transport drives. Lets us seed an
 * actor wrap (so unwrap succeeds) and toggle the live key id (so we can
 * simulate co-chair rotation observed on another device).
 */
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
  bodies: Record<string, unknown>[];
} {
  const ops: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const transport: T07OpTransport = async (body) => {
    ops.push(String(body.op));
    bodies.push(body);
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
              wrapped_ciphertext_hex: bytesToPgHexLocal(srv.liveWrap)
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
              wrapped_ciphertext_hex: bytesToPgHexLocal(r.wrap),
              is_live: r.is_live
            }))
          }
        };
      }
      default:
        throw new Error(`makeT07Transport: unexpected op ${String(body.op)}`);
    }
  };
  return { transport, ops, bodies };
}

interface ConcernResponse {
  status: number;
  body: unknown;
  /**
   * If set, the server's response will pretend the row was written under a
   * different key_id — drives the rotation-observed branch. The submit
   * composition must call `keyHolder.onKeyRotationObserved(...)` for this.
   */
  observed_key_id?: string;
}

function makeConcernTransport(queue: ConcernResponse[]): {
  transport: ConcernOpTransport;
  bodies: Record<string, unknown>[];
  observedKeys: string[];
} {
  const bodies: Record<string, unknown>[] = [];
  const observedKeys: string[] = [];
  let i = 0;
  const transport: ConcernOpTransport = async (body) => {
    bodies.push(body);
    const r = queue[i++];
    if (!r) throw new Error(`makeConcernTransport: no response queued (call #${i})`);
    if (r.observed_key_id) observedKeys.push(r.observed_key_id);
    return { status: r.status, body: r.body };
  };
  return { transport, bodies, observedKeys };
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
// AC-1 — happy submit: ciphertext on the wire decrypts under the SAME key
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — submitConcernViaProduction happy path (AC-1)', () => {
  it('seals title + body under the unwrapped data key and posts hex ciphertext that decrypts back to the originals', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    const concern = makeConcernTransport([
      { status: 200, body: { ok: true, data: { id: 'c-1' } } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await submitConcernViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: {
        title: 'forklift struck pallet',
        body: 'no injuries; near miss in receiving',
        hazard_class: 'physical',
        severity: 'medium',
        location_id: 'L-1',
        anonymous: true
      }
    });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.id).toBe('c-1');

    // The first concern-op call was a submit; we can decrypt its ciphertext
    // back to the plaintext using the SAME data key the holder cached.
    const submitBody = concern.bodies[0];
    expect(submitBody?.op).toBe('submit');
    expect(typeof submitBody?.title_ct).toBe('string');
    expect(typeof submitBody?.body_ct).toBe('string');

    const titleCt = pgHexToBytes(submitBody!.title_ct as string);
    const bodyCt = pgHexToBytes(submitBody!.body_ct as string);
    // Decrypt the on-wire ciphertext under the same data key (oracle).
    const NONCE = sodium.crypto_secretbox_NONCEBYTES;
    const titlePt = sodium.crypto_secretbox_open_easy(
      titleCt.slice(NONCE),
      titleCt.slice(0, NONCE),
      plaintextKey
    );
    const bodyPt = sodium.crypto_secretbox_open_easy(
      bodyCt.slice(NONCE),
      bodyCt.slice(0, NONCE),
      plaintextKey
    );
    expect(Buffer.from(titlePt).toString('utf8')).toBe('forklift struck pallet');
    expect(Buffer.from(bodyPt).toString('utf8')).toBe('no injuries; near miss in receiving');
  });

  it('populates the holder from the unwrap RPC on first call when the holder is empty', async () => {
    const { t07Client, localIdentity, keyHolder, t07 } = await buildWired();
    const concern = makeConcernTransport([
      { status: 200, body: { ok: true, data: { id: 'c-2' } } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    expect(keyHolder.isPopulated()).toBe(false);
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
    // Holder was lazily populated via the unwrap composition (the t07 transport
    // saw the probe then the disclosure RPC).
    expect(t07.ops).toContain('committee_key_state');
    expect(t07.ops).toContain('get_key_wrap');
    expect(keyHolder.isPopulated()).toBe(true);
    expect(keyHolder.getDataKey()).toBeInstanceOf(Uint8Array);
  });

  it('reuses a populated holder — does NOT re-unwrap when the holder already holds a key', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey, t07 } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const concern = makeConcernTransport([
      { status: 200, body: { ok: true, data: { id: 'c-3' } } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await submitConcernViaProduction({
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
    expect(r.status).toBe('ok');
    // The unwrap composition was NOT invoked — no t07 ops at all
    // (or, defensively, no `get_key_wrap` op, because the cache is warm).
    expect(t07.ops).not.toContain('get_key_wrap');
  });
});

// ---------------------------------------------------------------------------
// AC-3 — anonymous vs named source on the wire
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — anonymous vs named submit (AC-3)', () => {
  it('anonymous=true puts NO source_name_ct on the wire (anon default-lock)', async () => {
    const { t07Client, localIdentity, keyHolder } = await buildWired();
    const concern = makeConcernTransport([
      { status: 200, body: { ok: true, data: { id: 'c-a' } } }
    ]);
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
    const submitBody = concern.bodies[0];
    expect(submitBody?.anonymous).toBe(true);
    // The transport library forwards `null` for an absent source — assert
    // the composition either omitted the field or set it to null. Critically,
    // it MUST NOT be a non-null hex string.
    expect(submitBody?.source_name_ct === null || submitBody?.source_name_ct === undefined).toBe(
      true
    );
  });

  it('anonymous=false + non-empty name seals source_name and posts it as hex ciphertext that decrypts to the name', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    const concern = makeConcernTransport([
      { status: 200, body: { ok: true, data: { id: 'c-n' } } }
    ]);
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
        anonymous: false,
        source_name_plaintext: 'CANARY-FIXTURE-NAME-DO-NOT-USE'
      }
    });
    const submitBody = concern.bodies[0];
    expect(submitBody?.anonymous).toBe(false);
    expect(typeof submitBody?.source_name_ct).toBe('string');
    const ct = pgHexToBytes(submitBody!.source_name_ct as string);
    const NONCE = sodium.crypto_secretbox_NONCEBYTES;
    const pt = sodium.crypto_secretbox_open_easy(
      ct.slice(NONCE),
      ct.slice(0, NONCE),
      plaintextKey
    );
    expect(Buffer.from(pt).toString('utf8')).toBe('CANARY-FIXTURE-NAME-DO-NOT-USE');
  });

  it('forwards source_passphrase verbatim when supplied alongside a named submit', async () => {
    const { t07Client, localIdentity, keyHolder } = await buildWired();
    const concern = makeConcernTransport([
      { status: 200, body: { ok: true, data: { id: 'c-np' } } }
    ]);
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
        anonymous: false,
        source_name_plaintext: 'someone',
        source_passphrase: 'open-sesame'
      } as unknown as import('../../src/lib/concerns/types').ConcernIntake
    });
    expect(concern.bodies[0]?.source_passphrase).toBe('open-sesame');
  });
});

// ---------------------------------------------------------------------------
// AC-5 — named submission with EMPTY name is rejected pre-submit
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — named submit with empty name is rejected (AC-5)', () => {
  it('anonymous=false + empty source_name_plaintext does NOT POST submit (defends the library, mirrors concern-core:139-142)', async () => {
    const { t07Client, localIdentity, keyHolder } = await buildWired();
    // No queued responses — if the composition POSTs we will get a
    // "no response queued" throw, which we treat as a contract violation.
    const concern = makeConcernTransport([]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await submitConcernViaProduction({
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
        anonymous: false,
        source_name_plaintext: ''
      }
    });
    // Must be a typed denial, not OK and not a thrown raw error.
    expect(r.status).not.toBe('ok');
    // No POST happened — bodies queue is empty.
    expect(concern.bodies.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-6 — rate-limit 429 surfaces with NO PI body, NO holder wipe, NO JWT clear
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — submit 429 surface (AC-6)', () => {
  it('a 429 from submit ⇒ status=rate_limited; holder NOT wiped; no PI or window-tripped hint in the surfaced result', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const concern = makeConcernTransport([
      { status: 429, body: { ok: false, error: 'rate_limited' } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await submitConcernViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: {
        title: 'CANARY-TITLE-XYZ',
        body: 'CANARY-BODY-XYZ',
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L-1',
        anonymous: true
      }
    });
    expect(r.status).toBe('rate_limited');
    // 429 is NOT a session event — holder remains populated (F-145 / AC-6).
    expect(keyHolder.isPopulated()).toBe(true);
    expect(Array.from(plaintextKey).some((b) => b !== 0)).toBe(true);

    // The returned surface must not leak which window tripped, the
    // submitted PI, or any internal limit structure.
    const blob = JSON.stringify(r);
    expect(blob.toLowerCase()).not.toContain('hourly');
    expect(blob.toLowerCase()).not.toContain('daily');
    expect(blob).not.toContain('CANARY-TITLE-XYZ');
    expect(blob).not.toContain('CANARY-BODY-XYZ');
  });
});

// ---------------------------------------------------------------------------
// AC-8 — submit 401 wipes the holder + surfaces session_expiry
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — submit 401 wipes holder (AC-8)', () => {
  it('a 401 from submit ⇒ status=session_expiry AND the cached data key is zeroized + the reference nulled', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const concern = makeConcernTransport([
      { status: 401, body: { ok: false, error: 'rls_denied' } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await submitConcernViaProduction({
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
    expect(r.status).toBe('session_expiry');
    // The exact buffer the holder cached is now all-zero, holder is empty.
    expect(Array.from(plaintextKey).every((b) => b === 0)).toBe(true);
    expect(keyHolder.isPopulated()).toBe(false);
    expect(keyHolder.getDataKey()).toBeNull();
  });

  it('a 403 from submit ⇒ status=rls_denied AND the holder is NOT wiped (rate-limit/RLS is not a session event, F-145)', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const concern = makeConcernTransport([
      { status: 403, body: { ok: false, error: 'rls_denied' } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await submitConcernViaProduction({
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
    expect(r.status).toBe('rls_denied');
    expect(keyHolder.isPopulated()).toBe(true);
    expect(Array.from(plaintextKey).some((b) => b !== 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-11 / C2 / A-8.10-R item 4 — rotation-on-submit seals under the LIVE key,
// never the retired one (forward secrecy). SUPERSEDES the old "wipe the stale
// key" case: the first submit after an observed rotation re-populates and seals
// under the NEW live key; the retired key is RETAINED (not zeroized), and the
// posted ciphertext is NEVER openable under the retired key. [requires
// F-183-R fix — the current impl seals a NEW record under the RETIRED key,
// exactly the forward-secrecy regression F-183-R exists to prevent.]
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — rotation-on-submit seals under the live key (AC-11 / A-8.10-R)', () => {
  it('the first submit, observing k-live-2 while cached at k-live-1, seals under the LIVE k-live-2 (NEVER the retired k-live-1); k-live-1 is RETAINED; the posted ciphertext opens under k-live-2 only', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey, srv, t07, kp } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });

    // A co-chair on another device rotated: the server now reports k-live-2 and
    // the multi-epoch wrap set carries the RETAINED k-live-1 (retired) + the NEW
    // live k-live-2, both sealed to the actor pubkey.
    srv.liveKeyId = 'k-live-2';
    srv.liveEpoch = 4;
    const newKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    srv.allWraps = [
      {
        key_id: 'k-live-1',
        epoch: 3,
        wrap: sodium.crypto_box_seal(plaintextKey, kp.publicKey),
        is_live: false
      },
      { key_id: 'k-live-2', epoch: 4, wrap: sodium.crypto_box_seal(newKey, kp.publicKey), is_live: true }
    ];

    const concern = makeConcernTransport([
      { status: 200, body: { ok: true, data: { id: 'c-r1' } } },
      { status: 200, body: { ok: true, data: { id: 'c-r2' } } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    await submitConcernViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: {
        title: 't1',
        body: 'b1',
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L-1',
        anonymous: true
      }
    });

    // Forward secrecy: the posted ciphertext opens under the LIVE k-live-2 ONLY,
    // NEVER the retired k-live-1. (A removed member who exfiltrated k-live-1
    // must not be able to read records filed AFTER the rotation — F-183-R.)
    const submitBody = concern.bodies[0] as { title_ct: string; body_ct: string };
    const postedTitle = pgHexToBytes(submitBody.title_ct);
    const postedBody = pgHexToBytes(submitBody.body_ct);
    await expect(openUtf8(postedTitle, newKey)).resolves.toBe('t1');
    await expect(openUtf8(postedBody, newKey)).resolves.toBe('b1');
    await expect(openUtf8(postedTitle, plaintextKey)).rejects.toThrow();
    await expect(openUtf8(postedBody, plaintextKey)).rejects.toThrow();

    // The retired k-live-1 buffer is RETAINED (add-not-wipe), not zeroized.
    expect(Array.from(plaintextKey).some((b) => b !== 0)).toBe(true);

    // A SECOND submit runs cleanly under the re-populated live key.
    await submitConcernViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: {
        title: 't2',
        body: 'b2',
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L-1',
        anonymous: true
      }
    });
    // The multi-epoch re-populate fired (gated on getKeyId() !== probe.key_id).
    expect(t07.ops).toContain('get_all_key_wraps');
    expect(keyHolder.getKeyId()).toBe('k-live-2');
    expect(keyHolder.isPopulated()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wire posture — no client-asserted actor_id on the wire (F-149)
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — wire posture (F-149)', () => {
  it('the submit body NEVER carries a client-supplied actor_id field (server enforces from auth.uid())', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const concern = makeConcernTransport([
      { status: 200, body: { ok: true, data: { id: 'c-w' } } }
    ]);
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
    const submitBody = concern.bodies[0] ?? {};
    for (const k of Object.keys(submitBody)) {
      expect(k).not.toMatch(/^actor_id$/i);
      expect(k).not.toMatch(/^user_id$/i);
    }
  });

  it('the submit body carries SEALED ciphertext on title_ct/body_ct — not plaintext (F-148 carry-forward)', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey, key_id: 'k-live-1', epoch: 3 });
    const concern = makeConcernTransport([
      { status: 200, body: { ok: true, data: { id: 'c-w2' } } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const pt = 'plaintext-canary-XYZ-1234';
    await submitConcernViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: {
        title: pt,
        body: pt,
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L-1',
        anonymous: true
      }
    });
    const submitBody = concern.bodies[0]!;
    // The plaintext canary must NOT appear in any field on the wire.
    for (const v of Object.values(submitBody)) {
      if (typeof v === 'string') expect(v).not.toContain(pt);
    }
    // The captured structured log MUST NOT contain the plaintext either.
    const logBlob = JSON.stringify(__getCapturedLines());
    expect(logBlob).not.toContain(pt);
  });
});
