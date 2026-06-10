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

  const DEMO_ROWS = buildDemoS51Evidence(30);

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

  $: predicate = activeValue
    ? /** @param {import('$lib/s51-evidence/demo-s51-evidence').DemoS51EvidenceRow} r */ (r) =>
        r.scene_state === activeValue
    : undefined;
  $: fetchPage =
    /**
     * @param {number} p
     * @param {number} ps
     */
    (p, ps) => fetchDemoS51EvidencePage(p, ps, DEMO_ROWS, predicate);
</script>

<svelte:head>
  <title>{pageTitle} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card s51-card" data-testid="s51-page">
  <FilterChipsRail {chips} {activeValue} />
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/s51-evidence" />
  {/if}
  {#key filterParam}
    <S51EvidenceViewer
      {fetchPage}
      filterActive={filterParam !== null}
      filterLabel={activeFilterLabel}
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
