<script>
  /**
   * /more — directory of every product surface in the app, grouped by
   * purpose. Bridges the discoverability gap between the small bottom
   * tab bar (4 tabs: Home / Concerns / Reprisal / Settings) and the
   * 11+ placeholder + real surfaces shipped across PRs #133, #136,
   * #137, #138, #139, #140, #141.
   *
   * Each entry is a worker-hub-styled link row with a one-line blurb,
   * grouped into five sections (Field intake / Deliberation / Reference
   * / Monitoring / Account). Surfaces that don't ship a real intake
   * yet land on their existing placeholder route — the launcher just
   * surfaces what's available; the placeholder pages already explain
   * "coming soon".
   *
   * Role visibility is NOT enforced in the markup — every signed-in
   * member sees every link. The actual role-gating (e.g.,
   * /sensitive-feed restricted to worker co-chair + certified member)
   * is enforced by the destination route's content + the server-side
   * RLS / capability checks the eventual production routes will carry.
   * Surfacing the link to a member who can't use it is a deliberate
   * trade-off: a coherent map of the app, with friendly "you don't
   * have access to this yet" feedback once the role-aware routes ship.
   *
   * No nav-link changes in this PR — the launcher exists at /more and
   * is reachable by URL; surfacing it in the tab bar / header is a
   * separate user-driven design call (4 tabs vs add-a-More-tab).
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { listRecentRoutes } from '$lib/nav/recent-routes';

  /** @type {import('$lib/nav/recent-routes').RecentRoute[]} */
  let recentRoutes = [];

  onMount(() => {
    recentRoutes = listRecentRoutes();
  });
</script>

<svelte:head>
  <title>{t('common.morePage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="more-page" data-testid="more-page">
  <header class="more-header">
    <h1>{t('common.morePage.heading')}</h1>
    <p class="muted">{t('common.morePage.intro')}</p>
  </header>

  <p class="more-search">
    <a href="/search" class="cta" data-testid="more-link-search"
      >{t('common.morePage.link_search_cta')}</a
    >
  </p>

  {#if recentRoutes.length > 0}
    <section
      class="card more-recent-routes"
      data-testid="more-recent-routes"
      aria-labelledby="more-recent-routes-heading"
    >
      <h2 id="more-recent-routes-heading">{t('common.morePage.recent_routes_heading')}</h2>
      <ul class="more-recent-routes-list">
        {#each recentRoutes as r (r.route)}
          <li>
            <a
              class="more-recent-route-chip"
              href={r.route}
              data-testid="more-recent-route-chip"
              data-route={r.route}
            >
              {r.route}
            </a>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="card more-group" data-testid="more-group-intake">
    <h2>{t('common.morePage.group_intake_heading')}</h2>
    <p class="muted">{t('common.morePage.group_intake_blurb')}</p>
    <ul class="more-links">
      <li>
        <a href="/concerns" class="more-link" data-testid="more-link-concerns">
          <strong>{t('common.morePage.link_concerns_label')}</strong>
          <span>{t('common.morePage.link_concerns_blurb')}</span>
        </a>
      </li>
      <li>
        <a href="/reprisal" class="more-link" data-testid="more-link-reprisal">
          <strong>{t('common.morePage.link_reprisal_label')}</strong>
          <span>{t('common.morePage.link_reprisal_blurb')}</span>
        </a>
      </li>
      <li>
        <a href="/work-refusal" class="more-link" data-testid="more-link-work-refusal">
          <strong>{t('common.morePage.link_work_refusal_label')}</strong>
          <span>{t('common.morePage.link_work_refusal_blurb')}</span>
        </a>
      </li>
      <li>
        <a href="/s51-evidence" class="more-link" data-testid="more-link-s51">
          <strong>{t('common.morePage.link_s51_label')}</strong>
          <span>{t('common.morePage.link_s51_blurb')}</span>
        </a>
      </li>
      <li>
        <a href="/inspections" class="more-link" data-testid="more-link-inspections">
          <strong>{t('common.morePage.link_inspections_label')}</strong>
          <span>{t('common.morePage.link_inspections_blurb')}</span>
        </a>
      </li>
    </ul>
  </section>

  <section class="card more-group" data-testid="more-group-deliberation">
    <h2>{t('common.morePage.group_deliberation_heading')}</h2>
    <p class="muted">{t('common.morePage.group_deliberation_blurb')}</p>
    <ul class="more-links">
      <li>
        <a href="/minutes" class="more-link" data-testid="more-link-minutes">
          <strong>{t('common.morePage.link_minutes_label')}</strong>
          <span>{t('common.morePage.link_minutes_blurb')}</span>
        </a>
      </li>
      <li>
        <a href="/recommendations" class="more-link" data-testid="more-link-recommendations">
          <strong>{t('common.morePage.link_recommendations_label')}</strong>
          <span>{t('common.morePage.link_recommendations_blurb')}</span>
        </a>
      </li>
    </ul>
  </section>

  <section class="card more-group" data-testid="more-group-reference">
    <h2>{t('common.morePage.group_reference_heading')}</h2>
    <p class="muted">{t('common.morePage.group_reference_blurb')}</p>
    <ul class="more-links">
      <li>
        <a href="/library" class="more-link" data-testid="more-link-library">
          <strong>{t('common.morePage.link_library_label')}</strong>
          <span>{t('common.morePage.link_library_blurb')}</span>
        </a>
      </li>
      <li>
        <a href="/training" class="more-link" data-testid="more-link-training">
          <strong>{t('common.morePage.link_training_label')}</strong>
          <span>{t('common.morePage.link_training_blurb')}</span>
        </a>
      </li>
    </ul>
  </section>

  <section class="card more-group" data-testid="more-group-monitoring">
    <h2>{t('common.morePage.group_monitoring_heading')}</h2>
    <p class="muted">{t('common.morePage.group_monitoring_blurb')}</p>
    <ul class="more-links">
      <li>
        <a href="/audit" class="more-link" data-testid="more-link-audit">
          <strong>{t('common.morePage.link_audit_label')}</strong>
          <span>{t('common.morePage.link_audit_blurb')}</span>
        </a>
      </li>
      <li>
        <a href="/sensitive-feed" class="more-link" data-testid="more-link-sensitive-feed">
          <strong>{t('common.morePage.link_sensitive_feed_label')}</strong>
          <span>{t('common.morePage.link_sensitive_feed_blurb')}</span>
        </a>
      </li>
      <li>
        <a href="/report" class="more-link" data-testid="more-link-report">
          <strong>{t('common.morePage.link_report_label')}</strong>
          <span>{t('common.morePage.link_report_blurb')}</span>
        </a>
      </li>
    </ul>
  </section>

  <section class="card more-group" data-testid="more-group-account">
    <h2>{t('common.morePage.group_account_heading')}</h2>
    <p class="muted">{t('common.morePage.group_account_blurb')}</p>
    <ul class="more-links">
      <li>
        <a href="/settings" class="more-link" data-testid="more-link-settings">
          <strong>{t('common.morePage.link_settings_label')}</strong>
          <span>{t('common.morePage.link_settings_blurb')}</span>
        </a>
      </li>
      <li>
        <a href="/privacy" class="more-link" data-testid="more-link-privacy">
          <strong>{t('common.morePage.link_privacy_label')}</strong>
          <span>{t('common.morePage.link_privacy_blurb')}</span>
        </a>
      </li>
      <li>
        <a href="/help" class="more-link" data-testid="more-link-help">
          <strong>{t('common.morePage.link_help_label')}</strong>
          <span>{t('common.morePage.link_help_blurb')}</span>
        </a>
      </li>
      <li>
        <a href="/saved-views" class="more-link" data-testid="more-link-saved-views">
          <strong>{t('common.morePage.link_saved_views_label')}</strong>
          <span>{t('common.morePage.link_saved_views_blurb')}</span>
        </a>
      </li>
    </ul>
  </section>

  <p class="more-footer">
    <a href="/" data-testid="more-back-to-home">
      {t('common.morePage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .more-page {
    display: block;
    margin-block-start: 1rem;
  }
  .more-header {
    margin-block-end: 1rem;
  }
  .more-group {
    margin-block-end: 1rem;
  }
  .more-group h2 {
    margin-block-start: 0;
  }

  .more-links {
    list-style: none;
    padding: 0;
    margin: 0.75rem 0 0;
    display: grid;
    gap: 0.5rem;
  }
  .more-link {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.125rem;
    padding: 0.75rem 0.875rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    text-decoration: none;
    transition: background-color 150ms ease;
  }
  .more-link:hover {
    background: var(--color-muted);
    text-decoration: none;
  }
  .more-link strong {
    color: var(--color-fg);
    font-weight: 600;
    font-size: 0.9375rem;
  }
  .more-link span {
    color: var(--color-fg-muted);
    font-size: 0.8125rem;
    line-height: 1.4;
  }

  .more-footer {
    margin-block-start: 0.75rem;
  }

  .more-recent-routes {
    margin-block-end: 1rem;
  }
  .more-recent-routes h2 {
    margin-block-start: 0;
    margin-block-end: 0.5rem;
    font-size: 1rem;
  }
  .more-recent-routes-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .more-recent-route-chip {
    display: inline-block;
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    text-decoration: none;
  }
  .more-recent-route-chip:hover {
    background: var(--color-muted);
    text-decoration: none;
  }
</style>
