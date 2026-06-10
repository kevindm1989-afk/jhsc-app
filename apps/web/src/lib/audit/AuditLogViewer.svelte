<script>
  /**
   * AuditLogViewer — Surface-style feed for the append-only audit log.
   *
   * Reads pages via a `fetchPage(page, page_size)` provider function so
   * the surface is backend-agnostic:
   *   - /audit currently wires this to the demo provider in
   *     `$lib/audit/demo-audit-rows` (deterministic synthetic data so
   *     the placeholder isn't empty).
   *   - The real T18 wire-up swaps in a SupabaseAuditClient pointed at
   *     the future audit-op Edge Function. No viewer-side changes
   *     required — provider injection is the only seam.
   *
   * Layout:
   *   - Header with title + intro + integrity-status pin.
   *   - Pagination row (prev / next + page indicator).
   *   - Table of rows (timestamp · event_type · actor · meta chips).
   *   - Loading + error + empty states.
   *
   * Worker-hub styling: bordered rows, monospace timestamp + event_type
   * + actor pseudonym, two-layer AODA focus ring on every interactive.
   *
   * F-101 / F-105 / F-108 are not directly relevant here (the audit
   * log surface deliberately does NOT carry passphrase / private key
   * material — only metadata). The viewer surfaces ONLY what the
   * provider returns; it does not derive or compute anything sensitive
   * client-side.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import SkeletonRows from '$lib/ui/SkeletonRows.svelte';

  /**
   * Page fetcher contract. The provider returns a deterministic page
   * of rows for a 0-indexed page number + page size, plus the total
   * row count so the viewer can render "Page X of Y".
   *
   * @type {(page: number, page_size: number) => Promise<{
   *   rows: import('./demo-audit-rows').DemoAuditRow[];
   *   total: number;
   *   page: number;
   *   page_size: number;
   * }>}
   */
  export let fetchPage = async () => {
    throw new Error('AuditLogViewer: fetchPage not wired');
  };

  /** Default page size — 10 rows per page comfortably fits mobile. */
  export let pageSize = 10;

  /** True when the route page has applied a filter; switches the
   *  empty state copy to a "no matches for this filter" message. */
  export let filterActive = false;

  /** @type {import('./demo-audit-rows').DemoAuditRow[]} */
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
    try {
      return iso.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
    } catch {
      return iso;
    }
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
  class="audit-viewer-section"
  aria-labelledby="audit-viewer-heading"
  aria-busy={loading ? 'true' : 'false'}
  data-testid="audit-viewer-section"
>
  <header class="audit-viewer-header">
    <h1 id="audit-viewer-heading">{t('audit.viewer.heading')}</h1>
    <p class="muted">{t('audit.viewer.intro')}</p>
    <p class="audit-viewer-integrity-note" data-testid="audit-viewer-integrity-note">
      <strong>{t('audit.viewer.integrity.label')}:</strong>
      {t('audit.viewer.integrity.value_demo')}
    </p>
  </header>

  {#if loading}
    <div role="status" aria-label={t('audit.viewer.loading')} data-testid="audit-viewer-loading">
      <SkeletonRows />
    </div>
  {:else if loadError}
    <p class="audit-viewer-alert" role="alert" data-testid="audit-viewer-load-error">
      {t('audit.viewer.error.load_failed')}
    </p>
  {:else if rows.length === 0}
    <p class="muted" role="status" data-testid="audit-viewer-empty">
      {filterActive ? t('common.filterEmptyState.no_matches') : t('audit.viewer.empty')}
    </p>
  {:else}
    <div class="audit-viewer-controls" data-testid="audit-viewer-controls" data-print="hide">
      <button
        type="button"
        class="btn-outline"
        on:click={onPrev}
        disabled={!hasPrev}
        data-testid="audit-viewer-prev"
      >
        {t('audit.viewer.prev')}
      </button>
      <span class="audit-viewer-page-indicator" data-testid="audit-viewer-page-indicator">
        {t('audit.viewer.page_indicator', { page: page + 1, total: pageCount })}
        <span class="pagination-total" data-testid="pagination-total"
          >· {t('common.pagination.total_entries', { count: total })}</span
        >
      </span>
      <button
        type="button"
        class="btn-outline"
        on:click={onNext}
        disabled={!hasNext}
        data-testid="audit-viewer-next"
      >
        {t('audit.viewer.next')}
      </button>
    </div>

    <ul class="audit-viewer-list" data-testid="audit-viewer-list">
      {#each rows as row (row.id)}
        <li class="audit-row" data-testid="audit-row">
          <div class="audit-row-head">
            <time class="audit-row-ts" data-testid="audit-row-ts">{formatTimestamp(row.ts)}</time>
            <code class="audit-row-event" data-testid="audit-row-event">{row.event_type}</code>
          </div>
          <div class="audit-row-actor-row">
            <span class="audit-row-actor-label">{t('audit.viewer.column.actor')}:</span>
            <code class="audit-row-actor" data-testid="audit-row-actor">{row.actor_pseudonym}</code>
          </div>
          {#if metaEntries(row.meta).length > 0}
            <ul class="audit-row-meta" data-testid="audit-row-meta">
              {#each metaEntries(row.meta) as [k, v] (k)}
                <li class="audit-meta-chip">
                  <span class="audit-meta-key">{k}</span>
                  <span class="audit-meta-value">{String(v)}</span>
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
  .audit-viewer-section {
    display: block;
  }
  .audit-viewer-header {
    margin-block-end: 1rem;
  }
  .audit-viewer-integrity-note {
    margin-block: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-tint-blue-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    font-size: 0.8125rem;
  }
  .audit-viewer-integrity-note strong {
    font-weight: 600;
    margin-inline-end: 0.25rem;
  }

  .audit-viewer-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-block: 0.75rem;
  }
  .audit-viewer-controls .btn-outline {
    min-height: 2.25rem;
    padding-inline: 0.875rem;
    font-size: 0.8125rem;
  }
  .audit-viewer-page-indicator {
    color: var(--color-fg-muted);
    font-size: 0.8125rem;
    margin-inline-start: auto;
  }

  .audit-viewer-list {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .audit-row {
    display: block;
    padding: 0.75rem 0.875rem;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
  }
  .audit-row + .audit-row {
    border-block-start: 1px solid var(--color-border);
  }
  .audit-row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.375rem 0.75rem;
  }
  .audit-row-ts {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--color-fg-muted);
  }
  .audit-row-event {
    font-family: var(--font-mono);
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-fg);
  }
  .audit-row-actor-row {
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
    margin-block-start: 0.25rem;
    font-size: 0.75rem;
  }
  .audit-row-actor-label {
    color: var(--color-fg-muted);
  }
  .audit-row-actor {
    font-family: var(--font-mono);
    color: var(--color-fg);
  }
  .audit-row-meta {
    list-style: none;
    padding: 0;
    margin: 0.5rem 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .audit-meta-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
    padding: 0.0625rem 0.375rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-muted);
    font-size: 0.6875rem;
  }
  .audit-meta-key {
    color: var(--color-fg-muted);
  }
  .audit-meta-value {
    font-family: var(--font-mono);
    color: var(--color-fg);
  }

  .audit-viewer-alert {
    margin-block: 0.75rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-red-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
  }
</style>
