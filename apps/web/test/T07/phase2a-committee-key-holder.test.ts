/**
 * Phase 2a PR1 — `CommitteeKeyHolder` (ADR-0027 Decision 1; threat-model
 * §3.16 F-145 / F-146 / F-148). RED-FIRST (TDD): written against a module
 * that does NOT exist yet. The file MUST fail at import/binding time until
 * the implementer adds `src/lib/crypto/committee-key-holder.ts` and
 * re-exports its surface from `src/lib/crypto`. The implementer treats this
 * file as READ-ONLY.
 *
 * The holder is the SOLE owner of the session-resident plaintext 32-byte
 * committee data key. It is heap-only (never serialized) and is wiped on
 * SIX mandatory triggers, each `.fill(0)`-zeroizing the single by-reference
 * buffer and nulling the holder.
 *
 * Surface under test (the contract the implementer must satisfy):
 *   class CommitteeKeyHolder {
 *     set(entry: { data_key: Uint8Array; key_id: string; epoch: number }): void
 *     isPopulated(): boolean
 *     getDataKey(): Uint8Array | null   // the live by-reference buffer
 *     getKeyId(): string | null
 *     getEpoch(): number | null
 *     wipe(): void                      // .fill(0) the buffer, then null
 *     // the six wipe triggers — every one routes to wipe():
 *     onSignOut(): void                 // trigger 1 (clearJwt / sign-out)
 *     onSessionRevoked(): void          // trigger 2 (HTTP 401)
 *     onPanicWipe(): void               // trigger 3 (BrowserWipeStore)
 *     onSessionExpiry(): void           // trigger 4 (mint-session expiry)
 *     onPageUnload(): void              // trigger 5 (beforeunload/pagehide)
 *     onKeyRotationObserved(newKeyId: string): void  // trigger 6 (epoch advance)
 *   }
 *   // panic-wipe ordering seam (Decision 1 / F-145): MUST wipe the holder
 *   // BEFORE the WipeStore clears IndexedDB.
 *   panicWipeWithCommitteeKeyHolder(opts: {
 *     holder: CommitteeKeyHolder;
 *     store: WipeStore;
 *     surface?: 'settings' | 'lock_screen';
 *   }): Promise<unknown>
 *
 * Hermetic: real libsodium (only to mint a realistic 32-byte key), a
 * MemoryWipeStore from the lock module for the panic-wipe ordering test, the
 * structured-log test sink, real sessionStorage/localStorage (jsdom). No
 * real clock, no real network.
 *
 * ───────────────────────────────────────────────────────────────────────
 * TEST → AC / FINDING MAP
 * ───────────────────────────────────────────────────────────────────────
 *   AC-8 / F-145 — each of the SIX triggers .fill(0)-zeroizes the EXACT
 *                  buffer and nulls the holder (six assertions).
 *   AC-8 / F-145 — single-buffer-by-reference: the buffer the holder exposes
 *                  IS the buffer passed in; wiping it zeros that same array.
 *   AC-8 / F-145 — panic-wipe ordering: holder.wipe() happens-before the
 *                  WipeStore clears IndexedDB (ordering spy).
 *   F-146 / AC-9 — no serialization: the 32 key bytes never appear in
 *                  sessionStorage / localStorage / a JSON snapshot / a URL.
 *   F-148 / AC-9 — set+wipe leaks no key bytes to console.* / structured log.
 *   AC-11        — rotation-observed wipe drops the stale key so a re-unwrap
 *                  is forced (no seal/open under the stale epoch).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import { MemoryWipeStore } from '../../src/lib/lock/wipe-store';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';
// RED-FIRST: these imports do not resolve yet — the implementer adds the
// module + re-exports. Importing them here pins the public surface.
import {
  CommitteeKeyHolder,
  panicWipeWithCommitteeKeyHolder
} from '../../src/lib/crypto';

await _sodium.ready;
const sodium = _sodium;

function freshKey(): Uint8Array {
  return sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
}

function populated(): { holder: CommitteeKeyHolder; key: Uint8Array } {
  const holder = new CommitteeKeyHolder();
  const key = freshKey();
  holder.set({ data_key: key, key_id: 'k-live-1', epoch: 3 });
  return { holder, key };
}

beforeEach(() => {
  __resetCapture();
  __setTestSink();
  // Each test owns its storage — start clean (no shared mutable state).
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

afterEach(() => {
  __resetCapture();
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  if (typeof localStorage !== 'undefined') localStorage.clear();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Populate + single-buffer-by-reference (F-145 / F-147)
// ---------------------------------------------------------------------------

describe('CommitteeKeyHolder — populate + single buffer (F-145 / F-147)', () => {
  it('caches the entry and exposes the SAME buffer that was set (by reference, not a copy)', () => {
    const { holder, key } = populated();
    expect(holder.isPopulated()).toBe(true);
    expect(holder.getKeyId()).toBe('k-live-1');
    expect(holder.getEpoch()).toBe(3);
    // By reference: the exposed buffer IS the input buffer (one buffer to wipe).
    expect(holder.getDataKey()).toBe(key);
  });

  it('an empty holder reports not populated and yields no key', () => {
    const holder = new CommitteeKeyHolder();
    expect(holder.isPopulated()).toBe(false);
    expect(holder.getDataKey()).toBeNull();
    expect(holder.getKeyId()).toBeNull();
    expect(holder.getEpoch()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-8 / F-145 — each of the SIX wipe triggers zeroizes + nulls
// ---------------------------------------------------------------------------

describe('CommitteeKeyHolder — six wipe triggers (AC-8 / F-145)', () => {
  // One row per trigger. Each fires the trigger, then asserts BOTH:
  //   (a) the EXACT buffer that was set is now all-zero, and
  //   (b) the holder reports empty (reference nulled).
  const triggers: ReadonlyArray<[string, (h: CommitteeKeyHolder) => void]> = [
    ['trigger 1 — sign-out / clearJwt', (h) => h.onSignOut()],
    ['trigger 2 — session revocation / HTTP 401', (h) => h.onSessionRevoked()],
    ['trigger 3 — panic-wipe', (h) => h.onPanicWipe()],
    ['trigger 4 — session expiry', (h) => h.onSessionExpiry()],
    ['trigger 5 — page unload (beforeunload/pagehide)', (h) => h.onPageUnload()],
    ['trigger 6 — observed key rotation', (h) => h.onKeyRotationObserved('k-live-2')]
  ];

  for (const [name, fire] of triggers) {
    it(`${name}: .fill(0)-zeroizes the exact buffer AND nulls the holder`, () => {
      const { holder, key } = populated();
      expect(Array.from(key).some((b) => b !== 0)).toBe(true); // non-zero before

      fire(holder);

      // (a) the exact buffer is zeroized in place.
      expect(Array.from(key).every((b) => b === 0)).toBe(true);
      // (b) the holder reference is nulled.
      expect(holder.isPopulated()).toBe(false);
      expect(holder.getDataKey()).toBeNull();
      expect(holder.getKeyId()).toBeNull();
    });
  }

  it('wipe() is idempotent — a second wipe on an empty holder does not throw', () => {
    const { holder } = populated();
    holder.wipe();
    expect(() => holder.wipe()).not.toThrow();
    expect(holder.isPopulated()).toBe(false);
  });

  it('wipe() zeroizes the exact buffer (direct wipe(), not via a trigger)', () => {
    const { holder, key } = populated();
    holder.wipe();
    expect(Array.from(key).every((b) => b === 0)).toBe(true);
    expect(holder.getDataKey()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-11 — observed rotation wipes the stale key (re-unwrap forced)
// ---------------------------------------------------------------------------

describe('CommitteeKeyHolder — observed-rotation wipe (AC-11 / F-154)', () => {
  it('observing a NEWER key_id wipes the stale key so a re-unwrap is forced', () => {
    const { holder, key } = populated(); // cached at k-live-1 / epoch 3
    holder.onKeyRotationObserved('k-live-2'); // a co-chair rotated elsewhere
    expect(Array.from(key).every((b) => b === 0)).toBe(true);
    expect(holder.isPopulated()).toBe(false);
    // No seal/open can proceed under the stale key — the holder is empty.
    expect(holder.getDataKey()).toBeNull();
  });

  it('observing the SAME key_id does NOT wipe (no spurious re-unwrap churn)', () => {
    const { holder, key } = populated(); // cached at k-live-1
    holder.onKeyRotationObserved('k-live-1'); // same epoch — no rotation
    // The key is still live (no zeroize) and still cached.
    expect(Array.from(key).some((b) => b !== 0)).toBe(true);
    expect(holder.isPopulated()).toBe(true);
    expect(holder.getDataKey()).toBe(key);
  });
});

// ---------------------------------------------------------------------------
// AC-8 / F-145 — panic-wipe ordering: holder wiped BEFORE IndexedDB clear
// ---------------------------------------------------------------------------

describe('CommitteeKeyHolder — panic-wipe ordering (AC-8 / F-145, load-bearing)', () => {
  it('wipes the holder BEFORE the WipeStore clears IndexedDB (ordering spy)', async () => {
    const { holder, key } = populated();
    const store = new MemoryWipeStore();
    // The store's audit must succeed so the wipe sequence actually runs
    // (audit-before-side-effect). MemoryWipeStore.emitAudit returns ok by
    // default.

    const order: string[] = [];
    const wipeSpy = vi.spyOn(holder, 'wipe').mockImplementation(() => {
      order.push('holder.wipe');
      // Honour the real contract inside the spy so post-conditions hold.
      key.fill(0);
    });
    const idbSpy = vi.spyOn(store, 'clearIndexedDb');
    idbSpy.mockImplementation(async (names) => {
      order.push('store.clearIndexedDb');
      return { ok: true, failed: [] as readonly string[] };
    });

    await panicWipeWithCommitteeKeyHolder({ holder, store, surface: 'lock_screen' });

    // The most sensitive in-memory secret is zeroized FIRST: if the wipe is
    // interrupted after the holder wipe but before IndexedDB, the live key is
    // already zero (F-145 ordering invariant).
    expect(order).toContain('holder.wipe');
    expect(order).toContain('store.clearIndexedDb');
    expect(order.indexOf('holder.wipe')).toBeLessThan(order.indexOf('store.clearIndexedDb'));
    // And the key really is zero after the sequence.
    expect(Array.from(key).every((b) => b === 0)).toBe(true);

    wipeSpy.mockRestore();
    idbSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// F-146 / AC-9 — no serialization of the key to any persistent surface
// ---------------------------------------------------------------------------

describe('CommitteeKeyHolder — non-serialization (F-146 / AC-9)', () => {
  it('the 32 key bytes never appear in sessionStorage or localStorage at any lifecycle point', () => {
    const { holder, key } = populated();
    const keyHex = sodium.to_hex(key);

    const scanStorage = (s: Storage): string => {
      let blob = '';
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k === null) continue;
        blob += k + '=' + (s.getItem(k) ?? '') + ';';
      }
      return blob;
    };

    // After populate.
    if (typeof sessionStorage !== 'undefined') {
      expect(scanStorage(sessionStorage)).not.toContain(keyHex);
    }
    if (typeof localStorage !== 'undefined') {
      expect(scanStorage(localStorage)).not.toContain(keyHex);
    }

    // After a wipe.
    holder.onSignOut();
    if (typeof sessionStorage !== 'undefined') {
      expect(scanStorage(sessionStorage)).not.toContain(keyHex);
    }
    if (typeof localStorage !== 'undefined') {
      expect(scanStorage(localStorage)).not.toContain(keyHex);
    }
  });

  it('JSON.stringify of the holder does NOT expose the key bytes (not a serializing store)', () => {
    const { holder, key } = populated();
    const keyHex = sodium.to_hex(key);
    // A naive serialize of the holder must not spill the buffer. The holder
    // is heap-only; either it stringifies to an opaque value or it omits the
    // bytes — never the raw key.
    const snapshot = JSON.stringify(holder);
    expect(snapshot).not.toContain(keyHex);
    // Defense-in-depth: also assert the raw decimal byte sequence is absent
    // (in case a store serialized the Uint8Array as an index object).
    const asNumbers = Array.from(key).join(',');
    expect(snapshot).not.toContain(asNumbers);
  });

  it('no URL on the page ever carries the key bytes (no key-in-URL)', () => {
    const { key } = populated();
    const keyHex = sodium.to_hex(key);
    if (typeof window !== 'undefined' && window.location) {
      expect(window.location.href).not.toContain(keyHex);
      expect(window.location.hash).not.toContain(keyHex);
      expect(window.location.search).not.toContain(keyHex);
    }
  });
});

// ---------------------------------------------------------------------------
// F-148 / AC-9 — set+wipe leaks no key bytes to logs/errors
// ---------------------------------------------------------------------------

describe('CommitteeKeyHolder — leak sweep across set+wipe (F-148 / AC-9)', () => {
  it('no key bytes reach console.* or the structured-log sink across populate+wipe', () => {
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

    const holder = new CommitteeKeyHolder();
    const key = freshKey();
    const keyHex = sodium.to_hex(key);
    holder.set({ data_key: key, key_id: 'k-live-1', epoch: 3 });
    holder.onSessionRevoked();

    const haystacks = [
      ...errs,
      ...warns,
      ...logs,
      ...__getCapturedLines().map((l) => JSON.stringify(l))
    ];
    for (const h of haystacks) {
      expect(h).not.toContain(keyHex);
    }

    errSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 401 vs 403 distinction at the holder level (AC-8)
// ---------------------------------------------------------------------------

describe('CommitteeKeyHolder — 401 wipes, 403 does not (AC-8)', () => {
  it('onSessionRevoked() (the 401 handler) wipes the holder', () => {
    const { holder, key } = populated();
    holder.onSessionRevoked();
    expect(Array.from(key).every((b) => b === 0)).toBe(true);
    expect(holder.isPopulated()).toBe(false);
  });

  it('a 403 (rls_denied) is NOT a holder trigger — there is no onForbidden wipe path', () => {
    // 403 (generic-forbidden) must NOT wipe the holder (rate-limit / RLS is
    // not a session event, F-145 / AC-8). The holder exposes no 403 trigger;
    // only the SIX defined triggers wipe. Assert the holder has no method
    // that suggests a 403/forbidden-driven wipe.
    const { holder, key } = populated();
    const proto = Object.getPrototypeOf(holder) as Record<string, unknown>;
    const methodNames = Object.getOwnPropertyNames(proto);
    expect(methodNames).not.toContain('onForbidden');
    expect(methodNames).not.toContain('onRlsDenied');
    expect(methodNames).not.toContain('onRateLimited');
    // The holder remains populated — nothing about a 403 touched it.
    expect(holder.isPopulated()).toBe(true);
    expect(holder.getDataKey()).toBe(key);
  });
});
