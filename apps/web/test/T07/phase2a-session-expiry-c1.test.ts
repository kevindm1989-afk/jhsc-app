/**
 * Phase 2a PR2 — threat-modeler co-sign condition C1: `onSessionExpiry`
 * wiring. RED-FIRST.
 *
 * The threat-modeler signed off PR1 with TWO carry-forward conditions:
 *   - C2 — every site that observes a `key_id` MUST call
 *          `holder.onKeyRotationObserved(observedKeyId)` and surface the
 *          unwrap composition through `holder.set()`. (Pinned in the three
 *          production-composition tests.)
 *   - C1 — `onSessionExpiry` MUST EITHER be driven by a real exp-timer
 *          mechanism that fires at JWT expiry, OR the design must be pinned
 *          to "trigger 4 collapses into trigger 2 (401 → clearJwt →
 *          onSessionRevoked) within ≤5 s, and there is an explicit code
 *          comment/test pinning that decision."
 *
 * This test pins the RECOMMENDED design (collapse into the 401 path) UNLESS
 * the implementer adds a real exp-timer. The PR2 implementer chooses ONE of
 * the two satisfying branches:
 *
 *   (a) Add a real exp-timer module + wire it into the session-scoped holder
 *       (e.g. `wireSessionCommitteeKeyHolderTriggers` already exists in
 *       PR1 — extend it to schedule a timer at JWT-exp that calls
 *       `holder.onSessionExpiry()`). Then the implementer ALSO updates the
 *       relevant assertion below (the assertion is marked "OR" — see the
 *       inline comment) so the test verifies the timer-driven wipe.
 *
 *   (b) Document the collapse: add a code comment in
 *       `apps/web/src/lib/crypto/committee-key-holder.ts` (or a sibling
 *       module that owns the session wiring) explaining that trigger 4
 *       collapses into the 401 path within ≤5 s of expiry, and that
 *       `onSessionExpiry` is a defensive no-additional-state method that
 *       only zeroizes (which the holder unit-test already asserts).
 *
 * The test asserts the CONTRACT either branch satisfies: from a 401 mid-
 * call, the holder reaches the zeroized state in the SAME execution as
 * the 401-path wipe (`onSessionRevoked`). That is the operationally-
 * observable behavior the threat-modeler signed off on.
 *
 * TEST → AC / FINDING MAP
 *   C1 (carry-forward)          — onSessionExpiry exists and wipes the
 *                                 holder (already covered in
 *                                 phase2a-committee-key-holder.test.ts; this
 *                                 file confirms the design pin).
 *   C1 (carry-forward, design)  — the 401 path STILL wipes the holder
 *                                 within the same call (the load-bearing
 *                                 collapse: trigger 4 → trigger 2).
 *
 * Hermetic: real CommitteeKeyHolder, no real timers.
 */

import { describe, expect, it } from 'vitest';
import _sodium from 'libsodium-wrappers-sumo';
import { CommitteeKeyHolder } from '../../src/lib/crypto';

await _sodium.ready;
const sodium = _sodium;

function populated(): { holder: CommitteeKeyHolder; key: Uint8Array } {
  const holder = new CommitteeKeyHolder();
  const key = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  holder.set({ data_key: key, key_id: 'k-live-1', epoch: 3 });
  return { holder, key };
}

describe('Phase 2a PR2 — C1 carry-forward (onSessionExpiry design pin)', () => {
  it('onSessionExpiry is a typed method on the holder (the wipe target exists, regardless of timer choice)', () => {
    const { holder } = populated();
    const proto = Object.getPrototypeOf(holder) as Record<string, unknown>;
    expect(typeof proto.onSessionExpiry).toBe('function');
  });

  it('onSessionExpiry zeroizes the cached key buffer + nulls the reference (defensive wipe path remains usable)', () => {
    const { holder, key } = populated();
    holder.onSessionExpiry();
    expect(Array.from(key).every((b) => b === 0)).toBe(true);
    expect(holder.isPopulated()).toBe(false);
  });

  it('onSessionRevoked (the 401 path the design collapses into) wipes the holder — confirms the collapse-into-401 design is observable', () => {
    // If the implementer chooses design (b), the 401 path IS the eventual
    // wipe; an exp-timer is not required. Either choice satisfies this
    // assertion because both paths route to wipe(), which is the actually
    // observable behavior the threat-modeler signed off on.
    const { holder, key } = populated();
    holder.onSessionRevoked();
    expect(Array.from(key).every((b) => b === 0)).toBe(true);
    expect(holder.isPopulated()).toBe(false);
  });

  it('the C1 collapse design is documented OR an exp-timer wiring source is present (flagged for implementer choice)', async () => {
    // This assertion is a SOFT pin: the implementer must satisfy ONE of:
    //   (a) add a session-expiry-timer wiring source under
    //       `src/lib/crypto/` whose source mentions `onSessionExpiry` AND
    //       a real timer primitive (`setTimeout` / `Date.now` / an
    //       exp-based scheduler), wiring it to the session-scoped holder,
    //       OR
    //   (b) add a comment in `committee-key-holder.ts` (or a sibling
    //       holder wiring file) that explicitly references "C1" or
    //       "collapses to the 401 path" so a future reviewer sees the
    //       design pin.
    //
    // The test does both checks; if EITHER branch is satisfied the test
    // passes. Today neither is in place → RED.
    const { readFileSync, readdirSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const cryptoDir = resolve(__dirname, '../../src/lib/crypto');
    const holderFile = resolve(cryptoDir, 'committee-key-holder.ts');

    // (b) design comment present?
    const holderSrc = readFileSync(holderFile, 'utf8');
    const designCommentPresent =
      /(^|\W)C1(\W|$)/i.test(holderSrc) || /collapses?.*401/i.test(holderSrc);

    // (a) a real exp-timer wiring source under src/lib/crypto/ ?
    let timerWiringPresent = false;
    const files = readdirSync(cryptoDir);
    for (const f of files) {
      if (!f.endsWith('.ts')) continue;
      const src = readFileSync(join(cryptoDir, f), 'utf8');
      if (
        /onSessionExpiry\s*\(/.test(src) &&
        /(setTimeout|setInterval|\bexp\b|expires_at|expiresAt)/.test(src) &&
        // The bare class definition in committee-key-holder.ts is NOT a
        // wiring file — we want a CALLER (a file that calls the method).
        !/^.*class\s+CommitteeKeyHolder/m.test(src)
      ) {
        timerWiringPresent = true;
        break;
      }
    }
    expect(designCommentPresent || timerWiringPresent).toBe(true);
  });
});
