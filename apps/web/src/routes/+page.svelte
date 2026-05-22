<script lang="ts">
  /**
   * Placeholder landing page.
   *
   * Renders the app name + the release tag so a smoke test can confirm
   * the build succeeded. The implementer of T05 replaces this with the
   * auth-gated entry flow.
   */
  import { t } from '$lib/i18n';

  const release = 'scaffold';
</script>

<h1>{t('common.app_name')}</h1>
<p>{t('common.actions.continue')} — release: {release}</p>
