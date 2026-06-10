<script>
  /**
   * FilterBanner — visible banner shown above a register viewer when
   * the URL carries a `?filter` query param that narrows the dataset.
   *
   * Worker lands at `/concerns?filter=open` (e.g. by clicking the
   * "Open concerns" tile on the home dashboard). The route page
   * applies the predicate to the demo provider AND mounts this banner
   * so the worker reads "Filtered: Open concerns · Clear filter"
   * before the rows paint. The banner's "Clear filter" link drops the
   * query param so the full register comes back.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';

  /** Human-readable label of the active filter, e.g. "Open" or "Overdue". */
  export let label;

  /** Href to clear the filter (typically the bare route path). */
  export let clearHref;
</script>

<aside class="fb-banner" data-testid="filter-banner" role="status" data-print="hide">
  <span class="fb-label">
    <strong>{t('common.filterBanner.filtered_label')}:</strong>
    {label}
  </span>
  <a href={clearHref} class="fb-clear" data-testid="filter-banner-clear">
    {t('common.filterBanner.clear_cta')}
  </a>
</aside>

<style>
  .fb-banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    margin-block: 0.75rem;
    padding: 0.5rem 0.875rem;
    border: 1px solid var(--color-tint-blue-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    font-size: 0.8125rem;
  }
  .fb-label strong {
    font-weight: 600;
    margin-inline-end: 0.25rem;
  }
  .fb-clear {
    margin-inline-start: auto;
    font-weight: 600;
  }
</style>
