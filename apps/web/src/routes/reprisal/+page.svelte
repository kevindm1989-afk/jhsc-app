<script lang="ts">
  /**
   * /reprisal — coming-soon placeholder for the reprisal-log intake
   * surface (Surface C / T13).
   *
   * The intake component (`ReprisalIntakeForm.svelte`) is shipped and
   * tested, but the production wire-up (T13.1 — submit handler bound to
   * `SupabaseReprisalClient`, per-entry passphrase derivation, audit
   * emission) is a separate focused PR. Mounting the form here without
   * that wire-up would let a worker type a real reprisal narrative into
   * a textarea that goes nowhere — actively bad UX, a data-loss risk,
   * and worse than other surfaces because reprisal entries are
   * sensitivity C4 (the highest tier).
   *
   * This placeholder lands the URL + the four-bullet contract bullets
   * the intake surface will honour, so a worker who clicks through from
   * a future nav link doesn't 404 and sees what's coming. The four
   * "what this will do" bullets restate the structural contracts
   * already enforced by the form (per-intake re-render of consent,
   * per-entry passphrase, actor visibility, OHSA s.50 reminder) so the
   * catalog strings the form references stay in sync with the
   * user-facing summary here.
   *
   * Replaces this file on T13.1 mount: a thin wiring shell that mounts
   * <ReprisalIntakeForm /> with the production client.
   */
  import { t } from '$lib/i18n';
</script>

<svelte:head>
  <title>{t('common.reprisalPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card reprisal-card" data-testid="reprisal-page">
  <h1>{t('common.reprisalPage.heading')}</h1>

  <p class="muted" data-testid="reprisal-coming-soon-notice">
    {t('common.reprisalPage.coming_soon_body')}
  </p>

  <h2>{t('common.reprisalPage.what_this_will_do_heading')}</h2>
  <ul class="reprisal-bullets">
    <li>{t('common.reprisalPage.bullet_consent_per_intake')}</li>
    <li>{t('common.reprisalPage.bullet_per_entry_passphrase')}</li>
    <li>{t('common.reprisalPage.bullet_actor_visible_to_author')}</li>
    <li>{t('common.reprisalPage.bullet_ohsa_reminder')}</li>
  </ul>

  <p>
    <a href="/" data-testid="reprisal-back-to-home">
      {t('common.reprisalPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .reprisal-card {
    margin-block-start: 1rem;
    border-inline-start: 4px solid var(--color-destructive);
  }
  .reprisal-bullets {
    margin-block: 0.75rem 1rem;
    padding-inline-start: 1.25rem;
  }
  .reprisal-bullets > li {
    margin-block-end: 0.5rem;
  }
</style>
