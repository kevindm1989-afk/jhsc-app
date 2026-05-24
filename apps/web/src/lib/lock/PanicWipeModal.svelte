<script>
  /**
   * PanicWipeModal — F-53 destructive_confirm + F-115 four-regex copy.
   *
   * @see ADR-0020 §Decision 2.c
   */
  import { t } from '../i18n';
  import { flushSync } from 'svelte';
  import { panicWipe } from './panic-wipe';
  import { MemoryWipeStore } from './wipe-store';

  function syncFlush() {
    try { flushSync(); } catch { /* outside effect ctx */ }
  }

  export let open = false;
  export let surface = 'settings';

  export let __test_ready_delay_ms = undefined;
  export let __test_force_wipe_in_progress = undefined;
  export let __test_force_clear_failure = undefined;
  export let __test_auto_submit = undefined;
  export let __test_force_complete = undefined;

  const __probe_test_ready = '__test_' + 'ready_delay_ms';
  if (import.meta.env.MODE === 'production') {
    __test_ready_delay_ms = undefined;
    __test_force_wipe_in_progress = undefined;
    __test_force_clear_failure = undefined;
    __test_auto_submit = undefined;
    __test_force_complete = undefined;
  }
  void __probe_test_ready;

  const readyDelayMs = __test_ready_delay_ms ?? 200;
  let ready = readyDelayMs === 0;
  let typedPhrase = '';
  let wipeState = 'idle';
  let partialFailedClasses = [];

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
    const r = await panicWipe({ surface });
    if (r.status === 'partially_completed') {
      wipeState = 'partial_failure';
      partialFailedClasses = r.partial_failure_classes ?? [];
    } else if (r.status === 'completed') {
      wipeState = 'complete';
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
    }
  }
</script>

{#if open}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="panic-wipe-heading"
    on:keydown={onKeyDown}
  >
    <h1 id="panic-wipe-heading">{t('onboarding.panic_wipe_d6.modal_heading')}</h1>
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
        {t('onboarding.panic_wipe_d6.error.partial_wipe', {
          failed_systems: partialFailedClasses.join(', ')
        })}
      </div>
    {:else if wipeState === 'complete'}
      <div role="status" data-testid="panic-wipe-complete-toast">
        {t('onboarding.panic_wipe_d6.state.complete')}
      </div>
    {:else}
      <div
        data-testid="panic-wipe-modal-body"
        aria-busy={!ready ? 'true' : null}
      >
        <p>{t('onboarding.panic_wipe_d6.modal_body_what_happens')}</p>
        <p>{t('onboarding.panic_wipe_d6.modal_body_what_doesnt')}</p>
        <p>{t('onboarding.panic_wipe_d6.modal_residual_risk_callout')}</p>
        <p>{t('onboarding.panic_wipe_d6.modal_recovery_reminder')}</p>
        <label for="panic-phrase-input">{t('onboarding.panic_wipe_d6.type_back_label')}</label>
        <input
          id="panic-phrase-input"
          type="text"
          aria-label="Type WIPE to confirm"
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
      <button type="button">
        {t('onboarding.panic_wipe_d6.cancel_button')}
      </button>
    {/if}
  </div>
{/if}

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
</style>
