<script>
  /**
   * /concerns — JHSC concerns register viewer mount.
   *
   * Replaces the PR #136 coming-soon placeholder. Mounts ConcernsViewer
   * with the demo provider so the register surface renders realistic
   * content until T08.1 wires the production SupabaseConcernsClient.
   *
   * Multi-axis URL filtering: status + severity + hazard, plus a sort
   * direction. Each axis chip rail composes URL state via buildHref
   * so the other axes survive a chip click.
   *
   *   ?filter=<status>      open / triaged / resolved / archived
   *   ?severity=<value>     low / medium / high / critical
   *   ?hazard=<value>       physical / chemical / biological / ergonomic / psychosocial
   *   ?sort=oldest          flips newest-first to oldest-first
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import ConcernsViewer from '$lib/concerns/ConcernsViewer.svelte';
  import { buildDemoConcerns, fetchDemoConcernsPage } from '$lib/concerns/demo-concerns';
  import FilterBanner from '$lib/ui/FilterBanner.svelte';
  import FilterChipsRail from '$lib/ui/FilterChipsRail.svelte';
  import CsvDownloadButton from '$lib/ui/CsvDownloadButton.svelte';
  import ShareUrlButton from '$lib/ui/ShareUrlButton.svelte';
  import SaveViewButton from '$lib/ui/SaveViewButton.svelte';
  import SavedViewsRail from '$lib/ui/SavedViewsRail.svelte';
  import SortToggle from '$lib/ui/SortToggle.svelte';
  import DateRangeChips from '$lib/ui/DateRangeChips.svelte';
  import ActiveFiltersBar from '$lib/ui/ActiveFiltersBar.svelte';
  import { buildHref } from '$lib/ui/url-state';
  import { withinRange } from '$lib/ui/date-range';
  import { toCsv, csvFilename } from '$lib/ui/csv';

  const DEMO_ROWS = buildDemoConcerns(50);

  const CSV_FIELDS = /** @type {const} */ ([
    'id',
    'filed_at',
    'title',
    'status',
    'severity',
    'hazard_class',
    'source_protected',
    'days_since_filed',
    'actor_pseudonym'
  ]);

  const STATUS_VALUES = /** @type {const} */ (['open', 'triaged', 'resolved', 'archived']);
  const SEVERITY_VALUES = /** @type {const} */ (['low', 'medium', 'high', 'critical']);
  const HAZARD_VALUES = /** @type {const} */ ([
    'physical',
    'chemical',
    'biological',
    'ergonomic',
    'psychosocial'
  ]);

  $: filterParam = $page.url.searchParams.get('filter');
  $: severityParam = $page.url.searchParams.get('severity');
  $: hazardParam = $page.url.searchParams.get('hazard');
  $: sortParam = $page.url.searchParams.get('sort');
  $: fromParam = $page.url.searchParams.get('from');
  $: toParam = $page.url.searchParams.get('to');

  $: activeStatus =
    filterParam && STATUS_VALUES.includes(/** @type {any} */ (filterParam)) ? filterParam : null;
  $: activeSeverity =
    severityParam && SEVERITY_VALUES.includes(/** @type {any} */ (severityParam))
      ? severityParam
      : null;
  $: activeHazard =
    hazardParam && HAZARD_VALUES.includes(/** @type {any} */ (hazardParam)) ? hazardParam : null;

  $: anyAxisActive = !!(activeStatus || activeSeverity || activeHazard || fromParam || toParam);

  $: filterLabel = activeStatus === 'open' ? t('common.filterBanner.label.concerns_open') : null;

  // Preserved-param sets for each chip rail's hrefs. Each rail's chips
  // change THEIR axis; the other axes survive verbatim.
  $: preservedForStatus = {
    severity: activeSeverity,
    hazard: activeHazard,
    sort: sortParam,
    from: fromParam,
    to: toParam
  };
  $: preservedForSeverity = {
    filter: activeStatus,
    hazard: activeHazard,
    sort: sortParam,
    from: fromParam,
    to: toParam
  };
  $: preservedForHazard = {
    filter: activeStatus,
    severity: activeSeverity,
    sort: sortParam,
    from: fromParam,
    to: toParam
  };
  $: preservedForSort = {
    filter: activeStatus,
    severity: activeSeverity,
    hazard: activeHazard,
    from: fromParam,
    to: toParam
  };
  $: preservedForDateRange = {
    filter: activeStatus,
    severity: activeSeverity,
    hazard: activeHazard,
    sort: sortParam
  };

  $: statusChips = [
    {
      href: buildHref('/concerns', preservedForStatus, { filter: null }),
      label: t('common.filterChips.all'),
      value: null
    },
    ...STATUS_VALUES.map((v) => ({
      href: buildHref('/concerns', preservedForStatus, { filter: v }),
      label: t(`concern.viewer.status.${v}`),
      value: v
    }))
  ];

  $: severityChips = [
    {
      href: buildHref('/concerns', preservedForSeverity, { severity: null }),
      label: t('common.filterChips.all'),
      value: null
    },
    ...SEVERITY_VALUES.map((v) => ({
      href: buildHref('/concerns', preservedForSeverity, { severity: v }),
      label: t(`concern.viewer.severity.${v}`),
      value: v
    }))
  ];

  $: hazardChips = [
    {
      href: buildHref('/concerns', preservedForHazard, { hazard: null }),
      label: t('common.filterChips.all'),
      value: null
    },
    ...HAZARD_VALUES.map((v) => ({
      href: buildHref('/concerns', preservedForHazard, { hazard: v }),
      label: t(`concern.viewer.hazard.${v}`),
      value: v
    }))
  ];

  $: activeFilterLabel = (() => {
    if (activeStatus) {
      const chip = statusChips.find((c) => c.value === activeStatus);
      if (chip?.label) return chip.label;
    }
    if (filterLabel) return filterLabel;
    return null;
  })();
  $: pageTitle = activeFilterLabel ?? t('common.concernsPage.title');

  // ActiveFiltersBar descriptors. One entry per currently-active axis,
  // each with a removeHref that returns the URL minus that one axis.
  $: activeFilters = (() => {
    /** @type {Array<{ key: string, label: string, removeHref: string }>} */
    const list = [];
    if (activeStatus) {
      list.push({
        key: 'status',
        label: `${t('common.activeFilters.axis.status')}: ${t(`concern.viewer.status.${activeStatus}`)}`,
        removeHref: buildHref('/concerns', preservedForStatus, { filter: null })
      });
    }
    if (activeSeverity) {
      list.push({
        key: 'severity',
        label: `${t('common.activeFilters.axis.severity')}: ${t(`concern.viewer.severity.${activeSeverity}`)}`,
        removeHref: buildHref('/concerns', preservedForSeverity, { severity: null })
      });
    }
    if (activeHazard) {
      list.push({
        key: 'hazard',
        label: `${t('common.activeFilters.axis.hazard')}: ${t(`concern.viewer.hazard.${activeHazard}`)}`,
        removeHref: buildHref('/concerns', preservedForHazard, { hazard: null })
      });
    }
    if (fromParam || toParam) {
      list.push({
        key: 'date',
        label: `${t('common.activeFilters.axis.date_range')}: ${fromParam ?? '…'} → ${toParam ?? '…'}`,
        removeHref: buildHref(
          '/concerns',
          { filter: activeStatus, severity: activeSeverity, hazard: activeHazard, sort: sortParam },
          { from: null, to: null }
        )
      });
    }
    if (sortParam === 'oldest') {
      list.push({
        key: 'sort',
        label: `${t('common.activeFilters.axis.sort')}: ${t('common.sortToggle.oldest')}`,
        removeHref: buildHref('/concerns', {
          filter: activeStatus,
          severity: activeSeverity,
          hazard: activeHazard,
          from: fromParam,
          to: toParam
        })
      });
    }
    return list;
  })();

  /** Composed multi-axis predicate (status, severity, hazard, date range). */
  $: predicate = anyAxisActive
    ? /** @param {import('$lib/concerns/demo-concerns').DemoConcernRow} r */ (r) => {
        if (activeStatus && r.status !== activeStatus) return false;
        if (activeSeverity && r.severity !== activeSeverity) return false;
        if (activeHazard && r.hazard_class !== activeHazard) return false;
        if ((fromParam || toParam) && !withinRange(r.filed_at, fromParam, toParam)) return false;
        return true;
      }
    : undefined;

  // Sort: default is newest-first (the demo provider returns rows in
  // that order). `?sort=oldest` reverses before pagination.
  $: sortedRows = sortParam === 'oldest' ? [...DEMO_ROWS].reverse() : DEMO_ROWS;

  $: fetchPage =
    /**
     * @param {number} p
     * @param {number} ps
     */
    (p, ps) => fetchDemoConcernsPage(p, ps, sortedRows, predicate);

  function buildDownload() {
    const rows = predicate ? sortedRows.filter(predicate) : sortedRows;
    return {
      csv: toCsv(rows, CSV_FIELDS),
      filename: csvFilename(
        'concerns',
        new Date(),
        activeFilters.map((f) => f.key + '-' + f.label)
      )
    };
  }

  // The {#key} block remounts the viewer when ANY axis or the sort
  // changes — resets the page indicator to page 1.
  $: viewerKey = `${filterParam ?? ''}|${severityParam ?? ''}|${hazardParam ?? ''}|${sortParam ?? ''}|${fromParam ?? ''}|${toParam ?? ''}`;
</script>

<svelte:head>
  <title>{pageTitle} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card con-card" data-testid="concerns-page">
  <ActiveFiltersBar baseHref="/concerns" filters={activeFilters} />
  <SavedViewsRail route="/concerns" />
  <FilterChipsRail chips={statusChips} activeValue={activeStatus} />
  <FilterChipsRail
    chips={severityChips}
    activeValue={activeSeverity}
    ariaLabelKey="common.filterChips.severity_aria_label"
  />
  <FilterChipsRail
    chips={hazardChips}
    activeValue={activeHazard}
    ariaLabelKey="common.filterChips.hazard_aria_label"
  />
  <DateRangeChips
    baseHref="/concerns"
    {fromParam}
    {toParam}
    preservedParams={preservedForDateRange}
  />
  <SortToggle baseHref="/concerns" activeSort={sortParam} preservedParams={preservedForSort} />
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/concerns" />
  {/if}
  <CsvDownloadButton onClick={buildDownload} />
  <ShareUrlButton />
  <SaveViewButton suggestedName={activeFilters.map((f) => f.label).join(' · ')} />
  {#key viewerKey}
    <ConcernsViewer
      {fetchPage}
      filterActive={anyAxisActive}
      filterLabel={activeFilterLabel}
      clearHref="/concerns"
    />
  {/key}
  <p class="con-demo-note muted" data-testid="con-demo-note">
    {t('concern.viewer.demo_note')}
  </p>
  <p class="con-footer" data-print="hide">
    <a href="/" data-testid="concerns-back-to-home">
      {t('common.concernsPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .con-card {
    margin-block-start: 1rem;
  }
  .con-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .con-footer {
    margin-block-start: 0.75rem;
  }
</style>
