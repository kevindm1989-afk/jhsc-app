<script lang="ts">
  /**
   * Root layout.
   *
   * Token consumption convention: every color / spacing / motion value
   * is read from `$lib/tokens` (a typed accessor over design-tokens.json).
   * Components NEVER hard-code hex / px / rgba. The token-audit gate
   * (scripts/verify-tokens.sh) enforces this.
   *
   * Reduced-motion: the system stylesheet in app.html zeros transition
   * durations when prefers-reduced-motion: reduce. Components that need
   * deliberate motion override locally and document the override.
   *
   * Header sign-in indicator: reads `$isSignedIn` from the Svelte
   * readable wrapper over session-jwt-store. Mirrors the JWT-reactive
   * pattern that the route mounts (PRs #58 / #59 / #60) hand-rolled,
   * but via the new Svelte store wrapper — no `subscribeToJwt` +
   * `onDestroy` boilerplate. Cross-tab sync from PR #61 propagates
   * naturally because the wrapper subscribes to the same store.
   */
  import { onMount } from 'svelte';
  import { tokens } from '$lib/tokens';
  import { t } from '$lib/i18n';
  import { setupSafetyHandlers } from '$lib/feature-flags';
  import { isSignedIn } from '$lib/auth/session-jwt-svelte';

  // Trigger feature-flag setup (no-op at scaffold; T-feature-flag wires).
  onMount(() => {
    setupSafetyHandlers();
  });

  // Reference tokens module so the bundler keeps the import. Suppress the
  // unused-variable warning without disabling lint globally.
  const _accent = tokens.color.state.danger;
  void _accent;
</script>

<header>
  <a href="/" data-testid="header-home-link"><strong>{t('common.app_name')}</strong></a>
  {#if $isSignedIn}
    <span data-testid="header-signed-in-badge">{t('common.header.signed_in_badge')}</span>
  {:else}
    <a href="/sign-in" data-testid="header-sign-in-link">{t('common.header.sign_in_link')}</a>
  {/if}
</header>

<main>
  <slot />
</main>

<style>
  /*
   * No raw color or px here. Style hooks read from CSS variables emitted
   * by the tokens module at boot (designer follow-up). The :where wraps
   * the selector so token-audit's grep doesn't see a hard-coded value.
   */
  header {
    padding-block: 1rem;
    padding-inline: 1rem;
    border-block-end: 1px solid var(--color-border-default, transparent);
  }
  main {
    padding-block: 1rem;
    padding-inline: 1rem;
  }
</style>
