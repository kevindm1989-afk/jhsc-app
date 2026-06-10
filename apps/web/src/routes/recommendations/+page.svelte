<script>
  /**
   * /recommendations — JHSC recommendations register viewer mount.
   *
   * Replaces the PR #138 coming-soon placeholder. Mounts
   * RecommendationsViewer with the demo provider so the surface
   * renders realistic content until T12 wires the real backend.
   *
   * Supports URL-driven filtering on `status` (one of responded /
   * pending / overdue / archived) via `?filter=<value>`. A
   * FilterChipsRail above the viewer lets the worker swap chips
   * without typing the URL. The "Overdue recommendations" home
   * dashboard tile deep-links here with `?filter=overdue` already
   * highlighted.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import RecommendationsViewer from '$lib/recommendations/RecommendationsViewer.svelte';
  import {
    buildDemoRecommendations,
    fetchDemoRecommendationsPage
  } from '$lib/recommendations/demo-recommendations';
  import FilterBanner from '$lib/ui/FilterBanner.svelte';
  import FilterChipsRail from '$lib/ui/FilterChipsRail.svelte';

  const DEMO_ROWS = buildDemoRecommendations(50);

  /** Canonical status values supported by `?filter=`. */
  const STATUS_VALUES = /** @type {const} */ (['responded', 'pending', 'overdue', 'archived']);

  $: filterParam = $page.url.searchParams.get('filter');
  $: activeValue =
    filterParam && STATUS_VALUES.includes(/** @type {any} */ (filterParam)) ? filterParam : null;
  $: filterLabel =
    activeValue === 'overdue' ? t('common.filterBanner.label.recommendations_overdue') : null;

  $: chips = [
    { href: '/recommendations', label: t('common.filterChips.all'), value: null },
    {
      href: '/recommendations?filter=responded',
      label: t('recommendations.viewer.status.responded'),
      value: 'responded'
    },
    {
      href: '/recommendations?filter=pending',
      label: t('recommendations.viewer.status.pending'),
      value: 'pending'
    },
    {
      href: '/recommendations?filter=overdue',
      label: t('recommendations.viewer.status.overdue'),
      value: 'overdue'
    },
    {
      href: '/recommendations?filter=archived',
      label: t('recommendations.viewer.status.archived'),
      value: 'archived'
    }
  ];

  $: pageTitle = (() => {
    if (activeValue) {
      const chip = chips.find((c) => c.value === activeValue);
      if (chip?.label) return chip.label;
    }
    if (filterLabel) return filterLabel;
    return t('common.recommendationsPage.title');
  })();

  $: predicate = activeValue
    ? /** @param {import('$lib/recommendations/demo-recommendations').DemoRecommendationRow} r */ (
        r
      ) => r.status === activeValue
    : undefined;
  $: fetchPage =
    /**
     * @param {number} p
     * @param {number} ps
     */
    (p, ps) => fetchDemoRecommendationsPage(p, ps, DEMO_ROWS, predicate);
</script>

<svelte:head>
  <title>{pageTitle} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card recs-card" data-testid="recommendations-page">
  <FilterChipsRail {chips} {activeValue} />
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/recommendations" />
  {/if}
  {#key filterParam}
    <RecommendationsViewer {fetchPage} filterActive={filterParam !== null} />
  {/key}
  <p class="recs-demo-note muted" data-testid="recs-demo-note">
    {t('recommendations.viewer.demo_note')}
  </p>
  <p class="recs-footer" data-print="hide">
    <a href="/" data-testid="recommendations-back-to-home">
      {t('common.recommendationsPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .recs-card {
    margin-block-start: 1rem;
  }
  .recs-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .recs-footer {
    margin-block-start: 0.75rem;
  }
</style>
