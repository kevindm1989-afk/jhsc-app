<script lang="ts">
  /**
   * Landing page.
   *
   * Offers both onboarding entry (new device) and sign-in entry
   * (returning device). The already-onboarded ↔ new-device decision
   * COULD be automated via `localIdentity.getIdentityPrivateKey()`
   * (resolves → "already onboarded" path; throws → "new device" path),
   * but that requires an async probe at mount time + a UX decision
   * about how to surface ambiguity. Until then, present both paths
   * and let the user choose — the static CTA pair is also robust to
   * shared-device scenarios where the local store identifies one user
   * but a different user is signing in.
   *
   * All visible text resolves via t() per ADR-0009.
   */
  import { t } from '$lib/i18n';
</script>

<svelte:head>
  <title>{t('common.app_name')}</title>
</svelte:head>

<h1>{t('common.app_name')}</h1>
<p>{t('landing.subtitle')}</p>

<section data-testid="landing-new-device">
  <h2>{t('landing.new_device.heading')}</h2>
  <p>{t('landing.new_device.description')}</p>
  <p>
    <a href="/onboarding" data-testid="landing-link-onboarding">{t('landing.new_device.cta')}</a>
  </p>
</section>

<section data-testid="landing-returning-device">
  <h2>{t('landing.returning_device.heading')}</h2>
  <p>{t('landing.returning_device.description')}</p>
  <p>
    <a href="/sign-in" data-testid="landing-link-sign-in">{t('landing.returning_device.cta')}</a>
  </p>
</section>
