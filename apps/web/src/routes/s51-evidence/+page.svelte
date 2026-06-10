<script>
  /**
   * /s51-evidence — JHSC C4-tier OHSA s. 51 critical-injury evidence
   * register mount.
   *
   * Replaces the PR #141 coming-soon placeholder. Mounts
   * S51EvidenceViewer with the demo provider so the register surface
   * renders realistic content until T14 wires the real backend.
   *
   * Supports URL-driven filtering:
   *   - `?filter=preserving` narrows to `scene_state === 'preserving'`,
   *     matching the "Scenes preserving" home dashboard tile.
   *
   * Preserves the destructive-red 4px inline-start border the
   * placeholder card established — every C4 surface in the worker-hub
   * language shares that accent.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';
  import S51EvidenceViewer from '$lib/s51-evidence/S51EvidenceViewer.svelte';
  import {
    buildDemoS51Evidence,
    fetchDemoS51EvidencePage
  } from '$lib/s51-evidence/demo-s51-evidence';
  import FilterBanner from '$lib/ui/FilterBanner.svelte';

  const DEMO_ROWS = buildDemoS51Evidence(30);

  $: filterParam = $page.url.searchParams.get('filter');
  $: filterLabel =
    filterParam === 'preserving' ? t('common.filterBanner.label.s51_preserving') : null;
  $: predicate =
    filterParam === 'preserving'
      ? /** @param {import('$lib/s51-evidence/demo-s51-evidence').DemoS51EvidenceRow} r */ (r) =>
          r.scene_state === 'preserving'
      : undefined;
  $: fetchPage =
    /**
     * @param {number} p
     * @param {number} ps
     */
    (p, ps) => fetchDemoS51EvidencePage(p, ps, DEMO_ROWS, predicate);
</script>

<svelte:head>
  <title>{t('common.s51Page.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card s51-card" data-testid="s51-page">
  {#if filterLabel}
    <FilterBanner label={filterLabel} clearHref="/s51-evidence" />
  {/if}
  {#key filterParam}
    <S51EvidenceViewer {fetchPage} />
  {/key}
  <p class="s51-demo-note muted" data-testid="s51-demo-note">
    {t('s51.viewer.demo_note')}
  </p>
  <p class="s51-footer">
    <a href="/" data-testid="s51-back-to-home">
      {t('common.s51Page.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  /*
   * 4px destructive-red inline-start border — the C4 sensitivity
   * accent shared with /reprisal and PanicWipeModal.
   */
  .s51-card {
    margin-block-start: 1rem;
    border-inline-start: 4px solid var(--color-destructive);
  }
  .s51-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .s51-footer {
    margin-block-start: 0.75rem;
  }
</style>
