/**
 * F-183-B — fresh-session / baseline multi-epoch anti-lockout (F182-2 panel
 * keystone gap; threat-model §3.18, second-opinion Concern 2).
 *
 * CLOSED by F182-9 (ADR-0031, escalate-on-miss). This is now the LIVE keystone
 * acceptance test — un-skipped and GREEN. It pins that a fresh-session (empty-
 * holder) post-rotation load holding {retired epoch-1, live epoch-2} STILL opens
 * a pre-rotation (epoch-1-sealed) row: the read loop escalates to the multi-epoch
 * key set on the FIRST `trialOpen` miss (bounded once-per-op) and retries, instead
 * of aborting `decrypt_failed`. This closes the F-183 anti-lockout gap on the
 * common re-sign-in path and clears F182-4's last hard-block (re-pass trigger #12).
 *
 * Hermetic: real libsodium (secretbox + sealed-box); mock t07/concern
 * transports; a real BrowserLocalIdentityStore (SSR-fallback Map); a real
 * CommitteeKeyHolder. No real clock, no real network, no seeded-RNG assertion
 * (assertions are on the DECRYPT round-trip / list outcome, never on raw
 * ciphertext bytes). Determinism: created_at is set from `Date.now()` exactly
 * as the sibling flow tests do, and `days_since_filed` is not asserted here, so
 * no clock control is required.
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
import {
  listConcernsViaProduction,
  revealConcernSourceViaProduction,
  submitConcernViaProduction,
  openUtf8
} from '../../src/lib/concerns';
import { pgHexToBytes } from '../../src/lib/server-client/pg-hex';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

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

interface FakeKeyServer {
  liveKeyId: string;
  liveEpoch: number;
  actorHasWrap: boolean;
  liveWrap: Uint8Array | null;
  allWraps: Array<{ key_id: string; epoch: number; wrap: Uint8Array; is_live: boolean }> | null;
  // AC-9 fetch-fault typing: when set to a non-200 status, `get_all_key_wraps`
  // (the escalation RPC) returns a typed transport error instead of the wrap
  // set — so the escalation seam's 401-vs-non-401 branch can be exercised.
  allWrapsStatus?: number;
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
      if (srv.allWrapsStatus && srv.allWrapsStatus !== 200) {
        return { status: srv.allWrapsStatus, body: { ok: false, error: 'unknown' } };
      }
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

/**
 * A FRESH signed-in session (EMPTY holder) after the committee has rotated to
 * epoch-2. The member legitimately holds BOTH a retired epoch-1 wrap and the
 * live epoch-2 wrap (get_all_key_wraps), each sealed to the actor pubkey. The
 * single-live probe reports only the live epoch-2 key_id.
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
  // FRESH session — the holder starts EMPTY (no prior key_id to delta against).
  const keyHolder = new CommitteeKeyHolder();

  return { srv, t07, t07Client, localIdentity, keyHolder, retiredKey, liveKey };
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
// F-183-B — the from-empty-holder anti-lockout keystone gap. PENDING.
// ===========================================================================
describe('F-183-B / AC-1 — fresh-session baseline multi-epoch anti-lockout (concerns keystone)', () => {
  it('AC-1 (keystone) — an EMPTY holder loaded on a fresh post-rotation session holding {retired epoch-1, live epoch-2} STILL opens a pre-rotation (epoch-1-sealed) row via escalate-on-miss', async () => {
    const { t07Client, localIdentity, keyHolder, retiredKey } = await buildBaselineRotatedSession();

    // Precondition of the gap: the session starts with an EMPTY holder, so the
    // within-session key_id delta detector never fires — the baseline load must
    // itself be multi-epoch (the F182-3 fix) for this to pass.
    expect(keyHolder.isPopulated()).toBe(false);

    // A pre-rotation concern row, sealed under the RETIRED epoch-1 key. On the
    // fixed baseline path the retired epoch is loaded, so trial-decrypt opens it.
    const nowIso = new Date().toISOString();
    const rowsFromView = [
      {
        id: 'c-pre',
        title_ct: sealHex('history-title-under-retired-epoch-1', retiredKey),
        body_ct: sealHex('history-body-under-retired-epoch-1', retiredKey),
        hazard_class: 'physical',
        severity: 'low',
        location_id: 'L-1',
        created_at: nowIso,
        actor_pseudonym: 'p-pre',
        anonymous_default_kept: true,
        has_named_source: false,
        key_id: 'k-epoch-1'
      }
    ];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rowsFromView } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    });

    // The keystone assertion the F182-3 fix must satisfy: no whole-page
    // decrypt_failed lockout on the common re-sign-in path.
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.items.length).toBe(1);
    expect(r.items[0]!.title).toBe('history-title-under-retired-epoch-1');
    expect(r.items[0]!.body).toBe('history-body-under-retired-epoch-1');

    // …and the baseline load brought in BOTH epochs (retired read key retained).
    expect(keyHolder.size()).toBeGreaterThanOrEqual(2);
    expect(keyHolder.getKeyId()).toBe('k-epoch-2');
  });
});

// ===========================================================================
// F182-9 / ADR-0031 — the escalate-on-miss test set (AC-2..AC-9 + re-pass
// triggers #15..#19 + F-VAL-1(a)), CONCERN read/seal paths.
//
// RED-FIRST: every "escalation behaviour" test below FAILS against the current
// worktree because the read compositions ABORT on the first `trialOpen` miss
// (`concerns/production-flows.ts:466-468` / `:565-568`) instead of escalating to
// `unwrapAllCommitteeKeysViaProduction` + `populate()`. Each goes GREEN only once
// the implementer lands `escalateToAllEpochs` + `mode:'read'|'seal'`.
//
// A handful of tests below are REGRESSION PINS that are GREEN today and MUST stay
// GREEN: they guard against the implementer (a) wiring escalation into a SEAL
// path (#15 — re-opens F-190), (b) adopting load-all-on-init (#19 — the
// audit-noise regression the ADR rejected), or (c) breaking the retired-only
// WRITE fail-closed gate (AC-4). Each such test is labelled `[PIN]`.
//
// Determinism: real libsodium, mock transports, a real BrowserLocalIdentityStore
// (SSR-fallback Map), a real (or getDataKey-override) CommitteeKeyHolder. No real
// clock (created_at from Date.now(); days_since_filed never asserted), no real
// network, no seeded-RNG assertion (assertions are on decrypt round-trip / typed
// status / transport op-count, never on raw ciphertext bytes). Each test owns its
// fixtures. The one mid-seal interleave (F-VAL-1(a)) is forced deterministically
// via a getDataKey()-override that injects the read-escalation populate() into the
// seal's `await ready()` gap, with a determinism GUARD that FAILS LOUDLY (asserts
// the captured buffer was actually zeroed) if the race did not fire — so the test
// can never pass by accident of timing.
// ===========================================================================

const RETIRED_ONLY_LIVE_KEY_ID = 'k-epoch-2'; // probe-reported live epoch the retired-only member does NOT hold

/**
 * A retired-only remaining member (ADR-0031 Decision 3 / second-opinion Concern
 * 2). Holder EMPTY. The probe reports `actor_has_wrap:true` with a LIVE key_id
 * the member does NOT hold; the single-live disclosure (`get_key_wrap`) returns
 * null; `get_all_key_wraps` returns ONLY a retired (`is_live:false`) entry.
 */
async function buildRetiredOnlySession() {
  const retiredKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const localIdentity = silentStore();
  const kp = sodium.crypto_box_keypair();
  await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

  const srv: FakeKeyServer = {
    liveKeyId: RETIRED_ONLY_LIVE_KEY_ID,
    liveEpoch: 2,
    actorHasWrap: true,
    liveWrap: null, // get_key_wrap (live) → null: the member holds NO live wrap
    allWraps: [
      { key_id: 'k-epoch-1', epoch: 1, wrap: sodium.crypto_box_seal(retiredKey, kp.publicKey), is_live: false }
    ]
  };
  const t07 = makeT07Transport(srv);
  const t07Client = new SupabaseT07Client({ transport: t07.transport, localIdentity });
  const keyHolder = new CommitteeKeyHolder();
  return { srv, t07, t07Client, localIdentity, keyHolder, retiredKey };
}

/**
 * A fresh CURRENT-only session (re-pass trigger #19 anti-load-all-on-init pin):
 * the member holds the live epoch-2 wrap and reads ONLY current-epoch data, so
 * NO `trialOpen` miss ever occurs → escalation must NEVER fire.
 */
async function buildCurrentOnlySession() {
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
      { key_id: 'k-epoch-1', epoch: 1, wrap: sodium.crypto_box_seal(sodium.randombytes_buf(32), kp.publicKey), is_live: false },
      { key_id: 'k-epoch-2', epoch: 2, wrap: sodium.crypto_box_seal(liveKey, kp.publicKey), is_live: true }
    ]
  };
  const t07 = makeT07Transport(srv);
  const t07Client = new SupabaseT07Client({ transport: t07.transport, localIdentity });
  const keyHolder = new CommitteeKeyHolder();
  return { srv, t07, t07Client, localIdentity, keyHolder, liveKey };
}

/** Seal a plaintext under a FRESH random key the holder will never hold (a
 * post-escalation persistent miss / "wrong or corrupt" ciphertext). */
function sealUnderRandomKey(pt: string): string {
  return sealHex(pt, sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES));
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
 * A `CommitteeKeyHolder` that fires ONE armed trigger the first time
 * `getDataKey()` is read — on a `queueMicrotask` so it lands inside the seal's
 * `await ready()` gap, strictly before the synchronous secretbox. Same proven
 * mechanism as the committed F-190 mid-seal tests. Arm-ONCE: the fixed re-read of
 * `getDataKey()` after the seal-path liveness re-check does NOT re-arm.
 */
class MidSealRaceHolder extends CommitteeKeyHolder {
  #armed = false;
  #trigger: (() => void) | null = null;
  armOnFirstDataKeyRead(trigger: () => void): void {
    this.#armed = true;
    this.#trigger = trigger;
  }
  override getDataKey(): Uint8Array | null {
    const k = super.getDataKey();
    if (this.#armed && this.#trigger) {
      this.#armed = false;
      const t = this.#trigger;
      this.#trigger = null;
      queueMicrotask(t);
    }
    return k;
  }
}

/** F-190/F-VAL-1(a) load-bearing assertion: no POSTed ciphertext opens under an
 * all-zero key. `openUtf8` fails-closed for a real-key seal; it RESOLVES only for
 * bytes genuinely sealed under zeros — the world-readable disclosure forbidden. */
async function expectNoZeroKeyCiphertextPosted(bodies: Record<string, unknown>[]): Promise<void> {
  const ZERO_KEY = new Uint8Array(32);
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i]!;
    for (const field of ['title_ct', 'body_ct', 'source_name_ct'] as const) {
      const v = body[field];
      if (typeof v !== 'string' || !v.startsWith('\\x')) continue;
      let openedUnderZeroKey: string | null = null;
      try {
        openedUnderZeroKey = await openUtf8(pgHexToBytes(v), ZERO_KEY);
      } catch {
        openedUnderZeroKey = null; // sealed under a REAL key — opaque to zeros (good).
      }
      expect(
        openedUnderZeroKey,
        `F-VAL-1(a): POSTed body #${i} field \`${field}\` opens under an ALL-ZERO key → ` +
          `"${openedUnderZeroKey ?? ''}". A read-escalation populate() zeroed the captured ` +
          `data-key buffer during the seal's \`await\`; the seal must re-read getDataKey() after ` +
          `the liveness re-check and seal synchronously.`
      ).toBeNull();
    }
  }
}

// ---------------------------------------------------------------------------
// AC-3 / re-pass trigger #17 — retired-only READ escalates to `ok` (concerns)
// ---------------------------------------------------------------------------
describe('F-183-B / AC-3+#17 — retired-only remaining member READs (concerns)', () => {
  it('AC-3 — a retired-only member (probe live key_id NOT held; get_key_wrap null; all_wraps = retired-only) READs a retired-sealed row as `ok`, NOT `needs_setup`; hasLiveKey()===false, isPopulated()===true', async () => {
    const { t07, t07Client, localIdentity, keyHolder, retiredKey } = await buildRetiredOnlySession();
    const rows = [makeConcernRow({ id: 'c-retired', title_ct: sealHex('retired-title', retiredKey), body_ct: sealHex('retired-body', retiredKey), key_id: 'k-epoch-1' })];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({ client: t07Client, concernClient, keyHolder, localIdentity, user_id: USER });

    expect(r.status).toBe('ok'); // current worktree: `needs_setup` (single-live no_wrap misroute) — RED
    if (r.status !== 'ok') return;
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.title).toBe('retired-title');
    // The isPopulated()-sufficient read branch reached via the fresh-session path.
    expect(keyHolder.hasLiveKey()).toBe(false);
    expect(keyHolder.isPopulated()).toBe(true);
    // Exactly one escalation RPC drove the retired-only load.
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-4 / re-pass triggers #15+#17 — retired-only WRITE stays fail-closed; NO
// seal path ever escalates. [PIN — GREEN today, MUST stay GREEN]
// ---------------------------------------------------------------------------
describe('F-183-B / AC-4+#15 — retired-only WRITE fail-closed + seal paths never escalate (concerns) [PIN]', () => {
  it('AC-4+#17 — a retired-only member submitting a concern gets `needs_setup`; NO submit POST; NO all-wraps RPC on the seal path', async () => {
    const { t07, t07Client, localIdentity, keyHolder } = await buildRetiredOnlySession();
    const concern = makeConcernTransport([]); // any POST would throw "no response queued"
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await submitConcernViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: { title: 't', body: 'b', hazard_class: 'physical', severity: 'low', location_id: 'L-1', anonymous: true }
    });

    expect(r.status).toBe('needs_setup');
    expect(concern.bodies).toHaveLength(0); // no submit POST
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(0); // seal path never escalates (#15)
  });

  it('#15 — a NORMAL concern submit (holder has the live key) seals + POSTs but fires ZERO all-wraps RPC (the seal path must never call escalateToAllEpochs)', async () => {
    const { t07, t07Client, localIdentity, keyHolder } = await buildCurrentOnlySession();
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: { id: 'c-normal' } } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await submitConcernViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: { title: 't', body: 'b', hazard_class: 'physical', severity: 'low', location_id: 'L-1', anonymous: true }
    });

    expect(r.status).toBe('ok');
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-5 / re-pass trigger #16 — bounded escalation (at most ONE all-wraps RPC per
// read op), concerns list.
// ---------------------------------------------------------------------------
describe('F-183-B / AC-5+#16 — bounded escalation, concerns list', () => {
  it('AC-5 — a page of MULTIPLE pre-rotation (epoch-1) rows all open; `get_all_key_wraps` appears EXACTLY ONCE across the whole list', async () => {
    const { t07, t07Client, localIdentity, keyHolder, retiredKey } = await buildBaselineRotatedSession();
    const rows = [0, 1, 2, 3].map((n) =>
      makeConcernRow({ id: `c-${n}`, title_ct: sealHex(`pre-title-${n}`, retiredKey), body_ct: sealHex(`pre-body-${n}`, retiredKey), key_id: 'k-epoch-1' })
    );
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({ client: t07Client, concernClient, keyHolder, localIdentity, user_id: USER });

    expect(r.status).toBe('ok'); // current: aborts decrypt_failed on the first miss — RED
    if (r.status !== 'ok') return;
    expect(r.items).toHaveLength(4);
    expect(r.items.map((i) => i.title)).toEqual(['pre-title-0', 'pre-title-1', 'pre-title-2', 'pre-title-3']);
    // The bound: first miss fetches once; the remaining rows open against the now-
    // complete holder (or hit the spent guard) — never a per-row re-fetch.
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);
  });

  it('#16 (hostile all-miss page) — a page where EVERY row is un-openable fires `get_all_key_wraps` EXACTLY ONCE (bounded, never per-row audit-amplification) and fails closed', async () => {
    const { t07, t07Client, localIdentity, keyHolder } = await buildBaselineRotatedSession();
    const rows = [0, 1, 2, 3, 4].map((n) =>
      makeConcernRow({ id: `h-${n}`, title_ct: sealUnderRandomKey(`x-${n}`), body_ct: sealUnderRandomKey(`y-${n}`), key_id: 'k-epoch-hostile' })
    );
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({ client: t07Client, concernClient, keyHolder, localIdentity, user_id: USER });

    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.reason).toBe('decrypt_failed');
    // The bound is load-bearing for the audit-cost property (Property 2): a crafted
    // all-miss page must NEVER inflate `committee_data_key.unwrap` beyond one fetch.
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1); // current: 0 (no escalation) — RED
  });

  it('#16 (shared guard) — a retired-only member whose `ensureHolderPopulated` ALREADY escalated + a subsequent still-missing row fires ZERO ADDITIONAL all-wraps RPC (guard is shared, not per-row)', async () => {
    const { t07, t07Client, localIdentity, keyHolder } = await buildRetiredOnlySession();
    // The list row is sealed under YET ANOTHER epoch the retired-only member never
    // holds → it still misses AFTER the retired-only escalation already spent the
    // once-per-op guard. It must be terminal, never a second fetch.
    const rows = [makeConcernRow({ id: 'c-miss', title_ct: sealUnderRandomKey('nope-t'), body_ct: sealUnderRandomKey('nope-b'), key_id: 'k-epoch-3' })];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({ client: t07Client, concernClient, keyHolder, localIdentity, user_id: USER });

    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.reason).toBe('decrypt_failed');
    // ONE fetch total (the retired-only ensureHolderPopulated escalation); the read
    // loop's subsequent miss sees the spent guard → NO second fetch.
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1); // current: 0 + needs_setup — RED
  });
});

// ---------------------------------------------------------------------------
// AC-6 — persistent miss after escalation fails closed to decrypt_failed (no
// wrong-key plaintext), concerns.
// ---------------------------------------------------------------------------
describe('F-183-B / AC-6 — persistent post-escalation miss fails closed (concerns)', () => {
  it('AC-6 — a row sealed under an epoch the member NEVER held returns `decrypt_failed` AFTER escalation; NO wrong-key plaintext is returned; the escalation RPC fired exactly once', async () => {
    const { t07, t07Client, localIdentity, keyHolder } = await buildBaselineRotatedSession();
    const NEVER = 'AC6-PLAINTEXT-MUST-NOT-SURFACE';
    const rows = [makeConcernRow({ id: 'c-nomatch', title_ct: sealUnderRandomKey(NEVER), body_ct: sealUnderRandomKey(NEVER), key_id: 'k-epoch-unknown' })];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({ client: t07Client, concernClient, keyHolder, localIdentity, user_id: USER });

    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.reason).toBe('decrypt_failed');
    // No wrong-key value smuggled through the failure surface.
    expect(JSON.stringify(r)).not.toContain(NEVER);
    // Escalation was ATTEMPTED once (proves the read miss escalated, then failed
    // closed) — current worktree fires zero: RED.
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-7 / re-pass trigger #18 — the F-183-B-OBS diagnostic is key-material-free
// (counts + booleans only), concerns.
// ---------------------------------------------------------------------------
describe('F-183-B / AC-7+#18 — OBS seam leaks no key material (concerns)', () => {
  function findDiagnostic() {
    return __getCapturedLines().find(
      (l) => l.attributes !== undefined && (l.attributes as Record<string, unknown>).escalated !== undefined
    );
  }
  function assertNoKeyMaterialInLogs(forbidden: string[]) {
    const blob = __getCapturedLines().map((l) => JSON.stringify(l)).join('\n');
    for (const secret of forbidden) {
      expect(blob, `F-183-B-OBS (#18): the diagnostic log leaked "${secret}"`).not.toContain(secret);
    }
  }

  it('AC-7 (missing-epoch) — a post-escalation miss whose row key_id is NOT held logs `escalated:true`, `epochs_held` (a count), `row_epoch_held:false`; NO key_id VALUE / key bytes / plaintext', async () => {
    const { t07, t07Client, localIdentity, keyHolder, retiredKey, liveKey } = await buildBaselineRotatedSession();
    const rows = [makeConcernRow({ id: 'c-missing', title_ct: sealUnderRandomKey('OBS-MISS-TITLE'), body_ct: sealUnderRandomKey('OBS-MISS-BODY'), key_id: 'k-epoch-404-not-held' })];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    await listConcernsViaProduction({ client: t07Client, concernClient, keyHolder, localIdentity, user_id: USER });

    const diag = findDiagnostic();
    expect(diag, 'no F-183-B-OBS diagnostic emitted on the persistent post-escalation miss').toBeDefined();
    if (!diag) return;
    const attrs = diag.attributes as Record<string, unknown>;
    expect(attrs.escalated).toBe(true);
    expect(typeof attrs.epochs_held).toBe('number');
    expect(attrs.epochs_held).toBe(2); // holds {epoch-1, epoch-2} after escalation
    expect(attrs.row_epoch_held).toBe(false); // row's claimed epoch is NOT held → missing-epoch, benign
    // #18 leak canary: no key_id VALUE, no key bytes, no plaintext anywhere in the logs.
    assertNoKeyMaterialInLogs(['k-epoch-1', 'k-epoch-2', 'k-epoch-404-not-held', sodium.to_hex(retiredKey), sodium.to_hex(liveKey), 'OBS-MISS-TITLE', 'OBS-MISS-BODY']);
  });

  it('AC-7 (corrupt-but-held-epoch) — a post-escalation miss whose row key_id IS held logs `row_epoch_held:true` (the corrupt/tamper telemetry class); still NO key material', async () => {
    const { t07, t07Client, localIdentity, keyHolder, retiredKey, liveKey } = await buildBaselineRotatedSession();
    // key_id hint says the HELD epoch-2, but the bytes were sealed under a random
    // key so no held key authenticates → corrupt/tamper class (row_epoch_held true).
    const rows = [makeConcernRow({ id: 'c-corrupt', title_ct: sealUnderRandomKey('OBS-CORRUPT-TITLE'), body_ct: sealUnderRandomKey('OBS-CORRUPT-BODY'), key_id: 'k-epoch-2' })];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    await listConcernsViaProduction({ client: t07Client, concernClient, keyHolder, localIdentity, user_id: USER });

    const diag = findDiagnostic();
    expect(diag, 'no F-183-B-OBS diagnostic emitted on the persistent post-escalation miss').toBeDefined();
    if (!diag) return;
    const attrs = diag.attributes as Record<string, unknown>;
    expect(attrs.escalated).toBe(true);
    expect(attrs.row_epoch_held).toBe(true); // the actor holds the row's claimed epoch → genuine corrupt/tamper
    assertNoKeyMaterialInLogs(['k-epoch-1', 'k-epoch-2', sodium.to_hex(retiredKey), sodium.to_hex(liveKey), 'OBS-CORRUPT-TITLE', 'OBS-CORRUPT-BODY']);
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-9 — escalation fetch-fault typing (401 vs non-401), concerns.
// ---------------------------------------------------------------------------
describe('F-183-B / AC-9 — escalation fetch-fault typing (concerns)', () => {
  it('AC-9 (401) — a 401 during `get_all_key_wraps` (the escalation RPC) → `session_expiry` AND the holder is wiped', async () => {
    const { srv, t07, t07Client, localIdentity, keyHolder, retiredKey } = await buildBaselineRotatedSession();
    srv.allWrapsStatus = 401;
    const rows = [makeConcernRow({ id: 'c-401', title_ct: sealHex('pre', retiredKey), body_ct: sealHex('pre', retiredKey), key_id: 'k-epoch-1' })];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({ client: t07Client, concernClient, keyHolder, localIdentity, user_id: USER });

    expect(r.status).toBe('session_expiry'); // current: decrypt_failed (no escalation) — RED
    expect(keyHolder.isPopulated()).toBe(false); // 401 wiped the holder
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);
  });

  it('AC-9 (non-401) — a 500 during the escalation RPC → `failed` (NOT `decrypt_failed`: a fetch fault, not a crypto miss)', async () => {
    const { srv, t07, t07Client, localIdentity, keyHolder, retiredKey } = await buildBaselineRotatedSession();
    srv.allWrapsStatus = 500;
    const rows = [makeConcernRow({ id: 'c-500', title_ct: sealHex('pre', retiredKey), body_ct: sealHex('pre', retiredKey), key_id: 'k-epoch-1' })];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({ client: t07Client, concernClient, keyHolder, localIdentity, user_id: USER });

    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.reason).not.toBe('decrypt_failed'); // current: decrypt_failed — RED
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// re-pass trigger #19 — a fresh CURRENT-only session fires ZERO all-wraps RPC
// (the anti-load-all-on-init / audit-noise pin). [PIN — GREEN today, MUST stay
// GREEN through a correct escalate-on-miss implementation]
// ---------------------------------------------------------------------------
describe('F-183-B / #19 — current-only session never escalates (concerns) [PIN]', () => {
  it('#19 — a fresh session reading ONLY current-epoch rows opens them WITHOUT any `get_all_key_wraps` RPC (escalate-on-miss, NOT load-all-on-init)', async () => {
    const { t07, t07Client, localIdentity, keyHolder, liveKey } = await buildCurrentOnlySession();
    const rows = [makeConcernRow({ id: 'c-cur-0', title_ct: sealHex('cur-0', liveKey), body_ct: sealHex('cur-0', liveKey), key_id: 'k-epoch-2' })];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({ client: t07Client, concernClient, keyHolder, localIdentity, user_id: USER });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.items[0]!.title).toBe('cur-0');
    // The whole point of the fork ruling: no historical read ⇒ no all-wraps RPC ⇒
    // no per-login `committee_data_key.unwrap` audit-noise / over-disclosure.
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-2 (reveal mirror) — revealConcernSourceViaProduction escalates on a
// retired-epoch-sealed source_name.
// ---------------------------------------------------------------------------
describe('F-183-B / AC-2 (reveal mirror) — source_name under a retired epoch reveals after escalation (concerns)', () => {
  it('AC-2 — a fresh post-rotation session reveals a source_name sealed under the RETIRED epoch-1 via escalate-on-miss (`ok`, correct source_name)', async () => {
    const { t07, t07Client, localIdentity, keyHolder, retiredKey } = await buildBaselineRotatedSession();
    const SOURCE = 'named-source-under-retired-epoch';
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: { source_name_ct: sealHex(SOURCE, retiredKey) } } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await revealConcernSourceViaProduction({ client: t07Client, concernClient, keyHolder, localIdentity, user_id: USER, id: 'c-pre', passphrase: null });

    expect(r.status).toBe('ok'); // current: single-record trialOpen miss → decrypt_failed — RED
    if (r.status !== 'ok') return;
    expect(r.source_name).toBe(SOURCE);
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);
    expect(keyHolder.size()).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// F-VAL-1(a) — the NEW read-escalation populate() call site, when it fires
// during a concurrent seal's `await ready()` gap, must NOT induce a seal under a
// zeroed (all-zero) data key. The F-190 populate-trigger assertion re-
// parameterized onto the read-escalation site. [PIN — GREEN today: the landed
// F-190 re-read-getDataKey() guard is populate-source-agnostic; this pins that it
// keeps covering the read-escalation call site F182-9 introduces.]
// ---------------------------------------------------------------------------
describe('F-183-B / F-VAL-1(a) — read-escalation populate() mid-seal does not seal-under-zero (concerns) [PIN]', () => {
  it('F-VAL-1(a) — a read-escalation multi-epoch populate([retired, live-fresh]) landing inside submitConcern`s seal await must NOT POST a ciphertext openable under an all-zero key', async () => {
    const { t07Client, localIdentity } = await buildBaselineRotatedSession();

    // The submit`s captured live buffer. A read-op escalation populate() installs a
    // FRESH multi-epoch map (distinct buffers), orphaning + zeroing this one via
    // F-145-C`s identity-compare — while hasLiveKey() stays TRUE.
    const capturedLive = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const holder = new MidSealRaceHolder();
    holder.set({ data_key: capturedLive, key_id: 'k-epoch-2', epoch: 2 });

    // Exactly the entries a read-op `escalateToAllEpochs` → `populate(all.entries)`
    // would install: retired epoch-1 + a FRESH live epoch-2 buffer.
    const freshRetired = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const freshLive = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    holder.armOnFirstDataKeyRead(() =>
      holder.populate([
        { data_key: freshRetired, key_id: 'k-epoch-1', epoch: 1, is_live: false },
        { data_key: freshLive, key_id: 'k-epoch-2', epoch: 2, is_live: true }
      ])
    );

    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: { id: 'c-fval' } } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await submitConcernViaProduction({
      client: t07Client,
      concernClient,
      keyHolder: holder,
      localIdentity,
      user_id: USER,
      intake: { title: 'FVAL1a-TITLE', body: 'FVAL1a-BODY', hazard_class: 'physical', severity: 'low', location_id: 'L-1', anonymous: true }
    });

    // Determinism GUARD — the read-escalation populate genuinely fired mid-seal:
    // the orphaned captured buffer is zeroed while the holder still reports a live
    // key. If this fails, the interleave did not happen and the test is inconclusive
    // (never a silent pass).
    expect(
      Array.from(capturedLive).every((b) => b === 0),
      'race not exercised: the captured buffer was never zeroed by the read-escalation populate()'
    ).toBe(true);
    expect(holder.hasLiveKey()).toBe(true);

    // THE invariant: no all-zero-key ciphertext reached the wire.
    await expectNoZeroKeyCiphertextPosted(concern.bodies);

    // Coherence: a correct seal re-reads getDataKey() → seals under the FRESH live
    // epoch-2 key (never the zeroed captured buffer).
    if (r.status === 'ok') {
      const body = concern.bodies[0] as { title_ct?: string };
      expect(typeof body.title_ct).toBe('string');
      await expect(openUtf8(pgHexToBytes(body.title_ct as string), freshLive)).resolves.toBe('FVAL1a-TITLE');
    }
  });
});
