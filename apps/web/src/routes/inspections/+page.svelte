<script>
  /**
   * /inspections — JHSC inspections register viewer mount.
   *
   * Replaces the PR #136 coming-soon placeholder. Mounts
   * InspectionsViewer with the demo provider so the surface renders
   * realistic content until T10.1 wires the real backend.
   *
   * Supports URL-driven filtering:
   *   - `?filter=quarantined` narrows to entries whose per-entry
   *     HMAC integrity tag failed verification — the rare-but-real
   *     F-45 / ADR-0014 tamper signal. Surfaces "what needs
   *     investigation" cleanly.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import InspectionsViewer from '$lib/inspections/InspectionsViewer.svelte';
  import {
    buildDemoInspections,
    fetchDemoInspectionsPage
  } from '$lib/inspections/demo-inspections';
  import FilterBanner from '$lib/ui/FilterBanner.svelte';

  const DEMO_ROWS = buildDemoInspections(50);

  $: filterParam = $page.url.searchParams.get('filter');
  $: filterLabel =
    filterParam === 'quarantined' ? t('common.filterBanner.label.inspections_quarantined') : null;
  $: predicate =
    filterParam === 'quarantined'
      ? /** @param {import('$lib/inspections/demo-inspections').DemoInspectionRow} r */ (r) =>
          r.integrity_status === 'quarantined'
      : undefined;
  $: fetchPage =
    /**
     * @param {number} p
     * @param {number} ps
     */
    (p, ps) => fetchDemoInspectionsPage(p, ps, DEMO_ROWS, predicate);
</script>

<svelte:head>
  <title>{t('common.inspectionsPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card ins-card" data-testid="inspections-page">
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/inspections" />
  {/if}
  {#key filterParam}
    <InspectionsViewer {fetchPage} />
  {/key}
  <p class="ins-demo-note muted" data-testid="ins-demo-note">
    {t('inspection.viewer.demo_note')}
  </p>
  <p class="ins-footer">
    <a href="/" data-testid="inspections-back-to-home">
      {t('common.inspectionsPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .ins-card {
    margin-block-start: 1rem;
  }
  .ins-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .ins-footer {
    margin-block-start: 0.75rem;
  }
</style>
