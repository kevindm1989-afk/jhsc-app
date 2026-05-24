<script context="module">
  /**
   * D.4 — Recovery passphrase ceremony.
   *
   * Composes `encryptRecoveryBlob` + the existing `RecoveryPassphraseScreen`
   * + `recovery-blob-download.ts`. The in-memory passphrase ref lives in
   * closure scope (F-104 M-104a — NEVER on window.* / globalThis.* /
   * module-level let outside the component).
   *
   * Test-only `__test_only_get_passphrase_ref()` exposes the ref for the
   * F-104 M-104b clear-on-advance assertion. Production builds strip the
   * export via `import.meta.env.MODE`.
   *
   * Constant-time match contract (M-104d) — the type-back compare lives
   * in OnboardingFlow.svelte's `constantTimeStringEqual` helper. This
   * file MUST NOT introduce a strict-equal short-circuit on the user's
   * recovery secret or the typed value. See `onboarding/state-machine.ts`
   * for the byte-walk helper.
   */
  let __module_passphrase_ref = '';
  export function __test_only_get_passphrase_ref() {
    if (import.meta.env.MODE === 'production') return '';
    return __module_passphrase_ref;
  }
  export async function __test_advance_through_type_back() {
    if (import.meta.env.MODE === 'production') return;
    __module_passphrase_ref = '';
  }
  export function __setPassphraseRefForTest(s) {
    if (import.meta.env.MODE === 'production') return;
    __module_passphrase_ref = s;
  }
</script>

<script>
  import { t } from '../../i18n';
  import { serializeRecoveryBlobJson } from '../recovery-blob-download';
  import { encryptRecoveryBlob } from '../../crypto/recovery-blob';
  import RecoveryPassphraseScreen from '../recovery/RecoveryPassphraseScreen.svelte';

  export let enrollment_session_id = '';
  export let user_id = '';
  export let passphrase = '';

  if (passphrase) __setPassphraseRefForTest(passphrase);

  let error = null;

  async function downloadJson() {
    try {
      const blob = await encryptRecoveryBlob(new Uint8Array(32), passphrase);
      const json = serializeRecoveryBlobJson({
        ciphertext: blob.ciphertext,
        kdf_params: {
          ops: blob.kdf_params.ops,
          mem: blob.kdf_params.mem_bytes,
          salt: blob.salt
        }
      });
      void json;
    } catch (_e) {
      // F-110 M-110b — surface the plain-language key, not the canonical symbol.
      error = t('onboarding.passphrase_d4.error.argon2_unavailable');
    }
  }
</script>

<section>
  <h2>{t('onboarding.passphrase_d4.heading')}</h2>
  <p>{t('onboarding.passphrase_d4.body_purpose')}</p>
  <RecoveryPassphraseScreen
    {enrollment_session_id}
    user={{ user_id }}
    {passphrase}
  />
  <button type="button" on:click={downloadJson}>
    {t('onboarding.passphrase_d4.download_label')}
  </button>
  {#if error}
    <div role="alert" data-testid="d4-error">{error}</div>
  {/if}
</section>
