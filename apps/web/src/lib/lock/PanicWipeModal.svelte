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
  import { getPanicWipeTestConfig } from './panic-wipe-test-config';

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
  /**
   * G-T19-PRIV-3 production wire-up: an explicit WipeStore (typically a
   * BrowserWipeStore constructed with `auditEmitter: createPanicWipeAuditEmitter(client)`
   * — see `apps/web/src/lib/server-client/t07-client-factory.ts`). When
   * provided, the wipe path routes through this store and its audit
   * emitter — meaning the `panic_wipe.invoked` row commits server-side
   * before any local destruction happens. When omitted the modal falls
   * back to `panicWipe`'s internal default store (the bare BrowserWipeStore
   * with no auditEmitter, which fails-closed on emitAudit) — back-compat
   * with all existing test renders + with deployments that haven't wired
   * a Supabase client yet.
   */
  export let wipeStore = undefined;

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

  // Test-only config read from a production-stripped seam (issue #120 /
  // A-T19-RR-4). Every read below is guarded by `!import.meta.env.PROD`, so
  // Vite DCE drops them in production → the seam import is unused → Rollup
  // tree-shakes the side-effect-free seam out and NO `__test_*` prop names
  // compile into the production bundle. In tests (MODE !== production) `__pc`
  // carries the per-render config set via `setPanicWipeTestConfig` before render.
  /** @type {import('./panic-wipe-test-config').PanicWipeTestConfig} */
  const __pc = !import.meta.env.PROD ? getPanicWipeTestConfig() : {};

  const readyDelayMs = (!import.meta.env.PROD ? __pc.readyDelayMs : undefined) ?? 200;
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

  if (!import.meta.env.PROD && __pc.forceWipeInProgress) wipeState = 'in_progress';
  if (!import.meta.env.PROD && __pc.forceComplete) wipeState = 'complete';
  // `import.meta.env.PROD` guard so Vite/Rollup DCE removes this entire
  // test-only block in a production build. It is the sole reference to
  // `MemoryWipeStore`; without the static guard the runtime test-prop check
  // alone can't be tree-shaken, so the whole MemoryWipeStore class (and its
  // __debug* error-injection seams) leaks into the production panic-wipe
  // chunk. The test props are already runtime-stripped to undefined in prod,
  // so this branch never executed there — the guard just lets the bundler
  // prove it. In tests (MODE !== production) PROD is false, so behaviour is
  // unchanged.
  if (!import.meta.env.PROD && __pc.forceClearFailure && __pc.autoSubmit) {
    setTimeout(async () => {
      const store = new MemoryWipeStore();
      if (typeof store.__debugForceClearFailure === 'function') {
        store.__debugForceClearFailure(__pc.forceClearFailure);
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
    // Precedence: the test-only store override (from the production-stripped
    // panic-wipe-test-config seam) wins, then the production `wipeStore` prop,
    // then panicWipe's internal default. The seam is the load-bearing contract
    // for the existing d6 / onboarding tests; the production prop is the wired
    // surface. The `!import.meta.env.PROD` guard keeps the seam read out of the
    // prod bundle, so production always resolves to `wipeStore ?? undefined`.
    const storeOverride =
      (!import.meta.env.PROD ? __pc.store : undefined) ?? wipeStore ?? undefined;
    const r = await panicWipe({ store: storeOverride, surface });
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
  <div class="panic-backdrop">
    <!-- The keydown listener implements the WAI-ARIA modal focus trap (Tab/Shift+Tab
         wrap); the dialog role + tabindex=-1 is the correct pattern. The listener is
         focus management, not a click affordance. -->
    <div
      class="panic-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="panic-wipe-heading"
      tabindex="-1"
      bind:this={dialogRoot}
      on:keydown={onKeyDown}
    >
      <h1 id="panic-wipe-heading" class="panic-heading">
        <svg
          class="panic-heading-icon"
          aria-hidden="true"
          width="24"
          height="24"
          viewBox="0 0 24 24"
        >
          <path
            d="M12 2L2 21h20L12 2z"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linejoin="round"
          />
          <path d="M12 9v5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          <circle cx="12" cy="17.5" r="1" fill="currentColor" />
        </svg>
        {t('onboarding.panic_wipe_d6.modal_heading')}
      </h1>
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
        <div class="panic-alert" role="alert" data-testid="panic-wipe-partial-failure">
          <span class="sr-only">{t('a11y.onboarding.panic_wipe_partial_failure_announcement')}</span
          >
          {t('onboarding.panic_wipe_d6.error.partial_wipe', {
            failed_systems: partialFailedClasses.join(', ')
          })}
        </div>
      {:else if wipeState === 'complete'}
        <div class="panic-status" role="status" data-testid="panic-wipe-complete-toast">
          <span class="sr-only">{t('a11y.onboarding.panic_wipe_complete_announcement')}</span>
          {t('onboarding.panic_wipe_d6.state.complete')}
        </div>
      {:else if wipeState === 'audit_failed'}
        <!-- A-T19-RR-1: audit-emit failed BEFORE any side-effect. Surface the
           recoverable error and keep the modal escapable (RR-2 Cancel). No
           in-progress overlay, no complete toast — nothing was destroyed. -->
        <div class="panic-alert" role="alert" data-testid="panic-wipe-audit-failed">
          {t('onboarding.panic_wipe_d6.error.audit_emit_failed')}
        </div>
        <div class="panic-action-row">
          <button
            type="button"
            class="panic-cancel"
            bind:this={auditFailedCancelRef}
            on:click={onCancel}
          >
            {t('onboarding.panic_wipe_d6.cancel_button')}
          </button>
        </div>
      {:else}
        <div data-testid="panic-wipe-modal-body" aria-busy={!ready ? 'true' : null}>
          <p>{t('onboarding.panic_wipe_d6.modal_body_what_happens')}</p>
          <p>{t('onboarding.panic_wipe_d6.modal_body_what_doesnt')}</p>
          <p>{t('onboarding.panic_wipe_d6.modal_residual_risk_callout')}</p>
          <p>{t('onboarding.panic_wipe_d6.modal_recovery_reminder')}</p>
          <label class="panic-phrase-label" for="panic-phrase-input">
            {t('onboarding.panic_wipe_d6.type_back_label')}
          </label>
          <input
            id="panic-phrase-input"
            class="panic-phrase-input"
            type="text"
            bind:this={typeBackInputRef}
            aria-label={t('a11y.onboarding.panic_wipe_type_back_label')}
            aria-required="true"
            placeholder={t('onboarding.panic_wipe_d6.type_back_placeholder')}
            on:input={onPhraseInput}
          />
        </div>
        <div class="panic-action-row">
          <button
            type="button"
            class="panic-primary"
            aria-disabled={primaryDisabled ? 'true' : 'false'}
            on:click={onConfirm}
            aria-label={t('onboarding.panic_wipe_d6.primary_button_destructive')}
          >
            {t('onboarding.panic_wipe_d6.primary_button_destructive')}
          </button>
          <button type="button" class="panic-cancel" on:click={onCancel}>
            {t('onboarding.panic_wipe_d6.cancel_button')}
          </button>
        </div>
      {/if}
    </div>
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

  /*
   * Modal scrim — fixed-position viewport overlay that darkens the
   * background behind the dialog. Reuses the existing panic-overlay-bg
   * token (the near-black 92% alpha surface used by the in-progress
   * overlay) so the scrim and the wipe state surface share a palette.
   * The dialog inside is centered with grid; vertical scroll is allowed
   * for short viewports.
   */
  .panic-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    padding: 1rem;
    overflow-y: auto;
    background: var(--color-light-onboarding-panic-overlay-bg, rgba(22, 24, 29, 0.7));
  }
  @media (prefers-color-scheme: dark) {
    .panic-backdrop {
      background: var(--color-dark-onboarding-panic-overlay-bg, rgba(0, 0, 0, 0.7));
    }
  }

  /*
   * Dialog card — elevated surface with destructive accent border. The
   * left-border stripe is the destructive-affordance signal echoing the
   * `.btn-destructive` class in app.css: every visible surface in the
   * panic-wipe ceremony shares the destructive-red signal.
   */
  .panic-dialog {
    width: 100%;
    max-width: 32rem;
    margin: auto;
    padding: 1.5rem;
    border: 1px solid var(--color-border);
    border-inline-start: 4px solid var(--color-destructive);
    border-radius: var(--radius);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    box-shadow: var(--shadow-lg);
  }
  .panic-dialog > :first-child {
    margin-block-start: 0;
  }
  .panic-dialog > :last-child {
    margin-block-end: 0;
  }
  .panic-heading {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--color-destructive);
  }
  .panic-heading-icon {
    flex: none;
    color: var(--color-destructive);
  }

  /* Type-back input — monospace block so the literal-phrase value is
     visually distinct from prose text and reads as a literal command. */
  .panic-phrase-label {
    display: block;
    margin-block: 1rem 0.375rem;
    color: var(--color-fg);
    font-weight: 500;
  }
  .panic-phrase-input {
    display: block;
    width: 100%;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-family: var(--font-mono);
    font-size: 1rem;
    letter-spacing: 0.08em;
  }
  .panic-phrase-input:focus-visible {
    outline: 2px solid var(--color-focus-inner);
    outline-offset: 1px;
    box-shadow: 0 0 0 4px var(--color-focus-outer);
  }

  /* Action row — primary destructive + cancel outline, side-by-side on
     desktop, stacked on narrow viewports. The destructive button is
     last in the source order so a quick-tap user lands on Cancel by
     default; but `aria-disabled` on the primary still gates submission
     until the phrase matches (F-115 contract). */
  .panic-action-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-block-start: 1.25rem;
  }
  .panic-primary {
    background: var(--color-destructive);
    color: var(--color-destructive-fg);
    border-color: var(--color-destructive);
  }
  .panic-primary[aria-disabled='true'] {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .panic-cancel {
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    border: 1px solid var(--color-border);
  }
  .panic-cancel:hover {
    background: var(--color-muted);
    opacity: 1;
  }

  /* Recoverable alerts (partial_failure, audit_failed) — red-tinted
     inline panels inside the card. The complete-toast uses the green
     status tint to signal the (irreversible) completion state. */
  .panic-alert {
    margin-block: 0.75rem 0;
    padding: 0.75rem 1rem;
    border: 1px solid var(--color-tint-red-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
  }
  .panic-status {
    margin-block: 0.75rem 0;
    padding: 0.75rem 1rem;
    border: 1px solid var(--color-tint-green-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
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
