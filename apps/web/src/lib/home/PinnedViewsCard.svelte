<script>
  /**
   * PinnedViewsCard — signed-in landing-page card listing the worker's
   * pinned saved views as quick-jump chips.
   *
   * Promotes a curated subset of /saved-views onto the dashboard so
   * the worker can land back into their canonical filtered surfaces
   * with one click. Pinning is per-device (localStorage) — the same
   * affordance the SavedViewsCard surfaces (every saved view), but
   * narrowed to the views the worker explicitly marked.
   *
   * Visibility rule:
   *   - No pinned views → card renders nothing (no chrome).
   *   - Refreshes live on the window `view:saved` event so a fresh
   *     pin appears without a reload (SaveViewButton fires that
   *     event after add; /saved-views pin toggle also dispatches it).
   *
   * Carries `data-print="hide"` so it stays off paper handouts.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { hrefForSavedView, listPinnedSavedViews } from '$lib/saved-views/saved-views';

  /** @type {import('$lib/saved-views/saved-views').SavedView[]} */
  let views = [];

  function refresh() {
    views = listPinnedSavedViews();
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
</script>

{#if views.length > 0}
  <section
    class="pvc"
    aria-labelledby="pvc-heading"
    data-testid="home-pinned-views"
    data-print="hide"
  >
    <header class="pvc-header">
      <h2 id="pvc-heading">{t('home.pinnedViews.heading')}</h2>
      <a href="/saved-views" class="pvc-manage" data-testid="home-pinned-views-manage">
        {t('home.pinnedViews.manage_link')}
      </a>
    </header>
    <ul class="pvc-list" data-testid="home-pinned-views-list">
      {#each views as v (v.id)}
        <li>
          <a
            href={hrefForSavedView(v)}
            class="pvc-chip"
            data-testid="home-pinned-view-chip"
            data-id={v.id}
            data-route={v.route}
          >
            <span class="pvc-chip-name">{v.name}</span>
            <span class="pvc-chip-route">{v.route}</span>
          </a>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .pvc {
    display: block;
    margin-block-start: 1rem;
  }
  .pvc-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-block-end: 0.5rem;
  }
  .pvc-header h2 {
    margin: 0;
    font-size: 1rem;
  }
  .pvc-manage {
    font-size: 0.75rem;
    color: var(--color-fg-muted);
    text-decoration: none;
  }
  .pvc-manage:hover {
    color: var(--color-fg);
  }
  .pvc-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .pvc-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.375rem;
    padding-inline: 0.625rem;
    padding-block: 0.25rem;
    border: 1px solid var(--color-tint-blue-border);
    border-radius: 999px;
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    text-decoration: none;
    font-size: 0.8125rem;
  }
  .pvc-chip:hover {
    filter: brightness(0.95);
    text-decoration: none;
  }
  .pvc-chip-name {
    font-weight: 600;
  }
  .pvc-chip-route {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    opacity: 0.75;
  }
</style>
