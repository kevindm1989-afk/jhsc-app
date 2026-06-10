<script>
  /**
   * DateRangeChips — quick-range chip rail for time-series register
   * surfaces (currently /audit; /sensitive-feed can opt in).
   *
   * Renders four chips: All time, Today, Last 7 days, Last 30 days.
   * Each chip composes its href via `buildHref` so other URL params
   * survive. The active chip is determined by `detectQuickRange`
   * against the current `?from=` / `?to=` URL state.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';
  import { buildHref } from './url-state';
  import { detectQuickRange, quickRange } from './date-range';

  /** Route base path, e.g. "/audit". */
  export let baseHref;

  /** Current `?from=` value (or null). */
  export let fromParam = null;

  /** Current `?to=` value (or null). */
  export let toParam = null;

  /** Other URL params to preserve when building the chip links. */
  export let preservedParams = {};

  $: activeRange = detectQuickRange(fromParam, toParam);

  $: rangeChips = [
    {
      label: t('common.dateRange.all_time'),
      value: null,
      from: null,
      to: null
    },
    {
      label: t('common.dateRange.today'),
      value: 'today',
      ...quickRange('today')
    },
    {
      label: t('common.dateRange.last_7_days'),
      value: '7days',
      ...quickRange('7days')
    },
    {
      label: t('common.dateRange.last_30_days'),
      value: '30days',
      ...quickRange('30days')
    }
  ];
</script>

<nav
  class="drc-rail"
  aria-label={t('common.dateRange.aria_label')}
  data-testid="date-range-chips"
  data-print="hide"
>
  {#each rangeChips as chip (chip.value ?? '__all__')}
    {@const isActive = chip.value === activeRange}
    <a
      href={buildHref(baseHref, preservedParams, { from: chip.from, to: chip.to })}
      class="drc-chip"
      class:active={isActive}
      aria-current={isActive ? 'true' : 'false'}
      data-testid="date-range-chip"
      data-value={chip.value ?? ''}
    >
      {chip.label}
    </a>
  {/each}
</nav>

<style>
  .drc-rail {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-block-end: 0.5rem;
  }
  .drc-chip {
    display: inline-flex;
    align-items: center;
    padding: 0.1875rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg-elevated);
    color: var(--color-fg-muted);
    font-size: 0.6875rem;
    font-weight: 500;
    text-decoration: none;
  }
  .drc-chip:hover {
    background: var(--color-muted);
    text-decoration: none;
  }
  .drc-chip.active {
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    border-color: var(--color-tint-blue-border);
    font-weight: 600;
  }
</style>
