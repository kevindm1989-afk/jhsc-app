<script>
  /**
   * SaveViewButton — small affordance that captures the current URL
   * (route + querystring) under a worker-supplied name and persists
   * it to the saved-views localStorage registry.
   *
   * UX: a single-click button that flips into an inline name input
   * + Save link. Saving emits a `view:saved` CustomEvent so the
   * route page can refresh its SavedViewsRail without a reload.
   *
   * Why localStorage (not the URL or a server): saved views are
   * per-device worker affordances — pseudonymous URL fragments + a
   * short label. The committee data they point at lives behind RLS;
   * the saved view is purely a navigation shortcut.
   *
   * Carries `data-print="hide"` so it never appears on paper handouts.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { tick } from 'svelte';
  import { t } from '$lib/i18n';
  import { addSavedView } from '$lib/saved-views/saved-views';

  /**
   * UI state machine. `idle` shows the trigger button; `naming`
   * shows the inline input; `saved` shows a brief confirmation.
   * @type {'idle' | 'naming' | 'saved'}
   */
  let mode = 'idle';
  let name = '';
  /** @type {HTMLInputElement | null} */
  let nameInput = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let resetTimer = null;

  async function openInput() {
    if (resetTimer) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
    mode = 'naming';
    name = '';
    await tick();
    nameInput?.focus();
  }

  function cancel() {
    mode = 'idle';
    name = '';
  }

  function saveNow() {
    const trimmed = name.trim();
    if (!trimmed) {
      nameInput?.focus();
      return;
    }
    if (typeof window === 'undefined') {
      // No window means no URL to save from (e.g. SSR build). Fail
      // silently; the button just resets.
      cancel();
      return;
    }
    const route = window.location.pathname;
    const search = window.location.search;
    const saved = addSavedView({ name: trimmed, route, search });
    // Cross-component refresh: SavedViewsRail listens on window for
    // this event so a newly-saved view appears without a reload.
    window.dispatchEvent(new CustomEvent('view:saved', { detail: saved }));
    mode = 'saved';
    name = '';
    resetTimer = setTimeout(() => {
      mode = 'idle';
      resetTimer = null;
    }, 1500);
  }

  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (mode !== 'naming') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      saveNow();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }
</script>

<div class="svb" data-testid="save-view" data-print="hide" data-mode={mode}>
  {#if mode === 'idle'}
    <button
      type="button"
      class="btn-outline svb-trigger"
      data-testid="save-view-trigger"
      on:click={openInput}
    >
      {t('common.savedViews.save_button')}
    </button>
  {:else if mode === 'naming'}
    <input
      type="text"
      class="svb-input"
      placeholder={t('common.savedViews.name_placeholder')}
      aria-label={t('common.savedViews.name_aria')}
      data-testid="save-view-name-input"
      bind:this={nameInput}
      bind:value={name}
      on:keydown={onKey}
      maxlength="80"
    />
    <button
      type="button"
      class="btn-outline svb-confirm"
      data-testid="save-view-confirm"
      on:click={saveNow}
    >
      {t('common.savedViews.save_confirm')}
    </button>
    <button
      type="button"
      class="svb-cancel"
      aria-label={t('common.savedViews.cancel_aria')}
      data-testid="save-view-cancel"
      on:click={cancel}
    >
      ×
    </button>
  {:else}
    <span class="svb-saved" data-testid="save-view-saved">
      {t('common.savedViews.saved_announce')}
    </span>
  {/if}
</div>

<style>
  .svb {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin-block-end: 0.75rem;
    margin-inline-start: 0.25rem;
  }
  .svb-trigger,
  .svb-confirm {
    min-height: 2.25rem;
    padding-inline: 0.875rem;
    font-size: 0.8125rem;
  }
  .svb-input {
    min-height: 2.25rem;
    padding-inline: 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-size: 0.8125rem;
    min-inline-size: 12rem;
  }
  .svb-cancel {
    background: transparent;
    border: none;
    color: var(--color-fg-muted);
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
    padding: 0.25rem 0.375rem;
    border-radius: var(--radius-sm);
  }
  .svb-cancel:hover {
    background: var(--color-muted);
    color: var(--color-fg);
  }
  .svb-saved {
    font-size: 0.8125rem;
    color: var(--color-tint-green-fg);
    padding-inline: 0.625rem;
    padding-block: 0.25rem;
    background: var(--color-tint-green-bg);
    border: 1px solid var(--color-tint-green-border);
    border-radius: var(--radius-sm);
  }
</style>
