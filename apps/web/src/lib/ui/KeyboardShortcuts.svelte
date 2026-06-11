<script>
  /**
   * KeyboardShortcuts — global "?" key opens a modal listing the
   * keyboard shortcuts available across the app.
   *
   * Why a modal vs a help page: the page (/help) lives at a known URL
   * for direct linking, while the modal gives instant in-context
   * recall without navigating away from the surface the worker is on.
   * Both surfaces read the same i18n keys so they stay in sync.
   *
   * Behaviour:
   *   - Listens for `?` globally. Ignores the keystroke when focus is
   *     inside a text input / textarea / contenteditable so typing
   *     literal `?` in those fields still works.
   *   - Esc closes the modal.
   *   - Focus is moved to the close button when the modal opens, and
   *     returned to the previously-focused element on close.
   *   - The modal is `role="dialog"` + `aria-modal="true"` per WAI-ARIA.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount, onDestroy, tick } from 'svelte';
  import { t } from '$lib/i18n';

  let open = false;
  /** @type {HTMLElement | null} */
  let previouslyFocused = null;
  /** @type {HTMLButtonElement | null} */
  let closeBtn = null;

  function isTypingTarget(target) {
    if (!(target instanceof Element)) return false;
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (target.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  async function show() {
    previouslyFocused = /** @type {HTMLElement | null} */ (
      typeof document !== 'undefined' ? document.activeElement : null
    );
    open = true;
    await tick();
    closeBtn?.focus();
  }

  function hide() {
    open = false;
    previouslyFocused?.focus?.();
    previouslyFocused = null;
  }

  /** @param {KeyboardEvent} e */
  function onGlobalKeydown(e) {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      hide();
      return;
    }
    if (e.key === '?' && !open) {
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      void show();
    }
  }

  onMount(() => {
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', onGlobalKeydown);
    }
  });

  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', onGlobalKeydown);
    }
  });

  const ROWS = /** @type {const} */ ([
    { key: 'slash', i18nKey: 'search' },
    { key: 'question', i18nKey: 'shortcuts' },
    { key: 'escape', i18nKey: 'escape' }
  ]);
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="ks-backdrop"
    data-testid="keyboard-shortcuts-backdrop"
    data-print="hide"
    on:click={hide}
    role="presentation"
  >
    <div
      class="ks-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ks-heading"
      data-testid="keyboard-shortcuts-dialog"
      on:click|stopPropagation
      on:keydown|stopPropagation
    >
      <header class="ks-header">
        <h2 id="ks-heading">{t('common.keyboardShortcuts.heading')}</h2>
        <button
          type="button"
          class="ks-close"
          aria-label={t('common.keyboardShortcuts.close_aria')}
          data-testid="keyboard-shortcuts-close"
          bind:this={closeBtn}
          on:click={hide}
        >
          ×
        </button>
      </header>
      <dl class="ks-list" data-testid="keyboard-shortcuts-list">
        {#each ROWS as r (r.key)}
          <div class="ks-row" data-key={r.key}>
            <dt>
              <kbd>{t(`common.keyboardShortcuts.key.${r.key}`)}</kbd>
            </dt>
            <dd>{t(`common.keyboardShortcuts.rows.${r.i18nKey}`)}</dd>
          </div>
        {/each}
      </dl>
      <p class="ks-hint muted">{t('common.keyboardShortcuts.share_hint')}</p>
      <p class="ks-actions">
        <button type="button" class="btn-outline" on:click={hide}>
          {t('common.keyboardShortcuts.close')}
        </button>
      </p>
    </div>
  </div>
{/if}

<style>
  .ks-backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 50%);
    display: grid;
    place-items: center;
    z-index: 1000;
  }
  .ks-dialog {
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 1rem 1.25rem;
    max-inline-size: min(90vw, 28rem);
    inline-size: 100%;
    box-shadow: 0 10px 30px rgb(0 0 0 / 25%);
  }
  .ks-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-block-end: 0.5rem;
  }
  .ks-header h2 {
    margin: 0;
    font-size: 1rem;
  }
  .ks-close {
    background: transparent;
    border: none;
    color: var(--color-fg);
    font-size: 1.25rem;
    line-height: 1;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-sm);
  }
  .ks-close:hover {
    background: var(--color-muted);
  }
  .ks-list {
    margin: 0 0 0.75rem;
    padding: 0;
    display: grid;
    gap: 0.375rem;
  }
  .ks-row {
    display: grid;
    grid-template-columns: 4rem 1fr;
    align-items: baseline;
    gap: 0.75rem;
  }
  .ks-row dt {
    margin: 0;
  }
  .ks-row dd {
    margin: 0;
    font-size: 0.875rem;
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    padding: 0.125rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-muted);
    color: var(--color-fg);
  }
  .ks-hint {
    font-size: 0.75rem;
    margin-block: 0.5rem 0.75rem;
  }
  .ks-actions {
    margin: 0;
    display: flex;
    justify-content: flex-end;
  }
</style>
