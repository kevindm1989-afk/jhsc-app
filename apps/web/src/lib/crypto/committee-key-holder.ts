/**
 * CommitteeKeyHolder — the SOLE owner of the session-resident plaintext
 * committee data key(s) (ADR-0027 Decision 1; ADR-0030 Decision 6;
 * threat-model §3.16 F-145 / F-146 / F-147 / F-148 and §3.18 A-8.10 F-183).
 *
 * ADR-0030 Decision 6 turned this from a SINGLE-key holder into a MULTI-EPOCH
 * key-map: `Map<key_id, { data_key, epoch, is_live }>` with a designated LIVE
 * key used for all sealing (writes) and trial-decrypt over every held key for
 * opening (reads). The change is what makes a committee-key rotation
 * anti-lockout: a member keeps opening data sealed under a rotated-out
 * (retired) epoch key because that epoch's key stays in the map.
 *
 * Dwell policy (Decision 1): the committee data key(s) are unwrapped ONCE per
 * signed-in session (via `unwrapCommitteeDataKeyViaProduction` for the single
 * live wrap, or `unwrapAllCommitteeKeysViaProduction` for the multi-epoch set)
 * into this in-process holder, reused for every seal/open in that session, and
 * wiped on every session-end trigger. NOT a fresh unwrap+zeroize per op.
 *
 * Invariants this module enforces:
 *   - **Heap-only (F-146).** The key material lives ONLY in the JS heap. It is
 *     NEVER written to IndexedDB, localStorage, sessionStorage, a serializing
 *     Svelte store, a URL, or the audit meta. The map is held in a `#private`
 *     field, so a naive `JSON.stringify(holder)` cannot reach any buffer and a
 *     structured-clone of the instance would not expose enumerable key bytes.
 *   - **Buffers by reference (F-145 / F-147).** `set()` / `populate()` store the
 *     caller's exact `Uint8Array`s — no copy. `getDataKey()` returns the LIVE
 *     buffer by reference. There is exactly one buffer per epoch to wipe, so
 *     `wipe()`'s `.fill(0)` zeroizes each held key in place (and any other live
 *     reference to it, e.g. the one a composition returned).
 *   - **Wipe EVERY buffer under the session-end triggers (F-145 / F-183 ii).**
 *     Each of the FIVE session-end transitions routes to `wipe()`, which
 *     `.fill(0)`s EVERY buffer in the map THEN clears it. The session-end
 *     triggers are: sign-out / 401 / panic-wipe / session-expiry / page-unload.
 *     A 403 (rls_denied / rate-limit) is NOT a trigger (it is not a session
 *     event) — there is deliberately no `onForbidden` / `onRlsDenied` /
 *     `onRateLimited` method (AC-8).
 *   - **Rotation is ADD-not-wipe (ADR-0030 Decision 6.3; A-8.10 line 4150 /
 *     A-8.10-R).** `onKeyRotationObserved` NEVER wipes the retained read keys on
 *     epoch advance. If the observed (AUTHORITATIVE) key is already HELD it
 *     re-designates it live; if it is NOT held it DEMOTES the current live key
 *     (clears `is_live` + nulls `#liveKeyId`, RETAINING the buffer for reads) so
 *     `hasLiveKey()`→false and the seal path fails CLOSED (F-183-R) while the
 *     caller re-fetches ALL wraps (`unwrapAllCommitteeKeysViaProduction`) and
 *     `populate()`s the new epoch. Per-row list hints route through the ADD-only
 *     `redesignateLiveIfHeld` (never demote — a row may carry an OLDER epoch's
 *     key_id). Either path RETAINS the prior epochs' keys for reads (anti-lockout).
 *   - **Fail-closed live-key gate.** `getDataKey()/getKeyId()/getEpoch()` return
 *     the `is_live` entry, or `null` when NO live key is held — so a holding
 *     state that carries only RETIRED keys (a purged/reactivated member
 *     mid-window, or a co-chair between rotate and finalize) never hands out a
 *     retired key to seal with. Reads still work over the retained keys via
 *     `trialOpen`.
 *   - **Trial-decrypt is fail-closed (F-183 iii).** `trialOpen` iterates the
 *     held keys; a wrong-key open THROWS (the shared seal primitive is
 *     `crypto_secretbox`/AEAD — a wrong key fails the Poly1305 MAC), the throw
 *     is treated as "not this key, try the next", the first success wins, and
 *     an all-keys-wrong open returns a typed `{ status: 'unavailable' }` — NEVER
 *     a wrong-key value, NEVER an uncaught throw. No epoch tag is consulted; the
 *     MAC is the sole authority.
 *   - **No key material in logs (F-148).** This module never `console.*`s nor
 *     emits key material through the structured logger.
 *
 * The panic-wipe ordering seam (`panicWipeWithCommitteeKeyHolder`) wipes the
 * holder BEFORE the WipeStore clears IndexedDB: the most sensitive in-memory
 * secret (the whole key map) is zeroized first, so an interrupted wipe after
 * the holder wipe but before IndexedDB still leaves every key at zero (F-145
 * ordering invariant).
 */

import { panicWipe, type PanicWipeResult } from '../lock/panic-wipe';
import type { WipeStore } from '../lock/wipe-store';

/** The single-live-key shape the back-compat `set()` API accepts. */
export interface CommitteeKeyEntry {
  data_key: Uint8Array;
  key_id: string;
  epoch: number;
}

/**
 * A multi-epoch map entry (ADR-0030 Decision 6). `data_key` is held BY
 * REFERENCE (single buffer to wipe, F-147). At most ONE entry across a populate
 * may be `is_live: true` (the designated sealing key).
 */
export interface CommitteeKeyMapEntry {
  data_key: Uint8Array;
  key_id: string;
  epoch: number;
  is_live: boolean;
}

/** The internal per-key record (data_key by reference; live flag mutable). */
interface HeldKey {
  data_key: Uint8Array;
  epoch: number;
  is_live: boolean;
}

/** Trial-decrypt outcome — a typed value, never a thrown exception (F-148). */
export type TrialOpenResult<T> = { status: 'ok'; value: T } | { status: 'unavailable' };

export class CommitteeKeyHolder {
  // #private fields are NOT enumerable and are excluded from JSON.stringify —
  // the holder cannot accidentally serialize key material (F-146).
  #keys: Map<string, HeldKey> = new Map();
  #liveKeyId: string | null = null;

  // -----------------------------------------------------------------------
  // Multi-epoch surface (ADR-0030 Decision 6 / F182-2)
  // -----------------------------------------------------------------------

  /**
   * REPLACE the key map with the freshly-unwrapped multi-epoch entries. Each
   * `data_key` is held BY REFERENCE (not copied) so there is exactly one buffer
   * per epoch to wipe (F-145 / F-147). At most one entry may be `is_live`; the
   * live entry is the designated sealing key. An empty array is a valid holding
   * state (no live key, no crash — F182-1 handoff).
   */
  populate(entries: ReadonlyArray<CommitteeKeyMapEntry>): void {
    const next = new Map<string, HeldKey>();
    let liveKeyId: string | null = null;
    for (const e of entries) {
      next.set(e.key_id, { data_key: e.data_key, epoch: e.epoch, is_live: e.is_live });
      if (e.is_live) liveKeyId = e.key_id;
    }
    this.#wipeOrphanedBuffers(next);
    this.#keys = next;
    this.#liveKeyId = liveKeyId;
  }

  /**
   * Zeroize (`.fill(0)`) every OUTGOING buffer that is NOT carried into `next`,
   * compared by OBJECT IDENTITY, BEFORE `this.#keys` is reassigned (F-145-C). A
   * bare reassign would orphan an evicted buffer un-wiped in the JS heap
   * (recoverable via heap dump / swap / core until GC), defeating the "zeroize
   * in place, never rely on GC" discipline (F-145). A re-installed SAME-reference
   * buffer (identity match — e.g. `wrapMemberInViaProduction`'s re-`set()` of the
   * live buffer) is retained, NEVER wiped out from under a live caller.
   */
  #wipeOrphanedBuffers(next: Map<string, HeldKey>): void {
    const carried = new Set<Uint8Array>();
    for (const entry of next.values()) carried.add(entry.data_key);
    for (const entry of this.#keys.values()) {
      if (!carried.has(entry.data_key)) entry.data_key.fill(0);
    }
  }

  /** The number of held keys across all epochs. */
  size(): number {
    return this.#keys.size;
  }

  /** Whether a designated LIVE (sealing) key is held. */
  hasLiveKey(): boolean {
    return this.#liveKeyId !== null && this.#keys.has(this.#liveKeyId);
  }

  /**
   * Trial-decrypt (F-183 iii, fail-closed). Iterate the held keys and hand each
   * `data_key` to `open`; the FIRST that succeeds wins. A wrong-key open THROWS
   * (the shared seal primitive is AEAD — a wrong key fails the MAC), the throw
   * is swallowed and the next key is tried. If NO held key authenticates, return
   * `{ status: 'unavailable' }` — never a wrong-key value, never an uncaught
   * throw, and the typed failure carries no key/plaintext bytes. No epoch tag is
   * consulted (the MAC is the sole authority). Newest epoch first so recent data
   * opens on the first try.
   */
  async trialOpen<T>(open: (dataKey: Uint8Array) => Promise<T> | T): Promise<TrialOpenResult<T>> {
    const held = Array.from(this.#keys.values()).sort((a, b) => b.epoch - a.epoch);
    for (const entry of held) {
      try {
        const value = await Promise.resolve(open(entry.data_key));
        return { status: 'ok', value };
      } catch {
        // Not this key (MAC failure / too-short input) — try the next. NEVER
        // surface the thrown error (it could carry buffer bytes, F-148).
      }
    }
    return { status: 'unavailable' };
  }

  // -----------------------------------------------------------------------
  // Backward-compatible single-live-key surface (unchanged contract)
  // -----------------------------------------------------------------------

  /**
   * Populate the holder with a SINGLE live entry (the single-live-wrap unwrap
   * path the concern/reprisal/committee consumers use). REPLACES the map with a
   * one-entry live map. The buffer is held BY REFERENCE (F-145 / F-147).
   */
  set(entry: CommitteeKeyEntry): void {
    const next = new Map<string, HeldKey>([
      [entry.key_id, { data_key: entry.data_key, epoch: entry.epoch, is_live: true }]
    ]);
    this.#wipeOrphanedBuffers(next);
    this.#keys = next;
    this.#liveKeyId = entry.key_id;
  }

  /** Whether the holder holds ANY key material (live or retired). */
  isPopulated(): boolean {
    return this.#keys.size > 0;
  }

  /**
   * The LIVE by-reference key buffer, or `null` when NO live key is held. A
   * retired-only holding state returns null here — the seal path fails CLOSED
   * (never seals under a retired key) while reads still work via `trialOpen`.
   */
  getDataKey(): Uint8Array | null {
    if (this.#liveKeyId === null) return null;
    return this.#keys.get(this.#liveKeyId)?.data_key ?? null;
  }

  /** The LIVE key_id, or `null` when no live key is held. */
  getKeyId(): string | null {
    if (this.#liveKeyId === null) return null;
    return this.#keys.has(this.#liveKeyId) ? this.#liveKeyId : null;
  }

  /** The LIVE epoch, or `null` when no live key is held. */
  getEpoch(): number | null {
    if (this.#liveKeyId === null) return null;
    return this.#keys.get(this.#liveKeyId)?.epoch ?? null;
  }

  /**
   * Zeroize EVERY buffer in the map (`.fill(0)`) THEN clear the map and null the
   * live designation. Idempotent — a second wipe on an empty holder is a no-op.
   * This is the sole teardown primitive; every session-end trigger routes here.
   */
  wipe(): void {
    for (const entry of this.#keys.values()) {
      entry.data_key.fill(0);
    }
    this.#keys.clear();
    this.#liveKeyId = null;
  }

  // -----------------------------------------------------------------------
  // The five session-end wipe triggers (Decision 1 / F-145). Each routes to
  // wipe(). 403 is intentionally NOT a trigger (AC-8). Trigger 6
  // (onKeyRotationObserved) is ADD-not-wipe (ADR-0030 Decision 6.3) — below.
  // -----------------------------------------------------------------------

  /** Trigger 1 — sign-out / clearJwt: the JWT-clear path wipes the holder. */
  onSignOut(): void {
    this.wipe();
  }

  /** Trigger 2 — session revocation / HTTP 401 (`onSessionRevoked`). */
  onSessionRevoked(): void {
    this.wipe();
  }

  /** Trigger 3 — panic-wipe (BrowserWipeStore). See the ordering seam below. */
  onPanicWipe(): void {
    this.wipe();
  }

  /**
   * Trigger 4 — mint-session JWT expiry; the next op re-unwraps.
   *
   * C1 design pin (threat-modeler PR1 carry-forward): trigger 4 collapses into
   * trigger 2 (401 → clearJwt → onSessionRevoked → wipe) within F-116's ≤5 s
   * budget. The mint-session JWT carries an expiry; once it passes, the next
   * Edge Function call returns HTTP 401 and the existing `onSessionRevoked` path
   * wipes the holder + clears the JWT. We deliberately do NOT schedule an
   * exp-timer in Phase 2a (one less moving piece, one fewer cross-tab race
   * surface to reason about); this method exists as a defensive
   * no-additional-state wipe so a future caller (a real exp-driven timer, a
   * server-pushed "your session is about to expire" hint, a test that wants to
   * force the path) can fire it without adding state. The collapse-into-401 path
   * is what the threat-modeler signed off on; an additive exp-timer can land
   * later without changing this contract.
   */
  onSessionExpiry(): void {
    this.wipe();
  }

  /** Trigger 5 — tab/window close (beforeunload / pagehide); best-effort. */
  onPageUnload(): void {
    this.wipe();
  }

  /**
   * Trigger 6 — observed key rotation (epoch advance). ADD-not-wipe (ADR-0030
   * Decision 6.3; threat-model §3.18 A-8.10 line 4150 / A-8.10-R). Contrast the
   * superseded single-key wipe-on-advance: the multi-epoch holder must NEVER
   * zeroize the retained read keys when a co-chair rotates elsewhere, or the
   * committee would be locked out of every pre-rotation record (the F-183
   * anti-lockout hazard). This is NOT a session-end trigger and NEVER wipes a
   * buffer.
   *
   * This method acts on the AUTHORITATIVE rotation signal (the probe's live
   * key_id, or a response-embedded key_id). Three cases:
   *   - observed key_id is ALREADY HELD → re-designate it as the live (sealing)
   *     key; the prior live entry is demoted to retired, buffer RETAINED.
   *   - observed key_id is NOT HELD → DEMOTE the current live key: clear its
   *     `is_live` flag and null `#liveKeyId`, RETAINING the buffer in the map for
   *     reads (F-183-R fail-closed seal gate). `hasLiveKey()`→false /
   *     `getDataKey()`→null, so a NEW record can never seal under the now-retired
   *     key; the caller re-fetches ALL wraps
   *     (`unwrapAllCommitteeKeysViaProduction`) and `populate()`s the new epoch.
   *   - observed key_id EQUALS the live key_id → the held branch re-designates it
   *     to itself: a no-op (no rotation, no churn).
   *
   * CAVEAT (A-8.10-R). Demote is correct ONLY for an AUTHORITATIVE key_id. This
   * method receives only a key_id (no epoch) so it cannot tell a NEWER key
   * (authoritative probe) from an OLDER one (a per-row hint on a pre-rotation
   * row). A per-row list hint MUST route through `redesignateLiveIfHeld`
   * (add-only, never demote), NOT here — else a stale row hint would wrongly
   * demote the live key.
   */
  onKeyRotationObserved(newKeyId: string): void {
    const entry = this.#keys.get(newKeyId);
    if (entry) {
      // HELD — re-designate the observed key live (add-not-wipe). Demote the
      // previous live entry's flag but RETAIN its buffer for reads.
      if (this.#liveKeyId !== null && this.#liveKeyId !== newKeyId) {
        const prevLive = this.#keys.get(this.#liveKeyId);
        if (prevLive) prevLive.is_live = false;
      }
      entry.is_live = true;
      this.#liveKeyId = newKeyId;
      return;
    }
    // NOT held — an authoritative rotation to a key we do not have. DEMOTE the
    // current live key (fail-closed seal gate) while RETAINING its buffer in the
    // map for reads (F-183-R). The caller re-populates ALL wraps under the new
    // epoch. NEVER a wipe.
    if (this.#liveKeyId !== null) {
      const prevLive = this.#keys.get(this.#liveKeyId);
      if (prevLive) prevLive.is_live = false;
      this.#liveKeyId = null;
    }
  }

  /**
   * Per-row key_id hint — ADD / re-designate ONLY, NEVER demote, and EPOCH-AWARE
   * (A-8.10-R / A-8.10-R2 F-183-R2). A list row may carry the key_id it was
   * sealed under; unlike the authoritative probe, a row hint can be an OLDER
   * epoch (a pre-rotation row), so it must NOT be allowed to move the live
   * designation onto anything but a STRICTLY-NEWER held epoch:
   *   - hinted key NOT held → pure no-op (no demote, no re-fetch).
   *   - NO current live entry (`#liveKeyId === null` — demoted / retired-only)
   *     → pure no-op that DEFERS to the authoritative probe
   *     (`onKeyRotationObserved`) to re-establish live. A list row is
   *     UNAUTHENTICATED for the "which epoch is live" designation, so it may
   *     re-designate among probe-blessed epochs but MUST NEVER bootstrap live out
   *     of the demoted state (fail-closed; same add-only-vs-authoritative split
   *     as `onKeyRotationObserved` :288-293, now enforced on the epoch axis).
   *   - hinted epoch EQUAL-or-OLDER than the current live epoch → pure no-op
   *     (no state change, no demote, no churn) — this is what stops a newest-first
   *     list's trailing pre-rotation row from demoting live to a RETIRED epoch.
   *   - hinted epoch STRICTLY GREATER than the current live epoch → re-designate
   *     it live (add-not-wipe, demoting the prior live's flag but retaining its
   *     buffer for reads). NEVER a wipe.
   */
  redesignateLiveIfHeld(keyId: string): void {
    const entry = this.#keys.get(keyId);
    if (!entry) return; // not held — a row hint never demotes / re-fetches.
    // Fail-closed: with no current live entry, a row hint may not bootstrap live
    // out of the demoted state — only the authoritative probe can (F-183-R2).
    if (this.#liveKeyId === null) return;
    const liveEpoch = this.#keys.get(this.#liveKeyId)?.epoch;
    // Promote ONLY on a STRICTLY-NEWER epoch; equal/older is a pure no-op.
    if (liveEpoch === undefined || entry.epoch <= liveEpoch) return;
    if (this.#liveKeyId !== keyId) {
      const prevLive = this.#keys.get(this.#liveKeyId);
      if (prevLive) prevLive.is_live = false;
    }
    entry.is_live = true;
    this.#liveKeyId = keyId;
  }
}

/**
 * Panic-wipe composition seam (Decision 1 / F-145 ordering invariant). Wipes
 * the committee-key holder BEFORE the WipeStore clears IndexedDB, so the most
 * sensitive in-memory secret (the whole multi-epoch key map) is zeroized first:
 * an interrupted wipe after the holder wipe but before IndexedDB still leaves
 * every key at zero.
 *
 * Routes through the existing `panicWipe()` library (which preserves the F-53
 * audit-before-side-effect contract); this seam only prepends the
 * holder.wipe() step. The holder wipe is best-effort and never blocks the
 * panic-wipe (a panic must always proceed to destroy device state).
 */
export async function panicWipeWithCommitteeKeyHolder(opts: {
  holder: CommitteeKeyHolder;
  store: WipeStore;
  surface?: 'settings' | 'lock_screen';
}): Promise<PanicWipeResult> {
  // F-145 ordering: zeroize the whole committee key map FIRST, before any
  // IndexedDB / Cache / storage clear runs.
  opts.holder.onPanicWipe();
  const wipeOpts: { store: WipeStore; surface?: 'settings' | 'lock_screen' } = {
    store: opts.store
  };
  if (opts.surface) wipeOpts.surface = opts.surface;
  return panicWipe(wipeOpts);
}

// ---------------------------------------------------------------------------
// Session-scoped singleton (Decision 1: ONE holder per signed-in session).
// ---------------------------------------------------------------------------

let __sessionHolder: CommitteeKeyHolder | null = null;

/**
 * The session-scoped singleton holder (Decision 1: a single module-scoped
 * holder per signed-in session, reused for every seal/open). Lazily created on
 * first access. Production code reads/populates this one instance.
 */
export function getSessionCommitteeKeyHolder(): CommitteeKeyHolder {
  if (!__sessionHolder) __sessionHolder = new CommitteeKeyHolder();
  return __sessionHolder;
}

/** Test-only — reset the session singleton between tests. */
export function __resetSessionCommitteeKeyHolderForTest(): void {
  if (__sessionHolder) __sessionHolder.wipe();
  __sessionHolder = null;
}
