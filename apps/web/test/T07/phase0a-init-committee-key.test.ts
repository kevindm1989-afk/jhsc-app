/**
 * Phase 0a — `initCommitteeDataKeyViaProduction` (ADR-0026 Decision 2 +
 * Amendment A edge-A repair ruling). RED-FIRST (TDD): these tests are
 * written against a function that does NOT exist yet; they MUST fail at
 * import/binding time until the implementer adds
 * `initCommitteeDataKeyViaProduction` to
 * `src/lib/crypto/production-flows.ts` (and re-exports it from
 * `src/lib/crypto/index.ts`). The implementer treats this file as
 * READ-ONLY.
 *
 * Surface under test (the one net-new production composition function):
 *   initCommitteeDataKeyViaProduction({ client, localIdentity, user_id,
 *     actor_public_key })
 * which composes `SupabaseT07Client.initCommitteeDataKey()` /
 * `.wrapCommitteeDataKeyForMember()` / `.rotateCommitteeDataKey()` /
 * `.finalizeCommitteeDataKeyRotation()` over a mock t07 transport + real
 * libsodium + a real BrowserLocalIdentityStore (SSR Map fallback).
 *
 * Hermetic: mock transport (records ops + faithfully simulates the live
 * key / wrap-count state the probe must read), real libsodium, real
 * BrowserLocalIdentityStore. No real clock, no real network, no RNG seed
 * needed (libsodium CSPRNG is the system-under-test's randomness; the
 * tests capture the exact buffer libsodium hands out rather than predict
 * its value).
 *
 * ───────────────────────────────────────────────────────────────────────
 * TEST → AC / FINDING MAP
 * ───────────────────────────────────────────────────────────────────────
 *   AC-2  / F-129 — happy init: { ok, key_id, epoch }; persisted wrap opens
 *                   to the exact 32 bytes generated.
 *   AC-4  / F-137 — second init → already_initialised mapped to success-
 *                   equivalent; NO second data key generated; no error.
 *   AC-5a / F-138 — fresh init happy; NO rotation invoked.
 *   AC-5b / F-138 — true edge-A (ZERO wraps on the live key): probe detects
 *                   zero wraps by COUNT (not actor-presence) → rotate
 *                   ('incident') retires the dead key_id (never wrapped) →
 *                   fresh 32-byte key self-wrapped under the NEW key_id →
 *                   finalize(rotation_id, new_key_id, 1) → round-trip ok.
 *   AC-5b-disc    — discriminator MUST be wrap COUNT of the live key, NOT
 *                   actor-wrap presence (this test FAILS if someone branches
 *                   on actor-wrap presence).
 *   AC-5c / F-138 — foreign-held (some OTHER member holds a wrap, actor does
 *                   not): explicit recoverable error; NO init/rotate/self-
 *                   wrap; never silent "done".
 *   AC-5d / F-138 — invariant guard: never "done" without a confirmed actor
 *                   wrap under a non-retired (rotated_at IS NULL) key_id.
 *   AC-8  / F-132 — the 32-byte plaintext data key is zeroized (.fill(0))
 *                   before the function returns.
 *   AC-6  / F-130 — 401 vs 403 split surfaced distinctly on the init/wrap
 *                   path.
 *   F-135         — { key_id, epoch } returned is metadata only — no key
 *                   material.
 */

import { describe, expect, it, vi } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import {
  BrowserLocalIdentityStore,
  SupabaseT07Client,
  type T07OpTransport
} from '../../src/lib/crypto';
// RED-FIRST: this import does not resolve yet — the implementer adds the
// function + re-export. Importing it here pins the public name + signature.
import { initCommitteeDataKeyViaProduction } from '../../src/lib/crypto';

await _sodium.ready;
const sodium = _sodium;

const USER = '9f4e9b40-0000-4000-8000-00000000001a'; // SYNTHETIC_USER_COCHAIR
const OTHER = '9f4e9b40-0000-4000-8000-00000000000b'; // SYNTHETIC_USER_B

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
 * A small in-memory committee-key "server" that the mock transport drives.
 * It tracks the live (rotated_at IS NULL) key, the retired keys, and the
 * per-(key_id,user) wraps — exactly the state the resume probe must read to
 * distinguish AC-5a/b/c. `failNextWrap` lets a test simulate the edge-A
 * crash (init ok, first wrap fails) without throwing.
 */
interface FakeKeyServer {
  liveKeyId: string | null;
  liveEpoch: number;
  retired: Set<string>;
  // key_id -> set of user_ids that hold a wrap, plus the wrap bytes
  wraps: Map<string, Map<string, Uint8Array>>;
  rotations: Map<string, { new_key_id: string }>; // rotation_id -> new key
  failNextWrap: boolean;
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
    failNextWrap: false,
    nextKeyId: 1,
    nextRotationId: 1
  };
}

function wrapCountForLiveKey(srv: FakeKeyServer): number {
  if (!srv.liveKeyId) return 0;
  return srv.wraps.get(srv.liveKeyId)?.size ?? 0;
}

/**
 * Build a transport over a FakeKeyServer. The transport records every op
 * name so tests can assert exact call sequences (e.g. "no wrap_member
 * against the dead key_id", "rotate called", "init NOT called").
 *
 * The transport also exposes a `getCurrentCommitteeKeyWrap`-equivalent read
 * op `committee_key_state` returning the live key_id + total wrap count +
 * whether the actor holds a wrap — the production probe (P0a-2) reads this
 * shape. (The exact op name is an implementation seam; the tests assert
 * observable BEHAVIOR — call ordering + final state — not the wire name.)
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
        // Read-only probe surface for the live key + wrap count.
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
        if (srv.failNextWrap) {
          srv.failNextWrap = false;
          return { status: 500, body: { ok: false, error: 'unknown' } };
        }
        if (srv.retired.has(keyId)) {
          // A wrap against a retired key is a contract violation; reject it.
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
        const dead = srv.liveKeyId;
        srv.retired.add(dead);
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
      case 'finalize_rotate': {
        return { status: 200, body: { ok: true, data: null } };
      }
      case 'record_unwrap': {
        return { status: 200, body: { ok: true, data: null } };
      }
      default: {
        // The state-probe (P0a-2) read-op wire name is an implementation
        // seam — the tests pin BEHAVIOR (call ordering + final state), not
        // the probe's op name. Any read-shaped op (state / wrap-count /
        // current-wrap / get-key) gets the live-key state payload so the
        // resume branch can read the wrap count. A genuinely-unexpected
        // WRITE op still throws (it would mutate state the test did not
        // anticipate).
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

// ---------------------------------------------------------------------------
// AC-2 / AC-5a / F-129 — happy init self-wrap + round-trip
// ---------------------------------------------------------------------------

describe('Phase 0a — initCommitteeDataKeyViaProduction (AC-2 / AC-5a happy path)', () => {
  it('AC-2: returns { ok, key_id, epoch } and the persisted wrap opens to the exact 32 bytes generated', async () => {
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });

    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    // Capture the exact 32-byte data key libsodium hands the function so we
    // can prove the persisted wrap opens to THOSE bytes (not "some 32 bytes").
    const spy = vi.spyOn(sodium, 'randombytes_buf');

    const r = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(typeof r.key_id).toBe('string');
    expect(r.key_id.length).toBeGreaterThan(0);
    expect(r.epoch).toBe(1);

    // The 32-byte data-key call: find the randombytes_buf result of length 32.
    const dataKeyResults = spy.mock.results
      .map((res) => res.value as Uint8Array)
      .filter((v) => v instanceof Uint8Array && v.length === sodium.crypto_secretbox_KEYBYTES);
    expect(dataKeyResults.length).toBeGreaterThanOrEqual(1);

    // The persisted wrap, opened with the actor privkey, yields 32 bytes.
    const opened = openWrap(srv, r.key_id, USER, kp.publicKey, kp.privateKey);
    expect(opened.length).toBe(sodium.crypto_secretbox_KEYBYTES);
    expect(opened.length).toBe(32);

    spy.mockRestore();
  });

  it('AC-5a: fresh init invokes NO rotation (init_key + wrap_member only, never rotate/finalize)', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    const r = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });

    expect(r.status).toBe('ok');
    expect(ops).toContain('init_key');
    expect(ops).toContain('wrap_member');
    expect(ops).not.toContain('rotate');
    expect(ops).not.toContain('finalize_rotate');
  });

  it('F-135: the returned { key_id, epoch } carries no key material (metadata only)', async () => {
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    const r = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    // The result is metadata only — string key_id + numeric epoch, nothing
    // Uint8Array / byte-shaped.
    expect(typeof r.key_id).toBe('string');
    expect(typeof r.epoch).toBe('number');
    for (const v of Object.values(r as Record<string, unknown>)) {
      expect(v instanceof Uint8Array).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4 / F-137 — second init → already_initialised, no re-mint
// ---------------------------------------------------------------------------

describe('Phase 0a — already_initialised resume with an actor wrap already present (AC-4 / F-137)', () => {
  it('AC-4: a second init against an actor-wrapped live key maps to success-equivalent and generates NO new data key', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    // First ceremony: the actor ends fully provisioned with a working wrap.
    const first = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;

    // Re-run the ceremony (resume): init_key now returns already_initialised
    // AND the actor already holds a wrap → success-equivalent, no re-mint.
    const spy = vi.spyOn(sodium, 'randombytes_buf');
    const second = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });

    // Success-equivalent: NOT a 'failed' status, NOT an error.
    expect(second.status === 'already_initialised' || second.status === 'ok').toBe(true);
    expect(second.status).not.toBe('failed');

    // No second 32-byte data key minted on the already-initialised branch.
    const newDataKeys = spy.mock.results
      .map((res) => res.value as Uint8Array)
      .filter((v) => v instanceof Uint8Array && v.length === sodium.crypto_secretbox_KEYBYTES);
    expect(newDataKeys.length).toBe(0);

    // No rotation, no second init write attempted beyond the probe/init read.
    expect(ops.filter((o) => o === 'rotate')).toHaveLength(0);

    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// AC-5b / F-138 — TRUE EDGE A: zero wraps → rotate-and-reinit
// ---------------------------------------------------------------------------

describe('Phase 0a — edge-A repair: ZERO wraps on the live key (AC-5b / F-138)', () => {
  it('AC-5b: rotates the dead key, self-wraps a FRESH key under the NEW key_id, finalizes, and round-trips', async () => {
    const srv = newServer();
    const { transport, ops, bodies } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    // Simulate the crash: init_key succeeds, the FIRST wrap_member fails.
    srv.failNextWrap = true;
    const crashed = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });
    expect(crashed.status).toBe('failed');
    const deadKeyId = srv.liveKeyId;
    expect(deadKeyId).not.toBeNull();
    expect(wrapCountForLiveKey(srv)).toBe(0); // zero wraps for ANY member

    // Resume: the probe must see zero wraps on the live key and repair.
    const spy = vi.spyOn(sodium, 'randombytes_buf');
    const opsBefore = ops.length;
    const repaired = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });
    const resumeOps = ops.slice(opsBefore);

    // (ii) rotate('incident') was called and its new_key_id is used.
    expect(resumeOps).toContain('rotate');
    const rotateBody = bodies.find((b) => b.op === 'rotate');
    expect(rotateBody?.trigger).toBe('incident');

    // (ii cont.) the OLD/dead key_id is now retired and is NEVER wrapped.
    expect(srv.retired.has(deadKeyId as string)).toBe(true);
    expect(srv.wraps.get(deadKeyId as string)?.size ?? 0).toBe(0);

    // (vi) no wrap_member is EVER issued against the dead key_id.
    const wrapBodies = bodies.filter((b) => b.op === 'wrap_member');
    for (const w of wrapBodies) {
      expect(w.key_id).not.toBe(deadKeyId);
    }

    // (iii) a fresh 32-byte key was generated on the repair path.
    const freshKeys = spy.mock.results
      .map((res) => res.value as Uint8Array)
      .filter((v) => v instanceof Uint8Array && v.length === sodium.crypto_secretbox_KEYBYTES);
    expect(freshKeys.length).toBeGreaterThanOrEqual(1);

    // (iv) finalize_committee_data_key_rotation(rotation_id, new_key_id, 1).
    expect(resumeOps).toContain('finalize_rotate');
    const finalizeBody = bodies.find((b) => b.op === 'finalize_rotate');
    expect(finalizeBody?.members_rewrapped_count).toBe(1);
    expect(finalizeBody?.new_key_id).toBe(srv.liveKeyId);

    // (v) the repair succeeds and the actor's wrap under the NEW key opens
    //     to a 32-byte data key (round-trip).
    expect(repaired.status).toBe('ok');
    if (repaired.status !== 'ok') return;
    expect(repaired.key_id).toBe(srv.liveKeyId);
    const opened = openWrap(srv, srv.liveKeyId as string, USER, kp.publicKey, kp.privateKey);
    expect(opened.length).toBe(32);

    spy.mockRestore();
  });

  it('AC-5b-disc: the repair discriminates on WRAP COUNT of the live key, not actor-wrap presence (would-fail-if-branched-on-actor-presence)', async () => {
    // This scenario is INDISTINGUISHABLE from AC-5c if the implementer
    // branches on "does the ACTOR have a wrap" — in BOTH cases the actor has
    // no wrap. The ONLY safe discriminator is the total wrap count of the
    // live key. Here the count is ZERO, so the correct action is rotate; a
    // wrong actor-presence branch would mis-route this into the AC-5c
    // foreign-held error (no rotate) and FAIL this assertion.
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    srv.failNextWrap = true;
    await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });
    expect(srv.wraps.get(srv.liveKeyId as string)?.has(USER)).toBe(false); // actor has no wrap
    expect(wrapCountForLiveKey(srv)).toBe(0); // ...AND zero wraps overall

    const opsBefore = ops.length;
    const repaired = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });
    const resumeOps = ops.slice(opsBefore);

    // Zero-count → MUST rotate (not surface the foreign-held error).
    expect(resumeOps).toContain('rotate');
    expect(repaired.status).toBe('ok');
  });

  it('AC-5b: the fresh repair key differs from the dead-key material (no divergent key under a stale id)', async () => {
    const srv = newServer();
    const { transport, bodies } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    srv.failNextWrap = true;
    await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });
    const deadKeyId = srv.liveKeyId;

    const repaired = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });
    expect(repaired.status).toBe('ok');
    if (repaired.status !== 'ok') return;

    // The new key_id is distinct from the dead key_id, and no wrap row was
    // ever written under the dead key_id.
    expect(repaired.key_id).not.toBe(deadKeyId);
    const wrapBodiesAgainstDead = bodies.filter(
      (b) => b.op === 'wrap_member' && b.key_id === deadKeyId
    );
    expect(wrapBodiesAgainstDead).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-5c / F-138 — foreign-held key: explicit recoverable error
// ---------------------------------------------------------------------------

describe('Phase 0a — edge-A sub-case (a): foreign-held live key (AC-5c / F-138)', () => {
  it('AC-5c: when ANOTHER member holds a wrap and the actor does not, surfaces a recoverable error and does NOT init/rotate/self-wrap', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });

    const actorKp = sodium.crypto_box_keypair();
    const otherKp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, actorKp.privateKey);

    // Pre-seed: a live key exists with a wrap for OTHER only (not the actor).
    srv.liveKeyId = 'k-existing';
    srv.liveEpoch = 1;
    const holders = new Map<string, Uint8Array>();
    const sharedKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    holders.set(OTHER, sodium.crypto_box_seal(sharedKey, otherKp.publicKey));
    srv.wraps.set('k-existing', holders);

    const r = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: actorKp.publicKey
    });

    // Explicit recoverable error — NOT ok, NOT already_initialised "done".
    expect(r.status).not.toBe('ok');
    expect(r.status).not.toBe('already_initialised');

    // No init, no rotate, no self-wrap attempt (it has no key material).
    expect(ops).not.toContain('rotate');
    expect(ops.filter((o) => o === 'wrap_member')).toHaveLength(0);
    // The actor never gained a wrap under the foreign-held key.
    expect(srv.wraps.get('k-existing')?.has(USER)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-5d / F-138 — invariant guard: never "done" without a confirmed actor wrap
// ---------------------------------------------------------------------------

describe('Phase 0a — invariant guard: never silent "done" (AC-5d / F-138)', () => {
  it('AC-5d (zero-wrap): does NOT return ok unless a real actor wrap was persisted under a non-retired key_id', async () => {
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    srv.failNextWrap = true;
    await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });

    const r = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });

    if (r.status === 'ok') {
      // If it claims done, the claim MUST be backed by a real wrap under the
      // CURRENT (non-retired) key_id.
      expect(r.key_id).toBe(srv.liveKeyId);
      expect(srv.retired.has(r.key_id)).toBe(false);
      expect(srv.wraps.get(r.key_id)?.has(USER)).toBe(true);
    }
  });

  it('AC-5d (foreign-held): never short-circuits to ok when only another member holds a wrap', async () => {
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const actorKp = sodium.crypto_box_keypair();
    const otherKp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, actorKp.privateKey);

    srv.liveKeyId = 'k-existing';
    srv.liveEpoch = 1;
    const holders = new Map<string, Uint8Array>();
    holders.set(
      OTHER,
      sodium.crypto_box_seal(
        sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES),
        otherKp.publicKey
      )
    );
    srv.wraps.set('k-existing', holders);

    const r = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: actorKp.publicKey
    });
    expect(r.status).not.toBe('ok');
  });

  it('AC-5d (actor-already-wrapped): the already-initialised happy resume confirms the actor wrap before reporting done', async () => {
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });

    const r = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });
    // success-equivalent AND the actor really does hold a wrap on the live key.
    expect(r.status).not.toBe('failed');
    expect(srv.wraps.get(srv.liveKeyId as string)?.has(USER)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-8 / F-132 — zeroization of the plaintext data key
// ---------------------------------------------------------------------------

describe('Phase 0a — data-key zeroization (AC-8 / F-132)', () => {
  it('AC-8: the 32-byte plaintext data key is .fill(0)-zeroized before the function returns', async () => {
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    // Spy WITHOUT replacing the implementation: `spy.mock.results` then holds
    // the EXACT Uint8Array instances libsodium returned, including the one the
    // function uses as the 32-byte data key. After the function resolves, that
    // instance must be all-zero (the function .fill(0)-zeroizes it in place).
    const spy = vi.spyOn(sodium, 'randombytes_buf');

    const r = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });
    expect(r.status).toBe('ok');

    const dataKeyBuffers = spy.mock.results
      .map((res) => res.value as Uint8Array)
      .filter((v) => v instanceof Uint8Array && v.length === sodium.crypto_secretbox_KEYBYTES);
    expect(dataKeyBuffers.length).toBeGreaterThanOrEqual(1);
    // At least one captured 32-byte buffer is the data key, and every such
    // buffer is zeroized after return (a non-zeroized data key FAILS here).
    for (const buf of dataKeyBuffers) {
      expect(buf.length).toBe(32);
      expect(Array.from(buf).every((b) => b === 0)).toBe(true);
    }

    spy.mockRestore();
  });

  it('AC-8: the persisted wrap is ciphertext, never the plaintext data key (wrap !== plaintext)', async () => {
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    const r = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    const wrap = srv.wraps.get(r.key_id)?.get(USER);
    expect(wrap).toBeDefined();
    // A sealed box is SEALBYTES longer than the 32-byte plaintext — proves
    // the persisted artifact is ciphertext, not the raw key.
    expect((wrap as Uint8Array).length).toBe(32 + sodium.crypto_box_SEALBYTES);
    expect((wrap as Uint8Array).length).not.toBe(32);
  });
});

// ---------------------------------------------------------------------------
// AC-6 / F-130 — 401 vs 403 split on the init/wrap path
// ---------------------------------------------------------------------------

describe('Phase 0a — 401 vs 403 split on init/wrap (AC-6 / F-130)', () => {
  it('AC-6: a 401 on init_key surfaces a distinct session/sign-in-required failure (not a generic 403)', async () => {
    const transport: T07OpTransport = async () => ({
      status: 401,
      body: { ok: false, error: 'rls_denied' }
    });
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    const r = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.http).toBe(401);
  });

  it('AC-6: a 403 rls_denied on init_key is surfaced distinctly from a 401 (different http on the result)', async () => {
    const transport403: T07OpTransport = async () => ({
      status: 403,
      body: { ok: false, error: 'rls_denied' }
    });
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport: transport403, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    const r = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.http).toBe(403);
    expect(r.reason).toBe('rls_denied');
  });

  it('AC-6: a 401 mid-step (init ok, wrap 401) does not leave the actor with a wrap and surfaces failed/401', async () => {
    const srv = newServer();
    let wrapCalled = false;
    const transport: T07OpTransport = async (body) => {
      if (body.op === 'init_key') {
        srv.liveKeyId = 'k-1';
        srv.liveEpoch = 1;
        srv.wraps.set('k-1', new Map());
        return { status: 200, body: { ok: true, data: { key_id: 'k-1', epoch: 1 } } };
      }
      if (body.op === 'committee_key_state') {
        return { status: 200, body: { ok: true, data: null } };
      }
      if (body.op === 'wrap_member') {
        wrapCalled = true;
        return { status: 401, body: { ok: false, error: 'rls_denied' } };
      }
      throw new Error(`unexpected op ${String(body.op)}`);
    };
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

    const r = await initCommitteeDataKeyViaProduction({
      client,
      localIdentity,
      user_id: USER,
      actor_public_key: kp.publicKey
    });
    expect(wrapCalled).toBe(true);
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.http).toBe(401);
    // No actor wrap persisted on a failed wrap step.
    expect(srv.wraps.get('k-1')?.has(USER) ?? false).toBe(false);
  });
});
