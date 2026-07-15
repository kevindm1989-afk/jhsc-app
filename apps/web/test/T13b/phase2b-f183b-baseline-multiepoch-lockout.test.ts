/**
 * F-183-B — fresh-session / retired-only BASELINE multi-epoch anti-lockout,
 * REPRISAL read/seal mirror (F182-9 / ADR-0031 escalate-on-miss;
 * threat-model §3.18 F-183-B DESIGN VALIDATION, re-pass triggers #15..#19,
 * F-VAL-1(a)).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY; do not relax
 * the assertions.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE GAP (verified this pass — reprisal read path)
 * ───────────────────────────────────────────────────────────────────────────
 * `readReprisalViaProduction` (`reprisal/production-flows.ts`) runs the SINGLE-
 * live baseline load on a fresh session (`ensureHolderPopulated` → the mid-
 * session self-heal branch is skipped when the holder is EMPTY, :162; the load
 * falls to `unwrapCommitteeDataKeyViaProduction` + `keyHolder.set(...)`, :193-213
 * — the LIVE epoch only). A record sealed under a RETIRED epoch then MISSES the
 * single `trialOpen` (:405-408) and the read returns `decrypt_failed` (:409-411)
 * — the F-183 anti-lockout catastrophe on the common re-sign-in path. A retired-
 * only remaining member is worse: the single-live unwrap returns `no_wrap`, so
 * `ensureHolderPopulated` misroutes them to `needs_setup` even for READS (Decision
 * 3 / second-opinion Concern 2).
 *
 * These tests go GREEN only once the implementer lands `escalateToAllEpochs`
 * (escalate to `unwrapAllCommitteeKeysViaProduction` + `populate()` ONCE on the
 * first miss, then retry) + threads `mode:'read'|'seal'` through the reprisal
 * `ensureHolderPopulated` (read-mode escalates a retired-only member; seal-mode
 * stays fail-closed to `needs_setup`).
 *
 * A few tests are REGRESSION PINS (`[PIN]`) — GREEN today and MUST stay GREEN:
 * they guard against escalation being wired into a SEAL path (#15 → re-opens
 * F-190), against load-all-on-init (#19 audit-noise regression), and against the
 * retired-only WRITE gate being loosened (AC-4). F-VAL-1(a) pins that the landed
 * F-190 re-read-getDataKey() guard keeps covering the NEW read-escalation
 * populate() call site when it fires during a concurrent reprisal seal.
 *
 * Determinism: real libsodium (secretbox + sealed-box), mock t07/reprisal
 * transports, a real BrowserLocalIdentityStore (SSR-fallback Map). No real clock
 * (no ts/latency assertions), no real network, no seeded-RNG assertion
 * (assertions are on decrypt round-trip / typed status / transport op-count,
 * never raw ciphertext bytes). Each test owns its fixtures. The one mid-seal
 * interleave (F-VAL-1(a)) is forced deterministically via a getDataKey()-override
 * that injects the read-escalation populate() into the seal's `await ready()`
 * gap, with a determinism GUARD that FAILS LOUDLY if the race did not fire.
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
import {
  readReprisalViaProduction,
  submitReprisalViaProduction,
  updateReprisalViaProduction
} from '../../src/lib/reprisal/production-flows';
import { openUtf8 } from '../../src/lib/concerns/seal';
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

/** Seal under a FRESH random key the holder will never hold (a persistent miss). */
function sealUnderRandomKey(pt: string): string {
  return sealHex(pt, sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES));
}

interface FakeKeyServer {
  liveKeyId: string;
  liveEpoch: number;
  actorHasWrap: boolean;
  liveWrap: Uint8Array | null;
  allWraps: Array<{ key_id: string; epoch: number; wrap: Uint8Array; is_live: boolean }> | null;
  /** AC-9: when non-200, the escalation RPC (`get_all_key_wraps`) returns a typed
   * transport error so the 401-vs-non-401 branch can be exercised. */
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
 * A fresh signed-in session (EMPTY holder) after the committee rotated to
 * epoch-2. The member legitimately holds BOTH a retired epoch-1 wrap and the live
 * epoch-2 wrap; the single-live probe reports only the live epoch-2 key_id.
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
  const keyHolder = new CommitteeKeyHolder();
  return { srv, t07, t07Client, localIdentity, keyHolder, retiredKey, liveKey };
}

/**
 * A retired-only remaining member (Decision 3). Holder EMPTY; probe reports
 * `actor_has_wrap:true` with a live key_id the member does NOT hold; `get_key_wrap`
 * (live) → null; `get_all_key_wraps` → ONLY a retired (`is_live:false`) entry.
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
  const keyHolder = new CommitteeKeyHolder();
  return { srv, t07, t07Client, localIdentity, keyHolder, retiredKey };
}

/** A fresh CURRENT-only session (re-pass trigger #19 anti-load-all-on-init pin). */
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
      { key_id: 'k-epoch-2', epoch: 2, wrap: sodium.crypto_box_seal(liveKey, kp.publicKey), is_live: true }
    ]
  };
  const t07 = makeT07Transport(srv);
  const t07Client = new SupabaseT07Client({ transport: t07.transport, localIdentity });
  const keyHolder = new CommitteeKeyHolder();
  return { srv, t07, t07Client, localIdentity, keyHolder, liveKey };
}

/**
 * A `CommitteeKeyHolder` that fires ONE armed trigger the first time
 * `getDataKey()` is read — on a `queueMicrotask` so it lands inside the seal's
 * `await ready()` gap, strictly before the synchronous secretbox. Same proven
 * mechanism as the committed F-190 mid-seal tests. Arm-ONCE.
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

async function expectNoZeroKeyCiphertextPosted(bodies: Record<string, unknown>[]): Promise<void> {
  const ZERO_KEY = new Uint8Array(32);
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i]!;
    for (const field of ['title_ct', 'body_ct'] as const) {
      const v = body[field];
      if (typeof v !== 'string' || !v.startsWith('\\x')) continue;
      let openedUnderZeroKey: string | null = null;
      try {
        openedUnderZeroKey = await openUtf8(pgHexToBytes(v), ZERO_KEY);
      } catch {
        openedUnderZeroKey = null;
      }
      expect(
        openedUnderZeroKey,
        `F-VAL-1(a): POSTed reprisal body #${i} field \`${field}\` opens under an ALL-ZERO key → ` +
          `"${openedUnderZeroKey ?? ''}". A read-escalation populate() zeroed the captured data-key ` +
          `buffer during the seal's \`await\`; the seal must re-read getDataKey() after the liveness ` +
          `re-check and seal synchronously.`
      ).toBeNull();
    }
  }
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
// AC-2 — reprisal read escalates on a retired-epoch-sealed record.
// ---------------------------------------------------------------------------
describe('F-183-B / AC-2 — fresh-session baseline multi-epoch anti-lockout (reprisal read)', () => {
  it('AC-2 — an EMPTY holder on a fresh post-rotation session holding {retired epoch-1, live epoch-2} opens a reprisal record sealed under epoch-1 via escalate-on-miss (`ok`, correct title+body); holder ends with both epochs, live=epoch-2', async () => {
    const { t07, t07Client, localIdentity, keyHolder, retiredKey } = await buildBaselineRotatedSession();
    const TITLE = 'reprisal-title-under-retired-epoch-1';
    const BODY = 'reprisal-body-under-retired-epoch-1';
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { title_ct: sealHex(TITLE, retiredKey), body_ct: sealHex(BODY, retiredKey) } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    expect(keyHolder.isPopulated()).toBe(false); // fresh session precondition

    const r = await readReprisalViaProduction({ reprisalClient, t07Client, keyHolder, localIdentity, user_id: USER, id: 'r-pre', passphrase: null });

    expect(r.status).toBe('ok'); // current: single-live trialOpen miss → decrypt_failed — RED
    if (r.status !== 'ok') return;
    expect(r.title).toBe(TITLE);
    expect(r.body).toBe(BODY);
    expect(keyHolder.size()).toBeGreaterThanOrEqual(2);
    expect(keyHolder.getKeyId()).toBe('k-epoch-2');
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1); // bounded: escalated exactly once
  });
});

// ---------------------------------------------------------------------------
// AC-3 / re-pass trigger #17 — retired-only READ escalates to `ok` (reprisal).
// ---------------------------------------------------------------------------
describe('F-183-B / AC-3+#17 — retired-only remaining member READs (reprisal)', () => {
  it('AC-3 — a retired-only member reads a retired-sealed reprisal record as `ok`, NOT `needs_setup`; hasLiveKey()===false, isPopulated()===true', async () => {
    const { t07, t07Client, localIdentity, keyHolder, retiredKey } = await buildRetiredOnlySession();
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { title_ct: sealHex('retired-t', retiredKey), body_ct: sealHex('retired-b', retiredKey) } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({ reprisalClient, t07Client, keyHolder, localIdentity, user_id: USER, id: 'r-retired', passphrase: null });

    expect(r.status).toBe('ok'); // current: needs_setup (single-live no_wrap misroute) — RED
    if (r.status !== 'ok') return;
    expect(r.title).toBe('retired-t');
    expect(keyHolder.hasLiveKey()).toBe(false);
    expect(keyHolder.isPopulated()).toBe(true);
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-4 / re-pass trigger #15 — retired-only WRITE fail-closed + seal paths never
// escalate. [PIN — GREEN today, MUST stay GREEN]
// ---------------------------------------------------------------------------
describe('F-183-B / AC-4+#15 — retired-only WRITE fail-closed + reprisal seal paths never escalate [PIN]', () => {
  it('AC-4+#17 — a retired-only member submitting a reprisal gets `needs_setup`; NO submit POST; NO all-wraps RPC on the seal path', async () => {
    const { t07, t07Client, localIdentity, keyHolder } = await buildRetiredOnlySession();
    const reprisal = makeReprisalTransport([]); // any POST would throw
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      intake: { title: 't', body: 'b', passphrase: 'friction' }
    });

    expect(r.status).toBe('needs_setup');
    expect(reprisal.bodies).toHaveLength(0);
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(0);
  });

  it('#15 — a NORMAL reprisal submit fires ZERO all-wraps RPC (the seal path must never escalate)', async () => {
    const { t07, t07Client, localIdentity, keyHolder } = await buildCurrentOnlySession();
    const reprisal = makeReprisalTransport([{ status: 200, body: { ok: true, data: { id: 'r-normal' } } }]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await submitReprisalViaProduction({ reprisalClient, t07Client, keyHolder, localIdentity, user_id: USER, intake: { title: 't', body: 'b', passphrase: 'friction' } });

    expect(r.status).toBe('ok');
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(0);
  });

  it('#15 — a reprisal UPDATE fires ZERO all-wraps RPC (the seal path must never escalate)', async () => {
    const { t07, t07Client, localIdentity, keyHolder } = await buildCurrentOnlySession();
    const reprisal = makeReprisalTransport([{ status: 200, body: { ok: true, data: null } }]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await updateReprisalViaProduction({ reprisalClient, t07Client, keyHolder, localIdentity, user_id: USER, id: 'r-1', title: 'new-title', body: 'new-body' });

    expect(r.status).toBe('ok');
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-5 / AC-6 / re-pass trigger #16 — bounded escalation + persistent miss fails
// closed (reprisal single-record read).
// ---------------------------------------------------------------------------
describe('F-183-B / AC-5+AC-6+#16 — bounded escalation + persistent miss (reprisal)', () => {
  it('AC-6 — a reprisal record sealed under an epoch the member NEVER held returns `decrypt_failed` AFTER escalation; NO plaintext leaks; the escalation RPC fired exactly once (bounded)', async () => {
    const { t07, t07Client, localIdentity, keyHolder } = await buildBaselineRotatedSession();
    const NEVER = 'AC6-REPRISAL-PLAINTEXT-MUST-NOT-SURFACE';
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { title_ct: sealUnderRandomKey(NEVER), body_ct: sealUnderRandomKey(NEVER) } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({ reprisalClient, t07Client, keyHolder, localIdentity, user_id: USER, id: 'r-nomatch', passphrase: null });

    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.reason).toBe('decrypt_failed');
    expect(JSON.stringify(r)).not.toContain(NEVER);
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1); // current: 0 (no escalation) — RED
  });

  it('#16 (shared guard) — a retired-only member whose read-mode escalation ALREADY ran + a record STILL missing fires ZERO ADDITIONAL all-wraps RPC (guard is shared, not re-armed per attempt)', async () => {
    const { t07, t07Client, localIdentity, keyHolder } = await buildRetiredOnlySession();
    // Sealed under yet another epoch the retired-only member never holds → still
    // misses AFTER the retired-only escalation spent the once-per-op guard.
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { title_ct: sealUnderRandomKey('nope-t'), body_ct: sealUnderRandomKey('nope-b') } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({ reprisalClient, t07Client, keyHolder, localIdentity, user_id: USER, id: 'r-miss', passphrase: null });

    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.reason).toBe('decrypt_failed');
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1); // current: 0 + needs_setup — RED
  });
});

// ---------------------------------------------------------------------------
// AC-7 / re-pass trigger #18 — OBS seam key-material-free (reprisal). The
// reprisal read carries no key_id hint (ADR-0028 option (a)), so the diagnostic
// classifies as corrupt/tamper (no `row_epoch_held` hint) — still counts +
// booleans only, never key material.
// ---------------------------------------------------------------------------
describe('F-183-B / AC-7+#18 — OBS seam leaks no key material (reprisal)', () => {
  it('AC-7/#18 — a persistent post-escalation miss logs `escalated:true` + `epochs_held` (a count) and NO key_id VALUE / key bytes / plaintext', async () => {
    const { t07, t07Client, localIdentity, keyHolder, retiredKey, liveKey } = await buildBaselineRotatedSession();
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { title_ct: sealUnderRandomKey('OBS-REPRISAL-TITLE'), body_ct: sealUnderRandomKey('OBS-REPRISAL-BODY') } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    await readReprisalViaProduction({ reprisalClient, t07Client, keyHolder, localIdentity, user_id: USER, id: 'r-obs', passphrase: null });

    const diag = __getCapturedLines().find(
      (l) => l.attributes !== undefined && (l.attributes as Record<string, unknown>).escalated !== undefined
    );
    expect(diag, 'no F-183-B-OBS diagnostic emitted on the persistent post-escalation reprisal miss').toBeDefined();
    if (!diag) return;
    const attrs = diag.attributes as Record<string, unknown>;
    expect(attrs.escalated).toBe(true);
    expect(typeof attrs.epochs_held).toBe('number');
    expect(attrs.epochs_held).toBe(2);

    const blob = __getCapturedLines().map((l) => JSON.stringify(l)).join('\n');
    for (const secret of ['k-epoch-1', 'k-epoch-2', sodium.to_hex(retiredKey), sodium.to_hex(liveKey), 'OBS-REPRISAL-TITLE', 'OBS-REPRISAL-BODY']) {
      expect(blob, `F-183-B-OBS (#18): the diagnostic log leaked "${secret}"`).not.toContain(secret);
    }
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-9 — escalation fetch-fault typing (401 vs non-401), reprisal.
// ---------------------------------------------------------------------------
describe('F-183-B / AC-9 — escalation fetch-fault typing (reprisal)', () => {
  it('AC-9 (401) — a 401 during the escalation RPC → `session_expiry` AND the holder is wiped', async () => {
    const { srv, t07, t07Client, localIdentity, keyHolder, retiredKey } = await buildBaselineRotatedSession();
    srv.allWrapsStatus = 401;
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { title_ct: sealHex('pre', retiredKey), body_ct: sealHex('pre', retiredKey) } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({ reprisalClient, t07Client, keyHolder, localIdentity, user_id: USER, id: 'r-401', passphrase: null });

    expect(r.status).toBe('session_expiry'); // current: decrypt_failed — RED
    expect(keyHolder.isPopulated()).toBe(false);
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);
  });

  it('AC-9 (non-401) — a 500 during the escalation RPC → `failed` (NOT `decrypt_failed`)', async () => {
    const { srv, t07, t07Client, localIdentity, keyHolder, retiredKey } = await buildBaselineRotatedSession();
    srv.allWrapsStatus = 500;
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { title_ct: sealHex('pre', retiredKey), body_ct: sealHex('pre', retiredKey) } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({ reprisalClient, t07Client, keyHolder, localIdentity, user_id: USER, id: 'r-500', passphrase: null });

    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.reason).not.toBe('decrypt_failed'); // current: decrypt_failed — RED
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// re-pass trigger #19 — a fresh CURRENT-only session fires ZERO all-wraps RPC.
// [PIN — GREEN today, MUST stay GREEN]
// ---------------------------------------------------------------------------
describe('F-183-B / #19 — current-only session never escalates (reprisal) [PIN]', () => {
  it('#19 — a fresh session reading a CURRENT-epoch reprisal record opens it WITHOUT any `get_all_key_wraps` RPC (escalate-on-miss, NOT load-all-on-init)', async () => {
    const { t07, t07Client, localIdentity, keyHolder, liveKey } = await buildCurrentOnlySession();
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { title_ct: sealHex('cur-t', liveKey), body_ct: sealHex('cur-b', liveKey) } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({ reprisalClient, t07Client, keyHolder, localIdentity, user_id: USER, id: 'r-cur', passphrase: null });

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.title).toBe('cur-t');
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F-VAL-1(a) — the NEW read-escalation populate() call site, when it fires during
// a concurrent reprisal seal's `await ready()` gap, must NOT induce a seal under a
// zeroed key. The F-190 populate-trigger assertion re-parameterized onto the read-
// escalation site, for BOTH reprisal seal paths. [PIN — GREEN today.]
// ---------------------------------------------------------------------------
describe('F-183-B / F-VAL-1(a) — read-escalation populate() mid-seal does not seal-under-zero (reprisal) [PIN]', () => {
  async function runInterleave(
    kind: 'submit' | 'update'
  ): Promise<{ capturedLive: Uint8Array; freshLive: Uint8Array; holder: MidSealRaceHolder; bodies: Record<string, unknown>[]; status: string }> {
    const { t07Client, localIdentity } = await buildBaselineRotatedSession();

    const capturedLive = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const holder = new MidSealRaceHolder();
    holder.set({ data_key: capturedLive, key_id: 'k-epoch-2', epoch: 2 });

    const freshRetired = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const freshLive = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    holder.armOnFirstDataKeyRead(() =>
      holder.populate([
        { data_key: freshRetired, key_id: 'k-epoch-1', epoch: 1, is_live: false },
        { data_key: freshLive, key_id: 'k-epoch-2', epoch: 2, is_live: true }
      ])
    );

    const reprisal = makeReprisalTransport([
      { status: 200, body: kind === 'submit' ? { ok: true, data: { id: 'r-fval' } } : { ok: true, data: null } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r =
      kind === 'submit'
        ? await submitReprisalViaProduction({ reprisalClient, t07Client, keyHolder: holder, localIdentity, user_id: USER, intake: { title: 'FVAL1a-R-TITLE', body: 'FVAL1a-R-BODY', passphrase: 'friction' } })
        : await updateReprisalViaProduction({ reprisalClient, t07Client, keyHolder: holder, localIdentity, user_id: USER, id: 'r-1', title: 'FVAL1a-R-TITLE', body: 'FVAL1a-R-BODY' });

    return { capturedLive, freshLive, holder, bodies: reprisal.bodies, status: r.status };
  }

  it('F-VAL-1(a) submit — a read-escalation populate() landing inside submitReprisal`s seal await must NOT POST a ciphertext openable under an all-zero key', async () => {
    const { capturedLive, freshLive, holder, bodies, status } = await runInterleave('submit');

    expect(
      Array.from(capturedLive).every((b) => b === 0),
      'race not exercised: the captured buffer was never zeroed by the read-escalation populate()'
    ).toBe(true);
    expect(holder.hasLiveKey()).toBe(true);

    await expectNoZeroKeyCiphertextPosted(bodies);

    if (status === 'ok') {
      const body = bodies[0] as { title_ct?: string };
      expect(typeof body.title_ct).toBe('string');
      await expect(openUtf8(pgHexToBytes(body.title_ct as string), freshLive)).resolves.toBe('FVAL1a-R-TITLE');
    }
  });

  it('F-VAL-1(a) update — a read-escalation populate() landing inside updateReprisal`s seal await must NOT POST a ciphertext openable under an all-zero key', async () => {
    const { capturedLive, freshLive, holder, bodies, status } = await runInterleave('update');

    expect(
      Array.from(capturedLive).every((b) => b === 0),
      'race not exercised: the captured buffer was never zeroed by the read-escalation populate()'
    ).toBe(true);
    expect(holder.hasLiveKey()).toBe(true);

    await expectNoZeroKeyCiphertextPosted(bodies);

    if (status === 'ok') {
      const body = bodies[0] as { title_ct?: string };
      expect(typeof body.title_ct).toBe('string');
      await expect(openUtf8(pgHexToBytes(body.title_ct as string), freshLive)).resolves.toBe('FVAL1a-R-TITLE');
    }
  });
});
