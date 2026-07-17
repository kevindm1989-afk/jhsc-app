/**
 * F-VAL-1(b) — wipe-then-resurrect key-lifecycle gap on the CONCERN read paths
 * (threat-model §3.18 F-183-B CLOSURE / F-VAL-1(b) ruling, `.context/threat-model.md`
 * ~:4631-4635; security-reviewer specified the wipe-generation latch fix).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY; do not relax
 * the assertions.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE DEFECT (confirmed on this worktree)
 * ───────────────────────────────────────────────────────────────────────────
 * A panic-wipe / 401 / page-unload firing DURING a read composition's disclosure
 * fetch `await` empties the holder via `wipe()`. The fetch then RESOLVES and the
 * composition RE-INSTALLS the keys (`populate()` / `set()`), RESURRECTING the
 * just-wiped key map. `wipe()` sets no latch and `populate()` / `set()` check
 * none, so the resurrected keys persist until the next wipe trigger — defeating
 * panic-wipe, a data-destruction SAFETY feature.
 *
 * The three read-path INSTALL sites (`concerns/production-flows.ts`):
 *   (1) escalation `populate()`  — `escalateToAllEpochs` after
 *       `await unwrapAllCommitteeKeysViaProduction(...)` (~:186).
 *   (2) self-heal `populate()`   — `ensureHolderPopulated` after the probe-driven
 *       rotation self-heal `await unwrapAllCommitteeKeysViaProduction(...)` (~:283).
 *   (3) single-live `set()`      — `ensureHolderPopulated` after
 *       `await unwrapCommitteeDataKeyViaProduction(...)` (~:330).
 *
 * THE FIX these tests force (security's specified design):
 *   - `committee-key-holder.ts`: a monotonic `#wipeGeneration` counter bumped
 *     inside `wipe()`, plus a read-only `wipeGeneration(): number`.
 *   - Each awaiting composition snapshots `gen = keyHolder.wipeGeneration()` at
 *     entry (before the fetch await) and, immediately BEFORE every install,
 *     re-checks `if (keyHolder.wipeGeneration() !== gen) return { status:
 *     'session_expiry' }` — do NOT resurrect.
 *   - CRITICAL: the discriminator is the monotonic COUNTER, NOT `isPopulated()`.
 *     The single-live `set()` case (test 3) starts from an EMPTY holder and is
 *     STILL empty right after the mid-await wipe, so `isPopulated()===false`
 *     cannot distinguish "never populated (legitimate)" from "wiped mid-await
 *     (must not resurrect)". Only the counter can.
 *
 * WHAT EACH RESURRECT TEST ASSERTS (both, after the op):
 *   (a) the holder is NOT resurrected — `isPopulated()===false` AND
 *       `hasLiveKey()===false`; and
 *   (b) the op fails closed to `session_expiry` — never `ok`, no decrypted data.
 *
 * DETERMINISM (no timers / no real network / no RNG assertions): the mid-await
 * wipe is injected SYNCHRONOUSLY from the mock T07 transport at the exact
 * disclosure op (`get_all_key_wraps` / `get_key_wrap`). The transport runs while
 * the composition is suspended on `await unwrap…ViaProduction(...)`, so the wipe
 * lands strictly BETWEEN fetch-start and the resuming install — no `queueMicrotask`
 * deferral needed (contrast the F-190 seal-await tests, whose injection point is a
 * synchronous `getDataKey()` and so must defer). A `WipeRecordingHolder`
 * determinism GUARD proves the wipe genuinely landed mid-fetch (pre-install) via
 * `wipeCalls` + `sizeBeforeLastWipe`, so no test can pass by timing luck. A
 * positive control (NORMAL op, no injected wipe) proves the latch does NOT break
 * the happy path (stays GREEN). Passes at any wall-clock time; each test owns its
 * fixtures.
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
  revealConcernSourceViaProduction
} from '../../src/lib/concerns';
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

function countOp(ops: string[], op: string): number {
  return ops.filter((o) => o === op).length;
}

/**
 * A `CommitteeKeyHolder` that RECORDS every `wipe()` — the determinism substrate
 * for F-VAL-1(b). `sizeBeforeLastWipe` is the holder's size at the moment the
 * wipe fired; combined with `wipeCalls` it proves the injected session-end wipe
 * landed MID-FETCH, before the resuming install:
 *   - `wipeCalls === 0`               → the wipe never fired (race not exercised).
 *   - `sizeBeforeLastWipe === <pre>`  → fired while the holder still held the
 *                                       pre-install key set (mid-await, correct).
 *   - `sizeBeforeLastWipe === <post>` → fired AFTER the install (bad injection).
 * The subclass keeps its OWN counter, independent of the production
 * `#wipeGeneration` the fix adds, so the guard works identically RED and GREEN.
 */
class WipeRecordingHolder extends CommitteeKeyHolder {
  wipeCalls = 0;
  sizeBeforeLastWipe = -1;
  override wipe(): void {
    this.sizeBeforeLastWipe = this.size();
    this.wipeCalls += 1;
    super.wipe();
  }
}

interface FakeKeyServer {
  liveKeyId: string;
  liveEpoch: number;
  actorHasWrap: boolean;
  liveWrap: Uint8Array | null;
  allWraps: Array<{ key_id: string; epoch: number; wrap: Uint8Array; is_live: boolean }> | null;
  /**
   * F-VAL-1(b) injection seam: fired SYNCHRONOUSLY inside the transport for each
   * disclosure op WHILE the composition is suspended on its fetch `await`. The
   * test wires this to a session-end wipe on the specific disclosure op whose
   * resuming install it wants to attack (`get_all_key_wraps` / `get_key_wrap`).
   */
  midFetchHook?: (op: string) => void;
}

function makeT07Transport(srv: FakeKeyServer): { transport: T07OpTransport; ops: string[] } {
  const ops: string[] = [];
  const transport: T07OpTransport = async (body) => {
    const op = String(body.op);
    ops.push(op);
    // Inject the mid-fetch wipe SYNCHRONOUSLY (before the response resolves) so it
    // lands inside the composition's `await unwrap…ViaProduction(...)` window,
    // strictly before the resuming populate()/set().
    srv.midFetchHook?.(op);
    if (op === 'committee_key_state') {
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
    if (op === 'get_key_wrap') {
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
    if (op === 'get_all_key_wraps') {
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
    throw new Error(`unexpected op ${op}`);
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
 * A FRESH signed-in session (EMPTY holder) after the committee rotated to
 * epoch-2. The member legitimately holds BOTH a retired epoch-1 wrap and the
 * live epoch-2 wrap; the single-live probe reports only the live epoch-2 key_id.
 * A read of an epoch-1-sealed row drives the read-loop escalation.
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
  const keyHolder = new WipeRecordingHolder();
  return { srv, t07, t07Client, localIdentity, keyHolder, retiredKey, liveKey, kp };
}

/** A fresh CURRENT-only session (drives the single-live `set()` install site). */
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
  const keyHolder = new WipeRecordingHolder();
  return { srv, t07, t07Client, localIdentity, keyHolder, liveKey, kp };
}

/**
 * A mid-SESSION already-populated holder cached at the STALE epoch-1 live key,
 * with the server rotated to epoch-2 (probe reports the newer key_id). The next
 * read drives the probe-driven rotation SELF-HEAL install site: demote stale live
 * (buffer retained) → `await unwrapAllCommitteeKeysViaProduction` → `populate()`.
 */
async function buildStaleThenRotatedSession() {
  const retiredKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const liveKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const localIdentity = silentStore();
  const kp = sodium.crypto_box_keypair();
  await localIdentity.storeIdentityPrivateKey(USER, kp.privateKey);

  const srv: FakeKeyServer = {
    liveKeyId: 'k-epoch-2', // probe reports the NEWER key_id → self-heal fires
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
  const keyHolder = new WipeRecordingHolder();
  // Cache the STALE epoch-1 as the current live key (this session's earlier probe).
  const staleBuf = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  keyHolder.set({ data_key: staleBuf, key_id: 'k-epoch-1', epoch: 1 });
  return { srv, t07, t07Client, localIdentity, keyHolder, retiredKey, liveKey, staleBuf, kp };
}

function concernRow(over: Partial<Record<string, unknown>> & { id: string }): Record<string, unknown> {
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

beforeEach(() => {
  __resetCapture();
  __setTestSink();
});

afterEach(() => {
  __resetCapture();
  vi.restoreAllMocks();
});

// ===========================================================================
// INSTALL SITE 1 — escalation populate() (`escalateToAllEpochs`, ~:186).
// A panic-wipe fired during the escalation `get_all_key_wraps` fetch must NOT be
// undone by the resuming populate(). Trigger: onPanicWipe (the data-destruction
// SAFETY feature the resurrection defeats).
// ===========================================================================
describe('F-VAL-1(b) / concerns — escalation populate() must not resurrect a mid-await panic-wipe', () => {
  it('a onPanicWipe() during the escalation `get_all_key_wraps` fetch leaves the holder EMPTY (not resurrected) and the list fails closed to session_expiry', async () => {
    const { srv, t07, t07Client, localIdentity, keyHolder, retiredKey } = await buildBaselineRotatedSession();

    // Panic-wipe the holder DURING the escalation disclosure fetch (mid-await).
    srv.midFetchHook = (op) => {
      if (op === 'get_all_key_wraps') keyHolder.onPanicWipe();
    };

    // One pre-rotation (epoch-1-sealed) row → forces the read-loop trialOpen miss
    // → `escalateToAllEpochs` → the attacked populate().
    const rows = [
      concernRow({
        id: 'c-pre',
        title_ct: sealHex('history-title', retiredKey),
        body_ct: sealHex('history-body', retiredKey),
        key_id: 'k-epoch-1'
      })
    ];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    });

    // Determinism GUARD — the panic-wipe genuinely landed MID-FETCH, before the
    // resuming populate(): exactly one wipe, and it fired while the holder still
    // held ONLY the single-live epoch-2 (size 1). A post-install wipe would record
    // size 2; a never-fired wipe records wipeCalls 0.
    expect(keyHolder.wipeCalls, 'race not exercised: the injected onPanicWipe() never fired').toBe(1);
    expect(
      keyHolder.sizeBeforeLastWipe,
      'the wipe did not land mid-fetch pre-install: expected the holder to still hold the single live key (size 1) when the escalation fetch wiped it'
    ).toBe(1);
    // The escalation disclosure fired exactly once (bounded), i.e. we truly hit
    // the attacked install site.
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);

    // (a) NOT resurrected — the escalation populate() must observe the bumped wipe
    // generation and refuse to re-install. CURRENT worktree: populate() re-installs
    // {epoch-1, epoch-2} → isPopulated()===true (RED).
    expect(
      keyHolder.isPopulated(),
      'F-VAL-1(b): the escalation populate() RESURRECTED the just-wiped key map — the mid-await panic-wipe was undone. wipe() must bump #wipeGeneration and escalateToAllEpochs must re-check it before populate() (do NOT resurrect).'
    ).toBe(false);
    expect(keyHolder.hasLiveKey(), 'F-VAL-1(b): a live key was resurrected after the panic-wipe').toBe(false);

    // (b) fail closed — no decrypted rows returned.
    expect(
      r.status,
      'F-VAL-1(b): a mid-await panic-wipe must fail the read CLOSED to session_expiry, not return decrypted concerns (CURRENT worktree returns `ok`)'
    ).toBe('session_expiry');
  });
});

// ===========================================================================
// INSTALL SITE 1 (reveal mirror) — the escalation populate() reached via
// `revealConcernSourceViaProduction`'s single-record escalate-on-miss.
// Trigger: onPanicWipe.
// ===========================================================================
describe('F-VAL-1(b) / concerns reveal mirror — escalation populate() must not resurrect a mid-await panic-wipe', () => {
  it('a onPanicWipe() during the reveal escalation `get_all_key_wraps` fetch leaves the holder EMPTY and the reveal fails closed to session_expiry (no source_name)', async () => {
    const { srv, t07, t07Client, localIdentity, keyHolder, retiredKey } = await buildBaselineRotatedSession();

    srv.midFetchHook = (op) => {
      if (op === 'get_all_key_wraps') keyHolder.onPanicWipe();
    };

    // The revealed source_name is sealed under the RETIRED epoch-1 → single-record
    // trialOpen miss → escalate → the attacked populate().
    const SOURCE = 'named-source-under-retired-epoch';
    const reveal = makeConcernTransport([
      { status: 200, body: { ok: true, data: { source_name_ct: sealHex(SOURCE, retiredKey) } } }
    ]);
    const concernClient = new SupabaseConcernClient({ transport: reveal.transport });

    const r = await revealConcernSourceViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'c-pre',
      passphrase: null
    });

    expect(keyHolder.wipeCalls, 'race not exercised: the injected onPanicWipe() never fired').toBe(1);
    expect(keyHolder.sizeBeforeLastWipe, 'the wipe did not land mid-fetch pre-install (expected size 1)').toBe(1);
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);

    expect(
      keyHolder.isPopulated(),
      'F-VAL-1(b) reveal: the escalation populate() RESURRECTED the just-wiped key map after a mid-await panic-wipe'
    ).toBe(false);
    expect(keyHolder.hasLiveKey()).toBe(false);
    expect(
      r.status,
      'F-VAL-1(b) reveal: a mid-await panic-wipe must fail closed to session_expiry, never return a decrypted source_name (CURRENT worktree returns `ok`)'
    ).toBe('session_expiry');
    // Belt-and-suspenders: no source_name plaintext smuggled through the result.
    expect(JSON.stringify(r)).not.toContain('named-source-under-retired-epoch');
  });
});

// ===========================================================================
// INSTALL SITE 2 — self-heal populate() (`ensureHolderPopulated` rotation
// self-heal, ~:283). A 401/session-revocation fired during the self-heal
// `get_all_key_wraps` fetch must NOT be undone by the resuming populate().
// Trigger: onSessionRevoked (the 401 class).
// ===========================================================================
describe('F-VAL-1(b) / concerns — self-heal populate() must not resurrect a mid-await session revocation', () => {
  it('a onSessionRevoked() during the self-heal `get_all_key_wraps` fetch leaves the holder EMPTY and the list fails closed to session_expiry', async () => {
    const { srv, t07, t07Client, localIdentity, keyHolder, liveKey } = await buildStaleThenRotatedSession();

    srv.midFetchHook = (op) => {
      if (op === 'get_all_key_wraps') keyHolder.onSessionRevoked();
    };

    // A live-epoch-2-sealed row so the CURRENT (buggy) worktree — which resurrects
    // then proceeds — would open it and return `ok`. The fix returns session_expiry
    // from ensureHolderPopulated before this row is ever fetched.
    const rows = [
      concernRow({
        id: 'c-live',
        title_ct: sealHex('live-title', liveKey),
        body_ct: sealHex('live-body', liveKey),
        key_id: 'k-epoch-2'
      })
    ];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    });

    // Determinism GUARD — the revocation landed MID-FETCH: exactly one wipe, fired
    // while the holder still held ONLY the demoted-but-retained stale epoch-1
    // (size 1). Post-install would record size 2.
    expect(keyHolder.wipeCalls, 'race not exercised: the injected onSessionRevoked() never fired').toBe(1);
    expect(
      keyHolder.sizeBeforeLastWipe,
      'the wipe did not land mid-fetch pre-install: expected the holder to still hold the retained stale epoch-1 (size 1) when the self-heal fetch wiped it'
    ).toBe(1);
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);

    // (a) NOT resurrected. CURRENT worktree: the self-heal populate() re-installs
    // {epoch-1, epoch-2} → isPopulated()===true, hasLiveKey()===true (RED).
    expect(
      keyHolder.isPopulated(),
      'F-VAL-1(b): the self-heal populate() RESURRECTED the just-wiped key map — the mid-await 401 wipe was undone. wipe() must bump #wipeGeneration and the self-heal must re-check it before populate() (do NOT resurrect).'
    ).toBe(false);
    expect(keyHolder.hasLiveKey()).toBe(false);

    // (b) fail closed.
    expect(
      r.status,
      'F-VAL-1(b): a mid-await 401 must fail the read CLOSED to session_expiry, not resurrect keys and return `ok`'
    ).toBe('session_expiry');
  });
});

// ===========================================================================
// INSTALL SITE 3 — single-live set() (`ensureHolderPopulated` lazy unwrap,
// ~:330). A page-unload fired during the single-live `get_key_wrap` fetch must
// NOT be undone by the resuming set(). This is the CRITICAL counter-not-
// isPopulated case: the holder is EMPTY before AND right after the wipe, so only
// the monotonic wipe-generation counter can distinguish it. Trigger: onPageUnload.
// ===========================================================================
describe('F-VAL-1(b) / concerns — single-live set() must not resurrect a mid-await page-unload (counter, not isPopulated)', () => {
  it('a onPageUnload() during the single-live `get_key_wrap` fetch leaves the holder EMPTY and the list fails closed to session_expiry', async () => {
    const { srv, t07, t07Client, localIdentity, keyHolder, liveKey } = await buildCurrentOnlySession();

    srv.midFetchHook = (op) => {
      if (op === 'get_key_wrap') keyHolder.onPageUnload();
    };

    const rows = [
      concernRow({
        id: 'c-cur',
        title_ct: sealHex('cur-title', liveKey),
        body_ct: sealHex('cur-body', liveKey),
        key_id: 'k-epoch-2'
      })
    ];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    });

    // Determinism GUARD — the unload landed MID-FETCH on an EMPTY holder: exactly
    // one wipe, size 0 at wipe time (fresh session). This is precisely why
    // `isPopulated()` cannot be the fix's discriminator (empty before AND after
    // the wipe) — the guard records the ordering via the counter instead.
    expect(keyHolder.wipeCalls, 'race not exercised: the injected onPageUnload() never fired').toBe(1);
    expect(
      keyHolder.sizeBeforeLastWipe,
      'the wipe did not land mid-fetch pre-install: expected an empty holder (size 0) when the single-live fetch wiped it'
    ).toBe(0);
    expect(countOp(t07.ops, 'get_key_wrap')).toBe(1);

    // (a) NOT resurrected. CURRENT worktree: set() installs the single live key →
    // isPopulated()===true (RED). The fix must re-check the bumped #wipeGeneration
    // before set() — NOT isPopulated(), which is false in BOTH the legitimate
    // never-populated and the wiped-mid-await cases.
    expect(
      keyHolder.isPopulated(),
      'F-VAL-1(b): the single-live set() RESURRECTED the key after a mid-await page-unload wipe. The discriminator MUST be the monotonic #wipeGeneration counter, NOT isPopulated() (which is false both when legitimately never-populated and when wiped mid-await).'
    ).toBe(false);
    expect(keyHolder.hasLiveKey()).toBe(false);

    // (b) fail closed.
    expect(
      r.status,
      'F-VAL-1(b): a mid-await page-unload must fail the read CLOSED to session_expiry, not resurrect the live key and return `ok`'
    ).toBe('session_expiry');
  });
});

// ===========================================================================
// POSITIVE CONTROLS — the latch must NOT break the happy path. A NORMAL read
// with NO mid-await wipe still installs the keys and returns `ok`. GREEN today,
// and MUST stay GREEN after the fix lands.
// ===========================================================================
describe('F-VAL-1(b) / concerns — positive controls (no mid-await wipe → normal install + ok) [PIN]', () => {
  it('escalation happy path: an epoch-1 row with NO mid-await wipe escalates, installs both epochs, and returns ok', async () => {
    const { t07, t07Client, localIdentity, keyHolder, retiredKey } = await buildBaselineRotatedSession();
    // No midFetchHook wired → no wipe during any fetch.

    const rows = [
      concernRow({
        id: 'c-pre',
        title_ct: sealHex('history-title', retiredKey),
        body_ct: sealHex('history-body', retiredKey),
        key_id: 'k-epoch-1'
      })
    ];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    });

    expect(keyHolder.wipeCalls, 'positive control must not wipe').toBe(0);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.title).toBe('history-title');
    expect(r.items[0]!.body).toBe('history-body');
    // The escalation genuinely installed the multi-epoch map (latch did not block it).
    expect(keyHolder.isPopulated()).toBe(true);
    expect(keyHolder.size()).toBeGreaterThanOrEqual(2);
    expect(keyHolder.getKeyId()).toBe('k-epoch-2');
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);
  });

  it('single-live happy path: a current-epoch row with NO mid-await wipe installs the live key and returns ok', async () => {
    const { t07, t07Client, localIdentity, keyHolder, liveKey } = await buildCurrentOnlySession();

    const rows = [
      concernRow({
        id: 'c-cur',
        title_ct: sealHex('cur-title', liveKey),
        body_ct: sealHex('cur-body', liveKey),
        key_id: 'k-epoch-2'
      })
    ];
    const concern = makeConcernTransport([{ status: 200, body: { ok: true, data: rows } }]);
    const concernClient = new SupabaseConcernClient({ transport: concern.transport });

    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id: USER
    });

    expect(keyHolder.wipeCalls, 'positive control must not wipe').toBe(0);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.items[0]!.title).toBe('cur-title');
    // The single-live set() genuinely installed the live key (latch did not block it).
    expect(keyHolder.isPopulated()).toBe(true);
    expect(keyHolder.hasLiveKey()).toBe(true);
    expect(keyHolder.getKeyId()).toBe('k-epoch-2');
    // Current-only read never escalates (no historical miss).
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(0);
  });
});
