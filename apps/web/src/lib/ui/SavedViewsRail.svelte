<script>
  /**
   * SavedViewsRail — chip rail of the worker's saved views for the
   * current route. Each chip deep-links into that named filtered
   * view via `hrefForSavedView`.
   *
   * Visibility rule:
   *   - When the worker has no saved views for this route the rail
   *     renders nothing — no chrome.
   *   - Listens for the `view:saved` event from SaveViewButton so
   *     newly-saved views appear without a reload.
   *
   * Carries `data-print="hide"` so the rail does not appear in
   * printed register exports.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { hrefForSavedView, listSavedViewsForRoute } from '$lib/saved-views/saved-views';

  /** Route pathname this rail surfaces, e.g. "/concerns". */
  export let route;

  /** @type {import('$lib/saved-views/saved-views').SavedView[]} */
  let views = [];

  function refresh() {
    views = listSavedViewsForRoute(route);
  }

  function onViewSaved() {
    refresh();
  }

  onMount(() => {
    refresh();
    if (typeof window !== 'undefined') {
      window.addEventListener('view:saved', onViewSaved);
      return () => window.removeEventListener('view:saved', onViewSaved);
    }
    return undefined;
  });

  // Refresh when the route prop changes (so navigating between
  // register surfaces keeps the rail in sync without an unmount).
  $: if (route) refresh();
</script>

{#if views.length > 0}
  <nav
    class="svr"
    aria-label={t('common.savedViews.rail_aria')}
    data-testid="saved-views-rail"
    data-print="hide"
  >
    <span class="svr-label">{t('common.savedViews.rail_label')}</span>
    <ul class="svr-chips">
      {#each views as v (v.id)}
        <li>
          <a
            href={hrefForSavedView(v)}
            class="svr-chip"
            data-testid="saved-view-chip"
            data-id={v.id}
          >
            {v.name}
          </a>
        </li>
      {/each}
    </ul>
    <a href="/saved-views" class="svr-manage" data-testid="saved-views-manage-link">
      {t('common.savedViews.manage_link')}
    </a>
  </nav>
{/if}

<style>
  .svr {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin-block-end: 0.5rem;
  }
  .svr-label {
    font-size: 0.75rem;
    color: var(--color-fg-muted);
  }
  .svr-chips {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .svr-chip {
    display: inline-block;
    padding-inline: 0.625rem;
    padding-block: 0.125rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-size: 0.75rem;
    text-decoration: none;
  }
  .svr-chip:hover {
    background: var(--color-muted);
    text-decoration: none;
  }
  .svr-manage {
    font-size: 0.75rem;
    color: var(--color-fg-muted);
    text-decoration: none;
    margin-inline-start: auto;
  }
  .svr-manage:hover {
    color: var(--color-fg);
  }
</style>
