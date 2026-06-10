<script>
  /**
   * RecentActivityCard — compact "what just happened" list for the
   * signed-in home page.
   *
   * Complements the home dashboard tiles (which show open-work
   * COUNTS) by surfacing the TIMELINE dimension — the latest N audit
   * rows so a returning worker reads the front door as both
   * "what's open" + "what just happened" without bouncing through
   * /audit.
   *
   * Renders the rows the route page supplies — typically the first
   * 5 of `buildDemoAuditRows(50)`, but the component is provider-
   * agnostic. Each entry shows timestamp + event_type + actor
   * pseudonym. "See full audit log" link drops to /audit.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';
  import { eventTypeToHref } from './recent-activity-targets';

  /** @type {import('../audit/demo-audit-rows').DemoAuditRow[]} */
  export let rows = [];

  /** @param {string} iso */
  function formatTimestamp(iso) {
    try {
      return iso.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
    } catch {
      return iso;
    }
  }
</script>

<section class="ra-section" aria-labelledby="ra-heading" data-testid="recent-activity">
  <header class="ra-header">
    <h2 id="ra-heading">{t('home.recent.heading')}</h2>
    <p class="muted">{t('home.recent.intro')}</p>
  </header>

  {#if rows.length === 0}
    <p class="muted" role="status" data-testid="ra-empty">{t('home.recent.empty')}</p>
  {:else}
    <ul class="ra-list" data-testid="ra-list">
      {#each rows as row (row.id)}
        <li class="ra-row" data-testid="ra-row">
          <a
            href={eventTypeToHref(row.event_type)}
            class="ra-row-link"
            data-testid="ra-row-link"
            aria-label={t('home.recent.row_aria', {
              event: row.event_type,
              ts: formatTimestamp(row.ts)
            })}
          >
            <time class="ra-ts" data-testid="ra-row-ts">{formatTimestamp(row.ts)}</time>
            <code class="ra-event" data-testid="ra-row-event">{row.event_type}</code>
            <span class="ra-actor-row">
              <span class="ra-actor-key">{t('home.recent.actor_label')}:</span>
              <code class="ra-actor" data-testid="ra-row-actor">{row.actor_pseudonym}</code>
            </span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}

  <p class="ra-more">
    <a href="/audit" data-testid="ra-see-all">{t('home.recent.see_all_cta')}</a>
  </p>
</section>

<style>
  .ra-section {
    display: block;
  }
  .ra-header {
    margin-block-end: 0.5rem;
  }
  .ra-header h2 {
    margin-block: 0 0.25rem;
  }

  .ra-list {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .ra-row {
    display: block;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
  }
  .ra-row + .ra-row {
    border-block-start: 1px solid var(--color-border);
  }
  /* The row itself is a link so a tap anywhere in the row navigates.
     Mirror grid layout the row used to carry. */
  .ra-row-link {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 0.5rem;
    row-gap: 0.125rem;
    padding: 0.625rem 0.875rem;
    color: inherit;
    text-decoration: none;
    transition: background-color 150ms ease;
  }
  .ra-row-link:hover {
    background: var(--color-muted);
    text-decoration: none;
  }
  .ra-ts {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--color-fg-muted);
  }
  .ra-event {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-fg);
    word-break: break-all;
  }
  .ra-actor-row {
    grid-column: 1 / -1;
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
    font-size: 0.6875rem;
  }
  .ra-actor-key {
    color: var(--color-fg-muted);
  }
  .ra-actor {
    font-family: var(--font-mono);
    color: var(--color-fg);
  }

  .ra-more {
    margin-block-start: 0.75rem;
  }
</style>
