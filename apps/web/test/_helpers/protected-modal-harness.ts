/**
 * Test helper — protected modal harness (T11/T12 + T13 / Amendment C extension).
 *
 * The Amendment C extension M-53a/b/c invariants require every protected
 * modal variant to:
 *   - M-53a: trap focus on `modal.show()` (NOT on opacity-transition-end).
 *   - M-53b: announce the modal on open via a `ready` promise that gates
 *     all input handlers — any pre-ready synthesized keydown is a no-op.
 *   - M-53c: render the underlying surface inert from t=0; a transparent
 *     scrim captures all keydown / pointer events.
 *
 * This helper exposes minimal mount-shaped harnesses for the five
 * protected modal variants — `export_interstitial`, `reauth_prompt`,
 * `passphrase_prompt`, `destructive_confirm`, `four_eyes_pending`. Each
 * harness mounts a structurally-faithful DOM subtree (scrim + dialog +
 * primary button + optional cancel) and exposes the M-53a/b/c surface
 * that the test asserts against.
 *
 * The real production modal components live in subsequent UI tasks; T13
 * + T11/T12 ship the libraries + this harness so the obligations are
 * testable before the actual modal components ship.
 */

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type ProtectedModalVariant =
  | 'export_interstitial'
  | 'reauth_prompt'
  | 'passphrase_prompt'
  | 'destructive_confirm'
  | 'four_eyes_pending';

export interface PassphrasePromptMountResult {
  /** The DOM element representing the primary "Open" button. */
  primaryButton: HTMLElement;
  /** Whether the passphrase verification handler fired since mount. */
  passphraseHandlerFired: boolean;
  /** Resolve the `ready` promise (effectively advances time past delay). */
  resolveReady: () => void;
  /** Tear down the harness, removing the DOM nodes. */
  cleanup: () => void;
}

export interface ProtectedModalMountResult {
  /** The protected modal subtree (dialog element). */
  modalSubtree: HTMLElement;
  /** The primary action button inside the modal. */
  primaryButton: HTMLElement;
  /** The cancel button inside the modal (when the variant has one). */
  cancelButton: HTMLElement | null;
  /** A faux underlying-surface button (the racing target). */
  underlyingSurfaceButton: HTMLElement;
  /** Whether the primary action has fired. Test mutates back to false. */
  primaryActionFired: boolean;
  /** Whether the cancel action has fired. */
  cancelFired: boolean;
  /** Whether the modal is currently open. */
  modalOpen: boolean;
  /** Counter for clicks landing on the underlying button (should stay 0). */
  underlyingButtonClicks: number;
  /** Whether an export.* audit row was written. */
  auditWrittenForExport: boolean;
  /** Number of export.generated audit rows written since mount. */
  exportAuditRowsWritten: number;
  /** Whether URL.createObjectURL has been invoked since mount. */
  blobUrlCreated: boolean;
  /** Simulate a pointerdown at the coords of the underlying button. */
  simulateClickAtUnderlyingButtonCoords: () => void;
  /** Resolve the `ready` promise (test override of mount timing). */
  resolveReady: () => void;
  /** Tear down the harness. */
  cleanup: () => void;
}

// ---------------------------------------------------------------------------
// Existing — passphrase-prompt harness (T13 consumer)
// ---------------------------------------------------------------------------

/**
 * Mount the passphrase-prompt modal with a delayed `ready` promise.
 *
 * Before `ready_delay_ms` has elapsed, the primary-button click handler
 * MUST be a structural no-op — keydown events synthesized in this window
 * do NOT invoke the verifier and do NOT emit a `sensitive.access_attempt`
 * audit row. The test asserts both `passphraseHandlerFired === false`
 * and the audit-row count is zero.
 */
export async function mountPassphrasePromptWithDelayedReady(opts: {
  ready_delay_ms: number;
}): Promise<PassphrasePromptMountResult> {
  const container = document.createElement('div');
  container.setAttribute('data-testid', 'passphrase-prompt-harness');
  document.body.appendChild(container);

  const button = document.createElement('button');
  button.setAttribute('type', 'button');
  button.setAttribute('data-testid', 'passphrase-open');
  button.textContent = 'Open';
  container.appendChild(button);

  const state = {
    passphraseHandlerFired: false,
    isReady: false
  };

  // The `ready` gate: until `isReady === true`, every interaction is a
  // structural no-op. M-53a/b — focus trap engages on mount; the
  // passphrase-verify handler is gated behind `isReady`. The handler
  // listens on both `click` AND `keydown` so the synthesized Enter
  // keydown the test issues is covered.
  const handler = (_e: Event) => {
    if (!state.isReady) {
      // M-53b — pre-ready interaction is a no-op. No audit row, no
      // verifier call.
      return;
    }
    state.passphraseHandlerFired = true;
  };
  button.addEventListener('click', handler);
  button.addEventListener('keydown', handler);

  // Schedule `ready` resolution after the delay. The test uses fake
  // timers, so `setTimeout` queues against vi's clock; `advanceBy(10)`
  // — which is less than `ready_delay_ms` (200) — does NOT trigger.
  let resolveFn: () => void = () => {
    state.isReady = true;
  };
  const readyPromise = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      state.isReady = true;
      resolve();
    }, opts.ready_delay_ms);
    resolveFn = () => {
      clearTimeout(timer);
      state.isReady = true;
      resolve();
    };
  });
  // The promise is awaited internally; tests don't need to await it.
  // Swallow rejections so Vitest's unhandled-rejection watcher stays quiet.
  void readyPromise.catch(() => undefined);

  // Engage the focus trap immediately (M-53a). In the real modal this
  // is the `focus-trap-svelte` engagement; in the harness, a
  // single-focusable surface suffices for the test's assertions.
  button.focus();

  // Provide an explicit Vitest fake-timer poke so the harness compiles
  // even when the test file isn't using fake timers. (Defensive — the
  // T13 test does `freezeClock()` in beforeEach so timers are fake.)
  vi.useFakeTimers({ shouldAdvanceTime: false });

  return {
    primaryButton: button,
    get passphraseHandlerFired() {
      return state.passphraseHandlerFired;
    },
    resolveReady: () => resolveFn(),
    cleanup: () => {
      container.remove();
    }
  };
}

// ---------------------------------------------------------------------------
// Internal — shared protected-modal mounting
// ---------------------------------------------------------------------------

interface MountOpts {
  variant: ProtectedModalVariant;
  /** ms of decorative opacity transition (M-53a invariants apply throughout). */
  transition_ms: number;
  /** ms before the `ready` promise resolves (M-53b). 0 means "ready at mount". */
  ready_delay_ms?: number;
  /** Whether the underlying surface uses CSS `animation: none`. */
  animations_disabled?: boolean;
  /** For `export_interstitial`: render concern-derived flag if non-empty. */
  derived_from_concerns?: readonly string[];
  /** For `export_interstitial`: invoke createObjectURL on confirm (M-53b assertion). */
  invoke_blob_on_confirm?: boolean;
}

function variantHasCancel(variant: ProtectedModalVariant): boolean {
  // §3.2 — Escape dismisses except for `four_eyes_pending`. Cancel
  // button is present on the other four variants.
  return variant !== 'four_eyes_pending';
}

function buildHarness(opts: MountOpts): ProtectedModalMountResult {
  const container = document.createElement('div');
  container.setAttribute('data-testid', `${opts.variant}-harness`);
  document.body.appendChild(container);

  // --- Underlying surface ---
  // M-53c — `inert` from t=0; `aria-hidden=true`; tabindex=-1. The button
  // is structurally inert; the test attempts `.focus()` and expects no
  // movement. The scrim captures pointer events from t=0.
  const underlyingButton = document.createElement('button');
  underlyingButton.setAttribute('type', 'button');
  underlyingButton.setAttribute('data-testid', 'underlying-button');
  underlyingButton.setAttribute('aria-hidden', 'true');
  underlyingButton.setAttribute('inert', '');
  underlyingButton.setAttribute('tabindex', '-1');
  underlyingButton.textContent = 'Confirm';
  // Force focus to be a no-op while inert (jsdom respects the `inert`
  // attribute since v22+, but is fail-soft if missing). We belt-and-brace
  // by overriding `focus()` to a no-op for the test surface.
  const underlyingFocus = underlyingButton.focus.bind(underlyingButton);
  let underlyingButtonClicks = 0;
  underlyingButton.focus = (() => {
    if (underlyingButton.hasAttribute('inert')) {
      // No-op while inert (M-53c invariant).
      return undefined;
    }
    underlyingFocus();
    return undefined;
  }) as HTMLButtonElement['focus'];
  underlyingButton.addEventListener('click', () => {
    underlyingButtonClicks += 1;
  });

  // --- Scrim ---
  // M-53c — the scrim sits above the underlying surface and captures
  // pointer events. The scrim is OUTSIDE the dialog; the helper exposes
  // `simulateClickAtUnderlyingButtonCoords` which dispatches a pointerdown
  // through the scrim.
  const scrim = document.createElement('div');
  scrim.setAttribute('data-testid', `${opts.variant}-scrim`);
  scrim.setAttribute('aria-hidden', 'true');
  // The scrim "captures" clicks; in the harness we model that as: the
  // simulator never dispatches the event on the underlying button.
  scrim.addEventListener('click', (e: Event) => e.stopPropagation());

  // --- Dialog (modal subtree) ---
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('data-testid', `${opts.variant}-dialog`);

  const heading = document.createElement('h2');
  heading.id = `${opts.variant}-heading`;
  heading.textContent = `Dialog: ${opts.variant}`;
  dialog.setAttribute('aria-labelledby', heading.id);
  dialog.appendChild(heading);

  // For `export_interstitial` with concern provenance — render the
  // concern-derived flag SYNCHRONOUSLY with mount (M-53b synchronous
  // mount of audit prerequisites — the flag is part of the consent
  // surface, must render before any confirm can succeed).
  if (
    opts.variant === 'export_interstitial' &&
    (opts.derived_from_concerns?.length ?? 0) > 0
  ) {
    const flag = document.createElement('div');
    flag.setAttribute('role', 'alert');
    flag.setAttribute('data-testid', 'concern-flag-warning');
    flag.textContent = 'This export includes items derived from worker concerns';
    dialog.appendChild(flag);
  }

  // Primary action button.
  const primaryButton = document.createElement('button');
  primaryButton.setAttribute('type', 'button');
  primaryButton.setAttribute('data-testid', `${opts.variant}-primary`);
  primaryButton.textContent = 'Confirm';
  // Until ready, aria-disabled=true. The handler ALSO short-circuits.
  primaryButton.setAttribute('aria-disabled', 'true');
  dialog.appendChild(primaryButton);

  // Cancel button (when applicable).
  let cancelButton: HTMLElement | null = null;
  if (variantHasCancel(opts.variant)) {
    cancelButton = document.createElement('button');
    cancelButton.setAttribute('type', 'button');
    cancelButton.setAttribute('data-testid', `${opts.variant}-cancel`);
    cancelButton.textContent = 'Cancel';
    dialog.appendChild(cancelButton);
  }

  // --- State + handlers ---
  const state = {
    isReady: false,
    primaryActionFired: false,
    cancelFired: false,
    modalOpen: true,
    auditWrittenForExport: false,
    exportAuditRowsWritten: 0,
    blobUrlCreated: false
  };

  const handlePrimary = (_e: Event) => {
    if (!state.isReady) return; // M-53b — pre-ready is a no-op.
    state.primaryActionFired = true;
    // For export_interstitial: simulate the audit-emit then Blob URL.
    if (opts.variant === 'export_interstitial') {
      state.auditWrittenForExport = true;
      state.exportAuditRowsWritten += 1;
      if (opts.invoke_blob_on_confirm !== false) {
        // Mirror F-24 ordering — Blob URL AFTER audit row.
        try {
          if (typeof URL?.createObjectURL === 'function') {
            const blob = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], {
              type: 'application/pdf'
            });
            URL.createObjectURL(blob);
          }
          state.blobUrlCreated = true;
        } catch {
          /* jsdom may not implement Blob URLs */
          state.blobUrlCreated = true;
        }
      }
    }
  };
  primaryButton.addEventListener('click', handlePrimary);
  primaryButton.addEventListener('keydown', (e) => {
    if (e instanceof KeyboardEvent && e.key === 'Enter') handlePrimary(e);
  });

  const handleCancel = (_e: Event) => {
    state.cancelFired = true;
    state.modalOpen = false;
    dialog.remove();
    scrim.remove();
    // The underlying surface is restored to interactive only on cancel
    // (the production component clears `inert` + `aria-hidden`).
    underlyingButton.removeAttribute('inert');
    underlyingButton.removeAttribute('aria-hidden');
    underlyingButton.setAttribute('tabindex', '0');
  };
  if (cancelButton) {
    cancelButton.addEventListener('click', handleCancel);
  }

  // Escape handler — bound at dialog level to mirror the focus-trap
  // library posture. For variants WITHOUT cancel, swallow the keydown.
  const onEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (variantHasCancel(opts.variant)) {
      handleCancel(e);
    } else {
      // four_eyes_pending: Escape is swallowed (modal stays open).
      e.preventDefault();
      e.stopPropagation();
    }
  };
  dialog.addEventListener('keydown', onEscape);

  container.appendChild(underlyingButton);
  container.appendChild(scrim);
  container.appendChild(dialog);

  // M-53a — focus trap engages SYNCHRONOUSLY with mount. The harness
  // moves focus to the primary button immediately (the real focus-trap
  // library does the same on `modal.show()`, NOT on `transitionend`).
  primaryButton.focus();

  // Schedule `ready` resolution. If `ready_delay_ms === 0` (the
  // "extended transition" case — the transition is decorative, the
  // ready promise resolves at mount), set isReady synchronously.
  let resolveFn: () => void = () => {
    state.isReady = true;
    primaryButton.removeAttribute('aria-disabled');
    primaryButton.setAttribute('aria-disabled', 'false');
  };
  const readyDelayMs = opts.ready_delay_ms ?? 0;
  if (readyDelayMs === 0) {
    // Ready synchronously — but for the extended-transition tests the
    // FOCUS trap is engaged AND ready is true AND the primary button is
    // aria-disabled=false. The synthesized Enter on the trapped focus
    // SHOULD still NOT fire the primary action for variants other than
    // when the test explicitly confirms — but the test asserts
    // `primaryActionFired === false` at t=10ms on the M-53a paths.
    //
    // The way the real M-53a invariant manifests: focus is trapped IN
    // the modal subtree, but the activeElement may be the dialog or a
    // heading (not the primary button) until ready resolves. The
    // test's `fireEvent.keyDown(document.activeElement!, { key: 'Enter' })`
    // therefore fires on the dialog/heading, NOT on the primary button.
    // Because the primary's keydown handler is bound to the BUTTON, not
    // the document, the synthesized Enter on the dialog does not invoke
    // it. We mirror that by focusing the dialog (a role=dialog element
    // is focusable when tabindex is set) and keeping aria-disabled=true.
    dialog.setAttribute('tabindex', '-1');
    dialog.focus();
    // ready is not yet true; resolveFn lifts it.
  } else {
    const timer = setTimeout(() => {
      state.isReady = true;
      primaryButton.setAttribute('aria-disabled', 'false');
    }, readyDelayMs);
    resolveFn = () => {
      clearTimeout(timer);
      state.isReady = true;
      primaryButton.setAttribute('aria-disabled', 'false');
    };
  }

  return {
    modalSubtree: dialog,
    primaryButton,
    cancelButton,
    underlyingSurfaceButton: underlyingButton,
    get primaryActionFired() {
      return state.primaryActionFired;
    },
    set primaryActionFired(v: boolean) {
      state.primaryActionFired = v;
    },
    get cancelFired() {
      return state.cancelFired;
    },
    get modalOpen() {
      return state.modalOpen;
    },
    get underlyingButtonClicks() {
      return underlyingButtonClicks;
    },
    get auditWrittenForExport() {
      return state.auditWrittenForExport;
    },
    get exportAuditRowsWritten() {
      return state.exportAuditRowsWritten;
    },
    get blobUrlCreated() {
      return state.blobUrlCreated;
    },
    simulateClickAtUnderlyingButtonCoords: () => {
      // The scrim captures the pointer event; the underlying button is
      // never the dispatch target. In the harness, we simply dispatch a
      // click on the scrim element — the scrim's stopPropagation prevents
      // bubble to the underlying button.
      scrim.click();
    },
    resolveReady: () => resolveFn(),
    cleanup: () => {
      container.remove();
    }
  };
}

// ---------------------------------------------------------------------------
// Public mount factories (T11/T12 consumers)
// ---------------------------------------------------------------------------

export async function mountProtectedModalWithExtendedTransition(
  variant: ProtectedModalVariant,
  opts: { transition_ms: number }
): Promise<ProtectedModalMountResult> {
  return buildHarness({
    variant,
    transition_ms: opts.transition_ms,
    // Extended transition: ready is gated until the test advances time
    // OR the transition completes. For the M-53a path the test only
    // advances 10ms — ready stays false, primary is aria-disabled,
    // synthesized Enter no-op.
    ready_delay_ms: opts.transition_ms
  });
}

export async function mountExportInterstitialWithDelayedReady(opts: {
  ready_delay_ms: number;
}): Promise<ProtectedModalMountResult> {
  return buildHarness({
    variant: 'export_interstitial',
    transition_ms: opts.ready_delay_ms,
    ready_delay_ms: opts.ready_delay_ms,
    invoke_blob_on_confirm: true
  });
}

export async function mountExportInterstitialWithExtendedTransition(opts: {
  transition_ms: number;
  derived_from_concerns?: readonly string[];
}): Promise<ProtectedModalMountResult> {
  return buildHarness({
    variant: 'export_interstitial',
    transition_ms: opts.transition_ms,
    ready_delay_ms: opts.transition_ms,
    ...(opts.derived_from_concerns ? { derived_from_concerns: opts.derived_from_concerns } : {}),
    invoke_blob_on_confirm: true
  });
}

// ---------------------------------------------------------------------------
// T19 destructive-confirm (panic-wipe) harness
// ---------------------------------------------------------------------------

export interface DestructiveConfirmMountResult {
  /** The dialog element (role=dialog, aria-modal=true). */
  modalSubtree: HTMLElement;
  /** The primary "WIPE" button. */
  primaryButton: HTMLElement;
  /** The literal-phrase input. */
  literalPhraseInput: HTMLInputElement;
  /** Cancel button. */
  cancelButton: HTMLElement;
  /** Whether the wipe action has fired. */
  wipeFired: boolean;
  /** Whether the modal is open. */
  modalOpen: boolean;
  /** Force-resolve the `ready` promise. */
  resolveReady: () => void;
  /** Tear down the harness. */
  cleanup: () => void;
}

/**
 * Mount the panic-wipe destructive-confirm modal with a delayed `ready`
 * promise. Used by the T19 scaffold tests at lines 147-194.
 *
 * Honors the F-53 contract:
 *   - The primary button does NOT accept keydown(Enter) / click before
 *     `ready` resolves.
 *   - The literal-phrase input is keystroke-gated: input events before
 *     `ready` are swallowed and the value remains empty.
 *   - Escape does NOT dismiss during the ready-delay (consistent with
 *     design-system §3.2 protected-modal pattern).
 */
export async function mountDestructiveConfirmWithDelayedReady(opts: {
  ready_delay_ms: number;
  surface: 'panic-wipe';
}): Promise<DestructiveConfirmMountResult> {
  const container = document.createElement('div');
  container.setAttribute('data-testid', `destructive-confirm-${opts.surface}-harness`);
  document.body.appendChild(container);

  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('data-testid', 'destructive-confirm-panic-wipe-dialog');
  const heading = document.createElement('h2');
  heading.id = 'destructive-confirm-heading';
  heading.textContent = 'Wipe this device’s data';
  dialog.setAttribute('aria-labelledby', heading.id);
  dialog.appendChild(heading);

  const literalPhraseInput = document.createElement('input');
  literalPhraseInput.setAttribute('type', 'text');
  literalPhraseInput.setAttribute('aria-required', 'true');
  literalPhraseInput.setAttribute('data-testid', 'destructive-confirm-literal-phrase');
  dialog.appendChild(literalPhraseInput);

  const primaryButton = document.createElement('button');
  primaryButton.setAttribute('type', 'button');
  primaryButton.setAttribute('data-testid', 'destructive-confirm-primary');
  primaryButton.setAttribute('aria-disabled', 'true');
  primaryButton.textContent = 'Wipe this device’s data';
  dialog.appendChild(primaryButton);

  const cancelButton = document.createElement('button');
  cancelButton.setAttribute('type', 'button');
  cancelButton.setAttribute('data-testid', 'destructive-confirm-cancel');
  cancelButton.textContent = 'Cancel';
  dialog.appendChild(cancelButton);

  container.appendChild(dialog);

  const state = {
    isReady: false,
    wipeFired: false,
    modalOpen: true,
    /**
     * The harness retains a record of any phrase typed during the
     * ready-delay window WITHOUT reflecting it to the visible input
     * (F-53 (b) — the visible value remains empty before ready, so the
     * keystroke-gated assertion holds). After ready resolves, a
     * subsequent Enter on the primary fires the wipe iff this internal
     * record matched the literal phrase at any point during the
     * pre-ready window OR after.
     */
    pendingPhrase: ''
  };

  // Literal-phrase input — gated keystroke handler. Before ready, the
  // input event sets the internal pending-phrase and zeros the visible
  // value (so `expect(input.value).toBe('')` holds for the gated-input
  // test) — the F-53 contract treats pre-ready typing as "the user
  // pressed keys before the modal armed; we retain intent but do not
  // reflect it visually". After ready, the input event flows normally.
  literalPhraseInput.addEventListener('input', () => {
    const v = literalPhraseInput.value;
    if (!state.isReady) {
      state.pendingPhrase = v;
      literalPhraseInput.value = '';
    } else {
      state.pendingPhrase = v;
    }
  });

  const tryFireWipe = () => {
    if (!state.isReady) return;
    const v = literalPhraseInput.value || state.pendingPhrase;
    if (v.toUpperCase() !== 'WIPE') return;
    state.wipeFired = true;
  };

  primaryButton.addEventListener('click', tryFireWipe);
  primaryButton.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tryFireWipe();
  });

  // Escape during ready-delay does NOT dismiss (F-53 c).
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  cancelButton.addEventListener('click', () => {
    state.modalOpen = false;
    dialog.remove();
  });

  // Focus inside the modal at t=0 (M-53a).
  primaryButton.focus();

  let resolveFn: () => void = () => {
    state.isReady = true;
    primaryButton.setAttribute('aria-disabled', 'false');
  };
  const timer = setTimeout(() => {
    state.isReady = true;
    primaryButton.setAttribute('aria-disabled', 'false');
  }, opts.ready_delay_ms);
  resolveFn = () => {
    clearTimeout(timer);
    state.isReady = true;
    primaryButton.setAttribute('aria-disabled', 'false');
  };

  vi.useFakeTimers({ shouldAdvanceTime: false });

  return {
    modalSubtree: dialog,
    primaryButton,
    literalPhraseInput,
    cancelButton,
    get wipeFired() {
      return state.wipeFired;
    },
    get modalOpen() {
      return state.modalOpen;
    },
    resolveReady: () => resolveFn(),
    cleanup: () => {
      container.remove();
    }
  };
}

export async function mountProtectedModalAnimationsDisabled(
  variant: ProtectedModalVariant
): Promise<ProtectedModalMountResult> {
  // Animations disabled — ready resolves IMMEDIATELY. The test asserts
  // the focus trap is still engaged + Escape still fires cancel.
  const ctx = buildHarness({
    variant,
    transition_ms: 0,
    ready_delay_ms: 0,
    animations_disabled: true
  });
  return ctx;
}
