<script>
  /**
   * /report — monthly committee report.
   *
   * Aggregates row counts across every register for a chosen month
   * (`?month=YYYY-MM`, default = current month). Shows per-register
   * totals plus two targeted breakdowns: concerns by severity and
   * recommendations by status.
   *
   * Prev/Next links shift the month by one. Each total tile is a
   * deep link into the matching register surface — so a worker
   * looking at "12 concerns filed in 2026-05" can click through to
   * the concerns viewer directly.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import { buildMonthlyReport, shiftMonth, toMonthString } from '$lib/report/aggregate';
  import { buildHref } from '$lib/ui/url-state';

  $: monthParam = $page.url.searchParams.get('month');
  $: month =
    monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : toMonthString(new Date());
  $: report = buildMonthlyReport(month);

  $: prevHref = buildHref('/report', {}, { month: shiftMonth(month, -1) });
  $: nextHref = buildHref('/report', {}, { month: shiftMonth(month, 1) });

  const REGISTERS = /** @type {const} */ ([
    { key: 'concerns', href: '/concerns', label: 'concerns' },
    { key: 'recommendations', href: '/recommendations', label: 'recommendations' },
    { key: 'workRefusals', href: '/work-refusal', label: 'work_refusals' },
    { key: 's51Evidence', href: '/s51-evidence', label: 's51_evidence' },
    { key: 'reprisal', href: '/reprisal', label: 'reprisal' },
    { key: 'minutes', href: '/minutes', label: 'minutes' },
    { key: 'inspections', href: '/inspections', label: 'inspections' },
    { key: 'training', href: '/training', label: 'training' }
  ]);

  const SEVERITY_KEYS = /** @type {const} */ (['critical', 'high', 'medium', 'low']);
  const REC_STATUS_KEYS = /** @type {const} */ (['overdue', 'pending', 'responded', 'archived']);
</script>

<svelte:head>
  <title>{t('report.page.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card report-card" data-testid="report-page">
  <header class="report-header">
    <h1>{t('report.page.heading')}</h1>
    <p class="muted">{t('report.page.intro')}</p>
  </header>

  <nav class="report-month-nav" aria-label={t('report.page.month_nav_aria')} data-print="hide">
    <a href={prevHref} class="report-month-link" data-testid="report-prev-month">
      {t('report.page.prev_month')}
    </a>
    <span class="report-month-label" data-testid="report-month">{month}</span>
    <a href={nextHref} class="report-month-link" data-testid="report-next-month">
      {t('report.page.next_month')}
    </a>
  </nav>

  <h2>{t('report.page.totals_heading')}</h2>
  <ul class="report-tiles" data-testid="report-tiles">
    {#each REGISTERS as r (r.key)}
      <li>
        <a href={r.href} class="report-tile" data-testid="report-tile" data-key={r.key}>
          <span class="report-tile-count" data-testid="report-tile-count"
            >{report.totals[r.key]}</span
          >
          <span class="report-tile-label">{t(`report.page.tile.${r.label}`)}</span>
        </a>
      </li>
    {/each}
  </ul>

  <h2>{t('report.page.concerns_severity_heading')}</h2>
  <ul class="report-breakdown" data-testid="report-concerns-severity">
    {#each SEVERITY_KEYS as sev (sev)}
      <li class="report-breakdown-row">
        <span class="report-breakdown-key">{t(`concern.viewer.severity.${sev}`)}</span>
        <span class="report-breakdown-count" data-testid="report-severity-count" data-key={sev}
          >{report.concernsBySeverity[sev]}</span
        >
      </li>
    {/each}
  </ul>

  <h2>{t('report.page.recs_status_heading')}</h2>
  <ul class="report-breakdown" data-testid="report-recs-status">
    {#each REC_STATUS_KEYS as st (st)}
      <li class="report-breakdown-row">
        <span class="report-breakdown-key">{t(`recommendations.viewer.status.${st}`)}</span>
        <span class="report-breakdown-count" data-testid="report-status-count" data-key={st}
          >{report.recommendationsByStatus[st]}</span
        >
      </li>
    {/each}
  </ul>

  <p class="muted report-demo-note" data-testid="report-demo-note">
    {t('report.page.demo_note')}
  </p>
  <p class="report-footer" data-print="hide">
    <a href="/" data-testid="report-back-to-home">{t('report.page.back_to_home_cta')}</a>
  </p>
</section>

<style>
  .report-card {
    margin-block-start: 1rem;
  }
  .report-header {
    margin-block-end: 0.75rem;
  }
  .report-header h1 {
    margin-block: 0 0.25rem;
  }

  .report-month-nav {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-block-end: 1rem;
  }
  .report-month-label {
    font-family: var(--font-mono);
    font-size: 0.9375rem;
    font-weight: 600;
  }
  .report-month-link {
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-size: 0.8125rem;
    text-decoration: none;
  }
  .report-month-link:hover {
    background: var(--color-muted);
    text-decoration: none;
  }

  .report-tiles {
    list-style: none;
    padding: 0;
    margin: 0 0 1rem;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
    gap: 0.5rem;
  }
  .report-tile {
    display: grid;
    gap: 0.125rem;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    text-decoration: none;
  }
  .report-tile:hover {
    background: var(--color-muted);
    text-decoration: none;
  }
  .report-tile-count {
    font-family: var(--font-mono);
    font-size: 1.25rem;
    font-weight: 700;
  }
  .report-tile-label {
    font-size: 0.6875rem;
    color: var(--color-fg-muted);
  }

  .report-breakdown {
    list-style: none;
    padding: 0;
    margin: 0 0 1rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
    overflow: hidden;
  }
  .report-breakdown-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 0.5rem 0.875rem;
  }
  .report-breakdown-row + .report-breakdown-row {
    border-block-start: 1px solid var(--color-border);
  }
  .report-breakdown-key {
    font-size: 0.8125rem;
  }
  .report-breakdown-count {
    font-family: var(--font-mono);
    font-size: 0.875rem;
    font-weight: 600;
  }

  .report-demo-note {
    margin-block: 1rem 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .report-footer {
    margin-block-start: 0.75rem;
  }
</style>
