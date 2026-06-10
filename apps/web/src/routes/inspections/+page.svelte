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

  const DEMO_ROWS = buildDemoInspections(50);

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

  $: pageTitle = (() => {
    if (activeValue) {
      const chip = chips.find((c) => c.value === activeValue);
      if (chip?.label) return chip.label;
    }
    if (filterLabel) return filterLabel;
    return t('common.inspectionsPage.title');
  })();

  $: predicate = activeValue
    ? /** @param {import('$lib/inspections/demo-inspections').DemoInspectionRow} r */ (r) =>
        r.integrity_status === activeValue
    : undefined;
  $: fetchPage =
    /**
     * @param {number} p
     * @param {number} ps
     */
    (p, ps) => fetchDemoInspectionsPage(p, ps, DEMO_ROWS, predicate);
</script>

<svelte:head>
  <title>{pageTitle} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card ins-card" data-testid="inspections-page">
  <FilterChipsRail {chips} {activeValue} />
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/inspections" />
  {/if}
  {#key filterParam}
    <InspectionsViewer {fetchPage} filterActive={filterParam !== null} />
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
