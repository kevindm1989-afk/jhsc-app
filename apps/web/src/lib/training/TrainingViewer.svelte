<script>
  /**
   * TrainingViewer — JHSC training-records register.
   *
   * Same architectural pattern as the other register viewers (backend-
   * agnostic provider injection + pagination + worker-hub styling).
   * Bespoke row layout for OHSA s. 9(12)(d) certified-member tracking:
   *
   *   - Validity pin: valid (green) / expiring ≤60 days (amber) /
   *     expired (red). The refresher backlog reads at a glance — that
   *     is this surface's whole job.
   *   - Day counter inside the chip row: "N days left" for valid +
   *     expiring; "N days overdue" for expired.
   *   - Evidence-attached chip when a certificate scan is on file.
   *   - Pseudonymized member chip — names never appear; the real
   *     backend joins pseudonyms to display identities only for
   *     authorized roles.
   *
   * Reads pages via `fetchPage(page, page_size)`; the training-module
   * wire-up swaps in a real client with no viewer-side changes.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { formatDateShort } from '$lib/ui/date-format';
  import SkeletonRows from '$lib/ui/SkeletonRows.svelte';

  /**
   * @type {(page: number, page_size: number) => Promise<{
   *   rows: import('./demo-training').DemoTrainingRow[];
   *   total: number;
   *   page: number;
   *   page_size: number;
   * }>}
   */
  export let fetchPage = async () => {
    throw new Error('TrainingViewer: fetchPage not wired');
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

  /** @type {import('./demo-training').DemoTrainingRow[]} */
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
    return formatDateShort(iso) || iso;
  }

  /** @param {import('./demo-training').TrainingValidity} validity */
  function validityLabel(validity) {
    return t(`training.viewer.validity.${validity}`);
  }

  /** @param {import('./demo-training').DemoTrainingRow} row */
  function expiryText(row) {
    if (row.validity === 'expired') {
      return t('training.viewer.days_overdue', { days: row.days_to_expiry });
    }
    return t('training.viewer.days_left', { days: row.days_to_expiry });
  }

  $: pageCount = total === 0 ? 1 : Math.ceil(total / pageSize);
  $: hasPrev = page > 0 && !loading;
  $: hasNext = (page + 1) * pageSize < total && !loading;
</script>

<section
  class="trn-section"
  aria-labelledby="trn-heading"
  aria-busy={loading ? 'true' : 'false'}
  data-testid="trn-viewer-section"
>
  <header class="trn-header">
    <h1 id="trn-heading">
      {t('training.viewer.heading')}{#if filterLabel}<span
          class="viewer-heading-filter"
          data-testid="viewer-heading-filter">{' '}— {filterLabel}</span
        >{/if}
    </h1>
    <p class="muted">{t('training.viewer.intro')}</p>
    <p class="trn-refresher-note" data-testid="trn-refresher-note">
      <strong>{t('training.viewer.refresher_note.label')}:</strong>
      {t('training.viewer.refresher_note.value')}
    </p>
  </header>

  {#if loading}
    <div role="status" aria-label={t('training.viewer.loading')} data-testid="trn-loading">
      <SkeletonRows />
    </div>
  {:else if loadError}
    <p class="trn-alert" role="alert" data-testid="trn-load-error">
      {t('training.viewer.error.load_failed')}
    </p>
  {:else if rows.length === 0}
    <div class="empty-state" data-testid="trn-empty" role="status">
      <p class="muted">
        {filterActive ? t('common.filterEmptyState.no_matches') : t('training.viewer.empty')}
      </p>
      {#if filterActive && clearHref}
        <p class="empty-state-actions">
          <a href={clearHref} class="empty-state-clear" data-testid="trn-empty-clear">
            {t('common.filterEmptyState.clear_filters')}
          </a>
        </p>
      {/if}
    </div>
  {:else}
    <div class="trn-controls" data-testid="trn-controls" data-print="hide">
      <button
        type="button"
        class="btn-outline"
        on:click={onPrev}
        disabled={!hasPrev}
        data-testid="trn-prev"
      >
        {t('training.viewer.prev')}
      </button>
      <span class="trn-page-indicator" data-testid="trn-page-indicator">
        {t('training.viewer.page_indicator', { page: page + 1, total: pageCount })}
        <span class="pagination-total" data-testid="pagination-total"
          >· {t('common.pagination.total_entries', { count: total })}</span
        >
      </span>
      <button
        type="button"
        class="btn-outline"
        on:click={onNext}
        disabled={!hasNext}
        data-testid="trn-next"
      >
        {t('training.viewer.next')}
      </button>
    </div>

    <ul class="trn-list" data-testid="trn-list">
      {#each rows as row (row.id)}
        <li class="trn-row" data-testid="trn-row" data-validity={row.validity} data-print="row">
          <div class="trn-row-head">
            <span
              class="trn-validity-pin"
              class:valid={row.validity === 'valid'}
              class:expiring={row.validity === 'expiring'}
              class:expired={row.validity === 'expired'}
              data-testid="trn-validity-pin"
            >
              {validityLabel(row.validity)}
            </span>
            <time class="trn-row-date" data-testid="trn-row-date"
              >{formatDate(row.completed_at)}</time
            >
          </div>
          <p class="trn-row-title" data-testid="trn-row-title">{row.certification}</p>
          <div class="trn-row-chips">
            <span
              class="trn-expiry-chip"
              class:overdue={row.validity === 'expired'}
              data-testid="trn-expiry-chip"
            >
              {expiryText(row)}
            </span>
            {#if row.evidence_attached}
              <span class="trn-evidence-chip" data-testid="trn-evidence-chip">
                {t('training.viewer.evidence_attached')}
              </span>
            {/if}
            <span class="trn-info-chip" data-testid="trn-member-chip">
              <span class="trn-chip-key">{t('training.viewer.member_label')}:</span>
              <code>{row.member_pseudonym}</code>
            </span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .trn-section {
    display: block;
  }
  .trn-header {
    margin-block-end: 1rem;
  }
  .trn-refresher-note {
    margin-block: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-tint-blue-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    font-size: 0.8125rem;
  }
  .trn-refresher-note strong {
    font-weight: 600;
    margin-inline-end: 0.25rem;
  }

  .trn-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-block: 0.75rem;
  }
  .trn-controls .btn-outline {
    min-height: 2.25rem;
    padding-inline: 0.875rem;
    font-size: 0.8125rem;
  }
  .trn-page-indicator {
    color: var(--color-fg-muted);
    font-size: 0.8125rem;
    margin-inline-start: auto;
  }

  .trn-list {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .trn-row {
    display: block;
    padding: 0.875rem 1rem;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
  }
  .trn-row + .trn-row {
    border-block-start: 1px solid var(--color-border);
  }
  .trn-row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 0.75rem;
  }
  .trn-row-date {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--color-fg-muted);
    margin-inline-start: auto;
  }

  .trn-validity-pin {
    display: inline-flex;
    align-items: center;
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-sm);
    border: 1px solid;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .trn-validity-pin.valid {
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
    border-color: var(--color-tint-green-border);
  }
  .trn-validity-pin.expiring {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-color: var(--color-tint-amber-border);
  }
  .trn-validity-pin.expired {
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-color: var(--color-tint-red-border);
  }

  .trn-row-title {
    margin-block: 0.5rem 0.5rem;
    font-size: 0.9375rem;
    line-height: 1.4;
  }

  .trn-row-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    font-size: 0.6875rem;
  }
  .trn-expiry-chip,
  .trn-evidence-chip,
  .trn-info-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
    padding: 0.0625rem 0.375rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-muted);
  }
  .trn-expiry-chip {
    font-family: var(--font-mono);
  }
  .trn-expiry-chip.overdue {
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-color: var(--color-tint-red-border);
    font-weight: 600;
  }
  .trn-evidence-chip {
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
    border-color: var(--color-tint-green-border);
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .trn-chip-key {
    color: var(--color-fg-muted);
  }
  .trn-info-chip code {
    font-family: var(--font-mono);
    color: var(--color-fg);
  }

  .trn-alert {
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
