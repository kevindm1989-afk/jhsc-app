/**
 * ADR-0029 P1-5 — `wrapMemberInViaProduction` (the co-chair-side composition
 * that fetches a member's pubkey via the new disclosure RPC, opens the
 * actor's own committee data key, seals the data key to the member's pubkey
 * via libsodium `crypto_box_seal`, and lands the wrap via the existing
 * `wrap_committee_data_key_for_member` RPC).
 *
 * This is the FIRST production composition that operates against ANOTHER
 * member's pubkey. Every prior wrap (Phase 0a / 2a / 2b) sealed to the
 * actor's OWN pubkey. ADR-0029 Decisions 4 + 5; threat-model §3.18
 * F-172 / F-174 / F-176.
 *
 * RED-FIRST (TDD): written against:
 *   - `SupabaseT07Client.getMemberPubkey(input)` (P1-5)
 *   - `wrapMemberInViaProduction(...)` exported from `src/lib/crypto` (P1-5)
 * Both do NOT exist on `main`; the imports below fail to resolve until the
 * implementer lands them. The implementer treats this file as READ-ONLY.
 *
 * Surface under test (per ADR-0029 Decision 5):
 *
 *   wrapMemberInViaProduction({
 *     client: SupabaseT07Client,
 *     holder: CommitteeKeyHolder,
 *     localIdentity: LocalIdentityStore,  // for the holder-unwrap fallback
 *     user_id: string,                    // the actor's own uid (caller)
 *     target_user_id: string              // the member to grant key access to
 *   }) ->
 *     | { status: 'ok' }
 *     | { status: 'member_not_enrolled' }       // disclosure RPC: no pubkey
 *     | { status: 'failed';
 *         reason:
 *           | 'pubkey_disclosure_denied'        // disclosure rls_denied
 *           | 'actor_has_no_wrap'               // holder empty + probe says no
 *           | 'data_key_unwrap_failed'          // holder unwrap failed
 *           | 'wrap_post_failed'                // wrap_member RPC failed
 *           | 'decrypt_failed'                  // (defensive; bad holder bytes)
 *           | 'invalid_pubkey'                  // server returned wrong-length
 *         ; http?: number }
 *
 * Hermetic: a mock t07-op transport with op-capture (mirrors
 * phase2a-unwrap-composition.test.ts); a real BrowserLocalIdentityStore (SSR
 * Map fallback); a real CommitteeKeyHolder; real libsodium. No real network,
 * no real clock, no seeded RNG (we capture what libsodium hands out).
 *
 * ───────────────────────────────────────────────────────────────────────
 * TEST → FINDING / DECISION MAP
 * ───────────────────────────────────────────────────────────────────────
 *   Decision 5 step 2 / F-172 — composition fetches the TARGET pubkey from
 *                               get_member_pubkey (server-bound), NOT from
 *                               a caller-supplied input; the sealed-to key
 *                               MUST equal the server-returned bytes byte-
 *                               for-byte.
 *   Decision 5 step 3 / F-172 — composition seals the data key with
 *                               crypto_box_seal (libsodium, sender-anonymous).
 *                               The wrap is a sealed box, NOT a secretbox.
 *   Decision 5 step 4 / F-172 — composition POSTs via wrap_committee_data_key_for_member
 *                               (the existing `wrap_member` op) with the
 *                               sealed bytes only; rotation_id is null
 *                               (non-rotation grant).
 *   Decision 5 step 5         — composition does NOT zeroize holder.data_key
 *                               (the holder owns its lifecycle; the unwrap
 *                               composition handed back live bytes by
 *                               reference, Decision 2 step 5).
 *   F-172                     — the plaintext data key NEVER appears in any
 *                               request the EF receives (only the sealed bytes
 *                               do); also asserted via SEALBYTES length.
 *   F-172 / Decision 4 Rejected (a)
 *                             — server-side-seal STAYS rejected: no RPC /
 *                               EF op accepts a plaintext data key; no
 *                               request body field in the wire history
 *                               carries the data key (a structural / wire
 *                               pin, not just a "the implementer didn't
 *                               write it").
 *   F-174                     — member_not_enrolled: the disclosure RPC
 *                               returning the closed denial maps to a
 *                               typed terminal state (no wrap POSTed; the
 *                               co-chair UI surfaces "this member isn't
 *                               ready").
 *   F-176                     — leak sweep: the 32-byte plaintext data key,
 *                               the target's pubkey bytes, the sealed wrap
 *                               bytes, the device privkey, the target uid,
 *                               and the actor uid never appear in
 *                               console.* / thrown errors / structured
 *                               logs / sessionStorage / localStorage.
 *   F-148 carry-forward       — typed failure shapes; the composition NEVER
 *                               throws a raw libsodium error (which could
 *                               carry key bytes in its message/stack).
 *
 * Cross-ref: phase2a-unwrap-composition.test.ts is the sibling pattern;
 * mirror the FakeKeyServer shape and the leak-sweep helper.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import {
  BrowserLocalIdentityStore,
  CommitteeKeyHolder,
  SupabaseT07Client,
  type T07OpTransport
} from '../../src/lib/crypto';
// RED-FIRST: the implementer adds this export at P1-5. Importing it here
// pins the public name + signature.
import { wrapMemberInViaProduction } from '../../src/lib/crypto';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

await _sodium.ready;
const sodium = _sodium;

// Synthetic actor / target uids — the F-176 sweep will assert neither
// appears in any log line.
const ACTOR = '9f4e9b40-0000-4000-8000-00000000001a'; // SYNTHETIC_USER_COCHAIR
const TARGET = '9f4e9b40-0000-4000-8000-00000000002b'; // SYNTHETIC_USER_MEMBER

function bytesToPgHex(b: Uint8Array): string {
  let s = '\\x';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
}

function silentStore(): BrowserLocalIdentityStore {
  return new BrowserLocalIdentityStore({ idbFactory: null, warn: () => undefined });
}

/**
 * The fake t07-op server the mock transport drives. Models the three reads
 * the composition needs:
 *   - committee_key_state  (metadata probe; reused from holder-unwrap path)
 *   - get_key_wrap         (the actor's own sealed wrap; reused from unwrap)
 *   - get_member_pubkey    (NEW — the target's pubkey for Decision 5 step 2)
 *   - wrap_member          (the existing wrap-for-member RPC; lands the seal)
 */
interface FakeKeyServer {
  // Live committee key
  liveKeyId: string;
  liveEpoch: number;
  // The actor's holdings (used by the holder-unwrap fallback path)
  actorHasWrap: boolean;
  actorWrapBytes: Uint8Array | null; // sealed-to-actor wrap; if set, holder can
                                     // be filled by unwrap; if null, holder
                                     // stays empty.
  actorDataKey: Uint8Array | null;   // the 32-byte oracle — what the holder
                                     // would resolve to.
  // The target's enrolled pubkey (the NEW disclosure RPC's return value).
  // `null` means the member has not enrolled an identity yet → server raises
  // the closed denial literal (the F-174 closed oracle).
  targetPubkey: Uint8Array | null;
  targetFingerprint: string | null;
  // The denial literal the server raises when the target pubkey is null.
  // ADR-0029 has not pinned the exact literal (target_not_member /
  // not_found / member_not_enrolled); the EF mapRpcError surfaces it as
  // either 404/not_found or 422/invalid_input. We assert the
  // COMPOSITION'S OUTCOME, not the wire-internal mapping (which the EF
  // tests pin).
  notEnrolledReason: 'not_found' | 'invalid_input';
  // Recording surfaces
  wrapPosted: null | { member_user_id: string; key_id: string; sealed_hex: string; rotation_id: string | null };
}

function newServer(): FakeKeyServer {
  return {
    liveKeyId: 'k-live-1',
    liveEpoch: 7,
    actorHasWrap: true,
    actorWrapBytes: null,
    actorDataKey: null,
    targetPubkey: null,
    targetFingerprint: null,
    notEnrolledReason: 'not_found',
    wrapPosted: null
  };
}

/**
 * Seed the actor's holder-side state: generate a keypair for the ACTOR,
 * store the privkey device-locally, generate the 32-byte data key oracle,
 * and seal it to the actor's pubkey so the holder-unwrap path can populate
 * the holder.
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

/** Seed the TARGET's enrolled pubkey server-side (the disclosure RPC return). */
function seedTarget(srv: FakeKeyServer): { pub: Uint8Array; priv: Uint8Array } {
  const kp = sodium.crypto_box_keypair();
  srv.targetPubkey = kp.publicKey;
  // The fingerprint format is the JS lib's BLAKE2b-32 hex (64 hex chars).
  // Compute it here so the leak-sweep can search for it.
  srv.targetFingerprint = sodium.to_hex(sodium.crypto_generichash(32, kp.publicKey));
  return { pub: kp.publicKey, priv: kp.privateKey };
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
        // Decision 4 / F-174: the disclosure RPC. The server is the SOLE
        // source of target pubkey bytes for the composition.
        if (!srv.targetPubkey || !srv.targetFingerprint) {
          // Closed denial — the literal exact form maps via the EF
          // mapRpcError to either not_found/404 or invalid_input/422
          // (depending on the SQL literal ADR-0029 ratifies). The
          // composition translates EITHER to 'member_not_enrolled'.
          return {
            status: srv.notEnrolledReason === 'not_found' ? 404 : 422,
            body: { ok: false, error: srv.notEnrolledReason }
          };
        }
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              public_key_hex: bytesToPgHex(srv.targetPubkey),
              fingerprint: srv.targetFingerprint
            }
          }
        };
      }
      case 'wrap_member': {
        // The existing :485-522 contract; the EF op forwards through.
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

beforeEach(() => {
  __resetCapture();
  __setTestSink();
});

afterEach(() => {
  __resetCapture();
  vi.restoreAllMocks();
});

// ===========================================================================
// HAPPY PATH — full composition (Decision 5 steps 1..4)
// ===========================================================================

describe('ADR-0029 P1-5 — happy composition (Decision 5)', () => {
  it('Decision 5 step 4: posts a wrap_member with the sealed-to-target ciphertext and returns ok', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();

    // Seed actor + target.
    const actor = await seedActor(srv, localIdentity);
    seedTarget(srv);
    // Populate the holder up-front (Decision 5 step 1 says "ensures the
    // holder is populated, unwrap if null" — when the holder is already
    // populated by a prior session-resident unwrap, no re-unwrap happens).
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET
    });

    expect(r.status).toBe('ok');
    // The disclosure RPC was hit (Decision 5 step 2). The wrap RPC was hit
    // (Decision 5 step 4). The order of the two is implementation-defined
    // but BOTH must be present.
    expect(ops).toContain('get_member_pubkey');
    expect(ops).toContain('wrap_member');
    // Wrap recorded server-side with the right target uid + key_id.
    expect(srv.wrapPosted).not.toBeNull();
    expect(srv.wrapPosted?.member_user_id).toBe(TARGET);
    expect(srv.wrapPosted?.key_id).toBe(srv.liveKeyId);
    expect(srv.wrapPosted?.rotation_id).toBeNull();
  });

  it('Decision 5 step 1: when holder is empty AND actor has a wrap, unwrap first then proceed', async () => {
    // The holder is empty; the composition resorts to the unwrap path
    // (committee_key_state probe + get_key_wrap → crypto_box_seal_open with
    // device privkey). Then the disclosure + seal + wrap_member sequence.
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();

    await seedActor(srv, localIdentity);
    seedTarget(srv);
    // Holder DELIBERATELY empty.
    expect(holder.isPopulated()).toBe(false);

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET
    });

    expect(r.status).toBe('ok');
    // The full set of ops fired (probe + unwrap + disclosure + wrap).
    expect(ops).toContain('committee_key_state');
    expect(ops).toContain('get_key_wrap');
    expect(ops).toContain('get_member_pubkey');
    expect(ops).toContain('wrap_member');
    // The holder is now populated (the unwrap step's side effect).
    expect(holder.isPopulated()).toBe(true);
  });
});

// ===========================================================================
// F-172 — seal to the SERVER-disclosed pubkey, byte-for-byte
// ===========================================================================

describe('ADR-0029 P1-5 — F-172 server-bound seal target', () => {
  it('the sealed-to pubkey is EXACTLY what get_member_pubkey returned (the composition does NOT accept a caller-supplied pubkey)', async () => {
    // Threat: a compromised co-chair client substitutes an attacker pubkey
    // and seals the data key to it. Mitigation: the composition reads the
    // pubkey from the server's disclosure RPC and seals to THAT — there
    // is no path that lets the caller bypass the disclosure.
    //
    // We verify by mocking the disclosure to return a KNOWN pubkey and
    // checking that the wrap_member call seals to BYTES OPENABLE BY THAT
    // KEY'S PRIVATE HALF (which only the target holds). crypto_box_seal_open
    // with the target's privkey MUST recover the actor's data key bytes
    // exactly — proving the seal target is the server-disclosed pubkey.
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    const target = seedTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET
    });
    expect(r.status).toBe('ok');

    // Recover the sealed bytes from the recorded wrap and open with the
    // TARGET's privkey. Successful open with target.priv proves the seal
    // target is target.pub (the server-disclosed key) byte-for-byte.
    expect(srv.wrapPosted).not.toBeNull();
    const sealedHex = (srv.wrapPosted as { sealed_hex: string }).sealed_hex;
    const sealed = new Uint8Array(
      (sealedHex.startsWith('\\x') ? sealedHex.slice(2) : sealedHex)
        .match(/.{1,2}/g)!
        .map((h) => parseInt(h, 16))
    );
    const opened = sodium.crypto_box_seal_open(sealed, target.pub, target.priv);
    expect(opened.length).toBe(32);
    expect(Array.from(opened)).toEqual(Array.from(actor.dataKey));
  });

  it('Decision 5 step 3: sealed bytes are EXACTLY plaintext.length + crypto_box_SEALBYTES (a sealed box, not a secretbox)', async () => {
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET
    });

    const sealedHex = (srv.wrapPosted as { sealed_hex: string }).sealed_hex;
    const sealedLen = ((sealedHex.startsWith('\\x') ? sealedHex.slice(2) : sealedHex).length) / 2;
    expect(sealedLen).toBe(32 + sodium.crypto_box_SEALBYTES);
    // And specifically NOT the 32 plaintext bytes (the canary against an
    // accidental "send the plaintext data key" regression — F-172 / F-176).
    expect(sealedLen).not.toBe(32);
  });
});

// ===========================================================================
// F-172 / Decision 4 Rejected (a) — server-side seal STAYS rejected: no
// request body field anywhere in the wire history carries the plaintext
// data key. Asserted as a structural / wire pin.
// ===========================================================================

describe('ADR-0029 P1-5 — F-172 server-side-seal-stays-rejected (Decision 4 Rejected (a))', () => {
  it('the plaintext 32-byte data key NEVER appears in any request body the EF sees', async () => {
    const srv = newServer();
    const { transport, bodies } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET
    });

    // The plaintext data key's hex form …
    const dataKeyHex = sodium.to_hex(actor.dataKey);
    // … must NOT appear in ANY recorded request body (the EF sees the
    // sealed bytes only, never the plaintext — ADR-0003 Invariant 1/5/6,
    // Decision 4 Rejected (a)).
    for (const body of bodies) {
      const blob = JSON.stringify(body);
      expect(blob).not.toContain(dataKeyHex);
    }
  });

  it('the composition NEVER calls a "server-side seal" op (no wrap_member_server_side / seal_member / similar shape)', async () => {
    const srv = newServer();
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET
    });

    // Pin structurally: the composition only ever dispatches the four
    // expected ops (probe + wrap-read + disclosure + wrap_post). A future
    // "optimization" that introduces a server-side-seal would surface here.
    for (const op of ops) {
      expect(op).toMatch(/^(committee_key_state|get_key_wrap|get_member_pubkey|wrap_member)$/);
      expect(op).not.toMatch(/server.?side.?seal|seal.?member|server.?seal/i);
    }
  });
});

// ===========================================================================
// F-174 — member_not_enrolled: the disclosure RPC returning the closed
// denial maps to a typed terminal state (no wrap POSTed; the co-chair UI
// surfaces "this member isn't ready yet").
// ===========================================================================

describe('ADR-0029 P1-5 — F-174 member_not_enrolled terminal (Decision 5 step 2)', () => {
  it('disclosure RPC returning not_found (member has no identity_keys row) → member_not_enrolled, no wrap_member posted', async () => {
    const srv = newServer();
    srv.targetPubkey = null;
    srv.notEnrolledReason = 'not_found';
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET
    });

    expect(r.status).toBe('member_not_enrolled');
    // CRITICAL: wrap_member was NOT posted (we did not seal to a partial /
    // wrong pubkey; the composition aborted before the seal step).
    expect(ops).not.toContain('wrap_member');
    expect(srv.wrapPosted).toBeNull();
  });

  it('disclosure RPC returning invalid_input (the alternative ADR-0029 literal) ALSO maps to member_not_enrolled', async () => {
    // ADR-0029 has not pinned the exact SQL literal (Decision 4 says
    // target_not_member; Decision 5 step 2 says "no-pubkey returns
    // {status:'member_not_enrolled'}"; F-174 says
    // "member_not_enrolled/not_found"). The composition must collapse
    // EITHER server denial into the SAME terminal client state so the UI
    // doesn't have to branch on the literal.
    const srv = newServer();
    srv.targetPubkey = null;
    srv.notEnrolledReason = 'invalid_input';
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET
    });

    expect(r.status).toBe('member_not_enrolled');
    expect(ops).not.toContain('wrap_member');
  });

  it('disclosure RPC returning rls_denied (non-co-chair caller) → pubkey_disclosure_denied (NOT member_not_enrolled)', async () => {
    // The two denial classes are DIFFERENT: "member is not ready" vs "you
    // are not authorized". Conflating them would confuse the UI; the
    // composition must distinguish.
    const srv = newServer();
    const localIdentity = silentStore();
    // Override transport for this case to inject rls_denied on disclosure.
    const transport: T07OpTransport = async (body) => {
      if (body.op === 'get_member_pubkey') {
        return { status: 403, body: { ok: false, error: 'rls_denied' } };
      }
      // The holder is empty so the composition will hit get_key_wrap first;
      // return a normal happy path for those ops.
      return makeTransport(srv).transport(body);
    };
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET
    });

    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('pubkey_disclosure_denied');
  });
});

// ===========================================================================
// Holder-unwrap fallback failure branches (Decision 5 step 1)
// ===========================================================================

describe('ADR-0029 P1-5 — actor key-state preconditions', () => {
  it('actor has no wrap and the holder is empty → actor_has_no_wrap (no disclosure RPC hit)', async () => {
    const srv = newServer();
    srv.actorHasWrap = false;
    srv.actorWrapBytes = null;
    const { transport, ops } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    // No seedActor for the wrap; just store a privkey so the device-side
    // has SOMETHING (the no_wrap path is the "actor has no key access"
    // case, which Phase 1 explicitly distinguishes from "no device key").
    const kp = sodium.crypto_box_keypair();
    await localIdentity.storeIdentityPrivateKey(ACTOR, kp.privateKey);
    seedTarget(srv);

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET
    });

    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('actor_has_no_wrap');
    // F-174 information-hiding: we do NOT hit the disclosure RPC if the
    // co-chair can't proceed anyway (no point leaving a disclosure audit
    // row for an aborted grant).
    expect(ops).not.toContain('get_member_pubkey');
    // And of course no wrap was posted.
    expect(ops).not.toContain('wrap_member');
  });
});

// ===========================================================================
// wrap_post_failed — the final RPC fails (e.g. the target became inactive
// between disclosure and wrap, F-172 mitigation #2 `:502-503`).
// ===========================================================================

describe('ADR-0029 P1-5 — wrap_post_failed (race between disclosure and wrap)', () => {
  it('wrap_member returning rls_denied → failed/wrap_post_failed (the target deactivated mid-grant)', async () => {
    const srv = newServer();
    const localIdentity = silentStore();
    // Make wrap_member fail with rls_denied (the F-172 active-member re-assert
    // at :502-503 firing because the target deactivated mid-flow).
    const transport: T07OpTransport = async (body) => {
      if (body.op === 'wrap_member') {
        return { status: 403, body: { ok: false, error: 'rls_denied' } };
      }
      return makeTransport(srv).transport(body);
    };
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET
    });

    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('wrap_post_failed');
  });
});

// ===========================================================================
// Holder lifecycle — Decision 5 step 5: the composition does NOT zeroize
// holder.data_key. (Contrast with initCommitteeDataKeyViaProduction at
// production-flows.ts:371,431 which zeroizes a throwaway buffer.)
// ===========================================================================

describe('ADR-0029 P1-5 — Decision 5 step 5: holder retains the data key after a successful wrap', () => {
  it('after a successful grant, the holder STILL holds the live data key (no premature zeroize)', async () => {
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET
    });
    expect(r.status).toBe('ok');

    // The holder is still populated (Decision 5 step 5 contrast with the
    // throwaway-buffer init).
    expect(holder.isPopulated()).toBe(true);
    const live = holder.getDataKey();
    expect(live).not.toBeNull();
    // And the bytes are the ORIGINAL data key (no .fill(0) anywhere
    // along the path).
    expect(Array.from(live!)).toEqual(Array.from(actor.dataKey));
    expect(Array.from(live!).some((b) => b !== 0)).toBe(true);
  });
});

// ===========================================================================
// F-176 — leak sweep: the full set of "must never log" values, across the
// happy path AND each failure branch.
// ===========================================================================

describe('ADR-0029 P1-5 — F-176 key-material + pseudonym leak sweep', () => {
  it('happy path: data key / target pubkey / sealed bytes / privkey / actor uid / target uid never appear in logs', async () => {
    const errs: string[] = [];
    const warns: string[] = [];
    const infos: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      errs.push(a.map(String).join(' '));
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a) => {
      warns.push(a.map(String).join(' '));
    });
    const infoSpy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      infos.push(a.map(String).join(' '));
    });

    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    const target = seedTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET
    });
    expect(r.status).toBe('ok');

    const dataKeyHex = sodium.to_hex(actor.dataKey);
    const targetPubHex = sodium.to_hex(target.pub);
    const targetPrivHex = sodium.to_hex(target.priv);
    const actorPrivHex = sodium.to_hex(actor.priv);
    const sealedHex = sodium.to_hex(sodium.crypto_box_seal(actor.dataKey, target.pub));

    const haystacks = [
      ...errs,
      ...warns,
      ...infos,
      ...__getCapturedLines().map((l) => JSON.stringify(l))
    ];
    for (const h of haystacks) {
      // Key material — every byte sequence the F-176 list bans.
      expect(h).not.toContain(dataKeyHex);
      expect(h).not.toContain(actorPrivHex);
      expect(h).not.toContain(targetPrivHex);
      expect(h).not.toContain(targetPubHex);
      // The sealed wrap bytes (a server-known artifact, but the audit
      // contract — F-172 mitigation #4 — keeps them out of the wrap audit
      // meta; the client-side log surface MUST follow the same posture).
      expect(h).not.toContain(sealedHex);
      // Pseudonymity: the target uid is the re-identification aid
      // (F-174). The actor uid is the co-chair's identity. Neither
      // belongs in operator logs (the EF emits opcode + outcome only —
      // the closed-literal posture established by bootstrap-first-co-chair
      // and inherited by every Phase 1 surface).
      expect(h).not.toContain(TARGET);
      expect(h).not.toContain(ACTOR);
      // The target fingerprint (re-identification aid; F-174's
      // companion field).
      if (srv.targetFingerprint) expect(h).not.toContain(srv.targetFingerprint);
    }

    errSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('member_not_enrolled branch: the leak sweep also passes (denial branches log nothing more than happy path)', async () => {
    const errs: string[] = [];
    const warns: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      errs.push(a.map(String).join(' '));
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a) => {
      warns.push(a.map(String).join(' '));
    });

    const srv = newServer();
    srv.targetPubkey = null;
    srv.notEnrolledReason = 'not_found';
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET
    });
    expect(r.status).toBe('member_not_enrolled');

    const dataKeyHex = sodium.to_hex(actor.dataKey);
    const actorPrivHex = sodium.to_hex(actor.priv);
    const haystacks = [
      ...errs,
      ...warns,
      ...__getCapturedLines().map((l) => JSON.stringify(l))
    ];
    for (const h of haystacks) {
      expect(h).not.toContain(dataKeyHex);
      expect(h).not.toContain(actorPrivHex);
      expect(h).not.toContain(TARGET);
      expect(h).not.toContain(ACTOR);
    }

    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('on any failure the composition returns a TYPED failure value — NEVER throws a raw libsodium / fetch error', async () => {
    // F-148 carry-forward: a raw thrown error could carry buffer bytes in
    // its .message / .stack. The composition must catch and map every
    // crypto / transport exception to a closed-literal typed failure.
    const srv = newServer();
    // Inject a hostile transport that throws (simulating a network blow-up).
    const transport: T07OpTransport = async (body) => {
      if (body.op === 'wrap_member') {
        // Throw with a payload that LOOKS like it might be key material — if
        // the composition surfaces this to the caller verbatim, the bytes
        // leak. The composition must catch + map to wrap_post_failed
        // (or unknown), NEVER propagate.
        throw new Error(`network failure: ${sodium.to_hex(srv.actorDataKey ?? new Uint8Array(32))}`);
      }
      return makeTransport(srv).transport(body);
    };
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    // .catch is the "must NOT throw" assertion: if the composition
    // propagates the raw Error, the catch fires and we re-throw a
    // clearer test failure.
    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET
    }).catch((e: unknown) => {
      throw new Error(
        `F-148: wrapMemberInViaProduction must not throw on transport failure; got: ${
          e instanceof Error ? e.constructor.name : 'unknown'
        }`
      );
    });

    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    // Closed-set typed failure (one of the documented reasons).
    expect(['wrap_post_failed', 'unknown']).toContain(r.reason);

    // The returned failure object MUST NOT smuggle any Uint8Array / raw
    // exception message — every field is a metadata primitive.
    for (const v of Object.values(r as Record<string, unknown>)) {
      expect(v instanceof Uint8Array).toBe(false);
      if (typeof v === 'string') {
        expect(v).not.toContain(sodium.to_hex(actor.dataKey));
      }
    }
  });
});

// ===========================================================================
// Plaintext-data-key never leaves the browser — REUSED ADR-0003 Invariant 1
// pin. (Closely related to F-172 Decision 4 Rejected (a) but framed at the
// composition output level: even on EVERY failure branch, the data key
// hex never appears in any request body.)
// ===========================================================================

describe('ADR-0029 P1-5 — ADR-0003 Invariant 1 (plaintext data key never crosses the wire)', () => {
  it('across happy + member_not_enrolled + wrap_post_failed branches, no request body carries the plaintext data key hex', async () => {
    const branches: Array<() => Promise<void>> = [
      async () => {
        const srv = newServer();
        const { transport, bodies } = makeTransport(srv);
        const localIdentity = silentStore();
        const client = new SupabaseT07Client({ transport, localIdentity });
        const holder = new CommitteeKeyHolder();
        const actor = await seedActor(srv, localIdentity);
        seedTarget(srv);
        holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });
        await wrapMemberInViaProduction({
          client,
          holder,
          localIdentity,
          user_id: ACTOR,
          target_user_id: TARGET
        });
        const hex = sodium.to_hex(actor.dataKey);
        for (const b of bodies) expect(JSON.stringify(b)).not.toContain(hex);
      },
      async () => {
        const srv = newServer();
        srv.targetPubkey = null;
        srv.notEnrolledReason = 'not_found';
        const { transport, bodies } = makeTransport(srv);
        const localIdentity = silentStore();
        const client = new SupabaseT07Client({ transport, localIdentity });
        const holder = new CommitteeKeyHolder();
        const actor = await seedActor(srv, localIdentity);
        holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });
        await wrapMemberInViaProduction({
          client,
          holder,
          localIdentity,
          user_id: ACTOR,
          target_user_id: TARGET
        });
        const hex = sodium.to_hex(actor.dataKey);
        for (const b of bodies) expect(JSON.stringify(b)).not.toContain(hex);
      },
      async () => {
        const srv = newServer();
        const bodies: Record<string, unknown>[] = [];
        const localIdentity = silentStore();
        const transport: T07OpTransport = async (body) => {
          bodies.push(body);
          if (body.op === 'wrap_member') {
            return { status: 403, body: { ok: false, error: 'rls_denied' } };
          }
          return makeTransport(srv).transport(body);
        };
        const client = new SupabaseT07Client({ transport, localIdentity });
        const holder = new CommitteeKeyHolder();
        const actor = await seedActor(srv, localIdentity);
        seedTarget(srv);
        holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });
        await wrapMemberInViaProduction({
          client,
          holder,
          localIdentity,
          user_id: ACTOR,
          target_user_id: TARGET
        });
        const hex = sodium.to_hex(actor.dataKey);
        for (const b of bodies) expect(JSON.stringify(b)).not.toContain(hex);
      }
    ];
    for (const run of branches) await run();
  });

  it('no sessionStorage / localStorage write occurs during the composition (the data key + sealed bytes are heap-only)', async () => {
    // The Phase 0a / Phase 2a F-145/F-146 pattern: the data key lives in
    // the heap holder only. The wrap composition must not "cache" the
    // seal in browser storage as an optimization. We spy on Storage.setItem
    // to catch any write.
    const setSpy = vi.spyOn(Storage.prototype, 'setItem');

    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    seedTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    const r = await wrapMemberInViaProduction({
      client,
      holder,
      localIdentity,
      user_id: ACTOR,
      target_user_id: TARGET
    });
    expect(r.status).toBe('ok');

    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });
});

// ===========================================================================
// EXPLICIT NEGATIVE — the caller-supplied pubkey escape hatch does NOT exist
// ===========================================================================

describe('ADR-0029 P1-5 — F-172 the composition signature does NOT accept a caller-supplied pubkey', () => {
  it('passing a smuggled target_public_key field has NO effect on what gets sealed (server-disclosed key is authoritative)', async () => {
    // Even if a caller adds a target_public_key to the opts (a "hint" /
    // optimization), the composition MUST sealed-to the server-disclosed
    // pubkey, not the caller's. We seed a different pubkey on the server
    // than the smuggled one and assert the sealed bytes open with the
    // SERVER's privkey, not the smuggled one's.
    const srv = newServer();
    const { transport } = makeTransport(srv);
    const localIdentity = silentStore();
    const client = new SupabaseT07Client({ transport, localIdentity });
    const holder = new CommitteeKeyHolder();
    const actor = await seedActor(srv, localIdentity);
    const serverTarget = seedTarget(srv);
    holder.set({ data_key: actor.dataKey, key_id: srv.liveKeyId, epoch: srv.liveEpoch });

    // The smuggled "attacker pubkey" the test pretends a hostile caller
    // passes through opts.
    const attacker = sodium.crypto_box_keypair();

    const r = await wrapMemberInViaProduction(
      // deno-lint-ignore no-explicit-any
      {
        client,
        holder,
        localIdentity,
        user_id: ACTOR,
        target_user_id: TARGET,
        // F-172 attempted bypass — must be ignored.
        target_public_key: attacker.publicKey,
        public_key: attacker.publicKey,
        pubkey: attacker.publicKey
      } as any
    );
    expect(r.status).toBe('ok');

    // The wrap_member call recorded the seal; recover it and prove it
    // opens with the SERVER's target privkey (not the attacker's).
    expect(srv.wrapPosted).not.toBeNull();
    const sealedHex = (srv.wrapPosted as { sealed_hex: string }).sealed_hex;
    const sealed = new Uint8Array(
      (sealedHex.startsWith('\\x') ? sealedHex.slice(2) : sealedHex)
        .match(/.{1,2}/g)!
        .map((h) => parseInt(h, 16))
    );

    // Opening with the SERVER target's keypair succeeds (proving the
    // composition sealed to the server-disclosed pubkey).
    const opened = sodium.crypto_box_seal_open(sealed, serverTarget.pub, serverTarget.priv);
    expect(Array.from(opened)).toEqual(Array.from(actor.dataKey));

    // Opening with the ATTACKER's keypair fails (F-172: the data key was
    // NOT sealed to the attacker pubkey).
    let attackerOpened: Uint8Array | null = null;
    try {
      attackerOpened = sodium.crypto_box_seal_open(sealed, attacker.publicKey, attacker.privateKey);
    } catch {
      // Expected: AEAD verification fails — the seal target is not the
      // attacker key.
    }
    expect(attackerOpened).toBeNull();
  });
});
