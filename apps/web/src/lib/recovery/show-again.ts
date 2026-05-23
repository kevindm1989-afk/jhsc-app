/**
 * Amendment F "show again" hold-to-reveal controller.
 *
 * --- WHAT THIS MODULE IS NOT ---
 * This file deliberately exposes NO copy-to-clipboard, NO speech-synthesis
 * affordance, NO screenshot affordance, NO file-export hook. The Amendment
 * F operational rule 4 (static-lint surface) requires that the recovery
 * passphrase reveal surface offer ONLY hold-to-reveal — anything else
 * widens the M-54a/b/c/d threat surface. The contract is enforced by the
 * library NOT exposing such hooks. The Test T07 / M-54d static lint
 * (mirrored by scripts/check-recovery-surface-lint.sh per privacy-review
 * T07-A3 widening, Amendment pass #5) greps for the speech-synthesis API
 * identifier(s) under both recovery surface directories
 * (src/lib/onboarding/recovery/ AND src/lib/recovery/) and fails on any
 * match outside test fixtures.
 *
 * --- WHAT THIS MODULE IS ---
 * A pure, framework-agnostic state machine for the hold-to-reveal
 * affordance. The UI (`RecoveryPassphraseScreen.svelte`) consumes the
 * controller surface and renders the passphrase only when the controller
 * enters the `revealed` state. The audit emission for
 * `identity_privkey.recovery_blob.viewed` fires BEFORE the controller
 * transitions to `revealed` (M-54b: audit-before-render contract); if the
 * audit callback throws or returns a non-ok shape, the controller stays
 * in `pressing` and surfaces an `audit_failed` reason so the UI can show
 * the M-54b danger toast.
 *
 * --- CONSTANTS (exported; pinned per Amendment F + threat-model M-54a/c) ---
 *   - REVEAL_HOLD_MS = 1500    — the minimum sustained press to reveal.
 *   - MAX_REVEALS_PER_SESSION = 3 — the per-enrollment-session cap.
 *
 * --- STATE MACHINE ---
 *
 *   idle ──onPressStart──> pressing ──(timer ≥1500ms)──> revealed
 *                              │
 *                              └──onPressEnd / onCancel──> cancelled ──> idle
 *
 *   revealed ──onPressEnd / onCancel──> idle
 *
 *   At any state ──cap reached──> capped (sticky; survives onCancel)
 *
 * --- AUDIT-BEFORE-RENDER ---
 *
 * On the timer firing in `pressing`, the controller:
 *   1. Increments the per-session reveal counter optimistically.
 *   2. Calls `onAudit('identity_privkey.recovery_blob.viewed', meta)` and
 *      awaits its result.
 *   3. If the audit call returns ok, transitions to `revealed`.
 *   4. If the audit call throws or returns `{ ok: false }`, decrements
 *      the counter and stays in `pressing` with `audit_failed = true`.
 *
 * Source obligations:
 *   - ADR-0003 Amendment F + threat-model M-54a/b/c/d.
 *   - observability/audit-log.md §1 — `identity_privkey.recovery_blob.viewed`
 *     enum value (Amendment F addition).
 *   - test/T07/e2ee-key-core.test.ts — the M-54a/b/c/d test block.
 */

/** Per Amendment F + threat-model M-54a: the minimum sustained press. */
export const REVEAL_HOLD_MS = 1500;

/** Per Amendment F + threat-model M-54c: per-session reveal cap. */
export const MAX_REVEALS_PER_SESSION = 3;

/**
 * Test-only observer for the `identity_privkey.recovery_blob.viewed`
 * emission. The Vitest harness's `spyAuditWrites()` installs a listener
 * here so it can record the audit-row emission BEFORE the DOM renders
 * the passphrase (M-54b ordering test). Production builds never set
 * this; the controller short-circuits if no observer is registered.
 */
let __testAuditObserver:
  | null
  | ((meta: {
      enrollment_session_id: string;
      reveal_count_in_session: number;
      actor_id: string;
    }) => void) = null;
export function __setShowAgainAuditObserverForTest(
  fn:
    | ((meta: {
        enrollment_session_id: string;
        reveal_count_in_session: number;
        actor_id: string;
      }) => void)
    | null
): void {
  __testAuditObserver = fn;
}
/**
 * Test-only override: when set, the controller calls THIS function as
 * `onAudit` instead of the constructor's `onAudit` callback. The harness
 * uses this to force a `{ ok: false }` (M-54b 500-blocks-render test)
 * without re-rendering the component.
 */
let __testAuditOverride: null | OnAuditFn = null;
export function __setShowAgainAuditOverrideForTest(fn: OnAuditFn | null): void {
  __testAuditOverride = fn;
}

export type ShowAgainState = 'idle' | 'pressing' | 'revealed' | 'capped';

export interface OnAuditMeta {
  enrollment_session_id: string;
  reveal_count_in_session: number;
  actor_id: string;
}

/**
 * The audit callback may return synchronously OR via a Promise. The
 * controller (`onTimer`) inspects the returned value's shape: a non-
 * promise applies immediately (lets the M-54b sync-tests observe the
 * reveal without a microtask flush); a promise is awaited.
 */
export type OnAuditFn = (
  event_type: 'identity_privkey.recovery_blob.viewed',
  meta: OnAuditMeta
) => Promise<{ ok: true } | { ok: false }> | { ok: true } | { ok: false };

export interface ShowAgainController {
  /** Begin a hold. Returns `cap_reached` if the cap was already hit. */
  onPressStart(): Promise<{ ok: true } | { ok: false; reason: 'cap_reached' }>;
  /** Release the hold. Idempotent. */
  onPressEnd(): void;
  /** Cancel the hold (pointer leave, blur, route change). Idempotent. */
  onCancel(): void;
  /** Current state. */
  getState(): ShowAgainState;
  /** Reveal count for this session so far. */
  getRevealCount(): number;
  /** Cap (exported constant; here as a method for ergonomic consumers). */
  getMaxReveals(): number;
  /** True after a successful reveal until the press is released. */
  isRevealed(): boolean;
  /**
   * True if the most-recent reveal attempt failed because the audit
   * endpoint did not return ok. Resets on the next `onPressStart`.
   */
  isAuditFailed(): boolean;
  /**
   * Subscribe to state mutations. Returns an unsubscribe function. The
   * Svelte component uses this to trigger reactive re-renders when the
   * timer fires asynchronously.
   */
  subscribe(listener: () => void): () => void;
}

export interface CreateShowAgainOpts {
  /** Per-enrollment-session correlation. Reset → new id → counter resets. */
  sessionId: string;
  /** Actor user id for the audit row meta. */
  actorId: string;
  /** Audit-before-render emission callback (M-54b). */
  onAudit: OnAuditFn;
  /**
   * Optional clock — defaults to wall-clock. Tests inject the frozen
   * clock from `_helpers/clock.ts`.
   */
  now?: () => number;
  /**
   * Optional timer scheduler — defaults to `setTimeout`. Tests pass the
   * vitest fake-timers `setTimeout` (which advanceBy() exercises).
   */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Build a controller bound to a specific enrollment session. The cap and
 * the hold-duration are NOT configurable — they are the security
 * contract from Amendment F.
 */
export function createShowAgainController(opts: CreateShowAgainOpts): ShowAgainController {
  const setTimer = opts.setTimer ?? ((cb: () => void, ms: number) => globalThis.setTimeout(cb, ms));
  const clearTimer =
    opts.clearTimer ??
    ((h: unknown) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>));

  let state: ShowAgainState = 'idle';
  let revealCount = 0;
  let auditFailed = false;
  let timerHandle: unknown = null;
  const listeners = new Set<() => void>();
  function notify(): void {
    for (const l of listeners) l();
  }

  function clearActiveTimer(): void {
    if (timerHandle !== null) {
      clearTimer(timerHandle);
      timerHandle = null;
    }
  }

  async function onPressStart(): Promise<{ ok: true } | { ok: false; reason: 'cap_reached' }> {
    if (state === 'capped' || revealCount >= MAX_REVEALS_PER_SESSION) {
      state = 'capped';
      return { ok: false, reason: 'cap_reached' };
    }
    // Re-pressing during an active hold: ignore the second press
    // (treat the controller as already-pressing).
    if (state === 'pressing' || state === 'revealed') {
      return { ok: true };
    }
    auditFailed = false;
    state = 'pressing';
    timerHandle = setTimer(() => {
      onTimer();
    }, REVEAL_HOLD_MS);
    notify();
    return { ok: true };
  }

  function onTimer(): void {
    if (state !== 'pressing') return;
    // Optimistically increment so the audit row carries the correct
    // `reveal_count_in_session` value (1-indexed per M-54b/c).
    const candidateCount = revealCount + 1;
    const meta = {
      enrollment_session_id: opts.sessionId,
      reveal_count_in_session: candidateCount,
      actor_id: opts.actorId
    };
    // Test-only observer fires synchronously BEFORE the audit callback,
    // capturing the M-54b "audit row emitted BEFORE DOM render" contract.
    if (__testAuditObserver) {
      try {
        __testAuditObserver(meta);
      } catch {
        /* observer must never break the controller */
      }
    }
    // Per M-54b the audit row MUST be emitted BEFORE the DOM renders
    // the passphrase. We invoke the audit callback and inspect the
    // returned value. If it's a non-promise (synchronous `{ok: true}`)
    // we apply the transition immediately — this keeps the test's
    // `advanceBy(1500); await waitFor(...)` working under fake timers
    // without needing a microtask-flush helper that doesn't exist.
    let result: ReturnType<OnAuditFn>;
    try {
      const auditFn = __testAuditOverride ?? opts.onAudit;
      result = auditFn('identity_privkey.recovery_blob.viewed', meta);
    } catch {
      auditFailed = true;
      notify();
      return;
    }
    const apply = (r: { ok: true } | { ok: false }): void => {
      if (state !== 'pressing') return;
      if (r.ok) {
        revealCount = candidateCount;
        state = 'revealed';
      } else {
        auditFailed = true;
      }
      notify();
    };
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<{ ok: true } | { ok: false }>).then(apply).catch(() => {
        auditFailed = true;
        notify();
      });
    } else {
      apply(result as { ok: true } | { ok: false });
    }
  }

  function onPressEnd(): void {
    clearActiveTimer();
    if (state === 'pressing' || state === 'revealed') {
      if (revealCount >= MAX_REVEALS_PER_SESSION) {
        state = 'capped';
      } else {
        state = 'idle';
      }
    }
    notify();
  }

  function onCancel(): void {
    onPressEnd();
  }

  return {
    onPressStart,
    onPressEnd,
    onCancel,
    getState: () => state,
    getRevealCount: () => revealCount,
    getMaxReveals: () => MAX_REVEALS_PER_SESSION,
    isRevealed: () => state === 'revealed',
    isAuditFailed: () => auditFailed,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
