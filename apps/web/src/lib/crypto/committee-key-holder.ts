/**
 * CommitteeKeyHolder — the SOLE owner of the session-resident plaintext
 * 32-byte committee data key (ADR-0027 Decision 1; threat-model §3.16
 * F-145 / F-146 / F-147 / F-148).
 *
 * Decision 1 dwell policy: the committee data key is unwrapped ONCE per
 * signed-in session (via `unwrapCommitteeDataKeyViaProduction`) into this
 * single in-process holder, reused for every seal/open in that session, and
 * wiped on every session-end trigger. NOT a fresh unwrap+zeroize per op.
 *
 * Invariants this module enforces:
 *   - **Heap-only (F-146).** The key lives ONLY in the JS heap. It is NEVER
 *     written to IndexedDB, localStorage, sessionStorage, a serializing Svelte
 *     store, a URL, or the audit meta. There is no `toJSON` / serializer; a
 *     naive `JSON.stringify(holder)` cannot reach the buffer because the field
 *     is held in a module-private closure-equivalent (a `#private` field), and
 *     even a structured-clone of the instance would not expose it as enumerable
 *     key bytes the leak-sweep recognizes.
 *   - **Single buffer by reference (F-145 / F-147).** `set()` stores the
 *     caller's exact `Uint8Array` — no copy. `getDataKey()` returns that same
 *     reference. There is exactly ONE buffer to wipe, so `wipe()`'s `.fill(0)`
 *     zeroizes the live key in place (and any other live reference to it, e.g.
 *     the one the composition returned). This is what makes the six-trigger
 *     wipe sufficient.
 *   - **Six wipe triggers (F-145).** Every session-end transition routes to
 *     `wipe()`, which `.fill(0)`s the buffer THEN nulls the reference. The
 *     triggers are: sign-out / 401 / panic-wipe / session-expiry / page-unload
 *     / observed-key-rotation. A 403 (rls_denied / rate-limit) is NOT a trigger
 *     (it is not a session event) — there is deliberately no `onForbidden` /
 *     `onRlsDenied` / `onRateLimited` method (AC-8).
 *   - **No key material in logs (F-148).** This module never `console.*`s nor
 *     emits the key through the structured logger.
 *
 * The panic-wipe ordering seam (`panicWipeWithCommitteeKeyHolder`) wipes the
 * holder BEFORE the WipeStore clears IndexedDB: the most sensitive in-memory
 * secret is zeroized first, so an interrupted wipe after the holder wipe but
 * before IndexedDB still leaves the live key at zero (F-145 ordering invariant).
 */

import { panicWipe, type PanicWipeResult } from '../lock/panic-wipe';
import type { WipeStore } from '../lock/wipe-store';

export interface CommitteeKeyEntry {
  data_key: Uint8Array;
  key_id: string;
  epoch: number;
}

export class CommitteeKeyHolder {
  // #private fields are NOT enumerable and are excluded from JSON.stringify —
  // the holder cannot accidentally serialize the key (F-146).
  #dataKey: Uint8Array | null = null;
  #keyId: string | null = null;
  #epoch: number | null = null;

  /**
   * Populate the holder with the freshly-unwrapped entry. The buffer is held
   * BY REFERENCE (not copied) so there is exactly one buffer to wipe
   * (F-145 / F-147 single-buffer invariant).
   */
  set(entry: CommitteeKeyEntry): void {
    this.#dataKey = entry.data_key;
    this.#keyId = entry.key_id;
    this.#epoch = entry.epoch;
  }

  isPopulated(): boolean {
    return this.#dataKey !== null;
  }

  /** The live by-reference key buffer, or null when empty. */
  getDataKey(): Uint8Array | null {
    return this.#dataKey;
  }

  getKeyId(): string | null {
    return this.#keyId;
  }

  getEpoch(): number | null {
    return this.#epoch;
  }

  /**
   * Zeroize the key buffer in place (`.fill(0)`) THEN null the reference.
   * Idempotent — a second wipe on an empty holder is a no-op. This is the sole
   * teardown primitive; every trigger routes here.
   */
  wipe(): void {
    if (this.#dataKey !== null) {
      this.#dataKey.fill(0);
    }
    this.#dataKey = null;
    this.#keyId = null;
    this.#epoch = null;
  }

  // -----------------------------------------------------------------------
  // The six mandatory wipe triggers (Decision 1 / F-145). Each routes to
  // wipe(). 403 is intentionally NOT a trigger (AC-8).
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

  /** Trigger 4 — mint-session JWT expiry; the next op re-unwraps. */
  onSessionExpiry(): void {
    this.wipe();
  }

  /** Trigger 5 — tab/window close (beforeunload / pagehide); best-effort. */
  onPageUnload(): void {
    this.wipe();
  }

  /**
   * Trigger 6 — observed key rotation (epoch advance). If a seal/open op or the
   * list probe observes a `key_id` NEWER than the cached one, wipe so the next
   * op re-unwraps under the new key (prevents sealing under a stale key — the
   * F-137 hazard). Observing the SAME key_id is a no-op (no spurious re-unwrap
   * churn).
   */
  onKeyRotationObserved(newKeyId: string): void {
    if (this.#keyId !== null && newKeyId !== this.#keyId) {
      this.wipe();
    }
  }
}

/**
 * Panic-wipe composition seam (Decision 1 / F-145 ordering invariant). Wipes
 * the committee-key holder BEFORE the WipeStore clears IndexedDB, so the most
 * sensitive in-memory secret is zeroized first: an interrupted wipe after the
 * holder wipe but before IndexedDB still leaves the live key at zero.
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
  // F-145 ordering: zeroize the live committee data key FIRST, before any
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
 * first access. Production code reads/populates this one instance; the six
 * triggers are wired against it by `wireSessionCommitteeKeyHolderTriggers`.
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
