<script>
  /**
   * /library — JHSC committee document library register mount.
   *
   * Replaces the PR #139 coming-soon placeholder. Mounts LibraryViewer
   * with the demo provider so the surface renders realistic content
   * until the library-module backend is wired.
   *
   * Supports URL-driven filtering on `category` (one of policy /
   * procedure / training / legislation / template) via
   * `?filter=<value>`, plus a macro `?filter=offline` (offline_cached
   * === true) that's orthogonal to category. The chip rail surfaces
   * each category; the macro doesn't highlight a chip but still shows
   * the FilterBanner.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import LibraryViewer from '$lib/library/LibraryViewer.svelte';
  import { buildDemoLibrary, fetchDemoLibraryPage } from '$lib/library/demo-library';
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
  import { csvFilename, toCsv, withMetadata } from '$lib/ui/csv';

  const DEMO_ROWS = buildDemoLibrary(50);

  const CSV_FIELDS = /** @type {const} */ ([
    'id',
    'title',
    'category',
    'version',
    'updated_at',
    'language',
    'offline_cached'
  ]);

  /** Canonical category values supported by `?filter=`. */
  const CATEGORY_VALUES = /** @type {const} */ ([
    'policy',
    'procedure',
    'training',
    'legislation',
    'template'
  ]);

  $: filterParam = $page.url.searchParams.get('filter');
  $: activeValue =
    filterParam && CATEGORY_VALUES.includes(/** @type {any} */ (filterParam)) ? filterParam : null;
  $: filterLabel =
    filterParam === 'offline' ? t('common.filterBanner.label.library_offline') : null;

  $: chips = [
    { href: '/library', label: t('common.filterChips.all'), value: null },
    {
      href: '/library?filter=policy',
      label: t('library.viewer.category.policy'),
      value: 'policy'
    },
    {
      href: '/library?filter=procedure',
      label: t('library.viewer.category.procedure'),
      value: 'procedure'
    },
    {
      href: '/library?filter=training',
      label: t('library.viewer.category.training'),
      value: 'training'
    },
    {
      href: '/library?filter=legislation',
      label: t('library.viewer.category.legislation'),
      value: 'legislation'
    },
    {
      href: '/library?filter=template',
      label: t('library.viewer.category.template'),
      value: 'template'
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
  $: pageTitle = activeFilterLabel ?? t('common.libraryPage.title');

  // ActiveFiltersBar descriptors — one entry per active axis.
  $: activeFilters = (() => {
    /** @type {Array<{ key: string, label: string, removeHref: string }>} */
    const list = [];
    if (activeValue) {
      list.push({
        key: 'filter',
        label: `${t('common.activeFilters.axis.category')}: ${t(`library.viewer.category.${activeValue}`)}`,
        removeHref: buildHref('/library', { sort: sortParam, from: fromParam, to: toParam })
      });
    }
    if (filterParam === 'offline') {
      list.push({
        key: 'filter',
        label: t('common.filterBanner.label.library_offline'),
        removeHref: buildHref('/library', { sort: sortParam, from: fromParam, to: toParam })
      });
    }
    if (fromParam || toParam) {
      list.push({
        key: 'date',
        label: `${t('common.activeFilters.axis.date_range')}: ${fromParam ?? '…'} → ${toParam ?? '…'}`,
        removeHref: buildHref('/library', { filter: filterParam, sort: sortParam })
      });
    }
    if (sortParam === 'oldest') {
      list.push({
        key: 'sort',
        label: `${t('common.activeFilters.axis.sort')}: ${t('common.sortToggle.oldest')}`,
        removeHref: buildHref('/library', { filter: filterParam, from: fromParam, to: toParam })
      });
    }
    return list;
  })();

  $: fromParam = $page.url.searchParams.get('from');
  $: toParam = $page.url.searchParams.get('to');

  $: predicate = (() => {
    const catPred = activeValue
      ? /** @param {import('$lib/library/demo-library').DemoLibraryRow} r */ (r) =>
          r.category === activeValue
      : filterParam === 'offline'
        ? /** @param {import('$lib/library/demo-library').DemoLibraryRow} r */ (r) =>
            r.offline_cached === true
        : null;
    const hasRange = fromParam || toParam;
    if (!catPred && !hasRange) return undefined;
    return /** @param {import('$lib/library/demo-library').DemoLibraryRow} r */ (r) => {
      if (catPred && !catPred(r)) return false;
      if (hasRange && !withinRange(r.updated_at, fromParam, toParam)) return false;
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
    (p, ps) => fetchDemoLibraryPage(p, ps, sortedRows, predicate);

  function buildDownload() {
    const rows = predicate ? sortedRows.filter(predicate) : sortedRows;
    return {
      csv: withMetadata(
        { route: '/library', filters: activeFilters.map((f) => f.label).join(' · ') },
        toCsv(rows, CSV_FIELDS)
      ),
      filename: csvFilename(
        'library',
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

<section class="card lib-card" data-testid="library-page">
  <ActiveFiltersBar baseHref="/library" filters={activeFilters} />
  <SavedViewsRail route="/library" />
  <FilterChipsRail {chips} {activeValue} />
  <DateRangeChips
    baseHref="/library"
    {fromParam}
    {toParam}
    preservedParams={{ filter: filterParam, sort: sortParam }}
  />
  <SortToggle
    baseHref="/library"
    activeSort={sortParam}
    preservedParams={{ filter: filterParam, from: fromParam, to: toParam }}
  />
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/library" />
  {/if}
  <CsvDownloadButton onClick={buildDownload} />
  <ShareUrlButton />
  <SaveViewButton suggestedName={activeFilters.map((f) => f.label).join(' · ')} />
  {#key `${filterParam ?? ''}|${sortParam ?? ''}|${fromParam ?? ''}|${toParam ?? ''}`}
    <LibraryViewer
      {fetchPage}
      filterActive={filterParam !== null || !!fromParam || !!toParam}
      filterLabel={activeFilterLabel}
      clearHref="/library"
    />
  {/key}
  <p class="lib-demo-note muted" data-testid="lib-demo-note">
    {t('library.viewer.demo_note')}
  </p>
  <p class="lib-footer" data-print="hide">
    <a href="/" data-testid="library-back-to-home">
      {t('common.libraryPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .lib-card {
    margin-block-start: 1rem;
  }
  .lib-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .lib-footer {
    margin-block-start: 0.75rem;
  }
</style>
