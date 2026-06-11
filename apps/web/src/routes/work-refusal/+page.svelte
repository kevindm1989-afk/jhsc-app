<script>
  /**
   * /work-refusal — JHSC C4-tier OHSA s. 43 work-refusal register mount.
   *
   * Replaces the PR #139 coming-soon placeholder. Mounts
   * WorkRefusalViewer with the demo provider so the register surface
   * renders realistic content until the work-refusal-module backend
   * is wired.
   *
   * Supports URL-driven filtering on `stage` (one of worker_refusal /
   * s43_4_investigation / s43_8_mol / resolved) via `?filter=<value>`,
   * plus a macro `?filter=active` (stage !== 'resolved') for the
   * home dashboard tile. The chip rail surfaces each individual stage;
   * the macro doesn't highlight a chip but still shows the FilterBanner.
   *
   * Work refusals are sensitivity C4 — the card carries the
   * destructive-red inline-start border shared with /reprisal and
   * /s51-evidence.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import WorkRefusalViewer from '$lib/work-refusal/WorkRefusalViewer.svelte';
  import {
    buildDemoWorkRefusals,
    fetchDemoWorkRefusalPage
  } from '$lib/work-refusal/demo-work-refusal';
  import FilterBanner from '$lib/ui/FilterBanner.svelte';
  import FilterChipsRail from '$lib/ui/FilterChipsRail.svelte';
  import CsvDownloadButton from '$lib/ui/CsvDownloadButton.svelte';
  import ActiveFiltersBar from '$lib/ui/ActiveFiltersBar.svelte';
  import ShareUrlButton from '$lib/ui/ShareUrlButton.svelte';
  import SaveViewButton from '$lib/ui/SaveViewButton.svelte';
  import SavedViewsRail from '$lib/ui/SavedViewsRail.svelte';
  import SortToggle from '$lib/ui/SortToggle.svelte';
  import DateRangeChips from '$lib/ui/DateRangeChips.svelte';
  import { buildHref } from '$lib/ui/url-state';
  import { withinRange } from '$lib/ui/date-range';
  import { toCsv, csvFilename } from '$lib/ui/csv';

  const DEMO_ROWS = buildDemoWorkRefusals(50);

  const CSV_FIELDS = /** @type {const} */ ([
    'id',
    'filed_at',
    'title',
    'stage',
    'resolved_at_stage',
    'alternative_work_assigned',
    'days_since_filed',
    'actor_pseudonym'
  ]);

  /** Canonical stage values supported by `?filter=`. */
  const STAGE_VALUES = /** @type {const} */ ([
    'worker_refusal',
    's43_4_investigation',
    's43_8_mol',
    'resolved'
  ]);

  $: filterParam = $page.url.searchParams.get('filter');
  $: activeValue =
    filterParam && STAGE_VALUES.includes(/** @type {any} */ (filterParam)) ? filterParam : null;
  $: filterLabel =
    filterParam === 'active' ? t('common.filterBanner.label.work_refusal_active') : null;

  $: chips = [
    { href: '/work-refusal', label: t('common.filterChips.all'), value: null },
    {
      href: '/work-refusal?filter=worker_refusal',
      label: t('workRefusal.viewer.stage.worker_refusal'),
      value: 'worker_refusal'
    },
    {
      href: '/work-refusal?filter=s43_4_investigation',
      label: t('workRefusal.viewer.stage.s43_4_investigation'),
      value: 's43_4_investigation'
    },
    {
      href: '/work-refusal?filter=s43_8_mol',
      label: t('workRefusal.viewer.stage.s43_8_mol'),
      value: 's43_8_mol'
    },
    {
      href: '/work-refusal?filter=resolved',
      label: t('workRefusal.viewer.stage.resolved'),
      value: 'resolved'
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
  $: pageTitle = activeFilterLabel ?? t('common.workRefusalPage.title');

  // ActiveFiltersBar descriptors — one entry per active axis.
  $: activeFilters = (() => {
    /** @type {Array<{ key: string, label: string, removeHref: string }>} */
    const list = [];
    if (activeValue) {
      list.push({
        key: 'filter',
        label: `${t('common.activeFilters.axis.stage')}: ${t(`workRefusal.viewer.stage.${activeValue}`)}`,
        removeHref: buildHref('/work-refusal', { sort: sortParam, from: fromParam, to: toParam })
      });
    }
    if (filterParam === 'active') {
      list.push({
        key: 'filter',
        label: t('common.filterBanner.label.work_refusal_active'),
        removeHref: buildHref('/work-refusal', { sort: sortParam, from: fromParam, to: toParam })
      });
    }
    if (fromParam || toParam) {
      list.push({
        key: 'date',
        label: `${t('common.activeFilters.axis.date_range')}: ${fromParam ?? '…'} → ${toParam ?? '…'}`,
        removeHref: buildHref('/work-refusal', { filter: filterParam, sort: sortParam })
      });
    }
    if (sortParam === 'oldest') {
      list.push({
        key: 'sort',
        label: `${t('common.activeFilters.axis.sort')}: ${t('common.sortToggle.oldest')}`,
        removeHref: buildHref('/work-refusal', {
          filter: filterParam,
          from: fromParam,
          to: toParam
        })
      });
    }
    return list;
  })();

  $: fromParam = $page.url.searchParams.get('from');
  $: toParam = $page.url.searchParams.get('to');

  $: predicate = (() => {
    const stagePred = activeValue
      ? /** @param {import('$lib/work-refusal/demo-work-refusal').DemoWorkRefusalRow} r */ (r) =>
          r.stage === activeValue
      : filterParam === 'active'
        ? /** @param {import('$lib/work-refusal/demo-work-refusal').DemoWorkRefusalRow} r */ (r) =>
            r.stage !== 'resolved'
        : null;
    const hasRange = fromParam || toParam;
    if (!stagePred && !hasRange) return undefined;
    return /** @param {import('$lib/work-refusal/demo-work-refusal').DemoWorkRefusalRow} r */ (
      r
    ) => {
      if (stagePred && !stagePred(r)) return false;
      if (hasRange && !withinRange(r.filed_at, fromParam, toParam)) return false;
      return true;
    };
  })();
  $: sortParam = $page.url.searchParams.get('sort');
  $: sortedRows = sortParam === 'oldest' ? [...DEMO_ROWS].reverse() : DEMO_ROWS;

  $: fetchPage =
    /**
     * @param {number} p
     * @param {number} ps
     */
    (p, ps) => fetchDemoWorkRefusalPage(p, ps, sortedRows, predicate);

  function buildDownload() {
    const rows = predicate ? sortedRows.filter(predicate) : sortedRows;
    return {
      csv: toCsv(rows, CSV_FIELDS),
      filename: csvFilename(
        'work-refusal',
        new Date(),
        activeFilters.map((f) => f.key + '-' + f.label)
      )
    };
  }
</script>

<svelte:head>
  <title>{pageTitle} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card work-refusal-card" data-testid="work-refusal-page">
  <ActiveFiltersBar baseHref="/work-refusal" filters={activeFilters} />
  <SavedViewsRail route="/work-refusal" />
  <FilterChipsRail {chips} {activeValue} />
  <DateRangeChips
    baseHref="/work-refusal"
    {fromParam}
    {toParam}
    preservedParams={{ filter: filterParam, sort: sortParam }}
  />
  <SortToggle
    baseHref="/work-refusal"
    activeSort={sortParam}
    preservedParams={{ filter: filterParam, from: fromParam, to: toParam }}
  />
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/work-refusal" />
  {/if}
  <CsvDownloadButton onClick={buildDownload} />
  <ShareUrlButton />
  <SaveViewButton suggestedName={activeFilters.map((f) => f.label).join(' · ')} />
  {#key `${filterParam ?? ''}|${sortParam ?? ''}|${fromParam ?? ''}|${toParam ?? ''}`}
    <WorkRefusalViewer
      {fetchPage}
      filterActive={filterParam !== null || !!fromParam || !!toParam}
      filterLabel={activeFilterLabel}
      clearHref="/work-refusal"
    />
  {/key}
  <p class="wr-demo-note muted" data-testid="wr-demo-note">
    {t('workRefusal.viewer.demo_note')}
  </p>
  <p class="wr-footer" data-print="hide">
    <a href="/" data-testid="work-refusal-back-to-home">
      {t('common.workRefusalPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  /* C4 sensitivity accent — shared with /reprisal and /s51-evidence. */
  .work-refusal-card {
    margin-block-start: 1rem;
    border-inline-start: 4px solid var(--color-destructive);
  }
  .wr-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .wr-footer {
    margin-block-start: 0.75rem;
  }
</style>
