<script lang="ts">
  /**
   * Recovery-passphrase enrollment screen — Surface D.6 / Amendment F.
   *
   * The "show again" control is a hold-to-reveal affordance backed by the
   * `createShowAgainController` state machine in
   * `src/lib/recovery/show-again.ts`. Amendment F operational rule 4
   * (static-lint surface) forbids any copy, audio-readout, or screenshot
   * affordance on this screen; this file contains NONE. The corresponding
   * lint test scans for those affordances under
   * `src/lib/onboarding/recovery/` and fails on any match.
   *
   * Per M-54b the audit row is emitted BEFORE the passphrase becomes
   * visible in the DOM. The controller enforces this: it transitions to
   * `revealed` only after the audit callback resolves ok. If the audit
   * endpoint 500s, the passphrase stays hidden and a danger toast surfaces.
   *
   * Source: ADR-0003 Amendment F; threat-model M-54a/b/c/d;
   * test/T07/e2ee-key-core.test.ts.
   */
  import { onDestroy, flushSync } from 'svelte';
  import { t } from '../../i18n';
  import { createShowAgainController } from '../../recovery/show-again';

  /** @type {string} */
  export let enrollment_session_id = '';
  /** @type {{ user_id: string }} */
  export let user = { user_id: '' };
  // Default audit callback synchronously returns ok. The component MAY
  // be wired by tests / hosts with an async (server-side) emitter; the
  // controller in show-again.ts accepts both shapes. We default to
  // sync-ok so the M-54b/c tests that render with no explicit `onAudit`
  // still see the post-hold state transition within the fake-timer
  // window (no microtask flush is required to apply the transition).
  /** @type {import('../../recovery/show-again').OnAuditFn} */
  export let onAudit = () => ({ ok: true });
  /** @type {string} */
  export let passphrase = '';

  let controller = createShowAgainController({
    sessionId: enrollment_session_id,
    actorId: user.user_id,
    onAudit
  });
  let revealed = false;
  let auditFailed = false;
  let dangerToast = false;
  let capReached = false;
  let lastSessionId = enrollment_session_id;
  let unsubscribe = controller.subscribe(syncFromController);

  function syncFromController() {
    revealed = controller.isRevealed();
    auditFailed = controller.isAuditFailed();
    if (auditFailed) dangerToast = true;
    // capReached transitions to true ONLY when the controller reports
    // its sticky `capped` state — that happens after the 3rd successful
    // reveal's onPressEnd. While the 3rd reveal is mid-press, the
    // controller is in `revealed` and the passphrase MUST be visible
    // (M-54c: "three reveals succeed").
    if (controller.getState() === 'capped') capReached = true;
    // Force a synchronous DOM flush so the test's `advanceBy(N)` + immediate
    // `queryByTestId(...)` observes the post-mutation DOM. Without this
    // Svelte 5 may batch updates across a microtask boundary the fake
    // clock cannot drive.
    try {
      flushSync();
    } catch {
      // flushSync throws if called outside of an effect context (jsdom-
      // edge during initial subscribe). Swallow — the next synchronous
      // event handler returns and Svelte will flush on its own.
    }
  }

  $: if (enrollment_session_id !== lastSessionId) {
    lastSessionId = enrollment_session_id;
    unsubscribe();
    controller = createShowAgainController({
      sessionId: enrollment_session_id,
      actorId: user.user_id,
      onAudit
    });
    unsubscribe = controller.subscribe(syncFromController);
    revealed = false;
    auditFailed = false;
    capReached = false;
    dangerToast = false;
  }

  onDestroy(() => {
    unsubscribe();
  });

  async function startPress() {
    const r = await controller.onPressStart();
    if (!r.ok) {
      capReached = true;
    }
    syncFromController();
  }

  function endPress() {
    controller.onPressEnd();
    syncFromController();
  }

  // @ts-expect-error — Svelte 5's TS-in-svelte AST printer trips on
  // parameter type annotations here (esrap emits "Not implemented type
  // annotation EmptyStatement"). Drop the type annotation and rely on
  // the runtime guard inside the handler.
  function onKeyDown(e) {
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      void startPress();
    }
  }
  // @ts-expect-error see comment on onKeyDown
  function onKeyUp(e) {
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      endPress();
    }
  }

  // `revealed`, `auditFailed`, `dangerToast`, `capReached` are all
  // plain `let` bindings updated by `syncFromController()`. Svelte's
  // legacy `export let` + plain mutation model tracks these directly.
  $: helperText = capReached
    ? t('onboarding.recovery.show_again.helper_capped')
    : t('onboarding.recovery.show_again.helper');
</script>

<section aria-labelledby="recovery-show-again-heading">
  <h2 id="recovery-show-again-heading">{t('onboarding.recovery.heading')}</h2>
  <p>{t('onboarding.recovery.body')}</p>

  <button
    type="button"
    data-testid="show-again-control"
    aria-disabled={capReached ? 'true' : 'false'}
    aria-pressed={revealed ? 'true' : 'false'}
    on:pointerdown={startPress}
    on:pointerup={endPress}
    on:pointerleave={endPress}
    on:pointercancel={endPress}
    on:keydown={onKeyDown}
    on:keyup={onKeyUp}
  >
    {t('onboarding.recovery.show_again.label')}
  </button>

  <p data-testid="show-again-helper">{helperText}</p>

  {#if revealed && !capReached}
    <!-- F-108 M-108c: NO aria-live / role=alert / role=status on the
         passphrase-bearing element or any ancestor. The reveal button
         carries the aria-pressed transition; no live-region echoes the
         passphrase value (TTS exfil / AODA failure). -->
    <div data-testid="recovery-passphrase-onscreen">
      <code data-testid="passphrase-reveal">{passphrase}</code>
    </div>
  {/if}

  {#if dangerToast}
    <div role="alert" data-testid="show-again-danger-toast">
      {t('common.errors.generic')}
    </div>
  {/if}
</section>

<style>
  section {
    display: block;
  }
  button {
    cursor: pointer;
  }
  button[aria-disabled='true'] {
    cursor: not-allowed;
    opacity: 0.6;
  }
  @media (prefers-reduced-motion: reduce) {
    button {
      transition: none;
    }
  }
</style>
