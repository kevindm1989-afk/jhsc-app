<script lang="ts">
  /**
   * Landing page.
   *
   * Offers three states keyed off CURRENT JWT presence:
   *   - Signed in (`isSignedIn = true`): single "Continue to settings"
   *     CTA. A returning visitor doesn't need to be told to "sign in"
   *     when they already have an active session.
   *   - Not signed in (`isSignedIn = false`): two CTAs — onboarding
   *     entry (new device) and sign-in entry (returning device).
   *     The already-onboarded ↔ new-device decision COULD be automated
   *     via `localIdentity.getIdentityPrivateKey()`, but that requires
   *     an async probe + UX decision; the static pair is also robust
   *     to shared-device scenarios.
   *
   * Reactive JWT state (parity with /sign-in and /settings): consumes
   * the `$isSignedIn` Svelte readable store from
   * `$lib/auth/session-jwt-svelte` (introduced PR #63, this route
   * migrated PR #64). The wrapper subscribes to the underlying
   * session-jwt-store once and Svelte's `$`-prefix auto-subscribes /
   * unsubscribes so any external clear (panic-wipe, 401 revocation,
   * cross-tab sign-out, future server-side revoke) flips the UI in
   * real time. Initial value comes from the wrapper's seed
   * (`getJwt() !== null`) so a returning visitor sees the welcome-back
   * state at mount without a flash of the two-CTA layout.
   *
   * All visible text resolves via t() per ADR-0009. Layout/colour come
   * from the shared card + cta classes in app.css (worker-hub language).
   */
  import { t } from '$lib/i18n';
  import { isSignedIn } from '$lib/auth/session-jwt-svelte';
</script>

<svelte:head>
  <title>{t('common.app_name')}</title>
</svelte:head>

<div class="page-head">
  <h1>{t('common.app_name')}</h1>
  <p class="muted">{t('landing.subtitle')}</p>
</div>

{#if $isSignedIn}
  <section class="card" data-testid="landing-signed-in">
    <h2>{t('landing.signed_in.heading')}</h2>
    <p>{t('landing.signed_in.description')}</p>
    <p>
      <a href="/settings" class="cta" data-testid="landing-link-settings"
        >{t('landing.signed_in.cta')}</a
      >
    </p>
  </section>
{:else}
  <section class="card" data-testid="landing-new-device">
    <h2>{t('landing.new_device.heading')}</h2>
    <p>{t('landing.new_device.description')}</p>
    <p>
      <a href="/onboarding" class="cta" data-testid="landing-link-onboarding"
        >{t('landing.new_device.cta')}</a
      >
    </p>
  </section>

  <section class="card" data-testid="landing-returning-device">
    <h2>{t('landing.returning_device.heading')}</h2>
    <p>{t('landing.returning_device.description')}</p>
    <p>
      <a href="/sign-in" class="cta" data-testid="landing-link-sign-in"
        >{t('landing.returning_device.cta')}</a
      >
    </p>
  </section>
{/if}

<style>
  .page-head {
    margin-block-end: 1.5rem;
  }
  /* The first card heading sits flush with the card's top padding. */
  section.card :global(h2) {
    margin-block-start: 0;
  }
</style>
