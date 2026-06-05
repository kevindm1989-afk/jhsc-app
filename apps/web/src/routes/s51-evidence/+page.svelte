<script lang="ts">
  /**
   * /s51-evidence — coming-soon placeholder for the OHSA s. 51
   * critical-injury evidence capture surface (T14 sibling task).
   *
   * Section 51 requires a worker member of the JHSC to be present at
   * the investigation of any critical injury or fatality, and the
   * scene must be preserved for at least 48 hours per s. 51(2). The
   * full capture surface (photos + witness statements + scene notes
   * at sensitivity C4, per-entry passphrase, scene-preservation timer
   * surfaced as a deadline) is a follow-on product surface; T14
   * library scaffolding exists for the s51_evidence schema but no
   * intake component ships yet.
   *
   * This placeholder is sensitivity-tier-aware: it carries the same
   * 4px destructive-red inline-start border as /reprisal and the
   * PanicWipeModal — every C4 surface in the worker-hub language
   * shares that destructive accent.
   *
   * Replaces this file on T14 mount: a thin wiring shell that mounts
   * the production evidence-capture flow + scene-preservation timer.
   */
  import { t } from '$lib/i18n';
</script>

<svelte:head>
  <title>{t('common.s51Page.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card s51-card" data-testid="s51-page">
  <h1>{t('common.s51Page.heading')}</h1>

  <p class="muted" data-testid="s51-coming-soon-notice">
    {t('common.s51Page.coming_soon_body')}
  </p>

  <h2>{t('common.s51Page.what_this_will_do_heading')}</h2>
  <ul class="s51-bullets">
    <li>{t('common.s51Page.bullet_worker_member_present')}</li>
    <li>{t('common.s51Page.bullet_scene_preservation')}</li>
    <li>{t('common.s51Page.bullet_c4_encryption')}</li>
    <li>{t('common.s51Page.bullet_photo_sanitize')}</li>
  </ul>

  <p>
    <a href="/" data-testid="s51-back-to-home">
      {t('common.s51Page.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  /*
   * 4px destructive-red inline-start border — the C4 sensitivity
   * accent shared with /reprisal and PanicWipeModal. Every high-
   * consequence surface in the worker-hub language carries this
   * signal so the user reads the gravity before they read the prose.
   */
  .s51-card {
    margin-block-start: 1rem;
    border-inline-start: 4px solid var(--color-destructive);
  }
  .s51-bullets {
    margin-block: 0.75rem 1rem;
    padding-inline-start: 1.25rem;
  }
  .s51-bullets > li {
    margin-block-end: 0.5rem;
  }
</style>
