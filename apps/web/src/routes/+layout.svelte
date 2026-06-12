<script lang="ts">
  /**
   * Root layout — app shell.
   *
   * Visual language ported from jhsc-worker-hub: a sticky top bar carrying
   * the brand mark, the primary nav, and the theme toggle, with a mobile
   * bottom tab bar for primary navigation (hidden at md+). Colours come from
   * the `--color-*` tokens defined in app.html and consumed via app.css —
   * no raw values here (verify-tokens gate).
   *
   * The header nav structure (skip-link → <header> → <nav> with the home +
   * conditional settings/sign-in links → <main id="main-content">) is the
   * pinned accessibility + JWT-reactive contract from the route tests; it is
   * preserved verbatim and only restyled.
   *
   * Token consumption convention: components read colour/spacing from CSS
   * variables, never hard-coded literals (scripts/verify-tokens.sh).
   * Reduced-motion: the boot stylesheet in app.html zeros transition
   * durations when prefers-reduced-motion: reduce.
   *
   * Header sign-in indicator reads `$isSignedIn` from the Svelte readable
   * wrapper over session-jwt-store; cross-tab sync propagates naturally.
   */
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { tokens } from '$lib/tokens';
  import { t } from '$lib/i18n';
  import { setupSafetyHandlers } from '$lib/feature-flags';
  import { isSignedIn } from '$lib/auth/session-jwt-svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import ThemeToggle from '$lib/ui/ThemeToggle.svelte';
  import BottomTabBar from '$lib/ui/BottomTabBar.svelte';
  import HeaderSearch from '$lib/ui/HeaderSearch.svelte';
  import KeyboardShortcuts from '$lib/ui/KeyboardShortcuts.svelte';
  import PrintGeneratedAt from '$lib/ui/PrintGeneratedAt.svelte';
  import { recordRouteVisit } from '$lib/nav/recent-routes';
  import '../app.css';

  // Trigger feature-flag setup (no-op at scaffold; T-feature-flag wires).
  onMount(() => {
    setupSafetyHandlers();
  });

  // Reference tokens module so the bundler keeps the import. Suppress the
  // unused-variable warning without disabling lint globally.
  const _accent = tokens.color.state.danger;
  void _accent;

  // `aria-current="page"` annotation for the header nav: reads
  // `$page.url.pathname` — SvelteKit's page store is reactive across route
  // changes so navigation updates the annotation without a page reload.
  $: currentPath = $page.url.pathname;
  // Record every signed-in route navigation into the recent-routes
  // store so the HomeDashboard RecentRoutesCard can surface them
  // as quick-jump chips. The recorder filters its own ignored list
  // (Home, /search, /more, /saved-views, /help, account / auth pages).
  $: if (typeof window !== 'undefined' && currentPath) recordRouteVisit(currentPath);
  // `as const` narrows the literal so svelte-check's aria-current attribute
  // type (a closed union of 'page' | 'step' | … | undefined) accepts it.
  $: ariaCurrentHome = currentPath === '/' ? ('page' as const) : undefined;
  $: ariaCurrentSettings = currentPath === '/settings' ? ('page' as const) : undefined;
  $: ariaCurrentSignIn = currentPath === '/sign-in' ? ('page' as const) : undefined;
  $: ariaCurrentConcerns = currentPath === '/concerns' ? ('page' as const) : undefined;
  $: ariaCurrentReprisal = currentPath === '/reprisal' ? ('page' as const) : undefined;
  $: ariaCurrentMore = currentPath === '/more' ? ('page' as const) : undefined;
</script>

<a class="skip-link" href="#main-content" data-testid="skip-to-content">
  {t('common.actions.skip_to_content')}
</a>

<header>
  <div class="topbar">
    <span class="brand-mark" aria-hidden="true">
      <Icon name="shield" size={16} strokeWidth={2.25} />
    </span>
    <!--
      `<nav aria-label="Primary">` adds a landmark so screen readers can
      discover the header's top-level navigation. The home link + the
      conditional sign-in/Settings link sit inside it.
    -->
    <nav
      aria-label={t('common.header.primary_nav_aria_label')}
      class="topnav"
      data-testid="header-primary-nav"
    >
      <a href="/" aria-current={ariaCurrentHome} data-testid="header-home-link">
        <strong>{t('common.app_name')}</strong>
      </a>
      {#if $isSignedIn}
        <a
          href="/concerns"
          aria-current={ariaCurrentConcerns}
          data-testid="header-concerns-link"
          class="navlink">{t('common.header.concerns_link')}</a
        >
        <a
          href="/reprisal"
          aria-current={ariaCurrentReprisal}
          data-testid="header-reprisal-link"
          class="navlink">{t('common.header.reprisal_link')}</a
        >
        <a
          href="/more"
          aria-current={ariaCurrentMore}
          data-testid="header-more-link"
          class="navlink">{t('common.header.more_link')}</a
        >
        <a
          href="/settings"
          aria-current={ariaCurrentSettings}
          data-testid="header-settings-link"
          class="navlink">{t('common.header.settings_link')}</a
        >
      {:else}
        <a
          href="/sign-in"
          aria-current={ariaCurrentSignIn}
          data-testid="header-sign-in-link"
          class="navlink">{t('common.header.sign_in_link')}</a
        >
      {/if}
    </nav>
    <div class="topbar-actions">
      {#if $isSignedIn}
        <HeaderSearch />
      {/if}
      <ThemeToggle />
    </div>
  </div>
</header>

<main id="main-content" tabindex="-1">
  <div class="container">
    <slot />
    <PrintGeneratedAt />
  </div>
</main>

<BottomTabBar />

<KeyboardShortcuts />

<style>
  /*
   * The skip-to-content link is visually hidden by default and revealed on
   * keyboard focus (WCAG 2.1.1 / 2.4.1). Off-screen positioning (not
   * display:none) keeps it focusable. Colours via tokens.
   */
  .skip-link {
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: 0;
    transform: translateY(-100%);
    padding-block: 0.5rem;
    padding-inline: 1rem;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    border-radius: var(--radius-sm);
    z-index: 1000;
  }
  .skip-link:focus {
    transform: translateY(0);
    outline: 2px solid var(--color-focus-inner);
    box-shadow: 0 0 0 4px var(--color-focus-outer);
  }
  main:focus {
    /* tabindex=-1 makes <main> programmatically focusable for the skip-link
       target; suppress the default ring on the landmark itself. */
    outline: none;
  }
</style>
