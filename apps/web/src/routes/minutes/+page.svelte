<script>
  /**
   * /minutes — JHSC meeting-minutes register viewer mount.
   *
   * Replaces the PR #137 coming-soon placeholder. Mounts MinutesViewer
   * with the demo provider so the surface renders realistic content
   * until the real minutes-module backend is wired.
   *
   * Supports URL-driven filtering on `status` (one of draft / approved /
   * archived) via `?filter=<value>`. A FilterChipsRail above the
   * viewer lets the worker swap chips without typing the URL.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import MinutesViewer from '$lib/minutes/MinutesViewer.svelte';
  import { buildDemoMinutes, fetchDemoMinutesPage } from '$lib/minutes/demo-minutes';
  import FilterBanner from '$lib/ui/FilterBanner.svelte';
  import FilterChipsRail from '$lib/ui/FilterChipsRail.svelte';
  import CsvDownloadButton from '$lib/ui/CsvDownloadButton.svelte';
  import SortToggle from '$lib/ui/SortToggle.svelte';
  import DateRangeChips from '$lib/ui/DateRangeChips.svelte';
  import { withinRange } from '$lib/ui/date-range';
  import { toCsv, csvFilename } from '$lib/ui/csv';

  const DEMO_ROWS = buildDemoMinutes(50);

  const CSV_FIELDS = /** @type {const} */ ([
    'id',
    'meeting_date',
    'title',
    'status',
    'revision_count',
    'quoted_concern_count',
    'quorum_present',
    'drafter_pseudonym'
  ]);

  /** Canonical status values supported by `?filter=`. */
  const STATUS_VALUES = /** @type {const} */ (['draft', 'approved', 'archived']);

  $: filterParam = $page.url.searchParams.get('filter');
  $: activeValue =
    filterParam && STATUS_VALUES.includes(/** @type {any} */ (filterParam)) ? filterParam : null;
  $: filterLabel = activeValue === 'draft' ? t('common.filterBanner.label.minutes_draft') : null;

  $: chips = [
    { href: '/minutes', label: t('common.filterChips.all'), value: null },
    {
      href: '/minutes?filter=draft',
      label: t('minutes.viewer.status.draft'),
      value: 'draft'
    },
    {
      href: '/minutes?filter=approved',
      label: t('minutes.viewer.status.approved'),
      value: 'approved'
    },
    {
      href: '/minutes?filter=archived',
      label: t('minutes.viewer.status.archived'),
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
  $: pageTitle = activeFilterLabel ?? t('common.minutesPage.title');

  $: fromParam = $page.url.searchParams.get('from');
  $: toParam = $page.url.searchParams.get('to');

  $: predicate = (() => {
    const statusPred = activeValue
      ? /** @param {import('$lib/minutes/demo-minutes').DemoMinutesRow} r */ (r) =>
          r.status === activeValue
      : null;
    const hasRange = fromParam || toParam;
    if (!statusPred && !hasRange) return undefined;
    return /** @param {import('$lib/minutes/demo-minutes').DemoMinutesRow} r */ (r) => {
      if (statusPred && !statusPred(r)) return false;
      if (hasRange && !withinRange(r.meeting_date, fromParam, toParam)) return false;
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
    (p, ps) => fetchDemoMinutesPage(p, ps, sortedRows, predicate);

  function buildDownload() {
    const rows = predicate ? sortedRows.filter(predicate) : sortedRows;
    return { csv: toCsv(rows, CSV_FIELDS), filename: csvFilename('minutes') };
  }
</script>

<svelte:head>
  <title>{pageTitle} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card min-card" data-testid="minutes-page">
  <FilterChipsRail {chips} {activeValue} />
  <DateRangeChips
    baseHref="/minutes"
    {fromParam}
    {toParam}
    preservedParams={{ filter: filterParam, sort: sortParam }}
  />
  <SortToggle
    baseHref="/minutes"
    activeSort={sortParam}
    preservedParams={{ filter: filterParam, from: fromParam, to: toParam }}
  />
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/minutes" />
  {/if}
  <CsvDownloadButton onClick={buildDownload} />
  {#key `${filterParam ?? ''}|${sortParam ?? ''}|${fromParam ?? ''}|${toParam ?? ''}`}
    <MinutesViewer
      {fetchPage}
      filterActive={filterParam !== null || !!fromParam || !!toParam}
      filterLabel={activeFilterLabel}
    />
  {/key}
  <p class="min-demo-note muted" data-testid="min-demo-note">
    {t('minutes.viewer.demo_note')}
  </p>
  <p class="min-footer" data-print="hide">
    <a href="/" data-testid="minutes-back-to-home">
      {t('common.minutesPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .min-card {
    margin-block-start: 1rem;
  }
  .min-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .min-footer {
    margin-block-start: 0.75rem;
  }
</style>
