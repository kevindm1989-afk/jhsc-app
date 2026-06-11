<script>
  /**
   * /audit — append-only audit-log viewer mount.
   *
   * Replaces the PR #141 coming-soon placeholder. Mounts AuditLogViewer
   * with the demo-data provider so a worker can see what the surface
   * looks like before the real audit-op Edge Function ships (T18).
   *
   * Supports URL-driven filtering on event-type category via
   * `?filter=<value>`. The chip rail surfaces three broad categories
   * that match worker mental models: sessions (session.*, panic_wipe,
   * recovery_blob.*, identity_keypair.*); workplace (concern.*,
   * reprisal.*, work_refusal.*, s51_evidence.*); committee
   * (committee_member.*, audit_log.read). Other events (the few
   * remaining infra-style enums) appear under "All" only.
   *
   * Provider injection (`fetchPage` prop): the viewer is backend-
   * agnostic; the demo provider lives in $lib/audit/demo-audit-rows.
   * When T18's SupabaseAuditClient lands, the route swaps the
   * provider — no viewer-side changes.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import AuditLogViewer from '$lib/audit/AuditLogViewer.svelte';
  import { buildDemoAuditRows, fetchDemoAuditPage } from '$lib/audit/demo-audit-rows';
  import FilterChipsRail from '$lib/ui/FilterChipsRail.svelte';
  import CsvDownloadButton from '$lib/ui/CsvDownloadButton.svelte';
  import ShareUrlButton from '$lib/ui/ShareUrlButton.svelte';
  import SortToggle from '$lib/ui/SortToggle.svelte';
  import DateRangeChips from '$lib/ui/DateRangeChips.svelte';
  import ActiveFiltersBar from '$lib/ui/ActiveFiltersBar.svelte';
  import { buildHref } from '$lib/ui/url-state';
  import { withinRange } from '$lib/ui/date-range';
  import { toCsv, csvFilename } from '$lib/ui/csv';

  const DEMO_ROWS = buildDemoAuditRows(50);

  // Note: meta is a record-shaped sub-field per row and is excluded
  // from the CSV in this snapshot — the real Merkle audit chain (T18)
  // will get its own canonical export shape.
  const CSV_FIELDS = /** @type {const} */ (['id', 'ts', 'event_type', 'actor_pseudonym']);

  /** Canonical filter values supported by `?filter=`. */
  const FILTER_VALUES = /** @type {const} */ (['sessions', 'workplace', 'committee']);

  /**
   * Map a filter value to a predicate over the event_type string.
   * @param {string} value
   * @returns {(row: import('$lib/audit/demo-audit-rows').DemoAuditRow) => boolean}
   */
  function predicateFor(value) {
    if (value === 'sessions') {
      return (r) =>
        r.event_type.startsWith('session.') ||
        r.event_type.startsWith('panic_wipe') ||
        r.event_type.startsWith('recovery_blob') ||
        r.event_type.startsWith('identity_keypair');
    }
    if (value === 'workplace') {
      return (r) =>
        r.event_type.startsWith('concern.') ||
        r.event_type.startsWith('reprisal.') ||
        r.event_type.startsWith('work_refusal') ||
        r.event_type.startsWith('s51_evidence');
    }
    // committee
    return (r) => r.event_type.startsWith('committee_member') || r.event_type === 'audit_log.read';
  }

  $: filterParam = $page.url.searchParams.get('filter');
  $: activeValue =
    filterParam && FILTER_VALUES.includes(/** @type {any} */ (filterParam)) ? filterParam : null;

  $: chips = [
    { href: '/audit', label: t('common.filterChips.all'), value: null },
    { href: '/audit?filter=sessions', label: t('audit.viewer.chip.sessions'), value: 'sessions' },
    {
      href: '/audit?filter=workplace',
      label: t('audit.viewer.chip.workplace'),
      value: 'workplace'
    },
    {
      href: '/audit?filter=committee',
      label: t('audit.viewer.chip.committee'),
      value: 'committee'
    }
  ];

  $: activeFilterLabel = (() => {
    if (activeValue) {
      const chip = chips.find((c) => c.value === activeValue);
      if (chip?.label) return chip.label;
    }
    return null;
  })();
  $: pageTitle = activeFilterLabel ?? t('common.auditPage.title');

  // ActiveFiltersBar descriptors — one entry per active axis.
  $: activeFilters = (() => {
    /** @type {Array<{ key: string, label: string, removeHref: string }>} */
    const list = [];
    if (activeValue) {
      list.push({
        key: 'filter',
        label: `${t('common.activeFilters.axis.event_type')}: ${t(`audit.viewer.chip.${activeValue}`)}`,
        removeHref: buildHref('/audit', { sort: sortParam, from: fromParam, to: toParam })
      });
    }
    if (fromParam || toParam) {
      list.push({
        key: 'date',
        label: `${t('common.activeFilters.axis.date_range')}: ${fromParam ?? '…'} → ${toParam ?? '…'}`,
        removeHref: buildHref('/audit', { filter: filterParam, sort: sortParam })
      });
    }
    if (sortParam === 'oldest') {
      list.push({
        key: 'sort',
        label: `${t('common.activeFilters.axis.sort')}: ${t('common.sortToggle.oldest')}`,
        removeHref: buildHref('/audit', { filter: filterParam, from: fromParam, to: toParam })
      });
    }
    return list;
  })();

  $: fromParam = $page.url.searchParams.get('from');
  $: toParam = $page.url.searchParams.get('to');

  // Compose the event-type predicate (chip) with the date-range
  // predicate (?from + ?to). If neither is active, predicate is
  // undefined and the provider returns the full dataset.
  $: predicate = (() => {
    const eventPred = activeValue ? predicateFor(activeValue) : null;
    const hasRange = fromParam || toParam;
    if (!eventPred && !hasRange) return undefined;
    return /** @param {import('$lib/audit/demo-audit-rows').DemoAuditRow} r */ (r) => {
      if (eventPred && !eventPred(r)) return false;
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
    (p, ps) => fetchDemoAuditPage(p, ps, sortedRows, predicate);

  function buildDownload() {
    const rows = predicate ? sortedRows.filter(predicate) : sortedRows;
    return { csv: toCsv(rows, CSV_FIELDS), filename: csvFilename('audit') };
  }
</script>

<svelte:head>
  <title>{pageTitle} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="audit-page" data-testid="audit-page">
  <ActiveFiltersBar baseHref="/audit" filters={activeFilters} />
  <FilterChipsRail {chips} {activeValue} />
  <DateRangeChips
    baseHref="/audit"
    {fromParam}
    {toParam}
    preservedParams={{ filter: filterParam, sort: sortParam }}
  />
  <SortToggle
    baseHref="/audit"
    activeSort={sortParam}
    preservedParams={{ filter: filterParam, from: fromParam, to: toParam }}
  />
  <CsvDownloadButton onClick={buildDownload} />
  <ShareUrlButton />
  {#key `${filterParam ?? ''}|${sortParam ?? ''}|${fromParam ?? ''}|${toParam ?? ''}`}
    <AuditLogViewer
      {fetchPage}
      filterActive={filterParam !== null || !!fromParam || !!toParam}
      filterLabel={activeFilterLabel}
    />
  {/key}
  <p class="audit-page-demo-note muted" data-testid="audit-page-demo-note">
    {t('audit.viewer.demo_note')}
  </p>
  <p class="audit-page-footer" data-print="hide">
    <a href="/" data-testid="audit-back-to-home">{t('common.auditPage.back_to_home_cta')}</a>
  </p>
</section>

<style>
  .audit-page {
    display: block;
    margin-block-start: 1rem;
  }
  .audit-page-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .audit-page-footer {
    margin-block-start: 0.75rem;
  }
</style>
