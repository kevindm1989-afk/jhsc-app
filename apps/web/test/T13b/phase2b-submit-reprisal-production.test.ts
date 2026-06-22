/**
 * Phase 2b PR1 / P2b-2 — `submitReprisalViaProduction` (ADR-0028 Decision 3;
 * threat-model §3.17 F-161 / F-163 / F-164 / F-167).
 *
 * RED-FIRST (TDD): written against a composition that does NOT exist yet
 * (`apps/web/src/lib/reprisal/production-flows.ts`). The implementer treats
 * this file as READ-ONLY and writes code to satisfy it.
 *
 * Surface under test (the contract the implementer must satisfy):
 *
 *   submitReprisalViaProduction({
 *     reprisalClient: SupabaseReprisalClient,   // for the seal-and-POST submit
 *     t07Client:      SupabaseT07Client,        // for the probe + lazy unwrap
 *     keyHolder:      CommitteeKeyHolder,        // session-scoped data-key cache
 *     localIdentity:  LocalIdentityStore,
 *     user_id:        string,
 *     intake:         ReprisalIntake             // { title, body, passphrase }
 *   }): Promise<SubmitReprisalViaProductionResult>
 *
 * Result discriminator (the union the UI pattern-matches; mirrors the concerns
 * SubmitConcernViaProductionResult MINUS the anonymous-default-lock branch):
 *   { status: 'ok'; id: string }
 *   | { status: 'rate_limited' }
 *   | { status: 'rls_denied' }
 *   | { status: 'session_expiry' }              // HTTP 401 path
 *   | { status: 'needs_setup' }                 // actor_has_wrap === false
 *   | { status: 'needs_recovery' }
 *   | { status: 'failed'; reason: string; http: number }
 *
 * Reprisal-specific contract notes (ADR-0028 Findings / Decision 3):
 *   - There is NO anonymous mode on reprisal — every row records actor_id
 *     server-side. The intake ALWAYS has an author; there is NO source-name
 *     seal. Only title + body are sealed.
 *   - `intake.passphrase` is the per-record FRICTION gate (F-164). It is
 *     forwarded VERBATIM to `reprisalClient.submitReprisal({ passphrase })`
 *     and NEVER used as a decryption key, NEVER logged (F-161).
 *
 * TEST → AC / FINDING MAP
 *   AC-1 (submit round-trip)  — title/body ciphertext on the wire decrypts
 *                               back to the originals under the SAME committee
 *                               key (proves the SHARED concerns/seal.ts scheme,
 *                               not a fork — F-167).
 *   AC-5 / F-163 (probe-first)— actor_has_wrap === false ⇒ needs_setup; the
 *                               disclosure RPC (get_key_wrap) is NEVER hit and
 *                               NO submit POST is made.
 *   AC-7 (rate-limit 429)     — surfaces rate_limited, holder NOT wiped, no PI
 *                               in the surface, no window-tripped hint.
 *   AC-6 (401 vs 403)         — 401 ⇒ session_expiry + holder wiped; 403 ⇒
 *                               rls_denied + holder NOT wiped.
 *   AC-8 / F-161              — the wire carries SEALED title_ct/body_ct, never
 *                               plaintext; the passphrase is forwarded but the
 *                               plaintext title/body/passphrase never land in a
 *                               structured-log line (full sweep is in
 *                               phase2b-key-material-leak-sweep.test.ts).
 *   F-164                     — passphrase forwarded verbatim; the wire never
 *                               carries a client-asserted actor_id.
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
// RED-FIRST: this import does not resolve yet. The implementer adds the
// composition in `src/lib/reprisal/production-flows.ts` and re-exports it from
// `$lib/reprisal` (the index re-export pins the public name).
import { submitReprisalViaProduction } from '../../src/lib/reprisal/production-flows';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
import { pgHexToBytes } from '../../src/lib/server-client/pg-hex';

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

interface FakeKeyServer {
  liveKeyId: string;
  liveEpoch: number;
  actorHasWrap: boolean;
  liveWrap: Uint8Array | null;
  plaintextKey: Uint8Array | null;
}

function newServer(overrides: Partial<FakeKeyServer> = {}): FakeKeyServer {
  return {
    liveKeyId: 'k-live-1',
    liveEpoch: 3,
    actorHasWrap: true,
    liveWrap: null,
    plaintextKey: null,
    ...overrides
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
      default:
        throw new Error(`makeT07Transport: unexpected op ${String(body.op)}`);
    }
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
    if (!r) throw new Error(`makeReprisalTransport: no response queued (call #${i})`);
    return { status: r.status, body: r.body };
  };
  return { transport, bodies };
}

async function buildWired(srvOverrides: Partial<FakeKeyServer> = {}) {
  const srv = newServer(srvOverrides);
  const t07 = makeT07Transport(srv);
  const localIdentity = silentStore();
  const t07Client = new SupabaseT07Client({ transport: t07.transport, localIdentity });
  const kp = sodium.crypto_box_keypair();
  await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);
  const plaintextKey = srv.actorHasWrap ? seedWrap(srv, kp.publicKey) : null;
  const keyHolder = new CommitteeKeyHolder();
  return { srv, t07, localIdentity, t07Client, keyHolder, kp, plaintextKey };
}

function openHex(hex: string, key: Uint8Array): string {
  const bytes = pgHexToBytes(hex);
  const NONCE = sodium.crypto_secretbox_NONCEBYTES;
  const pt = sodium.crypto_secretbox_open_easy(bytes.slice(NONCE), bytes.slice(0, NONCE), key);
  return Buffer.from(pt).toString('utf8');
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

describe('Phase 2b PR1 — submitReprisalViaProduction happy path (AC-1)', () => {
  it('seals title + body under the unwrapped committee key and POSTs hex ciphertext that decrypts back to the originals', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { id: 'r-1' } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: {
        title: 'supervisor cut my hours after I raised the guard issue',
        body: 'detailed timeline of the retaliation follows',
        passphrase: 'per-record-friction-gate'
      }
    });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.id).toBe('r-1');

    const submitBody = reprisal.bodies[0];
    expect(submitBody?.op).toBe('submit');
    expect(typeof submitBody?.title_ct).toBe('string');
    expect(typeof submitBody?.body_ct).toBe('string');

    // The on-wire ciphertext decrypts under the SAME committee key the holder
    // cached — proving the shared concerns/seal.ts scheme was used (F-167), not
    // a reprisal-specific fork.
    expect(openHex(submitBody!.title_ct as string, plaintextKey!)).toBe(
      'supervisor cut my hours after I raised the guard issue'
    );
    expect(openHex(submitBody!.body_ct as string, plaintextKey!)).toBe(
      'detailed timeline of the retaliation follows'
    );
  });

  it('populates the holder from the unwrap RPC on first call when the holder is empty', async () => {
    const { t07Client, localIdentity, keyHolder, t07 } = await buildWired();
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { id: 'r-2' } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    expect(keyHolder.isPopulated()).toBe(false);
    await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: { title: 't', body: 'b', passphrase: 'p' }
    });

    expect(t07.ops).toContain('committee_key_state');
    expect(t07.ops).toContain('get_key_wrap');
    expect(keyHolder.isPopulated()).toBe(true);
    expect(keyHolder.getDataKey()).toBeInstanceOf(Uint8Array);
  });

  it('reuses a populated holder — does NOT re-unwrap when the holder already holds the live key', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey, t07 } = await buildWired();
    keyHolder.set({ data_key: plaintextKey!, key_id: 'k-live-1', epoch: 3 });
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { id: 'r-3' } } }
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
    expect(r.status).toBe('ok');
    // Cache warm — the disclosure RPC must not fire again.
    expect(t07.ops).not.toContain('get_key_wrap');
  });

  it('forwards intake.passphrase VERBATIM as the per-record friction gate (F-164)', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey!, key_id: 'k-live-1', epoch: 3 });
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { id: 'r-pp' } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: { title: 't', body: 'b', passphrase: 'open-sesame-friction' }
    });
    expect(reprisal.bodies[0]?.passphrase).toBe('open-sesame-friction');
  });
});

// ---------------------------------------------------------------------------
// AC-5 / F-163 — probe-first: no_wrap ⇒ needs_setup, NO disclosure RPC, NO POST
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — submit probe-first no-wrap guard (AC-5 / F-163)', () => {
  it('actor_has_wrap === false ⇒ needs_setup; get_key_wrap NEVER called; NO submit POST made', async () => {
    const { t07Client, localIdentity, keyHolder, t07 } = await buildWired({ actorHasWrap: false });
    // Empty queue — any submit POST would throw "no response queued", which we
    // treat as a contract violation (the composition must short-circuit first).
    const reprisal = makeReprisalTransport([]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: { title: 't', body: 'b', passphrase: 'p' }
    });

    expect(r.status).toBe('needs_setup');
    // The probe ran, but the disclosure RPC must NOT have been hit (F-163 /
    // F-144 — a no-wrap actor never reaches get_key_wrap).
    expect(t07.ops).toContain('committee_key_state');
    expect(t07.ops).not.toContain('get_key_wrap');
    // No reprisal-op call at all.
    expect(reprisal.bodies.length).toBe(0);
    expect(keyHolder.isPopulated()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-7 — rate-limit 429 surfaces with NO PI body, NO holder wipe
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — submit 429 surface (AC-7)', () => {
  it('a 429 from submit ⇒ rate_limited; holder NOT wiped; no PI / no window-tripped hint in the surface', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey!, key_id: 'k-live-1', epoch: 3 });
    const reprisal = makeReprisalTransport([
      { status: 429, body: { ok: false, error: 'rate_limited' } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: {
        title: 'CANARY-TITLE-RL',
        body: 'CANARY-BODY-RL',
        passphrase: 'CANARY-PASS-RL'
      }
    });
    expect(r.status).toBe('rate_limited');
    // 429 is NOT a session event — the holder stays populated (F-161 / AC-7).
    expect(keyHolder.isPopulated()).toBe(true);
    expect(Array.from(plaintextKey!).some((b) => b !== 0)).toBe(true);

    const blob = JSON.stringify(r);
    expect(blob.toLowerCase()).not.toContain('hourly');
    expect(blob.toLowerCase()).not.toContain('daily');
    expect(blob).not.toContain('CANARY-TITLE-RL');
    expect(blob).not.toContain('CANARY-BODY-RL');
    expect(blob).not.toContain('CANARY-PASS-RL');
  });
});

// ---------------------------------------------------------------------------
// AC-6 — submit 401 wipes the holder; 403 does NOT
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — submit 401 vs 403 split (AC-6 / F-163)', () => {
  it('a 401 from submit ⇒ session_expiry AND the cached data key is zeroized + reference nulled', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey!, key_id: 'k-live-1', epoch: 3 });
    const reprisal = makeReprisalTransport([
      { status: 401, body: { ok: false, error: 'rls_denied' } }
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
    expect(r.status).toBe('session_expiry');
    expect(Array.from(plaintextKey!).every((b) => b === 0)).toBe(true);
    expect(keyHolder.isPopulated()).toBe(false);
    expect(keyHolder.getDataKey()).toBeNull();
  });

  it('a 403 from submit ⇒ rls_denied AND the holder is NOT wiped (403 is not a session event)', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey!, key_id: 'k-live-1', epoch: 3 });
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
    expect(Array.from(plaintextKey!).some((b) => b !== 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-8 / F-161 — the wire carries SEALED ciphertext, never plaintext, and no
// client-asserted actor_id (the full leak sweep is its own file)
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — submit wire posture (AC-8 / F-161 / F-164)', () => {
  it('the submit body carries SEALED ciphertext on title_ct/body_ct — never the plaintext canary', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey!, key_id: 'k-live-1', epoch: 3 });
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { id: 'r-w' } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const pt = 'plaintext-reprisal-canary-XYZ-1234';
    await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: { title: pt, body: pt, passphrase: 'pp' }
    });
    const submitBody = reprisal.bodies[0]!;
    for (const v of Object.values(submitBody)) {
      if (typeof v === 'string') expect(v).not.toContain(pt);
    }
    const logBlob = JSON.stringify(__getCapturedLines());
    expect(logBlob).not.toContain(pt);
  });

  it('the submit body NEVER carries a client-supplied actor_id / user_id field (server enforces from auth.uid())', async () => {
    const { t07Client, localIdentity, keyHolder, plaintextKey } = await buildWired();
    keyHolder.set({ data_key: plaintextKey!, key_id: 'k-live-1', epoch: 3 });
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { id: 'r-w2' } } }
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
    const submitBody = reprisal.bodies[0] ?? {};
    for (const k of Object.keys(submitBody)) {
      expect(k).not.toMatch(/^actor_id$/i);
      expect(k).not.toMatch(/^user_id$/i);
    }
  });
});
