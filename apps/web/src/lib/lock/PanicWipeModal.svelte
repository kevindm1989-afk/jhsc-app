<!-- This component uses Svelte 4-style `export let` props + createEventDispatcher,
     so Svelte 5 compiles it in legacy component-API mode automatically. That
     lets callers use `component.$on('close', ...)` to subscribe to the
     dispatched close event (A-T19-RR-2 test contract). -->
<script>
  /**
   * PanicWipeModal — F-53 destructive_confirm + F-115 four-regex copy.
   *
   * Focus management (A11Y-T19-2 / finding #13):
   *   - On open, initial focus shifts to the type-back input (or to the
   *     dialog itself while the ready-delay is pending).
   *   - Tab / Shift-Tab cycles WITHIN the dialog (focus trap); the page
   *     behind the dialog is inert.
   *   - On close, focus is restored to whichever element opened the
   *     modal (the trigger button).
   *
   * @see ADR-0020 §Decision 2.c
   */
  import { t } from '../i18n';
  import { flushSync, tick, onDestroy, createEventDispatcher } from 'svelte';
  import { panicWipe } from './panic-wipe';
  import { MemoryWipeStore } from './wipe-store';

  const dispatch = createEventDispatcher();

  function syncFlush() {
    try {
      flushSync();
    } catch {
      /* outside effect ctx */
    }
  }

  export let open = false;
  export let surface = 'settings';

  // Focus management refs.
  /** @type {HTMLElement | null} */
  let dialogRoot = null;
  /** @type {HTMLInputElement | null} */
  let typeBackInputRef = null;
  /** @type {HTMLButtonElement | null} */
  let auditFailedCancelRef = null;
  /** @type {Element | null} */
  let priorFocus = null;

  function focusableWithin(root) {
    if (!root) return [];
    const sel =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(root.querySelectorAll(sel)).filter((el) => !el.hasAttribute('aria-hidden'));
  }

  async function onOpenFocus() {
    if (typeof document === 'undefined') return;
    priorFocus = document.activeElement;
    await tick();
    if (typeBackInputRef && typeof typeBackInputRef.focus === 'function') {
      typeBackInputRef.focus();
    } else if (dialogRoot && typeof dialogRoot.focus === 'function') {
      dialogRoot.focus();
    }
  }

  function restoreFocus() {
    if (priorFocus && typeof priorFocus.focus === 'function') {
      priorFocus.focus();
    }
    priorFocus = null;
  }

  // Trigger initial focus when `open` flips to true.
  $: if (open) void onOpenFocus();
  $: if (!open && priorFocus) restoreFocus();
  onDestroy(() => {
    if (priorFocus) restoreFocus();
  });

  export let __test_ready_delay_ms = undefined;
  export let __test_force_wipe_in_progress = undefined;
  export let __test_force_clear_failure = undefined;
  export let __test_auto_submit = undefined;
  export let __test_force_complete = undefined;
  export let __test_store = undefined;

  const __probe_test_ready = '__test_' + 'ready_delay_ms';
  if (import.meta.env.MODE === 'production') {
    __test_ready_delay_ms = undefined;
    __test_force_wipe_in_progress = undefined;
    __test_force_clear_failure = undefined;
    __test_auto_submit = undefined;
    __test_force_complete = undefined;
    __test_store = undefined;
  }
  void __probe_test_ready;

  const readyDelayMs = __test_ready_delay_ms ?? 200;
  let ready = readyDelayMs === 0;
  let typedPhrase = '';
  let wipeState = 'idle';
  let partialFailedClasses = [];
  // Persistent close announcement — lives OUTSIDE the {#if open} block so it
  // survives the modal unmount and the SR can read it after the dialog is gone.
  let closeAnnouncement = '';

  const LITERAL_PHRASE = t('onboarding.panic_wipe_d6.type_back_value');

  if (readyDelayMs > 0) {
    setTimeout(() => {
      ready = true;
      syncFlush();
    }, readyDelayMs);
  }

  if (__test_force_wipe_in_progress) wipeState = 'in_progress';
  if (__test_force_complete) wipeState = 'complete';
  if (__test_force_clear_failure && __test_auto_submit) {
    setTimeout(async () => {
      const store = new MemoryWipeStore();
      if (typeof store.__debugForceClearFailure === 'function') {
        store.__debugForceClearFailure(__test_force_clear_failure);
      }
      wipeState = 'in_progress';
      const r = await panicWipe({ store, surface });
      if (r.status === 'partially_completed') {
        wipeState = 'partial_failure';
        partialFailedClasses = r.partial_failure_classes ?? [];
      } else if (r.status === 'completed') {
        wipeState = 'complete';
      }
    }, 0);
  }

  function onPhraseInput(e) {
    const target = e.target;
    if (!ready) {
      target.value = '';
      typedPhrase = '';
      syncFlush();
      return;
    }
    typedPhrase = target.value;
    syncFlush();
  }

  function isPhraseMatched() {
    return typedPhrase.toUpperCase() === LITERAL_PHRASE.toUpperCase();
  }

  $: phraseMatched = typedPhrase.toUpperCase() === LITERAL_PHRASE.toUpperCase();
  $: primaryDisabled = !ready || !phraseMatched;

  async function onConfirm() {
    if (!ready || !isPhraseMatched()) return;
    wipeState = 'in_progress';
    const r = await panicWipe({ store: __test_store ?? undefined, surface });
    if (r.status === 'partially_completed') {
      wipeState = 'partial_failure';
      partialFailedClasses = r.partial_failure_classes ?? [];
    } else if (r.status === 'completed') {
      wipeState = 'complete';
    } else if (r.status === 'audit_failed') {
      wipeState = 'audit_failed';
      // A11Y (WCAG 2.4.3): the destructive button that held focus unmounts
      // with the idle branch. Move focus to the audit_failed Cancel so it is
      // not stranded on a detached node / dropped to <body>.
      await tick();
      if (auditFailedCancelRef && typeof auditFailedCancelRef.focus === 'function') {
        auditFailedCancelRef.focus();
      }
    }
  }

  function onCancel() {
    closeAnnouncement = t('a11y.onboarding.modal_close_announcement');
    open = false;
    dispatch('close');
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Tab') {
      // Focus trap (A11Y-T19-2): cycle within the dialog.
      const focusables = focusableWithin(dialogRoot);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
</script>

{#if open}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="panic-wipe-heading"
    tabindex="-1"
    bind:this={dialogRoot}
    on:keydown={onKeyDown}
  >
    <h1 id="panic-wipe-heading">{t('onboarding.panic_wipe_d6.modal_heading')}</h1>
    <!-- SR-only announcers: modal_open + destructive_confirm + (when
         applicable) panic_wipe_* state transitions. The visible heading
         carries the same information for sighted users. -->
    <span class="sr-only"
      >{t('a11y.onboarding.modal_open_announcement', {
        modal_name: t('onboarding.panic_wipe_d6.modal_heading')
      })}</span
    >
    <span class="sr-only">{t('a11y.onboarding.destructive_confirm_announcement')}</span>
    {#if wipeState === 'in_progress'}
      <div
        data-testid="panic-wipe-in-progress-overlay"
        aria-busy="true"
        role="alert"
        data-focus-ring-inner-token="color.light.onboarding.panic_overlay_fg"
      >
        <span>{t('onboarding.panic_wipe_d6.state.wiping')}</span>
        <span class="sr-only">{t('a11y.onboarding.panic_wipe_in_progress_announcement')}</span>
      </div>
    {:else if wipeState === 'partial_failure'}
      <div role="alert" data-testid="panic-wipe-partial-failure">
        <span class="sr-only">{t('a11y.onboarding.panic_wipe_partial_failure_announcement')}</span>
        {t('onboarding.panic_wipe_d6.error.partial_wipe', {
          failed_systems: partialFailedClasses.join(', ')
        })}
      </div>
    {:else if wipeState === 'complete'}
      <div role="status" data-testid="panic-wipe-complete-toast">
        <span class="sr-only">{t('a11y.onboarding.panic_wipe_complete_announcement')}</span>
        {t('onboarding.panic_wipe_d6.state.complete')}
      </div>
    {:else if wipeState === 'audit_failed'}
      <!-- A-T19-RR-1: audit-emit failed BEFORE any side-effect. Surface the
           recoverable error and keep the modal escapable (RR-2 Cancel). No
           in-progress overlay, no complete toast — nothing was destroyed. -->
      <div role="alert" data-testid="panic-wipe-audit-failed">
        {t('onboarding.panic_wipe_d6.error.audit_emit_failed')}
      </div>
      <button type="button" bind:this={auditFailedCancelRef} on:click={onCancel}>
        {t('onboarding.panic_wipe_d6.cancel_button')}
      </button>
    {:else}
      <div data-testid="panic-wipe-modal-body" aria-busy={!ready ? 'true' : null}>
        <p>{t('onboarding.panic_wipe_d6.modal_body_what_happens')}</p>
        <p>{t('onboarding.panic_wipe_d6.modal_body_what_doesnt')}</p>
        <p>{t('onboarding.panic_wipe_d6.modal_residual_risk_callout')}</p>
        <p>{t('onboarding.panic_wipe_d6.modal_recovery_reminder')}</p>
        <label for="panic-phrase-input">{t('onboarding.panic_wipe_d6.type_back_label')}</label>
        <input
          id="panic-phrase-input"
          type="text"
          bind:this={typeBackInputRef}
          aria-label={t('a11y.onboarding.panic_wipe_type_back_label')}
          aria-required="true"
          placeholder={t('onboarding.panic_wipe_d6.type_back_placeholder')}
          on:input={onPhraseInput}
        />
      </div>
      <button
        type="button"
        aria-disabled={primaryDisabled ? 'true' : 'false'}
        on:click={onConfirm}
        aria-label={t('onboarding.panic_wipe_d6.primary_button_destructive')}
      >
        {t('onboarding.panic_wipe_d6.primary_button_destructive')}
      </button>
      <button type="button" on:click={onCancel}>
        {t('onboarding.panic_wipe_d6.cancel_button')}
      </button>
    {/if}
  </div>
{/if}

<!-- A-T19-RR-2: persistent close announcer — lives OUTSIDE {#if open} so it
     survives the modal unmount and the SR can read the close announcement. -->
<span class="sr-only" aria-live="polite">{closeAnnouncement}</span>

<style>
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }
  /* A11Y-T19-7 / design-system §4.D.T19 panic-overlay-focus-ring rule.
     The two-layer focus ring inverts on the panic overlay surface: the
     outer ring uses border.focus (#fbbf24 amber), and the INNER ring
     uses foreground.primary so the high-contrast pair is legible on
     the near-black overlay (the standard inner-ring color is invisible
     at 1.0:1 on the overlay). Tokens land via the global CSS var
     namespace produced from design-tokens.json. */
  [role='dialog']:focus-visible {
    outline: 2px solid
      var(--color-light-onboarding-panic-overlay-fg, var(--color-light-foreground-primary, #16181d));
    outline-offset: 2px;
  }
  [data-testid='panic-wipe-in-progress-overlay'] {
    background: var(--color-light-onboarding-panic-overlay-bg, rgba(22, 24, 29, 0.92));
    color: var(--color-light-onboarding-panic-overlay-fg, #fbfbfa);
  }
  [data-testid='panic-wipe-in-progress-overlay']:focus-visible,
  [data-testid='panic-wipe-in-progress-overlay'] :focus-visible {
    /* Inverted inner ring per the design-system rule: on near-black the
       inner layer must be the foreground (light) color, not the standard
       focus_ring.inner (#16181d) which would render at 1.0:1 invisible. */
    outline: 2px solid
      var(--color-light-onboarding-panic-overlay-fg, var(--color-light-foreground-primary, #f3f4f6));
    outline-offset: 2px;
  }
  @media (prefers-color-scheme: dark) {
    [role='dialog']:focus-visible {
      outline-color: var(
        --color-dark-onboarding-panic-overlay-fg,
        var(--color-dark-foreground-primary, #f3f4f6)
      );
    }
    [data-testid='panic-wipe-in-progress-overlay'] {
      background: var(--color-dark-onboarding-panic-overlay-bg, rgba(0, 0, 0, 0.92));
      color: var(--color-dark-onboarding-panic-overlay-fg, #f3f4f6);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    * {
      transition-duration: var(--motion-duration-instant, 0s) !important;
      animation-duration: var(--motion-duration-instant, 0s) !important;
    }
  }
</style>
