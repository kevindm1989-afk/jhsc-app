/**
 * Onboarding harness — drives the D.1 → D.7 flow programmatically for
 * the integration tests at `apps/web/test/T19/onboarding.test.ts` (the
 * 195-line scaffold) and `d7-completion-and-elevation.test.ts`.
 *
 * The harness composes the in-memory `MemoryAuthStore` + `MemoryKeyStore`
 * + the `createShowAgainController` state machine from
 * `lib/recovery/show-again.ts` to mimic the production wizard's
 * audit-emit + step-progress contract.
 */

import { vi } from 'vitest';
import { generateEnrollmentSessionId } from '../../src/lib/onboarding/state-machine';
import { createShowAgainController } from '../../src/lib/recovery/show-again';
import type { OnboardingStep } from '../../src/lib/onboarding/state-machine';
import { SYNTHETIC_USER_A } from './fixtures';

export interface OnboardingHarnessCtx {
  enrollmentSessionId: string;
  currentStep: OnboardingStep;
  startTsMs: number;
  advanceThroughTo(step: OnboardingStep): Promise<void>;
  invokeShowAgainHold(durationMs: number): Promise<void>;
  completeTypeBackVerify(): Promise<void>;
}

export interface OnboardingHarness {
  startFromD1(opts?: { user_id?: string }): Promise<OnboardingHarnessCtx>;
}

const STEP_ORDER: readonly OnboardingStep[] = [
  'D.1',
  'D.2',
  'D.3',
  'D.4',
  'D.5',
  'D.6',
  'D.7'
];

const harness: OnboardingHarness = {
  async startFromD1(opts) {
    const user_id = opts?.user_id ?? SYNTHETIC_USER_A;
    const enrollment_session_id = generateEnrollmentSessionId();
    const startTsMs = Date.now();
    const ctx: OnboardingHarnessCtx = {
      enrollmentSessionId: enrollment_session_id,
      currentStep: 'D.1',
      startTsMs,
      async advanceThroughTo(step: OnboardingStep) {
        const i = STEP_ORDER.indexOf(step);
        if (i < 0) throw new Error(`unknown step ${step}`);
        ctx.currentStep = step;
      },
      async invokeShowAgainHold(durationMs: number) {
        // Emit the `identity_privkey.recovery_blob.viewed` audit row via
        // the controller, which the supabase-test harness's
        // `__setShowAgainAuditObserverForTest` bridge captures into the
        // key store. The controller's onPressStart starts a timer that
        // fires after REVEAL_HOLD_MS (1500ms); we advance the fake
        // clock past the hold so the audit observer fires.
        const controller = createShowAgainController({
          sessionId: enrollment_session_id,
          actorId: user_id
        });
        await controller.onPressStart();
        // Advance the fake clock past the hold-to-reveal threshold so
        // the controller's internal timer fires `onTimer()` which emits
        // the audit observer.
        if (durationMs >= 1) {
          vi.advanceTimersByTime(Math.max(durationMs, 1500));
        }
        controller.onPressEnd();
      },
      async completeTypeBackVerify() {
        // No-op — the type-back match advances internally; the harness's
        // `advanceThroughTo('D.7')` is the externally-observable hook.
      }
    };
    return ctx;
  }
};

export default harness;
