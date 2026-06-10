<script>
  /**
   * InspectionsViewer — JHSC inspections register surface.
   *
   * Architecturally the same as AuditLogViewer / SensitiveFeedViewer /
   * RecommendationsViewer (backend-agnostic provider injection +
   * pagination + worker-hub styling), but the row layout is bespoke to
   * surface the register-of-walks attributes at a glance:
   *
   *   - Area chip (which part of the workplace was walked) +
   *     conducted-on date.
   *   - Per-entry HMAC integrity status: green "verified" pin for the
   *     happy path, red "quarantined" pin for the F-45 / ADR-0014 keyed-
   *     MAC failure path. The integrity status reads at-a-glance so a
   *     worker spotting a red row knows to investigate.
   *   - Offline-queued chip when the entry was held in the F-47 offline
   *     queue before sync (so the register reads as a realistic mix of
   *     direct + offline-first capture).
   *   - Counts: photos + checklist items.
   *   - Pseudonymized "conducted-by" actor.
   *
   * Reads pages via `fetchPage(page, page_size)`; the T10.1 wire-up
   * swaps in a SupabaseInspectionsClient with no viewer-side changes.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import SkeletonRows from '$lib/ui/SkeletonRows.svelte';

  /**
   * @type {(page: number, page_size: number) => Promise<{
   *   rows: import('./demo-inspections').DemoInspectionRow[];
   *   total: number;
   *   page: number;
   *   page_size: number;
   * }>}
   */
  export let fetchPage = async () => {
    throw new Error('InspectionsViewer: fetchPage not wired');
  };

  export let pageSize = 10;

  /** True when the route page has applied a filter; switches the
   *  empty state copy to a "no matches for this filter" message. */
  export let filterActive = false;

  /** When non-null, the active filter label echoes in the h1. */
  export let filterLabel = null;

  /** @type {import('./demo-inspections').DemoInspectionRow[]} */
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

  /** @param {import('./demo-inspections').InspectionIntegrityStatus} status */
  function integrityLabel(status) {
    return t(`inspection.viewer.integrity.${status}`);
  }

  $: pageCount = total === 0 ? 1 : Math.ceil(total / pageSize);
  $: hasPrev = page > 0 && !loading;
  $: hasNext = (page + 1) * pageSize < total && !loading;
</script>

<section
  class="ins-section"
  aria-labelledby="ins-heading"
  aria-busy={loading ? 'true' : 'false'}
  data-testid="ins-viewer-section"
>
  <header class="ins-header">
    <h1 id="ins-heading">
      {t('inspection.viewer.heading')}{#if filterLabel}<span
          class="viewer-heading-filter"
          data-testid="viewer-heading-filter">{' '}— {filterLabel}</span
        >{/if}
    </h1>
    <p class="muted">{t('inspection.viewer.intro')}</p>
    <p class="ins-offline-note" data-testid="ins-offline-note">
      <strong>{t('inspection.viewer.offline_note.label')}:</strong>
      {t('inspection.viewer.offline_note.value')}
    </p>
  </header>

  {#if loading}
    <div role="status" aria-label={t('inspection.viewer.loading')} data-testid="ins-loading">
      <SkeletonRows />
    </div>
  {:else if loadError}
    <p class="ins-alert" role="alert" data-testid="ins-load-error">
      {t('inspection.viewer.error.load_failed')}
    </p>
  {:else if rows.length === 0}
    <p class="muted" role="status" data-testid="ins-empty">
      {filterActive ? t('common.filterEmptyState.no_matches') : t('inspection.viewer.empty')}
    </p>
  {:else}
    <div class="ins-controls" data-testid="ins-controls" data-print="hide">
      <button
        type="button"
        class="btn-outline"
        on:click={onPrev}
        disabled={!hasPrev}
        data-testid="ins-prev"
      >
        {t('inspection.viewer.prev')}
      </button>
      <span class="ins-page-indicator" data-testid="ins-page-indicator">
        {t('inspection.viewer.page_indicator', { page: page + 1, total: pageCount })}
        <span class="pagination-total" data-testid="pagination-total"
          >· {t('common.pagination.total_entries', { count: total })}</span
        >
      </span>
      <button
        type="button"
        class="btn-outline"
        on:click={onNext}
        disabled={!hasNext}
        data-testid="ins-next"
      >
        {t('inspection.viewer.next')}
      </button>
    </div>

    <ul class="ins-list" data-testid="ins-list">
      {#each rows as row (row.id)}
        <li
          class="ins-row"
          class:quarantined={row.integrity_status === 'quarantined'}
          data-testid="ins-row"
          data-status={row.integrity_status}
        >
          <div class="ins-row-head">
            <span
              class="ins-integrity-pin"
              class:verified={row.integrity_status === 'verified'}
              class:quarantined={row.integrity_status === 'quarantined'}
              data-testid="ins-integrity-pin"
            >
              {integrityLabel(row.integrity_status)}
            </span>
            {#if row.was_offline_queued}
              <span class="ins-offline-chip" data-testid="ins-offline-chip">
                {t('inspection.viewer.offline_queued')}
              </span>
            {/if}
            <time class="ins-row-date" data-testid="ins-row-date"
              >{formatDate(row.conducted_at)}</time
            >
          </div>
          <p class="ins-row-area" data-testid="ins-row-area">
            <span class="ins-row-area-key">{t('inspection.viewer.area_label')}:</span>
            {row.area}
          </p>
          <p class="ins-row-notes" data-testid="ins-row-notes">{row.notes_preview}</p>
          <div class="ins-row-chips">
            <span class="ins-count-chip" data-testid="ins-checklist-chip">
              <span class="ins-count-key">{t('inspection.viewer.checklist_label')}:</span>
              <code>{row.checklist_item_count}</code>
            </span>
            <span class="ins-count-chip" data-testid="ins-photos-chip">
              <span class="ins-count-key">{t('inspection.viewer.photos_label')}:</span>
              <code>{row.photo_count}</code>
            </span>
            <span class="ins-actor-chip" data-testid="ins-actor-chip">
              <span class="ins-count-key">{t('inspection.viewer.conducted_by')}:</span>
              <code>{row.actor_pseudonym}</code>
            </span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .ins-section {
    display: block;
  }
  .ins-header {
    margin-block-end: 1rem;
  }
  .ins-offline-note {
    margin-block: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-tint-blue-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    font-size: 0.8125rem;
  }
  .ins-offline-note strong {
    font-weight: 600;
    margin-inline-end: 0.25rem;
  }

  .ins-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-block: 0.75rem;
  }
  .ins-controls .btn-outline {
    min-height: 2.25rem;
    padding-inline: 0.875rem;
    font-size: 0.8125rem;
  }
  .ins-page-indicator {
    color: var(--color-fg-muted);
    font-size: 0.8125rem;
    margin-inline-start: auto;
  }

  .ins-list {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  /*
   * A quarantined row carries a destructive inline-start border so the
   * F-45 / ADR-0014 keyed-MAC failure reads at a glance. Worker-hub
   * uses the same accent on /reprisal and /s51-evidence.
   */
  .ins-row {
    display: block;
    padding: 0.875rem 1rem;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    border-inline-start: 4px solid transparent;
  }
  .ins-row.quarantined {
    border-inline-start-color: var(--color-destructive);
  }
  .ins-row + .ins-row {
    border-block-start: 1px solid var(--color-border);
  }
  .ins-row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 0.75rem;
  }
  .ins-row-date {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--color-fg-muted);
    margin-inline-start: auto;
  }

  .ins-integrity-pin {
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
  .ins-integrity-pin.verified {
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
    border-color: var(--color-tint-green-border);
  }
  .ins-integrity-pin.quarantined {
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-color: var(--color-tint-red-border);
  }
  .ins-offline-chip {
    display: inline-flex;
    align-items: center;
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--color-tint-amber-border);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .ins-row-area {
    margin-block: 0.5rem 0.25rem;
    font-size: 0.9375rem;
    line-height: 1.4;
  }
  .ins-row-area-key {
    color: var(--color-fg-muted);
    margin-inline-end: 0.25rem;
  }
  .ins-row-notes {
    margin-block: 0 0.5rem;
    color: var(--color-fg-muted);
    font-size: 0.8125rem;
    line-height: 1.4;
  }

  .ins-row-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    font-size: 0.6875rem;
  }
  .ins-count-chip,
  .ins-actor-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
    padding: 0.0625rem 0.375rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-muted);
  }
  .ins-count-key {
    color: var(--color-fg-muted);
  }
  .ins-count-chip code,
  .ins-actor-chip code {
    font-family: var(--font-mono);
    color: var(--color-fg);
  }

  .ins-alert {
    margin-block: 0.75rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-red-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
  }
</style>
