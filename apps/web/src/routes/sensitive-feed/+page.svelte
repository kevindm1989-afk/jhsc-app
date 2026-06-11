<script>
  /**
   * /sensitive-feed — worker co-chair + worker certified member C3/C4
   * activity-feed viewer mount.
   *
   * Replaces the PR #141 coming-soon placeholder. Mounts
   * SensitiveFeedViewer with the demo provider so the surface renders
   * realistic content until the real backend ships.
   *
   * Supports URL-driven filtering on sensitivity tier via
   * `?filter=<value>` (c3 / c4). The chip rail lets the worker narrow
   * to either tier — useful when a worker co-chair wants to triage
   * only the highest-sensitivity events.
   *
   * Provider injection (`fetchPage` prop): the viewer is backend-
   * agnostic; T-future swap-in replaces the demo provider with no
   * viewer-side changes.
   *
   * Sensitivity-tier visual: the page keeps the 4px destructive-red
   * inline-start border on the outer card (matches PR #141's placeholder
   * + /reprisal + /s51-evidence + PanicWipeModal). The viewer's per-row
   * badge layers an additional tier indicator (C3 blue, C4 red).
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import SensitiveFeedViewer from '$lib/audit/SensitiveFeedViewer.svelte';
  import { buildDemoSensitiveRows, fetchDemoSensitivePage } from '$lib/audit/demo-sensitive-feed';
  import FilterChipsRail from '$lib/ui/FilterChipsRail.svelte';
  import CsvDownloadButton from '$lib/ui/CsvDownloadButton.svelte';
  import ShareUrlButton from '$lib/ui/ShareUrlButton.svelte';
  import SortToggle from '$lib/ui/SortToggle.svelte';
  import DateRangeChips from '$lib/ui/DateRangeChips.svelte';
  import { withinRange } from '$lib/ui/date-range';
  import { toCsv, csvFilename } from '$lib/ui/csv';

  const DEMO_ROWS = buildDemoSensitiveRows(50);

  // meta excluded (record-shaped); the rest is metadata-only by design.
  const CSV_FIELDS = /** @type {const} */ ([
    'id',
    'ts',
    'event_type',
    'sensitivity',
    'actor_pseudonym'
  ]);

  /** Canonical sensitivity-tier values supported by `?filter=`. */
  const SENSITIVITY_VALUES = /** @type {const} */ (['c3', 'c4']);

  $: filterParam = $page.url.searchParams.get('filter');
  $: activeValue =
    filterParam && SENSITIVITY_VALUES.includes(/** @type {any} */ (filterParam))
      ? filterParam
      : null;

  $: chips = [
    { href: '/sensitive-feed', label: t('common.filterChips.all'), value: null },
    {
      href: '/sensitive-feed?filter=c3',
      label: t('sensitiveFeed.viewer.chip.c3'),
      value: 'c3'
    },
    {
      href: '/sensitive-feed?filter=c4',
      label: t('sensitiveFeed.viewer.chip.c4'),
      value: 'c4'
    }
  ];

  $: activeFilterLabel = (() => {
    if (activeValue) {
      const chip = chips.find((c) => c.value === activeValue);
      if (chip?.label) return chip.label;
    }
    return null;
  })();
  $: pageTitle = activeFilterLabel ?? t('common.sensitiveFeedPage.title');

  $: fromParam = $page.url.searchParams.get('from');
  $: toParam = $page.url.searchParams.get('to');

  // Compose the sensitivity-tier filter with the date range so both
  // gates must pass for a row to appear.
  $: predicate = (() => {
    const tierPred = activeValue
      ? /** @param {import('$lib/audit/demo-sensitive-feed').DemoSensitiveRow} r */ (r) =>
          r.sensitivity === activeValue
      : null;
    const hasRange = fromParam || toParam;
    if (!tierPred && !hasRange) return undefined;
    return /** @param {import('$lib/audit/demo-sensitive-feed').DemoSensitiveRow} r */ (r) => {
      if (tierPred && !tierPred(r)) return false;
      if (hasRange && !withinRange(r.ts, fromParam, toParam)) return false;
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
    (p, ps) => fetchDemoSensitivePage(p, ps, sortedRows, predicate);

  function buildDownload() {
    const rows = predicate ? sortedRows.filter(predicate) : sortedRows;
    return { csv: toCsv(rows, CSV_FIELDS), filename: csvFilename('sensitive-feed') };
  }
</script>

<svelte:head>
  <title>{pageTitle} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card sensitive-feed-card" data-testid="sensitive-feed-page">
  <FilterChipsRail {chips} {activeValue} />
  <DateRangeChips
    baseHref="/sensitive-feed"
    {fromParam}
    {toParam}
    preservedParams={{ filter: filterParam, sort: sortParam }}
  />
  <SortToggle
    baseHref="/sensitive-feed"
    activeSort={sortParam}
    preservedParams={{ filter: filterParam, from: fromParam, to: toParam }}
  />
  <CsvDownloadButton onClick={buildDownload} />
  <ShareUrlButton />
  {#key `${filterParam ?? ''}|${sortParam ?? ''}|${fromParam ?? ''}|${toParam ?? ''}`}
    <SensitiveFeedViewer
      {fetchPage}
      filterActive={filterParam !== null || !!fromParam || !!toParam}
      filterLabel={activeFilterLabel}
    />
  {/key}
  <p class="sensitive-feed-demo-note muted" data-testid="sensitive-feed-demo-note">
    {t('sensitiveFeed.viewer.demo_note')}
  </p>
  <p class="sensitive-feed-footer" data-print="hide">
    <a href="/" data-testid="sensitive-feed-back-to-home">
      {t('common.sensitiveFeedPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  /*
   * 4px destructive-red inline-start border — shared with /reprisal,
   * /s51-evidence, and PanicWipeModal. Preserved verbatim from PR #141's
   * placeholder so the visual gravity signal doesn't regress.
   */
  .sensitive-feed-card {
    margin-block-start: 1rem;
    border-inline-start: 4px solid var(--color-destructive);
  }
  .sensitive-feed-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .sensitive-feed-footer {
    margin-block-start: 0.75rem;
  }
</style>
