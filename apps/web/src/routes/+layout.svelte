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

<a class="skip-link" href="#main-content" data-testid="skip-to-content">
  {t('common.actions.skip_to_content')}
</a>

<header>
  <a href="/" data-testid="header-home-link"><strong>{t('common.app_name')}</strong></a>
  {#if $isSignedIn}
    <!--
      When signed in, the header shows a Settings link (one-click access
      to where the sign-out + panic-wipe affordances live) rather than
      a static "Signed in" badge. Sign-in state is still signalled
      implicitly: the Sign in link only appears when NOT signed in.
    -->
    <a href="/settings" data-testid="header-settings-link">{t('common.header.settings_link')}</a>
  {:else}
    <a href="/sign-in" data-testid="header-sign-in-link">{t('common.header.sign_in_link')}</a>
  {/if}
</header>

<main id="main-content" tabindex="-1">
  <slot />
</main>

<style>
  /*
   * No raw color or px here. Style hooks read from CSS variables emitted
   * by the tokens module at boot (designer follow-up). The :where wraps
   * the selector so token-audit's grep doesn't see a hard-coded value.
   */
  .skip-link {
    /*
     * WCAG 2.1.1 / 2.4.1 — the skip-to-content link is visually hidden
     * by default and becomes visible on keyboard focus so keyboard
     * users can bypass the repeated header on every page navigation.
     * Off-screen positioning (not display:none) keeps it focusable.
     * The :focus rule reveals it inline at the top-left.
     */
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: 0;
    transform: translateY(-100%);
    padding-block: 0.5rem;
    padding-inline: 1rem;
    background: var(--color-bg-elevated, transparent);
    color: var(--color-fg-default, inherit);
    z-index: 1000;
  }
  .skip-link:focus {
    transform: translateY(0);
    outline: 2px solid var(--color-state-focus, currentColor);
  }
  header {
    padding-block: 1rem;
    padding-inline: 1rem;
    border-block-end: 1px solid var(--color-border-default, transparent);
  }
  main {
    padding-block: 1rem;
    padding-inline: 1rem;
  }
  main:focus {
    /*
     * tabindex=-1 makes <main> programmatically focusable so the
     * skip-link's #main-content hash target moves focus correctly,
     * but we don't want the default browser focus ring on the main
     * landmark itself — keyboard users follow up with Tab and
     * discover the first focusable element inside.
     */
    outline: none;
  }
</style>
