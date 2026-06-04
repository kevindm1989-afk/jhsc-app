<script lang="ts">
  /**
   * Mobile bottom tab bar — worker-hub's primary-nav-on-mobile pattern,
   * hidden at the `md` breakpoint where the top bar's inline nav suffices.
   * Fixed to the bottom with safe-area padding for notched devices.
   *
   * The destinations mirror the top-bar nav (auth-state aware): Home is
   * always present; the second tab is Settings when signed in, Sign in
   * otherwise. Labels resolve via t(); the active tab is marked with
   * aria-current="page".
   *
   * Placed AFTER the <header> nav in the layout DOM so the header's
   * primary-nav landmark remains the first <nav> (the layout contract the
   * route tests pin). `data-print="hide"` keeps it off evidence-grade
   * printouts.
   */
  import { page } from '$app/stores';
  import { isSignedIn } from '$lib/auth/session-jwt-svelte';
  import { t } from '$lib/i18n';
  import Icon from './Icon.svelte';

  $: path = $page.url.pathname;
</script>

<nav
  class="tabbar"
  aria-label={t('common.nav.aria_label')}
  data-testid="mobile-tab-bar"
  data-print="hide"
>
  <a
    href="/"
    class="tab"
    class:active={path === '/'}
    aria-current={path === '/' ? 'page' : undefined}
    data-testid="tab-home"
  >
    <Icon name="home" size={20} strokeWidth={path === '/' ? 2.25 : 2} />
    <span>{t('common.nav.home')}</span>
  </a>

  {#if $isSignedIn}
    <a
      href="/concerns"
      class="tab"
      class:active={path === '/concerns'}
      aria-current={path === '/concerns' ? 'page' : undefined}
      data-testid="tab-concerns"
    >
      <Icon name="clipboard-list" size={20} strokeWidth={path === '/concerns' ? 2.25 : 2} />
      <span>{t('common.header.concerns_link')}</span>
    </a>
    <a
      href="/reprisal"
      class="tab"
      class:active={path === '/reprisal'}
      aria-current={path === '/reprisal' ? 'page' : undefined}
      data-testid="tab-reprisal"
    >
      <Icon name="shield-alert" size={20} strokeWidth={path === '/reprisal' ? 2.25 : 2} />
      <span>{t('common.header.reprisal_link')}</span>
    </a>
    <a
      href="/settings"
      class="tab"
      class:active={path === '/settings'}
      aria-current={path === '/settings' ? 'page' : undefined}
      data-testid="tab-settings"
    >
      <Icon name="settings" size={20} strokeWidth={path === '/settings' ? 2.25 : 2} />
      <span>{t('common.header.settings_link')}</span>
    </a>
  {:else}
    <a
      href="/sign-in"
      class="tab"
      class:active={path === '/sign-in'}
      aria-current={path === '/sign-in' ? 'page' : undefined}
      data-testid="tab-sign-in"
    >
      <Icon name="key" size={20} strokeWidth={path === '/sign-in' ? 2.25 : 2} />
      <span>{t('common.header.sign_in_link')}</span>
    </a>
  {/if}
</nav>

<style>
  .tabbar {
    position: fixed;
    inset-inline: 0;
    inset-block-end: 0;
    z-index: 30;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    border-block-start: 1px solid var(--color-border);
    background: var(--color-bg-elevated);
    padding-block-end: env(safe-area-inset-bottom);
  }
  /* Top bar carries the nav at md+, so the bottom bar is mobile-only. */
  @media (min-width: 768px) {
    .tabbar {
      display: none;
    }
  }
  .tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    min-height: 3.5rem;
    padding-block: 0.5rem;
    color: var(--color-fg-muted);
    text-decoration: none;
    font-size: 0.6875rem;
    font-weight: 500;
    letter-spacing: -0.01em;
    transition: color 150ms ease;
  }
  .tab.active {
    color: var(--color-fg);
    font-weight: 600;
  }
</style>
