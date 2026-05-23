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
 * This helper exposes a minimal harness for T13's passphrase-prompt
 * test: `mountPassphrasePromptWithDelayedReady({ ready_delay_ms })`
 * mounts a modal whose `ready` promise resolves after `ready_delay_ms`
 * ms. Until then, the primary-button click handler (passphrase verify)
 * is structurally short-circuited — no `sensitive.access_attempt`
 * audit row is written for a pre-ready keydown.
 *
 * The real production passphrase modal lives in a future task; T13
 * ships the library + this harness so the obligation is testable
 * before the modal component itself.
 */

import { vi } from 'vitest';

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
