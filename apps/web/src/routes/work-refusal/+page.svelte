<script>
  /**
   * /work-refusal — JHSC C4-tier OHSA s. 43 work-refusal register mount.
   *
   * Replaces the PR #139 coming-soon placeholder. Mounts
   * WorkRefusalViewer with the demo provider so the register surface
   * renders realistic content until the work-refusal-module backend
   * is wired.
   *
   * Supports URL-driven filtering on `stage` (one of worker_refusal /
   * s43_4_investigation / s43_8_mol / resolved) via `?filter=<value>`,
   * plus a macro `?filter=active` (stage !== 'resolved') for the
   * home dashboard tile. The chip rail surfaces each individual stage;
   * the macro doesn't highlight a chip but still shows the FilterBanner.
   *
   * Work refusals are sensitivity C4 — the card carries the
   * destructive-red inline-start border shared with /reprisal and
   * /s51-evidence.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import WorkRefusalViewer from '$lib/work-refusal/WorkRefusalViewer.svelte';
  import {
    buildDemoWorkRefusals,
    fetchDemoWorkRefusalPage
  } from '$lib/work-refusal/demo-work-refusal';
  import FilterBanner from '$lib/ui/FilterBanner.svelte';
  import FilterChipsRail from '$lib/ui/FilterChipsRail.svelte';

  const DEMO_ROWS = buildDemoWorkRefusals(50);

  /** Canonical stage values supported by `?filter=`. */
  const STAGE_VALUES = /** @type {const} */ ([
    'worker_refusal',
    's43_4_investigation',
    's43_8_mol',
    'resolved'
  ]);

  $: filterParam = $page.url.searchParams.get('filter');
  $: activeValue =
    filterParam && STAGE_VALUES.includes(/** @type {any} */ (filterParam)) ? filterParam : null;
  $: filterLabel =
    filterParam === 'active' ? t('common.filterBanner.label.work_refusal_active') : null;

  $: chips = [
    { href: '/work-refusal', label: t('common.filterChips.all'), value: null },
    {
      href: '/work-refusal?filter=worker_refusal',
      label: t('workRefusal.viewer.stage.worker_refusal'),
      value: 'worker_refusal'
    },
    {
      href: '/work-refusal?filter=s43_4_investigation',
      label: t('workRefusal.viewer.stage.s43_4_investigation'),
      value: 's43_4_investigation'
    },
    {
      href: '/work-refusal?filter=s43_8_mol',
      label: t('workRefusal.viewer.stage.s43_8_mol'),
      value: 's43_8_mol'
    },
    {
      href: '/work-refusal?filter=resolved',
      label: t('workRefusal.viewer.stage.resolved'),
      value: 'resolved'
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
  $: pageTitle = activeFilterLabel ?? t('common.workRefusalPage.title');

  $: predicate = activeValue
    ? /** @param {import('$lib/work-refusal/demo-work-refusal').DemoWorkRefusalRow} r */ (r) =>
        r.stage === activeValue
    : filterParam === 'active'
      ? /** @param {import('$lib/work-refusal/demo-work-refusal').DemoWorkRefusalRow} r */ (r) =>
          r.stage !== 'resolved'
      : undefined;
  $: fetchPage =
    /**
     * @param {number} p
     * @param {number} ps
     */
    (p, ps) => fetchDemoWorkRefusalPage(p, ps, DEMO_ROWS, predicate);
</script>

<svelte:head>
  <title>{pageTitle} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card work-refusal-card" data-testid="work-refusal-page">
  <FilterChipsRail {chips} {activeValue} />
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/work-refusal" />
  {/if}
  {#key filterParam}
    <WorkRefusalViewer
      {fetchPage}
      filterActive={filterParam !== null}
      filterLabel={activeFilterLabel}
    />
  {/key}
  <p class="wr-demo-note muted" data-testid="wr-demo-note">
    {t('workRefusal.viewer.demo_note')}
  </p>
  <p class="wr-footer" data-print="hide">
    <a href="/" data-testid="work-refusal-back-to-home">
      {t('common.workRefusalPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  /* C4 sensitivity accent — shared with /reprisal and /s51-evidence. */
  .work-refusal-card {
    margin-block-start: 1rem;
    border-inline-start: 4px solid var(--color-destructive);
  }
  .wr-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .wr-footer {
    margin-block-start: 0.75rem;
  }
</style>
