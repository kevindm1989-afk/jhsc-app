<script lang="ts">
  /**
   * /concerns — coming-soon placeholder for the concerns intake surface.
   *
   * The intake component (`ConcernIntakeForm.svelte`) is shipped and
   * tested, but the production wire-up (T08.1 — submit handler bound to
   * `SupabaseConcernClient`, audit emission, error surfacing) is a
   * separate focused PR. Mounting the form here without that wire-up
   * would let a worker type a real concern into a textarea that goes
   * nowhere — actively bad UX and a data-loss risk.
   *
   * This placeholder route lands the URL + the contract bullets the
   * intake surface will honour, so a worker who clicks through from a
   * future nav link or a shared link doesn't 404 and sees what's
   * coming. The four "what this will do" bullets restate the structural
   * contracts already enforced by the form (F-17 anonymous default,
   * client-side encryption, pseudonymized audit, no employer
   * disclosure) so the catalog strings the form references stay in
   * sync with the user-facing summary here.
   *
   * Replaces this file on T08.1 mount: a thin wiring shell that mounts
   * <ConcernIntakeForm /> with the production client.
   */
  import { t } from '$lib/i18n';
</script>

<svelte:head>
  <title>{t('common.concernsPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card concerns-card" data-testid="concerns-page">
  <h1>{t('common.concernsPage.heading')}</h1>

  <p class="muted" data-testid="concerns-coming-soon-notice">
    {t('common.concernsPage.coming_soon_body')}
  </p>

  <h2>{t('common.concernsPage.what_this_will_do_heading')}</h2>
  <ul class="concerns-bullets">
    <li>{t('common.concernsPage.bullet_anonymous_default')}</li>
    <li>{t('common.concernsPage.bullet_encrypted')}</li>
    <li>{t('common.concernsPage.bullet_audit_pseudonym')}</li>
    <li>{t('common.concernsPage.bullet_no_employer_disclosure')}</li>
  </ul>

  <p>
    <a href="/" data-testid="concerns-back-to-home">
      {t('common.concernsPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .concerns-card {
    margin-block-start: 1rem;
  }
  .concerns-bullets {
    margin-block: 0.75rem 1rem;
    padding-inline-start: 1.25rem;
  }
  .concerns-bullets > li {
    margin-block-end: 0.5rem;
  }
</style>
