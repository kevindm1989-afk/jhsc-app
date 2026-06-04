<script lang="ts">
  /**
   * /privacy — placeholder privacy page.
   *
   * D2 of the onboarding flow links to /privacy via
   * `<a href="/privacy">Read the full privacy policy</a>`. Before this
   * route existed, that link 404'd. The full prose policy is HG-10
   * (lawyer-review-trigger) territory and is being finalized; this
   * route ships a minimal interim page so the link resolves and the
   * user is not dead-ended.
   *
   * The body carries a short summary of the contractual posture
   * already pinned in the threat model + §PI inventory + decisions.md:
   *   - No third-party JS or analytics (svelte.config.js CSP).
   *   - Client-side encryption for concerns + reprisal narratives.
   *   - Pseudonymized append-only audit log (ADR-0016).
   *   - PI-scrubbed crash logs (lib/observability/sentry-scrub.ts).
   *
   * Every claim above is structurally enforced by code paths that
   * already ship; this page just surfaces them in user-facing prose.
   * Sentence-level wording remains placeholder until lawyer review.
   *
   * Routes load posture matches the rest of the app shell: prerender
   * + ssr=false (see +page.ts). No PI on the route surface.
   */
  import { t } from '$lib/i18n';
</script>

<svelte:head>
  <title>{t('common.privacyPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card privacy-card" data-testid="privacy-page">
  <h1>{t('common.privacyPage.heading')}</h1>

  <p class="muted" data-testid="privacy-placeholder-notice">
    {t('common.privacyPage.placeholder_body')}
  </p>

  <h2>{t('common.privacyPage.summary_heading')}</h2>
  <p>{t('common.privacyPage.summary_intro')}</p>

  <ul class="privacy-bullets">
    <li>{t('common.privacyPage.bullet_no_third_party')}</li>
    <li>{t('common.privacyPage.bullet_local_first')}</li>
    <li>{t('common.privacyPage.bullet_audit')}</li>
    <li>{t('common.privacyPage.bullet_no_pi_logs')}</li>
  </ul>

  <p>
    <a href="/" data-testid="privacy-back-to-home">
      {t('common.privacyPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .privacy-card {
    margin-block-start: 1rem;
  }
  .privacy-bullets {
    margin-block: 0.75rem 1rem;
    padding-inline-start: 1.25rem;
  }
  .privacy-bullets > li {
    margin-block-end: 0.5rem;
  }
</style>
