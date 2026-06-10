<script>
  /**
   * RecommendationsViewer — JHSC recommendations register with the
   * 21-day OHSA s. 50(7)(c) employer-response timer.
   *
   * Same architectural pattern as AuditLogViewer / SensitiveFeedViewer
   * (backend-agnostic provider injection + pagination + worker-hub
   * styling), but the row layout is bespoke to surface the timer state
   * at a glance:
   *
   *   - Status chip: responded (green), pending (amber within 21
   *     days), overdue (red >21 days, auto-escalated to next meeting),
   *     archived (neutral).
   *   - "Day X / 21" indicator on the chip so the worker reads "Day 18
   *     of 21" without doing the math.
   *   - Traceability chip linking back to the concern or inspection
   *     that prompted the recommendation (F-19 traceability rule).
   *
   * Reads pages via `fetchPage(page, page_size)`; the T12 wire-up
   * swaps in a SupabaseRecommendationsClient with no viewer-side
   * changes.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import SkeletonRows from '$lib/ui/SkeletonRows.svelte';

  /**
   * @type {(page: number, page_size: number) => Promise<{
   *   rows: import('./demo-recommendations').DemoRecommendationRow[];
   *   total: number;
   *   page: number;
   *   page_size: number;
   * }>}
   */
  export let fetchPage = async () => {
    throw new Error('RecommendationsViewer: fetchPage not wired');
  };

  export let pageSize = 10;

  /** True when the route page has applied a filter; switches the
   *  empty state copy to a "no matches for this filter" message. */
  export let filterActive = false;

  /** @type {import('./demo-recommendations').DemoRecommendationRow[]} */
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

  /** @param {import('./demo-recommendations').RecommendationStatus} status */
  function statusLabel(status) {
    return t(`recommendations.viewer.status.${status}`);
  }

  $: pageCount = total === 0 ? 1 : Math.ceil(total / pageSize);
  $: hasPrev = page > 0 && !loading;
  $: hasNext = (page + 1) * pageSize < total && !loading;
</script>

<section
  class="recs-section"
  aria-labelledby="recs-heading"
  aria-busy={loading ? 'true' : 'false'}
  data-testid="recs-viewer-section"
>
  <header class="recs-header">
    <h1 id="recs-heading">{t('recommendations.viewer.heading')}</h1>
    <p class="muted">{t('recommendations.viewer.intro')}</p>
    <p class="recs-timer-note" data-testid="recs-timer-note">
      <strong>{t('recommendations.viewer.timer.label')}:</strong>
      {t('recommendations.viewer.timer.value')}
    </p>
  </header>

  {#if loading}
    <div role="status" aria-label={t('recommendations.viewer.loading')} data-testid="recs-loading">
      <SkeletonRows />
    </div>
  {:else if loadError}
    <p class="recs-alert" role="alert" data-testid="recs-load-error">
      {t('recommendations.viewer.error.load_failed')}
    </p>
  {:else if rows.length === 0}
    <p class="muted" role="status" data-testid="recs-empty">
      {filterActive ? t('common.filterEmptyState.no_matches') : t('recommendations.viewer.empty')}
    </p>
  {:else}
    <div class="recs-controls" data-testid="recs-controls">
      <button
        type="button"
        class="btn-outline"
        on:click={onPrev}
        disabled={!hasPrev}
        data-testid="recs-prev"
      >
        {t('recommendations.viewer.prev')}
      </button>
      <span class="recs-page-indicator" data-testid="recs-page-indicator">
        {t('recommendations.viewer.page_indicator', { page: page + 1, total: pageCount })}
        <span class="pagination-total" data-testid="pagination-total"
          >· {t('common.pagination.total_entries', { count: total })}</span
        >
      </span>
      <button
        type="button"
        class="btn-outline"
        on:click={onNext}
        disabled={!hasNext}
        data-testid="recs-next"
      >
        {t('recommendations.viewer.next')}
      </button>
    </div>

    <ul class="recs-list" data-testid="recs-list">
      {#each rows as row (row.id)}
        <li class="recs-row" data-testid="recs-row" data-status={row.status}>
          <div class="recs-row-head">
            <span
              class="recs-status-chip"
              class:responded={row.status === 'responded'}
              class:pending={row.status === 'pending'}
              class:overdue={row.status === 'overdue'}
              class:archived={row.status === 'archived'}
              data-testid="recs-status-chip"
            >
              {statusLabel(row.status)}
              {#if row.status === 'pending' || row.status === 'overdue'}
                <span class="recs-day-counter" data-testid="recs-day-counter">
                  · {t('recommendations.viewer.day_of', {
                    day: Math.min(row.days_elapsed, 99),
                    total: 21
                  })}
                </span>
              {/if}
            </span>
            <time class="recs-row-filed" data-testid="recs-row-filed"
              >{formatDate(row.filed_at)}</time
            >
          </div>
          <p class="recs-row-title" data-testid="recs-row-title">{row.title}</p>
          <div class="recs-row-chips">
            {#if row.traceability_concern_id}
              <span class="recs-trace-chip" data-testid="recs-trace-chip">
                <span class="recs-trace-key">{t('recommendations.viewer.from_concern')}:</span>
                <code>{row.traceability_concern_id}</code>
              </span>
            {/if}
            {#if row.traceability_inspection_id}
              <span class="recs-trace-chip" data-testid="recs-trace-chip">
                <span class="recs-trace-key">{t('recommendations.viewer.from_inspection')}:</span>
                <code>{row.traceability_inspection_id}</code>
              </span>
            {/if}
            <span class="recs-actor-chip">
              <span class="recs-trace-key">{t('recommendations.viewer.filed_by')}:</span>
              <code>{row.actor_pseudonym}</code>
            </span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .recs-section {
    display: block;
  }
  .recs-header {
    margin-block-end: 1rem;
  }
  .recs-timer-note {
    margin-block: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-tint-blue-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    font-size: 0.8125rem;
  }
  .recs-timer-note strong {
    font-weight: 600;
    margin-inline-end: 0.25rem;
  }

  .recs-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-block: 0.75rem;
  }
  .recs-controls .btn-outline {
    min-height: 2.25rem;
    padding-inline: 0.875rem;
    font-size: 0.8125rem;
  }
  .recs-page-indicator {
    color: var(--color-fg-muted);
    font-size: 0.8125rem;
    margin-inline-start: auto;
  }

  .recs-list {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .recs-row {
    display: block;
    padding: 0.875rem 1rem;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
  }
  .recs-row + .recs-row {
    border-block-start: 1px solid var(--color-border);
  }
  .recs-row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 0.75rem;
  }
  .recs-row-filed {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--color-fg-muted);
    margin-inline-start: auto;
  }

  /* Status chip — colour + label. The day-counter span inside is
     suppressed for responded / archived rows. */
  .recs-status-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-sm);
    border: 1px solid;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .recs-status-chip.responded {
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
    border-color: var(--color-tint-green-border);
  }
  .recs-status-chip.pending {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-color: var(--color-tint-amber-border);
  }
  .recs-status-chip.overdue {
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-color: var(--color-tint-red-border);
  }
  .recs-status-chip.archived {
    background: var(--color-tint-neutral-bg);
    color: var(--color-tint-neutral-fg);
    border-color: var(--color-tint-neutral-border);
  }
  .recs-day-counter {
    font-family: var(--font-mono);
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
  }

  .recs-row-title {
    margin-block: 0.5rem 0.5rem;
    font-size: 0.9375rem;
    line-height: 1.4;
  }

  .recs-row-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    font-size: 0.6875rem;
  }
  .recs-trace-chip,
  .recs-actor-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
    padding: 0.0625rem 0.375rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-muted);
  }
  .recs-trace-key {
    color: var(--color-fg-muted);
  }
  .recs-trace-chip code,
  .recs-actor-chip code {
    font-family: var(--font-mono);
    color: var(--color-fg);
  }

  .recs-alert {
    margin-block: 0.75rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-red-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
  }
</style>
