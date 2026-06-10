<script>
  /**
   * /concerns — JHSC concerns register viewer mount.
   *
   * Replaces the PR #136 coming-soon placeholder. Mounts ConcernsViewer
   * with the demo provider so the register surface renders realistic
   * content until T08.1 wires the production SupabaseConcernsClient.
   *
   * Supports URL-driven filtering:
   *   - `?filter=open` narrows the register to `status === 'open'`,
   *     matching the "Open concerns" home dashboard tile.
   * Future filters (severity, hazard) slot in here without changing
   * the viewer.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import ConcernsViewer from '$lib/concerns/ConcernsViewer.svelte';
  import { buildDemoConcerns, fetchDemoConcernsPage } from '$lib/concerns/demo-concerns';
  import FilterBanner from '$lib/ui/FilterBanner.svelte';

  const DEMO_ROWS = buildDemoConcerns(50);

  $: filterParam = $page.url.searchParams.get('filter');
  $: filterLabel = filterParam === 'open' ? t('common.filterBanner.label.concerns_open') : null;
  $: predicate =
    filterParam === 'open'
      ? /** @param {import('$lib/concerns/demo-concerns').DemoConcernRow} r */ (r) =>
          r.status === 'open'
      : undefined;
  $: fetchPage =
    /**
     * @param {number} p
     * @param {number} ps
     */
    (p, ps) => fetchDemoConcernsPage(p, ps, DEMO_ROWS, predicate);
</script>

<svelte:head>
  <title>{t('common.concernsPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card con-card" data-testid="concerns-page">
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/concerns" />
  {/if}
  {#key filterParam}
    <ConcernsViewer {fetchPage} />
  {/key}
  <p class="con-demo-note muted" data-testid="con-demo-note">
    {t('concern.viewer.demo_note')}
  </p>
  <p class="con-footer">
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
