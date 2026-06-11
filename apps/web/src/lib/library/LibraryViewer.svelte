<script>
  /**
   * LibraryViewer — JHSC committee document library register.
   *
   * Same architectural pattern as the other register viewers (backend-
   * agnostic provider injection + pagination + worker-hub styling).
   * Bespoke row layout for versioned reference documents:
   *
   *   - Category pin (policy / procedure / training / legislation /
   *     template) — neutral-tinted; the library is reference material,
   *     not an event stream, so no urgency colours.
   *   - Version chip + last-updated date (versioned, no silent
   *     overwrites).
   *   - Language chip (EN / FR / EN+FR) — bilingual posture per doc.
   *   - Offline-cached chip (green) when readable beyond cell signal.
   *
   * Reads pages via `fetchPage(page, page_size)`; the library-module
   * wire-up swaps in a real client with no viewer-side changes.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import SkeletonRows from '$lib/ui/SkeletonRows.svelte';

  /**
   * @type {(page: number, page_size: number) => Promise<{
   *   rows: import('./demo-library').DemoLibraryRow[];
   *   total: number;
   *   page: number;
   *   page_size: number;
   * }>}
   */
  export let fetchPage = async () => {
    throw new Error('LibraryViewer: fetchPage not wired');
  };

  export let pageSize = 10;

  /** True when the route page has applied a filter; switches the
   *  empty state copy to a "no matches for this filter" message. */
  export let filterActive = false;

  /** When non-null, the active filter label echoes in the h1. */
  export let filterLabel = null;

  /**
   * Route URL to navigate to when the worker clicks "Clear filters"
   * in the empty state. Empty / null suppresses the link.
   * @type {string}
   */
  export let clearHref = '';

  /** @type {import('./demo-library').DemoLibraryRow[]} */
  let rows = [];
  let total = 0;
  let page = 0;
  let loading = true;
  let loadError = false;

  onMount(() => {
    void load(0);
  });

  /** @param {number} target */
  async function load(target) {
    loading = true;
    loadError = false;
    try {
      const r = await fetchPage(target, pageSize);
      rows = r.rows;
      total = r.total;
      page = r.page;
    } catch {
      loadError = true;
    } finally {
      loading = false;
    }
  }

  function onPrev() {
    if (loading) return;
    if (page > 0) void load(page - 1);
  }
  function onNext() {
    if (loading) return;
    if ((page + 1) * pageSize < total) void load(page + 1);
  }

  /** @param {string} iso */
  function formatDate(iso) {
    try {
      return iso.replace(/T.*$/, '');
    } catch {
      return iso;
    }
  }

  /** @param {import('./demo-library').LibraryCategory} category */
  function categoryLabel(category) {
    return t(`library.viewer.category.${category}`);
  }
  /** @param {import('./demo-library').LibraryLanguage} language */
  function languageLabel(language) {
    return t(`library.viewer.language.${language}`);
  }

  $: pageCount = total === 0 ? 1 : Math.ceil(total / pageSize);
  $: hasPrev = page > 0 && !loading;
  $: hasNext = (page + 1) * pageSize < total && !loading;
</script>

<section
  class="lib-section"
  aria-labelledby="lib-heading"
  aria-busy={loading ? 'true' : 'false'}
  data-testid="lib-viewer-section"
>
  <header class="lib-header">
    <h1 id="lib-heading">
      {t('library.viewer.heading')}{#if filterLabel}<span
          class="viewer-heading-filter"
          data-testid="viewer-heading-filter">{' '}— {filterLabel}</span
        >{/if}
    </h1>
    <p class="muted">{t('library.viewer.intro')}</p>
    <p class="lib-offline-note" data-testid="lib-offline-note">
      <strong>{t('library.viewer.offline_note.label')}:</strong>
      {t('library.viewer.offline_note.value')}
    </p>
  </header>

  {#if loading}
    <div role="status" aria-label={t('library.viewer.loading')} data-testid="lib-loading">
      <SkeletonRows />
    </div>
  {:else if loadError}
    <p class="lib-alert" role="alert" data-testid="lib-load-error">
      {t('library.viewer.error.load_failed')}
    </p>
  {:else if rows.length === 0}
    <div class="empty-state" data-testid="lib-empty" role="status">
      <p class="muted">
        {filterActive ? t('common.filterEmptyState.no_matches') : t('library.viewer.empty')}
      </p>
      {#if filterActive && clearHref}
        <p class="empty-state-actions">
          <a href={clearHref} class="empty-state-clear" data-testid="lib-empty-clear">
            {t('common.filterEmptyState.clear_filters')}
          </a>
        </p>
      {/if}
    </div>
  {:else}
    <div class="lib-controls" data-testid="lib-controls" data-print="hide">
      <button
        type="button"
        class="btn-outline"
        on:click={onPrev}
        disabled={!hasPrev}
        data-testid="lib-prev"
      >
        {t('library.viewer.prev')}
      </button>
      <span class="lib-page-indicator" data-testid="lib-page-indicator">
        {t('library.viewer.page_indicator', { page: page + 1, total: pageCount })}
        <span class="pagination-total" data-testid="pagination-total"
          >· {t('common.pagination.total_entries', { count: total })}</span
        >
      </span>
      <button
        type="button"
        class="btn-outline"
        on:click={onNext}
        disabled={!hasNext}
        data-testid="lib-next"
      >
        {t('library.viewer.next')}
      </button>
    </div>

    <ul class="lib-list" data-testid="lib-list">
      {#each rows as row (row.id)}
        <li class="lib-row" data-testid="lib-row" data-category={row.category} data-print="row">
          <div class="lib-row-head">
            <span class="lib-category-pin" data-testid="lib-category-pin">
              {categoryLabel(row.category)}
            </span>
            <span class="lib-version-chip" data-testid="lib-version-chip">
              <code>{row.version}</code>
            </span>
            <time class="lib-row-date" data-testid="lib-row-date">{formatDate(row.updated_at)}</time
            >
          </div>
          <p class="lib-row-title" data-testid="lib-row-title">{row.title}</p>
          <div class="lib-row-chips">
            <span class="lib-language-chip" data-testid="lib-language-chip">
              {languageLabel(row.language)}
            </span>
            {#if row.offline_cached}
              <span class="lib-offline-chip" data-testid="lib-offline-chip">
                {t('library.viewer.offline_cached')}
              </span>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .lib-section {
    display: block;
  }
  .lib-header {
    margin-block-end: 1rem;
  }
  .lib-offline-note {
    margin-block: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-tint-blue-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    font-size: 0.8125rem;
  }
  .lib-offline-note strong {
    font-weight: 600;
    margin-inline-end: 0.25rem;
  }

  .lib-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-block: 0.75rem;
  }
  .lib-controls .btn-outline {
    min-height: 2.25rem;
    padding-inline: 0.875rem;
    font-size: 0.8125rem;
  }
  .lib-page-indicator {
    color: var(--color-fg-muted);
    font-size: 0.8125rem;
    margin-inline-start: auto;
  }

  .lib-list {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .lib-row {
    display: block;
    padding: 0.875rem 1rem;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
  }
  .lib-row + .lib-row {
    border-block-start: 1px solid var(--color-border);
  }
  .lib-row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 0.75rem;
  }
  .lib-row-date {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--color-fg-muted);
    margin-inline-start: auto;
  }

  .lib-category-pin {
    display: inline-flex;
    align-items: center;
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--color-tint-neutral-border);
    background: var(--color-tint-neutral-bg);
    color: var(--color-tint-neutral-fg);
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .lib-version-chip {
    display: inline-flex;
    align-items: baseline;
    padding: 0.0625rem 0.375rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-muted);
    font-size: 0.6875rem;
  }
  .lib-version-chip code {
    font-family: var(--font-mono);
    color: var(--color-fg);
  }

  .lib-row-title {
    margin-block: 0.5rem 0.5rem;
    font-size: 0.9375rem;
    line-height: 1.4;
  }

  .lib-row-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    font-size: 0.6875rem;
  }
  .lib-language-chip,
  .lib-offline-chip {
    display: inline-flex;
    align-items: center;
    padding: 0.0625rem 0.375rem;
    border: 1px solid;
    border-radius: var(--radius-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .lib-language-chip {
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    border-color: var(--color-tint-blue-border);
  }
  .lib-offline-chip {
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
    border-color: var(--color-tint-green-border);
  }

  .lib-alert {
    margin-block: 0.75rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-red-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
  }
  .empty-state {
    display: grid;
    gap: 0.375rem;
    margin: 0.5rem 0;
  }
  .empty-state-actions {
    margin: 0;
  }
  .empty-state-clear {
    font-size: 0.8125rem;
    color: var(--color-fg-muted);
    text-decoration: none;
    padding: 0.25rem 0.625rem;
    border: 1px dashed var(--color-border);
    border-radius: 999px;
  }
  .empty-state-clear:hover {
    background: var(--color-muted);
    color: var(--color-fg);
    text-decoration: none;
  }
</style>
