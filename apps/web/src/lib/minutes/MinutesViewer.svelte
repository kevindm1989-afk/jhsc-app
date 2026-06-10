<script>
  /**
   * MinutesViewer — JHSC meeting-minutes register surface.
   *
   * Same architectural pattern as the audit / sensitive-feed /
   * recommendations / inspections viewers (backend-agnostic
   * provider injection + pagination + worker-hub styling), but the
   * row layout is bespoke to surface the deliberation+approval state
   * at a glance:
   *
   *   - Status pin: draft (amber) / approved (green) / archived
   *     (neutral). Draft minutes stay committee-key encrypted and
   *     visible only to authorized worker members; approved minutes
   *     carry a documented quorum count.
   *   - Quorum-met chip for approved minutes: "Quorum: N members".
   *   - Revision-count chip — every edit is captured (append-only).
   *   - Quoted-concerns chip when minutes reference filed concerns
   *     (F-19 traceability — author consent required before approval).
   *   - Pseudonymized drafter.
   *
   * Reads pages via `fetchPage(page, page_size)`; the real backend
   * swap-in replaces the demo provider with no viewer-side changes.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';

  /**
   * @type {(page: number, page_size: number) => Promise<{
   *   rows: import('./demo-minutes').DemoMinutesRow[];
   *   total: number;
   *   page: number;
   *   page_size: number;
   * }>}
   */
  export let fetchPage = async () => {
    throw new Error('MinutesViewer: fetchPage not wired');
  };

  export let pageSize = 10;

  /** True when the route page has applied a filter; switches the
   *  empty state copy to a "no matches for this filter" message. */
  export let filterActive = false;

  /** @type {import('./demo-minutes').DemoMinutesRow[]} */
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

  /** @param {import('./demo-minutes').MinutesStatus} status */
  function statusLabel(status) {
    return t(`minutes.viewer.status.${status}`);
  }

  $: pageCount = total === 0 ? 1 : Math.ceil(total / pageSize);
  $: hasPrev = page > 0 && !loading;
  $: hasNext = (page + 1) * pageSize < total && !loading;
</script>

<section
  class="min-section"
  aria-labelledby="min-heading"
  aria-busy={loading ? 'true' : 'false'}
  data-testid="min-viewer-section"
>
  <header class="min-header">
    <h1 id="min-heading">{t('minutes.viewer.heading')}</h1>
    <p class="muted">{t('minutes.viewer.intro')}</p>
    <p class="min-approval-note" data-testid="min-approval-note">
      <strong>{t('minutes.viewer.approval_note.label')}:</strong>
      {t('minutes.viewer.approval_note.value')}
    </p>
  </header>

  {#if loading}
    <p class="muted" role="status" data-testid="min-loading">
      {t('minutes.viewer.loading')}
    </p>
  {:else if loadError}
    <p class="min-alert" role="alert" data-testid="min-load-error">
      {t('minutes.viewer.error.load_failed')}
    </p>
  {:else if rows.length === 0}
    <p class="muted" role="status" data-testid="min-empty">
      {filterActive ? t('common.filterEmptyState.no_matches') : t('minutes.viewer.empty')}
    </p>
  {:else}
    <div class="min-controls" data-testid="min-controls">
      <button
        type="button"
        class="btn-outline"
        on:click={onPrev}
        disabled={!hasPrev}
        data-testid="min-prev"
      >
        {t('minutes.viewer.prev')}
      </button>
      <span class="min-page-indicator" data-testid="min-page-indicator">
        {t('minutes.viewer.page_indicator', { page: page + 1, total: pageCount })}
      </span>
      <button
        type="button"
        class="btn-outline"
        on:click={onNext}
        disabled={!hasNext}
        data-testid="min-next"
      >
        {t('minutes.viewer.next')}
      </button>
    </div>

    <ul class="min-list" data-testid="min-list">
      {#each rows as row (row.id)}
        <li class="min-row" data-testid="min-row" data-status={row.status}>
          <div class="min-row-head">
            <span
              class="min-status-pin"
              class:draft={row.status === 'draft'}
              class:approved={row.status === 'approved'}
              class:archived={row.status === 'archived'}
              data-testid="min-status-pin"
            >
              {statusLabel(row.status)}
            </span>
            <time class="min-row-date" data-testid="min-row-date"
              >{formatDate(row.meeting_date)}</time
            >
          </div>
          <p class="min-row-title" data-testid="min-row-title">{row.title}</p>
          <div class="min-row-chips">
            {#if row.status === 'approved' && row.quorum_present !== null}
              <span class="min-quorum-chip" data-testid="min-quorum-chip">
                <span class="min-chip-key">{t('minutes.viewer.quorum_label')}:</span>
                <code>{row.quorum_present}</code>
              </span>
            {/if}
            <span class="min-info-chip" data-testid="min-revision-chip">
              <span class="min-chip-key">{t('minutes.viewer.revisions_label')}:</span>
              <code>{row.revision_count}</code>
            </span>
            {#if row.quoted_concern_count > 0}
              <span class="min-info-chip" data-testid="min-quoted-chip">
                <span class="min-chip-key">{t('minutes.viewer.quoted_label')}:</span>
                <code>{row.quoted_concern_count}</code>
              </span>
            {/if}
            <span class="min-info-chip" data-testid="min-drafter-chip">
              <span class="min-chip-key">{t('minutes.viewer.drafted_by')}:</span>
              <code>{row.drafter_pseudonym}</code>
            </span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .min-section {
    display: block;
  }
  .min-header {
    margin-block-end: 1rem;
  }
  .min-approval-note {
    margin-block: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-tint-blue-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    font-size: 0.8125rem;
  }
  .min-approval-note strong {
    font-weight: 600;
    margin-inline-end: 0.25rem;
  }

  .min-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-block: 0.75rem;
  }
  .min-controls .btn-outline {
    min-height: 2.25rem;
    padding-inline: 0.875rem;
    font-size: 0.8125rem;
  }
  .min-page-indicator {
    color: var(--color-fg-muted);
    font-size: 0.8125rem;
    margin-inline-start: auto;
  }

  .min-list {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .min-row {
    display: block;
    padding: 0.875rem 1rem;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
  }
  .min-row + .min-row {
    border-block-start: 1px solid var(--color-border);
  }
  .min-row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 0.75rem;
  }
  .min-row-date {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--color-fg-muted);
    margin-inline-start: auto;
  }

  .min-status-pin {
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
  .min-status-pin.draft {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-color: var(--color-tint-amber-border);
  }
  .min-status-pin.approved {
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
    border-color: var(--color-tint-green-border);
  }
  .min-status-pin.archived {
    background: var(--color-tint-neutral-bg);
    color: var(--color-tint-neutral-fg);
    border-color: var(--color-tint-neutral-border);
  }

  .min-row-title {
    margin-block: 0.5rem 0.5rem;
    font-size: 0.9375rem;
    line-height: 1.4;
  }

  .min-row-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    font-size: 0.6875rem;
  }
  .min-quorum-chip,
  .min-info-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
    padding: 0.0625rem 0.375rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-muted);
  }
  .min-quorum-chip {
    background: var(--color-tint-green-bg);
    border-color: var(--color-tint-green-border);
    color: var(--color-tint-green-fg);
  }
  .min-chip-key {
    color: var(--color-fg-muted);
  }
  .min-quorum-chip .min-chip-key {
    color: var(--color-tint-green-fg);
    opacity: 0.85;
  }
  .min-info-chip code,
  .min-quorum-chip code {
    font-family: var(--font-mono);
    color: var(--color-fg);
  }
  .min-quorum-chip code {
    color: var(--color-tint-green-fg);
  }

  .min-alert {
    margin-block: 0.75rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-red-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
  }
</style>
