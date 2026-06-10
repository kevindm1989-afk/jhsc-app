<script>
  /**
   * /work-refusal — JHSC C4-tier OHSA s. 43 work-refusal register mount.
   *
   * Replaces the PR #139 coming-soon placeholder. Mounts
   * WorkRefusalViewer with the demo provider so the register surface
   * renders realistic content until the work-refusal-module backend
   * (stage-gated capture + worker-side encryption + audit chain) is
   * wired.
   *
   * Work refusals are sensitivity C4 — the card carries the
   * destructive-red inline-start border shared with /reprisal and
   * /s51-evidence.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';
  import WorkRefusalViewer from '$lib/work-refusal/WorkRefusalViewer.svelte';
  import {
    buildDemoWorkRefusals,
    fetchDemoWorkRefusalPage
  } from '$lib/work-refusal/demo-work-refusal';

  const DEMO_ROWS = buildDemoWorkRefusals(50);

  /**
   * @param {number} page
   * @param {number} page_size
   */
  const fetchPage = (page, page_size) => fetchDemoWorkRefusalPage(page, page_size, DEMO_ROWS);
</script>

<svelte:head>
  <title>{t('common.workRefusalPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card work-refusal-card" data-testid="work-refusal-page">
  <WorkRefusalViewer {fetchPage} />
  <p class="wr-demo-note muted" data-testid="wr-demo-note">
    {t('workRefusal.viewer.demo_note')}
  </p>
  <p class="wr-footer">
    <a href="/" data-testid="work-refusal-back-to-home">
      {t('common.workRefusalPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  /* C4 sensitivity accent — shared with /reprisal and /s51-evidence. */
  .work-refusal-card {
    margin-block-start: 1rem;
    border-inline-start: 4px solid var(--color-destructive);
  }
  .wr-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .wr-footer {
    margin-block-start: 0.75rem;
  }
</style>
