/**
 * Test-only configuration seam for the onboarding wizard (OnboardingFlow +
 * its D5SessionRevocationPrimer child).
 *
 * Replaces the former `export let __test_*` props so their names no longer
 * compile into the production bundle (issue #120 / A-T19-RR-4). Tests SET the
 * config before `render()`; the components READ it at init ONLY inside
 * `if (!import.meta.env.PROD)` blocks, so Vite DCE drops the reads in
 * production → the import becomes unused → Rollup tree-shakes this
 * side-effect-free module out of the prod bundle. Same mechanism as
 * `src/lib/onboarding/__test_seams.ts`.
 *
 * SIDE-EFFECT-FREE at the top level: the production tripwire lives inside the
 * exported functions (`__assertNotProduction()`), never at module scope.
 * Export names deliberately avoid the `__test_`/`__debug` prefixes the gate
 * (`scripts/check-onboarding-test-props-stripped.sh`) greps for.
 */
import type { OnboardingStep } from './step-machine';

export interface OnboardingTestConfig {
  /** Force the wizard's initial step (D.1 … D.7). */
  step?: OnboardingStep;
  /** Override the user-agent for the device-fingerprint + baseline gate. */
  userAgent?: string;
  /** D.5 — number of active sessions shown by the revocation primer. */
  sessionCount?: number;
  /** D.5 — artificial delay (ms) before revokeAllSessions() resolves. */
  revokeDelayMs?: number;
  /** D.5 — devices that fail to revoke (partial-failure path). */
  revokePartialFailure?: readonly string[];
  /** D.5 — error injection: 'rate_limited' | 'server_unreachable'. */
  revokeError?: string;
  /** D.4 — force the encryption-in-progress state. */
  forceEncryptionInProgress?: boolean;
  /** D.4 — force the download-in-progress state. */
  forceDownloadInProgress?: boolean;
  /** D.4 — force the download-blocked toast. */
  forceDownloadBlocked?: boolean;
  /** D.4 — force the download-success state. */
  forceDownloadSuccess?: boolean;
  /** D.4 — force the reveal-capped state. */
  forceRevealCap?: boolean;
}

let current: OnboardingTestConfig = {};

function __assertNotProduction(): void {
  if (typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'production') {
    throw new Error('onboarding-test-config invoked in production build');
  }
}

export function setOnboardingTestConfig(cfg: OnboardingTestConfig): void {
  __assertNotProduction();
  current = cfg;
}

export function getOnboardingTestConfig(): OnboardingTestConfig {
  __assertNotProduction();
  return current;
}

export function clearOnboardingTestConfig(): void {
  __assertNotProduction();
  current = {};
}
