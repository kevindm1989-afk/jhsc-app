<script>
  /**
   * SensitiveFeedViewer — role-gated C3/C4 activity feed.
   *
   * Architecturally close to AuditLogViewer (same backend-agnostic
   * provider pattern, same pagination shape) but scoped to the
   * sensitive-tier subset. Adds:
   *   - Per-row sensitivity tier badge (C3 / C4) with worker-hub
   *     tinted colors so the gravity reads at a glance.
   *   - A role-gating callout above the list — the real backend
   *     enforces this (worker co-chair + worker certified member only);
   *     until then the viewer just frames the surface honestly so a
   *     curious member sees the expectation.
   *
   * Metadata-only contract: the feed surfaces ONLY the audit-row
   * metadata (event type, pseudonymized actor, timestamp, small meta
   * payload). The encrypted narrative content never appears here —
   * the real backend never returns it on this query, and the demo
   * provider doesn't synthesize it either.
   *
   * Reads pages via a `fetchPage(page, page_size)` provider function so
   * the surface is backend-agnostic; T-future swap-in replaces the
   * demo provider with a SupabaseSensitiveFeedClient.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { formatDateTime } from '$lib/ui/date-format';
  import SkeletonRows from '$lib/ui/SkeletonRows.svelte';

  /**
   * Page fetcher contract — returns a page of sensitive rows + the
   * total + page index + page size. Same shape as the audit viewer's
   * provider so the row-renderer can be shared if a future refactor
   * extracts it.
   *
   * @type {(page: number, page_size: number) => Promise<{
   *   rows: import('./demo-sensitive-feed').DemoSensitiveRow[];
   *   total: number;
   *   page: number;
   *   page_size: number;
   * }>}
   */
  export let fetchPage = async () => {
    throw new Error('SensitiveFeedViewer: fetchPage not wired');
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

  /** @type {import('./demo-sensitive-feed').DemoSensitiveRow[]} */
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
  function formatTimestamp(iso) {
    return formatDateTime(iso) || iso;
  }

  /** @param {Record<string, string | number | boolean | null>} meta */
  function metaEntries(meta) {
    return Object.entries(meta).slice(0, 3);
  }

  $: pageCount = total === 0 ? 1 : Math.ceil(total / pageSize);
  $: hasPrev = page > 0 && !loading;
  $: hasNext = (page + 1) * pageSize < total && !loading;
</script>

<section
  class="sensitive-feed-section"
  aria-labelledby="sensitive-feed-heading"
  aria-busy={loading ? 'true' : 'false'}
  data-testid="sensitive-feed-section"
>
  <header class="sensitive-feed-header">
    <h1 id="sensitive-feed-heading">
      {t('sensitiveFeed.viewer.heading')}{#if filterLabel}<span
          class="viewer-heading-filter"
          data-testid="viewer-heading-filter">{' '}— {filterLabel}</span
        >{/if}
    </h1>
    <p class="muted">{t('sensitiveFeed.viewer.intro')}</p>
    <p class="sensitive-feed-role-note" role="note" data-testid="sensitive-feed-role-note">
      <strong>{t('sensitiveFeed.viewer.role.label')}:</strong>
      {t('sensitiveFeed.viewer.role.value')}
    </p>
  </header>

  {#if loading}
    <div
      role="status"
      aria-label={t('sensitiveFeed.viewer.loading')}
      data-testid="sensitive-feed-loading"
    >
      <SkeletonRows />
    </div>
  {:else if loadError}
    <p class="sensitive-feed-alert" role="alert" data-testid="sensitive-feed-load-error">
      {t('sensitiveFeed.viewer.error.load_failed')}
    </p>
  {:else if rows.length === 0}
    <div class="empty-state" data-testid="sensitive-feed-empty" role="status">
      <p class="muted">
        {filterActive ? t('common.filterEmptyState.no_matches') : t('sensitiveFeed.viewer.empty')}
      </p>
      {#if filterActive && clearHref}
        <p class="empty-state-actions">
          <a href={clearHref} class="empty-state-clear" data-testid="sensitive-feed-empty-clear">
            {t('common.filterEmptyState.clear_filters')}
          </a>
        </p>
      {/if}
    </div>
  {:else}
    <div class="sensitive-feed-controls" data-testid="sensitive-feed-controls" data-print="hide">
      <button
        type="button"
        class="btn-outline"
        on:click={onPrev}
        disabled={!hasPrev}
        data-testid="sensitive-feed-prev"
      >
        {t('sensitiveFeed.viewer.prev')}
      </button>
      <span class="sensitive-feed-page-indicator" data-testid="sensitive-feed-page-indicator">
        {t('sensitiveFeed.viewer.page_indicator', { page: page + 1, total: pageCount })}
        <span class="pagination-total" data-testid="pagination-total"
          >· {t('common.pagination.total_entries', { count: total })}</span
        >
      </span>
      <button
        type="button"
        class="btn-outline"
        on:click={onNext}
        disabled={!hasNext}
        data-testid="sensitive-feed-next"
      >
        {t('sensitiveFeed.viewer.next')}
      </button>
    </div>

    <ul class="sensitive-feed-list" data-testid="sensitive-feed-list">
      {#each rows as row (row.id)}
        <li
          class="sensitive-row"
          class:c3={row.sensitivity === 'c3'}
          class:c4={row.sensitivity === 'c4'}
          data-testid="sensitive-row"
          data-sensitivity={row.sensitivity}
          data-print="row"
        >
          <div class="sensitive-row-head">
            <span class="sensitivity-badge" data-testid="sensitivity-badge"
              >{row.sensitivity.toUpperCase()}</span
            >
            <time class="sensitive-row-ts">{formatTimestamp(row.ts)}</time>
            <code class="sensitive-row-event" data-testid="sensitive-row-event"
              >{row.event_type}</code
            >
          </div>
          <div class="sensitive-row-actor-row">
            <span class="sensitive-row-actor-label">{t('sensitiveFeed.viewer.column.actor')}:</span>
            <code class="sensitive-row-actor" data-testid="sensitive-row-actor"
              >{row.actor_pseudonym}</code
            >
          </div>
          {#if metaEntries(row.meta).length > 0}
            <ul class="sensitive-row-meta" data-testid="sensitive-row-meta">
              {#each metaEntries(row.meta) as [k, v] (k)}
                <li class="sensitive-meta-chip">
                  <span class="sensitive-meta-key">{k}</span>
                  <span class="sensitive-meta-value">{String(v)}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .sensitive-feed-section {
    display: block;
  }
  .sensitive-feed-header {
    margin-block-end: 1rem;
  }
  .sensitive-feed-role-note {
    margin-block: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .sensitive-feed-role-note strong {
    font-weight: 600;
    margin-inline-end: 0.25rem;
  }

  .sensitive-feed-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-block: 0.75rem;
  }
  .sensitive-feed-controls .btn-outline {
    min-height: 2.25rem;
    padding-inline: 0.875rem;
    font-size: 0.8125rem;
  }
  .sensitive-feed-page-indicator {
    color: var(--color-fg-muted);
    font-size: 0.8125rem;
    margin-inline-start: auto;
  }

  .sensitive-feed-list {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  /*
   * Per-row tier bands — C3 keeps the neutral elevated surface; C4
   * adds a destructive-red inline-start border so the gravest events
   * read at a glance. Matches the C4 accent worker-hub uses on
   * /reprisal, /s51-evidence, and PanicWipeModal.
   */
  .sensitive-row {
    display: block;
    padding: 0.75rem 0.875rem;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    border-inline-start: 4px solid transparent;
  }
  .sensitive-row.c4 {
    border-inline-start-color: var(--color-destructive);
  }
  .sensitive-row + .sensitive-row {
    border-block-start: 1px solid var(--color-border);
  }
  .sensitive-row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.375rem 0.75rem;
  }
  .sensitivity-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.0625rem 0.4rem;
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .sensitive-row.c3 .sensitivity-badge {
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    border: 1px solid var(--color-tint-blue-border);
  }
  .sensitive-row.c4 .sensitivity-badge {
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border: 1px solid var(--color-tint-red-border);
  }
  .sensitive-row-ts {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--color-fg-muted);
  }
  .sensitive-row-event {
    font-family: var(--font-mono);
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-fg);
  }
  .sensitive-row-actor-row {
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
    margin-block-start: 0.25rem;
    font-size: 0.75rem;
  }
  .sensitive-row-actor-label {
    color: var(--color-fg-muted);
  }
  .sensitive-row-actor {
    font-family: var(--font-mono);
    color: var(--color-fg);
  }
  .sensitive-row-meta {
    list-style: none;
    padding: 0;
    margin: 0.5rem 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .sensitive-meta-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
    padding: 0.0625rem 0.375rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-muted);
    font-size: 0.6875rem;
  }
  .sensitive-meta-key {
    color: var(--color-fg-muted);
  }
  .sensitive-meta-value {
    font-family: var(--font-mono);
    color: var(--color-fg);
  }

  .sensitive-feed-alert {
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
