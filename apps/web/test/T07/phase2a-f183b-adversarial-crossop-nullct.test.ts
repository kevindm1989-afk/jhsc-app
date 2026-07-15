/**
 * F-183-B / F182-9 (escalate-on-miss) — ADVERSARIAL-REVIEW tranche.
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY; do not relax
 * the assertions. Both tests FAIL against the current worktree and pass ONLY
 * once the escalate-on-miss read loop is corrected.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * FINDING 1 (concurrency — the important one). Cross-op spurious lockout.
 * ───────────────────────────────────────────────────────────────────────────
 * Two READ compositions share ONE `CommitteeKeyHolder` (the Decision-1 session
 * singleton). Op A (a concern-list read by a retired-only remaining member) has
 * ALREADY spent its once-per-op escalation guard inside `ensureHolderPopulated`
 * (the retired-only read branch, production-flows.ts:296) and holds a retired
 * read key. As op A trial-decrypts its pre-rotation row, it parks in
 * `openUtf8`'s `await ready()` gap holding that key buffer BY REFERENCE. In that
 * gap op B's escalation runs `populate([...fresh])` on the SAME holder; F-145-C
 * orphan-wipe zeroes op A's captured buffer in place (op B installs a distinct,
 * still-valid buffer for the SAME retired epoch). Op A resumes → decrypt-under-
 * zeros → miss; op A calls `escalateToAllEpochs`, whose guard is spent → it
 * returns `{status:'already'}`. The read loop RE-OPENS only on `'escalated'`
 * (production-flows.ts:601), so op A falls through to `decrypt_failed` — a
 * spurious WHOLE-PAGE lockout on genuinely-readable data the holder now holds.
 *
 * The fix must re-attempt the trial-open when escalation reports `'already'`
 * too (a concurrent op may have re-populated the shared holder), so op A opens
 * its row instead of aborting. Asserted on the OBSERVABLE outcome only
 * (`status:'ok'` + the row's plaintext), never on the fix's shape.
 *
 * DETERMINISM. The interleave is forced with the committed MidSeal/queueMicrotask
 * technique, re-parameterised onto the READ path (`trialOpen` instead of the
 * seal's `getDataKey`): a `MidReadRaceHolder` wraps the trial-open callback,
 * captures op A's in-flight buffer, and schedules op B's `populate()` onto a
 * `queueMicrotask` so it lands strictly inside `openUtf8`'s `await ready()` gap
 * and strictly before the synchronous `crypto_secretbox_open_easy`. A load-
 * bearing determinism GUARD asserts op A's captured buffer was ACTUALLY zeroed
 * mid-flight — so the test can NEVER pass by timing luck (if the race did not
 * fire, op A's first open would succeed and the assertion would be meaningless;
 * the guard fails LOUDLY instead). No real clock / network / RNG assertion; the
 * F-190 lesson (no load-sensitive raw timing) is honoured.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * FINDING 2. Null / non-hex ciphertext row → uncaught throw.
 * ───────────────────────────────────────────────────────────────────────────
 * `listConcernsViaProduction` runs `toBytes(row.title_ct)` OUTSIDE any try/catch
 * (production-flows.ts:582-583). A server row with `title_ct:null` drives
 * `toBytes(null)` → `pgHexToBytesLocal(null)` → `null.startsWith('\\x')` → an
 * uncaught `TypeError` that REJECTS the returned promise — violating the file's
 * "failures surface as a typed union; the thrown error never propagates" (F-148)
 * guarantee. A non-string/number `title_ct` throws the same way. The op must
 * surface a TYPED union value, never a thrown/rejected promise.
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
  SupabaseConcernClient,
  type ConcernOpTransport
} from '../../src/lib/concerns/supabase-concern-client';
import { listConcernsViaProduction } from '../../src/lib/concerns';
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

function makeConcernTransport(queue: Array<{ status: number; body: unknown }>): {
  transport: ConcernOpTransport;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  let i = 0;
  const transport: ConcernOpTransport = async (body) => {
    bodies.push(body);
    const r = queue[i++];
    if (!r) throw new Error(`concern: no response queued (call #${i})`);
    return { status: r.status, body: r.body };
  };
  return { transport, bodies };
}

function makeConcernRow(over: Partial<Record<string, unknown>> & { id: string }): Record<string, unknown> {
  return {
    hazard_class: 'physical',
    severity: 'low',
    location_id: 'L-1',
    created_at: new Date().toISOString(),
    actor_pseudonym: 'p',
    anonymous_default_kept: true,
    has_named_source: false,
    ...over
  };
}

function countOp(ops: string[], op: string): number {
  return ops.filter((o) => o === op).length;
}

/**
 * A retired-only remaining member (ADR-0031 Decision 3). Holder EMPTY; probe
 * reports `actor_has_wrap:true` with a LIVE key_id the member does NOT hold;
 * `get_key_wrap` (live) → null; `get_all_key_wraps` → ONLY a retired
 * (`is_live:false`) entry. `ensureHolderPopulated('read')` therefore ESCALATES —
 * spending the once-per-op guard and populating the holder with the retired read
 * key — BEFORE the read loop runs (the precondition Finding 1 needs).
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
 * A fresh post-rotation session holding {retired epoch-1, live epoch-2}. The
 * single-live unwrap succeeds, so `ensureHolderPopulated` returns `ok` with a
 * LIVE key and never escalates — used by Finding 2 so the read loop reaches the
 * `toBytes(row.title_ct)` conversion under test.
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
 * path. `capturedBuffer` is exposed so the determinism GUARD can assert the
 * race genuinely fired (op A's buffer got zeroed) — never a silent timing pass.
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
        // Capture op A's live-flight read buffer, THEN schedule op B's
        // escalation populate() so it interleaves inside the openUtf8 await gap.
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
// FINDING 1 — cross-op spurious whole-page lockout (concurrency).
// ===========================================================================
describe('F-183-B / adversarial — cross-op escalate-on-miss lockout (concerns)', () => {
  it('op A opens its pre-rotation row via the shared holder that op B re-populated mid-flight, instead of aborting decrypt_failed (guard-spent `already` must still re-open)', async () => {
    const { t07, t07Client, localIdentity, retiredKey } = await buildRetiredOnlySession();

    // The SHARED session singleton both ops run on. Op A's ensureHolderPopulated
    // escalation (retired-only read branch) spends op A's guard and installs op
    // A's retired read buffer BEFORE the read loop — so when op A misses inside
    // the loop it calls escalateToAllEpochs with a SPENT guard → `already`.
    const holder = new MidReadRaceHolder();

    // Op B's escalation, simulated as the exact effect it has on the shared
    // holder: populate() a FRESH, distinct buffer for the SAME retired epoch (op
    // B unwraps the same server wrap → same key VALUE, new buffer). F-145-C
    // orphan-wipe zeroes op A's captured buffer; the row (sealed under retiredKey)
    // stays openable under op B's fresh buffer.
    const opBRetiredBuffer = Uint8Array.from(retiredKey);
    holder.armOpBEscalationOnFirstTrialOpen(() => {
      holder.populate([
        { data_key: opBRetiredBuffer, key_id: 'k-epoch-1', epoch: 1, is_live: false }
      ]);
    });

    // Op A's page: a single pre-rotation row sealed under the RETIRED epoch-1 key.
    const TITLE = 'crossop-title-under-retired-epoch-1';
    const BODY = 'crossop-body-under-retired-epoch-1';
    const rows = [
      makeConcernRow({
        id: 'c-crossop',
        title_ct: sealHex(TITLE, retiredKey),
        body_ct: sealHex(BODY, retiredKey),
        key_id: 'k-epoch-1'
      })
    ];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder: holder,
      localIdentity,
      user_id: USER
    });

    // ── DETERMINISM GUARD (must hold whether RED or GREEN) ──────────────────
    // The race GENUINELY fired: op B's mid-flight populate() zeroed op A's
    // captured read buffer BY REFERENCE. If this fails, the interleave never
    // happened and any outcome assertion below would be a false pass — so we
    // fail LOUDLY here instead of passing by timing luck.
    expect(holder.capturedBuffer).not.toBeNull();
    expect(
      holder.capturedBuffer !== null && Array.from(holder.capturedBuffer).every((b) => b === 0),
      'race not exercised: op B`s populate() never zeroed op A`s captured trial-open buffer ' +
        'inside the openUtf8 await gap — the concurrency interleave did not fire, so the ' +
        'outcome assertion below would be meaningless.'
    ).toBe(true);
    // The shared holder still holds op B`s valid retired key (a genuinely-
    // readable state) — op A`s lockout, if any, is spurious.
    expect(holder.isPopulated()).toBe(true);

    // ── THE INVARIANT (RED today) ───────────────────────────────────────────
    // Current worktree: op A`s post-zero miss → escalate → `already` → the loop
    // does NOT re-open → decrypt_failed (a spurious whole-page lockout on data
    // the holder can read). Correct behaviour: re-open on `already` → `ok`.
    expect(
      r.status,
      'cross-op spurious lockout: op A returned a whole-page failure even though the ' +
        'shared holder holds a valid key for the row`s retired epoch (op B re-populated it ' +
        'mid-flight). A guard-spent `already` escalation must still retry the trial-open.'
    ).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.title).toBe(TITLE);
    expect(r.items[0]!.body).toBe(BODY);

    // Bounded: op A drove exactly one escalation RPC (its ensureHolderPopulated
    // retired-only load); the mid-flight recovery must NOT trigger a second.
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);
  });
});

// ===========================================================================
// FINDING 2 — null / non-hex ciphertext row must surface a typed union.
// ===========================================================================
describe('F-183-B / adversarial — malformed ciphertext row is a typed union, never a throw (concerns)', () => {
  it('a list row whose title_ct is null (or a non-hex number) yields a typed result, NOT a thrown/rejected promise (F-148: the thrown error never propagates)', async () => {
    const VALID_STATUSES = ['ok', 'needs_setup', 'needs_recovery', 'session_expiry', 'failed'];

    // Two malformed shapes an untrusted server could emit: an explicit null, and
    // a non-string/number. Both drive `toBytes(...)` → `pgHexToBytesLocal(...)` →
    // `<value>.startsWith(...)` → an uncaught TypeError in the current worktree.
    for (const [label, badTitleCt] of [
      ['null', null],
      ['number', 12345]
    ] as const) {
      const { t07Client, localIdentity, liveKey } = await buildBaselineRotatedSession();
      const holder = new CommitteeKeyHolder();

      const rows = [
        makeConcernRow({
          id: `c-bad-${label}`,
          // title_ct is deliberately malformed (server contract violation);
          // body_ct is well-formed to prove the throw is the title conversion.
          title_ct: badTitleCt as unknown as string,
          body_ct: sealHex('well-formed-body', liveKey),
          key_id: 'k-epoch-2'
        })
      ];
      const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
      const concernClient = new SupabaseConcernClient({ transport: concern.transport });

      const settled = await listConcernsViaProduction({
        client: t07Client,
        concernClient,
        keyHolder: holder,
        localIdentity,
        user_id: USER
      }).then(
        (value) => ({ threw: false as const, value }),
        (error: unknown) => ({ threw: true as const, error })
      );

      // ── THE INVARIANT (RED today) ─────────────────────────────────────────
      expect(
        settled.threw,
        `title_ct=${label}: listConcernsViaProduction must surface a malformed ciphertext ` +
          `as a TYPED union — the thrown error must NEVER propagate out of the composition ` +
          `(production-flows.ts F-148 guarantee). It threw: ` +
          `${settled.threw ? String((settled as { error: unknown }).error) : ''}`
      ).toBe(false);
      if (settled.threw) continue;

      // The resolved value is a valid discriminated-union member (row skipped →
      // `ok`, or the whole op failed closed → `failed`); either is acceptable,
      // an uncaught throw is not.
      expect(
        VALID_STATUSES,
        `title_ct=${label}: resolved to an unexpected status \`${settled.value.status}\``
      ).toContain(settled.value.status);
    }
  });
});

// ===========================================================================
// FINDING 3 — the self-heal branch must share the once-per-op escalation guard.
//
// `ensureHolderPopulated`'s probe-driven self-heal branch (production-flows.ts
// ~:257-271) calls `unwrapAllCommitteeKeysViaProduction` + `populate()` DIRECTLY
// without spending the shared `guard`. So on a POPULATED holder whose probe
// key_id DIFFERS (forces self-heal) + a persistently-missing row, the read-loop
// `escalateToAllEpochs` sees a FRESH guard and fires `get_all_key_wraps` a SECOND
// time — breaking re-pass trigger #16 ("exactly one all-wraps RPC per op") on the
// mid-session path and amplifying the `committee_data_key.unwrap` audit trail.
//
// The existing #16 tests all start from an EMPTY holder (which SKIPS the self-heal
// branch), so this second fetch is uncovered. RED today = 2 fetches.
// ===========================================================================
describe('F-183-B / adversarial — self-heal branch must share the once-per-op guard (concerns)', () => {
  it('a mid-session self-heal (populated holder + differing probe key_id) then a persistently-missing row fires get_all_key_wraps EXACTLY ONCE, not twice (#16 bound on the self-heal path)', async () => {
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

    // One row sealed under a key the holder will NEVER hold → the read loop MISSES
    // persistently → `escalateToAllEpochs` runs. If the self-heal branch did not
    // spend the shared guard, this is a SECOND, redundant all-wraps fetch.
    const rows = [
      makeConcernRow({
        id: 'c-foreign',
        title_ct: sealUnderRandomKey('foreign-title'),
        body_ct: sealUnderRandomKey('foreign-body'),
        key_id: 'k-epoch-foreign'
      })
    ];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder: holder,
      localIdentity,
      user_id: USER
    });

    // Coherence: the foreign row never opens under any held epoch → fail-closed.
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.reason).toBe('decrypt_failed');

    // ── THE #16 BOUND (RED today = 2) ───────────────────────────────────────
    // The self-heal fetch and the read-loop escalation must be the SAME
    // once-per-op disclosure, not two independent ones. A second fetch is a
    // redundant N-row `committee_data_key.unwrap` audit amplification.
    expect(
      countOp(t07.ops, 'get_all_key_wraps'),
      'self-heal branch bypassed the shared once-per-op guard: get_all_key_wraps fired ' +
        'more than once across a single read op (the self-heal populate() and the read-loop ' +
        'escalation each fetched independently). The #16 bound requires exactly one.'
    ).toBe(1);
  });
});
