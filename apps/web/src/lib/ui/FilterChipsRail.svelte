<script>
  /**
   * FilterChipsRail — clickable chip row for switching the URL filter
   * on a register surface.
   *
   * Each chip is a styled <a> link with `aria-current="page"` on the
   * active one. The route page supplies a `chips` array of
   * `{ href, label, value }` items plus the `activeValue` it derives
   * from `$page.url.searchParams.get('filter')`.
   *
   * Replaces / supplements the URL-typing affordance the FilterBanner
   * provided: workers switch chips with a tap instead of editing the
   * URL or returning to the home dashboard.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';

  /**
   * @type {Array<{
   *   href: string,
   *   label: string,
   *   value: string | null
   * }>}
   * The first chip is conventionally "All" with `value: null` and
   * `href` pointing at the bare route (the clear-filter destination).
   */
  export let chips = [];

  /** The active filter value (null = no filter applied). */
  export let activeValue = null;
</script>

<nav
  class="fcr-rail"
  aria-label={t('common.filterChips.aria_label')}
  data-testid="filter-chips"
  data-print="hide"
>
  <ul class="fcr-list">
    {#each chips as chip (chip.value === null ? '__all__' : chip.value)}
      {@const isActive = chip.value === activeValue}
      <li>
        <a
          href={chip.href}
          class="fcr-chip"
          class:active={isActive}
          aria-current={isActive ? 'page' : 'false'}
          data-testid="filter-chip"
          data-value={chip.value === null ? '' : chip.value}
        >
          {chip.label}
        </a>
      </li>
    {/each}
  </ul>
</nav>

<style>
  .fcr-rail {
    margin-block: 0.5rem 0.75rem;
  }
  .fcr-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .fcr-chip {
    display: inline-flex;
    align-items: center;
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-size: 0.75rem;
    font-weight: 500;
    text-decoration: none;
    transition:
      background-color 150ms ease,
      border-color 150ms ease,
      color 150ms ease;
  }
  .fcr-chip:hover {
    background: var(--color-muted);
    text-decoration: none;
  }
  /* The active chip picks up the worker-hub accent so the current
     filter state reads at a glance even before the rows paint. */
  .fcr-chip.active {
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    border-color: var(--color-tint-blue-border);
    font-weight: 600;
  }
</style>
