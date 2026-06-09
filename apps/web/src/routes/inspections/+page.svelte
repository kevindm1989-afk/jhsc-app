<script>
  /**
   * /inspections — JHSC inspections register viewer mount.
   *
   * Replaces the PR #136 coming-soon placeholder. Mounts
   * InspectionsViewer with the demo provider so the surface renders
   * realistic content until T10.1 wires the real backend (real
   * IndexedDB-backed store + PhotoCaptureSurface UI + ServiceWorker
   * integration + real-canvas EXIF re-encode).
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';
  import InspectionsViewer from '$lib/inspections/InspectionsViewer.svelte';
  import {
    buildDemoInspections,
    fetchDemoInspectionsPage
  } from '$lib/inspections/demo-inspections';

  const DEMO_ROWS = buildDemoInspections(50);

  /**
   * @param {number} page
   * @param {number} page_size
   */
  const fetchPage = (page, page_size) => fetchDemoInspectionsPage(page, page_size, DEMO_ROWS);
</script>

<svelte:head>
  <title>{t('common.inspectionsPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card ins-card" data-testid="inspections-page">
  <InspectionsViewer {fetchPage} />
  <p class="ins-demo-note muted" data-testid="ins-demo-note">
    {t('inspection.viewer.demo_note')}
  </p>
  <p class="ins-footer">
    <a href="/" data-testid="inspections-back-to-home">
      {t('common.inspectionsPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .ins-card {
    margin-block-start: 1rem;
  }
  .ins-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .ins-footer {
    margin-block-start: 0.75rem;
  }
</style>
