<script>
  /**
   * HeaderSearch — compact search input that lives in the top bar
   * when the user is signed in.
   *
   * Submitting (Enter) navigates to /search?q=<query> via the form's
   * native GET to /search (the input `name` is `q`) so a no-JS
   * fallback still works.
   *
   * Keyboard shortcut: pressing "/" anywhere outside of an existing
   * input / textarea / contenteditable focuses this input. Pressing
   * Escape blurs it.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13. A sibling
   * `.svelte.d.ts` declares the component type so .ts importers
   * (the root +layout.svelte) resolve cleanly.
   */
  import { onMount, onDestroy } from 'svelte';
  import { t } from '$lib/i18n';

  /** @type {HTMLInputElement | null} */
  let inputEl = null;

  /** @param {EventTarget | null} target */
  function isTypingTarget(target) {
    if (!target || !(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable) return true;
    return false;
  }

  /** @param {KeyboardEvent} ev */
  function onGlobalKeydown(ev) {
    if (ev.defaultPrevented) return;
    if (ev.key === '/' && !isTypingTarget(ev.target)) {
      ev.preventDefault();
      inputEl?.focus();
      return;
    }
    if (ev.key === 'Escape' && document.activeElement === inputEl) {
      inputEl?.blur();
    }
  }

  onMount(() => {
    document.addEventListener('keydown', onGlobalKeydown);
  });

  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', onGlobalKeydown);
    }
  });
</script>

<form
  class="hs-form"
  role="search"
  action="/search"
  method="get"
  data-testid="header-search"
  data-print="hide"
>
  <label class="hs-label" for="header-search-input">
    <span class="hs-visually-hidden">{t('common.headerSearch.label')}</span>
    <input
      id="header-search-input"
      bind:this={inputEl}
      type="search"
      name="q"
      autocomplete="off"
      spellcheck="false"
      autocapitalize="none"
      autocorrect="off"
      placeholder={t('common.headerSearch.placeholder')}
      aria-label={t('common.headerSearch.label')}
      data-testid="header-search-input"
    />
  </label>
</form>

<style>
  .hs-form {
    display: flex;
    align-items: center;
  }
  .hs-label {
    display: contents;
  }
  .hs-visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .hs-form input {
    min-width: 0;
    width: 12rem;
    max-width: 100%;
    min-height: 2rem;
    padding-inline: 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-size: 0.8125rem;
  }
  /* Hide on very narrow viewports — the worker has /search reachable
     from /more + a bottom-tab. */
  @media (max-width: 560px) {
    .hs-form {
      display: none;
    }
  }
</style>
