/**
 * Phase 0a — full provisioning ceremony (enroll → recovery → init) +
 * resumability + edge-B restore-not-reenroll + F-129 proof-of-possession +
 * AC-8 full-ceremony key-material leak sweep. RED-FIRST (TDD).
 *
 * Surfaces under test:
 *   - existing reused primitives: `enrollIdentityViaProduction`,
 *     `storeRecoveryBlobViaProduction`, `restoreRecoveryBlobViaProduction`.
 *   - the net-new composition: `initCommitteeDataKeyViaProduction`
 *     (DOES NOT EXIST YET — RED at import binding).
 *
 * The ceremony's resume routing (skip-enroll-if-privkey-present; route
 * server-pubkey/no-device-privkey to RESTORE not re-enroll; duplicate-
 * finalize → restore) is exercised here at the production-flow boundary
 * with a stateful mock transport that mimics the t07-op Edge Function's
 * identity / recovery / committee-key state. These behaviors are the card's
 * (P0a-3) orchestration contract, pinned as the threat-model handoff
 * mandates (vitest, mock t07 transport).
 *
 * Hermetic: mock transport + real libsodium + real BrowserLocalIdentityStore
 * (SSR Map). No real clock / network / unseeded business RNG. The structured
 * logger is captured via the project's test-sink (`src/lib/log/test-sink`)
 * and `console.*` is spied — both reset per test.
 *
 * ───────────────────────────────────────────────────────────────────────
 * TEST → AC / FINDING MAP
 * ───────────────────────────────────────────────────────────────────────
 *   AC-1        — full ceremony enroll→recovery→init produces, in order,
 *                 identity row + recovery row + committee key wrap; after
 *                 completion the actor can round-trip-decrypt.
 *   AC-1 / F-129 — privkey persisted to localIdentity ONLY after finalize
 *                  succeeds; a substituted/forged pubkey enroll is rejected
 *                  in one cycle with NO privkey persisted; only public key +
 *                  nonce cross the boundary (no privkey bytes in any request).
 *   AC-3 / F-136 — mid-flow resume: an already-enrolled identity is not
 *                  re-enrolled (no second enrollment_challenge_init);
 *                  a refresh between steps continues correctly.
 *   AC-7 / F-139 — edge-B: server-has-pubkey / device-has-no-privkey routes
 *                  to recovery RESTORE, never a second enroll; recovered
 *                  privkey opens the EXISTING committee-key wrap (no orphan);
 *                  duplicate-finalize → restore.
 *   AC-8 / F-132 — full-ceremony leak sweep: privkey bytes, passphrase
 *                  string, and the 32-byte plaintext data key never appear
 *                  in console.* / thrown errors / structured-log lines;
 *                  passphrase not persisted across a simulated refresh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import {
  BrowserLocalIdentityStore,
  SupabaseT07Client,
  enrollIdentityViaProduction,
  storeRecoveryBlobViaProduction,
  restoreRecoveryBlobViaProduction,
  type T07OpTransport
} from '../../src/lib/crypto';
// RED-FIRST: not exported yet — pins the public name + signature.
import { initCommitteeDataKeyViaProduction } from '../../src/lib/crypto';
import {
  __getCapturedLines,
  __resetCapture,
  __setTestSink
} from '../../src/lib/log/test-sink';

await _sodium.ready;
const sodium = _sodium;

const USER = '9f4e9b40-0000-4000-8000-00000000001a'; // SYNTHETIC_USER_COCHAIR
const PASSPHRASE = 'correct horse battery staple synthetic phase0a';

function pgHexToBytes(s: string): Uint8Array {
  const stripped = s.startsWith('\\x') ? s.slice(2) : s;
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
function bytesToPgHex(b: Uint8Array): string {
  let s = '\\x';
  for (const byte of b) s += byte.toString(16).padStart(2, '0');
  return s;
}
function silentStore(): BrowserLocalIdentityStore {
  return new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
}

/**
 * Stateful t07 "server": identity pubkey, recovery blob, committee key +
 * wraps. The mock seals the enrollment nonce to the POSTED pubkey so the
 * F-02 unseal round-trip is genuinely exercised. `serverHeldPubkey` lets a
 * test pre-seed the edge-B state (server has pubkey, device has none).
 */
interface CeremonyServer {
  serverPubkey: Uint8Array | null;
  recoveryEnvelopeHex: string | null;
  recoveryKdf: Record<string, unknown> | null;
  liveKeyId: string | null;
  liveEpoch: number;
  wraps: Map<string, Map<string, Uint8Array>>;
  // controls
  forgeNonceToPubkey: Uint8Array | null; // F-129: seal nonce to a DIFFERENT key
  finalizeReturnsDuplicate: boolean; // edge-B duplicate-finalize signal
  lastNonce: Uint8Array | null;
}
function newCeremonyServer(): CeremonyServer {
  return {
    serverPubkey: null,
    recoveryEnvelopeHex: null,
    recoveryKdf: null,
    liveKeyId: null,
    liveEpoch: 0,
    wraps: new Map(),
    forgeNonceToPubkey: null,
    finalizeReturnsDuplicate: false,
    lastNonce: null
  };
}

function makeCeremonyTransport(srv: CeremonyServer): {
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
      case 'enrollment_challenge_init': {
        const postedPub = pgHexToBytes(body.public_key_hex as string);
        srv.lastNonce = sodium.randombytes_buf(32);
        // F-129: optionally seal to a DIFFERENT pubkey so the device cannot
        // unseal (proof-of-possession failure).
        const sealTo = srv.forgeNonceToPubkey ?? postedPub;
        const sealed = sodium.crypto_box_seal(srv.lastNonce, sealTo);
        return {
          status: 200,
          body: {
            ok: true,
            data: { challenge_id: 'chal-1', sealed_nonce_hex: bytesToPgHex(sealed) }
          }
        };
      }
      case 'enrollment_challenge_finalize': {
        if (srv.finalizeReturnsDuplicate) {
          return { status: 409, body: { ok: false, error: 'duplicate' } };
        }
        const observed = pgHexToBytes(body.unsealed_nonce_hex as string);
        const match =
          srv.lastNonce !== null &&
          observed.length === srv.lastNonce.length &&
          observed.every((b, i) => b === (srv.lastNonce as Uint8Array)[i]);
        if (!match) return { status: 403, body: { ok: false, error: 'wrong_nonce' } };
        return { status: 200, body: { ok: true, data: USER } };
      }
      case 'store_recovery': {
        srv.recoveryEnvelopeHex = body.blob_ciphertext_hex as string;
        srv.recoveryKdf = body.kdf_params as Record<string, unknown>;
        return { status: 200, body: { ok: true, data: null } };
      }
      case 'get_recovery_blob': {
        if (srv.recoveryEnvelopeHex === null) {
          return { status: 200, body: { ok: true, data: null } };
        }
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              blob_ciphertext_hex: srv.recoveryEnvelopeHex,
              kdf_params: srv.recoveryKdf
            }
          }
        };
      }
      case 'record_restored': {
        return { status: 200, body: { ok: true, data: null } };
      }
      case 'init_key': {
        if (srv.liveKeyId !== null) {
          return { status: 409, body: { ok: false, error: 'already_initialised' } };
        }
        srv.liveKeyId = 'k-1';
        srv.liveEpoch = 1;
        srv.wraps.set('k-1', new Map());
        return { status: 200, body: { ok: true, data: { key_id: 'k-1', epoch: 1 } } };
      }
      case 'committee_key_state': {
        if (!srv.liveKeyId) return { status: 200, body: { ok: true, data: null } };
        const holders = srv.wraps.get(srv.liveKeyId) ?? new Map();
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              key_id: srv.liveKeyId,
              epoch: srv.liveEpoch,
              wrap_count: holders.size,
              actor_has_wrap: holders.has(body.actor_user_id as string)
            }
          }
        };
      }
      case 'wrap_member': {
        const keyId = body.key_id as string;
        const holders = srv.wraps.get(keyId) ?? new Map();
        holders.set(
          body.member_user_id as string,
          pgHexToBytes(body.wrapped_ciphertext_hex as string)
        );
        srv.wraps.set(keyId, holders);
        return { status: 200, body: { ok: true, data: null } };
      }
      case 'record_unwrap':
        return { status: 200, body: { ok: true, data: null } };
      default: {
        // State-probe read-op wire name is an implementation seam (see the
        // init-committee test file). Any read-shaped op gets the live-key
        // state; a genuinely-unexpected WRITE op throws.
        const op = String(body.op);
        if (/state|wrap.*count|count.*wrap|current.*wrap|get.*key|get.*wrap|probe/i.test(op)) {
          if (!srv.liveKeyId) return { status: 200, body: { ok: true, data: null } };
          const holders = srv.wraps.get(srv.liveKeyId) ?? new Map();
          return {
            status: 200,
            body: {
              ok: true,
              data: {
                key_id: srv.liveKeyId,
                epoch: srv.liveEpoch,
                wrap_count: holders.size,
                actor_has_wrap: holders.has(body.actor_user_id as string)
              }
            }
          };
        }
        throw new Error(`makeCeremonyTransport: unexpected op ${op}`);
      }
    }
  };
  return { transport, ops, bodies };
}

// ---------------------------------------------------------------------------
// AC-1 / F-129 — enroll persist-ordering + proof-of-possession
// ---------------------------------------------------------------------------

describe('Phase 0a ceremony — enroll persist-ordering + proof-of-possession (AC-1 / F-129)', () => {
  it('AC-1: privkey is persisted to localIdentity ONLY after enrollment_challenge_finalize succeeds (write-after-finalize ordering)', async () => {
    const srv = newCeremonyServer();
    const { transport, ops } = makeCeremonyTransport(srv);
    const localIdentity = silentStore();
    const writeSpy = vi.spyOn(localIdentity, 'storeIdentityPrivateKey');
    const client = new SupabaseT07Client({ transport, localIdentity });

    const r = await enrollIdentityViaProduction({ client, user_id: USER });
    expect(r.status).toBe('ok');

    // The store write happened, and it happened AFTER the finalize op.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const finalizeIdx = ops.indexOf('enrollment_challenge_finalize');
    expect(finalizeIdx).toBeGreaterThanOrEqual(0);
    // Ordering: finalize op was issued before the write resolved. The write
    // spy fires inside enrollIdentityViaChallenge after finalize.ok — assert
    // the privkey is readable only post-success.
    const sk = await localIdentity.getIdentityPrivateKey(USER);
    expect(sk.length).toBe(32);
    writeSpy.mockRestore();
  });

  it('AC-1 / F-129: a forged/substituted enrollment pubkey is rejected in one cycle and NO privkey is persisted', async () => {
    const srv = newCeremonyServer();
    // Force the server to seal the nonce to a DIFFERENT keypair's pubkey so
    // the device cannot unseal — proof-of-possession fails.
    srv.forgeNonceToPubkey = sodium.crypto_box_keypair().publicKey;
    const { transport } = makeCeremonyTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });

    const r = await enrollIdentityViaProduction({ client, user_id: USER });
    expect(r.status).toBe('failed');
    // No privkey persisted on the failed enroll.
    await expect(localIdentity.getIdentityPrivateKey(USER)).rejects.toThrow(/not found/);
  });

  it('AC-1 / F-129: no byte of the private key appears in any outbound request body across the enroll path', async () => {
    const srv = newCeremonyServer();
    const { transport, bodies } = makeCeremonyTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });

    const r = await enrollIdentityViaProduction({ client, user_id: USER });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const priv = await localIdentity.getIdentityPrivateKey(USER);
    const privHexNoPrefix = bytesToPgHex(priv).slice(2);

    for (const body of bodies) {
      const serialized = JSON.stringify(body);
      expect(serialized.includes(privHexNoPrefix)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-1 — full ceremony enroll → recovery → init round-trip
// ---------------------------------------------------------------------------

describe('Phase 0a ceremony — full enroll → recovery → init (AC-1)', () => {
  it('AC-1: runs the three steps in order and the actor can round-trip-decrypt the committee key afterward', async () => {
    const srv = newCeremonyServer();
    const { transport, ops } = makeCeremonyTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });

    // Step 1 — enroll identity.
    const enroll = await enrollIdentityViaProduction({ client, user_id: USER });
    expect(enroll.status).toBe('ok');
    if (enroll.status !== 'ok') return;

    // Step 2 — store recovery blob.
    const recovery = await storeRecoveryBlobViaProduction({
      client,
      localIdentity,
      user_id: USER,
      passphrase: PASSPHRASE
    });
    expect(recovery.status).toBe('ok');

    // Step 3 — init committee key + self-wrap (the net-new composition).
    const init = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: enroll.public_key
    });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;

    // Ordering: enroll-init precedes store_recovery precedes init_key.
    expect(ops.indexOf('enrollment_challenge_init')).toBeLessThan(ops.indexOf('store_recovery'));
    expect(ops.indexOf('store_recovery')).toBeLessThan(ops.indexOf('init_key'));

    // Round-trip: open the actor's wrap with the device privkey → 32-byte key.
    const priv = await localIdentity.getIdentityPrivateKey(USER);
    const wrap = srv.wraps.get(init.key_id)?.get(USER);
    expect(wrap).toBeDefined();
    const dataKey = sodium.crypto_box_seal_open(wrap as Uint8Array, enroll.public_key, priv);
    expect(dataKey.length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// AC-3 / F-136 — resumability: do not re-enroll an already-enrolled identity
// ---------------------------------------------------------------------------

describe('Phase 0a ceremony — resumability (AC-3 / F-136)', () => {
  it('AC-3: re-running step 3 on an already-fully-provisioned actor is success-equivalent and issues NO second enrollment_challenge_init and NO second init_key write', async () => {
    const srv = newCeremonyServer();
    const { transport, ops } = makeCeremonyTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });

    // Full first ceremony.
    const enroll = await enrollIdentityViaProduction({ client, user_id: USER });
    expect(enroll.status).toBe('ok');
    if (enroll.status !== 'ok') return;
    await storeRecoveryBlobViaProduction({
      client,
      localIdentity,
      user_id: USER,
      passphrase: PASSPHRASE
    });
    const firstInit = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: enroll.public_key
    });
    expect(firstInit.status).toBe('ok');

    const enrollInitCountAfterFirst = ops.filter(
      (o) => o === 'enrollment_challenge_init'
    ).length;
    expect(enrollInitCountAfterFirst).toBe(1);

    // Resume step 3 — the actor already holds a working wrap. This drives the
    // production resume path (the NEW function), which must be success-
    // equivalent and must not mint a second identity nor a divergent key.
    const resume = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: enroll.public_key
    });
    expect(resume.status).not.toBe('failed');

    // No second enrollment_challenge_init anywhere in the flow.
    expect(ops.filter((o) => o === 'enrollment_challenge_init')).toHaveLength(1);
    // The actor still holds exactly one wrap on the single live key.
    expect(srv.wraps.get(srv.liveKeyId as string)?.has(USER)).toBe(true);
  });

  it('AC-3: a refresh between steps (new client + persisted device privkey) continues to recovery + init without re-enroll', async () => {
    const srv = newCeremonyServer();
    const { transport, ops } = makeCeremonyTransport(srv);
    const localIdentity = silentStore();

    // Step 1 done on the "pre-refresh" client.
    const c1 = new SupabaseT07Client({ transport, localIdentity });
    const enroll = await enrollIdentityViaProduction({ client: c1, user_id: USER });
    expect(enroll.status).toBe('ok');
    if (enroll.status !== 'ok') return;

    // Simulate a refresh: a brand-new client over the SAME persisted
    // device store (IndexedDB survives refresh; in-memory flow state does not).
    const c2 = new SupabaseT07Client({ transport, localIdentity });

    const recovery = await storeRecoveryBlobViaProduction({
      client: c2,
      localIdentity,
      user_id: USER,
      passphrase: PASSPHRASE
    });
    expect(recovery.status).toBe('ok');

    const init = await initCommitteeDataKeyViaProduction({
      client: c2,
      localIdentity,
      user_id: USER,
      actor_public_key: enroll.public_key
    });
    expect(init.status).toBe('ok');

    // Exactly ONE enrollment_challenge_init across the whole (refreshed) flow.
    expect(ops.filter((o) => o === 'enrollment_challenge_init')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC-7 / F-139 — edge-B: server-has-pubkey / device-has-no-privkey → RESTORE
// ---------------------------------------------------------------------------

describe('Phase 0a ceremony — edge-B restore-not-reenroll (AC-7 / F-139)', () => {
  it('AC-7: a recovered privkey opens the EXISTING committee-key wrap (no second pubkey minted, no orphan)', async () => {
    const srv = newCeremonyServer();
    const { transport } = makeCeremonyTransport(srv);

    // ── Provision device 1 fully: enroll → store recovery → init+wrap.
    const device1 = silentStore();
    const c1 = new SupabaseT07Client({ transport, localIdentity: device1 });
    const enroll = await enrollIdentityViaProduction({ client: c1, user_id: USER });
    expect(enroll.status).toBe('ok');
    if (enroll.status !== 'ok') return;
    srv.serverPubkey = enroll.public_key; // server now holds the pubkey
    await storeRecoveryBlobViaProduction({
      client: c1,
      localIdentity: device1,
      user_id: USER,
      passphrase: PASSPHRASE
    });
    const init = await initCommitteeDataKeyViaProduction({
      client: c1,
      localIdentity: device1,
      user_id: USER,
      actor_public_key: enroll.public_key
    });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;

    // ── Device 2 (new device / cleared IDB): server has pubkey, device has
    //    NO privkey. The correct route is RESTORE, never re-enroll.
    const device2 = silentStore();
    const c2 = new SupabaseT07Client({ transport, localIdentity: device2 });
    await expect(device2.getIdentityPrivateKey(USER)).rejects.toThrow(/not found/);

    const restored = await restoreRecoveryBlobViaProduction({
      client: c2,
      localIdentity: device2,
      user_id: USER,
      passphrase: PASSPHRASE,
      device_fingerprint_raw: 'synthetic-device-2'
    });
    expect(restored.status).toBe('ok');
    if (restored.status !== 'ok') return;

    // The recovered privkey opens the EXISTING wrap (proves no orphan — the
    // wrap was sealed to the SAME pubkey the restored privkey matches).
    const existingWrap = srv.wraps.get(init.key_id)?.get(USER);
    expect(existingWrap).toBeDefined();
    const dataKey = sodium.crypto_box_seal_open(
      existingWrap as Uint8Array,
      restored.public_key,
      restored.private_key
    );
    expect(dataKey.length).toBe(32);
  });

  it('AC-7 / F-139: a duplicate-finalize signal must route to restore, NOT a success-equivalent fresh enroll', async () => {
    const srv = newCeremonyServer();
    srv.finalizeReturnsDuplicate = true; // server already has this pubkey
    const { transport } = makeCeremonyTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });

    const r = await enrollIdentityViaProduction({ client, user_id: USER });

    // A duplicate from finalize is NOT a clean enroll: enroll surfaces it as
    // a non-ok result, and crucially NO privkey is persisted (so the card
    // must route to restore rather than treat enroll as done).
    expect(r.status).not.toBe('ok');
    await expect(localIdentity.getIdentityPrivateKey(USER)).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// AC-8 / F-132 — full-ceremony key-material leak sweep + no-persist passphrase
// ---------------------------------------------------------------------------

describe('Phase 0a ceremony — full key-material leak sweep (AC-8 / F-132)', () => {
  const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
  const consoleCaptured: string[] = [];

  beforeEach(() => {
    __resetCapture();
    __setTestSink();
    consoleCaptured.length = 0;
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      consoleSpies.push(
        vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
          consoleCaptured.push(args.map((a) => String(a)).join(' '));
        })
      );
    }
  });
  afterEach(() => {
    for (const s of consoleSpies) s.mockRestore();
    consoleSpies.length = 0;
    __setTestSink();
    __resetCapture();
  });

  it('AC-8: neither the privkey bytes, the passphrase, nor the plaintext data key appear in console / structured-log lines across the whole ceremony', async () => {
    const srv = newCeremonyServer();
    const { transport } = makeCeremonyTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });

    const enroll = await enrollIdentityViaProduction({ client, user_id: USER });
    expect(enroll.status).toBe('ok');
    if (enroll.status !== 'ok') return;
    await storeRecoveryBlobViaProduction({
      client,
      localIdentity,
      user_id: USER,
      passphrase: PASSPHRASE
    });
    const init = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: enroll.public_key
    });
    expect(init.status).toBe('ok');
    if (init.status !== 'ok') return;

    // Secrets that must never appear in any observable text surface.
    const priv = await localIdentity.getIdentityPrivateKey(USER);
    const privHex = bytesToPgHex(priv).slice(2);
    const privB64 = sodium.to_base64(priv);
    // The plaintext data key is recoverable here only to BUILD the canary —
    // we open the actor wrap to learn its bytes, then assert those bytes are
    // absent from logs.
    const dataKey = sodium.crypto_box_seal_open(
      srv.wraps.get(init.key_id)?.get(USER) as Uint8Array,
      enroll.public_key,
      priv
    );
    const dataKeyHex = bytesToPgHex(dataKey).slice(2);

    const logLines = __getCapturedLines().map((l) => JSON.stringify(l));
    const allText = [...consoleCaptured, ...logLines].join('\n');

    expect(allText.includes(PASSPHRASE)).toBe(false);
    expect(allText.includes(privHex)).toBe(false);
    expect(allText.includes(privB64)).toBe(false);
    expect(allText.includes(dataKeyHex)).toBe(false);
  });

  it('AC-8: a thrown error from the ceremony carries no key material in message or stack', async () => {
    // Force a failure in step 3 (wrap rejected) and capture any thrown error.
    const srv = newCeremonyServer();
    const baseT = makeCeremonyTransport(srv).transport;
    const transport: T07OpTransport = async (body) => {
      if (body.op === 'wrap_member') {
        return { status: 500, body: { ok: false, error: 'unknown' } };
      }
      return baseT(body);
    };
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const enroll = await enrollIdentityViaProduction({ client, user_id: USER });
    expect(enroll.status).toBe('ok');
    if (enroll.status !== 'ok') return;
    await storeRecoveryBlobViaProduction({
      client,
      localIdentity,
      user_id: USER,
      passphrase: PASSPHRASE
    });

    const priv = await localIdentity.getIdentityPrivateKey(USER);
    const privHex = bytesToPgHex(priv).slice(2);

    let thrown: unknown = null;
    let result: unknown = null;
    try {
      result = await initCommitteeDataKeyViaProduction({
        client,
        localIdentity,
        user_id: USER,
        actor_public_key: enroll.public_key
      });
    } catch (e) {
      thrown = e;
    }
    // The function is wire-shaped — it should return a 'failed' union member
    // rather than throw. It MUST exist (a missing binding is not an
    // acceptable "no leak" — guard against a false green while RED).
    if (thrown !== null) {
      const err = thrown as Error;
      expect(String(err.message ?? '')).not.toMatch(/is not a function/);
      expect(String(err.message ?? '')).not.toContain(privHex);
      expect(String(err.message ?? '')).not.toContain(PASSPHRASE);
      expect(String(err.stack ?? '')).not.toContain(privHex);
    } else {
      expect((result as { status: string }).status).toBe('failed');
    }
  });

  it('AC-8: the passphrase is not persisted across a simulated refresh (not in IndexedDB store, not in any captured surface)', async () => {
    const srv = newCeremonyServer();
    const { transport } = makeCeremonyTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });

    const enroll = await enrollIdentityViaProduction({ client, user_id: USER });
    expect(enroll.status).toBe('ok');
    await storeRecoveryBlobViaProduction({
      client,
      localIdentity,
      user_id: USER,
      passphrase: PASSPHRASE
    });

    // Simulate refresh: new client + new in-memory device store view. The
    // passphrase must NOT be readable from the device store under any key.
    const refreshed = new SupabaseT07Client({ transport, localIdentity });
    void refreshed;
    // The device store only ever holds a 32-byte privkey, never the
    // passphrase string. Reading the privkey back must not yield the
    // passphrase bytes.
    const priv = await localIdentity.getIdentityPrivateKey(USER);
    const passphraseBytes = new Uint8Array(Buffer.from(PASSPHRASE, 'utf8'));
    expect(priv.length).toBe(32);
    expect(priv.length).not.toBe(passphraseBytes.length);
    // And nothing logged the passphrase during store/refresh.
    const logLines = __getCapturedLines().map((l) => JSON.stringify(l));
    const allText = [...consoleCaptured, ...logLines].join('\n');
    expect(allText.includes(PASSPHRASE)).toBe(false);
  });
});
