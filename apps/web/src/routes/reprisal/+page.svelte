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

  const DEMO_ROWS = buildDemoReprisals(50);

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

  $: predicate = activeValue
    ? /** @param {import('$lib/reprisal/demo-reprisal').DemoReprisalRow} r */ (r) =>
        r.status === activeValue
    : filterParam === 'active'
      ? /** @param {import('$lib/reprisal/demo-reprisal').DemoReprisalRow} r */ (r) =>
          r.status === 'filed' || r.status === 'investigating'
      : undefined;
  $: fetchPage =
    /**
     * @param {number} p
     * @param {number} ps
     */
    (p, ps) => fetchDemoReprisalPage(p, ps, DEMO_ROWS, predicate);
</script>

<svelte:head>
  <title>{t('common.reprisalPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card reprisal-card" data-testid="reprisal-page">
  <FilterChipsRail {chips} {activeValue} />
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/reprisal" />
  {/if}
  {#key filterParam}
    <ReprisalViewer {fetchPage} />
  {/key}
  <p class="rep-demo-note muted" data-testid="rep-demo-note">
    {t('reprisal.viewer.demo_note')}
  </p>
  <p class="rep-footer">
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
