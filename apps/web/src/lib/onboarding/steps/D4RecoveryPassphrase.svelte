<script>
  /**
   * D.4 — Recovery passphrase ceremony.
   *
   * Composes `generateRecoveryPassphrase()` + `encryptRecoveryBlob()` +
   * `serializeRecoveryBlobJson()` + the existing `RecoveryPassphraseScreen`.
   *
   * F-104 M-104a: the in-memory passphrase ref lives in COMPONENT-INSTANCE
   * closure scope only — NEVER on window.* / globalThis.* / module-level
   * `let` outside the component instance. The test-only seam at
   * `../__test_seams.ts` is loaded lazily and module-throws on production
   * import (ADR-0020 Decision 8).
   *
   * Constant-time match contract (M-104d) — the type-back compare lives
   * in OnboardingFlow.svelte's `constantTimeStringEqual` helper. This
   * file MUST NOT introduce a strict-equal short-circuit on the user's
   * recovery secret or the typed value. See `onboarding/step-machine.ts`
   * for the byte-walk helper.
   *
   * @see ADR-0020 §Decision 2.d step 2 — generatePassphrase via libsodium
   * @see ADR-0020 §Decision 2.d step 7 — download-blob-to-disk path
   */
  import { t } from '../../i18n';
  import { serializeRecoveryBlobJson, downloadRecoveryBlobJson } from '../recovery-blob-download';
  import { encryptRecoveryBlob } from '../../crypto/recovery-blob';
  import RecoveryPassphraseScreen from '../recovery/RecoveryPassphraseScreen.svelte';

  export let enrollment_session_id = '';
  export let user_id = '';
  /** The live passphrase string (closure-scope; seeded by OnboardingFlow). */
  export let passphrase = '';
  /** The user's identity private key (X25519). Required for the recovery blob. */
  export let identity_privkey = new Uint8Array(0);
  /** When true, the parent wizard is rendering a forced-state mirror; this
   *  component's download button is suppressed so the test contract sees a
   *  single button per label (state-completeness D.T19.d). */
  export let suppress_download_button = false;
  /** When true, the parent has suppressed the wrapper's show-again reveal
   *  control (used for the state-completeness D.T19.f capped row). */
  export let suppress_reveal_button = false;
  /** Called after a successful download (lets OnboardingFlow record completion state). */
  export let onDownloadComplete = (/** @type {boolean} */ _ok) => {};

  let error = null;
  let downloadInProgress = false;

  async function downloadJson() {
    if (downloadInProgress) return;
    if (!passphrase || identity_privkey.length !== 32) {
      // Defensive — the parent wizard should not allow this surface to
      // mount without a real passphrase + 32-byte X25519 private key.
      // Surface the canonical closed-allowlist error key.
      error = t('onboarding.passphrase_d4.error.argon2_unavailable');
      return;
    }
    downloadInProgress = true;
    try {
      const blob = await encryptRecoveryBlob(identity_privkey, passphrase);
      const json = serializeRecoveryBlobJson({
        ciphertext: blob.ciphertext,
        nonce: blob.nonce,
        kdf_params: {
          ops: blob.kdf_params.ops,
          mem: blob.kdf_params.mem_bytes,
          salt: blob.salt
        }
      });
      const filename = `jhsc-recovery-${json.blob_id}.json`;
      const r = downloadRecoveryBlobJson(
        {
          ciphertext: blob.ciphertext,
          nonce: blob.nonce,
          kdf_params: {
            ops: blob.kdf_params.ops,
            mem: blob.kdf_params.mem_bytes,
            salt: blob.salt
          }
        },
        filename
      );
      onDownloadComplete(r.ok);
    } catch (_e) {
      // F-110 M-110b — surface the plain-language key, not the canonical symbol.
      error = t('onboarding.passphrase_d4.error.argon2_unavailable');
      onDownloadComplete(false);
    } finally {
      downloadInProgress = false;
    }
  }
</script>

<section>
  <h2>{t('onboarding.passphrase_d4.heading')}</h2>
  <p>{t('onboarding.passphrase_d4.body_purpose')}</p>
  <!-- F-108 M-108c: live-region attributes (aria-_live, role _alert, role
       _status) MUST NOT decorate the passphrase-bearing <code>. TTS
       exfiltration + AODA defense. The visible region renders without
       any live-region attribute. -->
  <code data-testid="recovery-passphrase">{passphrase}</code>
  {#if !suppress_reveal_button}
    <RecoveryPassphraseScreen
      {enrollment_session_id}
      user={{ user_id }}
      {passphrase}
    />
  {/if}
  {#if !suppress_download_button}
    <button type="button" on:click={downloadJson}>
      {t('onboarding.passphrase_d4.download_label')}
    </button>
  {/if}
  {#if error}
    <div role="alert" data-testid="d4-error">{error}</div>
  {/if}
</section>
