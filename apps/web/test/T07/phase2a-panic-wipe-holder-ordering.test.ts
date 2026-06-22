/**
 * Phase 2a PR1 — F-145 panic-wipe ORDERING regression (security-reviewer BLOCK
 * / threat-model F-145 NO-GO #2). RED-FIRST.
 *
 * THE FINDING
 * ───────────
 * The committee-key holder MUST be zeroized BEFORE IndexedDB is cleared during
 * a panic-wipe (threat-model §3.16 F-145; decisions.md ADR-0027 Decision 1 /
 * AC-8: "panic-wipe wipes the holder BEFORE IndexedDB"). The threat-model's
 * explicit NO-GO #2 (threat-model.md line 3285): "panic-wipe clearing
 * IndexedDB BEFORE the holder → re-open F-145/F-146 NO-GO."
 *
 * The ORDERING seam `panicWipeWithCommitteeKeyHolder`
 * (apps/web/src/lib/crypto/committee-key-holder.ts) exists and is unit-tested
 * in ISOLATION (test/T07/phase2a-committee-key-holder.test.ts → "panic-wipe
 * ordering"). BUT the PRODUCTION panic path does NOT call that seam:
 *
 *   PanicWipeModal.onConfirm()  (apps/web/src/lib/lock/PanicWipeModal.svelte)
 *     → panicWipe({ store, surface })  (apps/web/src/lib/lock/panic-wipe.ts)
 *         → store.clearIndexedDb(...)         ← IndexedDB cleared HERE (line 214)
 *         → runPostWipeCleanup() → clearJwt   ← holder only wiped AFTER, via
 *                                                the clearJwt → JWT-null
 *                                                subscription side-effect wired
 *                                                in hooks.client.ts (line 107 +
 *                                                lines 121-123).
 *
 * So in production the holder is wiped (if at all) STRICTLY AFTER IndexedDB,
 * with no ordering guarantee — exactly the F-145 NO-GO. The existing isolated
 * `panicWipeWithCommitteeKeyHolder` test MASKS this gap because it exercises
 * the seam, not the production `panicWipe()`.
 *
 * THIS TEST
 * ─────────
 * Exercises the PRODUCTION `panicWipe()` (NOT the isolated seam). It populates
 * the session-scoped committee-key holder with a known 32-byte key, then drives
 * `panicWipe()` with an injected WipeStore whose `clearIndexedDb` is
 * instrumented as an ordering recorder. The recorder captures, AT THE INSTANT
 * IndexedDB is cleared, whether the holder has already been zeroized. It then
 * asserts:
 *   (1) the holder's data-key buffer was `.fill(0)`-zeroized BEFORE the
 *       IndexedDB clear ran (strict happens-before), and
 *   (2) after `panicWipe()` resolves, the holder is empty (reference nulled)
 *       and the original buffer is all-zero.
 *
 * EXPECTED RESULT AGAINST CURRENT CODE: RED. The production `panicWipe()` never
 * touches the committee-key holder, so at the moment `clearIndexedDb` runs the
 * holder is STILL POPULATED with the live (non-zero) key — assertion (1) fails
 * for the RIGHT reason (ordering violation: holder not wiped before IndexedDB),
 * not a harness error.
 *
 * IMPLEMENTER CONTRACT (the minimal seam this pins)
 * ─────────────────────────────────────────────────
 * `panicWipe()` (or whatever the production panic surface invokes) MUST zeroize
 * the session committee-key holder as its FIRST destructive step — before
 * `clearIndexedDb`. The clean shape is: route the production panic path through
 * `panicWipeWithCommitteeKeyHolder({ holder: getSessionCommitteeKeyHolder(),
 * ... })`, OR prepend `getSessionCommitteeKeyHolder().onPanicWipe()` inside
 * `panicWipe()` ahead of the first `clear*` call. The holder wipe must be
 * best-effort (a panic must always proceed to destroy device state) but must
 * happen-before the IndexedDB clear.
 *
 * HERMETIC: real libsodium (only to mint a realistic 32-byte key); the session
 * holder singleton from $lib/crypto (reset per-test); an in-test injected
 * WipeStore (no real IndexedDB, no network); frozen clock. The implementer
 * treats this file as READ-ONLY.
 *
 * TEST → AC / FINDING MAP
 *   AC-8 / F-145 (ordering, load-bearing) — production panicWipe() zeroizes the
 *     committee-key holder BEFORE the WipeStore clears IndexedDB.
 *   threat-model NO-GO #2 — IndexedDB cleared before the holder re-opens
 *     F-145/F-146.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import { freezeClock, restoreClock } from '../_helpers/clock';
import type {
  PanicWipeAuditRow,
  WipeClass,
  WipeStore
} from '../../src/lib/lock/wipe-store';
import { panicWipe, setPostWipeCleanup } from '../../src/lib/lock/panic-wipe';
import {
  getSessionCommitteeKeyHolder,
  __resetSessionCommitteeKeyHolderForTest
} from '../../src/lib/crypto/committee-key-holder';

await _sodium.ready;
const sodium = _sodium;

function freshKey(): Uint8Array {
  return sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
}

/**
 * A WipeStore whose `clearIndexedDb` is an ordering recorder. It records the
 * order of named events into `order` and, AT THE INSTANT it clears IndexedDB,
 * snapshots whether `isHolderZeroized()` is already true. Every other clear*
 * succeeds so `panicWipe()` runs the full success path (status: 'completed').
 *
 * The committee-key holder is NOT part of the WipeStore interface — that is the
 * whole point of the finding: the production wipe path has no holder seam. The
 * recorder observes the holder via the injected `isHolderZeroized` probe so the
 * test can assert the happens-before relation without depending on any
 * implementation detail of how the holder gets wiped.
 */
function makeOrderingStore(probe: {
  isHolderZeroized: () => boolean;
}): {
  store: WipeStore;
  order: string[];
  holderZeroizedAtIdbClear: { value: boolean | null };
} {
  const order: string[] = [];
  const holderZeroizedAtIdbClear: { value: boolean | null } = { value: null };

  const store: WipeStore = {
    async emitAudit(_row: PanicWipeAuditRow) {
      // Audit must succeed so the wipe sequence actually proceeds
      // (F-53 audit-before-side-effect: a failed audit aborts every clear*).
      order.push('emitAudit');
      return { ok: true };
    },
    async clearIndexedDb(_names: readonly string[]) {
      // Snapshot the holder state at the EXACT moment IndexedDB is cleared.
      holderZeroizedAtIdbClear.value = probe.isHolderZeroized();
      order.push('clearIndexedDb');
      return { ok: true, failed: [] as readonly string[] };
    },
    async clearCaches(_names: readonly string[]) {
      order.push('clearCaches');
      return { ok: true, failed: [] as readonly string[] };
    },
    async clearSessionStorage() {
      order.push('clearSessionStorage');
      return { ok: true };
    },
    async clearLocalStorage() {
      order.push('clearLocalStorage');
      return { ok: true };
    },
    async tearDownSessionCookie() {
      order.push('tearDownSessionCookie');
      return { ok: true };
    },
    nowMs() {
      return Date.now();
    }
  };

  return { store, order, holderZeroizedAtIdbClear };
}

/**
 * The holder is considered zeroized when it reports empty AND its previously
 * live buffer is all-zero. We capture the live buffer reference at populate
 * time so we can check the `.fill(0)` even after the holder nulls its own
 * reference.
 */
function holderZeroizedProbe(liveBuffer: Uint8Array): () => boolean {
  return () => {
    const stillPopulated = getSessionCommitteeKeyHolder().isPopulated();
    const bufferAllZero = Array.from(liveBuffer).every((b) => b === 0);
    return !stillPopulated && bufferAllZero;
  };
}

beforeEach(() => {
  freezeClock();
  __resetSessionCommitteeKeyHolderForTest();
  // The default-store post-wipe cleanup must not leak between tests; the
  // production wiring (hooks.client.ts) installs clearJwt here, but this test
  // injects its own store and owns the holder directly.
  setPostWipeCleanup(undefined);
});

afterEach(() => {
  __resetSessionCommitteeKeyHolderForTest();
  setPostWipeCleanup(undefined);
  restoreClock();
});

describe('Phase 2a / F-145 — PRODUCTION panicWipe() zeroizes the committee-key holder BEFORE IndexedDB', () => {
  it('wipes the session committee-key holder strictly BEFORE the WipeStore clears IndexedDB (production path)', async () => {
    // Populate the SESSION-scoped holder (the one production reads), exactly as
    // unwrapCommitteeDataKeyViaProduction would after a sign-in.
    const key = freshKey();
    const liveBuffer = key; // by-reference handoff (F-147 single-buffer invariant)
    getSessionCommitteeKeyHolder().set({ data_key: key, key_id: 'k-live-1', epoch: 3 });
    expect(getSessionCommitteeKeyHolder().isPopulated()).toBe(true);
    expect(Array.from(liveBuffer).some((b) => b !== 0)).toBe(true); // non-zero before

    const probe = { isHolderZeroized: holderZeroizedProbe(liveBuffer) };
    const { store, order, holderZeroizedAtIdbClear } = makeOrderingStore(probe);

    // Drive the PRODUCTION panic function (NOT panicWipeWithCommitteeKeyHolder).
    const result = await panicWipe({ store, surface: 'lock_screen' });

    // The wipe sequence actually ran (audit succeeded → clearIndexedDb fired).
    // If this fails, the harness is wrong (not the finding) — fail loudly.
    expect(
      order,
      'harness sanity: panicWipe must reach clearIndexedDb (audit-before-side-effect succeeded)'
    ).toContain('clearIndexedDb');
    expect(result.status).toBe('completed');

    // ── THE LOAD-BEARING ASSERTION (F-145 ordering / NO-GO #2) ──
    // At the instant IndexedDB was cleared, the committee-key holder MUST
    // already have been zeroized. Against current code the production
    // panicWipe() never touches the holder, so this is `false` → RED for the
    // intended reason (ordering violation: holder not wiped before IndexedDB).
    expect(
      holderZeroizedAtIdbClear.value,
      'F-145 NO-GO #2: the committee-key holder MUST be zeroized BEFORE IndexedDB ' +
        'is cleared. At clearIndexedDb time the holder was still populated / its ' +
        'key buffer was non-zero — production panicWipe() does not wipe the holder ' +
        'first. Route the panic path through panicWipeWithCommitteeKeyHolder or ' +
        'prepend getSessionCommitteeKeyHolder().onPanicWipe() before the first clear*.'
    ).toBe(true);
  });

  it('after panicWipe() resolves, the holder is empty and its key buffer is .fill(0)-zeroized', async () => {
    const key = freshKey();
    const liveBuffer = key;
    getSessionCommitteeKeyHolder().set({ data_key: key, key_id: 'k-live-1', epoch: 3 });

    const probe = { isHolderZeroized: holderZeroizedProbe(liveBuffer) };
    const { store } = makeOrderingStore(probe);

    await panicWipe({ store, surface: 'lock_screen' });

    // Post-condition: the most sensitive in-memory secret is gone. Against
    // current code the production panicWipe() never wipes the holder, so the
    // holder is STILL populated and the buffer is STILL non-zero → RED.
    expect(
      getSessionCommitteeKeyHolder().isPopulated(),
      'after panicWipe() the committee-key holder must be empty (reference nulled)'
    ).toBe(false);
    expect(
      Array.from(liveBuffer).every((b) => b === 0),
      'after panicWipe() the committee data-key buffer must be .fill(0)-zeroized'
    ).toBe(true);
  });

  it('records a clean happens-before via index comparison (holder-wipe index < clearIndexedDb index)', async () => {
    // A second, index-based view of the same ordering invariant. We capture a
    // 'holder.wipe' marker the moment the holder transitions to empty, and
    // assert its position precedes clearIndexedDb in the recorded order. This
    // pins the ordering without relying solely on the snapshot boolean, so a
    // regression that wipes the holder LATE (e.g. only in post-wipe cleanup)
    // is still caught as an index-ordering failure.
    const key = freshKey();
    const liveBuffer = key;
    getSessionCommitteeKeyHolder().set({ data_key: key, key_id: 'k-live-1', epoch: 3 });

    const order: string[] = [];
    let holderWipeRecorded = false;
    const recordHolderWipeIfDone = () => {
      if (
        !holderWipeRecorded &&
        !getSessionCommitteeKeyHolder().isPopulated() &&
        Array.from(liveBuffer).every((b) => b === 0)
      ) {
        holderWipeRecorded = true;
        order.push('holder.wipe');
      }
    };

    const store: WipeStore = {
      async emitAudit(_row: PanicWipeAuditRow) {
        recordHolderWipeIfDone();
        return { ok: true };
      },
      async clearIndexedDb(_names: readonly string[]) {
        recordHolderWipeIfDone();
        order.push('clearIndexedDb');
        return { ok: true, failed: [] as readonly string[] };
      },
      async clearCaches(_names: readonly string[]) {
        recordHolderWipeIfDone();
        return { ok: true, failed: [] as readonly string[] };
      },
      async clearSessionStorage() {
        recordHolderWipeIfDone();
        return { ok: true };
      },
      async clearLocalStorage() {
        recordHolderWipeIfDone();
        return { ok: true };
      },
      async tearDownSessionCookie() {
        recordHolderWipeIfDone();
        return { ok: true };
      },
      nowMs() {
        return Date.now();
      }
    };

    await panicWipe({ store, surface: 'lock_screen' });
    // Catch a holder wipe that happened in post-wipe cleanup (after all clear*).
    recordHolderWipeIfDone();

    const holderIdx = order.indexOf('holder.wipe');
    const idbIdx = order.indexOf('clearIndexedDb');

    expect(idbIdx, 'harness sanity: clearIndexedDb must have run').toBeGreaterThanOrEqual(0);
    expect(
      holderIdx,
      'the committee-key holder was never zeroized during the production panicWipe() ' +
        'sequence (F-145): no holder-wipe was observed before, between, or after the ' +
        'clear* steps. The production path must wipe the holder as its FIRST step.'
    ).toBeGreaterThanOrEqual(0);
    expect(
      holderIdx,
      'F-145 ordering: holder-wipe must happen-before clearIndexedDb. The recorded ' +
        `order was: [${order.join(', ')}]. The holder was zeroized at or after the ` +
        'IndexedDB clear, not before it.'
    ).toBeLessThan(idbIdx);
  });
});

// ---------------------------------------------------------------------------
// Guard: this regression must NOT silently pass because it exercises the
// isolated seam. The whole point of the finding is that the PRODUCTION
// panicWipe() — the function the modal calls — owns the ordering, not the
// `panicWipeWithCommitteeKeyHolder` composition. This meta-assertion documents
// that the test above imports and drives `panicWipe`, never the seam.
// ---------------------------------------------------------------------------
describe('Phase 2a / F-145 — regression targets the PRODUCTION function, not the isolated seam', () => {
  it('drives the production panicWipe export (the surface PanicWipeModal.onConfirm invokes)', () => {
    expect(
      typeof panicWipe,
      'this regression must exercise the production panicWipe(), the function the ' +
        'panic modal actually calls — not panicWipeWithCommitteeKeyHolder'
    ).toBe('function');
  });
});
