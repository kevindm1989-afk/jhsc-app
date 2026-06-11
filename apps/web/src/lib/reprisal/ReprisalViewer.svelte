<script>
  /**
   * ReprisalViewer — JHSC C4-tier reprisal-log register surface.
   *
   * Same architectural pattern as the audit / sensitive-feed /
   * recommendations / inspections / minutes / concerns viewers
   * (backend-agnostic provider injection + pagination + worker-hub
   * styling). The row layout is bespoke to surface the C4-sensitivity
   * markers at a glance:
   *
   *   - Per-row destructive-red inline-start border so the C4 sensitivity
   *     reads at a glance. Matches the worker-hub accent already used on
   *     the /reprisal placeholder card, the SensitiveFeedViewer C4 rows,
   *     and the /s51-evidence placeholder.
   *   - C4 badge on the header (red tint).
   *   - Per-entry-passphrase chip on every row that requires one — the
   *     reader sees at a glance "this row is sealed under a passphrase
   *     even from authorized members."
   *   - Status pin: filed (red) / investigating (amber) / resolved
   *     (green) / archived (neutral).
   *   - Source-protected / source-revealed chip — surfaces the rare
   *     source-revealed case honestly so it doesn't disappear into a
   *     uniform "protected" wash.
   *   - Days-since-filed counter + pseudonymized actor.
   *
   * Reads pages via `fetchPage(page, page_size)`; the T13.1 wire-up
   * swaps in a SupabaseReprisalClient with no viewer-side changes.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { formatDateShort } from '$lib/ui/date-format';
  import SkeletonRows from '$lib/ui/SkeletonRows.svelte';

  /**
   * @type {(page: number, page_size: number) => Promise<{
   *   rows: import('./demo-reprisal').DemoReprisalRow[];
   *   total: number;
   *   page: number;
   *   page_size: number;
   * }>}
   */
  export let fetchPage = async () => {
    throw new Error('ReprisalViewer: fetchPage not wired');
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

  /** @type {import('./demo-reprisal').DemoReprisalRow[]} */
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

  /** @param {import('./demo-reprisal').ReprisalStatus} status */
  function statusLabel(status) {
    return t(`reprisal.viewer.status.${status}`);
  }

  $: pageCount = total === 0 ? 1 : Math.ceil(total / pageSize);
  $: hasPrev = page > 0 && !loading;
  $: hasNext = (page + 1) * pageSize < total && !loading;
</script>

<section
  class="rep-section"
  aria-labelledby="rep-heading"
  aria-busy={loading ? 'true' : 'false'}
  data-testid="rep-viewer-section"
>
  <header class="rep-header">
    <div class="rep-heading-row">
      <h1 id="rep-heading">
        {t('reprisal.viewer.heading')}{#if filterLabel}<span
            class="viewer-heading-filter"
            data-testid="viewer-heading-filter">{' '}— {filterLabel}</span
          >{/if}
      </h1>
      <span class="rep-c4-badge" data-testid="rep-c4-badge">C4</span>
    </div>
    <p class="muted">{t('reprisal.viewer.intro')}</p>
    <p class="rep-c4-note" data-testid="rep-c4-note">
      <strong>{t('reprisal.viewer.c4_note.label')}:</strong>
      {t('reprisal.viewer.c4_note.value')}
    </p>
  </header>

  {#if loading}
    <div role="status" aria-label={t('reprisal.viewer.loading')} data-testid="rep-loading">
      <SkeletonRows />
    </div>
  {:else if loadError}
    <p class="rep-alert" role="alert" data-testid="rep-load-error">
      {t('reprisal.viewer.error.load_failed')}
    </p>
  {:else if rows.length === 0}
    <div class="empty-state" data-testid="rep-empty" role="status">
      <p class="muted">
        {filterActive ? t('common.filterEmptyState.no_matches') : t('reprisal.viewer.empty')}
      </p>
      {#if filterActive && clearHref}
        <p class="empty-state-actions">
          <a href={clearHref} class="empty-state-clear" data-testid="rep-empty-clear">
            {t('common.filterEmptyState.clear_filters')}
          </a>
        </p>
      {/if}
    </div>
  {:else}
    <div class="rep-controls" data-testid="rep-controls" data-print="hide">
      <button
        type="button"
        class="btn-outline"
        on:click={onPrev}
        disabled={!hasPrev}
        data-testid="rep-prev"
      >
        {t('reprisal.viewer.prev')}
      </button>
      <span class="rep-page-indicator" data-testid="rep-page-indicator">
        {t('reprisal.viewer.page_indicator', { page: page + 1, total: pageCount })}
        <span class="pagination-total" data-testid="pagination-total"
          >· {t('common.pagination.total_entries', { count: total })}</span
        >
      </span>
      <button
        type="button"
        class="btn-outline"
        on:click={onNext}
        disabled={!hasNext}
        data-testid="rep-next"
      >
        {t('reprisal.viewer.next')}
      </button>
    </div>

    <ul class="rep-list" data-testid="rep-list">
      {#each rows as row (row.id)}
        <li class="rep-row" data-testid="rep-row" data-status={row.status} data-print="row">
          <div class="rep-row-head">
            <span
              class="rep-status-pin"
              class:filed={row.status === 'filed'}
              class:investigating={row.status === 'investigating'}
              class:resolved={row.status === 'resolved'}
              class:archived={row.status === 'archived'}
              data-testid="rep-status-pin"
            >
              {statusLabel(row.status)}
            </span>
            {#if row.per_entry_passphrase_required}
              <span class="rep-passphrase-chip" data-testid="rep-passphrase-chip">
                {t('reprisal.viewer.passphrase_required')}
              </span>
            {/if}
            <time class="rep-row-date" data-testid="rep-row-date">{formatDate(row.filed_at)}</time>
          </div>
          <p class="rep-row-title" data-testid="rep-row-title">{row.title}</p>
          <div class="rep-row-chips">
            <span
              class="rep-source-chip"
              class:protected={!row.source_revealed}
              class:revealed={row.source_revealed}
              data-testid="rep-source-chip"
            >
              {row.source_revealed
                ? t('reprisal.viewer.source.revealed')
                : t('reprisal.viewer.source.protected')}
            </span>
            <span class="rep-info-chip" data-testid="rep-days-chip">
              <span class="rep-chip-key">{t('reprisal.viewer.days_label')}:</span>
              <code>{row.days_since_filed}</code>
            </span>
            <span class="rep-info-chip" data-testid="rep-actor-chip">
              <span class="rep-chip-key">{t('reprisal.viewer.filed_by')}:</span>
              <code>{row.actor_pseudonym}</code>
            </span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .rep-section {
    display: block;
  }
  .rep-header {
    margin-block-end: 1rem;
  }
  .rep-heading-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 0.75rem;
  }
  .rep-c4-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-sm);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border: 1px solid var(--color-tint-red-border);
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .rep-c4-note {
    margin-block: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-tint-red-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    font-size: 0.8125rem;
  }
  .rep-c4-note strong {
    font-weight: 600;
    margin-inline-end: 0.25rem;
  }

  .rep-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-block: 0.75rem;
  }
  .rep-controls .btn-outline {
    min-height: 2.25rem;
    padding-inline: 0.875rem;
    font-size: 0.8125rem;
  }
  .rep-page-indicator {
    color: var(--color-fg-muted);
    font-size: 0.8125rem;
    margin-inline-start: auto;
  }

  .rep-list {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  /*
   * Every row carries a destructive inline-start border so the C4
   * sensitivity reads at a glance, mirroring the SensitiveFeedViewer
   * C4 row accent and the /reprisal placeholder card border.
   */
  .rep-row {
    display: block;
    padding: 0.875rem 1rem;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    border-inline-start: 4px solid var(--color-destructive);
  }
  .rep-row + .rep-row {
    border-block-start: 1px solid var(--color-border);
  }
  .rep-row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 0.75rem;
  }
  .rep-row-date {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--color-fg-muted);
    margin-inline-start: auto;
  }

  .rep-status-pin,
  .rep-passphrase-chip {
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
  .rep-status-pin.filed {
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-color: var(--color-tint-red-border);
  }
  .rep-status-pin.investigating {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-color: var(--color-tint-amber-border);
  }
  .rep-status-pin.resolved {
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
    border-color: var(--color-tint-green-border);
  }
  .rep-status-pin.archived {
    background: var(--color-tint-neutral-bg);
    color: var(--color-tint-neutral-fg);
    border-color: var(--color-tint-neutral-border);
  }
  .rep-passphrase-chip {
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    border-color: var(--color-tint-blue-border);
  }

  .rep-row-title {
    margin-block: 0.5rem 0.5rem;
    font-size: 0.9375rem;
    line-height: 1.4;
  }

  .rep-row-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    font-size: 0.6875rem;
  }
  .rep-info-chip,
  .rep-source-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
    padding: 0.0625rem 0.375rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-muted);
  }
  .rep-source-chip {
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .rep-source-chip.protected {
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    border-color: var(--color-tint-blue-border);
  }
  .rep-source-chip.revealed {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-color: var(--color-tint-amber-border);
  }
  .rep-chip-key {
    color: var(--color-fg-muted);
  }
  .rep-info-chip code {
    font-family: var(--font-mono);
    color: var(--color-fg);
  }

  .rep-alert {
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
