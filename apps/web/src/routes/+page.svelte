<script lang="ts">
  /**
   * Landing page.
   *
   * Routes the user to the T19 onboarding wizard. The
   * already-onboarded ↔ new-device decision is the SupabaseKeyStore
   * wire-up's responsibility (`localIdentity.getIdentityPrivateKey()`
   * throws when no privkey is on file → "new device" path; resolves
   * to a privkey → "already onboarded" path). Until that lands, the
   * CTA is unconditional and mirrors the cold-boot path.
   */
  import { t } from '$lib/i18n';

  const release = 'scaffold';
</script>

<h1>{t('common.app_name')}</h1>
<p>{t('common.actions.continue')} — release: {release}</p>
<p>
  <a href="/onboarding">Start setup</a>
</p>
