<script>
  /**
   * ShortcutsHintPill — small, dismissable "Press ? for shortcuts" pill
   * shown to a worker once on a signed-in session so they discover the
   * keyboard-shortcuts modal without us bolting a tour onto the front
   * door.
   *
   * Visibility rule:
   *   - Default: visible.
   *   - Dismissed (× clicked OR worker pressed `?` once): persisted
   *     via `sessionStorage` under the `jhsc-shortcuts-hint-dismissed`
   *     key. SessionStorage (not localStorage) so a fresh tab session
   *     can re-surface the hint — it's a discoverability nudge, not a
   *     permanent opt-out.
   *   - Pre-onboarding (no JWT): the parent decides whether to mount
   *     this — the component itself does not gate on auth.
   *
   * Reads `data-print="hide"` so it never appears on paper handouts.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount, onDestroy } from 'svelte';
  import { t } from '$lib/i18n';

  const STORAGE_KEY = 'jhsc-shortcuts-hint-dismissed';

  let visible = true;

  function dismiss() {
    visible = false;
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(STORAGE_KEY, '1');
      }
    } catch {
      // sessionStorage can throw in private-mode Safari / sandboxed
      // contexts. Silently fall back to in-memory dismissal — the
      // hint is gone for this mount; the next mount may re-show it.
    }
  }

  /** @param {KeyboardEvent} e */
  function onKey(e) {
    // Once the worker discovers `?` themselves, dismiss the pill so
    // we don't keep nudging them.
    if (e.key === '?' && visible) dismiss();
  }

  onMount(() => {
    try {
      if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(STORAGE_KEY) === '1') {
        visible = false;
      }
    } catch {
      // ignore — see dismiss()
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', onKey);
    }
  });

  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', onKey);
    }
  });
</script>

{#if visible}
  <div class="shp" data-testid="shortcuts-hint-pill" data-print="hide">
    <span class="shp-text">
      {t('common.shortcutsHint.text_prefix')}
      <kbd>?</kbd>
      {t('common.shortcutsHint.text_suffix')}
    </span>
    <button
      type="button"
      class="shp-dismiss"
      aria-label={t('common.shortcutsHint.dismiss_aria')}
      data-testid="shortcuts-hint-dismiss"
      on:click={dismiss}
    >
      ×
    </button>
  </div>
{/if}

<style>
  .shp {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding-inline: 0.625rem;
    padding-block: 0.25rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-bg-elevated);
    font-size: 0.75rem;
    color: var(--color-fg-muted);
    margin-block-start: 0.5rem;
  }
  .shp-text {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    padding: 0.0625rem 0.375rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-muted);
    color: var(--color-fg);
  }
  .shp-dismiss {
    background: transparent;
    border: none;
    color: var(--color-fg-muted);
    font-size: 0.875rem;
    line-height: 1;
    cursor: pointer;
    padding: 0;
    padding-inline: 0.25rem;
    border-radius: var(--radius-sm);
  }
  .shp-dismiss:hover {
    color: var(--color-fg);
    background: var(--color-muted);
  }
</style>
