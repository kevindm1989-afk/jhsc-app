<script>
  /**
   * /audit — append-only audit-log viewer mount.
   *
   * Replaces the PR #141 coming-soon placeholder. Mounts AuditLogViewer
   * with the demo-data provider so a worker can see what the surface
   * looks like before the real audit-op Edge Function ships (T18).
   *
   * Provider injection (`fetchPage` prop): the viewer is backend-
   * agnostic; the demo provider lives in $lib/audit/demo-audit-rows.
   * When T18's SupabaseAuditClient lands, the route swaps the
   * provider — no viewer-side changes.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';
  import AuditLogViewer from '$lib/audit/AuditLogViewer.svelte';
  import { buildDemoAuditRows, fetchDemoAuditPage } from '$lib/audit/demo-audit-rows';

  // Build the demo dataset once on module load (50 rows spanning the
  // past 7 days). A future PR replaces this constant with a real
  // SupabaseAuditClient fetch.
  const DEMO_ROWS = buildDemoAuditRows(50);

  /**
   * @param {number} page
   * @param {number} page_size
   */
  const fetchPage = (page, page_size) => fetchDemoAuditPage(page, page_size, DEMO_ROWS);
</script>

<svelte:head>
  <title>{t('common.auditPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="audit-page" data-testid="audit-page">
  <AuditLogViewer {fetchPage} />
  <p class="audit-page-demo-note muted" data-testid="audit-page-demo-note">
    {t('audit.viewer.demo_note')}
  </p>
  <p class="audit-page-footer">
    <a href="/" data-testid="audit-back-to-home">{t('common.auditPage.back_to_home_cta')}</a>
  </p>
</section>

<style>
  .audit-page {
    display: block;
    margin-block-start: 1rem;
  }
  .audit-page-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .audit-page-footer {
    margin-block-start: 0.75rem;
  }
</style>
