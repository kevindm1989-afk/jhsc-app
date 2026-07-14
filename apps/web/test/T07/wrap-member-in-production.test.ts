/**
 * ADR-0029 P1-8d / Amendment A-8.6 — the SINGLE-DISCLOSURE refactor of
 * `wrapMemberInViaProduction`.
 *
 * This suite is REWRITTEN for the A-8.6 pinned signature. It supersedes the
 * P1-5 double-disclosure suite (the composition no longer fetches the target
 * pubkey itself — the caller/UI discloses ONCE, for the F-172 confirm screen,
 * and hands the pre-disclosed `{public_key, fingerprint}` to the composition).
 *
 *   BEFORE (P1-5):  wrapMemberInViaProduction({client, holder, localIdentity,
 *                     user_id, target_user_id})  — Step 2 internally called
 *                     `client.getMemberPubkey` → TWO `identity_pubkey
 *                     .disclosed_for_wrap` rows per grant + a TOCTOU (the
 *                     fingerprint the human CONFIRMED and the pubkey actually
 *                     SEALED were separate reads).
 *   AFTER  (A-8.6): wrapMemberInViaProduction({client, holder, localIdentity,
 *                     user_id, target_user_id,
 *                     disclosed: {public_key, fingerprint}})  — `disclosed`
 *                     is REQUIRED; the internal Step-2 `getMemberPubkey`
 *                     (production-flows.ts:689-717) is REMOVED; the
 *                     composition re-derives `pubkeyFingerprint(
 *                     disclosed.public_key)` and typed-fails unless it equals
 *                     `disclosed.fingerprint` AND `disclosed.public_key` is 32
 *                     bytes; then seals to `disclosed.public_key` and POSTs.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * RED-FIRST NOTE (for the implementer):
 *   These tests are written to FAIL against the CURRENT double-disclosing
 *   implementation and PASS once A-8.6 lands. The load-bearing structural
 *   property is asserted two independent ways:
 *     (1) `vi.spyOn(client, 'getMemberPubkey')` — the composition must call it
 *         ZERO times (the disclosure moved to the caller). Under current code
 *         it is called once → these assertions fail RED.
 *     (2) the mock transport records every dispatched op in `ops` — the string
 *         `get_member_pubkey` must NOT appear. Under current code it does → RED.
 *   The "seal target" property is asserted by spying on the libsodium singleton
 *   (`vi.spyOn(_sodium, 'crypto_box_seal')`, which — verified — intercepts the
 *   composition's `ready().crypto_box_seal(...)` call because `ready()` returns
 *   the same module singleton) AND by opening the POSTed sealed box with the
 *   private half of `disclosed.public_key`.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TEST → CONTRACT MAP
 * ───────────────────────────────────────────────────────────────────────────
 *   A-8.6 / F-179 mitigation (2)  — `disclosed` is REQUIRED (no-bypass): no
 *                                    seal path is reachable without a
 *                                    disclosed-and-confirmed pubkey. Documented
 *                                    at the TYPE level (`__typeLevelContract_*`;
 *                                    NOT gated — test/** is tsc-excluded, see
 *                                    that fn's note) AND ENFORCED at runtime (a
 *                                    cast-omitted `disclosed` yields a typed
 *                                    failure, NO seal, NO POST).
 *   A-8.6 / F-179 mitigation (1)  — ONE disclosure per grant: the composition
 *                                    NEVER calls `client.getMemberPubkey`.
 *   A-8.6 / F-179 mitigation (3)  — client-side self-consistency: a
 *                                    `{public_key, fingerprint}` whose derived
 *                                    `pubkeyFingerprint(public_key)` ≠
 *                                    `fingerprint` → typed fail, NO seal, NO
 *                                    POST. A non-32-byte `public_key` → typed
 *                                    fail (the re-pointed :722-725 check).
 *   A-8.6 / F-179 mitigation (4)  — confirmed == sealed (TOCTOU closed): the
 *   / F-172                          pubkey handed to `crypto_box_seal` and
 *                                    POSTed is EXACTLY `disclosed.public_key`,
 *                                    not any re-fetched value.
 *   A-8.6 (happy)                 — the new signature grants a member key with
 *                                    ONE disclosure (in the caller) and ONE
 *                                    wrap POST.
 *   A-8.6 / F-174 (Step 1 kept)   — a co-chair with no wrap short-circuits to
 *                                    `actor_has_no_wrap` BEFORE any seal (and
 *                                    with NO disclosure), preserving the
 *                                    abort-without-audit property.
 *   Preserved behavioural guards  — holder retains the data key (Decision 5
 *   (must survive the refactor)      step 5); F-176 leak sweep; heap-only (no
 *                                    Storage write); ADR-0003 Invariant 1
 *                                    (plaintext data key never crosses the
 *                                    wire); F-148 (never throws a raw error);
 *                                    wrap_post_failed on a mid-grant target
 *                                    deactivation.
 *
 * Hermetic: a mock t07-op transport with op-capture; a real
 * BrowserLocalIdentityStore (SSR Map fallback); a real CommitteeKeyHolder;
 * real libsodium; real `pubkeyFingerprint` (SHA-256) so every fingerprint
 * match/mismatch is genuine. No real network, no real clock, no seeded RNG.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import {
  BrowserLocalIdentityStore,
  CommitteeKeyHolder,
  SupabaseT07Client,
  pubkeyFingerprint,
  wrapMemberInViaProduction,
  type T07OpTransport
} from '../../src/lib/crypto';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

await _sodium.ready;
const sodium = _sodium;

// Synthetic actor / target uids — the F-176 sweep asserts neither appears in
// any log line.
const ACTOR = '9f4e9b40-0000-4000-8000-00000000001a'; // SYNTHETIC_USER_COCHAIR
const TARGET = '9f4e9b40-0000-4000-8000-00000000002b'; // SYNTHETIC_USER_MEMBER

function bytesToPgHex(b: Uint8Array): string {
  let s = '\\x';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
}

function pgHexToBytes(h: string): Uint8Array {
  const body = h.startsWith('\\x') ? h.slice(2) : h;
  return new Uint8Array(body.match(/.{1,2}/g)!.map((x) => parseInt(x, 16)));
}

function silentStore(): BrowserLocalIdentityStore {
  return new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
}

/**
 * The fake t07-op server the mock transport drives. Models the reads the
 * composition needs post-A-8.6:
 *   - committee_key_state  (metadata probe; Step 1 holder-unwrap fallback)
 *   - get_key_wrap         (the actor's own sealed wrap; Step 1 fallback)
 *   - wrap_member          (Step 4 — lands the seal)
 * `get_member_pubkey` is STILL modelled so the CURRENT (pre-refactor) code —
 * which still calls it internally — runs to completion and the RED failures
 * are about the composition's OBSERVABLE structure, not an incidental throw.
 * After A-8.6 the composition MUST NOT dispatch it at all.
 */
interface FakeKeyServer {
  liveKeyId: string;
  liveEpoch: number;
  actorHasWrap: boolean;
  actorWrapBytes: Uint8Array | null;
  actorDataKey: Uint8Array | null;
  // The SERVER-side pubkey the REMOVED internal disclosure would return. Kept
  // ONLY so the current double-disclosing code completes; the A-8.6 code never
  // reads it. Deliberately a DIFFERENT keypair than `disclosed` so the
  // confirmed==sealed test sees current code seal to the wrong key.
  serverTargetPubkey: Uint8Array | null;
  serverTargetFingerprint: string | null;
  wrapPosted:
    | null
    | { member_user_id: string; key_id: string; sealed_hex: string; rotation_id: string | null };
}

function newServer(): FakeKeyServer {
  return {
    liveKeyId: 'k-live-1',
    liveEpoch: 7,
    actorHasWrap: true,
    actorWrapBytes: null,
    actorDataKey: null,
    serverTargetPubkey: null,
    serverTargetFingerprint: null,
    wrapPosted: null
  };
}

/**
 * Seed the actor's holder-side state: keypair for the ACTOR, device-local
 * privkey, the 32-byte data-key oracle, and its actor-sealed wrap (so the
 * Step-1 holder-unwrap fallback can populate the holder).
 */
async function seedActor(
  srv: FakeKeyServer,
  localIdentity: BrowserLocalIdentityStore
): Promise<{ pub: Uint8Array; priv: Uint8Array; dataKey: Uint8Array }> {
  const kp = sodium.crypto_box_keypair();
  await localIdentity.storeIdentityPrivateKey(ACTOR, kp.privateKey);
  const dataKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  srv.actorDataKey = dataKey;
  srv.actorWrapBytes = sodium.crypto_box_seal(dataKey, kp.publicKey);
  return { pub: kp.publicKey, priv: kp.privateKey, dataKey };
}

/**
 * Seed the SERVER's disclosure return (the value the REMOVED internal
 * `getMemberPubkey` would produce). Lets the CURRENT code complete a grant so
 * the RED assertions bite on structure/seal-target, not on an incidental error
 * path. The A-8.6 code never touches this.
 */
function seedServerTarget(srv: FakeKeyServer): { pub: Uint8Array; priv: Uint8Array } {
  const kp = sodium.crypto_box_keypair();
  srv.serverTargetPubkey = kp.publicKey;
  srv.serverTargetFingerprint = sodium.to_hex(sodium.crypto_generichash(32, kp.publicKey));
  return { pub: kp.publicKey, priv: kp.privateKey };
}

/**
 * Build a valid pre-disclosed `{public_key, fingerprint}` using the REAL
 * `pubkeyFingerprint` (SHA-256), so the composition's self-consistency
 * re-derivation matches. Returns the private half for open-the-seal proofs.
 */
async function makeDisclosed(): Promise<{
  disclosed: { public_key: Uint8Array; fingerprint: string };
  priv: Uint8Array;
}> {
  const kp = sodium.crypto_box_keypair();
  const fingerprint = await pubkeyFingerprint(kp.publicKey);
  return { disclosed: { public_key: kp.publicKey, fingerprint }, priv: kp.privateKey };
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
        if (!srv.actorWrapBytes) return { status: 200, body: { ok: true, data: null } };
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              key_id: srv.liveKeyId,
              epoch: srv.liveEpoch,
              wrapped_ciphertext_hex: bytesToPgHex(srv.actorWrapBytes)
            }
          }
        };
      case 'get_member_pubkey': {
        // A-8.6: the composition MUST NOT dispatch this. Modelled only so the
        // pre-refactor code completes (its presence in `ops` is itself a RED
        // signal after the refactor).
        if (!srv.serverTargetPubkey || !srv.serverTargetFingerprint) {
          return { status: 404, body: { ok: false, error: 'not_found' } };
        }
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              public_key_hex: bytesToPgHex(srv.serverTargetPubkey),
              fingerprint: srv.serverTargetFingerprint
            }
          }
        };
      }
      case 'wrap_member': {
        srv.wrapPosted = {
          member_user_id: String(body.member_user_id),
          key_id: String(body.key_id),
          sealed_hex: String(body.wrapped_ciphertext_hex),
          rotation_id: (body.rotation_id as string | null) ?? null
        };
        return { status: 200, body: { ok: true, data: null } };
      }
      default:
        throw new Error(`makeTransport: unexpected op ${String(body.op)}`);
    }
  };
  return { transport, ops, bodies };
}

/**
 * TYPE-LEVEL CONTRACT — A-8.6 / F-179 mitigation (2): `disclosed` is a REQUIRED
 * parameter, so there is no COMPILE-TIME path to a seal without a
 * disclosed-and-confirmed pubkey. This function is never invoked; it exists
 * only to pin the type contract.
 *
 * How it would gate: against the CURRENT signature (no `disclosed` field) the
 * `@ts-expect-error` below is UNUSED → `tsc` raises TS2578; it goes GREEN once
 * the implementer makes `disclosed` required. The excess-property `disclosed:`
 * literals throughout this file are the mirror pin (TS2353 under the current
 * signature, clean under A-8.6).
 *
 * ⚠️ NOT CURRENTLY GATED: this project EXCLUDES `test/**` from tsc
 * (`apps/web/tsconfig.json` `exclude`), and there is no separate typecheck over
 * the test tree — so `npm run typecheck` does NOT surface this. The ENFORCED
 * no-bypass check is therefore the RUNTIME test below (a cast-omitted
 * `disclosed` → typed failure, NO seal, NO POST). Flagged for the implementer/
 * verifier: add `test/**` to a typecheck program to promote this contract from
 * documented to gated.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function __typeLevelContract_disclosedRequired(): Promise<void> {
  const base = {
    client: null as unknown as SupabaseT07Client,
    holder: null as unknown as CommitteeKeyHolder,
    localIdentity: null as unknown as BrowserLocalIdentityStore,
    user_id: ACTOR,
    target_user_id: TARGET
  };
  // @ts-expect-error A-8.6/F-179: omitting `disclosed` MUST be a compile error.
  await wrapMemberInViaProduction(base);
}
void __typeLevelContract_disclosedRequired;

beforeEach(() => {
  __resetCapture();
  __setTestSink();
});

afterEach(() => {
  __resetCapture();
  vi.restoreAllMocks();
});

// ===========================================================================
// (1) A-8.6 / F-179 mitigation (2) — `disclosed` is REQUIRED (no-bypass)
// ===========================================================================

describe('A-8.6/F-179 — `disclosed` is required (no-bypass)', () => {
  it('a runtime call omitting `disclosed` returns a typed failure and reaches NO seal / NO wrap POST', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedServerTarget(srv); // lets the CURRENT code run all the way through
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    const sealSpy = vi.spyOn(sodium, 'crypto_box_seal');
    const getPubSpy = vi.spyOn(client, 'getMemberPubkey');
    const wrapSpy = vi.spyOn(client, 'wrapCommitteeDataKeyForMember');

    // Deliberately omit `disclosed`. The double-cast compiles under BOTH the
    // current signature (no `disclosed`) and the A-8.6 signature (`disclosed`
    // required) so the vitest transform is unaffected either way.
    const optsNoDisclosed = {
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET
    };
    const r = await wrapMemberInViaProduction(
      optsNoDisclosed as unknown as Parameters<typeof wrapMemberInViaProduction>[0]
    ).catch((e: unknown) => {
      // F-148: the composition must map the missing-disclosure to a typed
      // failure, NEVER throw (a raw error could carry buffer bytes).
      throw new Error(
        `A-8.6/F-179: wrapMemberInViaProduction must not throw when \`disclosed\` is ` +
          `absent — it must typed-fail. Got: ${
            e instanceof Error ? e.constructor.name : 'non-error throw'
          }`
      );
    });

    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    // A typed, closed-set reason (the missing/invalid pubkey class).
    expect(['invalid_pubkey', 'unknown']).toContain(r.reason);

    // Load-bearing: NO seal, NO wrap POST were performed.
    expect(sealSpy).toHaveBeenCalledTimes(0);
    expect(wrapSpy).toHaveBeenCalledTimes(0);
    expect(srv.wrapPosted).toBeNull();
    expect(ops).not.toContain('wrap_member');
    // And the composition performed NO internal disclosure either.
    expect(getPubSpy).toHaveBeenCalledTimes(0);
    expect(ops).not.toContain('get_member_pubkey');
  });
});

// ===========================================================================
// (2) A-8.6 / F-179 mitigation (1) — single disclosure: NO internal re-fetch
// ===========================================================================

describe('A-8.6/F-179 — single disclosure: the composition never calls getMemberPubkey', () => {
  it('a full successful grant dispatches NO get_member_pubkey (the disclosure lives in the caller)', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedServerTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });
    const { disclosed } = await makeDisclosed();

    const getPubSpy = vi.spyOn(client, 'getMemberPubkey');

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed
    });

    expect(r.status).toBe('ok');
    // THE load-bearing structural property — one disclosure per grant.
    expect(getPubSpy).toHaveBeenCalledTimes(0);
    expect(ops).not.toContain('get_member_pubkey');
    // The wrap still lands exactly once, for the right target + live key.
    expect(srv.wrapPosted).not.toBeNull();
    expect(srv.wrapPosted?.member_user_id).toBe(TARGET);
    expect(srv.wrapPosted?.key_id).toBe(srv.liveKeyId);
  });

  it('the only ops dispatched are a subset of {committee_key_state, get_key_wrap, wrap_member}', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedServerTarget(srv);
    // Holder empty → exercises Step-1 fallback ops too (probe + get_key_wrap).
    const { disclosed } = await makeDisclosed();

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed
    });

    expect(r.status).toBe('ok');
    for (const op of ops) {
      expect(op).toMatch(/^(committee_key_state|get_key_wrap|wrap_member)$/);
    }
    // Explicit: the disclosure op is gone from the composition.
    expect(ops).not.toContain('get_member_pubkey');
  });
});

// ===========================================================================
// (3) A-8.6 / F-179 mitigation (3) — self-consistency: fingerprint mismatch
// ===========================================================================

describe('A-8.6/F-179 — self-consistency assert (fingerprint mismatch)', () => {
  it('disclosed {public_key: PK, fingerprint: WRONG} where pubkeyFingerprint(PK) ≠ WRONG → typed fail, NO seal, NO POST', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedServerTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    // A genuine mismatch: PK is a real 32-byte pubkey; the fingerprint is the
    // REAL SHA-256 of a DIFFERENT pubkey (the TOCTOU shape — the confirmed
    // fingerprint belongs to a pubkey the disclosed bytes no longer are).
    const pk = sodium.crypto_box_keypair().publicKey;
    const otherPub = sodium.crypto_box_keypair().publicKey;
    const wrongFingerprint = await pubkeyFingerprint(otherPub);
    // Precondition: the mismatch is real (not an accidental collision).
    expect(await pubkeyFingerprint(pk)).not.toBe(wrongFingerprint);

    const sealSpy = vi.spyOn(sodium, 'crypto_box_seal');
    const wrapSpy = vi.spyOn(client, 'wrapCommitteeDataKeyForMember');

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed: { public_key: pk, fingerprint: wrongFingerprint }
    });

    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(['invalid_pubkey', 'unknown']).toContain(r.reason);

    // Both mocks uncalled — the composition aborted BEFORE the seal step.
    expect(sealSpy).toHaveBeenCalledTimes(0);
    expect(wrapSpy).toHaveBeenCalledTimes(0);
    expect(srv.wrapPosted).toBeNull();
    expect(ops).not.toContain('wrap_member');
  });
});

// ===========================================================================
// (4) A-8.6 / F-179 mitigation (3) — 32-byte pubkey length guard
// ===========================================================================

describe('A-8.6/F-179 — 32-byte pubkey length guard', () => {
  it('disclosed.public_key of length ≠ 32 (even with a self-consistent fingerprint) → typed fail, NO seal, NO POST', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedServerTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    // 31 bytes — a wrong-length pubkey. Its fingerprint is computed over the
    // SAME (wrong-length) bytes so the self-consistency check passes and the
    // LENGTH guard is unambiguously what fires.
    const badPub = new Uint8Array(31).fill(7);
    const selfConsistentFingerprint = await pubkeyFingerprint(badPub);

    const sealSpy = vi.spyOn(sodium, 'crypto_box_seal');
    const wrapSpy = vi.spyOn(client, 'wrapCommitteeDataKeyForMember');

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed: { public_key: badPub, fingerprint: selfConsistentFingerprint }
    });

    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    // The re-pointed :722-725 structural check.
    expect(r.reason).toBe('invalid_pubkey');

    expect(sealSpy).toHaveBeenCalledTimes(0);
    expect(wrapSpy).toHaveBeenCalledTimes(0);
    expect(srv.wrapPosted).toBeNull();
    expect(ops).not.toContain('wrap_member');
  });
});

// ===========================================================================
// (5) A-8.6 / F-179 mitigation (4) / F-172 — confirmed == sealed (TOCTOU closed)
// ===========================================================================

describe('A-8.6/F-172 — confirmed == sealed: the seal target is exactly disclosed.public_key', () => {
  it('crypto_box_seal receives disclosed.public_key, and the POSTed box opens with its private half', async () => {
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    // A DIFFERENT server-side key: under current (double-disclosing) code the
    // seal goes here, NOT to `disclosed.public_key` → this test fails RED.
    seedServerTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    const { disclosed, priv: disclosedPriv } = await makeDisclosed();

    const sealSpy = vi.spyOn(sodium, 'crypto_box_seal');

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed
    });
    expect(r.status).toBe('ok');

    // (a) the pubkey handed to crypto_box_seal is EXACTLY disclosed.public_key.
    expect(sealSpy).toHaveBeenCalledTimes(1);
    const sealedToPubkey = sealSpy.mock.calls[0][1] as Uint8Array;
    expect(Array.from(sealedToPubkey)).toEqual(Array.from(disclosed.public_key));

    // (b) behavioural proof: the POSTed box opens with disclosed's private half
    // and recovers the actor's data key byte-for-byte (confirmed == sealed).
    expect(srv.wrapPosted).not.toBeNull();
    const sealed = pgHexToBytes((srv.wrapPosted as { sealed_hex: string }).sealed_hex);
    const opened = sodium.crypto_box_seal_open(sealed, disclosed.public_key, disclosedPriv);
    expect(Array.from(opened)).toEqual(Array.from(actor.dataKey));
  });

  it('sealed bytes are exactly 32 + crypto_box_SEALBYTES (a sealed box, not the plaintext data key)', async () => {
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedServerTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });
    const { disclosed } = await makeDisclosed();

    const getPubSpy = vi.spyOn(client, 'getMemberPubkey');

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed
    });
    expect(r.status).toBe('ok');
    // Single-disclosure invariant (makes this test RED under current code too).
    expect(getPubSpy).toHaveBeenCalledTimes(0);

    const sealedLen = pgHexToBytes((srv.wrapPosted as { sealed_hex: string }).sealed_hex).length;
    expect(sealedLen).toBe(32 + sodium.crypto_box_SEALBYTES);
    expect(sealedLen).not.toBe(32); // canary against shipping the plaintext key
  });
});

// ===========================================================================
// (6) A-8.6 — happy path with the new signature
// ===========================================================================

describe('A-8.6 — happy path (new signature)', () => {
  it('a valid `disclosed` whose fingerprint matches → seals to disclosed.public_key, POSTs once, returns ok', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedServerTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });
    const { disclosed, priv: disclosedPriv } = await makeDisclosed();

    const getPubSpy = vi.spyOn(client, 'getMemberPubkey');
    const wrapSpy = vi.spyOn(client, 'wrapCommitteeDataKeyForMember');

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed
    });

    // Success variant of WrapMemberInResult.
    expect(r).toEqual({ status: 'ok' });
    // Exactly one wrap POST, no internal disclosure.
    expect(wrapSpy).toHaveBeenCalledTimes(1);
    expect(getPubSpy).toHaveBeenCalledTimes(0);
    expect(ops.filter((o) => o === 'wrap_member')).toHaveLength(1);
    // Sealed to the disclosed (confirmed) pubkey.
    const sealed = pgHexToBytes((srv.wrapPosted as { sealed_hex: string }).sealed_hex);
    const opened = sodium.crypto_box_seal_open(sealed, disclosed.public_key, disclosedPriv);
    expect(Array.from(opened)).toEqual(Array.from(actor.dataKey));
    expect(srv.wrapPosted?.rotation_id).toBeNull();
  });

  it('Step 1 preserved: when the holder is empty AND the actor has a wrap, it unwraps first then grants with ONE disclosure', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    await seedActor(srv, localIdentity);
    seedServerTarget(srv);
    expect(holder.isPopulated()).toBe(false);
    const { disclosed } = await makeDisclosed();

    const getPubSpy = vi.spyOn(client, 'getMemberPubkey');

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed
    });

    expect(r.status).toBe('ok');
    // Step-1 fallback ran (probe + unwrap) …
    expect(ops).toContain('committee_key_state');
    expect(ops).toContain('get_key_wrap');
    // … the wrap landed …
    expect(ops).toContain('wrap_member');
    // … and the holder is now populated (unwrap side effect) …
    expect(holder.isPopulated()).toBe(true);
    // … all with ZERO internal disclosure.
    expect(getPubSpy).toHaveBeenCalledTimes(0);
    expect(ops).not.toContain('get_member_pubkey');
  });
});

// ===========================================================================
// (7) A-8.6 / F-174 — Step 1 preserved: actor_has_no_wrap short-circuit
//     (a PRESERVED invariant — passes against current code AND must keep
//     passing after the refactor: an unprovisioned co-chair aborts BEFORE any
//     disclosure/seal, leaving no `disclosed_for_wrap` audit row.)
// ===========================================================================

describe('A-8.6/F-174 — an unprovisioned co-chair aborts before any disclosure or seal', () => {
  it('actor has no wrap and the holder is empty → actor_has_no_wrap, NO disclosure, NO seal, NO wrap POST', async () => {
    const srv = newServer();
    srv.actorHasWrap = false;
    srv.actorWrapBytes = null;
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    // Device has a privkey (this is "no key ACCESS", not "no device key").
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(ACTOR, kp.privateKey);
    seedServerTarget(srv);
    const { disclosed } = await makeDisclosed();

    const sealSpy = vi.spyOn(sodium, 'crypto_box_seal');
    const getPubSpy = vi.spyOn(client, 'getMemberPubkey');

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed
    });

    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('actor_has_no_wrap');
    // F-174 abort-without-audit: no disclosure, no seal, no wrap.
    expect(getPubSpy).toHaveBeenCalledTimes(0);
    expect(ops).not.toContain('get_member_pubkey');
    expect(sealSpy).toHaveBeenCalledTimes(0);
    expect(ops).not.toContain('wrap_member');
    expect(srv.wrapPosted).toBeNull();
  });
});

// ===========================================================================
// Preserved behavioural guards (must survive the refactor)
// ===========================================================================

describe('A-8.6 — wrap_post_failed (target deactivated mid-grant)', () => {
  it('wrap_member returning rls_denied → failed/wrap_post_failed', async () => {
    const srv = newServer();
    const localIdentity = silentStore();
    const base = makeTransport(srv);
    const transport: T07OpTransport = async (body) => {
      if (body.op === 'wrap_member') {
        return { status: 403, body: { ok: false, error: 'rls_denied' } };
      }
      return base.transport(body);
    };
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedServerTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });
    const { disclosed } = await makeDisclosed();

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed
    });

    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('wrap_post_failed');
  });
});

describe('A-8.6 — Decision 5 step 5: the holder retains the data key after a successful grant', () => {
  it('after a successful grant the holder still holds the ORIGINAL live data key (no premature zeroize)', async () => {
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedServerTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });
    const { disclosed } = await makeDisclosed();

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed
    });
    expect(r.status).toBe('ok');

    expect(holder.isPopulated()).toBe(true);
    const live = holder.getDataKey();
    expect(live).not.toBeNull();
    expect(Array.from(live!)).toEqual(Array.from(actor.dataKey));
    expect(Array.from(live!).some((b) => b !== 0)).toBe(true);
  });
});

// ===========================================================================
// ADV-2 — a holder wipe DURING the seal window must not POST a zero-key wrap.
// `getDataKey()` hands out the live buffer BY REFERENCE (:688). If a wipe
// trigger (401 / panic / sign-out) fires during the `await pubkeyFingerprint`
// / `await ready()` window before the synchronous `crypto_box_seal` (:739), the
// buffer is zeroized in place — and the current code seals + POSTs that all-zero
// key. Fix: re-check `holder.isPopulated()` immediately before the seal and
// typed-fail (`data_key_unwrap_failed`) if wiped.
// ===========================================================================

describe('A-8.6/ADV-2 — a holder wipe during the seal window seals + POSTs nothing', () => {
  it('a wipe between the key read and the seal → data_key_unwrap_failed, NO seal, NO wrap POST', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });

    // A holder whose FIRST getDataKey() read schedules a wipe on the next
    // microtask. The composition reads the key at :688 (no await follows until
    // :722), so the scheduled wipe lands inside the `await pubkeyFingerprint(...)`
    // window — strictly between the key read and the synchronous seal at :739.
    // Deterministic: microtasks queued before the composition yields run FIFO at
    // the first suspension point.
    class WipeDuringSealHolder extends CommitteeKeyHolder {
      armed = false;
      getDataKey(): Uint8Array | null {
        const k = super.getDataKey();
        if (this.armed) {
          this.armed = false;
          queueMicrotask(() => this.wipe());
        }
        return k;
      }
    }
    const holder = new WipeDuringSealHolder();
    const actor = await seedActor(srv, localIdentity);
    seedServerTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });
    const { disclosed } = await makeDisclosed();

    const sealSpy = vi.spyOn(sodium, 'crypto_box_seal');
    const wrapSpy = vi.spyOn(client, 'wrapCommitteeDataKeyForMember');

    holder.armed = true; // arm the race for THIS grant only
    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed
    });

    // The load-bearing pin: a zeroized key must NOT be sealed and POSTed.
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('data_key_unwrap_failed');
    expect(sealSpy, 'no seal is built from a zeroized key').toHaveBeenCalledTimes(0);
    expect(wrapSpy, 'no wrap POST for a wiped-mid-seal grant').toHaveBeenCalledTimes(0);
    expect(srv.wrapPosted, 'no zero-key wrap reaches the server').toBeNull();
    expect(ops).not.toContain('wrap_member');
  });
});

describe('A-8.6 — ADR-0003 Invariant 1: the plaintext data key never crosses the wire', () => {
  it('no request body the EF sees carries the plaintext 32-byte data key hex', async () => {
    const srv = newServer();
    const { transport, bodies } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedServerTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });
    const { disclosed } = await makeDisclosed();

    await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed
    });

    const dataKeyHex = sodium.to_hex(actor.dataKey);
    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toContain(dataKeyHex);
    }
  });

  it('no sessionStorage / localStorage write occurs during the grant (data key + seal are heap-only)', async () => {
    const setSpy = vi.spyOn(Storage.prototype, 'setItem');
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedServerTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });
    const { disclosed } = await makeDisclosed();

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed
    });
    expect(r.status).toBe('ok');
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('A-8.6/F-176 — key-material + pseudonym leak sweep', () => {
  it('happy path: data key / disclosed pubkey+privkey / actor privkey / sealed bytes / uids / fingerprint never appear in logs', async () => {
    const errs: string[] = [];
    const warns: string[] = [];
    const infos: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => {
      errs.push(a.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation((...a) => {
      warns.push(a.map(String).join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation((...a) => {
      infos.push(a.map(String).join(' '));
    });

    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedServerTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });
    const { disclosed, priv: disclosedPriv } = await makeDisclosed();

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed
    });
    expect(r.status).toBe('ok');

    const banned = [
      sodium.to_hex(actor.dataKey), // the committee data key
      sodium.to_hex(actor.priv), // the actor device privkey
      sodium.to_hex(disclosedPriv), // the target device privkey
      sodium.to_hex(disclosed.public_key), // the target pubkey
      sodium.to_hex(sodium.crypto_box_seal(actor.dataKey, disclosed.public_key)), // sealed wrap
      disclosed.fingerprint, // re-identification aid
      TARGET, // target pseudonym source
      ACTOR // actor identity
    ];
    const haystacks = [
      ...errs,
      ...warns,
      ...infos,
      ...__getCapturedLines().map((l) => JSON.stringify(l))
    ];
    for (const h of haystacks) {
      for (const secret of banned) {
        expect(h).not.toContain(secret);
      }
    }
  });
});

describe('A-8.6/F-148 — the composition never throws a raw error on transport failure', () => {
  it('a transport that throws on wrap_member is caught and mapped to a typed failure carrying no key bytes', async () => {
    const srv = newServer();
    const base = makeTransport(srv);
    const transport: T07OpTransport = async (body) => {
      if (body.op === 'wrap_member') {
        // A payload shaped like it might carry key material — if the
        // composition surfaced it verbatim, bytes would leak.
        throw new Error(`network failure: ${sodium.to_hex(srv.actorDataKey ?? new Uint8Array(32))}`);
      }
      return base.transport(body);
    };
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedServerTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });
    const { disclosed } = await makeDisclosed();

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed
    }).catch((e: unknown) => {
      throw new Error(
        `F-148: wrapMemberInViaProduction must not throw on transport failure; got: ${
          e instanceof Error ? e.constructor.name : 'unknown'
        }`
      );
    });

    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(['wrap_post_failed', 'unknown']).toContain(r.reason);
    for (const v of Object.values(r as Record<string, unknown>)) {
      expect(v instanceof Uint8Array).toBe(false);
      if (typeof v === 'string') {
        expect(v).not.toContain(sodium.to_hex(actor.dataKey));
      }
    }
  });
});
