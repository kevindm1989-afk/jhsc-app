/**
 * F182-2 — multi-epoch `CommitteeKeyHolder` + fail-closed trial-decrypt
 * (ADR-0030 Decision 6; threat-model §3.18 Amendment A-8.10, finding F-183 —
 * the anti-lockout keystone; HG-KEY-ROTATION scope).
 *
 * RED-FIRST (TDD). Written against the multi-epoch holder surface that does
 * NOT exist on `main` yet — the current `CommitteeKeyHolder`
 * (src/lib/crypto/committee-key-holder.ts) is a SINGLE-key holder that wipes
 * on epoch advance. Every multi-epoch test here calls `assertF182_2Surface()`
 * first, which throws a clear RED message until the implementer refactors the
 * holder to a `Map<key_id, { data_key, epoch, is_live }>` with the four new
 * methods (`populate` / `hasLiveKey` / `size` / `trialOpen`). The implementer
 * treats this file as READ-ONLY.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * CONTRACT UNDER TEST (the surface the implementer must satisfy)
 * ───────────────────────────────────────────────────────────────────────────
 *   interface CommitteeKeyMapEntry {
 *     data_key: Uint8Array;   // held BY REFERENCE (single buffer to wipe, F-147)
 *     key_id: string;
 *     epoch: number;
 *     is_live: boolean;       // exactly ONE entry may be is_live:true
 *   }
 *   class CommitteeKeyHolder {
 *     // MULTI-EPOCH (new, F182-2):
 *     populate(entries: ReadonlyArray<CommitteeKeyMapEntry>): void  // REPLACE the map
 *     size(): number                                                // # held keys
 *     hasLiveKey(): boolean                                         // is there an is_live entry?
 *     trialOpen<T>(open: (dataKey: Uint8Array) => Promise<T> | T):
 *       Promise<{ status:'ok'; value:T } | { status:'unavailable' }>
 *
 *     // BACKWARD-COMPAT (unchanged surface; live-key = the is_live entry):
 *     set(entry: { data_key; key_id; epoch }): void   // sets ONE live key
 *     isPopulated(): boolean                          // map non-empty
 *     getDataKey(): Uint8Array | null                 // the LIVE key, or null (seal gate)
 *     getKeyId(): string | null                       // the LIVE key_id, or null
 *     getEpoch(): number | null                       // the LIVE epoch, or null
 *     wipe(): void                                    // .fill(0) EVERY buffer, THEN clear
 *
 *     // FIVE session-end triggers still route to wipe() (F-145 survives the refactor):
 *     onSignOut / onSessionRevoked / onPanicWipe / onSessionExpiry / onPageUnload(): void
 *
 *     // trigger 6 CHANGES (ADR-0030 Decision 6.3; threat-model line 4150):
 *     onKeyRotationObserved(newKeyId: string): void   // ADD-and-redesignate, NOT wipe
 *   }
 *   // panic-wipe ordering seam still zeroizes the WHOLE map BEFORE IndexedDB.
 *   panicWipeWithCommitteeKeyHolder({ holder, store, surface? }): Promise<unknown>
 *
 * Hermetic: real libsodium (via concerns/seal `sealUtf8`/`openUtf8` — the exact
 * `crypto_secretbox_easy`/`crypto_secretbox_open_easy` primitive the six sealed
 * registers share); FIXED byte fixtures; a MemoryWipeStore for the panic seam;
 * the structured-log test sink. No real clock, no real network, no seeded RNG
 * (the seal nonce is random inside libsodium, so assertions are on the DECRYPT
 * round-trip / fail-closed outcome, never on raw ciphertext bytes).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TEST → A-8.10 KAT / FINDING MAP
 * ───────────────────────────────────────────────────────────────────────────
 *   KAT-1  F-183 keystone / TM line 4149 — a record sealed under epoch-N STILL
 *          opens after the holder also holds epoch N+1 (trial-decrypt finds N
 *          by MAC alone; NO epoch tag consulted).
 *   KAT-1b TM line 4150 — a NEW record seals under the LIVE (N+1) key, never a
 *          retired key.
 *   KAT-2  F-183 (iii) / TM line 4153 — sealed under N, only N+1 held ⇒ trial-
 *          decrypt FAILS CLOSED (typed unavailable, never wrong plaintext,
 *          never an uncaught throw).
 *   KAT-2p TM line 4153 counterfactual — the seal primitive is fail-closed
 *          (opening under the wrong key THROWS a MAC failure; the precondition
 *          trial-decrypt relies on — re-pass trigger #3).
 *   KAT-3  F-183 (ii) / TM line 4151 — the FIVE session-end triggers + explicit
 *          wipe() zeroize EVERY buffer in a multi-key map AND clear it.
 *   KAT-3b AC-8 carry-forward — a 403 (rls_denied) is NOT a wipe trigger over
 *          the map (no onForbidden/onRlsDenied/onRateLimited path).
 *   KAT-4  adversarial F182-1 handoff — EMPTY / all-retired (no is_live) holding
 *          state: no crash, seal fails CLOSED (no live key), reads still trial-
 *          decrypt over retired keys.
 *   KAT-5  backward-compat — set() (single-live-key) + multi-epoch populate both
 *          expose EXACTLY the is_live entry as the live/sealing key.
 *   KAT-6r F-183 anti-lockout / TM line 4150 — rotation is ADD-not-wipe: re-
 *          populate retains old-epoch readability; onKeyRotationObserved does
 *          NOT zeroize held read buffers.  [FLAGGED: trigger-6 semantics change
 *          — cross-cutting blast radius, see the file footer.]
 *   KAT-7  F-146 carry-forward — a MULTI-epoch map never serializes a data_key.
 *   KAT-8  F-148 carry-forward — a failed trial-decrypt leaks no key/plaintext
 *          bytes and carries no buffer in its typed failure.
 *   KAT-9  F-145 ordering — the panic seam zeroizes the WHOLE map BEFORE the
 *          IndexedDB clear.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitteeKeyHolder, panicWipeWithCommitteeKeyHolder } from '../../src/lib/crypto';
import { MemoryWipeStore } from '../../src/lib/lock/wipe-store';
import { sealUtf8, openUtf8 } from '../../src/lib/concerns/seal';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

// ---------------------------------------------------------------------------
// The multi-epoch surface (pinned as a TS interface so the contract is explicit
// and this file type-checks against the target; the REAL object lacks these
// methods on `main`, so `assertF182_2Surface` produces a clean runtime RED).
// ---------------------------------------------------------------------------
interface CommitteeKeyMapEntry {
  data_key: Uint8Array;
  key_id: string;
  epoch: number;
  is_live: boolean;
}
type TrialResult<T> = { status: 'ok'; value: T } | { status: 'unavailable' };
interface MultiEpochHolder {
  populate(entries: ReadonlyArray<CommitteeKeyMapEntry>): void;
  size(): number;
  hasLiveKey(): boolean;
  isPopulated(): boolean;
  getDataKey(): Uint8Array | null;
  getKeyId(): string | null;
  getEpoch(): number | null;
  set(entry: { data_key: Uint8Array; key_id: string; epoch: number }): void;
  wipe(): void;
  onSignOut(): void;
  onSessionRevoked(): void;
  onPanicWipe(): void;
  onSessionExpiry(): void;
  onPageUnload(): void;
  onKeyRotationObserved(newKeyId: string): void;
  trialOpen<T>(open: (dataKey: Uint8Array) => Promise<T> | T): Promise<TrialResult<T>>;
}

/** A fresh, deterministic 32-byte secretbox key (never shared — wipe() zeroes it). */
function mkKey(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function toHex(b: Uint8Array): string {
  let s = '';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
}

/**
 * RED gate. Until the implementer lands the F182-2 multi-epoch surface, this
 * throws a self-documenting failure so every multi-epoch KAT reports WHAT is
 * missing (diagnosability) rather than an opaque "x is not a function".
 */
function assertF182_2Surface(h: CommitteeKeyHolder): MultiEpochHolder {
  const rec = h as unknown as Record<string, unknown>;
  const missing = (['populate', 'trialOpen', 'hasLiveKey', 'size'] as const).filter(
    (m) => typeof rec[m] !== 'function'
  );
  if (missing.length > 0) {
    throw new Error(
      `RED (F182-2 not implemented): CommitteeKeyHolder is missing the multi-epoch ` +
        `surface [${missing.join(', ')}]. It is still the single-key holder ` +
        `(committee-key-holder.ts) — refactor it to a Map<key_id,{data_key,epoch,is_live}> ` +
        `with populate()/hasLiveKey()/size()/trialOpen() per ADR-0030 Decision 6.`
    );
  }
  return h as unknown as MultiEpochHolder;
}

/** A fresh real holder + its multi-epoch typed view (same instance). */
function mk(): { real: CommitteeKeyHolder; mh: MultiEpochHolder } {
  const real = new CommitteeKeyHolder();
  return { real, mh: assertF182_2Surface(real) };
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
// KAT-1 — multi-epoch open (the anti-lockout keystone). MUST be RED against
// the single-key / wipe-on-rotation holder (TM line 4149).
// ===========================================================================
describe('F182-2 KAT-1 — multi-epoch open (anti-lockout keystone, F-183)', () => {
  it('a record sealed under epoch-1 STILL opens after the holder also holds the LIVE epoch-2 key', async () => {
    const kE1 = mkKey(0x11);
    const kE2 = mkKey(0x22);
    const { mh } = mk();

    // A pre-rotation record, sealed under epoch-1 (which becomes RETIRED after
    // a rotation). Real libsodium secretbox (concerns/seal).
    const record = 'concern-body-filed-under-epoch-1';
    const ct1 = await sealUtf8(record, kE1);

    // Multi-epoch state after a rotation: epoch-1 RETAINED (is_live:false),
    // epoch-2 LIVE. This is exactly what get_all_committee_key_wraps_for_self
    // returns to a remaining member.
    mh.populate([
      { data_key: kE1, key_id: 'k-epoch-1', epoch: 1, is_live: false },
      { data_key: kE2, key_id: 'k-epoch-2', epoch: 2, is_live: true }
    ]);

    // Trial-decrypt finds the epoch-1 key by MAC success ALONE (no epoch tag is
    // passed to trialOpen — the ciphertext carries none). This FAILS against a
    // holder that wiped the old key on epoch advance.
    const opened = await mh.trialOpen((k) => openUtf8(ct1, k));
    expect(opened.status).toBe('ok');
    if (opened.status !== 'ok') return;
    expect(opened.value).toBe(record);
  });

  it('KAT-1b — a NEW record seals under the LIVE (epoch-2) key, never a retired key', async () => {
    const kE1 = mkKey(0x11);
    const kE2 = mkKey(0x22);
    const { mh } = mk();
    mh.populate([
      { data_key: kE1, key_id: 'k-epoch-1', epoch: 1, is_live: false },
      { data_key: kE2, key_id: 'k-epoch-2', epoch: 2, is_live: true }
    ]);

    // The live-key accessor returns EXACTLY the is_live entry (epoch-2), by ref.
    const live = mh.getDataKey();
    expect(live).toBe(kE2);
    expect(mh.getKeyId()).toBe('k-epoch-2');
    expect(mh.getEpoch()).toBe(2);

    const newRecord = 'concern-filed-after-rotation';
    const ctNew = await sealUtf8(newRecord, live as Uint8Array);
    // The new ciphertext opens under the LIVE key, and does NOT open under the
    // retired epoch-1 key — proof the seal used the live epoch only.
    await expect(openUtf8(ctNew, kE2)).resolves.toBe(newRecord);
    await expect(openUtf8(ctNew, kE1)).rejects.toThrow();
  });
});

// ===========================================================================
// KAT-2 — trial-decrypt fail-closed (F-183 iii / TM line 4153).
// ===========================================================================
describe('F182-2 KAT-2 — trial-decrypt fail-closed (F-183 iii)', () => {
  it('sealed under epoch-1, only epoch-2 held ⇒ typed unavailable (never wrong plaintext, never an uncaught throw)', async () => {
    const kE1 = mkKey(0x11);
    const kE2 = mkKey(0x22);
    const { mh } = mk();

    const secret = 'plaintext-only-epoch-1-can-yield';
    const ct1 = await sealUtf8(secret, kE1);

    // The holder holds ONLY the WRONG key (epoch-2). crypto_secretbox_open_easy
    // MUST fail the Poly1305 MAC, so the loop finds nothing.
    mh.populate([{ data_key: kE2, key_id: 'k-epoch-2', epoch: 2, is_live: true }]);

    let threw = false;
    let result: TrialResult<string> | undefined;
    try {
      result = await mh.trialOpen((k) => openUtf8(ct1, k));
    } catch {
      threw = true;
    }

    // (a) trial-decrypt NEVER lets the wrong-key throw escape uncaught.
    expect(threw).toBe(false);
    // (b) it returns a LOUD typed failure, not a silent success.
    expect(result?.status).toBe('unavailable');
    // (c) it NEVER surfaces a value from a wrong-key open (no silent wrong-data).
    if (result && result.status === 'ok') {
      expect.unreachable('trial-decrypt returned a value from a wrong-epoch key (silent mis-decrypt)');
    }
    // (d) the unavailable result carries no plaintext and no buffer.
    for (const v of Object.values((result ?? {}) as Record<string, unknown>)) {
      expect(v instanceof Uint8Array).toBe(false);
      expect(v).not.toBe(secret);
    }
  });

  it('KAT-2p — the seal primitive is fail-closed: opening under the WRONG key THROWS a MAC failure (trial-decrypt precondition, re-pass trigger #3)', async () => {
    // NOTE: this pins the load-bearing PRECONDITION and passes on `main` today
    // (it exercises only the shared seal primitive). It fails ONLY if the seal
    // primitive is ever swapped for a non-authenticated cipher — which is
    // exactly the counterfactual that would make trial-decrypt silently accept
    // a wrong key (F-183 iii / re-pass trigger #3).
    const kA = mkKey(0xaa);
    const kB = mkKey(0xbb);
    const ct = await sealUtf8('x', kA);
    await expect(openUtf8(ct, kB)).rejects.toThrow(); // wrong key ⇒ MAC failure
    await expect(openUtf8(ct, kA)).resolves.toBe('x'); // right key ⇒ round-trips
  });
});

// ===========================================================================
// KAT-3 — wipe EVERY buffer in the map (F-183 ii / TM line 4151). The FIVE
// session-end triggers + explicit wipe(). (Rotation is add-not-wipe: KAT-6r.)
// ===========================================================================
describe('F182-2 KAT-3 — wipe-every-buffer under the session-end triggers (F-183 ii)', () => {
  const sessionEndWipes: ReadonlyArray<[string, (h: MultiEpochHolder) => void]> = [
    ['onSignOut (trigger 1)', (h) => h.onSignOut()],
    ['onSessionRevoked / 401 (trigger 2)', (h) => h.onSessionRevoked()],
    ['onPanicWipe (trigger 3)', (h) => h.onPanicWipe()],
    ['onSessionExpiry (trigger 4)', (h) => h.onSessionExpiry()],
    ['onPageUnload (trigger 5)', (h) => h.onPageUnload()],
    ['wipe() (explicit teardown)', (h) => h.wipe()]
  ];

  for (const [name, fire] of sessionEndWipes) {
    it(`${name}: zeroizes EVERY buffer in a 3-epoch map (not just the live one) AND empties the map`, () => {
      const kE1 = mkKey(0x11);
      const kE2 = mkKey(0x22);
      const kE3 = mkKey(0x33);
      const { mh } = mk();
      mh.populate([
        { data_key: kE1, key_id: 'k-epoch-1', epoch: 1, is_live: false },
        { data_key: kE2, key_id: 'k-epoch-2', epoch: 2, is_live: false },
        { data_key: kE3, key_id: 'k-epoch-3', epoch: 3, is_live: true }
      ]);
      expect(mh.size()).toBe(3);
      for (const b of [kE1, kE2, kE3]) {
        expect(Array.from(b).some((x) => x !== 0)).toBe(true); // non-zero before
      }

      fire(mh);

      // EVERY held buffer is zeroized in place — not just the live one.
      for (const b of [kE1, kE2, kE3]) {
        expect(Array.from(b).every((x) => x === 0)).toBe(true);
      }
      // The map is emptied and no key_id→data_key entry survives a session-end.
      expect(mh.size()).toBe(0);
      expect(mh.isPopulated()).toBe(false);
      expect(mh.hasLiveKey()).toBe(false);
      expect(mh.getDataKey()).toBeNull();
      expect(mh.getKeyId()).toBeNull();
    });
  }

  it('KAT-3b — a 403 (rls_denied) is NOT a wipe trigger over the map: no onForbidden/onRlsDenied/onRateLimited, and the map is untouched', () => {
    const kE1 = mkKey(0x11);
    const kE2 = mkKey(0x22);
    const { real, mh } = mk();
    mh.populate([
      { data_key: kE1, key_id: 'k-epoch-1', epoch: 1, is_live: false },
      { data_key: kE2, key_id: 'k-epoch-2', epoch: 2, is_live: true }
    ]);

    const proto = Object.getPrototypeOf(real) as Record<string, unknown>;
    const methodNames = Object.getOwnPropertyNames(proto);
    expect(methodNames).not.toContain('onForbidden');
    expect(methodNames).not.toContain('onRlsDenied');
    expect(methodNames).not.toContain('onRateLimited');

    // Nothing about a 403 touched the map: both buffers stay live, size holds.
    expect(Array.from(kE1).some((b) => b !== 0)).toBe(true);
    expect(Array.from(kE2).some((b) => b !== 0)).toBe(true);
    expect(mh.size()).toBe(2);
    expect(mh.hasLiveKey()).toBe(true);
  });
});

// ===========================================================================
// KAT-4 — fail-closed holding state (adversarial F182-1 handoff). EMPTY or
// all-retired bundle: no crash, seal fails CLOSED, reads still trial-decrypt.
// ===========================================================================
describe('F182-2 KAT-4 — fail-closed holding state (purged / reactivated / mid-rotation)', () => {
  it('an EMPTY bundle ⇒ not populated, no live key, getDataKey null, trialOpen unavailable — never crashes', async () => {
    const { mh } = mk();
    expect(() => mh.populate([])).not.toThrow();
    expect(mh.isPopulated()).toBe(false);
    expect(mh.size()).toBe(0);
    expect(mh.hasLiveKey()).toBe(false);
    expect(mh.getDataKey()).toBeNull();
    expect(mh.getKeyId()).toBeNull();
    expect(mh.getEpoch()).toBeNull();

    // Reads over an empty holder fail closed (no keys to try), never throw.
    const ct = await sealUtf8('anything', mkKey(0x11));
    const r = await mh.trialOpen((k) => openUtf8(ct, k));
    expect(r.status).toBe('unavailable');
  });

  it('an all-retired bundle (NO is_live) ⇒ seal path fails CLOSED (no live key) but reads still trial-decrypt over the retired key', async () => {
    const kE1 = mkKey(0x11);
    const { mh } = mk();
    const oldRecord = 'record-filed-before-the-member-was-purged';
    const ct1 = await sealUtf8(oldRecord, kE1);

    // The holding state: the member holds only a retired-epoch wrap (e.g. a
    // reactivated member mid-window, or a co-chair between rotate and finalize).
    mh.populate([{ data_key: kE1, key_id: 'k-epoch-1', epoch: 1, is_live: false }]);

    // WRITE fails closed: there is NO live key, so the holder NEVER hands out a
    // retired key to seal with (never seals under a retired key).
    expect(mh.hasLiveKey()).toBe(false);
    expect(mh.getDataKey()).toBeNull();
    expect(mh.getKeyId()).toBeNull();
    // But key material IS held for READS.
    expect(mh.isPopulated()).toBe(true);
    expect(mh.size()).toBe(1);

    // READS still work — trial-decrypt over the retained retired key.
    const r = await mh.trialOpen((k) => openUtf8(ct1, k));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.value).toBe(oldRecord);
  });

  it('never throws a non-null-assertion when asked for the live key with no live key held (no `.find(...)!` crash)', () => {
    const { mh } = mk();
    mh.populate([{ data_key: mkKey(0x11), key_id: 'k-epoch-1', epoch: 1, is_live: false }]);
    expect(() => mh.getDataKey()).not.toThrow();
    expect(() => mh.getKeyId()).not.toThrow();
    expect(() => mh.getEpoch()).not.toThrow();
    expect(() => mh.hasLiveKey()).not.toThrow();
  });
});

// ===========================================================================
// KAT-5 — backward-compat live-key path (concerns/reprisal/committee consumers
// that request "the current key" via getDataKey()/getKeyId()).
// ===========================================================================
describe('F182-2 KAT-5 — backward-compat live-key accessor', () => {
  it('set() (the single-live-key API the consumers use after unwrap) still yields exactly that key as the live/sealing key', () => {
    const k = mkKey(0x55);
    const { mh } = mk();
    mh.set({ data_key: k, key_id: 'k-live-1', epoch: 3 });
    expect(mh.isPopulated()).toBe(true);
    expect(mh.hasLiveKey()).toBe(true);
    expect(mh.getDataKey()).toBe(k); // by reference (F-147 single buffer)
    expect(mh.getKeyId()).toBe('k-live-1');
    expect(mh.getEpoch()).toBe(3);
    expect(mh.size()).toBe(1);
  });

  it('after a multi-epoch populate, getDataKey()/getKeyId()/getEpoch() return EXACTLY the is_live entry (never a retired one)', () => {
    const kRetired = mkKey(0x11);
    const kLive = mkKey(0x22);
    const { mh } = mk();
    mh.populate([
      { data_key: kRetired, key_id: 'k-epoch-1', epoch: 1, is_live: false },
      { data_key: kLive, key_id: 'k-epoch-2', epoch: 2, is_live: true }
    ]);
    expect(mh.getDataKey()).toBe(kLive);
    expect(mh.getDataKey()).not.toBe(kRetired);
    expect(mh.getKeyId()).toBe('k-epoch-2');
    expect(mh.getEpoch()).toBe(2);
  });
});

// ===========================================================================
// KAT-6r — rotation is ADD-not-wipe (F-183 anti-lockout / TM line 4150). This
// CONTRASTS the single-key wipe-on-advance (committee-key-holder.ts:150-154).
//
// FLAGGED: onKeyRotationObserved's wipe→add change is cross-cutting — see the
// file footer for the blast radius (T08/T13b consumer tests rely on the old
// wipe semantics). This KAT pins the holder-unit target; the consumer-flow
// reconciliation is a separate F182-2 coordination item.
// ===========================================================================
describe('F182-2 KAT-6r — rotation is add-not-wipe (anti-lockout retention)', () => {
  it('re-populating after a rotation RETAINS old-epoch readability (pre-rotation record still opens; new records seal under the new live key)', async () => {
    const kE1 = mkKey(0x11);
    const { mh } = mk();
    const pre = 'record-filed-before-the-rotation';
    const ct1 = await sealUtf8(pre, kE1);

    // Session starts with epoch-1 live.
    mh.populate([{ data_key: kE1, key_id: 'k-epoch-1', epoch: 1, is_live: true }]);

    // A co-chair rotates elsewhere; the member re-fetches ALL wraps (old+new)
    // and re-populates. epoch-1 is now RETAINED (re-opened into a fresh buffer),
    // epoch-2 is the new LIVE key.
    const kE1b = mkKey(0x11); // same key bytes, re-opened from the retained wrap
    const kE2 = mkKey(0x22);
    mh.populate([
      { data_key: kE1b, key_id: 'k-epoch-1', epoch: 1, is_live: false },
      { data_key: kE2, key_id: 'k-epoch-2', epoch: 2, is_live: true }
    ]);

    // Anti-lockout: the pre-rotation record STILL opens.
    const r = await mh.trialOpen((k) => openUtf8(ct1, k));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.value).toBe(pre);

    // New writes seal under the NEW live key (epoch-2).
    expect(mh.getKeyId()).toBe('k-epoch-2');
    expect(mh.getDataKey()).toBe(kE2);
  });

  it('onKeyRotationObserved(newerKeyId) does NOT zeroize the held read buffers (contrast the single-key wipe-on-advance; retained for reads)', async () => {
    const kE1 = mkKey(0x11);
    const kE2 = mkKey(0x22);
    const { mh } = mk();
    const oldRecord = 'old-epoch-record-still-readable';
    const ct1 = await sealUtf8(oldRecord, kE1);
    mh.populate([
      { data_key: kE1, key_id: 'k-epoch-1', epoch: 1, is_live: false },
      { data_key: kE2, key_id: 'k-epoch-2', epoch: 2, is_live: true }
    ]);

    // A strictly-newer live key is observed (not yet held). Under F182-2 this
    // must NOT wipe the retained buffers (the single-key holder would zeroize).
    mh.onKeyRotationObserved('k-epoch-3');

    // The retained read buffers survive (anti-lockout).
    expect(Array.from(kE1).some((b) => b !== 0)).toBe(true);
    expect(Array.from(kE2).some((b) => b !== 0)).toBe(true);
    // Old data STILL reads via trial-decrypt.
    const r = await mh.trialOpen((k) => openUtf8(ct1, k));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.value).toBe(oldRecord);
  });
});

// ===========================================================================
// KAT-7 — no key material serialized over the MULTI-epoch map (F-146).
// ===========================================================================
describe('F182-2 KAT-7 — non-serialization over the multi-epoch map (F-146)', () => {
  it('JSON.stringify(holder) with a 2-epoch map exposes NO data_key bytes (the map is a #private field)', () => {
    const kE1 = mkKey(0x11);
    const kE2 = mkKey(0x22);
    const { real, mh } = mk();
    mh.populate([
      { data_key: kE1, key_id: 'k-epoch-1', epoch: 1, is_live: false },
      { data_key: kE2, key_id: 'k-epoch-2', epoch: 2, is_live: true }
    ]);

    const snapshot = JSON.stringify(real);
    // Neither key's hex nor its decimal index-object form may appear.
    for (const b of [kE1, kE2]) {
      expect(snapshot).not.toContain(toHex(b));
      expect(snapshot).not.toContain(Array.from(b).join(','));
    }
  });
});

// ===========================================================================
// KAT-8 — a failed trial-decrypt leaks no key/plaintext bytes (F-148).
// ===========================================================================
describe('F182-2 KAT-8 — failed trial-decrypt is loud-but-leak-free (F-148)', () => {
  it('all-keys-wrong ⇒ no key/plaintext bytes reach console.* or the structured log, and the typed failure carries no buffer', async () => {
    const errs: string[] = [];
    const warns: string[] = [];
    const logs: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      errs.push(a.map(String).join(' '));
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a) => {
      warns.push(a.map(String).join(' '));
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      logs.push(a.map(String).join(' '));
    });

    const kSealed = mkKey(0x11);
    const kHeldWrong = mkKey(0x22);
    const { mh } = mk();
    const secret = 'sensitive-plaintext-must-not-leak';
    const ct = await sealUtf8(secret, kSealed);
    mh.populate([{ data_key: kHeldWrong, key_id: 'k-epoch-2', epoch: 2, is_live: true }]);

    const r = await mh.trialOpen((k) => openUtf8(ct, k));
    expect(r.status).toBe('unavailable');

    const haystacks = [
      ...errs,
      ...warns,
      ...logs,
      ...__getCapturedLines().map((l) => JSON.stringify(l))
    ];
    for (const h of haystacks) {
      expect(h).not.toContain(toHex(kSealed));
      expect(h).not.toContain(toHex(kHeldWrong));
      expect(h).not.toContain(secret);
    }

    errSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });
});

// ===========================================================================
// KAT-9 — panic-wipe ordering over the WHOLE map (F-145 ordering invariant).
// ===========================================================================
describe('F182-2 KAT-9 — panic seam zeroizes the whole map BEFORE IndexedDB (F-145)', () => {
  it('wipes the WHOLE multi-epoch map BEFORE the WipeStore clears IndexedDB, and every buffer ends zero', async () => {
    const kE1 = mkKey(0x11);
    const kE2 = mkKey(0x22);
    const kE3 = mkKey(0x33);
    const { real, mh } = mk();
    mh.populate([
      { data_key: kE1, key_id: 'k-epoch-1', epoch: 1, is_live: false },
      { data_key: kE2, key_id: 'k-epoch-2', epoch: 2, is_live: false },
      { data_key: kE3, key_id: 'k-epoch-3', epoch: 3, is_live: true }
    ]);
    const store = new MemoryWipeStore();

    const order: string[] = [];
    // Spy that records order but CALLS THROUGH to the real multi-key wipe (so
    // this test exercises the genuine map zeroization, not a stand-in).
    const wipeSpy = vi.spyOn(real, 'wipe').mockImplementation(() => {
      order.push('holder.wipe');
      CommitteeKeyHolder.prototype.wipe.call(real);
    });
    const idbSpy = vi.spyOn(store, 'clearIndexedDb').mockImplementation(async () => {
      order.push('store.clearIndexedDb');
      return { ok: true, failed: [] as readonly string[] };
    });

    await panicWipeWithCommitteeKeyHolder({ holder: real, store, surface: 'lock_screen' });

    // Ordering: the most sensitive in-memory secret (the whole key map) is
    // zeroized FIRST — an interrupted wipe after the holder but before IndexedDB
    // still leaves every key at zero.
    expect(order).toContain('holder.wipe');
    expect(order).toContain('store.clearIndexedDb');
    expect(order.indexOf('holder.wipe')).toBeLessThan(order.indexOf('store.clearIndexedDb'));

    // Every buffer in the map is zero after the sequence; the map is empty.
    for (const b of [kE1, kE2, kE3]) {
      expect(Array.from(b).every((x) => x === 0)).toBe(true);
    }
    expect(mh.size()).toBe(0);
    expect(mh.isPopulated()).toBe(false);

    wipeSpy.mockRestore();
    idbSpy.mockRestore();
  });
});

// ===========================================================================
// FLAGGED — cross-cutting reconciliation (trigger-6 semantics change).
// ---------------------------------------------------------------------------
// F182-2 changes onKeyRotationObserved from WIPE (single-key stale-key self-
// heal) to ADD-not-wipe (multi-epoch retention). The following existing tests
// assert the OLD wipe semantics and WILL go RED when the holder is refactored;
// they are NOT edited here (test-writer does not silently rewrite them). The
// implementer/orchestrator must reconcile them as part of F182-2:
//   - apps/web/test/T07/phase2a-committee-key-holder.test.ts
//       (trigger-6 row in the wipe loop :136; AC-11 "newer key_id wipes" :175)
//   - apps/web/test/T08/phase2a-submit-concern-production.test.ts (AC-11)
//   - apps/web/test/T08/phase2a-reveal-source-production.test.ts (:492)
//   - apps/web/test/T13b/phase2b-stale-key-self-heal.test.ts (F-162 self-heal)
//   - apps/web/test/T07/phase2a-session-expiry-c1.test.ts
// See ADR-0030 Decision 6.3 + threat-model §3.18 line 4150 ("onKeyRotationObserved
// ADDS the new key and RE-DESIGNATES live, and does NOT wipe the retained key").
// ===========================================================================
