/**
 * Onboarding wizard state machine + rate limiter (T19).
 *
 * Per ADR-0020 Decision 2.b: in-memory only; no URL hash, no sessionStorage,
 * no localStorage. Hard refresh restarts from D.1; a fresh
 * `enrollment_session_id` is issued on each entry to D.1 (F-54 contract).
 *
 * The state machine is pure (no DOM, no network). Tests exercise it
 * directly; the Svelte components consume it through `OnboardingFlow.svelte`.
 *
 * @see ADR-0020 §Decision 2.b — state machine for D.1 → D.7
 * @see threat-model §8.T19 F-112 M-112a — D.4→D.6 client-side rate limit
 */

export type OnboardingStep =
  | 'D.1'
  | 'D.2'
  | 'D.3'
  | 'D.4'
  | 'D.5'
  | 'D.6'
  | 'D.7'
  | 'baseline_blocked';

export interface OnboardingWizardState {
  step: OnboardingStep;
  enrollment_session_id: string;
  /** Whether D.1's confirmation checkbox is ticked. */
  device_confirmed: boolean;
  /** D.6 type-back attempt counter (resets on D.4 re-entry). */
  type_back_attempts: number;
}

const ORDER: OnboardingStep[] = ['D.1', 'D.2', 'D.3', 'D.4', 'D.5', 'D.6', 'D.7'];

function isOrdered(step: OnboardingStep): step is Exclude<OnboardingStep, 'baseline_blocked'> {
  return step !== 'baseline_blocked';
}

export function initialState(enrollment_session_id?: string): OnboardingWizardState {
  return {
    step: 'D.1',
    enrollment_session_id: enrollment_session_id ?? generateEnrollmentSessionId(),
    device_confirmed: false,
    type_back_attempts: 0
  };
}

/** Issue a fresh enrollment_session_id (RFC-4122-v4-shaped). */
export function generateEnrollmentSessionId(): string {
  // Prefer crypto.randomUUID; fall back to a deterministic shape using
  // crypto.getRandomValues so tests under jsdom always produce a valid
  // UUID-shaped string.
  if (
    typeof crypto !== 'undefined' &&
    typeof (crypto as Crypto & { randomUUID?: () => string }).randomUUID === 'function'
  ) {
    return (crypto as Crypto & { randomUUID: () => string }).randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Last-resort deterministic fallback — keep the shape valid.
  const ts = Date.now().toString(16).padStart(12, '0').slice(-12);
  return `00000000-0000-4000-8000-${ts}`;
}

/**
 * Advance forward one step. Throws when the current step's gate is not
 * satisfied. Callers (the Svelte components) check `canAdvance(...)`
 * BEFORE calling `advance(...)`.
 */
export function advance(state: OnboardingWizardState): OnboardingWizardState {
  if (!isOrdered(state.step)) {
    return state; // baseline_blocked — terminal; cannot advance.
  }
  const idx = ORDER.indexOf(state.step);
  if (idx < 0 || idx >= ORDER.length - 1) {
    return state;
  }
  return { ...state, step: ORDER[idx + 1]! };
}

/** Jump to a specific step (test-only / harness use). */
export function jumpTo(
  state: OnboardingWizardState,
  step: OnboardingStep
): OnboardingWizardState {
  return { ...state, step };
}

/** Block the wizard at the baseline_blocked terminal state. */
export function blockBaseline(state: OnboardingWizardState): OnboardingWizardState {
  return { ...state, step: 'baseline_blocked' };
}

/** Reset to D.1 with a fresh enrollment_session_id (F-54). */
export function reset(): OnboardingWizardState {
  return initialState();
}

/** True iff `from` precedes `to` in the wizard order. */
export function isStepBefore(from: OnboardingStep, to: OnboardingStep): boolean {
  if (!isOrdered(from) || !isOrdered(to)) return false;
  return ORDER.indexOf(from) < ORDER.indexOf(to);
}

/** Index of step in the canonical order (1-based for UI display). */
export function stepNumber(step: OnboardingStep): number {
  if (!isOrdered(step)) return 3; // baseline_blocked freezes at D.3
  return ORDER.indexOf(step) + 1;
}

export const TOTAL_STEPS = ORDER.length;

// ============================================================================
// Client-side rate limiter (F-112 M-112a)
// ============================================================================

export interface OnboardingRateLimiter {
  /**
   * Record an attempt at `now` (ms epoch). Returns `{ok: true}` if within
   * the limit, or `{ok: false, reason_key}` if the limiter is saturated.
   *
   * The closed-allowlist error key is the canonical user-facing reason
   * (`onboarding.passphrase_d4.error.rate_limited`).
   */
  tryAttempt(now: number): { ok: true } | { ok: false; reason_key: string };
}

export function createOnboardingRateLimiter(opts: {
  limit: number;
  window_ms: number;
}): OnboardingRateLimiter {
  const attempts: number[] = [];
  return {
    tryAttempt(now: number) {
      const cutoff = now - opts.window_ms;
      while (attempts.length > 0 && (attempts[0] ?? Infinity) <= cutoff) {
        attempts.shift();
      }
      if (attempts.length >= opts.limit) {
        return { ok: false, reason_key: 'onboarding.passphrase_d4.error.rate_limited' };
      }
      attempts.push(now);
      return { ok: true };
    }
  };
}
