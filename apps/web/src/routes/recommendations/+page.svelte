<script>
  /**
   * /recommendations — JHSC recommendations register viewer mount.
   *
   * Replaces the PR #138 coming-soon placeholder. Mounts
   * RecommendationsViewer with the demo provider so the surface
   * renders realistic content until T12 wires the real backend
   * (recommendations store + 21-day timer state + employer-response
   * capture + auto-escalation).
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';
  import RecommendationsViewer from '$lib/recommendations/RecommendationsViewer.svelte';
  import {
    buildDemoRecommendations,
    fetchDemoRecommendationsPage
  } from '$lib/recommendations/demo-recommendations';

  const DEMO_ROWS = buildDemoRecommendations(50);

  /**
   * @param {number} page
   * @param {number} page_size
   */
  const fetchPage = (page, page_size) => fetchDemoRecommendationsPage(page, page_size, DEMO_ROWS);
</script>

<svelte:head>
  <title>{t('common.recommendationsPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card recs-card" data-testid="recommendations-page">
  <RecommendationsViewer {fetchPage} />
  <p class="recs-demo-note muted" data-testid="recs-demo-note">
    {t('recommendations.viewer.demo_note')}
  </p>
  <p class="recs-footer">
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
