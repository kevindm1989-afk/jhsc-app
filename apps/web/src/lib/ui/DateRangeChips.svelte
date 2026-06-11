<script>
  /**
   * DateRangeChips — quick-range chip rail + typeable custom range
   * for time-series register surfaces.
   *
   * Renders four chips (All time, Today, Last 7 days, Last 30 days)
   * plus a pair of `<input type="date">` controls + an Apply link
   * for custom YYYY-MM-DD ranges. The Apply link is a plain `<a>` so
   * navigation flows through SvelteKit's router without any
   * imperative `goto` — its `href` is reactively assembled from the
   * inputs' bound values + `preservedParams`.
   *
   * Each chip composes its href via `buildHref` so other URL params
   * survive. The active chip is determined by `detectQuickRange`
   * against the current `?from=` / `?to=` URL state. When the worker
   * is on a custom (non-canonical) range, none of the chips show
   * `active` and the input pair carries the active values.
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

  // Local bindings so the worker can type a custom range without
  // navigating mid-keystroke. The Apply link's href reactively
  // composes the new URL.
  let localFrom = '';
  let localTo = '';
  $: localFrom = fromParam ?? '';
  $: localTo = toParam ?? '';

  $: customApplyHref = buildHref(baseHref, preservedParams, {
    from: localFrom || null,
    to: localTo || null
  });

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

<div
  class="drc-custom"
  aria-label={t('common.dateRange.custom_aria')}
  data-testid="date-range-custom"
  data-print="hide"
>
  <label class="drc-custom-field">
    <span class="drc-custom-label">{t('common.dateRange.custom_from_label')}</span>
    <input
      type="date"
      class="drc-custom-input"
      data-testid="date-range-custom-from"
      bind:value={localFrom}
    />
  </label>
  <label class="drc-custom-field">
    <span class="drc-custom-label">{t('common.dateRange.custom_to_label')}</span>
    <input
      type="date"
      class="drc-custom-input"
      data-testid="date-range-custom-to"
      bind:value={localTo}
    />
  </label>
  <a href={customApplyHref} class="drc-custom-apply" data-testid="date-range-custom-apply">
    {t('common.dateRange.custom_apply')}
  </a>
</div>

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

  .drc-custom {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.375rem;
    margin-block-end: 0.5rem;
  }
  .drc-custom-field {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .drc-custom-label {
    font-size: 0.625rem;
    color: var(--color-fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .drc-custom-input {
    min-height: 1.75rem;
    padding-inline: 0.375rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }
  .drc-custom-apply {
    min-height: 1.75rem;
    display: inline-flex;
    align-items: center;
    padding-inline: 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-size: 0.75rem;
    text-decoration: none;
  }
  .drc-custom-apply:hover {
    background: var(--color-muted);
    text-decoration: none;
  }
</style>
