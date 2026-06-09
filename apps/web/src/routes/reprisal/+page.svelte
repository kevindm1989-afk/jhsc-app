<script>
  /**
   * /reprisal — JHSC C4-tier reprisal-log register viewer mount.
   *
   * Replaces the PR #136 coming-soon placeholder. Mounts ReprisalViewer
   * with the demo provider so the register surface renders realistic
   * content until T13.1 wires the production SupabaseReprisalClient
   * (per-entry passphrase derivation + audit emission + role-gated
   * read path).
   *
   * Preserves the destructive-red 4px inline-start border the
   * placeholder card established, so the C4 sensitivity reads at a
   * glance even before the row list paints.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';
  import ReprisalViewer from '$lib/reprisal/ReprisalViewer.svelte';
  import { buildDemoReprisals, fetchDemoReprisalPage } from '$lib/reprisal/demo-reprisal';

  const DEMO_ROWS = buildDemoReprisals(50);

  /**
   * @param {number} page
   * @param {number} page_size
   */
  const fetchPage = (page, page_size) => fetchDemoReprisalPage(page, page_size, DEMO_ROWS);
</script>

<svelte:head>
  <title>{t('common.reprisalPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card reprisal-card" data-testid="reprisal-page">
  <ReprisalViewer {fetchPage} />
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
