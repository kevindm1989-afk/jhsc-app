<script>
  /**
   * /inspections — JHSC inspections register viewer mount.
   *
   * Replaces the PR #136 coming-soon placeholder. Mounts
   * InspectionsViewer with the demo provider so the surface renders
   * realistic content until T10.1 wires the real backend.
   *
   * Supports URL-driven filtering on `integrity_status` (one of
   * verified / quarantined) via `?filter=<value>`. A FilterChipsRail
   * above the viewer lets the worker swap chips without typing the
   * URL.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import InspectionsViewer from '$lib/inspections/InspectionsViewer.svelte';
  import {
    buildDemoInspections,
    fetchDemoInspectionsPage
  } from '$lib/inspections/demo-inspections';
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

  const DEMO_ROWS = buildDemoInspections(50);

  const CSV_FIELDS = /** @type {const} */ ([
    'id',
    'area',
    'conducted_at',
    'checklist_item_count',
    'photo_count',
    'integrity_status',
    'was_offline_queued',
    'notes_preview',
    'actor_pseudonym'
  ]);

  /** Canonical integrity-status values supported by `?filter=`. */
  const INTEGRITY_VALUES = /** @type {const} */ (['verified', 'quarantined']);

  $: filterParam = $page.url.searchParams.get('filter');
  $: activeValue =
    filterParam && INTEGRITY_VALUES.includes(/** @type {any} */ (filterParam)) ? filterParam : null;
  $: filterLabel =
    activeValue === 'quarantined' ? t('common.filterBanner.label.inspections_quarantined') : null;

  $: chips = [
    { href: '/inspections', label: t('common.filterChips.all'), value: null },
    {
      href: '/inspections?filter=verified',
      label: t('inspection.viewer.integrity.verified'),
      value: 'verified'
    },
    {
      href: '/inspections?filter=quarantined',
      label: t('inspection.viewer.integrity.quarantined'),
      value: 'quarantined'
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
  $: pageTitle = activeFilterLabel ?? t('common.inspectionsPage.title');

  // ActiveFiltersBar descriptors — one entry per active axis.
  $: activeFilters = (() => {
    /** @type {Array<{ key: string, label: string, removeHref: string }>} */
    const list = [];
    if (activeValue) {
      list.push({
        key: 'filter',
        label: `${t('common.activeFilters.axis.integrity_status')}: ${t(`inspection.viewer.integrity.${activeValue}`)}`,
        removeHref: buildHref('/inspections', { sort: sortParam, from: fromParam, to: toParam })
      });
    }
    if (fromParam || toParam) {
      list.push({
        key: 'date',
        label: `${t('common.activeFilters.axis.date_range')}: ${fromParam ?? '…'} → ${toParam ?? '…'}`,
        removeHref: buildHref('/inspections', { filter: filterParam, sort: sortParam })
      });
    }
    if (sortParam === 'oldest') {
      list.push({
        key: 'sort',
        label: `${t('common.activeFilters.axis.sort')}: ${t('common.sortToggle.oldest')}`,
        removeHref: buildHref('/inspections', { filter: filterParam, from: fromParam, to: toParam })
      });
    }
    return list;
  })();

  $: fromParam = $page.url.searchParams.get('from');
  $: toParam = $page.url.searchParams.get('to');

  $: predicate = (() => {
    const integrityPred = activeValue
      ? /** @param {import('$lib/inspections/demo-inspections').DemoInspectionRow} r */ (r) =>
          r.integrity_status === activeValue
      : null;
    const hasRange = fromParam || toParam;
    if (!integrityPred && !hasRange) return undefined;
    return /** @param {import('$lib/inspections/demo-inspections').DemoInspectionRow} r */ (r) => {
      if (integrityPred && !integrityPred(r)) return false;
      if (hasRange && !withinRange(r.conducted_at, fromParam, toParam)) return false;
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
    (p, ps) => fetchDemoInspectionsPage(p, ps, sortedRows, predicate);

  function buildDownload() {
    const rows = predicate ? sortedRows.filter(predicate) : sortedRows;
    return { csv: toCsv(rows, CSV_FIELDS), filename: csvFilename('inspections') };
  }
</script>

<svelte:head>
  <title>{pageTitle} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card ins-card" data-testid="inspections-page">
  <ActiveFiltersBar baseHref="/inspections" filters={activeFilters} />
  <SavedViewsRail route="/inspections" />
  <FilterChipsRail {chips} {activeValue} />
  <DateRangeChips
    baseHref="/inspections"
    {fromParam}
    {toParam}
    preservedParams={{ filter: filterParam, sort: sortParam }}
  />
  <SortToggle
    baseHref="/inspections"
    activeSort={sortParam}
    preservedParams={{ filter: filterParam, from: fromParam, to: toParam }}
  />
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/inspections" />
  {/if}
  <CsvDownloadButton onClick={buildDownload} />
  <ShareUrlButton />
  <SaveViewButton suggestedName={activeFilters.map((f) => f.label).join(' · ')} />
  {#key `${filterParam ?? ''}|${sortParam ?? ''}|${fromParam ?? ''}|${toParam ?? ''}`}
    <InspectionsViewer
      {fetchPage}
      filterActive={filterParam !== null || !!fromParam || !!toParam}
      filterLabel={activeFilterLabel}
    />
  {/key}
  <p class="ins-demo-note muted" data-testid="ins-demo-note">
    {t('inspection.viewer.demo_note')}
  </p>
  <p class="ins-footer" data-print="hide">
    <a href="/" data-testid="inspections-back-to-home">
      {t('common.inspectionsPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .ins-card {
    margin-block-start: 1rem;
  }
  .ins-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .ins-footer {
    margin-block-start: 0.75rem;
  }
</style>
