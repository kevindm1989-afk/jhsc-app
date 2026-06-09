<script>
  /**
   * /concerns — JHSC concerns register viewer mount.
   *
   * Replaces the PR #136 coming-soon placeholder. Mounts ConcernsViewer
   * with the demo provider so the register surface renders realistic
   * content until T08.1 wires the production SupabaseConcernsClient
   * (submit handler + audit emission + committee-key-derived
   * decryption).
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';
  import ConcernsViewer from '$lib/concerns/ConcernsViewer.svelte';
  import { buildDemoConcerns, fetchDemoConcernsPage } from '$lib/concerns/demo-concerns';

  const DEMO_ROWS = buildDemoConcerns(50);

  /**
   * @param {number} page
   * @param {number} page_size
   */
  const fetchPage = (page, page_size) => fetchDemoConcernsPage(page, page_size, DEMO_ROWS);
</script>

<svelte:head>
  <title>{t('common.concernsPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card con-card" data-testid="concerns-page">
  <ConcernsViewer {fetchPage} />
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
