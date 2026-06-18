<script>
  /**
   * /search — cross-register search surface.
   *
   * One input. Updates the URL `?q=<query>` so a worker can paste
   * /share / bookmark a search. Results are grouped by register
   * (concerns, recommendations, …, audit) with at most 5 records
   * per group; each result deep-links to its register surface.
   *
   * The index is built once at mount over the demo providers; when
   * each register's real backend lands the page swaps in a real
   * search adapter without UI changes.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import { buildSearchIndex, search } from '$lib/search/search';
  import { highlightMatches } from '$lib/search/highlight';
  import { listRecentSearches, recordRecentSearch } from '$lib/search/recent-searches';
  import { listRecentRoutes } from '$lib/nav/recent-routes';

  /** @type {ReturnType<typeof buildSearchIndex>} */
  let index = [];

  /** @type {string[]} */
  let recents = [];

  /** @type {import('$lib/nav/recent-routes').RecentRoute[]} */
  let recentRoutes = [];

  onMount(() => {
    index = buildSearchIndex();
    recents = listRecentSearches();
    recentRoutes = listRecentRoutes();
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', onSearchKeydown);
    }
  });

  // Record the query whenever it transitions from empty → non-empty.
  // The header SubmitEvent path already records, but workers landing
  // on /search?q=… (via share link, browser autocomplete, or our own
  // chip click) should still get their query into the history.
  let lastRecorded = '';
  $: {
    const q = $page.url.searchParams.get('q')?.trim() ?? '';
    // `lastRecorded = q` below is READ on the NEXT reactive invocation (the
    // `q !== lastRecorded` predicate two lines up), not in this block. The
    // no-useless-assignment rule's intra-block flow analysis cannot see
    // cross-invocation reads, so the assignment is suppressed.
    if (q && q !== lastRecorded) {
      recordRecentSearch(q);
      recents = listRecentSearches();
      // eslint-disable-next-line no-useless-assignment
      lastRecorded = q;
    }
  }

  /** @type {HTMLInputElement | null} */
  let inputEl = null;

  /** @param {string} value */
  function updateQuery(value) {
    const url = new URL($page.url);
    if (value.trim()) url.searchParams.set('q', value);
    else url.searchParams.delete('q');
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }

  /** @param {Event} ev */
  function onInput(ev) {
    const v = /** @type {HTMLInputElement} */ (ev.currentTarget).value;
    updateQuery(v);
  }

  $: query = $page.url.searchParams.get('q') ?? '';
  $: groups = search(index, query);
  $: totalMatches = groups.reduce((a, g) => a + g.total, 0);

  /**
   * Flat list of every result record across every group. Used by
   * the j/k keyboard nav so a single index walks the rendered
   * order. Re-derived whenever groups change.
   */
  $: flatResults = groups.flatMap((g) => g.records);

  /**
   * Active result index for keyboard navigation. -1 means no result
   * is active; resets when the query changes.
   */
  let activeResultIndex = -1;
  $: if (query) activeResultIndex = -1;

  /**
   * When the active row changes via the keyboard, scroll the matching
   * `<li>` into view if it's off-screen. We anchor by id so the DOM
   * lookup is O(1) and survives the `{#each ... (record.id)}` keyed
   * loop. `block: 'nearest'` keeps the view stable when the row is
   * already visible (no flash).
   */
  $: if (typeof document !== 'undefined' && activeResultIndex >= 0) {
    const el = document.getElementById(`search-result-${activeResultIndex}`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  /**
   * `j` / `k` (vim-style) + ArrowDown / ArrowUp step through the
   * flattened result list. Enter opens the active result. Ignored
   * when focus is inside a typing target (so typing the literal
   * "j" in the search input still works) or when a modifier is
   * held (so Cmd/Ctrl+K stays the browser default).
   *
   * @param {KeyboardEvent} ev
   */
  function onSearchKeydown(ev) {
    if (ev.defaultPrevented) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const target = ev.target;
    if (target instanceof Element) {
      const tag = target.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (target.getAttribute('contenteditable') === 'true') return;
    }
    if (flatResults.length === 0) return;
    if (ev.key === 'j' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      activeResultIndex = activeResultIndex < flatResults.length - 1 ? activeResultIndex + 1 : 0;
    } else if (ev.key === 'k' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      activeResultIndex = activeResultIndex > 0 ? activeResultIndex - 1 : flatResults.length - 1;
    } else if (ev.key === 'Enter' && activeResultIndex >= 0) {
      const item = flatResults[activeResultIndex];
      if (!item) return;
      ev.preventDefault();
      if (typeof window !== 'undefined') {
        window.location.href = item.href;
      }
    }
  }

  /**
   * Map a (groupIdx, recordIdx) pair to the flat index so the
   * markup can stamp the right `is-active` class.
   * @param {number} groupIdx
   * @param {number} recordIdx
   */
  function flatIndex(groupIdx, recordIdx) {
    let off = 0;
    for (let g = 0; g < groupIdx; g++) off += groups[g]?.records.length ?? 0;
    return off + recordIdx;
  }

  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', onSearchKeydown);
    }
  });
</script>

<svelte:head>
  <title>{t('search.page.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card search-card" data-testid="search-page">
  <header class="search-header">
    <h1 id="search-heading">{t('search.page.heading')}</h1>
    <p class="muted">{t('search.page.intro')}</p>
  </header>

  <label class="search-field" for="search-input">
    <span class="search-label-text">{t('search.page.label')}</span>
    <input
      id="search-input"
      bind:this={inputEl}
      type="search"
      autocomplete="off"
      spellcheck="false"
      autocapitalize="none"
      autocorrect="off"
      value={query}
      on:input={onInput}
      placeholder={t('search.page.placeholder')}
      data-testid="search-input"
      aria-describedby="search-help"
    />
    <span class="muted" id="search-help">{t('search.page.helper')}</span>
  </label>

  {#if !query.trim()}
    <p class="muted" role="status" data-testid="search-empty-state">
      {t('search.page.empty_state')}
    </p>
    {#if recentRoutes.length > 0}
      <nav
        class="search-recents"
        aria-label={t('search.page.recent_routes_label')}
        data-testid="search-recents-routes"
      >
        <p class="search-recents-label">{t('search.page.recent_routes_label')}</p>
        <ul class="search-recents-list">
          {#each recentRoutes as r (r.route)}
            <li>
              <a
                class="search-recents-chip"
                href={r.route}
                data-testid="search-recents-route-chip"
                data-route={r.route}
              >
                {r.route}
              </a>
            </li>
          {/each}
        </ul>
      </nav>
    {/if}
    {#if recents.length > 0}
      <nav
        class="search-recents"
        aria-label={t('search.page.recents_aria')}
        data-testid="search-recents"
      >
        <p class="search-recents-label">{t('search.page.recents_label')}</p>
        <ul class="search-recents-list">
          {#each recents as r (r)}
            <li>
              <a
                class="search-recents-chip"
                href={`/search?q=${encodeURIComponent(r)}`}
                data-testid="search-recents-chip"
                data-q={r}
              >
                {r}
              </a>
            </li>
          {/each}
        </ul>
      </nav>
    {/if}
  {:else if groups.length === 0}
    <p class="muted" role="status" data-testid="search-no-results">
      {t('search.page.no_results', { query })}
    </p>
  {:else}
    <p class="muted" data-testid="search-summary">
      {t('search.page.summary', { count: totalMatches, query })}
    </p>
    <ul class="search-groups" data-testid="search-groups">
      {#each groups as group, groupIdx (group.register)}
        <li class="search-group" data-testid="search-group" data-register={group.register}>
          <header class="search-group-head">
            <h2>{t(`search.page.register.${group.register}`)}</h2>
            <span class="muted" data-testid="search-group-total"
              >{t('search.page.group_total', { count: group.total })}</span
            >
          </header>
          <ul class="search-result-list">
            {#each group.records as record, recordIdx (record.id)}
              {@const flatIdx = flatIndex(groupIdx, recordIdx)}
              <li
                id={`search-result-${flatIdx}`}
                class="search-result"
                class:is-active={activeResultIndex === flatIdx}
                data-testid="search-result"
                data-active={activeResultIndex === flatIdx ? 'true' : 'false'}
              >
                <a class="search-result-link" href={record.href} data-testid="search-result-link">
                  <span class="search-result-primary" data-testid="search-result-primary">
                    {#each highlightMatches(record.primaryText, query) as seg, i (i)}
                      {#if seg.match}
                        <mark class="search-mark">{seg.text}</mark>
                      {:else}{seg.text}{/if}
                    {/each}
                  </span>
                  {#if record.secondaryText}
                    <span class="search-result-secondary">
                      {#each highlightMatches(record.secondaryText, query) as seg, i (i)}
                        {#if seg.match}
                          <mark class="search-mark">{seg.text}</mark>
                        {:else}{seg.text}{/if}
                      {/each}
                    </span>
                  {/if}
                  <time class="search-result-date">{record.date.replace(/T.*$/, '')}</time>
                </a>
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  {/if}

  <p class="search-footer" data-print="hide">
    <a href="/" data-testid="search-back-to-home">{t('search.page.back_to_home_cta')}</a>
  </p>
</section>

<style>
  .search-card {
    margin-block-start: 1rem;
  }
  .search-header {
    margin-block-end: 0.75rem;
  }
  .search-header h1 {
    margin-block: 0 0.25rem;
  }

  .search-field {
    display: grid;
    gap: 0.25rem;
    margin-block-end: 1rem;
  }
  .search-label-text {
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .search-field input {
    min-height: 2.5rem;
    padding-inline: 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-size: 1rem;
  }

  .search-groups {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0.75rem;
  }
  .search-group {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
  }
  .search-group-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.625rem 0.875rem;
    border-block-end: 1px solid var(--color-border);
  }
  .search-group-head h2 {
    margin: 0;
    font-size: 0.9375rem;
  }

  .search-result-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .search-result + .search-result {
    border-block-start: 1px solid var(--color-border);
  }
  .search-result-link {
    display: grid;
    gap: 0.125rem;
    padding: 0.5rem 0.875rem;
    color: var(--color-fg);
    text-decoration: none;
    transition: background-color 150ms ease;
  }
  .search-result.is-active {
    background: var(--color-muted);
  }
  .search-result-link:hover {
    background: var(--color-muted);
    text-decoration: none;
  }
  .search-result-primary {
    font-size: 0.875rem;
    font-weight: 500;
  }
  .search-result-secondary {
    font-size: 0.75rem;
    color: var(--color-fg-muted);
  }
  .search-result-date {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    color: var(--color-fg-muted);
  }

  .search-footer {
    margin-block-start: 0.75rem;
  }

  /* Highlight tint for matched substrings within results.
     Uses the worker-hub amber tint tokens so the highlight reads as
     a callout without competing with the destructive C4 accent. */
  .search-mark {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-radius: var(--radius-sm);
    padding: 0 0.125rem;
  }

  .search-recents {
    display: block;
    margin-block-start: 1rem;
  }
  .search-recents-label {
    margin: 0 0 0.375rem;
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-fg-muted);
  }
  .search-recents-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .search-recents-chip {
    display: inline-block;
    padding: 0.1875rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-size: 0.75rem;
    text-decoration: none;
  }
  .search-recents-chip:hover {
    background: var(--color-muted);
    text-decoration: none;
  }
</style>
