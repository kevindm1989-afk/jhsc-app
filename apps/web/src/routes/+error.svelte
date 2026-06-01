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

<section data-testid="error-page">
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

  <p data-testid="error-status">
    <strong>{t('common.errorPage.status_label')}</strong>
    <code>{status}</code>
  </p>

  <p>
    <a href="/" data-testid="error-back-to-home">{t('common.errorPage.back_to_home_cta')}</a>
  </p>
</section>
