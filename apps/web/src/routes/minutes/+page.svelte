<script>
  /**
   * /minutes — JHSC meeting-minutes register viewer mount.
   *
   * Replaces the PR #137 coming-soon placeholder. Mounts MinutesViewer
   * with the demo provider so the surface renders realistic content
   * until the real minutes-module backend is wired.
   *
   * Supports URL-driven filtering:
   *   - `?filter=draft` narrows to `status === 'draft'`, the worker
   *     co-chair's primary working view (drafts pending approval).
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import MinutesViewer from '$lib/minutes/MinutesViewer.svelte';
  import { buildDemoMinutes, fetchDemoMinutesPage } from '$lib/minutes/demo-minutes';
  import FilterBanner from '$lib/ui/FilterBanner.svelte';

  const DEMO_ROWS = buildDemoMinutes(50);

  $: filterParam = $page.url.searchParams.get('filter');
  $: filterLabel = filterParam === 'draft' ? t('common.filterBanner.label.minutes_draft') : null;
  $: predicate =
    filterParam === 'draft'
      ? /** @param {import('$lib/minutes/demo-minutes').DemoMinutesRow} r */ (r) =>
          r.status === 'draft'
      : undefined;
  $: fetchPage =
    /**
     * @param {number} p
     * @param {number} ps
     */
    (p, ps) => fetchDemoMinutesPage(p, ps, DEMO_ROWS, predicate);
</script>

<svelte:head>
  <title>{t('common.minutesPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card min-card" data-testid="minutes-page">
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/minutes" />
  {/if}
  {#key filterParam}
    <MinutesViewer {fetchPage} />
  {/key}
  <p class="min-demo-note muted" data-testid="min-demo-note">
    {t('minutes.viewer.demo_note')}
  </p>
  <p class="min-footer">
    <a href="/" data-testid="minutes-back-to-home">
      {t('common.minutesPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .min-card {
    margin-block-start: 1rem;
  }
  .min-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .min-footer {
    margin-block-start: 0.75rem;
  }
</style>
