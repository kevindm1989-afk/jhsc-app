/**
 * Phase 0a — REGRESSION: empty/short `actor_public_key` must never create a
 * zero-wrap committee key (security-reviewer Finding 1, re-opens threat-model
 * F-138). RED-FIRST: these tests reproduce a BLOCK finding and MUST fail
 * against the CURRENT `initCommitteeDataKeyViaProduction` for the right
 * reason. The implementer treats this file as READ-ONLY.
 *
 * ───────────────────────────────────────────────────────────────────────
 * THE BUG (security-reviewer Finding 1 / F-138)
 * ───────────────────────────────────────────────────────────────────────
 * On the resume path where the device already holds the identity privkey
 * (enroll is SKIPPED — ADR-0026 AC-3), `SetupCommitteeEncryptionCard` never
 * populates `actorPublicKey`; it stays `new Uint8Array(0)`. `runInit` then
 * passes that empty array as `actor_public_key` into
 * `initCommitteeDataKeyViaProduction`. Inside `freshInit`:
 *
 *   1. `init_key` succeeds FIRST  → a LIVE server-side committee key exists.
 *   2. `crypto_box_seal(dataKey, emptyPubkey)` THROWS ("invalid publicKey
 *      length") because libsodium rejects a non-32-byte recipient — and it
 *      throws BEFORE the retire-on-wrap-failure cleanup runs.
 *
 * Result: a permanent ZERO-WRAP dead key on the server + an unrecoverable
 * retry loop (the resume path sees zero wraps, routes into `repairZeroWrapKey`
 * which ALSO seals to the empty pubkey and throws again). This violates
 * ADR-0026 AC-3 / AC-5b / AC-5d and F-138's load-bearing invariant: a
 * missing/short pubkey can NEVER produce a zero-wrap key.
 *
 * ───────────────────────────────────────────────────────────────────────
 * TEST → AC / FINDING MAP
 * ───────────────────────────────────────────────────────────────────────
 *   1. Library-level guard (the DURABLE invariant, F-138 / AC-5d):
 *      a non-32-byte `actor_public_key` is rejected as a wire-shaped
 *      `failed` result BEFORE any state-mutating RPC — `init_key` is NEVER
 *      called, so no live server-side key it cannot wrap is ever created.
 *
 *   2. Resume-skip-enroll end-to-end (ADR-0026 AC-3 + AC-5b):
 *      the device already holds the identity privkey, no in-memory pubkey is
 *      carried over (the exact card resume composition). The empty-pubkey
 *      call must NOT create a live key (test-1 contract), while a CORRECT
 *      32-byte pubkey derived from the device privkey (libsodium
 *      `crypto_scalarmult_base`) drives the actor to a working wrap under a
 *      non-retired key_id with a successful round-trip decrypt.
 *
 * Hermetic: mock transport (records ops so we can assert init_key was/wasn't
 * called) + real libsodium + real BrowserLocalIdentityStore (SSR Map
 * fallback). No real clock, no real network, no RNG seed (the derived pubkey
 * is a deterministic function of the device privkey; libsodium's CSPRNG is
 * the system-under-test's own randomness).
 */

import { describe, expect, it } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import {
  BrowserLocalIdentityStore,
  SupabaseT07Client,
  initCommitteeDataKeyViaProduction,
  type T07OpTransport
} from '../../src/lib/crypto';

await _sodium.ready;
const sodium = _sodium;

const USER = '9f4e9b40-0000-4000-8000-00000000001a'; // SYNTHETIC_USER_COCHAIR

function pgHexToBytes(s: string): Uint8Array {
  const stripped = s.startsWith('\\x') ? s.slice(2) : s;
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function silentStore(): BrowserLocalIdentityStore {
  return new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
}

/**
 * The same in-memory committee-key "server" shape the sibling phase0a tests
 * use: a live (rotated_at IS NULL) key, retired keys, and per-(key_id,user)
 * wraps. This regression file only needs the init / probe / wrap / rotate ops
 * to observe whether a state-mutating RPC fired against a bad pubkey.
 */
interface FakeKeyServer {
  liveKeyId: string | null;
  liveEpoch: number;
  retired: Set<string>;
  wraps: Map<string, Map<string, Uint8Array>>;
  rotations: Map<string, { new_key_id: string }>;
  nextKeyId: number;
  nextRotationId: number;
}

function newServer(): FakeKeyServer {
  return {
    liveKeyId: null,
    liveEpoch: 0,
    retired: new Set(),
    wraps: new Map(),
    rotations: new Map(),
    nextKeyId: 1,
    nextRotationId: 1
  };
}

/**
 * Build a transport over a FakeKeyServer that records every op name so a
 * test can assert the EXACT call sequence — specifically whether the
 * state-mutating `init_key` / `rotate` ops ever fired against a bad pubkey.
 */
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
      case 'init_key': {
        if (srv.liveKeyId !== null) {
          return { status: 409, body: { ok: false, error: 'already_initialised' } };
        }
        srv.liveKeyId = `k-${srv.nextKeyId++}`;
        srv.liveEpoch += 1;
        srv.wraps.set(srv.liveKeyId, new Map());
        return {
          status: 200,
          body: { ok: true, data: { key_id: srv.liveKeyId, epoch: srv.liveEpoch } }
        };
      }
      case 'committee_key_state': {
        if (!srv.liveKeyId) {
          return { status: 200, body: { ok: true, data: null } };
        }
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
        if (srv.retired.has(keyId)) {
          return { status: 409, body: { ok: false, error: 'invalid_input' } };
        }
        const holders = srv.wraps.get(keyId) ?? new Map();
        holders.set(
          body.member_user_id as string,
          pgHexToBytes(body.wrapped_ciphertext_hex as string)
        );
        srv.wraps.set(keyId, holders);
        return { status: 200, body: { ok: true, data: null } };
      }
      case 'rotate': {
        if (!srv.liveKeyId) {
          return { status: 404, body: { ok: false, error: 'not_found' } };
        }
        srv.retired.add(srv.liveKeyId);
        const newKeyId = `k-${srv.nextKeyId++}`;
        srv.liveKeyId = newKeyId;
        srv.liveEpoch += 1;
        srv.wraps.set(newKeyId, new Map());
        const rotationId = `rot-${srv.nextRotationId++}`;
        srv.rotations.set(rotationId, { new_key_id: newKeyId });
        return {
          status: 200,
          body: { ok: true, data: { rotation_id: rotationId, new_key_id: newKeyId } }
        };
      }
      case 'finalize_rotate':
      case 'record_unwrap':
        return { status: 200, body: { ok: true, data: null } };
      default: {
        // Read-shaped probe ops (state / wrap-count) are an implementation
        // seam; serve the live-key state. A genuinely-unexpected WRITE op
        // throws so a stray mutation can never pass silently.
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
        throw new Error(`makeTransport: unexpected op ${op}`);
      }
    }
  };
  return { transport, ops, bodies };
}

/** Open the actor's persisted wrap for a key and return the plaintext. */
function openWrap(
  srv: FakeKeyServer,
  keyId: string,
  user: string,
  pub: Uint8Array,
  priv: Uint8Array
): Uint8Array {
  const holders = srv.wraps.get(keyId);
  if (!holders) throw new Error(`no wraps for ${keyId}`);
  const ct = holders.get(user);
  if (!ct) throw new Error(`no wrap for ${user} under ${keyId}`);
  return sodium.crypto_box_seal_open(ct, pub, priv);
}

type InitArgs = Parameters<typeof initCommitteeDataKeyViaProduction>[0];
type InitResult = Awaited<ReturnType<typeof initCommitteeDataKeyViaProduction>>;

/**
 * Invoke the function under test and NORMALISE the current finding into a
 * self-describing assertion. The wire contract is that this function NEVER
 * throws — it returns a discriminated-union result. Today (Finding 1 / F-138)
 * a non-32-byte `actor_public_key` makes `freshInit` throw "invalid publicKey
 * length" from `crypto_box_seal` AFTER `init_key` already minted a live key.
 *
 * Rather than let that raw TypeError abort the test with an opaque stack, we
 * catch it and FAIL with a message that names the finding — the test still
 * goes RED (as required) but a future reader sees WHY: the function threw
 * instead of returning a `failed` result, leaving a zero-wrap key. When the
 * implementer adds the up-front length guard this helper returns the real
 * result and the downstream assertions take over.
 */
async function runInitOrFailFinding(args: InitArgs): Promise<InitResult> {
  try {
    return await initCommitteeDataKeyViaProduction(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // RED-FIRST sentinel: surface the finding as a named assertion failure.
    expect(
      `initCommitteeDataKeyViaProduction THREW instead of returning a wire-shaped ` +
        `result (Finding 1 / F-138): "${msg}". A non-32-byte actor_public_key must be ` +
        `rejected as { status: 'failed', reason: 'invalid_input', http: 422 } BEFORE any ` +
        `init_key/rotate RPC — never crash after a live key was minted.`
    ).toBe('no-throw');
    throw e; // unreachable once the expect above fails; keeps the type checker happy
  }
}

// ---------------------------------------------------------------------------
// TEST 1 — Library-level guard (the durable F-138 invariant / AC-5d)
// ---------------------------------------------------------------------------
//
// The load-bearing assertion: a non-32-byte `actor_public_key` is rejected
// as a wire-shaped `failed` result WITHOUT ever invoking `init_key`. If the
// pubkey is validated only at `crypto_box_seal` time (the current bug), then
// `init_key` has already created a live server-side committee key that can
// never be wrapped — the exact zero-wrap key F-138 forbids.
//
// CURRENT (RED) BEHAVIOR: with an empty pubkey the op sequence is
// ["committee_key_state","init_key"] and the function THROWS "invalid
// publicKey length" instead of returning `failed`. Both the "init_key was
// called" assertion AND the "returns failed" assertion fail for the right
// reason.
// ---------------------------------------------------------------------------

describe('Phase 0a — empty/short actor_public_key never creates a zero-wrap key (Finding 1 / F-138 / AC-5d)', () => {
  it('rejects an EMPTY actor_public_key as a failed result WITHOUT ever calling init_key', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });

    // The device holds a valid identity privkey (resume context) but the
    // caller passed an EMPTY pubkey — the exact card-resume bug.
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    const r = await runInitOrFailFinding({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: new Uint8Array(0)
    });

    // (a) Wire-shaped failure — NOT a thrown exception, NOT a silent "ok".
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('invalid_input');
    expect(r.http).toBe(422);

    // (b) THE load-bearing assertion: no state-mutating RPC fired. A bad
    //     pubkey must be caught BEFORE init_key, so no live server-side
    //     committee key it cannot wrap is ever created.
    expect(ops).not.toContain('init_key');
    expect(ops).not.toContain('rotate');
    expect(ops).not.toContain('wrap_member');

    // (c) Server state proves the invariant directly: no live key, no key
    //     left in a zero-wrap state.
    expect(srv.liveKeyId).toBeNull();
    expect(srv.wraps.size).toBe(0);
  });

  it('rejects a SHORT (16-byte) actor_public_key as a failed result WITHOUT ever calling init_key', async () => {
    // libsodium rejects any recipient key whose length !== 32; a truncated
    // pubkey is just as dangerous as an empty one. Same invariant: validate
    // before the first state-mutating RPC.
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });

    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    const r = await runInitOrFailFinding({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey.slice(0, 16) // 16 bytes — wrong length
    });

    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('invalid_input');
    expect(r.http).toBe(422);

    expect(ops).not.toContain('init_key');
    expect(ops).not.toContain('rotate');
    expect(srv.liveKeyId).toBeNull();
  });

  it('does NOT leave an unrecoverable zero-wrap retry loop: a SECOND empty-pubkey resume is still a clean failure with no live key', async () => {
    // The finding's compounding harm: after the first crash leaves a
    // zero-wrap key, every retry re-enters repairZeroWrapKey, re-seals to the
    // empty pubkey, and throws again forever. With the guard in place the
    // first call creates NO live key, so the retry has nothing to repair and
    // simply fails cleanly again — no permanent dead key, no live retry loop.
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });

    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    const first = await runInitOrFailFinding({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: new Uint8Array(0)
    });
    expect(first.status).toBe('failed');

    const opsAfterFirst = [...ops];
    const second = await runInitOrFailFinding({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: new Uint8Array(0)
    });
    expect(second.status).toBe('failed');

    // Neither attempt ever minted or rotated a key — no zero-wrap dead key
    // can have been left behind for the retry loop to choke on.
    expect(opsAfterFirst).not.toContain('init_key');
    expect(opsAfterFirst).not.toContain('rotate');
    expect(ops).not.toContain('init_key');
    expect(ops).not.toContain('rotate');
    expect(srv.liveKeyId).toBeNull();
    expect(srv.retired.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TEST 2 — Resume-skip-enroll end-to-end (ADR-0026 AC-3 + AC-5b)
// ---------------------------------------------------------------------------
//
// Reproduce the card's resume composition: the device already holds the
// identity privkey in the REAL BrowserLocalIdentityStore (enroll is skipped),
// and there is NO in-memory pubkey carried over. We drive
// `initCommitteeDataKeyViaProduction` exactly as `runInit` does.
//
//  - The empty-pubkey call (what the buggy card actually sends) must be
//    rejected without ever calling init_key (test-1 contract).
//  - A CORRECT 32-byte pubkey, derived from the device privkey via
//    `crypto_scalarmult_base` (the documented fix the card must apply on the
//    skip-enroll path), drives the actor to a working wrap under a
//    non-retired key_id with a successful round-trip decrypt.
// ---------------------------------------------------------------------------

describe('Phase 0a — resume-skip-enroll: device holds privkey, no in-memory pubkey (ADR-0026 AC-3 / AC-5b)', () => {
  it('the empty-pubkey resume (the card bug) creates NO live key and the derived-pubkey resume succeeds with a round-trip', async () => {
    const srv = newServer();
    const { transport, ops, bodies } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });

    // ── Resume context: the device already holds the identity privkey (the
    //    enroll step was skipped — AC-3). Nothing seeded an in-memory pubkey.
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    // ── (1) Drive the SAME composition the buggy card uses on resume: it
    //    forwards its empty `actorPublicKey`. This must be rejected up front
    //    — init_key is NEVER called with an empty/short pubkey.
    const buggy = await runInitOrFailFinding({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: new Uint8Array(0)
    });
    expect(buggy.status).toBe('failed');
    expect(ops).not.toContain('init_key'); // never minted a key it cannot wrap
    expect(srv.liveKeyId).toBeNull();

    // ── (2) The documented fix for the skip-enroll path: derive the 32-byte
    //    actor pubkey from the device privkey (libsodium scalarmult_base) and
    //    re-run. This is the contract the card must honour — a correct pubkey
    //    yields success while the empty-pubkey call above is rejected.
    const devicePriv = await localIdentity.getIdentityPrivateKey(USER);
    const derivedPub = sodium.crypto_scalarmult_base(devicePriv);
    expect(derivedPub.length).toBe(32);

    const fixed = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: derivedPub
    });

    // The actor ends provisioned: ok, a live (non-retired) key, a real wrap.
    expect(fixed.status).toBe('ok');
    if (fixed.status !== 'ok') return;
    expect(fixed.key_id).toBe(srv.liveKeyId);
    expect(srv.retired.has(fixed.key_id)).toBe(false);

    // init_key was called exactly once and ONLY with a 32-byte pubkey-derived
    // wrap (no init_key ever fired during the empty-pubkey attempt above).
    expect(ops.filter((o) => o === 'init_key')).toHaveLength(1);
    const wrapBodies = bodies.filter((b) => b.op === 'wrap_member');
    expect(wrapBodies.length).toBeGreaterThanOrEqual(1);

    // Round-trip: the persisted wrap, opened with the device privkey, yields
    // the 32-byte committee data key.
    const opened = openWrap(srv, fixed.key_id, USER, derivedPub, devicePriv);
    expect(opened.length).toBe(32);
  });

  it('an empty-pubkey resume must NOT issue init_key with an empty/short pubkey (AC-5b: no zero-wrap key ever)', async () => {
    // A focused restatement of the F-138 invariant on the resume path: the
    // body sent to any state-mutating op must never be the consequence of an
    // empty/short pubkey. Today init_key fires first, then the seal throws —
    // this asserts init_key never fires at all for a bad pubkey.
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });

    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    const r = await runInitOrFailFinding({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: new Uint8Array(0)
    });

    // No state-mutating op fired, and the server is left with nothing live.
    expect(ops).not.toContain('init_key');
    expect(ops).not.toContain('rotate');
    expect(ops).not.toContain('wrap_member');
    expect(srv.liveKeyId).toBeNull();
    // The function reported the failure rather than throwing or silently
    // claiming done.
    expect(r.status).toBe('failed');
  });
});
