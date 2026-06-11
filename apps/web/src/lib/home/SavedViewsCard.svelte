<script>
  /**
   * SavedViewsCard — signed-in landing-page card surfacing the worker's
   * top saved views (any route) as quick-jump chips.
   *
   * When the worker has no saved views the card hides itself, so the
   * front door stays uncluttered for fresh devices. Listens to the
   * window `view:saved` event so newly-bookmarked views appear
   * without a reload.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { hrefForSavedView, listSavedViews } from '$lib/saved-views/saved-views';

  /** Max number of chips shown on the card. */
  const MAX = 6;

  /** @type {import('$lib/saved-views/saved-views').SavedView[]} */
  let views = [];

  function refresh() {
    views = listSavedViews().slice(0, MAX);
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
  <section class="svc" aria-labelledby="svc-heading" data-testid="home-saved-views">
    <header class="svc-header">
      <h2 id="svc-heading">{t('home.savedViews.heading')}</h2>
      <a href="/saved-views" class="svc-manage" data-testid="home-saved-views-manage">
        {t('home.savedViews.manage_link')}
      </a>
    </header>
    <ul class="svc-list" data-testid="home-saved-views-list">
      {#each views as v (v.id)}
        <li>
          <a
            href={hrefForSavedView(v)}
            class="svc-chip"
            data-testid="home-saved-view-chip"
            data-id={v.id}
            data-route={v.route}
          >
            <span class="svc-chip-name">{v.name}</span>
            <span class="svc-chip-route">{v.route}</span>
          </a>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .svc {
    display: block;
    margin-block-start: 1rem;
  }
  .svc-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-block-end: 0.5rem;
  }
  .svc-header h2 {
    margin: 0;
    font-size: 1rem;
  }
  .svc-manage {
    font-size: 0.75rem;
    color: var(--color-fg-muted);
    text-decoration: none;
  }
  .svc-manage:hover {
    color: var(--color-fg);
  }
  .svc-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .svc-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.375rem;
    padding-inline: 0.625rem;
    padding-block: 0.25rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    text-decoration: none;
    font-size: 0.8125rem;
  }
  .svc-chip:hover {
    background: var(--color-muted);
    text-decoration: none;
  }
  .svc-chip-name {
    font-weight: 600;
  }
  .svc-chip-route {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    color: var(--color-fg-muted);
  }
</style>
