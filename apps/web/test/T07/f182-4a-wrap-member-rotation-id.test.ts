/**
 * F182-4a / ADR-0030 Amendment B, Decision B1 — thread an optional `rotation_id`
 * through `wrapMemberInViaProduction` (GAP B1).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE GAP (verified against the merged tree on this branch)
 * ───────────────────────────────────────────────────────────────────────────
 * `wrapMemberInViaProduction` (`crypto/production-flows.ts:733`) HARDCODES
 * `rotation_id: null` in its Step-4 wrap POST (`:910`). The wire client method
 * `wrapCommitteeDataKeyForMember` (`supabase-t07-client.ts:439`) ALREADY accepts
 * `rotation_id?: string | null` and threads it onto the `wrap_member` op body
 * (`:450`) — ONLY the composition drops it. ADR-0030 Decision 2(d) / Amendment B
 * Decision B1 require the re-wrap loop to associate each re-wrap with the rotation
 * event by passing the live `rotation_id` (so the removal-rotation audit pair —
 * `.rotation.started`/`.completed` + `wrapped_for_member` — reconstructs).
 *
 * F182-4a is the SMALLEST slice: add an optional `rotation_id?: string | null`
 * (default null) on the opts object and pass it straight through in place of the
 * `:910` hardcoded null.
 *
 * SCOPE PIN (load-bearing): F182-4a threads the ID ONLY. It does NOT change WHAT
 * is sealed — the composition still seals the holder's LIVE data key to
 * `disclosed.public_key`. Sealing the NEW rotation key is F182-4b's composition
 * concern, NOT this param change. The threaded test below therefore ALSO asserts
 * the seal target and recovered plaintext are byte-for-byte identical to the
 * omitted-rotation_id path.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TEST → ACCEPTANCE-CRITERION MAP
 * ───────────────────────────────────────────────────────────────────────────
 *   AC-B1a (grant path unchanged) — rotation_id OMITTED → the POSTed `wrap_member`
 *                                   carries `rotation_id: null` and the grant is
 *                                   byte-identical to today. GREEN positive
 *                                   control: it pins the byte-identical-when-
 *                                   omitted contract and MUST stay green through
 *                                   the change.
 *   AC-B1b (rotation_id threaded)  — rotation_id PROVIDED → the POSTed
 *                                   `wrap_member` carries THAT exact id; the seal
 *                                   target is still `disclosed.public_key` and the
 *                                   sealed plaintext is still the LIVE data key.
 *                                   RED until Decision B1 lands (current code
 *                                   posts null).
 *
 * Hermetic: a mock t07-op transport recording the wrap POST body (incl. its
 * `rotation_id`); a real BrowserLocalIdentityStore (SSR Map fallback); a real
 * CommitteeKeyHolder; real libsodium; the real `pubkeyFingerprint` (SHA-256) so
 * the composition's self-consistency assert is genuine. No real network, no real
 * clock, no seeded-RNG assertions — passes at any wall-clock time.
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
import { __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

await _sodium.ready;
const sodium = _sodium;

// Synthetic actor / target uids (no PI).
const ACTOR = '9f4e9b40-0000-4000-8000-00000000001a'; // SYNTHETIC_USER_COCHAIR
const TARGET = '9f4e9b40-0000-4000-8000-00000000002b'; // SYNTHETIC_USER_MEMBER
// A fixed synthetic rotation UUID — the value F182-4b's re-wrap loop would thread.
const ROTATION_ID = 'a1b2c3d4-0000-4000-8000-0000000f182a'; // SYNTHETIC_ROTATION_ID

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
 * The fake t07-op server the mock transport drives. Records the `wrap_member`
 * POST body INCLUDING its `rotation_id` field — the observable this tranche pins.
 */
interface FakeKeyServer {
  liveKeyId: string;
  liveEpoch: number;
  actorHasWrap: boolean;
  actorWrapBytes: Uint8Array | null;
  actorDataKey: Uint8Array | null;
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
    wrapPosted: null
  };
}

/**
 * Seed the actor's holder-side state: keypair for the ACTOR, device-local
 * privkey, the 32-byte live data-key, and its actor-sealed wrap.
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
 * A valid pre-disclosed `{public_key, fingerprint}` built with the REAL
 * `pubkeyFingerprint` (SHA-256) so the composition's self-consistency
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

function makeTransport(srv: FakeKeyServer): { transport: T07OpTransport; ops: string[] } {
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
      case 'wrap_member': {
        srv.wrapPosted = {
          member_user_id: String(body.member_user_id),
          key_id: String(body.key_id),
          sealed_hex: String(body.wrapped_ciphertext_hex),
          // The load-bearing capture: read the id VERBATIM off the wire. `null`
          // (current code) and a real uuid (post-B1) are distinguishable here.
          rotation_id: (body.rotation_id as string | null) ?? null
        };
        return { status: 200, body: { ok: true, data: null } };
      }
      default:
        throw new Error(`makeTransport: unexpected op ${String(body.op)}`);
    }
  };
  return { transport, ops };
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
// AC-B1a — rotation_id OMITTED: byte-identical grant (GREEN positive control)
// ===========================================================================

describe('F182-4a/AC-B1a — rotation_id OMITTED: the grant is byte-identical (posts rotation_id:null)', () => {
  it('a grant with NO rotation_id POSTs wrap_member with rotation_id:null and returns ok', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
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

    expect(r).toEqual({ status: 'ok' });
    // Exactly one wrap landed …
    expect(ops.filter((o) => o === 'wrap_member')).toHaveLength(1);
    expect(srv.wrapPosted).not.toBeNull();
    // … for the right target + the LIVE key …
    expect(srv.wrapPosted?.member_user_id).toBe(TARGET);
    expect(srv.wrapPosted?.key_id).toBe(srv.liveKeyId);
    // … carrying rotation_id:null (the byte-identical-when-omitted contract).
    expect(
      srv.wrapPosted?.rotation_id,
      'AC-B1a: an omitted rotation_id MUST still POST rotation_id:null (byte-identical grant)'
    ).toBeNull();
  });

  it('the omitted-rotation_id seal is unchanged: LIVE data key sealed to disclosed.public_key', async () => {
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
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

    // Open the POSTed sealed box with disclosed's private half → the actor's
    // LIVE data key, byte-for-byte. This is the crypto baseline the threaded
    // path must match exactly (F182-4a threads the id ONLY, not the sealed key).
    const opened = sodium.crypto_box_seal_open(
      pgHexToBytes((srv.wrapPosted as { sealed_hex: string }).sealed_hex),
      disclosed.public_key,
      disclosedPriv
    );
    expect(Array.from(opened)).toEqual(Array.from(actor.dataKey));
  });
});

// ===========================================================================
// AC-B1b — rotation_id PROVIDED: the exact id threads onto the wrap POST (RED)
// ===========================================================================

describe('F182-4a/AC-B1b — rotation_id PROVIDED: the exact id threads onto the wrap_member POST', () => {
  it('a grant with rotation_id set POSTs wrap_member carrying THAT exact rotation_id', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });
    const { disclosed } = await makeDisclosed();

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed,
      // The B1 extension: an optional field on the SAME opts object. Under the
      // current signature this is an excess property (test/** is tsc-excluded, so
      // it transpiles and runs); the composition currently ignores it and posts
      // null → this test is RED until Decision B1 threads it through.
      rotation_id: ROTATION_ID
    } as Parameters<typeof wrapMemberInViaProduction>[0] & { rotation_id: string });

    expect(r.status).toBe('ok');
    expect(ops.filter((o) => o === 'wrap_member')).toHaveLength(1);
    expect(srv.wrapPosted).not.toBeNull();
    // THE load-bearing RED assertion — current code hardcodes null (:910).
    expect(
      srv.wrapPosted?.rotation_id,
      'AC-B1b: wrapMemberInViaProduction must thread the caller-supplied rotation_id ' +
        'onto the wrap_member POST (Decision B1 — replace the hardcoded rotation_id:null ' +
        'at production-flows.ts:910 with opts.rotation_id). It is currently posting null, ' +
        'so the removal-rotation audit pair cannot reconstruct.'
    ).toBe(ROTATION_ID);
  });

  it('threading rotation_id does NOT change WHAT is sealed: still the LIVE data key to disclosed.public_key', async () => {
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });
    const { disclosed, priv: disclosedPriv } = await makeDisclosed();

    const sealSpy = vi.spyOn(sodium, 'crypto_box_seal');

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET,
      disclosed,
      rotation_id: ROTATION_ID
    } as Parameters<typeof wrapMemberInViaProduction>[0] & { rotation_id: string });

    expect(r.status).toBe('ok');

    // (a) the pubkey handed to crypto_box_seal is EXACTLY disclosed.public_key —
    // threading the id must not re-point the seal target.
    expect(sealSpy).toHaveBeenCalledTimes(1);
    const sealedToPubkey = sealSpy.mock.calls[0][1] as Uint8Array;
    expect(Array.from(sealedToPubkey)).toEqual(Array.from(disclosed.public_key));

    // (b) the sealed plaintext is STILL the holder's LIVE data key (NOT a new
    // rotation key — that is F182-4b's concern). Open the POSTed box to prove it.
    const opened = sodium.crypto_box_seal_open(
      pgHexToBytes((srv.wrapPosted as { sealed_hex: string }).sealed_hex),
      disclosed.public_key,
      disclosedPriv
    );
    expect(
      Array.from(opened),
      'F182-4a threads the id ONLY: the sealed plaintext must stay the LIVE data key ' +
        '(sealing a NEW key is F182-4b, out of scope for this param change)'
    ).toEqual(Array.from(actor.dataKey));

    // (c) the POSTed key_id is still the live key id.
    expect(srv.wrapPosted?.key_id).toBe(srv.liveKeyId);
    // (d) and the threaded id landed on the wire.
    expect(srv.wrapPosted?.rotation_id).toBe(ROTATION_ID);
  });
});
