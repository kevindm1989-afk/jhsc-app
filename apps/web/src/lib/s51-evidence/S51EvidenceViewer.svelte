<script>
  /**
   * S51EvidenceViewer — JHSC C4-tier OHSA s. 51 critical-injury
   * evidence register.
   *
   * Same architectural pattern as the other register viewers (backend-
   * agnostic provider injection + pagination + worker-hub styling).
   * Bespoke row layout to surface the s. 51 evidence attributes at a
   * glance:
   *
   *   - Scene-preservation pin per s. 51(2): "Preserving — Nh left"
   *     (red, counts down the 48-hour window), "Released by inspector"
   *     (green), or "48-hour window expired" (neutral).
   *   - Per-row destructive-red inline-start border — C4 accent shared
   *     with /reprisal and /work-refusal.
   *   - Passphrase-sealed chip (C4 default).
   *   - Worker-member-present chip — s. 51 requires a worker member at
   *     the investigation; the rare "not present" case renders amber
   *     because it is itself a compliance gap.
   *   - Photo + witness-statement counts + pseudonymized actor.
   *
   * Reads pages via `fetchPage(page, page_size)`; the T14 wire-up
   * swaps in a real client with no viewer-side changes.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import SkeletonRows from '$lib/ui/SkeletonRows.svelte';

  /**
   * @type {(page: number, page_size: number) => Promise<{
   *   rows: import('./demo-s51-evidence').DemoS51EvidenceRow[];
   *   total: number;
   *   page: number;
   *   page_size: number;
   * }>}
   */
  export let fetchPage = async () => {
    throw new Error('S51EvidenceViewer: fetchPage not wired');
  };

  export let pageSize = 10;

  /** True when the route page has applied a filter; switches the
   *  empty state copy to a "no matches for this filter" message. */
  export let filterActive = false;

  /** When non-null, the active filter label echoes in the h1. */
  export let filterLabel = null;

  /** @type {import('./demo-s51-evidence').DemoS51EvidenceRow[]} */
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

  /** @param {import('./demo-s51-evidence').DemoS51EvidenceRow} row */
  function sceneLabel(row) {
    if (row.scene_state === 'preserving') {
      return t('s51.viewer.scene.preserving', { hours: row.hours_remaining ?? 0 });
    }
    return t(`s51.viewer.scene.${row.scene_state}`);
  }

  $: pageCount = total === 0 ? 1 : Math.ceil(total / pageSize);
  $: hasPrev = page > 0 && !loading;
  $: hasNext = (page + 1) * pageSize < total && !loading;
</script>

<section
  class="s51-section"
  aria-labelledby="s51-heading"
  aria-busy={loading ? 'true' : 'false'}
  data-testid="s51-viewer-section"
>
  <header class="s51-header">
    <div class="s51-heading-row">
      <h1 id="s51-heading">
        {t('s51.viewer.heading')}{#if filterLabel}<span
            class="viewer-heading-filter"
            data-testid="viewer-heading-filter">{' '}— {filterLabel}</span
          >{/if}
      </h1>
      <span class="s51-c4-badge" data-testid="s51-c4-badge">C4</span>
    </div>
    <p class="muted">{t('s51.viewer.intro')}</p>
    <p class="s51-scene-note" data-testid="s51-scene-note">
      <strong>{t('s51.viewer.scene_note.label')}:</strong>
      {t('s51.viewer.scene_note.value')}
    </p>
  </header>

  {#if loading}
    <div role="status" aria-label={t('s51.viewer.loading')} data-testid="s51-loading">
      <SkeletonRows />
    </div>
  {:else if loadError}
    <p class="s51-alert" role="alert" data-testid="s51-load-error">
      {t('s51.viewer.error.load_failed')}
    </p>
  {:else if rows.length === 0}
    <p class="muted" role="status" data-testid="s51-empty">
      {filterActive ? t('common.filterEmptyState.no_matches') : t('s51.viewer.empty')}
    </p>
  {:else}
    <div class="s51-controls" data-testid="s51-controls" data-print="hide">
      <button
        type="button"
        class="btn-outline"
        on:click={onPrev}
        disabled={!hasPrev}
        data-testid="s51-prev"
      >
        {t('s51.viewer.prev')}
      </button>
      <span class="s51-page-indicator" data-testid="s51-page-indicator">
        {t('s51.viewer.page_indicator', { page: page + 1, total: pageCount })}
        <span class="pagination-total" data-testid="pagination-total"
          >· {t('common.pagination.total_entries', { count: total })}</span
        >
      </span>
      <button
        type="button"
        class="btn-outline"
        on:click={onNext}
        disabled={!hasNext}
        data-testid="s51-next"
      >
        {t('s51.viewer.next')}
      </button>
    </div>

    <ul class="s51-list" data-testid="s51-list">
      {#each rows as row (row.id)}
        <li class="s51-row" data-testid="s51-row" data-scene-state={row.scene_state}>
          <div class="s51-row-head">
            <span
              class="s51-scene-pin"
              class:preserving={row.scene_state === 'preserving'}
              class:released={row.scene_state === 'released_by_inspector'}
              class:expired={row.scene_state === 'window_expired'}
              data-testid="s51-scene-pin"
            >
              {sceneLabel(row)}
            </span>
            {#if row.per_entry_passphrase_required}
              <span class="s51-passphrase-chip" data-testid="s51-passphrase-chip">
                {t('s51.viewer.passphrase_required')}
              </span>
            {/if}
            <time class="s51-row-date" data-testid="s51-row-date">{formatDate(row.opened_at)}</time>
          </div>
          <p class="s51-row-title" data-testid="s51-row-title">{row.title}</p>
          <div class="s51-row-chips">
            <span
              class="s51-member-chip"
              class:present={row.worker_member_present}
              class:absent={!row.worker_member_present}
              data-testid="s51-member-chip"
            >
              {row.worker_member_present
                ? t('s51.viewer.member.present')
                : t('s51.viewer.member.absent')}
            </span>
            <span class="s51-info-chip" data-testid="s51-photos-chip">
              <span class="s51-chip-key">{t('s51.viewer.photos_label')}:</span>
              <code>{row.photo_count}</code>
            </span>
            <span class="s51-info-chip" data-testid="s51-witness-chip">
              <span class="s51-chip-key">{t('s51.viewer.witness_label')}:</span>
              <code>{row.witness_statement_count}</code>
            </span>
            <span class="s51-info-chip" data-testid="s51-actor-chip">
              <span class="s51-chip-key">{t('s51.viewer.opened_by')}:</span>
              <code>{row.actor_pseudonym}</code>
            </span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .s51-section {
    display: block;
  }
  .s51-header {
    margin-block-end: 1rem;
  }
  .s51-heading-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 0.75rem;
  }
  .s51-c4-badge {
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
  .s51-scene-note {
    margin-block: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-tint-red-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    font-size: 0.8125rem;
  }
  .s51-scene-note strong {
    font-weight: 600;
    margin-inline-end: 0.25rem;
  }

  .s51-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-block: 0.75rem;
  }
  .s51-controls .btn-outline {
    min-height: 2.25rem;
    padding-inline: 0.875rem;
    font-size: 0.8125rem;
  }
  .s51-page-indicator {
    color: var(--color-fg-muted);
    font-size: 0.8125rem;
    margin-inline-start: auto;
  }

  .s51-list {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  /* C4 accent — same destructive inline-start border as /reprisal rows. */
  .s51-row {
    display: block;
    padding: 0.875rem 1rem;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    border-inline-start: 4px solid var(--color-destructive);
  }
  .s51-row + .s51-row {
    border-block-start: 1px solid var(--color-border);
  }
  .s51-row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 0.75rem;
  }
  .s51-row-date {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--color-fg-muted);
    margin-inline-start: auto;
  }

  .s51-scene-pin,
  .s51-passphrase-chip {
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
  .s51-scene-pin.preserving {
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-color: var(--color-tint-red-border);
  }
  .s51-scene-pin.released {
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
    border-color: var(--color-tint-green-border);
  }
  .s51-scene-pin.expired {
    background: var(--color-tint-neutral-bg);
    color: var(--color-tint-neutral-fg);
    border-color: var(--color-tint-neutral-border);
  }
  .s51-passphrase-chip {
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    border-color: var(--color-tint-blue-border);
  }

  .s51-row-title {
    margin-block: 0.5rem 0.5rem;
    font-size: 0.9375rem;
    line-height: 1.4;
  }

  .s51-row-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    font-size: 0.6875rem;
  }
  .s51-info-chip,
  .s51-member-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
    padding: 0.0625rem 0.375rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-muted);
  }
  .s51-member-chip {
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .s51-member-chip.present {
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
    border-color: var(--color-tint-green-border);
  }
  /* "Worker member not present" is itself a compliance gap — amber. */
  .s51-member-chip.absent {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-color: var(--color-tint-amber-border);
  }
  .s51-chip-key {
    color: var(--color-fg-muted);
  }
  .s51-info-chip code {
    font-family: var(--font-mono);
    color: var(--color-fg);
  }

  .s51-alert {
    margin-block: 0.75rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-red-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
  }
</style>
