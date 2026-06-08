<script lang="ts">
  /**
   * /training — coming-soon placeholder for the JHSC training-records
   * surface (worker certified member tracking per OHSA s. 9(12)(d),
   * refresher alerts, evidence attachments).
   *
   * The training-records module is a follow-on product surface; no
   * component ships yet. The placeholder lands the URL + the four-
   * bullet contract so a worker who navigates here from a future nav
   * link doesn't 404 and sees what's coming. Same pattern as PRs #133,
   * #136, #138, #139.
   *
   * Replaces this file on training-module mount: a thin wiring shell
   * that mounts the production training-records list + intake.
   */
  import { t } from '$lib/i18n';
</script>

<svelte:head>
  <title>{t('common.trainingPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card training-card" data-testid="training-page">
  <h1>{t('common.trainingPage.heading')}</h1>

  <p class="muted" data-testid="training-coming-soon-notice">
    {t('common.trainingPage.coming_soon_body')}
  </p>

  <h2>{t('common.trainingPage.what_this_will_do_heading')}</h2>
  <ul class="training-bullets">
    <li>{t('common.trainingPage.bullet_certified_member')}</li>
    <li>{t('common.trainingPage.bullet_refresher_alerts')}</li>
    <li>{t('common.trainingPage.bullet_pseudonymized_audit')}</li>
    <li>{t('common.trainingPage.bullet_evidence_attach')}</li>
  </ul>

  <p>
    <a href="/" data-testid="training-back-to-home">
      {t('common.trainingPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .training-card {
    margin-block-start: 1rem;
  }
  .training-bullets {
    margin-block: 0.75rem 1rem;
    padding-inline-start: 1.25rem;
  }
  .training-bullets > li {
    margin-block-end: 0.5rem;
  }
</style>
