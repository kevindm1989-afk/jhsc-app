<script>
  /**
   * RecoveryReissueCard — print a fresh recovery sheet without
   * re-onboarding (on /settings).
   *
   * The use case: a worker's original printed sheet was lost or damaged,
   * or they want to rotate their recovery passphrase. They still have
   * an active session on a working device; they don't need to recover
   * — they just need a NEW paper sheet derived from the same identity
   * private key.
   *
   * Flow:
   *   1. Worker clicks "Generate a new recovery sheet".
   *   2. Component reads the existing identity private key from the
   *      browser-local identity store (BrowserLocalIdentityStore).
   *      The key bytes live in the closure of `onGenerate()` — never
   *      on the DOM, never in any reactive store.
   *   3. Component generates a fresh passphrase (libsodium randombytes
   *      → Crockford base32 → hyphenated 32-char string, ~160 bits).
   *   4. Component encrypts the private key under the new passphrase
   *      via encryptRecoveryBlob (libsodium secretbox + Argon2id KDF).
   *   5. Component triggers a file download of the JSON blob via
   *      downloadRecoveryBlobJson + displays the passphrase for the
   *      worker to write down.
   *
   * Caveats surfaced in the UI:
   *   - The OLD paper sheet still decrypts the OLD passphrase. The
   *     system can't enforce paper destruction — the worker must
   *     physically destroy the old print.
   *   - The server-stored backup is NOT updated by this surface
   *     (F-12 server-side single-POST enforcement). The new local
   *     paper sheet works for on-device verification + the
   *     RecoveryVerifierCard; the server-stored blob still requires
   *     the original passphrase for the lost-device recovery flow.
   *     Future PR can add a server-rotate path if/when the server
   *     gains a rotate-recovery-blob op.
   *
   * F-108 contract preserved: no copy / audio / screenshot affordance
   * on the passphrase block. The passphrase <code> carries no
   * aria-live / role="alert" / role="status". The identity private
   * key is NEVER rendered to the DOM.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';
  import { getCurrentUserId } from '$lib/auth/jwt-claims';
  import { generateRecoveryPassphrase } from '$lib/crypto/passphrase';
  import { encryptRecoveryBlob } from '$lib/crypto/recovery-blob';
  import {
    downloadRecoveryBlobJson,
    serializeRecoveryBlobJson
  } from '$lib/onboarding/recovery-blob-download';

  /**
   * Identity-key provider — async function that returns the caller's
   * X25519 private key bytes. The production /settings route wires this
   * to BrowserLocalIdentityStore.getIdentityPrivateKey; tests inject
   * a stub.
   *
   * @type {(user_id: string) => Promise<Uint8Array>}
   */
  export let getIdentityPrivateKey = async () => {
    throw new Error('RecoveryReissueCard: getIdentityPrivateKey not wired');
  };

  /** @type {'idle' | 'generating' | 'issued' | 'failure'} */
  let state = 'idle';
  let passphrase = '';
  let downloadedFilename = '';
  let failureKey = '';

  async function onGenerate() {
    if (state === 'generating') return;
    state = 'generating';
    failureKey = '';
    passphrase = '';
    downloadedFilename = '';

    const userId = getCurrentUserId();
    if (!userId) {
      state = 'failure';
      failureKey = 'settings.recoveryReissue.error.signed_out';
      return;
    }

    /** @type {Uint8Array | null} */
    let privateKey;
    try {
      privateKey = await getIdentityPrivateKey(userId);
    } catch {
      state = 'failure';
      failureKey = 'settings.recoveryReissue.error.no_identity';
      return;
    }
    if (!privateKey || privateKey.length !== 32) {
      state = 'failure';
      failureKey = 'settings.recoveryReissue.error.no_identity';
      return;
    }

    try {
      const generated = await generateRecoveryPassphrase();
      const blob = await encryptRecoveryBlob(privateKey, generated.passphrase);
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
      if (!r.ok) {
        state = 'failure';
        failureKey = 'settings.recoveryReissue.error.download_failed';
        return;
      }
      passphrase = generated.passphrase;
      downloadedFilename = filename;
      state = 'issued';
    } catch {
      state = 'failure';
      failureKey = 'settings.recoveryReissue.error.unknown';
    }
  }

  function onReset() {
    state = 'idle';
    passphrase = '';
    downloadedFilename = '';
    failureKey = '';
  }
</script>

<section
  class="recovery-reissue-section"
  aria-labelledby="recovery-reissue-heading"
  aria-busy={state === 'generating' ? 'true' : 'false'}
  data-testid="recovery-reissue-section"
>
  <h2 id="recovery-reissue-heading">{t('settings.recoveryReissue.heading')}</h2>
  <p class="muted">{t('settings.recoveryReissue.intro')}</p>

  <ul class="recovery-reissue-warnings">
    <li>{t('settings.recoveryReissue.warning.old_sheet_still_works')}</li>
    <li>{t('settings.recoveryReissue.warning.server_backup_unchanged')}</li>
  </ul>

  {#if state === 'idle' || state === 'generating'}
    <button
      type="button"
      class="recovery-reissue-primary"
      on:click={onGenerate}
      disabled={state === 'generating'}
      aria-busy={state === 'generating' ? 'true' : 'false'}
      data-testid="recovery-reissue-button"
    >
      {state === 'generating'
        ? t('settings.recoveryReissue.generating')
        : t('settings.recoveryReissue.generate')}
    </button>
  {/if}

  {#if state === 'issued'}
    <div class="recovery-reissue-success" role="status" data-testid="recovery-reissue-success">
      <strong>{t('settings.recoveryReissue.success.heading')}</strong>
      <p>{t('settings.recoveryReissue.success.body')}</p>
      <p class="recovery-reissue-filename" data-testid="recovery-reissue-filename">
        {t('settings.recoveryReissue.success.file_label')}:
        <code>{downloadedFilename}</code>
      </p>
      <p class="recovery-reissue-passphrase-label">
        {t('settings.recoveryReissue.success.passphrase_label')}
      </p>
      <!--
        F-108 M-108c: NO aria-live / role attribute on the passphrase-
        bearing element or any ancestor (the outer role="status" lives
        on the surrounding success panel, NOT this <code>). TTS exfil
        defense; mirrors D.4 / RecoveryVerifierCard.
      -->
      <code class="recovery-reissue-passphrase" data-testid="recovery-reissue-passphrase">
        {passphrase}
      </code>
    </div>
    <button
      type="button"
      class="btn-outline"
      on:click={onReset}
      data-testid="recovery-reissue-reset"
    >
      {t('settings.recoveryReissue.reset')}
    </button>
  {/if}

  {#if state === 'failure' && failureKey}
    <div class="recovery-reissue-alert" role="alert" data-testid="recovery-reissue-error">
      {t(failureKey)}
    </div>
    <button
      type="button"
      class="btn-outline"
      on:click={onReset}
      data-testid="recovery-reissue-reset"
    >
      {t('settings.recoveryReissue.reset')}
    </button>
  {/if}
</section>

<style>
  .recovery-reissue-section {
    margin-block-start: 1.25rem;
  }
  .recovery-reissue-warnings {
    margin-block: 0.75rem 1rem;
    padding-inline-start: 1.25rem;
    color: var(--color-fg-muted);
    font-size: 0.875rem;
  }
  .recovery-reissue-warnings > li {
    margin-block-end: 0.375rem;
  }
  .recovery-reissue-primary {
    background: var(--color-accent);
    color: var(--color-accent-fg);
    border-color: var(--color-accent);
  }
  .recovery-reissue-primary:hover:not(:disabled) {
    background: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
    opacity: 1;
  }
  .recovery-reissue-success {
    margin-block: 1rem 0;
    padding: 0.875rem 1rem;
    border: 1px solid var(--color-tint-green-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
  }
  .recovery-reissue-success strong {
    display: block;
    margin-block-end: 0.25rem;
    font-weight: 600;
  }
  .recovery-reissue-success p {
    margin: 0 0 0.375rem;
  }
  .recovery-reissue-filename {
    font-size: 0.8125rem;
  }
  .recovery-reissue-filename code {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    word-break: break-all;
  }
  .recovery-reissue-passphrase-label {
    margin-block: 0.75rem 0.375rem;
    color: var(--color-tint-green-fg);
    font-weight: 600;
    font-size: 0.875rem;
  }
  .recovery-reissue-passphrase {
    display: block;
    padding: 0.875rem 1rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-muted);
    color: var(--color-fg);
    font-family: var(--font-mono);
    font-size: 1.0625rem;
    line-height: 1.5;
    letter-spacing: 0.02em;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .recovery-reissue-alert {
    margin-block: 1rem 0;
    padding: 0.75rem 1rem;
    border: 1px solid var(--color-tint-red-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
  }
</style>
