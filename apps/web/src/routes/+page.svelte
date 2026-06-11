<script>
  /**
   * Landing page.
   *
   * Offers three states keyed off CURRENT JWT presence:
   *   - Signed in (`isSignedIn = true`): the existing welcome-back card
   *     with the /settings CTA, PLUS the new HomeDashboard digest that
   *     tiles cross-register "needs attention" counts (open concerns,
   *     overdue recommendations, expired training, active s. 43
   *     refusals, s. 51 scenes still preserving). The digest is
   *     computed from the same demo providers the register surfaces
   *     use, so the front door reads as a coherent map of the open
   *     work until each register's real backend is wired.
   *   - Not signed in (`isSignedIn = false`): two CTAs — onboarding
   *     entry (new device) and sign-in entry (returning device).
   *     The already-onboarded ↔ new-device decision COULD be automated
   *     via `localIdentity.getIdentityPrivateKey()`, but that requires
   *     an async probe + UX decision; the static pair is also robust
   *     to shared-device scenarios.
   *
   * Reactive JWT state (parity with /sign-in and /settings): consumes
   * the `$isSignedIn` Svelte readable store from
   * `$lib/auth/session-jwt-svelte` (introduced PR #63). The wrapper
   * subscribes to the underlying session-jwt-store once and Svelte's
   * `$`-prefix auto-subscribes / unsubscribes so any external clear
   * (panic-wipe, 401 revocation, cross-tab sign-out, future server-
   * side revoke) flips the UI in real time. Initial value comes from
   * the wrapper's seed (`getJwt() !== null`) so a returning visitor
   * sees the welcome-back state at mount without a flash of the two-
   * CTA layout.
   *
   * All visible text resolves via t() per ADR-0009. Layout/colour
   * come from the shared card + cta classes in app.css (worker-hub
   * language).
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';
  import { isSignedIn } from '$lib/auth/session-jwt-svelte';
  import HomeDashboard from '$lib/home/HomeDashboard.svelte';
  import RecentActivityCard from '$lib/home/RecentActivityCard.svelte';
  import { buildHomeSummary } from '$lib/home/home-summary';
  import { buildDemoConcerns } from '$lib/concerns/demo-concerns';
  import { buildDemoRecommendations } from '$lib/recommendations/demo-recommendations';
  import { buildDemoTraining } from '$lib/training/demo-training';
  import { buildDemoWorkRefusals } from '$lib/work-refusal/demo-work-refusal';
  import { buildDemoS51Evidence } from '$lib/s51-evidence/demo-s51-evidence';
  import { buildDemoAuditRows } from '$lib/audit/demo-audit-rows';
  import { buildMonthlyReport, toMonthString } from '$lib/report/aggregate';

  // Sum the current month's totals across every register so the
  // "Monthly activity" tile shows one digestible number on the front
  // door. We re-use the same aggregator /report renders so the two
  // surfaces agree.
  const currentMonth = buildMonthlyReport(toMonthString(new Date()));
  const currentMonthActivity = Object.values(currentMonth.totals).reduce((acc, n) => acc + n, 0);

  // Digest is computed once at mount over the demo providers. When each
  // register's real backend lands the page swaps these calls for real
  // queries; the HomeDashboard component itself is provider-agnostic.
  const summary = buildHomeSummary({
    concerns: buildDemoConcerns(50),
    recommendations: buildDemoRecommendations(50),
    training: buildDemoTraining(50),
    workRefusals: buildDemoWorkRefusals(50),
    s51Evidence: buildDemoS51Evidence(30),
    currentMonthActivity
  });

  // Top-5 recent audit rows for the "what just happened" timeline.
  // buildDemoAuditRows sorts newest-first so a plain slice works.
  const recentRows = buildDemoAuditRows(50).slice(0, 5);
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
  <section class="card" data-testid="landing-dashboard">
    <HomeDashboard {summary} />
  </section>
  <section class="card" data-testid="landing-recent">
    <RecentActivityCard rows={recentRows} />
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
