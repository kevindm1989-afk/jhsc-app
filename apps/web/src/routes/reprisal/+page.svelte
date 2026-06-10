<script>
  /**
   * /reprisal — JHSC C4-tier reprisal-log register viewer mount.
   *
   * Replaces the PR #136 coming-soon placeholder. Mounts ReprisalViewer
   * with the demo provider so the register surface renders realistic
   * content until T13.1 wires the production SupabaseReprisalClient.
   *
   * Supports URL-driven filtering:
   *   - `?filter=active` narrows to stage in {filed, investigating}.
   *     The vast majority of register activity sits in those two
   *     stages — surfacing the "in-flight" subset is the most common
   *     worker query.
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

  const DEMO_ROWS = buildDemoReprisals(50);

  $: filterParam = $page.url.searchParams.get('filter');
  $: filterLabel = filterParam === 'active' ? t('common.filterBanner.label.reprisal_active') : null;
  $: predicate =
    filterParam === 'active'
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
