<script lang="ts">
  /**
   * /library — coming-soon placeholder for the committee document
   * library (versioned reference docs, offline cache, on-device search).
   *
   * The library module is a follow-on product surface; no intake or
   * viewer component ships yet. The placeholder lands the URL + the
   * four-bullet contract so a worker who navigates here from a future
   * nav link doesn't 404 and sees what's coming. Same pattern as
   * PRs #133, #136, #138, #139.
   *
   * Replaces this file on library-module mount: a thin wiring shell
   * that mounts the production document-list + viewer.
   */
  import { t } from '$lib/i18n';
</script>

<svelte:head>
  <title>{t('common.libraryPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card library-card" data-testid="library-page">
  <h1>{t('common.libraryPage.heading')}</h1>

  <p class="muted" data-testid="library-coming-soon-notice">
    {t('common.libraryPage.coming_soon_body')}
  </p>

  <h2>{t('common.libraryPage.what_this_will_do_heading')}</h2>
  <ul class="library-bullets">
    <li>{t('common.libraryPage.bullet_versioned')}</li>
    <li>{t('common.libraryPage.bullet_offline_cache')}</li>
    <li>{t('common.libraryPage.bullet_search')}</li>
    <li>{t('common.libraryPage.bullet_committee_scoped')}</li>
  </ul>

  <p>
    <a href="/" data-testid="library-back-to-home">
      {t('common.libraryPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .library-card {
    margin-block-start: 1rem;
  }
  .library-bullets {
    margin-block: 0.75rem 1rem;
    padding-inline-start: 1.25rem;
  }
  .library-bullets > li {
    margin-block-end: 0.5rem;
  }
</style>
