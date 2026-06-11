<script>
  /**
   * WorkRefusalViewer — JHSC C4-tier OHSA s. 43 work-refusal register.
   *
   * Same architectural pattern as the other register viewers (backend-
   * agnostic provider injection + pagination + worker-hub styling).
   * Bespoke row layout to surface the s. 43 stage machine at a glance:
   *
   *   - Three-step stage gauge per row: worker refusal → s. 43(4)
   *     joint investigation → s. 43(8) MOL. Filled steps show how far
   *     the refusal has progressed; resolved rows show a green pin
   *     plus which stage they resolved at.
   *   - Per-row destructive-red inline-start border — C4 accent shared
   *     with /reprisal and /s51-evidence.
   *   - Alternative-work chip (s. 43(5)) when the worker is on
   *     alternative work pending the investigation.
   *   - Days-since-filed counter + pseudonymized actor.
   *
   * Reads pages via `fetchPage(page, page_size)`; the work-refusal
   * backend wire-up swaps in a real client with no viewer-side changes.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import SkeletonRows from '$lib/ui/SkeletonRows.svelte';

  /**
   * @type {(page: number, page_size: number) => Promise<{
   *   rows: import('./demo-work-refusal').DemoWorkRefusalRow[];
   *   total: number;
   *   page: number;
   *   page_size: number;
   * }>}
   */
  export let fetchPage = async () => {
    throw new Error('WorkRefusalViewer: fetchPage not wired');
  };

  export let pageSize = 10;

  /** True when the route page has applied a filter; switches the
   *  empty state copy to a "no matches for this filter" message. */
  export let filterActive = false;

  /** When non-null, the active filter label echoes in the h1. */
  export let filterLabel = null;

  /** @type {import('./demo-work-refusal').DemoWorkRefusalRow[]} */
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

  /** @param {import('./demo-work-refusal').WorkRefusalStage} stage */
  function stageLabel(stage) {
    return t(`workRefusal.viewer.stage.${stage}`);
  }

  /**
   * Gauge fill depth for a row: how many of the three s. 43 steps are
   * reached. Resolved rows fill to the stage they resolved at.
   * @param {import('./demo-work-refusal').DemoWorkRefusalRow} row
   */
  function gaugeDepth(row) {
    const effective = row.stage === 'resolved' ? row.resolved_at_stage : row.stage;
    if (effective === 's43_8_mol') return 3;
    if (effective === 's43_4_investigation') return 2;
    return 1;
  }

  $: pageCount = total === 0 ? 1 : Math.ceil(total / pageSize);
  $: hasPrev = page > 0 && !loading;
  $: hasNext = (page + 1) * pageSize < total && !loading;
</script>

<section
  class="wr-section"
  aria-labelledby="wr-heading"
  aria-busy={loading ? 'true' : 'false'}
  data-testid="wr-viewer-section"
>
  <header class="wr-header">
    <div class="wr-heading-row">
      <h1 id="wr-heading">
        {t('workRefusal.viewer.heading')}{#if filterLabel}<span
            class="viewer-heading-filter"
            data-testid="viewer-heading-filter">{' '}— {filterLabel}</span
          >{/if}
      </h1>
      <span class="wr-c4-badge" data-testid="wr-c4-badge">C4</span>
    </div>
    <p class="muted">{t('workRefusal.viewer.intro')}</p>
    <p class="wr-stages-note" data-testid="wr-stages-note">
      <strong>{t('workRefusal.viewer.stages_note.label')}:</strong>
      {t('workRefusal.viewer.stages_note.value')}
    </p>
  </header>

  {#if loading}
    <div role="status" aria-label={t('workRefusal.viewer.loading')} data-testid="wr-loading">
      <SkeletonRows />
    </div>
  {:else if loadError}
    <p class="wr-alert" role="alert" data-testid="wr-load-error">
      {t('workRefusal.viewer.error.load_failed')}
    </p>
  {:else if rows.length === 0}
    <p class="muted" role="status" data-testid="wr-empty">
      {filterActive ? t('common.filterEmptyState.no_matches') : t('workRefusal.viewer.empty')}
    </p>
  {:else}
    <div class="wr-controls" data-testid="wr-controls" data-print="hide">
      <button
        type="button"
        class="btn-outline"
        on:click={onPrev}
        disabled={!hasPrev}
        data-testid="wr-prev"
      >
        {t('workRefusal.viewer.prev')}
      </button>
      <span class="wr-page-indicator" data-testid="wr-page-indicator">
        {t('workRefusal.viewer.page_indicator', { page: page + 1, total: pageCount })}
        <span class="pagination-total" data-testid="pagination-total"
          >· {t('common.pagination.total_entries', { count: total })}</span
        >
      </span>
      <button
        type="button"
        class="btn-outline"
        on:click={onNext}
        disabled={!hasNext}
        data-testid="wr-next"
      >
        {t('workRefusal.viewer.next')}
      </button>
    </div>

    <ul class="wr-list" data-testid="wr-list">
      {#each rows as row (row.id)}
        <li class="wr-row" data-testid="wr-row" data-stage={row.stage} data-print="row">
          <div class="wr-row-head">
            <span
              class="wr-stage-pin"
              class:active={row.stage !== 'resolved'}
              class:resolved={row.stage === 'resolved'}
              data-testid="wr-stage-pin"
            >
              {stageLabel(row.stage)}
            </span>
            {#if row.stage === 'resolved' && row.resolved_at_stage}
              <span class="wr-resolved-at-chip" data-testid="wr-resolved-at-chip">
                {t('workRefusal.viewer.resolved_at_label')}: {stageLabel(row.resolved_at_stage)}
              </span>
            {/if}
            {#if row.alternative_work_assigned}
              <span class="wr-altwork-chip" data-testid="wr-altwork-chip">
                {t('workRefusal.viewer.alternative_work')}
              </span>
            {/if}
            <time class="wr-row-date" data-testid="wr-row-date">{formatDate(row.filed_at)}</time>
          </div>
          <p class="wr-row-title" data-testid="wr-row-title">{row.title}</p>
          <div
            class="wr-gauge"
            data-testid="wr-gauge"
            data-depth={gaugeDepth(row)}
            role="img"
            aria-label={t('workRefusal.viewer.gauge_aria', { depth: gaugeDepth(row), total: 3 })}
          >
            <span class="wr-gauge-step" class:filled={gaugeDepth(row) >= 1}
              >{t('workRefusal.viewer.gauge.step1')}</span
            >
            <span class="wr-gauge-step" class:filled={gaugeDepth(row) >= 2}
              >{t('workRefusal.viewer.gauge.step2')}</span
            >
            <span class="wr-gauge-step" class:filled={gaugeDepth(row) >= 3}
              >{t('workRefusal.viewer.gauge.step3')}</span
            >
          </div>
          <div class="wr-row-chips">
            <span class="wr-info-chip" data-testid="wr-days-chip">
              <span class="wr-chip-key">{t('workRefusal.viewer.days_label')}:</span>
              <code>{row.days_since_filed}</code>
            </span>
            <span class="wr-info-chip" data-testid="wr-actor-chip">
              <span class="wr-chip-key">{t('workRefusal.viewer.filed_by')}:</span>
              <code>{row.actor_pseudonym}</code>
            </span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .wr-section {
    display: block;
  }
  .wr-header {
    margin-block-end: 1rem;
  }
  .wr-heading-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 0.75rem;
  }
  .wr-c4-badge {
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
  .wr-stages-note {
    margin-block: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-tint-blue-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    font-size: 0.8125rem;
  }
  .wr-stages-note strong {
    font-weight: 600;
    margin-inline-end: 0.25rem;
  }

  .wr-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-block: 0.75rem;
  }
  .wr-controls .btn-outline {
    min-height: 2.25rem;
    padding-inline: 0.875rem;
    font-size: 0.8125rem;
  }
  .wr-page-indicator {
    color: var(--color-fg-muted);
    font-size: 0.8125rem;
    margin-inline-start: auto;
  }

  .wr-list {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  /* C4 accent — same destructive inline-start border as /reprisal rows. */
  .wr-row {
    display: block;
    padding: 0.875rem 1rem;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    border-inline-start: 4px solid var(--color-destructive);
  }
  .wr-row + .wr-row {
    border-block-start: 1px solid var(--color-border);
  }
  .wr-row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 0.75rem;
  }
  .wr-row-date {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--color-fg-muted);
    margin-inline-start: auto;
  }

  .wr-stage-pin,
  .wr-altwork-chip,
  .wr-resolved-at-chip {
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
  .wr-stage-pin.active {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-color: var(--color-tint-amber-border);
  }
  .wr-stage-pin.resolved {
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
    border-color: var(--color-tint-green-border);
  }
  .wr-resolved-at-chip {
    background: var(--color-tint-neutral-bg);
    color: var(--color-tint-neutral-fg);
    border-color: var(--color-tint-neutral-border);
    text-transform: none;
    font-weight: 500;
  }
  .wr-altwork-chip {
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    border-color: var(--color-tint-blue-border);
  }

  .wr-row-title {
    margin-block: 0.5rem 0.5rem;
    font-size: 0.9375rem;
    line-height: 1.4;
  }

  /* Three-step s. 43 stage gauge. Filled steps use the amber tint;
     unfilled stay neutral so progression reads left-to-right. */
  .wr-gauge {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-block-end: 0.5rem;
  }
  .wr-gauge-step {
    display: inline-flex;
    align-items: center;
    padding: 0.0625rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-muted);
    color: var(--color-fg-muted);
    font-size: 0.6875rem;
  }
  .wr-gauge-step.filled {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-color: var(--color-tint-amber-border);
    font-weight: 600;
  }

  .wr-row-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    font-size: 0.6875rem;
  }
  .wr-info-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
    padding: 0.0625rem 0.375rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-muted);
  }
  .wr-chip-key {
    color: var(--color-fg-muted);
  }
  .wr-info-chip code {
    font-family: var(--font-mono);
    color: var(--color-fg);
  }

  .wr-alert {
    margin-block: 0.75rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-red-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
  }
</style>
