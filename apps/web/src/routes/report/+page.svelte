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
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { t } from '$lib/i18n';
  import {
    buildMonthlyReport,
    buildTrailingMonths,
    buildYearlyReport,
    reportToCsvRows,
    shiftMonth,
    shiftYear,
    toMonthString,
    toYearString,
    yearlyReportToCsvRows
  } from '$lib/report/aggregate';
  import { buildHref } from '$lib/ui/url-state';
  import CsvDownloadButton from '$lib/ui/CsvDownloadButton.svelte';
  import ShareUrlButton from '$lib/ui/ShareUrlButton.svelte';
  import { toCsv, csvFilename } from '$lib/ui/csv';

  const CSV_FIELDS = /** @type {const} */ (['month', 'section', 'key', 'count']);

  // Mode: "year" (`?year=YYYY`) or "month" (default; `?month=YYYY-MM`).
  // Year wins if both are set so a `?year=YYYY&month=...` URL stays
  // unambiguous.
  $: yearParam = $page.url.searchParams.get('year');
  $: monthParam = $page.url.searchParams.get('month');
  $: isYearView = !!(yearParam && /^\d{4}$/.test(yearParam));
  $: year = yearParam && /^\d{4}$/.test(yearParam) ? yearParam : toYearString(new Date());
  $: month =
    monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : toMonthString(new Date());
  $: report = isYearView ? buildYearlyReport(year) : buildMonthlyReport(month);

  // Year-over-year comparison: when in month mode, also load the same
  // month from a year earlier so each tile can render
  // "(<delta> vs <YYYY-MM>)". Skip in year mode — the existing
  // monthly strip already shows the within-year trend.
  $: priorMonth = isYearView ? null : shiftMonth(month, -12);
  $: priorReport = priorMonth ? buildMonthlyReport(priorMonth) : null;

  // Trailing-12-month series — also month-mode only. Each tile gets a
  // small sparkline showing the per-register totals across the
  // current month and the eleven months before it, oldest first.
  $: trailingMonths = isYearView ? null : buildTrailingMonths(month, 12);
  /**
   * Per-register-key array of integers for the trailing window. Lets
   * each tile render a sparkline without re-iterating the array.
   * @type {Record<string, number[]> | null}
   */
  $: trailingSeries = trailingMonths
    ? Object.fromEntries(REGISTERS.map((r) => [r.key, trailingMonths.map((m) => m.totals[r.key])]))
    : null;

  $: prevHref = isYearView
    ? buildHref('/report', {}, { year: shiftYear(year, -1) })
    : buildHref('/report', {}, { month: shiftMonth(month, -1) });
  $: nextHref = isYearView
    ? buildHref('/report', {}, { year: shiftYear(year, 1) })
    : buildHref('/report', {}, { month: shiftMonth(month, 1) });

  // Mode-toggle hrefs — switching mode preserves nothing (the other
  // mode's URL param is what disambiguates).
  $: toYearViewHref = buildHref('/report', {}, { year: toYearString(new Date()) });
  $: toMonthViewHref = buildHref('/report', {}, { month: toMonthString(new Date()) });

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

  function buildDownload() {
    if (isYearView) {
      const rows = yearlyReportToCsvRows(/** @type {any} */ (report));
      return { csv: toCsv(rows, CSV_FIELDS), filename: csvFilename(`report-${year}`) };
    }
    const rows = reportToCsvRows(/** @type {any} */ (report));
    return { csv: toCsv(rows, CSV_FIELDS), filename: csvFilename(`report-${month}`) };
  }

  /**
   * Tell whether a keystroke originated inside a form field (so the
   * worker can still type literal `j`/`k` while editing).
   * @param {EventTarget | null} target
   */
  function isTypingTarget(target) {
    if (!(target instanceof Element)) return false;
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (target.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  /**
   * `j` / `k` step the report by one month (or one year in year mode).
   * Vim-style — the help page surfaces the bindings via the
   * KeyboardShortcuts modal.
   *
   * @param {KeyboardEvent} e
   */
  function onReportKey(e) {
    if (e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    if (e.key === 'j') {
      e.preventDefault();
      void goto(prevHref, { replaceState: false });
    } else if (e.key === 'k') {
      e.preventDefault();
      void goto(nextHref, { replaceState: false });
    }
  }

  onMount(() => {
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', onReportKey);
    }
  });

  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', onReportKey);
    }
  });
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

  <nav class="report-mode-nav" aria-label={t('report.page.mode_nav_aria')} data-print="hide">
    <a
      href={toMonthViewHref}
      class="report-mode-link"
      class:is-active={!isYearView}
      aria-current={!isYearView ? 'true' : undefined}
      data-testid="report-mode-month"
    >
      {t('report.page.mode_month')}
    </a>
    <a
      href={toYearViewHref}
      class="report-mode-link"
      class:is-active={isYearView}
      aria-current={isYearView ? 'true' : undefined}
      data-testid="report-mode-year"
    >
      {t('report.page.mode_year')}
    </a>
  </nav>

  <nav class="report-month-nav" aria-label={t('report.page.month_nav_aria')} data-print="hide">
    <a href={prevHref} class="report-month-link" data-testid="report-prev-month">
      {isYearView ? t('report.page.prev_year') : t('report.page.prev_month')}
    </a>
    <span class="report-month-label" data-testid="report-month">
      {isYearView ? year : month}
    </span>
    <a href={nextHref} class="report-month-link" data-testid="report-next-month">
      {isYearView ? t('report.page.next_year') : t('report.page.next_month')}
    </a>
  </nav>

  <CsvDownloadButton onClick={buildDownload} />
  <ShareUrlButton />

  <h2>{t('report.page.totals_heading')}</h2>
  <ul class="report-tiles" data-testid="report-tiles">
    {#each REGISTERS as r (r.key)}
      {@const current = report.totals[r.key]}
      {@const prior = priorReport ? priorReport.totals[r.key] : null}
      {@const delta = prior === null ? null : current - prior}
      {@const series = trailingSeries ? trailingSeries[r.key] : null}
      {@const seriesMax = series ? Math.max(1, ...series) : 0}
      <li>
        <a href={r.href} class="report-tile" data-testid="report-tile" data-key={r.key}>
          <span class="report-tile-count" data-testid="report-tile-count">{current}</span>
          <span class="report-tile-label">{t(`report.page.tile.${r.label}`)}</span>
          {#if delta !== null}
            <span
              class="report-tile-yoy"
              class:is-up={delta > 0}
              class:is-down={delta < 0}
              class:is-flat={delta === 0}
              data-testid="report-tile-yoy"
              data-delta={delta}
              title={t('report.page.yoy_tooltip', { month: priorMonth ?? '' })}
            >
              {delta > 0 ? '+' : ''}{delta}
              <span class="report-tile-yoy-suffix">{t('report.page.yoy_vs_label')}</span>
            </span>
          {/if}
          {#if series}
            <!--
              12-bar inline sparkline. SVG viewBox is fixed at 60×12;
              each bar is 4px wide with a 1px gap, normalized to the
              window's max. The aria-label spells out the series so
              screen readers convey the trend; sighted users get the
              visual cue.
            -->
            <svg
              class="report-tile-spark"
              viewBox="0 0 60 12"
              role="img"
              aria-label={t('report.page.sparkline_aria', {
                values: series.join(', ')
              })}
              data-testid="report-tile-spark"
              data-key={r.key}
              focusable="false"
            >
              {#each series as v, i}
                {@const h = seriesMax > 0 ? Math.max(1, Math.round((v / seriesMax) * 12)) : 0}
                <rect
                  x={i * 5}
                  y={12 - h}
                  width="4"
                  height={h}
                  class="report-tile-spark-bar"
                  class:is-current={i === series.length - 1}
                />
              {/each}
            </svg>
          {/if}
        </a>
      </li>
    {/each}
  </ul>

  {#if isYearView}
    <h2>{t('report.page.months_heading')}</h2>
    <ul class="report-month-strip" data-testid="report-month-strip">
      {#each /** @type {any} */ (report).months as m (m.month)}
        <li>
          <a
            href={buildHref('/report', {}, { month: m.month })}
            class="report-month-cell"
            data-testid="report-month-cell"
            data-month={m.month}
          >
            <span class="report-month-cell-month">{m.month}</span>
            <span class="report-month-cell-total" data-testid="report-month-cell-total">
              {m.totals.concerns +
                m.totals.recommendations +
                m.totals.workRefusals +
                m.totals.s51Evidence +
                m.totals.reprisal +
                m.totals.minutes +
                m.totals.inspections +
                m.totals.training}
            </span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}

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

  .report-mode-nav {
    display: flex;
    gap: 0.25rem;
    margin-block-end: 0.5rem;
  }
  .report-mode-link {
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-size: 0.8125rem;
    text-decoration: none;
  }
  .report-mode-link:hover {
    background: var(--color-muted);
    text-decoration: none;
  }
  .report-mode-link.is-active {
    background: var(--color-fg);
    color: var(--color-bg);
    border-color: var(--color-fg);
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
  .report-tile-yoy {
    font-size: 0.625rem;
    font-family: var(--font-mono);
    color: var(--color-fg-muted);
  }
  .report-tile-yoy.is-up {
    color: var(--color-tint-red-fg);
  }
  .report-tile-yoy.is-down {
    color: var(--color-tint-green-fg);
  }
  .report-tile-yoy.is-flat {
    color: var(--color-fg-muted);
  }
  .report-tile-yoy-suffix {
    margin-inline-start: 0.125rem;
    color: var(--color-fg-muted);
    font-family: inherit;
  }
  .report-tile-spark {
    inline-size: 100%;
    block-size: 0.75rem;
    margin-block-start: 0.125rem;
    overflow: visible;
  }
  .report-tile-spark-bar {
    fill: var(--color-fg-muted);
    opacity: 0.6;
  }
  .report-tile-spark-bar.is-current {
    fill: var(--color-fg);
    opacity: 1;
  }

  .report-month-strip {
    list-style: none;
    padding: 0;
    margin: 0 0 1rem;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(4.5rem, 1fr));
    gap: 0.25rem;
  }
  .report-month-cell {
    display: grid;
    gap: 0.125rem;
    padding: 0.375rem 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    text-decoration: none;
    text-align: center;
  }
  .report-month-cell:hover {
    background: var(--color-muted);
    text-decoration: none;
  }
  .report-month-cell-month {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    color: var(--color-fg-muted);
  }
  .report-month-cell-total {
    font-family: var(--font-mono);
    font-size: 1rem;
    font-weight: 700;
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

  /*
   * Print stylesheet — committee-meeting deliverable. The worker
   * co-chair runs /report into a paper handout for the meeting, so we
   * collapse interactive chrome (mode toggle, prev/next nav, CSV
   * button, back-to-home — all already carry data-print="hide") and
   * tighten the tile/breakdown spacing. The amber demo-note callout
   * stays visible so paper readers see the same "synthetic data"
   * caveat the screen carries.
   */
  @media print {
    .report-card {
      margin: 0;
      border: none;
      padding: 0;
      background: transparent;
      box-shadow: none;
    }
    .report-header h1 {
      font-size: 1rem;
    }
    .report-tiles {
      gap: 0.25rem;
    }
    .report-tile {
      padding: 0.375rem 0.5rem;
      page-break-inside: avoid;
      background: transparent;
    }
    .report-tile-count {
      font-size: 1rem;
    }
    .report-month-strip {
      gap: 0.25rem;
    }
    .report-month-cell {
      padding: 0.25rem 0.375rem;
      page-break-inside: avoid;
      background: transparent;
    }
    .report-breakdown {
      background: transparent;
    }
    .report-breakdown-row {
      padding: 0.25rem 0.5rem;
      page-break-inside: avoid;
    }
  }
</style>
