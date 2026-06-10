<script>
  /**
   * /concerns — JHSC concerns register viewer mount.
   *
   * Replaces the PR #136 coming-soon placeholder. Mounts ConcernsViewer
   * with the demo provider so the register surface renders realistic
   * content until T08.1 wires the production SupabaseConcernsClient.
   *
   * Supports URL-driven filtering on `status` (one of open / triaged /
   * resolved / archived) via `?filter=<value>`. A FilterChipsRail
   * above the viewer lets the worker swap chips without typing the
   * URL. The "Open concerns" home dashboard tile deep-links here with
   * `?filter=open` already highlighted.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import ConcernsViewer from '$lib/concerns/ConcernsViewer.svelte';
  import { buildDemoConcerns, fetchDemoConcernsPage } from '$lib/concerns/demo-concerns';
  import FilterBanner from '$lib/ui/FilterBanner.svelte';
  import FilterChipsRail from '$lib/ui/FilterChipsRail.svelte';

  const DEMO_ROWS = buildDemoConcerns(50);

  /** Canonical status values supported by `?filter=`. */
  const STATUS_VALUES = /** @type {const} */ (['open', 'triaged', 'resolved', 'archived']);

  $: filterParam = $page.url.searchParams.get('filter');
  $: activeValue =
    filterParam && STATUS_VALUES.includes(/** @type {any} */ (filterParam)) ? filterParam : null;
  // FilterBanner still shows on the dashboard-tile "Open concerns" path
  // for clear-filter symmetry; the chip rail also highlights "Open".
  $: filterLabel = activeValue === 'open' ? t('common.filterBanner.label.concerns_open') : null;

  $: chips = [
    { href: '/concerns', label: t('common.filterChips.all'), value: null },
    { href: '/concerns?filter=open', label: t('concern.viewer.status.open'), value: 'open' },
    {
      href: '/concerns?filter=triaged',
      label: t('concern.viewer.status.triaged'),
      value: 'triaged'
    },
    {
      href: '/concerns?filter=resolved',
      label: t('concern.viewer.status.resolved'),
      value: 'resolved'
    },
    {
      href: '/concerns?filter=archived',
      label: t('concern.viewer.status.archived'),
      value: 'archived'
    }
  ];

  // Filter-aware document title + viewer h1 echo: extract the active
  // filter label first (chip-driven or banner macro), then derive the
  // page title from it.
  $: activeFilterLabel = (() => {
    if (activeValue) {
      const chip = chips.find((c) => c.value === activeValue);
      if (chip?.label) return chip.label;
    }
    if (filterLabel) return filterLabel;
    return null;
  })();
  $: pageTitle = activeFilterLabel ?? t('common.concernsPage.title');

  $: predicate = activeValue
    ? /** @param {import('$lib/concerns/demo-concerns').DemoConcernRow} r */ (r) =>
        r.status === activeValue
    : undefined;
  $: fetchPage =
    /**
     * @param {number} p
     * @param {number} ps
     */
    (p, ps) => fetchDemoConcernsPage(p, ps, DEMO_ROWS, predicate);
</script>

<svelte:head>
  <title>{pageTitle} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card con-card" data-testid="concerns-page">
  <FilterChipsRail {chips} {activeValue} />
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/concerns" />
  {/if}
  {#key filterParam}
    <ConcernsViewer
      {fetchPage}
      filterActive={filterParam !== null}
      filterLabel={activeFilterLabel}
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
