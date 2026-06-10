<script>
  /**
   * SortToggle — two-link toggle for switching the register sort
   * direction between Newest-first (the default) and Oldest-first.
   *
   * URL state: clicking "Oldest first" navigates to the same path
   * with `?sort=oldest` set; clicking "Newest first" drops the
   * `sort` param. Every other URL param on the route is preserved.
   *
   * Worker-hub styling: small inline button-style links. The active
   * link picks up the blue tint. `data-print="hide"` keeps it off
   * printouts.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';
  import { buildHref } from './url-state';

  /** Route base path, e.g. "/concerns". */
  export let baseHref;

  /** The currently active sort value, "oldest" or null (= newest). */
  export let activeSort = null;

  /** Other URL params to preserve when building the sort links. */
  export let preservedParams = {};
</script>

<nav
  class="st-rail"
  aria-label={t('common.sortToggle.aria_label')}
  data-testid="sort-toggle"
  data-print="hide"
>
  <a
    href={buildHref(baseHref, preservedParams, { sort: null })}
    class="st-link"
    class:active={activeSort !== 'oldest'}
    aria-current={activeSort !== 'oldest' ? 'true' : 'false'}
    data-testid="sort-link"
    data-value="newest"
  >
    {t('common.sortToggle.newest')}
  </a>
  <a
    href={buildHref(baseHref, preservedParams, { sort: 'oldest' })}
    class="st-link"
    class:active={activeSort === 'oldest'}
    aria-current={activeSort === 'oldest' ? 'true' : 'false'}
    data-testid="sort-link"
    data-value="oldest"
  >
    {t('common.sortToggle.oldest')}
  </a>
</nav>

<style>
  .st-rail {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-block-end: 0.5rem;
  }
  .st-link {
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
  .st-link:hover {
    background: var(--color-muted);
    text-decoration: none;
  }
  .st-link.active {
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    border-color: var(--color-tint-blue-border);
    font-weight: 600;
  }
</style>
