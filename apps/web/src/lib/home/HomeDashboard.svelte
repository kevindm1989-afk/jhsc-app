<script>
  /**
   * HomeDashboard — signed-in landing-page tiles.
   *
   * Renders the cross-register "needs attention" digest computed by
   * `buildHomeSummary`. Each tile is a tinted card with a count + a
   * label + a deep link to the corresponding register surface, so a
   * worker can land on `/` and see the open work at a glance.
   *
   * Severity tier (per tile):
   *   - openConcerns          — blue (info)
   *   - overdueRecommendations — red (overdue → escalated)
   *   - expiredTraining        — red (lapsed certifications)
   *   - activeRefusals         — amber (in progress, attention)
   *   - preservingScenes       — red (s. 51(2) 48-hour window live)
   *
   * Zero counts dim to neutral so they don't read as urgent.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';

  /** @type {import('./home-summary').HomeSummary} */
  export let summary;
</script>

<section class="hd-section" aria-labelledby="hd-heading" data-testid="home-dashboard">
  <header class="hd-header">
    <h2 id="hd-heading">{t('home.dashboard.heading')}</h2>
    <p class="muted">{t('home.dashboard.intro')}</p>
  </header>

  <ul class="hd-grid" data-testid="hd-grid">
    <li>
      <a
        href="/concerns"
        class="hd-tile"
        class:active={summary.openConcerns > 0}
        class:tone-blue={summary.openConcerns > 0}
        data-testid="hd-tile-concerns"
        data-active={summary.openConcerns > 0}
      >
        <span class="hd-count" data-testid="hd-count-concerns">{summary.openConcerns}</span>
        <span class="hd-label">{t('home.dashboard.tile.open_concerns')}</span>
      </a>
    </li>
    <li>
      <a
        href="/recommendations"
        class="hd-tile"
        class:active={summary.overdueRecommendations > 0}
        class:tone-red={summary.overdueRecommendations > 0}
        data-testid="hd-tile-recommendations"
        data-active={summary.overdueRecommendations > 0}
      >
        <span class="hd-count" data-testid="hd-count-recommendations"
          >{summary.overdueRecommendations}</span
        >
        <span class="hd-label">{t('home.dashboard.tile.overdue_recommendations')}</span>
      </a>
    </li>
    <li>
      <a
        href="/training"
        class="hd-tile"
        class:active={summary.expiredTraining > 0}
        class:tone-red={summary.expiredTraining > 0}
        data-testid="hd-tile-training"
        data-active={summary.expiredTraining > 0}
      >
        <span class="hd-count" data-testid="hd-count-training">{summary.expiredTraining}</span>
        <span class="hd-label">{t('home.dashboard.tile.expired_training')}</span>
      </a>
    </li>
    <li>
      <a
        href="/work-refusal"
        class="hd-tile"
        class:active={summary.activeRefusals > 0}
        class:tone-amber={summary.activeRefusals > 0}
        data-testid="hd-tile-work-refusal"
        data-active={summary.activeRefusals > 0}
      >
        <span class="hd-count" data-testid="hd-count-work-refusal">{summary.activeRefusals}</span>
        <span class="hd-label">{t('home.dashboard.tile.active_refusals')}</span>
      </a>
    </li>
    <li>
      <a
        href="/s51-evidence"
        class="hd-tile"
        class:active={summary.preservingScenes > 0}
        class:tone-red={summary.preservingScenes > 0}
        data-testid="hd-tile-s51"
        data-active={summary.preservingScenes > 0}
      >
        <span class="hd-count" data-testid="hd-count-s51">{summary.preservingScenes}</span>
        <span class="hd-label">{t('home.dashboard.tile.preserving_scenes')}</span>
      </a>
    </li>
  </ul>

  <p class="hd-more">
    <a href="/more" data-testid="hd-more-link">{t('home.dashboard.see_all_cta')}</a>
  </p>
</section>

<style>
  .hd-section {
    display: block;
    margin-block-start: 1rem;
  }
  .hd-header {
    margin-block-end: 0.75rem;
  }
  .hd-header h2 {
    margin-block: 0 0.25rem;
  }

  .hd-grid {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0.5rem;
  }
  .hd-tile {
    display: grid;
    grid-template-rows: auto 1fr;
    gap: 0.25rem;
    padding: 0.875rem 0.875rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    text-decoration: none;
    min-height: 4.5rem;
    transition:
      background-color 150ms ease,
      border-color 150ms ease;
  }
  .hd-tile:hover {
    background: var(--color-muted);
    text-decoration: none;
  }
  /* Tone classes are only applied when the count is > 0, so a zero
     tile always reads neutral (no false urgency). */
  .hd-tile.tone-blue {
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    border-color: var(--color-tint-blue-border);
  }
  .hd-tile.tone-amber {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-color: var(--color-tint-amber-border);
  }
  .hd-tile.tone-red {
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-color: var(--color-tint-red-border);
  }
  .hd-count {
    font-family: var(--font-mono);
    font-size: 1.5rem;
    font-weight: 700;
    line-height: 1.1;
  }
  .hd-label {
    font-size: 0.75rem;
    line-height: 1.3;
  }
  .hd-tile:not(.active) .hd-label {
    color: var(--color-fg-muted);
  }
  .hd-tile:not(.active) .hd-count {
    color: var(--color-fg-muted);
  }

  .hd-more {
    margin-block-start: 0.75rem;
  }
</style>
