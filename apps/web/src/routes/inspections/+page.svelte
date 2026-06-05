<script lang="ts">
  /**
   * /inspections — coming-soon placeholder for the monthly-inspection
   * capture surface (T10 sibling task).
   *
   * The T10 inspection queue library is shipped (offline-first queue,
   * per-entry HMAC integrity tags, photo sanitize) but production
   * wire-up is deferred to T10.1 (real IndexedDB-backed store,
   * PhotoCaptureSurface UI, ServiceWorker integration, real-canvas
   * EXIF re-encode). Mounting an unwired capture surface would risk a
   * worker filling in an inspection that goes nowhere.
   *
   * This placeholder lands the URL + the four-bullet contract bullets
   * the capture surface will honour so a worker who navigates here from
   * a future nav link or shared URL doesn't 404 and sees what's coming.
   * Same pattern as PRs #133 (/privacy) and #136 (/concerns + /reprisal).
   *
   * Replaces this file on T10.1 mount: a thin wiring shell that mounts
   * the production PhotoCaptureSurface + IndexedDBInspectionStore.
   */
  import { t } from '$lib/i18n';
</script>

<svelte:head>
  <title>{t('common.inspectionsPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card inspections-card" data-testid="inspections-page">
  <h1>{t('common.inspectionsPage.heading')}</h1>

  <p class="muted" data-testid="inspections-coming-soon-notice">
    {t('common.inspectionsPage.coming_soon_body')}
  </p>

  <h2>{t('common.inspectionsPage.what_this_will_do_heading')}</h2>
  <ul class="inspections-bullets">
    <li>{t('common.inspectionsPage.bullet_ohsa_monthly')}</li>
    <li>{t('common.inspectionsPage.bullet_offline_first')}</li>
    <li>{t('common.inspectionsPage.bullet_integrity_tag')}</li>
    <li>{t('common.inspectionsPage.bullet_photo_sanitize')}</li>
  </ul>

  <p>
    <a href="/" data-testid="inspections-back-to-home">
      {t('common.inspectionsPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .inspections-card {
    margin-block-start: 1rem;
  }
  .inspections-bullets {
    margin-block: 0.75rem 1rem;
    padding-inline-start: 1.25rem;
  }
  .inspections-bullets > li {
    margin-block-end: 0.5rem;
  }
</style>
