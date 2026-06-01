<script>
  // NOTE: no `lang="ts"` — OnboardingFlow.svelte is a plain-JS Svelte
  // component (no `<script lang="ts">`), and svelte-check's strict
  // implicit-any check rejects importing a JS component from a TS
  // route. Matching the imported component's discipline keeps the
  // type checker happy without weakening any contract; the route is a
  // simple mount wrapper with no logic of its own.
  /**
   * /onboarding — production mount point for the T19 wizard (G-T19-9).
   *
   * Before this file existed, `OnboardingFlow.svelte` was library-only
   * and no production SvelteKit route reached it — the library tests
   * mounted it directly via the harness. G-T19-9's resolution scope was
   * "land a route that mounts `OnboardingFlow` / `PanicWipeModal` in
   * production"; this is the first half.
   *
   * Production-store injection (D.3 passkey ceremony against the live
   * auth surface, D.4 recovery-blob via `storeRecoveryBlobViaProduction`,
   * the F-02 sealed-box challenge via `enrollIdentityViaProduction`)
   * lands as follow-up PRs in the T19.1 sequence. Today the route mounts
   * the wizard with the in-memory/default store wiring so end-to-end
   * users can walk D.1 → D.2 (baseline + advisory) and the structural
   * mount is in place. Per ADR-0020 Decision 8 the test-prop runtime
   * strip applies (we pass no `__test_*` props, and `MODE === 'production'`
   * in OnboardingFlow.svelte clears any inherited values defensively).
   *
   * Adapter-static + ssr=false (see `+page.ts`) — the wizard hydrates
   * client-side; no PI ever lands in SSR HTML.
   */
  import { t } from '$lib/i18n';
  import OnboardingFlow from '../../lib/onboarding/OnboardingFlow.svelte';
</script>

<svelte:head>
  <title>{t('onboarding.page_title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<OnboardingFlow />
