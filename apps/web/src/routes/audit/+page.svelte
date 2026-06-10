<script>
  /**
   * /audit — append-only audit-log viewer mount.
   *
   * Replaces the PR #141 coming-soon placeholder. Mounts AuditLogViewer
   * with the demo-data provider so a worker can see what the surface
   * looks like before the real audit-op Edge Function ships (T18).
   *
   * Supports URL-driven filtering on event-type category via
   * `?filter=<value>`. The chip rail surfaces three broad categories
   * that match worker mental models: sessions (session.*, panic_wipe,
   * recovery_blob.*, identity_keypair.*); workplace (concern.*,
   * reprisal.*, work_refusal.*, s51_evidence.*); committee
   * (committee_member.*, audit_log.read). Other events (the few
   * remaining infra-style enums) appear under "All" only.
   *
   * Provider injection (`fetchPage` prop): the viewer is backend-
   * agnostic; the demo provider lives in $lib/audit/demo-audit-rows.
   * When T18's SupabaseAuditClient lands, the route swaps the
   * provider — no viewer-side changes.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import AuditLogViewer from '$lib/audit/AuditLogViewer.svelte';
  import { buildDemoAuditRows, fetchDemoAuditPage } from '$lib/audit/demo-audit-rows';
  import FilterChipsRail from '$lib/ui/FilterChipsRail.svelte';

  const DEMO_ROWS = buildDemoAuditRows(50);

  /** Canonical filter values supported by `?filter=`. */
  const FILTER_VALUES = /** @type {const} */ (['sessions', 'workplace', 'committee']);

  /**
   * Map a filter value to a predicate over the event_type string.
   * @param {string} value
   * @returns {(row: import('$lib/audit/demo-audit-rows').DemoAuditRow) => boolean}
   */
  function predicateFor(value) {
    if (value === 'sessions') {
      return (r) =>
        r.event_type.startsWith('session.') ||
        r.event_type.startsWith('panic_wipe') ||
        r.event_type.startsWith('recovery_blob') ||
        r.event_type.startsWith('identity_keypair');
    }
    if (value === 'workplace') {
      return (r) =>
        r.event_type.startsWith('concern.') ||
        r.event_type.startsWith('reprisal.') ||
        r.event_type.startsWith('work_refusal') ||
        r.event_type.startsWith('s51_evidence');
    }
    // committee
    return (r) => r.event_type.startsWith('committee_member') || r.event_type === 'audit_log.read';
  }

  $: filterParam = $page.url.searchParams.get('filter');
  $: activeValue =
    filterParam && FILTER_VALUES.includes(/** @type {any} */ (filterParam)) ? filterParam : null;

  $: chips = [
    { href: '/audit', label: t('common.filterChips.all'), value: null },
    { href: '/audit?filter=sessions', label: t('audit.viewer.chip.sessions'), value: 'sessions' },
    {
      href: '/audit?filter=workplace',
      label: t('audit.viewer.chip.workplace'),
      value: 'workplace'
    },
    {
      href: '/audit?filter=committee',
      label: t('audit.viewer.chip.committee'),
      value: 'committee'
    }
  ];

  $: pageTitle = (() => {
    if (activeValue) {
      const chip = chips.find((c) => c.value === activeValue);
      if (chip?.label) return chip.label;
    }
    return t('common.auditPage.title');
  })();

  $: predicate = activeValue ? predicateFor(activeValue) : undefined;
  $: fetchPage =
    /**
     * @param {number} p
     * @param {number} ps
     */
    (p, ps) => fetchDemoAuditPage(p, ps, DEMO_ROWS, predicate);
</script>

<svelte:head>
  <title>{pageTitle} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="audit-page" data-testid="audit-page">
  <FilterChipsRail {chips} {activeValue} />
  {#key filterParam}
    <AuditLogViewer {fetchPage} filterActive={filterParam !== null} />
  {/key}
  <p class="audit-page-demo-note muted" data-testid="audit-page-demo-note">
    {t('audit.viewer.demo_note')}
  </p>
  <p class="audit-page-footer" data-print="hide">
    <a href="/" data-testid="audit-back-to-home">{t('common.auditPage.back_to_home_cta')}</a>
  </p>
</section>

<style>
  .audit-page {
    display: block;
    margin-block-start: 1rem;
  }
  .audit-page-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .audit-page-footer {
    margin-block-start: 0.75rem;
  }
</style>
