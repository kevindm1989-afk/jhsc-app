<script>
  /**
   * /s51-evidence — JHSC C4-tier OHSA s. 51 critical-injury evidence
   * register mount.
   *
   * Replaces the PR #141 coming-soon placeholder. Mounts
   * S51EvidenceViewer with the demo provider so the register surface
   * renders realistic content until T14 wires the real backend
   * (evidence-capture flow + scene-preservation timer + per-entry
   * passphrase + photo sanitize).
   *
   * Preserves the destructive-red 4px inline-start border the
   * placeholder card established — every C4 surface in the worker-hub
   * language shares that accent.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';
  import S51EvidenceViewer from '$lib/s51-evidence/S51EvidenceViewer.svelte';
  import {
    buildDemoS51Evidence,
    fetchDemoS51EvidencePage
  } from '$lib/s51-evidence/demo-s51-evidence';

  const DEMO_ROWS = buildDemoS51Evidence(30);

  /**
   * @param {number} page
   * @param {number} page_size
   */
  const fetchPage = (page, page_size) => fetchDemoS51EvidencePage(page, page_size, DEMO_ROWS);
</script>

<svelte:head>
  <title>{t('common.s51Page.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card s51-card" data-testid="s51-page">
  <S51EvidenceViewer {fetchPage} />
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
