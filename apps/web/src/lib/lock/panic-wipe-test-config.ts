/**
 * Test-only configuration seam for PanicWipeModal.
 *
 * Replaces the former `export let __test_*` props on PanicWipeModal so their
 * names no longer compile into the production bundle (issue #120 / A-T19-RR-4:
 * `scripts/check-onboarding-test-props-stripped.sh` greps the prod build for
 * `__test_*` literals). Tests SET the config before `render()`; the component
 * READS it at init ONLY inside `if (!import.meta.env.PROD)` blocks, so Vite's
 * dead-code-elimination drops the reads in production → the import becomes
 * unused → Rollup tree-shakes this side-effect-free module out of the prod
 * bundle entirely. Same mechanism as `src/lib/onboarding/__test_seams.ts`.
 *
 * SIDE-EFFECT-FREE at the top level: the production tripwire lives inside the
 * exported functions (`__assertNotProduction()`), never at module scope — a
 * top-level side effect would both defeat tree-shaking AND risk a prod crash
 * (the #118 regression). Export names deliberately avoid the `__test_`/
 * `__debug` prefixes the gate greps for.
 */
import type { WipeStore, WipeClass } from './wipe-store';

export interface PanicWipeTestConfig {
  /** Artificial delay (ms) before the type-back input becomes ready. */
  readyDelayMs?: number;
  /** Force the modal straight into the in-progress wipe state. */
  forceWipeInProgress?: boolean;
  /** Force a specific wipe class to fail (drives the partial-failure path). */
  forceClearFailure?: WipeClass;
  /** Auto-submit the wipe immediately (paired with forceClearFailure). */
  autoSubmit?: boolean;
  /** Force the modal straight into the completed state. */
  forceComplete?: boolean;
  /** Inject a WipeStore override (the existing test-harness contract). */
  store?: WipeStore;
}

let current: PanicWipeTestConfig = {};

function __assertNotProduction(): void {
  if (typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'production') {
    throw new Error('panic-wipe-test-config invoked in production build');
  }
}

export function setPanicWipeTestConfig(cfg: PanicWipeTestConfig): void {
  __assertNotProduction();
  current = cfg;
}

export function getPanicWipeTestConfig(): PanicWipeTestConfig {
  __assertNotProduction();
  return current;
}

export function clearPanicWipeTestConfig(): void {
  __assertNotProduction();
  current = {};
}
