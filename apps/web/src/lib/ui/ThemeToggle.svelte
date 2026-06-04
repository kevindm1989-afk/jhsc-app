<script lang="ts">
  /**
   * Theme toggle — cycles light → dark → system (parity with worker-hub's
   * top-bar toggle). Icon-only, 44×44 touch target on mobile (collapses to
   * 36px on wider pointers). Accessible name comes from the catalog via t()
   * and changes with the current state so screen-reader users hear what the
   * next press will do.
   */
  import { theme, cycleTheme } from './theme';
  import { t } from '$lib/i18n';
  import Icon from './Icon.svelte';

  $: icon = $theme === 'light' ? 'sun' : $theme === 'dark' ? 'moon' : 'monitor';
  $: label = t(`common.theme.toggle_${$theme}`);
</script>

<button
  type="button"
  class="theme-toggle"
  aria-label={label}
  title={label}
  on:click={cycleTheme}
  data-testid="theme-toggle"
  data-print="hide"
>
  <Icon name={icon} size={18} />
</button>

<style>
  .theme-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.75rem;
    height: 2.75rem;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-fg-muted);
    cursor: pointer;
    transition:
      background-color 150ms ease,
      color 150ms ease;
  }
  .theme-toggle:hover {
    background: var(--color-muted);
    color: var(--color-fg);
  }
  @media (pointer: fine) {
    .theme-toggle {
      width: 2.25rem;
      height: 2.25rem;
    }
  }
</style>
