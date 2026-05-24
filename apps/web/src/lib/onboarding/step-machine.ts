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
  /** Whether D.3's passkey enrollment succeeded server-side. */
  passkey_enrolled: boolean;
  /** Whether D.4's passphrase was generated and the user has acknowledged. */
  passphrase_acknowledged: boolean;
  /** Whether D.6 type-back constant-time-matched the live passphrase. */
  passphrase_confirmed: boolean;
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
    passkey_enrolled: false,
    passphrase_acknowledged: false,
    passphrase_confirmed: false,
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
 * Gate predicate for D.X → D.(X+1) transition. Returns the structured
 * reason key on rejection so the wizard's error surface can render a
 * closed-allowlist t() key (F-110 M-110a).
 */
export function canAdvance(
  state: OnboardingWizardState
): { ok: true } | { ok: false; reason: 'device_not_confirmed' | 'passkey_not_enrolled' | 'passphrase_not_acknowledged' | 'passphrase_not_confirmed' | 'terminal' } {
  if (!isOrdered(state.step)) return { ok: false, reason: 'terminal' };
  switch (state.step) {
    case 'D.1':
      // D.1 → D.2 requires the personal-device confirmation checkbox.
      if (!state.device_confirmed) return { ok: false, reason: 'device_not_confirmed' };
      return { ok: true };
    case 'D.2':
      // D.2 → D.3 has no precondition gate beyond an explicit click.
      return { ok: true };
    case 'D.3':
      // D.3 → D.4 requires the passkey ceremony to have succeeded.
      if (!state.passkey_enrolled) return { ok: false, reason: 'passkey_not_enrolled' };
      return { ok: true };
    case 'D.4':
      // D.4 → D.6 requires the user to have acknowledged the passphrase
      // (the wizard intentionally routes D.4 directly to D.6 — confirm via
      // type-back — and the session-revocation primer D.5 runs AFTER D.6
      // succeeds. The ORDER array reflects the canonical sequence but
      // advance() handles the D.4 → D.6 → D.5 → D.7 routing as per
      // ADR-0020 Decision 2.b).
      if (!state.passphrase_acknowledged) return { ok: false, reason: 'passphrase_not_acknowledged' };
      return { ok: true };
    case 'D.5':
      // D.5 → D.7 is always allowed (Skip is a tertiary action).
      return { ok: true };
    case 'D.6':
      // D.6 → D.5 requires constant-time-matched type-back.
      if (!state.passphrase_confirmed) return { ok: false, reason: 'passphrase_not_confirmed' };
      return { ok: true };
    case 'D.7':
      // Terminal.
      return { ok: false, reason: 'terminal' };
  }
}

/**
 * Advance forward following the canonical wizard order. Rejects (returns
 * the same state unchanged) when the current step's gate is not satisfied;
 * callers MUST consult `canAdvance(...)` to inspect the rejection reason
 * and render a closed-allowlist error key.
 *
 * The route is D.1 → D.2 → D.3 → D.4 → D.6 → D.5 → D.7 per ADR-0020
 * Decision 2.b (D.6 type-back happens BEFORE the session-revocation
 * primer so the user cannot bypass the type-back gate by skipping D.5).
 */
export function advance(state: OnboardingWizardState): OnboardingWizardState {
  const gate = canAdvance(state);
  if (!gate.ok) return state;
  if (!isOrdered(state.step)) return state;
  switch (state.step) {
    case 'D.1':
      return { ...state, step: 'D.2' };
    case 'D.2':
      return { ...state, step: 'D.3' };
    case 'D.3':
      return { ...state, step: 'D.4' };
    case 'D.4':
      return { ...state, step: 'D.6' };
    case 'D.6':
      return { ...state, step: 'D.5' };
    case 'D.5':
      return { ...state, step: 'D.7' };
    case 'D.7':
      return state;
  }
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
