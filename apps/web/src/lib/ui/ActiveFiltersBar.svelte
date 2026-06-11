<script>
  /**
   * ActiveFiltersBar — pills summarizing every active filter axis with
   * a one-click remove on each, plus a "Clear all" pill that returns
   * to the bare route.
   *
   * Each register surface composes several filter axes into one URL
   * (filter, severity, hazard, sort, from, to, …). The existing
   * FilterChipsRail covers per-axis swap, but until now there has been
   * no single affordance that summarizes what's actively filtered or
   * resets every axis at once. ActiveFiltersBar fills that gap.
   *
   * Props:
   *   - baseHref:  the bare route path (e.g. '/concerns')
   *   - filters:   array of { key, label, removeHref } describing each
   *                 active axis. Empty array → component renders
   *                 nothing (no chrome when nothing is filtered).
   *
   * The route page is responsible for computing the filter list — the
   * component itself stays presentation-only, so it composes cleanly
   * with whatever multi-axis schema each surface uses.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';

  /** @type {string} */
  export let baseHref;

  /**
   * Active-filter descriptors. Each entry contributes one pill.
   * `removeHref` is the URL the × button navigates to (i.e. the same
   * URL minus that one axis).
   *
   * @type {Array<{ key: string, label: string, removeHref: string }>}
   */
  export let filters = [];
</script>

{#if filters.length > 0}
  <div
    class="afb"
    role="region"
    aria-label={t('common.activeFilters.region_aria')}
    data-testid="active-filters-bar"
    data-print="hide"
  >
    <span class="afb-label">{t('common.activeFilters.label')}</span>
    <ul class="afb-pills" data-testid="active-filters-pills">
      {#each filters as f (f.key)}
        <li class="afb-pill" data-testid="active-filter-pill" data-key={f.key}>
          <span class="afb-pill-label">{f.label}</span>
          <a
            href={f.removeHref}
            class="afb-pill-remove"
            aria-label={t('common.activeFilters.remove_aria', { label: f.label })}
            data-testid="active-filter-remove"
            data-key={f.key}
          >
            ×
          </a>
        </li>
      {/each}
      <li>
        <a href={baseHref} class="afb-clear-all" data-testid="active-filters-clear-all">
          {t('common.activeFilters.clear_all')}
        </a>
      </li>
    </ul>
  </div>
{/if}

<style>
  .afb {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin-block-end: 0.5rem;
  }
  .afb-label {
    font-size: 0.75rem;
    color: var(--color-fg-muted);
  }
  .afb-pills {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .afb-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding-inline: 0.5rem;
    padding-block: 0.125rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-bg-elevated);
    font-size: 0.75rem;
  }
  .afb-pill-label {
    color: var(--color-fg);
  }
  .afb-pill-remove {
    color: var(--color-fg-muted);
    text-decoration: none;
    font-size: 1rem;
    line-height: 1;
    padding-inline: 0.125rem;
    border-radius: var(--radius-sm);
  }
  .afb-pill-remove:hover {
    color: var(--color-fg);
    background: var(--color-muted);
    text-decoration: none;
  }
  .afb-clear-all {
    display: inline-block;
    padding-inline: 0.625rem;
    padding-block: 0.125rem;
    border: 1px dashed var(--color-border);
    border-radius: 999px;
    color: var(--color-fg-muted);
    font-size: 0.75rem;
    text-decoration: none;
  }
  .afb-clear-all:hover {
    color: var(--color-fg);
    background: var(--color-muted);
    text-decoration: none;
  }
</style>
