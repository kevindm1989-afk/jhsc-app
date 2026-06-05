<script lang="ts">
  /**
   * /recommendations — coming-soon placeholder for the recommendations
   * register (T12 sibling task — recommendations + 21-day OHSA s. 50(7)(c)
   * timer + auto-escalation).
   *
   * The T12 timer infrastructure is library-only today; production
   * wire-up (real recommendation store, employer-response capture,
   * auto-escalation alarm, export-deliberate flow into T11) is deferred.
   * This placeholder lands the URL + the four-bullet contract so a
   * worker who navigates here from a future nav link doesn't 404 and
   * sees what's coming. Same pattern as PRs #133, #136.
   *
   * Replaces this file on T12 mount: a thin wiring shell that mounts
   * the production recommendations list + 21-day timer surfaces.
   */
  import { t } from '$lib/i18n';
</script>

<svelte:head>
  <title>{t('common.recommendationsPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card recommendations-card" data-testid="recommendations-page">
  <h1>{t('common.recommendationsPage.heading')}</h1>

  <p class="muted" data-testid="recommendations-coming-soon-notice">
    {t('common.recommendationsPage.coming_soon_body')}
  </p>

  <h2>{t('common.recommendationsPage.what_this_will_do_heading')}</h2>
  <ul class="recommendations-bullets">
    <li>{t('common.recommendationsPage.bullet_21_day_timer')}</li>
    <li>{t('common.recommendationsPage.bullet_auto_escalation')}</li>
    <li>{t('common.recommendationsPage.bullet_traceability')}</li>
    <li>{t('common.recommendationsPage.bullet_export_deliberate')}</li>
  </ul>

  <p>
    <a href="/" data-testid="recommendations-back-to-home">
      {t('common.recommendationsPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .recommendations-card {
    margin-block-start: 1rem;
  }
  .recommendations-bullets {
    margin-block: 0.75rem 1rem;
    padding-inline-start: 1.25rem;
  }
  .recommendations-bullets > li {
    margin-block-end: 0.5rem;
  }
</style>
