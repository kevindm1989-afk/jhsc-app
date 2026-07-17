/**
 * F-VAL-1(b) — wipe-then-resurrect key-lifecycle gap, REPRISAL read mirror
 * (threat-model §3.18 F-183-B CLOSURE / F-VAL-1(b) ruling,
 * `.context/threat-model.md` ~:4631-4635; security-reviewer specified the
 * wipe-generation latch fix). Mirror of `test/T08/phase2a-fval1b-wipe-then-
 * resurrect.test.ts` on `readReprisalViaProduction`.
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY; do not relax
 * the assertions.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE DEFECT (confirmed on this worktree — reprisal read path)
 * ───────────────────────────────────────────────────────────────────────────
 * A panic-wipe / 401 / page-unload firing DURING `readReprisalViaProduction`'s
 * disclosure fetch `await` empties the holder via `wipe()`. The fetch resolves
 * and the composition RE-INSTALLS the keys (`populate()` / `set()`), RESURRECTING
 * the just-wiped key map. `wipe()` sets no latch; `populate()` / `set()` check
 * none. The resurrected keys persist until the next wipe trigger — defeating
 * panic-wipe, a data-destruction SAFETY feature.
 *
 * The three reprisal read-path INSTALL sites (`reprisal/production-flows.ts`):
 *   (1) escalation `populate()`  — `escalateToAllEpochs` after
 *       `await unwrapAllCommitteeKeysViaProduction(...)` (~:184).
 *   (2) self-heal `populate()`   — `ensureHolderPopulated` after the probe-driven
 *       rotation self-heal `await unwrapAllCommitteeKeysViaProduction(...)` (~:275).
 *   (3) single-live `set()`      — `ensureHolderPopulated` after
 *       `await unwrapCommitteeDataKeyViaProduction(...)` (~:317).
 *
 * THE FIX these tests force (security's specified design): a monotonic
 * `#wipeGeneration` counter bumped inside `committee-key-holder.ts`'s `wipe()`
 * plus a read-only `wipeGeneration()`; each awaiting composition snapshots the
 * generation at entry and re-checks it immediately BEFORE every install,
 * returning `{ status: 'session_expiry' }` on a mismatch (do NOT resurrect). The
 * discriminator MUST be the monotonic COUNTER — the single-live `set()` case
 * (test 3) is empty before AND after the mid-await wipe, so `isPopulated()` can
 * never distinguish it.
 *
 * WHAT EACH RESURRECT TEST ASSERTS (both, after the op):
 *   (a) `isPopulated()===false` AND `hasLiveKey()===false` (NOT resurrected); and
 *   (b) the op returns `session_expiry` — never `ok`, no decrypted title/body.
 *
 * DETERMINISM: the mid-await wipe is injected SYNCHRONOUSLY from the mock T07
 * transport at the exact disclosure op, so it lands strictly BETWEEN fetch-start
 * and the resuming install (no timers / no real network / no RNG assertions). A
 * `WipeRecordingHolder` guard proves the wipe landed mid-fetch (pre-install). A
 * positive control (NORMAL read, no injected wipe) proves the latch does not
 * break the happy path (stays GREEN). Each test owns its fixtures.
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

function countOp(ops: string[], op: string): number {
  return ops.filter((o) => o === op).length;
}

/**
 * A `CommitteeKeyHolder` that RECORDS every `wipe()` — the determinism substrate.
 * `sizeBeforeLastWipe` is the holder size at wipe time; with `wipeCalls` it proves
 * the injected session-end wipe landed MID-FETCH (pre-install), never after the
 * install and never not-at-all. Keeps its OWN counter, independent of the
 * production `#wipeGeneration` the fix adds, so the guard reads identically RED
 * and GREEN.
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
  /** Fired SYNCHRONOUSLY inside the transport for each disclosure op WHILE the
   * composition is suspended on its fetch `await` (the F-VAL-1(b) injection seam). */
  midFetchHook?: (op: string) => void;
}

function makeT07Transport(srv: FakeKeyServer): { transport: T07OpTransport; ops: string[] } {
  const ops: string[] = [];
  const transport: T07OpTransport = async (body) => {
    const op = String(body.op);
    ops.push(op);
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

/** FRESH session (EMPTY holder) after a rotation to epoch-2; member holds retired
 * epoch-1 + live epoch-2. A record sealed under epoch-1 drives the escalation. */
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

/** FRESH CURRENT-only session (drives the single-live `set()` install site). */
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

/** Mid-SESSION holder cached at the STALE epoch-1 live key; server rotated to
 * epoch-2 (probe reports the newer key_id) → drives the self-heal `populate()`. */
async function buildStaleThenRotatedSession() {
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
  const staleBuf = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  keyHolder.set({ data_key: staleBuf, key_id: 'k-epoch-1', epoch: 1 });
  return { srv, t07, t07Client, localIdentity, keyHolder, retiredKey, liveKey, staleBuf, kp };
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
// INSTALL SITE 1 — escalation populate() (reprisal `escalateToAllEpochs`).
// Trigger: onPanicWipe.
// ===========================================================================
describe('F-VAL-1(b) / reprisal — escalation populate() must not resurrect a mid-await panic-wipe', () => {
  it('a onPanicWipe() during the escalation `get_all_key_wraps` fetch leaves the holder EMPTY and the read fails closed to session_expiry (no title/body)', async () => {
    const { srv, t07, t07Client, localIdentity, keyHolder, retiredKey } = await buildBaselineRotatedSession();

    srv.midFetchHook = (op) => {
      if (op === 'get_all_key_wraps') keyHolder.onPanicWipe();
    };

    // A record sealed under the RETIRED epoch-1 → single-record trialOpen miss →
    // escalate → the attacked populate().
    const TITLE = 'reprisal-title-under-retired-epoch';
    const BODY = 'reprisal-body-under-retired-epoch';
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { title_ct: sealHex(TITLE, retiredKey), body_ct: sealHex(BODY, retiredKey) } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-pre',
      passphrase: null
    });

    // Determinism GUARD — mid-fetch, pre-install: one wipe, fired while the holder
    // still held ONLY the single-live epoch-2 (size 1).
    expect(keyHolder.wipeCalls, 'race not exercised: the injected onPanicWipe() never fired').toBe(1);
    expect(keyHolder.sizeBeforeLastWipe, 'the wipe did not land mid-fetch pre-install (expected size 1)').toBe(1);
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);

    // (a) NOT resurrected. CURRENT worktree: populate() re-installs → isPopulated true (RED).
    expect(
      keyHolder.isPopulated(),
      'F-VAL-1(b) reprisal: the escalation populate() RESURRECTED the just-wiped key map after a mid-await panic-wipe. wipe() must bump #wipeGeneration and escalateToAllEpochs must re-check it before populate().'
    ).toBe(false);
    expect(keyHolder.hasLiveKey()).toBe(false);

    // (b) fail closed — no decrypted title/body.
    expect(
      r.status,
      'F-VAL-1(b) reprisal: a mid-await panic-wipe must fail the read CLOSED to session_expiry, not return decrypted title/body (CURRENT worktree returns `ok`)'
    ).toBe('session_expiry');
    expect(JSON.stringify(r)).not.toContain(TITLE);
    expect(JSON.stringify(r)).not.toContain(BODY);
  });
});

// ===========================================================================
// INSTALL SITE 2 — self-heal populate() (reprisal rotation self-heal).
// Trigger: onSessionRevoked (the 401 class).
// ===========================================================================
describe('F-VAL-1(b) / reprisal — self-heal populate() must not resurrect a mid-await session revocation', () => {
  it('a onSessionRevoked() during the self-heal `get_all_key_wraps` fetch leaves the holder EMPTY and the read fails closed to session_expiry', async () => {
    const { srv, t07, t07Client, localIdentity, keyHolder, liveKey } = await buildStaleThenRotatedSession();

    srv.midFetchHook = (op) => {
      if (op === 'get_all_key_wraps') keyHolder.onSessionRevoked();
    };

    // A live-epoch-2-sealed record so the CURRENT (buggy) worktree — which
    // resurrects then proceeds — would open it and return `ok`. The fix returns
    // session_expiry from ensureHolderPopulated before this record is ever opened.
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { title_ct: sealHex('live-title', liveKey), body_ct: sealHex('live-body', liveKey) } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-live',
      passphrase: null
    });

    // Determinism GUARD — mid-fetch, pre-install: one wipe, fired while the holder
    // still held ONLY the demoted-but-retained stale epoch-1 (size 1).
    expect(keyHolder.wipeCalls, 'race not exercised: the injected onSessionRevoked() never fired').toBe(1);
    expect(keyHolder.sizeBeforeLastWipe, 'the wipe did not land mid-fetch pre-install (expected size 1)').toBe(1);
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);

    // (a) NOT resurrected. CURRENT worktree: self-heal populate() re-installs → isPopulated true (RED).
    expect(
      keyHolder.isPopulated(),
      'F-VAL-1(b) reprisal: the self-heal populate() RESURRECTED the just-wiped key map after a mid-await 401. wipe() must bump #wipeGeneration and the self-heal must re-check it before populate().'
    ).toBe(false);
    expect(keyHolder.hasLiveKey()).toBe(false);

    // (b) fail closed.
    expect(
      r.status,
      'F-VAL-1(b) reprisal: a mid-await 401 must fail the read CLOSED to session_expiry, not resurrect keys and return `ok`'
    ).toBe('session_expiry');
  });
});

// ===========================================================================
// INSTALL SITE 3 — single-live set() (reprisal lazy unwrap). The CRITICAL
// counter-not-isPopulated case (empty before AND after the wipe).
// Trigger: onPageUnload.
// ===========================================================================
describe('F-VAL-1(b) / reprisal — single-live set() must not resurrect a mid-await page-unload (counter, not isPopulated)', () => {
  it('a onPageUnload() during the single-live `get_key_wrap` fetch leaves the holder EMPTY and the read fails closed to session_expiry', async () => {
    const { srv, t07, t07Client, localIdentity, keyHolder, liveKey } = await buildCurrentOnlySession();

    srv.midFetchHook = (op) => {
      if (op === 'get_key_wrap') keyHolder.onPageUnload();
    };

    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { title_ct: sealHex('cur-title', liveKey), body_ct: sealHex('cur-body', liveKey) } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-cur',
      passphrase: null
    });

    // Determinism GUARD — mid-fetch on an EMPTY holder (size 0). This is exactly
    // why `isPopulated()` cannot be the fix's discriminator: it is false both when
    // legitimately never-populated and when wiped mid-await. The counter records it.
    expect(keyHolder.wipeCalls, 'race not exercised: the injected onPageUnload() never fired').toBe(1);
    expect(keyHolder.sizeBeforeLastWipe, 'the wipe did not land mid-fetch pre-install (expected an empty holder, size 0)').toBe(0);
    expect(countOp(t07.ops, 'get_key_wrap')).toBe(1);

    // (a) NOT resurrected. CURRENT worktree: set() installs the live key → isPopulated true (RED).
    expect(
      keyHolder.isPopulated(),
      'F-VAL-1(b) reprisal: the single-live set() RESURRECTED the key after a mid-await page-unload. The discriminator MUST be the monotonic #wipeGeneration counter, NOT isPopulated() (false both when never-populated and when wiped mid-await).'
    ).toBe(false);
    expect(keyHolder.hasLiveKey()).toBe(false);

    // (b) fail closed.
    expect(
      r.status,
      'F-VAL-1(b) reprisal: a mid-await page-unload must fail the read CLOSED to session_expiry, not resurrect the live key and return `ok`'
    ).toBe('session_expiry');
  });
});

// ===========================================================================
// POSITIVE CONTROLS — the latch must NOT break the happy path. GREEN today,
// MUST stay GREEN after the fix.
// ===========================================================================
describe('F-VAL-1(b) / reprisal — positive controls (no mid-await wipe → normal install + ok) [PIN]', () => {
  it('escalation happy path: an epoch-1 record with NO mid-await wipe escalates, installs both epochs, and returns ok', async () => {
    const { t07, t07Client, localIdentity, keyHolder, retiredKey } = await buildBaselineRotatedSession();
    // No midFetchHook wired.

    const TITLE = 'reprisal-title-under-retired-epoch';
    const BODY = 'reprisal-body-under-retired-epoch';
    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { title_ct: sealHex(TITLE, retiredKey), body_ct: sealHex(BODY, retiredKey) } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-pre',
      passphrase: null
    });

    expect(keyHolder.wipeCalls, 'positive control must not wipe').toBe(0);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.title).toBe(TITLE);
    expect(r.body).toBe(BODY);
    expect(keyHolder.isPopulated()).toBe(true);
    expect(keyHolder.size()).toBeGreaterThanOrEqual(2);
    expect(keyHolder.getKeyId()).toBe('k-epoch-2');
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(1);
  });

  it('single-live happy path: a current-epoch record with NO mid-await wipe installs the live key and returns ok', async () => {
    const { t07, t07Client, localIdentity, keyHolder, liveKey } = await buildCurrentOnlySession();

    const reprisal = makeReprisalTransport([
      { status: 200, body: { ok: true, data: { title_ct: sealHex('cur-title', liveKey), body_ct: sealHex('cur-body', liveKey) } } }
    ]);
    const reprisalClient = new SupabaseReprisalClient({ transport: reprisal.transport });

    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id: USER,
      id: 'r-cur',
      passphrase: null
    });

    expect(keyHolder.wipeCalls, 'positive control must not wipe').toBe(0);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.title).toBe('cur-title');
    expect(keyHolder.isPopulated()).toBe(true);
    expect(keyHolder.hasLiveKey()).toBe(true);
    expect(keyHolder.getKeyId()).toBe('k-epoch-2');
    expect(countOp(t07.ops, 'get_all_key_wraps')).toBe(0);
  });
});
