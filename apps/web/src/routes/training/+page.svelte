<script>
  /**
   * /training — JHSC training-records register mount.
   *
   * Replaces the PR #139 coming-soon placeholder. Mounts TrainingViewer
   * with the demo provider so the surface renders realistic content
   * until the training-records-module backend (certified-member
   * tracking + refresher alerts + evidence attachments) is wired.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';
  import TrainingViewer from '$lib/training/TrainingViewer.svelte';
  import { buildDemoTraining, fetchDemoTrainingPage } from '$lib/training/demo-training';

  const DEMO_ROWS = buildDemoTraining(50);

  /**
   * @param {number} page
   * @param {number} page_size
   */
  const fetchPage = (page, page_size) => fetchDemoTrainingPage(page, page_size, DEMO_ROWS);
</script>

<svelte:head>
  <title>{t('common.trainingPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card trn-card" data-testid="training-page">
  <TrainingViewer {fetchPage} />
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
