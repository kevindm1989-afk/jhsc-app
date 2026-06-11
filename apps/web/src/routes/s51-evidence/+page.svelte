<script>
  /**
   * /s51-evidence — JHSC C4-tier OHSA s. 51 critical-injury evidence
   * register mount.
   *
   * Replaces the PR #141 coming-soon placeholder. Mounts
   * S51EvidenceViewer with the demo provider so the register surface
   * renders realistic content until T14 wires the real backend.
   *
   * Supports URL-driven filtering on `scene_state` (one of preserving /
   * released_by_inspector / window_expired) via `?filter=<value>`.
   * A FilterChipsRail above the viewer lets the worker swap chips.
   * The "Scenes preserving" home dashboard tile deep-links here with
   * `?filter=preserving` already highlighted.
   *
   * Preserves the destructive-red 4px inline-start border the
   * placeholder card established — every C4 surface in the worker-hub
   * language shares that accent.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import S51EvidenceViewer from '$lib/s51-evidence/S51EvidenceViewer.svelte';
  import {
    buildDemoS51Evidence,
    fetchDemoS51EvidencePage
  } from '$lib/s51-evidence/demo-s51-evidence';
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

  const DEMO_ROWS = buildDemoS51Evidence(30);

  const CSV_FIELDS = /** @type {const} */ ([
    'id',
    'opened_at',
    'title',
    'scene_state',
    'hours_remaining',
    'photo_count',
    'witness_statement_count',
    'per_entry_passphrase_required',
    'worker_member_present',
    'actor_pseudonym'
  ]);

  /** Canonical scene-state values supported by `?filter=`. */
  const SCENE_VALUES = /** @type {const} */ ([
    'preserving',
    'released_by_inspector',
    'window_expired'
  ]);

  $: filterParam = $page.url.searchParams.get('filter');
  $: activeValue =
    filterParam && SCENE_VALUES.includes(/** @type {any} */ (filterParam)) ? filterParam : null;
  $: filterLabel =
    activeValue === 'preserving' ? t('common.filterBanner.label.s51_preserving') : null;

  $: chips = [
    { href: '/s51-evidence', label: t('common.filterChips.all'), value: null },
    {
      href: '/s51-evidence?filter=preserving',
      label: t('s51.viewer.chip.preserving'),
      value: 'preserving'
    },
    {
      href: '/s51-evidence?filter=released_by_inspector',
      label: t('s51.viewer.chip.released'),
      value: 'released_by_inspector'
    },
    {
      href: '/s51-evidence?filter=window_expired',
      label: t('s51.viewer.chip.expired'),
      value: 'window_expired'
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
  $: pageTitle = activeFilterLabel ?? t('common.s51Page.title');

  // ActiveFiltersBar descriptors — one entry per active axis.
  $: activeFilters = (() => {
    /** @type {Array<{ key: string, label: string, removeHref: string }>} */
    const list = [];
    if (activeValue) {
      const VALUE_LABEL_REMAP = { released_by_inspector: 'released', window_expired: 'expired' };
      const labelKeyValue = VALUE_LABEL_REMAP[activeValue] ?? activeValue;
      list.push({
        key: 'filter',
        label: `${t('common.activeFilters.axis.scene_state')}: ${t(`s51.viewer.chip.${labelKeyValue}`)}`,
        removeHref: buildHref('/s51-evidence', { sort: sortParam, from: fromParam, to: toParam })
      });
    }
    if (fromParam || toParam) {
      list.push({
        key: 'date',
        label: `${t('common.activeFilters.axis.date_range')}: ${fromParam ?? '…'} → ${toParam ?? '…'}`,
        removeHref: buildHref('/s51-evidence', { filter: filterParam, sort: sortParam })
      });
    }
    if (sortParam === 'oldest') {
      list.push({
        key: 'sort',
        label: `${t('common.activeFilters.axis.sort')}: ${t('common.sortToggle.oldest')}`,
        removeHref: buildHref('/s51-evidence', {
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
    const scenePred = activeValue
      ? /** @param {import('$lib/s51-evidence/demo-s51-evidence').DemoS51EvidenceRow} r */ (r) =>
          r.scene_state === activeValue
      : null;
    const hasRange = fromParam || toParam;
    if (!scenePred && !hasRange) return undefined;
    return /** @param {import('$lib/s51-evidence/demo-s51-evidence').DemoS51EvidenceRow} r */ (
      r
    ) => {
      if (scenePred && !scenePred(r)) return false;
      if (hasRange && !withinRange(r.opened_at, fromParam, toParam)) return false;
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
    (p, ps) => fetchDemoS51EvidencePage(p, ps, sortedRows, predicate);

  function buildDownload() {
    const rows = predicate ? sortedRows.filter(predicate) : sortedRows;
    return {
      csv: withMetadata(
        { route: '/s51-evidence', filters: activeFilters.map((f) => f.label).join(' · ') },
        toCsv(rows, CSV_FIELDS)
      ),
      filename: csvFilename(
        's51-evidence',
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

<section class="card s51-card" data-testid="s51-page">
  <ActiveFiltersBar baseHref="/s51-evidence" filters={activeFilters} />
  <SavedViewsRail route="/s51-evidence" />
  <FilterChipsRail {chips} {activeValue} />
  <DateRangeChips
    baseHref="/s51-evidence"
    {fromParam}
    {toParam}
    preservedParams={{ filter: filterParam, sort: sortParam }}
  />
  <SortToggle
    baseHref="/s51-evidence"
    activeSort={sortParam}
    preservedParams={{ filter: filterParam, from: fromParam, to: toParam }}
  />
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/s51-evidence" />
  {/if}
  <CsvDownloadButton onClick={buildDownload} />
  <ShareUrlButton />
  <SaveViewButton suggestedName={activeFilters.map((f) => f.label).join(' · ')} />
  {#key `${filterParam ?? ''}|${sortParam ?? ''}|${fromParam ?? ''}|${toParam ?? ''}`}
    <S51EvidenceViewer
      {fetchPage}
      filterActive={filterParam !== null || !!fromParam || !!toParam}
      filterLabel={activeFilterLabel}
      clearHref="/s51-evidence"
    />
  {/key}
  <p class="s51-demo-note muted" data-testid="s51-demo-note">
    {t('s51.viewer.demo_note')}
  </p>
  <p class="s51-footer" data-print="hide">
    <a href="/" data-testid="s51-back-to-home">
      {t('common.s51Page.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  /*
   * 4px destructive-red inline-start border — the C4 sensitivity
   * accent shared with /reprisal and PanicWipeModal.
   */
  .s51-card {
    margin-block-start: 1rem;
    border-inline-start: 4px solid var(--color-destructive);
  }
  .s51-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .s51-footer {
    margin-block-start: 0.75rem;
  }
</style>
