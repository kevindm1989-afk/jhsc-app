<script>
  /**
   * /training — JHSC training-records register mount.
   *
   * Replaces the PR #139 coming-soon placeholder. Mounts TrainingViewer
   * with the demo provider so the surface renders realistic content
   * until the training-records-module backend is wired.
   *
   * Supports URL-driven filtering:
   *   - `?filter=expired` narrows to `validity === 'expired'`, matching
   *     the "Expired training" home dashboard tile.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import TrainingViewer from '$lib/training/TrainingViewer.svelte';
  import { buildDemoTraining, fetchDemoTrainingPage } from '$lib/training/demo-training';
  import FilterBanner from '$lib/ui/FilterBanner.svelte';

  const DEMO_ROWS = buildDemoTraining(50);

  $: filterParam = $page.url.searchParams.get('filter');
  $: filterLabel =
    filterParam === 'expired' ? t('common.filterBanner.label.training_expired') : null;
  $: predicate =
    filterParam === 'expired'
      ? /** @param {import('$lib/training/demo-training').DemoTrainingRow} r */ (r) =>
          r.validity === 'expired'
      : undefined;
  $: fetchPage =
    /**
     * @param {number} p
     * @param {number} ps
     */
    (p, ps) => fetchDemoTrainingPage(p, ps, DEMO_ROWS, predicate);
</script>

<svelte:head>
  <title>{t('common.trainingPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card trn-card" data-testid="training-page">
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/training" />
  {/if}
  {#key filterParam}
    <TrainingViewer {fetchPage} />
  {/key}
  <p class="trn-demo-note muted" data-testid="trn-demo-note">
    {t('training.viewer.demo_note')}
  </p>
  <p class="trn-footer">
    <a href="/" data-testid="training-back-to-home">
      {t('common.trainingPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .trn-card {
    margin-block-start: 1rem;
  }
  .trn-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .trn-footer {
    margin-block-start: 0.75rem;
  }
</style>
