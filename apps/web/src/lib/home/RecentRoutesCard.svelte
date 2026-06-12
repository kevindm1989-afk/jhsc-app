<script>
  /**
   * RecentRoutesCard — signed-in landing-page card listing the worker's
   * most-recently-visited routes as quick-jump chips.
   *
   * Reads listRecentRoutes() from $lib/nav/recent-routes (a per-device
   * localStorage store the root layout writes to on every navigation).
   * Hides itself when the history is empty — fresh devices stay
   * uncluttered. Carries `data-print="hide"`.
   *
   * Each chip shows the route + a relative "visited" stamp ("just
   * now", "2 h ago", "Jun 10, 2026"). Tap navigates straight to
   * that route.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { clearRecentRoutes, listRecentRoutes } from '$lib/nav/recent-routes';
  import { formatDateShort } from '$lib/ui/date-format';

  /** @type {import('$lib/nav/recent-routes').RecentRoute[]} */
  let entries = [];

  function refresh() {
    entries = listRecentRoutes();
  }

  function onClear() {
    clearRecentRoutes();
    refresh();
  }

  /**
   * Format an ISO timestamp as a relative "since" stamp. Tiny: we
   * surface "just now", "Nh ago", or fall back to the locale date
   * for anything older than 24 hours. Worker doesn't need second-
   * level precision for "where was I working" navigation.
   *
   * @param {string} iso
   */
  function relativeStamp(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    const deltaMs = Date.now() - d.getTime();
    const minutes = Math.floor(deltaMs / 60_000);
    if (minutes < 1) return t('home.recentRoutes.just_now');
    if (minutes < 60) return t('home.recentRoutes.minutes_ago', { n: String(minutes) });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('home.recentRoutes.hours_ago', { n: String(hours) });
    return formatDateShort(d);
  }

  onMount(() => {
    refresh();
  });
</script>

{#if entries.length > 0}
  <section
    class="rrc"
    aria-labelledby="rrc-heading"
    data-testid="home-recent-routes"
    data-print="hide"
  >
    <header class="rrc-header">
      <h2 id="rrc-heading">{t('home.recentRoutes.heading')}</h2>
      <button
        type="button"
        class="rrc-clear"
        data-testid="home-recent-routes-clear"
        on:click={onClear}
      >
        {t('home.recentRoutes.clear')}
      </button>
    </header>
    <ul class="rrc-list" data-testid="home-recent-routes-list">
      {#each entries as e (e.route)}
        <li>
          <a
            href={e.route}
            class="rrc-chip"
            data-testid="home-recent-route-chip"
            data-route={e.route}
          >
            <span class="rrc-chip-route">{e.route}</span>
            <span class="rrc-chip-when" data-testid="home-recent-route-when"
              >{relativeStamp(e.visitedAt)}</span
            >
          </a>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .rrc {
    display: block;
    margin-block-start: 1rem;
  }
  .rrc-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-block-end: 0.5rem;
  }
  .rrc-header h2 {
    margin: 0;
    font-size: 1rem;
  }
  .rrc-clear {
    background: transparent;
    border: none;
    color: var(--color-fg-muted);
    font-size: 0.75rem;
    cursor: pointer;
    padding: 0.125rem 0.25rem;
    border-radius: var(--radius-sm);
  }
  .rrc-clear:hover {
    color: var(--color-fg);
    background: var(--color-muted);
  }
  .rrc-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .rrc-chip {
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
  .rrc-chip:hover {
    background: var(--color-muted);
    text-decoration: none;
  }
  .rrc-chip-route {
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .rrc-chip-when {
    font-size: 0.6875rem;
    color: var(--color-fg-muted);
  }
</style>
