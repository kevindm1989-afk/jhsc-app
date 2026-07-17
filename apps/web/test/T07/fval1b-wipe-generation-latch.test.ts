/**
 * F-VAL-1(b) — the wipe-generation latch, CommitteeKeyHolder unit contract
 * (threat-model §3.18 F-183-B CLOSURE / F-VAL-1(b) ruling,
 * `.context/threat-model.md` ~:4631-4635; security-reviewer specified design).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
 *
 * This pins fix PART 1 (the holder surface the composition-level resurrect tests
 * in `test/T08/phase2a-fval1b-*` and `test/T13b/phase2b-fval1b-*` depend on):
 *
 *   - `wipe()` bumps a monotonic `#wipeGeneration` counter, so the generation
 *     advances under ALL FIVE session-end triggers (sign-out / 401 / panic-wipe /
 *     session-expiry / page-unload) — each routes through `wipe()`.
 *   - a read-only `wipeGeneration(): number` exposes it. Reading it does not
 *     mutate; only `wipe()` advances it.
 *   - it advances even on an EMPTY holder (the CRITICAL single-live `set()`
 *     resurrection case: an empty holder wiped mid-await is byte-identical to a
 *     legitimately never-populated one, so `isPopulated()` cannot discriminate —
 *     only this counter can).
 *   - NON-wipe mutations do NOT advance it: `populate()`, `set()`,
 *     `onKeyRotationObserved()`, `redesignateLiveIfHeld()`. (Add-not-wipe /
 *     rotation observe are NOT session-end events — ADR-0030 Decision 6.3.)
 *
 * RED today: `wipeGeneration` does not exist on `CommitteeKeyHolder`, so the
 * presence assertion fails with a clear "expected 'undefined' to be 'function'".
 * GREEN once the implementer adds the counter + reader. No clock / network / RNG.
 */

import { describe, expect, it } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import { CommitteeKeyHolder } from '../../src/lib/crypto';

await _sodium.ready;
const sodium = _sodium;

/** Read the (fix-added) generation. Callers assert presence FIRST. */
function gen(h: CommitteeKeyHolder): number {
  return (h as unknown as { wipeGeneration: () => number }).wipeGeneration();
}

function hasWipeGeneration(h: CommitteeKeyHolder): boolean {
  return typeof (h as unknown as { wipeGeneration?: unknown }).wipeGeneration === 'function';
}

function liveEntry(keyId: string, epoch: number) {
  return {
    data_key: sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES),
    key_id: keyId,
    epoch,
    is_live: true
  };
}

describe('F-VAL-1(b) — CommitteeKeyHolder.wipeGeneration() latch contract', () => {
  it('exposes a read-only numeric wipeGeneration() that does not mutate on read', () => {
    const h = new CommitteeKeyHolder();
    expect(
      hasWipeGeneration(h),
      'F-VAL-1(b): CommitteeKeyHolder.wipeGeneration() is missing — wipe() must bump a monotonic #wipeGeneration counter exposed by a read-only wipeGeneration(): number.'
    ).toBe(true);
    expect(typeof gen(h)).toBe('number');
    // Reading is idempotent — only wipe() advances the counter.
    const a = gen(h);
    const b = gen(h);
    expect(b).toBe(a);
  });

  it('wipe() advances the generation by exactly one (monotonic)', () => {
    const h = new CommitteeKeyHolder();
    expect(hasWipeGeneration(h), 'F-VAL-1(b): wipeGeneration() missing').toBe(true);
    const g0 = gen(h);
    h.wipe();
    expect(gen(h)).toBe(g0 + 1);
    h.wipe();
    expect(gen(h)).toBe(g0 + 2);
  });

  it('advances even on an EMPTY holder (the counter, not isPopulated(), is the discriminator)', () => {
    const h = new CommitteeKeyHolder();
    expect(hasWipeGeneration(h), 'F-VAL-1(b): wipeGeneration() missing').toBe(true);
    expect(h.isPopulated()).toBe(false);
    const g0 = gen(h);
    // A wipe on an already-empty holder still bumps — this is what lets a mid-await
    // single-live set() re-check distinguish "never populated" from "wiped".
    h.onPanicWipe();
    expect(h.isPopulated()).toBe(false); // still empty — isPopulated() unchanged
    expect(gen(h), 'F-VAL-1(b): a wipe on an empty holder must still advance #wipeGeneration').toBe(g0 + 1);
  });

  it('advances under EACH of the five session-end triggers (all route through wipe())', () => {
    const triggers: Array<[string, (h: CommitteeKeyHolder) => void]> = [
      ['onSignOut', (h) => h.onSignOut()],
      ['onSessionRevoked', (h) => h.onSessionRevoked()],
      ['onPanicWipe', (h) => h.onPanicWipe()],
      ['onSessionExpiry', (h) => h.onSessionExpiry()],
      ['onPageUnload', (h) => h.onPageUnload()]
    ];
    for (const [name, fire] of triggers) {
      const h = new CommitteeKeyHolder();
      expect(hasWipeGeneration(h), 'F-VAL-1(b): wipeGeneration() missing').toBe(true);
      h.populate([liveEntry('k-1', 1)]);
      const g0 = gen(h);
      fire(h);
      expect(gen(h), `F-VAL-1(b): trigger ${name}() must advance #wipeGeneration via wipe()`).toBe(g0 + 1);
    }
  });

  it('does NOT advance on non-wipe mutations (populate / set / onKeyRotationObserved / redesignateLiveIfHeld)', () => {
    const h = new CommitteeKeyHolder();
    expect(hasWipeGeneration(h), 'F-VAL-1(b): wipeGeneration() missing').toBe(true);
    const g0 = gen(h);

    h.populate([liveEntry('k-1', 1), { ...liveEntry('k-2', 2), is_live: false }]);
    expect(gen(h), 'populate() is not a session-end event and must not advance the generation').toBe(g0);

    h.set({ data_key: sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES), key_id: 'k-3', epoch: 3 });
    expect(gen(h), 'set() is not a session-end event and must not advance the generation').toBe(g0);

    h.onKeyRotationObserved('k-3');
    expect(gen(h), 'onKeyRotationObserved() is add-not-wipe (ADR-0030 6.3) and must not advance the generation').toBe(g0);

    h.redesignateLiveIfHeld('k-3');
    expect(gen(h), 'redesignateLiveIfHeld() is add-only and must not advance the generation').toBe(g0);
  });
});
