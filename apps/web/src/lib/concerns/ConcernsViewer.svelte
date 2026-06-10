<script>
  /**
   * ConcernsViewer — JHSC concerns register surface.
   *
   * Same architectural pattern as the audit / sensitive-feed /
   * recommendations / inspections / minutes viewers (backend-agnostic
   * provider injection + pagination + worker-hub styling). Bespoke
   * row layout to surface the concerns-register attributes at a
   * glance:
   *
   *   - Status pin: open (red) / triaged (amber) / resolved (green) /
   *     archived (neutral). Reads the lifecycle stage at a glance.
   *   - Severity chip: critical (red) / high (amber) / medium (blue) /
   *     low (neutral). Independent of status — a "critical, resolved"
   *     row reads honestly as both severe and closed-out.
   *   - Hazard-class chip (physical / chemical / biological /
   *     ergonomic / psychosocial).
   *   - Source-protection chip — surfaces F-17 anonymous-by-default
   *     honestly: "Source protected" (the common case) or "Source
   *     revealed with consent" (the rarer case).
   *   - Days-since-filed: surfaces age at a glance.
   *   - Pseudonymized actor.
   *
   * Reads pages via `fetchPage(page, page_size)`; the T08.1 wire-up
   * swaps in a SupabaseConcernsClient with no viewer-side changes.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import SkeletonRows from '$lib/ui/SkeletonRows.svelte';

  /**
   * @type {(page: number, page_size: number) => Promise<{
   *   rows: import('./demo-concerns').DemoConcernRow[];
   *   total: number;
   *   page: number;
   *   page_size: number;
   * }>}
   */
  export let fetchPage = async () => {
    throw new Error('ConcernsViewer: fetchPage not wired');
  };

  export let pageSize = 10;

  /** True when the route page has applied a filter; switches the
   *  empty state copy to a "no matches for this filter" message. */
  export let filterActive = false;

  /** @type {import('./demo-concerns').DemoConcernRow[]} */
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

  /** @param {import('./demo-concerns').ConcernStatus} status */
  function statusLabel(status) {
    return t(`concern.viewer.status.${status}`);
  }
  /** @param {import('./demo-concerns').ConcernSeverity} severity */
  function severityLabel(severity) {
    return t(`concern.viewer.severity.${severity}`);
  }
  /** @param {import('./demo-concerns').ConcernHazardClass} hazard */
  function hazardLabel(hazard) {
    return t(`concern.viewer.hazard.${hazard}`);
  }

  $: pageCount = total === 0 ? 1 : Math.ceil(total / pageSize);
  $: hasPrev = page > 0 && !loading;
  $: hasNext = (page + 1) * pageSize < total && !loading;
</script>

<section
  class="con-section"
  aria-labelledby="con-heading"
  aria-busy={loading ? 'true' : 'false'}
  data-testid="con-viewer-section"
>
  <header class="con-header">
    <h1 id="con-heading">{t('concern.viewer.heading')}</h1>
    <p class="muted">{t('concern.viewer.intro')}</p>
    <p class="con-anon-note" data-testid="con-anon-note">
      <strong>{t('concern.viewer.anon_note.label')}:</strong>
      {t('concern.viewer.anon_note.value')}
    </p>
  </header>

  {#if loading}
    <div role="status" aria-label={t('concern.viewer.loading')} data-testid="con-loading">
      <SkeletonRows />
    </div>
  {:else if loadError}
    <p class="con-alert" role="alert" data-testid="con-load-error">
      {t('concern.viewer.error.load_failed')}
    </p>
  {:else if rows.length === 0}
    <p class="muted" role="status" data-testid="con-empty">
      {filterActive ? t('common.filterEmptyState.no_matches') : t('concern.viewer.empty')}
    </p>
  {:else}
    <div class="con-controls" data-testid="con-controls" data-print="hide">
      <button
        type="button"
        class="btn-outline"
        on:click={onPrev}
        disabled={!hasPrev}
        data-testid="con-prev"
      >
        {t('concern.viewer.prev')}
      </button>
      <span class="con-page-indicator" data-testid="con-page-indicator">
        {t('concern.viewer.page_indicator', { page: page + 1, total: pageCount })}
        <span class="pagination-total" data-testid="pagination-total"
          >· {t('common.pagination.total_entries', { count: total })}</span
        >
      </span>
      <button
        type="button"
        class="btn-outline"
        on:click={onNext}
        disabled={!hasNext}
        data-testid="con-next"
      >
        {t('concern.viewer.next')}
      </button>
    </div>

    <ul class="con-list" data-testid="con-list">
      {#each rows as row (row.id)}
        <li class="con-row" data-testid="con-row" data-status={row.status}>
          <div class="con-row-head">
            <span
              class="con-status-pin"
              class:open={row.status === 'open'}
              class:triaged={row.status === 'triaged'}
              class:resolved={row.status === 'resolved'}
              class:archived={row.status === 'archived'}
              data-testid="con-status-pin"
            >
              {statusLabel(row.status)}
            </span>
            <span
              class="con-severity-chip"
              class:critical={row.severity === 'critical'}
              class:high={row.severity === 'high'}
              class:medium={row.severity === 'medium'}
              class:low={row.severity === 'low'}
              data-testid="con-severity-chip"
            >
              {severityLabel(row.severity)}
            </span>
            <time class="con-row-date" data-testid="con-row-date">{formatDate(row.filed_at)}</time>
          </div>
          <p class="con-row-title" data-testid="con-row-title">{row.title}</p>
          <div class="con-row-chips">
            <span class="con-info-chip" data-testid="con-hazard-chip">
              <span class="con-chip-key">{t('concern.viewer.hazard_label')}:</span>
              <code>{hazardLabel(row.hazard_class)}</code>
            </span>
            <span
              class="con-source-chip"
              class:protected={row.source_protected}
              class:revealed={!row.source_protected}
              data-testid="con-source-chip"
            >
              {row.source_protected
                ? t('concern.viewer.source.protected')
                : t('concern.viewer.source.revealed')}
            </span>
            <span class="con-info-chip" data-testid="con-days-chip">
              <span class="con-chip-key">{t('concern.viewer.days_label')}:</span>
              <code>{row.days_since_filed}</code>
            </span>
            <span class="con-info-chip" data-testid="con-actor-chip">
              <span class="con-chip-key">{t('concern.viewer.filed_by')}:</span>
              <code>{row.actor_pseudonym}</code>
            </span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .con-section {
    display: block;
  }
  .con-header {
    margin-block-end: 1rem;
  }
  .con-anon-note {
    margin-block: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-tint-blue-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    font-size: 0.8125rem;
  }
  .con-anon-note strong {
    font-weight: 600;
    margin-inline-end: 0.25rem;
  }

  .con-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-block: 0.75rem;
  }
  .con-controls .btn-outline {
    min-height: 2.25rem;
    padding-inline: 0.875rem;
    font-size: 0.8125rem;
  }
  .con-page-indicator {
    color: var(--color-fg-muted);
    font-size: 0.8125rem;
    margin-inline-start: auto;
  }

  .con-list {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .con-row {
    display: block;
    padding: 0.875rem 1rem;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
  }
  .con-row + .con-row {
    border-block-start: 1px solid var(--color-border);
  }
  .con-row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 0.75rem;
  }
  .con-row-date {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--color-fg-muted);
    margin-inline-start: auto;
  }

  .con-status-pin,
  .con-severity-chip {
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
  .con-status-pin.open {
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-color: var(--color-tint-red-border);
  }
  .con-status-pin.triaged {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-color: var(--color-tint-amber-border);
  }
  .con-status-pin.resolved {
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
    border-color: var(--color-tint-green-border);
  }
  .con-status-pin.archived {
    background: var(--color-tint-neutral-bg);
    color: var(--color-tint-neutral-fg);
    border-color: var(--color-tint-neutral-border);
  }
  .con-severity-chip.critical {
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-color: var(--color-tint-red-border);
  }
  .con-severity-chip.high {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-color: var(--color-tint-amber-border);
  }
  .con-severity-chip.medium {
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    border-color: var(--color-tint-blue-border);
  }
  .con-severity-chip.low {
    background: var(--color-tint-neutral-bg);
    color: var(--color-tint-neutral-fg);
    border-color: var(--color-tint-neutral-border);
  }

  .con-row-title {
    margin-block: 0.5rem 0.5rem;
    font-size: 0.9375rem;
    line-height: 1.4;
  }

  .con-row-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    font-size: 0.6875rem;
  }
  .con-info-chip,
  .con-source-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
    padding: 0.0625rem 0.375rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-muted);
  }
  .con-source-chip {
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .con-source-chip.protected {
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    border-color: var(--color-tint-blue-border);
  }
  .con-source-chip.revealed {
    background: var(--color-tint-neutral-bg);
    color: var(--color-tint-neutral-fg);
    border-color: var(--color-tint-neutral-border);
  }
  .con-chip-key {
    color: var(--color-fg-muted);
  }
  .con-info-chip code {
    font-family: var(--font-mono);
    color: var(--color-fg);
  }

  .con-alert {
    margin-block: 0.75rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-red-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
  }
</style>
