<script>
  /**
   * /recommendations — JHSC recommendations register viewer mount.
   *
   * Replaces the PR #138 coming-soon placeholder. Mounts
   * RecommendationsViewer with the demo provider so the surface
   * renders realistic content until T12 wires the real backend.
   *
   * Supports URL-driven filtering on `status` (one of responded /
   * pending / overdue / archived) via `?filter=<value>`. A
   * FilterChipsRail above the viewer lets the worker swap chips
   * without typing the URL. The "Overdue recommendations" home
   * dashboard tile deep-links here with `?filter=overdue` already
   * highlighted.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import RecommendationsViewer from '$lib/recommendations/RecommendationsViewer.svelte';
  import {
    buildDemoRecommendations,
    fetchDemoRecommendationsPage
  } from '$lib/recommendations/demo-recommendations';
  import FilterBanner from '$lib/ui/FilterBanner.svelte';
  import FilterChipsRail from '$lib/ui/FilterChipsRail.svelte';
  import CsvDownloadButton from '$lib/ui/CsvDownloadButton.svelte';
  import SortToggle from '$lib/ui/SortToggle.svelte';
  import DateRangeChips from '$lib/ui/DateRangeChips.svelte';
  import { withinRange } from '$lib/ui/date-range';
  import { toCsv, csvFilename } from '$lib/ui/csv';

  const DEMO_ROWS = buildDemoRecommendations(50);

  const CSV_FIELDS = /** @type {const} */ ([
    'id',
    'filed_at',
    'title',
    'status',
    'days_elapsed',
    'traceability_concern_id',
    'traceability_inspection_id',
    'actor_pseudonym'
  ]);

  /** Canonical status values supported by `?filter=`. */
  const STATUS_VALUES = /** @type {const} */ (['responded', 'pending', 'overdue', 'archived']);

  $: filterParam = $page.url.searchParams.get('filter');
  $: activeValue =
    filterParam && STATUS_VALUES.includes(/** @type {any} */ (filterParam)) ? filterParam : null;
  $: filterLabel =
    activeValue === 'overdue' ? t('common.filterBanner.label.recommendations_overdue') : null;

  $: chips = [
    { href: '/recommendations', label: t('common.filterChips.all'), value: null },
    {
      href: '/recommendations?filter=responded',
      label: t('recommendations.viewer.status.responded'),
      value: 'responded'
    },
    {
      href: '/recommendations?filter=pending',
      label: t('recommendations.viewer.status.pending'),
      value: 'pending'
    },
    {
      href: '/recommendations?filter=overdue',
      label: t('recommendations.viewer.status.overdue'),
      value: 'overdue'
    },
    {
      href: '/recommendations?filter=archived',
      label: t('recommendations.viewer.status.archived'),
      value: 'archived'
    }
  ];

  $: activeFilterLabel = (() => {
    if (activeValue) {
      const chip = chips.find((c) => c.value === activeValue);
      if (chip?.label) return chip.label;
    }
    if (filterLabel) return filterLabel;
    return null;
  })();
  $: pageTitle = activeFilterLabel ?? t('common.recommendationsPage.title');

  $: fromParam = $page.url.searchParams.get('from');
  $: toParam = $page.url.searchParams.get('to');

  $: predicate = (() => {
    const statusPred = activeValue
      ? /** @param {import('$lib/recommendations/demo-recommendations').DemoRecommendationRow} r */ (
          r
        ) => r.status === activeValue
      : null;
    const hasRange = fromParam || toParam;
    if (!statusPred && !hasRange) return undefined;
    return /** @param {import('$lib/recommendations/demo-recommendations').DemoRecommendationRow} r */ (
      r
    ) => {
      if (statusPred && !statusPred(r)) return false;
      if (hasRange && !withinRange(r.filed_at, fromParam, toParam)) return false;
      return true;
    };
  })();
  $: fetchPage =
    /**
     * @param {number} p
     * @param {number} ps
     */
    (p, ps) => fetchDemoRecommendationsPage(p, ps, sortedRows, predicate);

  $: sortParam = $page.url.searchParams.get('sort');
  $: sortedRows = sortParam === 'oldest' ? [...DEMO_ROWS].reverse() : DEMO_ROWS;

  function buildDownload() {
    const rows = predicate ? sortedRows.filter(predicate) : sortedRows;
    return { csv: toCsv(rows, CSV_FIELDS), filename: csvFilename('recommendations') };
  }
</script>

<svelte:head>
  <title>{pageTitle} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card recs-card" data-testid="recommendations-page">
  <FilterChipsRail {chips} {activeValue} />
  <DateRangeChips
    baseHref="/recommendations"
    {fromParam}
    {toParam}
    preservedParams={{ filter: filterParam, sort: sortParam }}
  />
  <SortToggle
    baseHref="/recommendations"
    activeSort={sortParam}
    preservedParams={{ filter: filterParam, from: fromParam, to: toParam }}
  />
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/recommendations" />
  {/if}
  <CsvDownloadButton onClick={buildDownload} />
  {#key `${filterParam ?? ''}|${sortParam ?? ''}|${fromParam ?? ''}|${toParam ?? ''}`}
    <RecommendationsViewer
      {fetchPage}
      filterActive={filterParam !== null || !!fromParam || !!toParam}
      filterLabel={activeFilterLabel}
    />
  {/key}
  <p class="recs-demo-note muted" data-testid="recs-demo-note">
    {t('recommendations.viewer.demo_note')}
  </p>
  <p class="recs-footer" data-print="hide">
    <a href="/" data-testid="recommendations-back-to-home">
      {t('common.recommendationsPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .recs-card {
    margin-block-start: 1rem;
  }
  .recs-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .recs-footer {
    margin-block-start: 0.75rem;
  }
</style>
