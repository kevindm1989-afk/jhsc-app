<script>
  /**
   * /help — static page summarizing the conventions the worker-hub
   * register surfaces use: keyboard shortcuts, URL sharing, CSV
   * export semantics, and the monthly /report.
   *
   * Pairs with the KeyboardShortcuts modal (press "?" anywhere) — the
   * modal gives in-context recall, this page gives a permanent URL
   * the team can link to. Both read the same i18n keys so they stay
   * in sync.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';

  const SHORTCUT_ROWS = /** @type {const} */ ([
    { key: 'slash', i18nKey: 'search' },
    { key: 'question', i18nKey: 'shortcuts' },
    { key: 'escape', i18nKey: 'escape' },
    { key: 'j', i18nKey: 'report_prev' },
    { key: 'k', i18nKey: 'report_next' }
  ]);
</script>

<svelte:head>
  <title>{t('common.helpPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card help-page" data-testid="help-page">
  <header class="help-header">
    <h1>{t('common.helpPage.heading')}</h1>
    <p class="muted">{t('common.helpPage.intro')}</p>
  </header>

  <h2>{t('common.helpPage.shortcuts_heading')}</h2>
  <dl class="help-shortcuts" data-testid="help-shortcuts">
    {#each SHORTCUT_ROWS as r (r.key)}
      <div class="help-shortcut-row" data-key={r.key}>
        <dt><kbd>{t(`common.keyboardShortcuts.key.${r.key}`)}</kbd></dt>
        <dd>{t(`common.keyboardShortcuts.rows.${r.i18nKey}`)}</dd>
      </div>
    {/each}
  </dl>

  <h2>{t('common.helpPage.urls_heading')}</h2>
  <p>{t('common.helpPage.urls_body')}</p>

  <h2>{t('common.helpPage.csv_heading')}</h2>
  <p>{t('common.helpPage.csv_body')}</p>

  <h2>{t('common.helpPage.report_heading')}</h2>
  <p>{t('common.helpPage.report_body')}</p>

  <p class="help-footer" data-print="hide">
    <a href="/" data-testid="help-back-to-home">{t('common.helpPage.back_to_home_cta')}</a>
  </p>
</section>

<style>
  .help-page {
    margin-block-start: 1rem;
  }
  .help-header {
    margin-block-end: 0.75rem;
  }
  .help-header h1 {
    margin-block: 0 0.25rem;
  }
  .help-page h2 {
    margin-block: 1rem 0.5rem;
    font-size: 1rem;
  }
  .help-page p {
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .help-shortcuts {
    margin: 0 0 0.5rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
    display: grid;
    gap: 0.375rem;
  }
  .help-shortcut-row {
    display: grid;
    grid-template-columns: 4rem 1fr;
    align-items: baseline;
    gap: 0.75rem;
  }
  .help-shortcut-row dt {
    margin: 0;
  }
  .help-shortcut-row dd {
    margin: 0;
    font-size: 0.875rem;
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    padding: 0.125rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-muted);
    color: var(--color-fg);
  }
  .help-footer {
    margin-block-start: 1rem;
  }
</style>
