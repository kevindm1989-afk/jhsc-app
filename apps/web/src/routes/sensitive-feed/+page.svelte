<script lang="ts">
  /**
   * /sensitive-feed — coming-soon placeholder for the worker-co-chair
   * + worker-certified-member C3/C4 activity feed.
   *
   * The feed surfaces metadata for sensitivity-tier events (concerns
   * filed, reprisal entries created, work-refusal stages, s.51 evidence
   * captured) without exposing the narrative content — narratives stay
   * encrypted. Role-gated visibility (worker co-chair / certified member
   * only); ordinary members see only their own actions.
   *
   * Sensitivity-tier-aware visual: the page carries the same 4px
   * destructive-red inline-start border as /reprisal, /s51-evidence,
   * and PanicWipeModal — every surface that interacts with C3/C4
   * content in the worker-hub language shares that destructive accent.
   *
   * Replaces this file on sensitive-feed-module mount: a thin wiring
   * shell that mounts the production feed surface.
   */
  import { t } from '$lib/i18n';
</script>

<svelte:head>
  <title>{t('common.sensitiveFeedPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card sensitive-feed-card" data-testid="sensitive-feed-page">
  <h1>{t('common.sensitiveFeedPage.heading')}</h1>

  <p class="muted" data-testid="sensitive-feed-coming-soon-notice">
    {t('common.sensitiveFeedPage.coming_soon_body')}
  </p>

  <h2>{t('common.sensitiveFeedPage.what_this_will_do_heading')}</h2>
  <ul class="sensitive-feed-bullets">
    <li>{t('common.sensitiveFeedPage.bullet_metadata_only')}</li>
    <li>{t('common.sensitiveFeedPage.bullet_c3_c4_scoped')}</li>
    <li>{t('common.sensitiveFeedPage.bullet_export_deliberate')}</li>
    <li>{t('common.sensitiveFeedPage.bullet_role_gated')}</li>
  </ul>

  <p>
    <a href="/" data-testid="sensitive-feed-back-to-home">
      {t('common.sensitiveFeedPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  /*
   * 4px destructive-red inline-start border — shared with /reprisal,
   * /s51-evidence, and PanicWipeModal. Every surface that interacts
   * with C3/C4 content (even just metadata) carries this signal so
   * the user reads the gravity before they read the prose.
   */
  .sensitive-feed-card {
    margin-block-start: 1rem;
    border-inline-start: 4px solid var(--color-destructive);
  }
  .sensitive-feed-bullets {
    margin-block: 0.75rem 1rem;
    padding-inline-start: 1.25rem;
  }
  .sensitive-feed-bullets > li {
    margin-block-end: 0.5rem;
  }
</style>
