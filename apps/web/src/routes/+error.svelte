<script lang="ts">
  /**
   * Customized SvelteKit error page.
   *
   * SvelteKit's default error page shows a raw "Error: 500 / message"
   * string with no styling, no i18n, and no path back to the app. This
   * component replaces it with a friendly:
   *
   *   - Heading + body tailored to the HTTP status (404 gets its own
   *     copy; everything else falls through to the generic message).
   *   - A back-to-home link so the user is never stranded.
   *   - All visible text via t() per ADR-0009.
   *
   * The page error itself (`$page.error.message`) is NOT rendered to
   * the user — per ADR-0010 / threat-model §3.1, runtime error messages
   * can leak PI (raw user IDs, ciphertext column names, etc.). The
   * canonical error reporting channel is the structured logger +
   * Sentry (when the DSN is wired in hooks.client.ts). Showing the
   * status code is fine; showing the message is not.
   *
   * The layout's JWT-reactive header (PR #63) wraps this component so
   * the sign-in indicator is still visible on the error page — a
   * signed-in user who hits a 404 still sees "Signed in" in the header.
   */
  import { page } from '$app/stores';
  import { t } from '$lib/i18n';

  $: status = $page.status;
  $: is404 = status === 404;
</script>

<svelte:head>
  <title>{t('common.errorPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card error-card" data-testid="error-page">
  <p class="error-status-badge" data-testid="error-status">
    <span class="sr-only">{t('common.errorPage.status_label')}</span>
    <code>{status}</code>
  </p>

  <h1>
    {#if is404}
      {t('common.errorPage.heading_404')}
    {:else}
      {t('common.errorPage.heading_other')}
    {/if}
  </h1>

  <p>
    {#if is404}
      {t('common.errorPage.body_404')}
    {:else}
      {t('common.errorPage.body_other')}
    {/if}
  </p>

  <p class="error-cta-row">
    <a href="/" class="cta" data-testid="error-back-to-home">
      {t('common.errorPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  /*
   * Error page — centered hero with the status code rendered as a large
   * monospace badge so the user can see "404" or "500" at a glance and
   * quote it to support. The status code carries the `error-status`
   * test-id (pinned by error-route-mount.test.ts) plus a screen-reader
   * label so AT announces "Status code 404" rather than just "404". The
   * heading + body follow the badge; the back-to-home link renders as
   * a primary CTA so a stranded user is funneled back to the app shell.
   *
   * The ADR-0010 PI-leak contract (no runtime error message rendered
   * in the template) is preserved — only the status code is shown.
   */
  .error-card {
    margin-block-start: 1.5rem;
    text-align: center;
  }
  .error-status-badge {
    display: flex;
    justify-content: center;
    margin-block: 0 1rem;
  }
  .error-status-badge code {
    display: inline-block;
    padding: 0.375rem 1rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-muted);
    color: var(--color-fg);
    font-family: var(--font-mono);
    font-size: 2rem;
    font-weight: 600;
    line-height: 1.1;
    letter-spacing: 0.02em;
  }
  .error-cta-row {
    margin-block-start: 1.5rem;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }
</style>
