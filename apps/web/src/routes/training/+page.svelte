<script>
  /**
   * /training — JHSC training-records register mount.
   *
   * Replaces the PR #139 coming-soon placeholder. Mounts TrainingViewer
   * with the demo provider so the surface renders realistic content
   * until the training-records-module backend is wired.
   *
   * Supports URL-driven filtering on `validity` (one of valid /
   * expiring / expired) via `?filter=<value>`. A FilterChipsRail
   * above the viewer lets the worker swap chips without typing the
   * URL. The "Expired training" home dashboard tile deep-links here
   * with `?filter=expired` already highlighted.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import TrainingViewer from '$lib/training/TrainingViewer.svelte';
  import { buildDemoTraining, fetchDemoTrainingPage } from '$lib/training/demo-training';
  import FilterBanner from '$lib/ui/FilterBanner.svelte';
  import FilterChipsRail from '$lib/ui/FilterChipsRail.svelte';
  import CsvDownloadButton from '$lib/ui/CsvDownloadButton.svelte';
  import SortToggle from '$lib/ui/SortToggle.svelte';
  import { toCsv, csvFilename } from '$lib/ui/csv';

  const DEMO_ROWS = buildDemoTraining(50);

  const CSV_FIELDS = /** @type {const} */ ([
    'id',
    'certification',
    'member_pseudonym',
    'completed_at',
    'validity',
    'days_to_expiry',
    'evidence_attached'
  ]);

  /** Canonical validity values supported by `?filter=`. */
  const VALIDITY_VALUES = /** @type {const} */ (['valid', 'expiring', 'expired']);

  $: filterParam = $page.url.searchParams.get('filter');
  $: activeValue =
    filterParam && VALIDITY_VALUES.includes(/** @type {any} */ (filterParam)) ? filterParam : null;
  $: filterLabel =
    activeValue === 'expired' ? t('common.filterBanner.label.training_expired') : null;

  $: chips = [
    { href: '/training', label: t('common.filterChips.all'), value: null },
    {
      href: '/training?filter=valid',
      label: t('training.viewer.validity.valid'),
      value: 'valid'
    },
    {
      href: '/training?filter=expiring',
      label: t('training.viewer.validity.expiring'),
      value: 'expiring'
    },
    {
      href: '/training?filter=expired',
      label: t('training.viewer.validity.expired'),
      value: 'expired'
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
  $: pageTitle = activeFilterLabel ?? t('common.trainingPage.title');

  $: predicate = activeValue
    ? /** @param {import('$lib/training/demo-training').DemoTrainingRow} r */ (r) =>
        r.validity === activeValue
    : undefined;
  $: sortParam = $page.url.searchParams.get('sort');
  $: sortedRows = sortParam === 'oldest' ? [...DEMO_ROWS].reverse() : DEMO_ROWS;

  $: fetchPage =
    /**
     * @param {number} p
     * @param {number} ps
     */
    (p, ps) => fetchDemoTrainingPage(p, ps, sortedRows, predicate);

  function buildDownload() {
    const rows = predicate ? sortedRows.filter(predicate) : sortedRows;
    return { csv: toCsv(rows, CSV_FIELDS), filename: csvFilename('training') };
  }
</script>

<svelte:head>
  <title>{pageTitle} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card trn-card" data-testid="training-page">
  <FilterChipsRail {chips} {activeValue} />
  <SortToggle
    baseHref="/training"
    activeSort={sortParam}
    preservedParams={{ filter: filterParam }}
  />
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/training" />
  {/if}
  <CsvDownloadButton onClick={buildDownload} />
  {#key `${filterParam ?? ''}|${sortParam ?? ''}`}
    <TrainingViewer
      {fetchPage}
      filterActive={filterParam !== null}
      filterLabel={activeFilterLabel}
    />
  {/key}
  <p class="trn-demo-note muted" data-testid="trn-demo-note">
    {t('training.viewer.demo_note')}
  </p>
  <p class="trn-footer" data-print="hide">
    <a href="/" data-testid="training-back-to-home">
      {t('common.trainingPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .trn-card {
    margin-block-start: 1rem;
  }
  .trn-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .trn-footer {
    margin-block-start: 0.75rem;
  }
</style>
