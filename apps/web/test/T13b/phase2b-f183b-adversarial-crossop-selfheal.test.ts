/**
 * F-183-B / F182-9 (escalate-on-miss) — ADVERSARIAL-REVIEW tranche, REPRISAL
 * mirror. The escalate-on-miss fix touches BOTH the concerns and reprisal read
 * loops, so the adversarial coverage mirrors across both.
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY; do not relax
 * the assertions. Both tests FAIL against the current worktree.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * FINDING 1 (reprisal mirror). Cross-op spurious lockout on the reprisal read.
 * ───────────────────────────────────────────────────────────────────────────
 * Two READ compositions share ONE `CommitteeKeyHolder`. Op A (a retired-only
 * remaining member's `readReprisalViaProduction`) has ALREADY spent its once-
 * per-op escalation guard inside `ensureHolderPopulated` (reprisal
 * production-flows.ts:286-291) and holds a retired read key. As op A trial-
 * decrypts its retired-sealed record it parks in `openUtf8`'s `await ready()`
 * gap holding that buffer BY REFERENCE; in that gap op B's escalation runs
 * `populate([...fresh])` on the SAME holder, and F-145-C orphan-wipe zeroes op
 * A's captured buffer in place. Op A resumes → decrypt-under-zeros → miss; op A
 * calls `escalateToAllEpochs`, whose guard is spent → `{status:'already'}`. The
 * read loop RE-OPENS only on `'escalated'` (reprisal production-flows.ts:522),
 * so op A falls through to `decrypt_failed` — a spurious lockout on a record the
 * shared holder can still open under op B's fresh, valid buffer. The fix must
 * re-attempt the trial-open on `'already'` too.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * FINDING 3 (reprisal mirror). Self-heal branch bypasses the shared guard.
 * ───────────────────────────────────────────────────────────────────────────
 * `ensureHolderPopulated`'s probe-driven self-heal branch (reprisal
 * production-flows.ts:246-264) calls `unwrapAllCommitteeKeysViaProduction` +
 * `populate()` DIRECTLY without spending the shared `guard`. So on a POPULATED
 * holder whose probe key_id DIFFERS (forces self-heal) + a persistently-missing
 * record, the read-loop `escalateToAllEpochs` sees a FRESH guard and fires
 * `get_all_key_wraps` a SECOND time — breaking re-pass trigger #16 ("exactly one
 * all-wraps RPC per op") on the mid-session path. RED today = 2 fetches.
 *
 * DETERMINISM. The Finding-1 interleave uses the committed
 * MidSeal/queueMicrotask technique re-parameterised onto the READ path, with a
 * load-bearing GUARD asserting op A's buffer was ACTUALLY zeroed mid-flight (no
 * timing-luck pass). No real clock / network / RNG assertion (assertions are on
 * the decrypt round-trip / typed status / transport op-count). Each test owns
 * its fixtures. The F-190 lesson (no load-sensitive raw timing) is honoured.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import {
  BrowserLocalIdentityStore,
  CommitteeKeyHolder,
  SupabaseT07Client,
  type T07OpTransport,
  type TrialOpenResult
} from '../../src/lib/crypto';
import {
  SupabaseReprisalClient,
  type ReprisalOpTransport
} from '../../src/lib/reprisal/supabase-reprisal-client';
import { readReprisalViaProduction } from '../../src/lib/reprisal/production-flows';
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

/** Seal a UTF-8 plaintext under a secretbox key → on-wire `[nonce][ct]` pg-hex. */
function sealHex(pt: string, key: Uint8Array): string {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ptBytes = new Uint8Array(new TextEncoder().encode(pt));
  const ct = sodium.crypto_secretbox_easy(ptBytes, nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return bytesToPgHex(out);
}

/** Seal under a FRESH random key the holder will NEVER hold (a persistent miss). */
function sealUnderRandomKey(pt: string): string {
  return sealHex(pt, sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES));
}

interface FakeKeyServer {
  liveKeyId: string;
  liveEpoch: number;
  actorHasWrap: boolean;
  liveWrap: Uint8Array | null;
  allWraps: Array<{ key_id: string; epoch: number; wrap: Uint8Array; is_live: boolean }> | null;
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
            wrap_count: srv.actorHasWrap ? (srv.allWraps?.length ?? 1) : 0,
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
    if (body.op === 'get_all_key_wraps') {
      const rows = srv.allWraps ?? [];
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
    throw new Error(`unexpected op ${String(body.op)}`);
  };
  return { transport, ops };
}

function makeReprisalTransport(queue: Array<{ status: number; body: unknown }>): {
  transport: ReprisalOpTransport;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  let i = 0;
  const transport: ReprisalOpTransport = async (body) => {
    bodies.push(body);
    const r = queue[i++];
    if (!r) throw new Error(`reprisal: no response queued (call #${i})`);
    return { status: r.status, body: r.body };
  };
  return { transport, bodies };
}

function countOp(ops: string[], op: string): number {
  return ops.filter((o) => o === op).length;
}

/**
 * A retired-only remaining member (ADR-0031 Decision 3). Holder EMPTY; probe
 * reports `actor_has_wrap:true` with a live key_id the member does NOT hold;
 * `get_key_wrap` (live) → null; `get_all_key_wraps` → ONLY a retired entry. So
 * `ensureHolderPopulated('read')` ESCALATES — spending the once-per-op guard and
 * populating the retired read key — BEFORE the read loop (the Finding-1 setup).
 */
async function buildRetiredOnlySession() {
  const retiredKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const localIdentity = silentStore();
  const kp = sodium.crypto_box_keypair();
  await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

  const srv: FakeKeyServer = {
    liveKeyId: 'k-epoch-2',
    liveEpoch: 2,
    actorHasWrap: true,
    liveWrap: null,
    allWraps: [
      { key_id: 'k-epoch-1', epoch: 1, wrap: sodium.crypto_box_seal(retiredKey, kp.publicKey), is_live: false }
    ]
  };
  const t07 = makeT07Transport(srv);
  const t07Client = new SupabaseT07Client({ transport: t07.transport, localIdentity });
  return { srv, t07, t07Client, localIdentity, retiredKey };
}

/**
 * A fresh post-rotation session holding {retired epoch-1, live epoch-2}. Used by
 * Finding 3 with a PRE-POPULATED holder under a stale key_id to force self-heal.
 */
async function buildBaselineRotatedSession() {
  const retiredKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const liveKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const localIdentity = silentStore();
  const kp = sodium.crypto_box_keypair();
  await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

  const srv: FakeKeyServer = {
    liveKeyId: 'k-epoch-2',
    liveEpoch: 2,
    actorHasWrap: true,
    liveWrap: sodium.crypto_box_seal(liveKey, kp.publicKey),
    allWraps: [
      { key_id: 'k-epoch-1', epoch: 1, wrap: sodium.crypto_box_seal(retiredKey, kp.publicKey), is_live: false },
      { key_id: 'k-epoch-2', epoch: 2, wrap: sodium.crypto_box_seal(liveKey, kp.publicKey), is_live: true }
    ]
  };
  const t07 = makeT07Transport(srv);
  const t07Client = new SupabaseT07Client({ transport: t07.transport, localIdentity });
  return { srv, t07, t07Client, localIdentity, retiredKey, liveKey };
}

/**
 * A `CommitteeKeyHolder` that fires ONE armed trigger the first time `trialOpen`
 * is entered — on a `queueMicrotask` scheduled the instant op A's in-flight
 * trial-decrypt buffer is captured, so op B's `populate()` lands inside
 * `openUtf8`'s `await ready()` gap (strictly before the synchronous
 * `crypto_secretbox_open_easy`). Same proven `queueMicrotask` mechanism as the
 * committed F-190 / F-VAL-1(a) MidSeal tests, re-parameterised onto the READ
 * path. `capturedBuffer` is exposed so the determinism GUARD can assert the race
 * genuinely fired (op A's buffer got zeroed) — never a silent timing pass.
 */
class MidReadRaceHolder extends CommitteeKeyHolder {
  #armed = false;
  #trigger: (() => void) | null = null;
  capturedBuffer: Uint8Array | null = null;

  /** Arm op B's escalation `populate()` to fire inside op A's first trial-open. */
  armOpBEscalationOnFirstTrialOpen(trigger: () => void): void {
    this.#armed = true;
    this.#trigger = trigger;
  }

  override async trialOpen<T>(
    open: (dataKey: Uint8Array) => Promise<T> | T
  ): Promise<TrialOpenResult<T>> {
    if (!this.#armed || this.#trigger === null) {
      return super.trialOpen(open);
    }
    this.#armed = false;
    const trigger = this.#trigger;
    this.#trigger = null;
    const wrapped = (dataKey: Uint8Array): Promise<T> | T => {
      if (this.capturedBuffer === null) {
        // Capture op A's live-flight read buffer, THEN schedule op B's escalation
        // populate() so it interleaves inside the openUtf8 await gap.
        this.capturedBuffer = dataKey;
        queueMicrotask(trigger);
      }
      return open(dataKey);
    };
    return super.trialOpen(wrapped);
  }
}

beforeEach(() => {
  __resetCapture();
  __setTestSink();
});

afterEach(() => {
  __resetCapture();
});

// ===========================================================================
// FINDING 1 (reprisal mirror) — cross-op spurious lockout on the reprisal read.
// ===========================================================================
describe('F-183-B / adversarial — cross-op escalate-on-miss lockout (reprisal)', () => {
  it('op A opens its retired-sealed record via the shared holder that op B re-populated mid-flight, instead of aborting decrypt_failed (guard-spent `already` must still re-open)', async () => {
    const { t07, t07Client, localIdentity, retiredKey } = await buildRetiredOnlySession();

    // The SHARED session singleton. Op A's ensureHolderPopulated escalation
    // (retired-only read branch) spends op A's guard and installs op A's retired
    // read buffer BEFORE the read loop — so when op A misses inside the loop it
    // calls escalateToAllEpochs with a SPENT guard → `already`.
    const holder = new MidReadRaceHolder();

    // Op B's escalation, simulated as its exact effect on the shared holder: a
    // FRESH, distinct buffer for the SAME retired epoch (op B unwraps the same
    // server wrap → same key VALUE, new buffer). F-145-C orphan-wipe zeroes op
    // A's captured buffer; the record (sealed under retiredKey) stays openable.
    const opBRetiredBuffer = Uint8Array.from(retiredKey);
    holder.armOpBEscalationOnFirstTrialOpen(() => {
      holder.populate([
        { data_key: opBRetiredBuffer, key_id: 'k-epoch-1', epoch: 1, is_live: false }
      ]);
    });

    const TITLE = 'reprisal-crossop-title-under-retired-epoch-1';
    const BODY = 'reprisal-crossop-body-under-retired-epoch-1';
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { title_ct: sealHex(TITLE, retiredKey), body_ct: sealHex(BODY, retiredKey) } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder: holder,
      localIdentity,
      user_id: USER,
      id: 'r-crossop',
      passphrase: null
    });

    // ── DETERMINISM GUARD (must hold whether RED or GREEN) ──────────────────
    // The race GENUINELY fired: op B's mid-flight populate() zeroed op A's
    // captured read buffer BY REFERENCE. If this fails, the interleave never
    // happened and any outcome assertion below would be a false pass.
    expect(holder.capturedBuffer).not.toBeNull();
    expect(
      holder.capturedBuffer !== null && Array.from(holder.capturedBuffer).every((b) => b === 0),
      'race not exercised: op B`s populate() never zeroed op A`s captured trial-open buffer ' +
        'inside the openUtf8 await gap — the concurrency interleave did not fire, so the ' +
        'outcome assertion below would be meaningless.'
    ).toBe(true);
    expect(holder.isPopulated()).toBe(true);

    // ── THE INVARIANT (RED today) ───────────────────────────────────────────
    // Current worktree: op A`s post-zero miss → escalate → `already` → the loop
    // does NOT re-open → decrypt_failed (a spurious lockout on a record the
    // holder can read). Correct behaviour: re-open on `already` → `ok`.
    expect(
      r.status,
      'cross-op spurious lockout (reprisal): op A returned a failure even though the shared ' +
        'holder holds a valid key for the record`s retired epoch (op B re-populated it ' +
        'mid-flight). A guard-spent `already` escalation must still retry the trial-open.'
    ).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.title).toBe(TITLE);
    expect(r.body).toBe(BODY);

    // Bounded: op A drove exactly one escalation RPC (its ensureHolderPopulated
    // retired-only load); the mid-flight recovery must NOT trigger a second.
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);
  });
});

// ===========================================================================
// FINDING 3 (reprisal mirror) — self-heal branch must share the once-per-op guard.
// ===========================================================================
describe('F-183-B / adversarial — self-heal branch must share the once-per-op guard (reprisal)', () => {
  it('a mid-session self-heal (populated holder + differing probe key_id) then a persistently-missing record fires get_all_key_wraps EXACTLY ONCE, not twice (#16 bound on the self-heal path)', async () => {
    const { t07, t07Client, localIdentity } = await buildBaselineRotatedSession();

    // A POPULATED holder cached from a prior op under a STALE live key_id
    // ('k-epoch-1'); the committee has since rotated and the probe now reports
    // the live 'k-epoch-2'. getKeyId() !== probe key_id → forces the self-heal
    // branch, which fetches all wraps + populate()s DIRECTLY.
    const holder = new CommitteeKeyHolder();
    holder.set({
      data_key: sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES),
      key_id: 'k-epoch-1',
      epoch: 1
    });
    expect(holder.getKeyId()).toBe('k-epoch-1');

    // A record sealed under a key the holder will NEVER hold → the read loop
    // MISSES persistently → `escalateToAllEpochs` runs. If the self-heal branch
    // did not spend the shared guard, this is a SECOND, redundant all-wraps fetch.
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { title_ct: sealUnderRandomKey('foreign-t'), body_ct: sealUnderRandomKey('foreign-b') } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder: holder,
      localIdentity,
      user_id: USER,
      id: 'r-foreign',
      passphrase: null
    });

    // Coherence: the foreign record never opens under any held epoch → fail-closed.
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.reason).toBe('decrypt_failed');

    // ── THE #16 BOUND (RED today = 2) ───────────────────────────────────────
    // The self-heal fetch and the read-loop escalation must be the SAME
    // once-per-op disclosure, not two independent ones.
    expect(
      countOp(t07.ops, 'get_all_key_wraps'),
      'self-heal branch bypassed the shared once-per-op guard: get_all_key_wraps fired ' +
        'more than once across a single reprisal read op (the self-heal populate() and the ' +
        'read-loop escalation each fetched independently). The #16 bound requires exactly one.'
    ).toBe(1);
  });
});
