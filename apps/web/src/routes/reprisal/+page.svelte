<script>
  /**
   * /reprisal — JHSC C4-tier reprisal-log register viewer mount.
   *
   * Replaces the PR #136 coming-soon placeholder. Mounts ReprisalViewer
   * with the demo provider so the register surface renders realistic
   * content until T13.1 wires the production SupabaseReprisalClient.
   *
   * Supports URL-driven filtering on `status` (one of filed /
   * investigating / resolved / archived) via `?filter=<value>`, plus a
   * macro `?filter=active` (status in {filed, investigating}) reachable
   * from the home dashboard tile. The chip rail surfaces each individual
   * status; the macro doesn't highlight a chip but still shows the
   * FilterBanner.
   *
   * Preserves the destructive-red 4px inline-start border the
   * placeholder card established, so the C4 sensitivity reads at a
   * glance even before the row list paints.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import ReprisalViewer from '$lib/reprisal/ReprisalViewer.svelte';
  import { buildDemoReprisals, fetchDemoReprisalPage } from '$lib/reprisal/demo-reprisal';
  import FilterBanner from '$lib/ui/FilterBanner.svelte';
  import FilterChipsRail from '$lib/ui/FilterChipsRail.svelte';
  import CsvDownloadButton from '$lib/ui/CsvDownloadButton.svelte';
  import SortToggle from '$lib/ui/SortToggle.svelte';
  import DateRangeChips from '$lib/ui/DateRangeChips.svelte';
  import { withinRange } from '$lib/ui/date-range';
  import { toCsv, csvFilename } from '$lib/ui/csv';

  const DEMO_ROWS = buildDemoReprisals(50);

  const CSV_FIELDS = /** @type {const} */ ([
    'id',
    'filed_at',
    'title',
    'status',
    'per_entry_passphrase_required',
    'source_revealed',
    'days_since_filed',
    'actor_pseudonym'
  ]);

  /** Canonical status values supported by `?filter=`. */
  const STATUS_VALUES = /** @type {const} */ (['filed', 'investigating', 'resolved', 'archived']);

  $: filterParam = $page.url.searchParams.get('filter');
  $: activeValue =
    filterParam && STATUS_VALUES.includes(/** @type {any} */ (filterParam)) ? filterParam : null;
  $: filterLabel = filterParam === 'active' ? t('common.filterBanner.label.reprisal_active') : null;

  $: chips = [
    { href: '/reprisal', label: t('common.filterChips.all'), value: null },
    {
      href: '/reprisal?filter=filed',
      label: t('reprisal.viewer.status.filed'),
      value: 'filed'
    },
    {
      href: '/reprisal?filter=investigating',
      label: t('reprisal.viewer.status.investigating'),
      value: 'investigating'
    },
    {
      href: '/reprisal?filter=resolved',
      label: t('reprisal.viewer.status.resolved'),
      value: 'resolved'
    },
    {
      href: '/reprisal?filter=archived',
      label: t('reprisal.viewer.status.archived'),
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
  $: pageTitle = activeFilterLabel ?? t('common.reprisalPage.title');

  $: fromParam = $page.url.searchParams.get('from');
  $: toParam = $page.url.searchParams.get('to');

  $: predicate = (() => {
    const statusPred = activeValue
      ? /** @param {import('$lib/reprisal/demo-reprisal').DemoReprisalRow} r */ (r) =>
          r.status === activeValue
      : filterParam === 'active'
        ? /** @param {import('$lib/reprisal/demo-reprisal').DemoReprisalRow} r */ (r) =>
            r.status === 'filed' || r.status === 'investigating'
        : null;
    const hasRange = fromParam || toParam;
    if (!statusPred && !hasRange) return undefined;
    return /** @param {import('$lib/reprisal/demo-reprisal').DemoReprisalRow} r */ (r) => {
      if (statusPred && !statusPred(r)) return false;
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
    (p, ps) => fetchDemoReprisalPage(p, ps, sortedRows, predicate);

  function buildDownload() {
    const rows = predicate ? sortedRows.filter(predicate) : sortedRows;
    return { csv: toCsv(rows, CSV_FIELDS), filename: csvFilename('reprisal') };
  }
</script>

<svelte:head>
  <title>{pageTitle} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card reprisal-card" data-testid="reprisal-page">
  <FilterChipsRail {chips} {activeValue} />
  <DateRangeChips
    baseHref="/reprisal"
    {fromParam}
    {toParam}
    preservedParams={{ filter: filterParam, sort: sortParam }}
  />
  <SortToggle
    baseHref="/reprisal"
    activeSort={sortParam}
    preservedParams={{ filter: filterParam, from: fromParam, to: toParam }}
  />
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/reprisal" />
  {/if}
  <CsvDownloadButton onClick={buildDownload} />
  {#key `${filterParam ?? ''}|${sortParam ?? ''}|${fromParam ?? ''}|${toParam ?? ''}`}
    <ReprisalViewer
      {fetchPage}
      filterActive={filterParam !== null || !!fromParam || !!toParam}
      filterLabel={activeFilterLabel}
    />
  {/key}
  <p class="rep-demo-note muted" data-testid="rep-demo-note">
    {t('reprisal.viewer.demo_note')}
  </p>
  <p class="rep-footer" data-print="hide">
    <a href="/" data-testid="reprisal-back-to-home">
      {t('common.reprisalPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  /*
   * Preserves the destructive-red 4px inline-start border the
   * placeholder card established for the C4 sensitivity tier.
   */
  .reprisal-card {
    margin-block-start: 1rem;
    border-inline-start: 4px solid var(--color-destructive);
  }
  .rep-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .rep-footer {
    margin-block-start: 0.75rem;
  }
</style>
