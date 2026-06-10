<script>
  /**
   * /library — JHSC committee document library register mount.
   *
   * Replaces the PR #139 coming-soon placeholder. Mounts LibraryViewer
   * with the demo provider so the surface renders realistic content
   * until the library-module backend (versioned doc store + offline
   * cache + on-device search) is wired.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';
  import LibraryViewer from '$lib/library/LibraryViewer.svelte';
  import { buildDemoLibrary, fetchDemoLibraryPage } from '$lib/library/demo-library';

  const DEMO_ROWS = buildDemoLibrary(50);

  /**
   * @param {number} page
   * @param {number} page_size
   */
  const fetchPage = (page, page_size) => fetchDemoLibraryPage(page, page_size, DEMO_ROWS);
</script>

<svelte:head>
  <title>{t('common.libraryPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card lib-card" data-testid="library-page">
  <LibraryViewer {fetchPage} />
  <p class="lib-demo-note muted" data-testid="lib-demo-note">
    {t('library.viewer.demo_note')}
  </p>
  <p class="lib-footer">
    <a href="/" data-testid="library-back-to-home">
      {t('common.libraryPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .lib-card {
    margin-block-start: 1rem;
  }
  .lib-demo-note {
    margin-block: 1rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-amber-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    font-size: 0.8125rem;
  }
  .lib-footer {
    margin-block-start: 0.75rem;
  }
</style>
