<script lang="ts">
  /**
   * /audit — coming-soon placeholder for the append-only audit-log
   * viewer (ADR-0016 pseudonymization + T18 Merkle integrity chain).
   *
   * The audit log itself is shipped server-side; the viewer surface
   * (scrollable feed, integrity verification UI, retention-aware
   * filtering) is a follow-on. The placeholder lands the URL + the
   * four-bullet contract so a worker who navigates here from a future
   * nav link doesn't 404 and sees what's coming. Same pattern as
   * PRs #133, #136, #138, #139, #140.
   *
   * Replaces this file on audit-viewer mount: a thin wiring shell
   * that mounts the production audit feed + Merkle verifier.
   */
  import { t } from '$lib/i18n';
</script>

<svelte:head>
  <title>{t('common.auditPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card audit-card" data-testid="audit-page">
  <h1>{t('common.auditPage.heading')}</h1>

  <p class="muted" data-testid="audit-coming-soon-notice">
    {t('common.auditPage.coming_soon_body')}
  </p>

  <h2>{t('common.auditPage.what_this_will_do_heading')}</h2>
  <ul class="audit-bullets">
    <li>{t('common.auditPage.bullet_append_only')}</li>
    <li>{t('common.auditPage.bullet_pseudonymized')}</li>
    <li>{t('common.auditPage.bullet_merkle_integrity')}</li>
    <li>{t('common.auditPage.bullet_retention_aware')}</li>
  </ul>

  <p>
    <a href="/" data-testid="audit-back-to-home">
      {t('common.auditPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .audit-card {
    margin-block-start: 1rem;
  }
  .audit-bullets {
    margin-block: 0.75rem 1rem;
    padding-inline-start: 1.25rem;
  }
  .audit-bullets > li {
    margin-block-end: 0.5rem;
  }
</style>
