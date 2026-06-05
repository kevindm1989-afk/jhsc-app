<script lang="ts">
  /**
   * /minutes — coming-soon placeholder for the meeting-minutes drafting
   * surface (committee deliberation, approval-gated publication).
   *
   * The minutes module is a follow-on product surface; library code is
   * partially scaffolded (audit-log enums for minutes events exist in
   * the catalog) but no intake component ships yet. The placeholder
   * lands the URL + the four-bullet contract so a worker who navigates
   * here from a future nav link doesn't 404 and sees what's coming.
   * Same pattern as PRs #133 (/privacy) and #136 (/concerns + /reprisal).
   *
   * Replaces this file on minutes-module mount: a thin wiring shell
   * that mounts the production minutes editor + approval ceremony.
   */
  import { t } from '$lib/i18n';
</script>

<svelte:head>
  <title>{t('common.minutesPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card minutes-card" data-testid="minutes-page">
  <h1>{t('common.minutesPage.heading')}</h1>

  <p class="muted" data-testid="minutes-coming-soon-notice">
    {t('common.minutesPage.coming_soon_body')}
  </p>

  <h2>{t('common.minutesPage.what_this_will_do_heading')}</h2>
  <ul class="minutes-bullets">
    <li>{t('common.minutesPage.bullet_worker_side_drafts')}</li>
    <li>{t('common.minutesPage.bullet_approval_gated')}</li>
    <li>{t('common.minutesPage.bullet_revision_history')}</li>
    <li>{t('common.minutesPage.bullet_quoted_consent')}</li>
  </ul>

  <p>
    <a href="/" data-testid="minutes-back-to-home">
      {t('common.minutesPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .minutes-card {
    margin-block-start: 1rem;
  }
  .minutes-bullets {
    margin-block: 0.75rem 1rem;
    padding-inline-start: 1.25rem;
  }
  .minutes-bullets > li {
    margin-block-end: 0.5rem;
  }
</style>
