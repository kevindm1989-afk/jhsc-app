<script>
  /**
   * /work-refusal — JHSC C4-tier OHSA s. 43 work-refusal register mount.
   *
   * Replaces the PR #139 coming-soon placeholder. Mounts
   * WorkRefusalViewer with the demo provider so the register surface
   * renders realistic content until the work-refusal-module backend
   * is wired.
   *
   * Supports URL-driven filtering:
   *   - `?filter=active` narrows to `stage !== 'resolved'`, matching
   *     the "Active s. 43 refusals" home dashboard tile.
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

  const DEMO_ROWS = buildDemoWorkRefusals(50);

  $: filterParam = $page.url.searchParams.get('filter');
  $: filterLabel =
    filterParam === 'active' ? t('common.filterBanner.label.work_refusal_active') : null;
  $: predicate =
    filterParam === 'active'
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
  <title>{t('common.workRefusalPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card work-refusal-card" data-testid="work-refusal-page">
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/work-refusal" />
  {/if}
  {#key filterParam}
    <WorkRefusalViewer {fetchPage} />
  {/key}
  <p class="wr-demo-note muted" data-testid="wr-demo-note">
    {t('workRefusal.viewer.demo_note')}
  </p>
  <p class="wr-footer">
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
