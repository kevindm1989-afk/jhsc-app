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
  import { onMount, onDestroy, tick } from 'svelte';
  import { t } from '$lib/i18n';
  import {
    deleteRecentSearch,
    listRecentSearches,
    recordRecentSearch
  } from '$lib/search/recent-searches';
  import { hrefForSavedView, listPinnedSavedViews } from '$lib/saved-views/saved-views';
  import { listRecentRoutes } from '$lib/nav/recent-routes';

  /** @type {HTMLInputElement | null} */
  let inputEl = null;

  /** @type {string[]} */
  let recents = [];

  /** @type {import('$lib/saved-views/saved-views').SavedView[]} */
  let pinnedViews = [];

  /** @type {import('$lib/nav/recent-routes').RecentRoute[]} */
  let recentRoutes = [];

  /** Whether the dropdown panel is open. */
  let recentsOpen = false;

  /**
   * Active row index across the combined dropdown (pinned views,
   * then recent searches). -1 means no row is active. Reset
   * whenever the panel opens, the source data changes, or the
   * worker types into the input.
   */
  let activeIndex = -1;

  /**
   * When the active row changes via the keyboard, scroll the matching
   * dropdown row into view. Same anchor-by-id trick as `/search` —
   * the rendered `<a>` carries `header-search-item-${i}` so the
   * lookup survives Svelte's keyed loop.
   */
  $: if (typeof document !== 'undefined' && recentsOpen && activeIndex >= 0) {
    const el = document.getElementById(`header-search-item-${activeIndex}`);
    // scrollIntoView is missing on some jsdom builds; guard so tests
    // and headless environments don't crash on the reactive update.
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * Build the flat ordered list of dropdown items so keyboard
   * navigation can walk a single array. Pinned views come first
   * (matching the panel's render order), then recent searches.
   *
   * @type {Array<{ kind: 'pinned', href: string, query?: string }
   *               | { kind: 'recent', href: string, query: string }>}
   */
  function buildItems() {
    /** @type {Array<{ kind: 'pinned' | 'route' | 'recent', href: string, query?: string }>} */
    const items = [];
    for (const v of pinnedViews) {
      items.push({ kind: 'pinned', href: hrefForSavedView(v) });
    }
    for (const r of recentRoutes) {
      items.push({ kind: 'route', href: r.route });
    }
    for (const q of recents) {
      items.push({ kind: 'recent', href: `/search?q=${encodeURIComponent(q)}`, query: q });
    }
    return items;
  }

  function refreshRecents() {
    recents = listRecentSearches();
    pinnedViews = listPinnedSavedViews();
    recentRoutes = listRecentRoutes();
    activeIndex = -1;
  }

  async function openRecents() {
    refreshRecents();
    if (recents.length > 0 || pinnedViews.length > 0 || recentRoutes.length > 0) {
      recentsOpen = true;
      await tick();
    }
  }

  function closeRecents() {
    recentsOpen = false;
  }

  function onFocus() {
    void openRecents();
  }

  /**
   * Close the dropdown when focus leaves the search region. Wrapped
   * in a microtask so a click on a recent-search link inside the
   * panel still fires before the panel is unmounted.
   * @param {FocusEvent} ev
   */
  function onBlur(ev) {
    const next = /** @type {Element | null} */ (ev.relatedTarget);
    if (next && next.closest('[data-testid="header-search"]')) return;
    setTimeout(closeRecents, 100);
  }

  /**
   * On submit, record the query and let the native GET proceed so
   * the no-JS fallback survives. SvelteKit's navigation picks it up
   * on the destination route.
   */
  function onSubmit() {
    const raw = inputEl?.value ?? '';
    if (raw.trim().length > 0) {
      recordRecentSearch(raw);
    }
  }

  /** @param {string} q */
  function onRemoveRecent(q) {
    deleteRecentSearch(q);
    refreshRecents();
    if (recents.length === 0) recentsOpen = false;
  }

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
      closeRecents();
    }
  }

  /**
   * Arrow / Enter handling on the input itself. Reads from the
   * combined `buildItems()` array so the order matches the panel
   * render order. Wraps at both ends so a worker reaching the last
   * row + ArrowDown lands back on the first.
   *
   * @param {KeyboardEvent} ev
   */
  function onInputKeydown(ev) {
    if (!recentsOpen) {
      // Reopen on ArrowDown when there's a payload to show.
      if (ev.key === 'ArrowDown') {
        const items = buildItems();
        if (items.length > 0) {
          ev.preventDefault();
          void openRecents();
          activeIndex = 0;
        }
      }
      return;
    }
    const items = buildItems();
    if (items.length === 0) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      activeIndex = activeIndex < items.length - 1 ? activeIndex + 1 : 0;
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      activeIndex = activeIndex > 0 ? activeIndex - 1 : items.length - 1;
    } else if (ev.key === 'Enter' && activeIndex >= 0) {
      const item = items[activeIndex];
      if (!item) return;
      ev.preventDefault();
      if (item.kind === 'recent' && item.query) recordRecentSearch(item.query);
      closeRecents();
      if (typeof window !== 'undefined') {
        window.location.href = item.href;
      }
    }
  }

  /**
   * Reset the active row when the worker types — once they're
   * editing the query, arrow-down should land on the first item,
   * not wherever the previous selection was.
   */
  function onInputInput() {
    activeIndex = -1;
  }

  onMount(() => {
    refreshRecents();
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
  on:submit={onSubmit}
  on:focusout={onBlur}
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
      role="combobox"
      aria-autocomplete="list"
      aria-controls="header-search-recents-panel"
      aria-expanded={recentsOpen ? 'true' : 'false'}
      aria-activedescendant={activeIndex >= 0 ? `header-search-item-${activeIndex}` : undefined}
      data-testid="header-search-input"
      on:focus={onFocus}
      on:keydown={onInputKeydown}
      on:input={onInputInput}
    />
  </label>
  {#if recentsOpen && (recents.length > 0 || pinnedViews.length > 0 || recentRoutes.length > 0)}
    <div
      id="header-search-recents-panel"
      class="hs-recents"
      role="listbox"
      aria-label={t('common.headerSearch.recent_aria')}
      data-testid="header-search-recents"
    >
      {#if pinnedViews.length > 0}
        <p class="hs-recents-label">{t('common.headerSearch.pinned_label')}</p>
        <ul class="hs-recents-list" data-testid="header-search-pinned">
          {#each pinnedViews as v, i (v.id)}
            <li
              class="hs-recents-row"
              class:is-active={activeIndex === i}
              data-testid="header-search-pinned-row"
              data-active={activeIndex === i ? 'true' : 'false'}
            >
              <a
                id={`header-search-item-${i}`}
                href={hrefForSavedView(v)}
                class="hs-recents-link hs-pinned-link"
                data-testid="header-search-pinned-link"
                data-id={v.id}
                role="option"
                aria-selected={activeIndex === i ? 'true' : 'false'}
                on:click={closeRecents}
              >
                <span class="hs-pinned-name">{v.name}</span>
                <span class="hs-pinned-route">{v.route}</span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
      {#if recentRoutes.length > 0}
        <p class="hs-recents-label">{t('common.headerSearch.routes_label')}</p>
        <ul class="hs-recents-list" data-testid="header-search-routes">
          {#each recentRoutes as r, j (r.route)}
            {@const flatIdx = pinnedViews.length + j}
            <li
              class="hs-recents-row"
              class:is-active={activeIndex === flatIdx}
              data-testid="header-search-route-row"
              data-active={activeIndex === flatIdx ? 'true' : 'false'}
            >
              <a
                id={`header-search-item-${flatIdx}`}
                href={r.route}
                class="hs-recents-link hs-route-link"
                data-testid="header-search-route-link"
                data-route={r.route}
                role="option"
                aria-selected={activeIndex === flatIdx ? 'true' : 'false'}
                on:click={closeRecents}
              >
                {r.route}
              </a>
            </li>
          {/each}
        </ul>
      {/if}
      {#if recents.length > 0}
        <p class="hs-recents-label">{t('common.headerSearch.recent_label')}</p>
        <ul class="hs-recents-list">
          {#each recents as q, j (q)}
            {@const flatIdx = pinnedViews.length + recentRoutes.length + j}
            <li
              class="hs-recents-row"
              class:is-active={activeIndex === flatIdx}
              data-testid="header-search-recent-row"
              data-active={activeIndex === flatIdx ? 'true' : 'false'}
            >
              <a
                id={`header-search-item-${flatIdx}`}
                href={`/search?q=${encodeURIComponent(q)}`}
                class="hs-recents-link"
                data-testid="header-search-recent-link"
                data-q={q}
                role="option"
                aria-selected={activeIndex === flatIdx ? 'true' : 'false'}
                on:click={() => {
                  recordRecentSearch(q);
                  closeRecents();
                }}
              >
                {q}
              </a>
              <button
                type="button"
                class="hs-recents-remove"
                data-testid="header-search-recent-remove"
                aria-label={t('common.headerSearch.recent_remove_aria', { query: q })}
                on:click={() => onRemoveRecent(q)}
              >
                ×
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
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

  .hs-form {
    position: relative;
  }
  .hs-recents {
    position: absolute;
    inset-block-start: 100%;
    inset-inline-end: 0;
    margin-block-start: 0.25rem;
    min-inline-size: 12rem;
    max-inline-size: 18rem;
    padding: 0.375rem 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg-elevated);
    box-shadow: var(--shadow-md);
    z-index: 50;
  }
  .hs-recents-label {
    margin: 0;
    padding: 0.125rem 0.625rem;
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-fg-muted);
  }
  .hs-recents-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .hs-recents-row {
    display: flex;
    align-items: center;
  }
  .hs-recents-row.is-active,
  .hs-recents-row.is-active .hs-recents-link {
    background: var(--color-muted);
  }
  .hs-recents-link {
    flex: 1;
    padding: 0.25rem 0.625rem;
    color: var(--color-fg);
    text-decoration: none;
    font-size: 0.8125rem;
  }
  .hs-recents-link:hover {
    background: var(--color-muted);
    text-decoration: none;
  }
  .hs-pinned-link {
    display: grid;
    gap: 0.125rem;
  }
  .hs-pinned-name {
    font-weight: 600;
  }
  .hs-pinned-route {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    color: var(--color-fg-muted);
  }
  .hs-recents-remove {
    background: transparent;
    border: none;
    color: var(--color-fg-muted);
    font-size: 0.875rem;
    line-height: 1;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
  }
  .hs-recents-remove:hover {
    color: var(--color-fg);
    background: var(--color-muted);
  }
  /* Hide on very narrow viewports — the worker has /search reachable
     from /more + a bottom-tab. */
  @media (max-width: 560px) {
    .hs-form {
      display: none;
    }
  }
</style>
