<script>
  /**
   * /sensitive-feed — worker co-chair + worker certified member C3/C4
   * activity-feed viewer mount.
   *
   * Replaces the PR #141 coming-soon placeholder. Mounts
   * SensitiveFeedViewer with the demo provider so the surface renders
   * realistic content until the real backend ships (role-gating +
   * server-side aggregation of sensitive-tier audit rows + Merkle proofs).
   *
   * Provider injection (`fetchPage` prop): the viewer is backend-
   * agnostic; T-future swap-in replaces the demo provider with no
   * viewer-side changes.
   *
   * Sensitivity-tier visual: the page keeps the 4px destructive-red
   * inline-start border on the outer card (matches PR #141's placeholder
   * + /reprisal + /s51-evidence + PanicWipeModal). The viewer's per-row
   * badge layers an additional tier indicator (C3 blue, C4 red).
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';
  import SensitiveFeedViewer from '$lib/audit/SensitiveFeedViewer.svelte';
  import { buildDemoSensitiveRows, fetchDemoSensitivePage } from '$lib/audit/demo-sensitive-feed';

  const DEMO_ROWS = buildDemoSensitiveRows(50);

  /**
   * @param {number} page
   * @param {number} page_size
   */
  const fetchPage = (page, page_size) => fetchDemoSensitivePage(page, page_size, DEMO_ROWS);
</script>

<svelte:head>
  <title>{t('common.sensitiveFeedPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card sensitive-feed-card" data-testid="sensitive-feed-page">
  <SensitiveFeedViewer {fetchPage} />
  <p class="sensitive-feed-demo-note muted" data-testid="sensitive-feed-demo-note">
    {t('sensitiveFeed.viewer.demo_note')}
  </p>
  <p class="sensitive-feed-footer">
    <a href="/" data-testid="sensitive-feed-back-to-home">
      {t('common.sensitiveFeedPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  /*
   * 4px destructive-red inline-start border — shared with /reprisal,
   * /s51-evidence, and PanicWipeModal. Preserved verbatim from PR #141's
   * placeholder so the visual gravity signal doesn't regress.
   */
  .sensitive-feed-card {
    margin-block-start: 1rem;
    border-inline-start: 4px solid var(--color-destructive);
  }
  .sensitive-feed-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .sensitive-feed-footer {
    margin-block-start: 0.75rem;
  }
</style>
