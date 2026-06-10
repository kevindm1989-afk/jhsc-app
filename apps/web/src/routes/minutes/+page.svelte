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

  const DEMO_ROWS = buildDemoMinutes(50);

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

  $: predicate = activeValue
    ? /** @param {import('$lib/minutes/demo-minutes').DemoMinutesRow} r */ (r) =>
        r.status === activeValue
    : undefined;
  $: fetchPage =
    /**
     * @param {number} p
     * @param {number} ps
     */
    (p, ps) => fetchDemoMinutesPage(p, ps, DEMO_ROWS, predicate);
</script>

<svelte:head>
  <title>{t('common.minutesPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card min-card" data-testid="minutes-page">
  <FilterChipsRail {chips} {activeValue} />
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/minutes" />
  {/if}
  {#key filterParam}
    <MinutesViewer {fetchPage} filterActive={filterParam !== null} />
  {/key}
  <p class="min-demo-note muted" data-testid="min-demo-note">
    {t('minutes.viewer.demo_note')}
  </p>
  <p class="min-footer">
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
