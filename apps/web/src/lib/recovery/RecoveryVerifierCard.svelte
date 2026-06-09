<script>
  /**
   * RecoveryVerifierCard — read-only "does my recovery sheet still work?"
   * surface on /settings.
   *
   * The full recover-and-re-enroll ceremony is a separate, larger flow
   * (it mints a new server-side passkey on a new device). This card is
   * the CHECK-IN-ADVANCE diagnostic: the worker periodically uploads
   * (or pastes) their downloaded recovery JSON + types the passphrase,
   * the client decrypts entirely on-device, and the surface reports
   * "still valid" / "wrong passphrase or corrupted file". No server
   * roundtrip; no key material persisted; nothing leaves the device.
   *
   * Why this matters: recovery sheets are paper-stored. Workers don't
   * find out the sheet was misprinted / smudged / had a typo in the
   * passphrase until they actually need it. A periodic check-in turns
   * that latent failure into an early-warning signal.
   *
   * F-108 contract preserved: the passphrase input carries the same
   * autocomplete=off / spellcheck=false / autocapitalize=none /
   * autocorrect=off attributes the D.6 type-back input uses
   * (defense vs Chromium cloud-spellcheck round-tripping). No copy /
   * audio / screenshot affordance. The verified IdentityKeypair is
   * NEVER rendered to the DOM or held in any persistent store — it
   * lives in the closure of verify() and goes out of scope when the
   * function returns.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13 — Svelte 5's esrap
   * codegen cannot serialize TS annotations on `let`.
   */
  import { t } from '$lib/i18n';
  import { verifyRecoveryBlobJson } from '$lib/onboarding/recovery-blob-import';

  let jsonText = '';
  let passphrase = '';
  /** @type {'idle' | 'verifying' | 'success' | 'failure'} */
  let state = 'idle';
  let failureKey = '';
  let blobId = '';
  let fileName = '';

  /** @param {Event} event */
  async function onFile(event) {
    const target = /** @type {HTMLInputElement} */ (event.target);
    const file = target.files && target.files[0];
    if (!file) return;
    fileName = file.name;
    try {
      jsonText = await file.text();
    } catch {
      jsonText = '';
      state = 'failure';
      failureKey = 'settings.recoveryVerify.error.file_read';
    }
  }

  async function onVerify() {
    if (state === 'verifying') return;
    state = 'verifying';
    failureKey = '';
    blobId = '';
    try {
      const r = await verifyRecoveryBlobJson(jsonText, passphrase);
      if (r.ok) {
        state = 'success';
        blobId = r.blob_id;
      } else {
        state = 'failure';
        failureKey = `settings.recoveryVerify.error.${r.reason}`;
      }
    } catch {
      state = 'failure';
      failureKey = 'settings.recoveryVerify.error.unknown';
    }
  }

  function onReset() {
    jsonText = '';
    passphrase = '';
    fileName = '';
    state = 'idle';
    failureKey = '';
    blobId = '';
  }

  $: canVerify = state !== 'verifying' && jsonText.trim().length > 0 && passphrase.length > 0;
</script>

<section
  class="recovery-verify-section"
  aria-labelledby="recovery-verify-heading"
  aria-busy={state === 'verifying' ? 'true' : 'false'}
  data-testid="recovery-verify-section"
>
  <h2 id="recovery-verify-heading">{t('settings.recoveryVerify.heading')}</h2>
  <p class="muted">{t('settings.recoveryVerify.intro')}</p>

  <div class="recovery-verify-field">
    <label for="recovery-json-file">{t('settings.recoveryVerify.file_label')}</label>
    <input
      id="recovery-json-file"
      type="file"
      accept="application/json,.json"
      on:change={onFile}
      data-testid="recovery-verify-file-input"
    />
    {#if fileName}
      <p class="recovery-verify-file-name" data-testid="recovery-verify-file-name">
        {fileName}
      </p>
    {/if}
  </div>

  <div class="recovery-verify-field">
    <label for="recovery-passphrase">{t('settings.recoveryVerify.passphrase_label')}</label>
    <input
      id="recovery-passphrase"
      class="recovery-verify-passphrase"
      type="password"
      bind:value={passphrase}
      autocomplete="off"
      spellcheck="false"
      autocapitalize="none"
      autocorrect="off"
      data-testid="recovery-verify-passphrase"
    />
    <p class="recovery-verify-helper">{t('settings.recoveryVerify.passphrase_helper')}</p>
  </div>

  <div class="recovery-verify-actions">
    <button
      type="button"
      class="recovery-verify-primary"
      on:click={onVerify}
      disabled={!canVerify}
      aria-busy={state === 'verifying' ? 'true' : 'false'}
      data-testid="recovery-verify-button"
    >
      {state === 'verifying'
        ? t('settings.recoveryVerify.verifying')
        : t('settings.recoveryVerify.verify')}
    </button>
    {#if state === 'success' || state === 'failure'}
      <button
        type="button"
        class="btn-outline"
        on:click={onReset}
        data-testid="recovery-verify-reset"
      >
        {t('settings.recoveryVerify.reset')}
      </button>
    {/if}
  </div>

  {#if state === 'success'}
    <div class="recovery-verify-success" role="status" data-testid="recovery-verify-success">
      <strong>{t('settings.recoveryVerify.success.heading')}</strong>
      <p>{t('settings.recoveryVerify.success.body')}</p>
      <p class="recovery-verify-blob-id">
        {t('settings.recoveryVerify.success.blob_id_label')}:
        <code data-testid="recovery-verify-blob-id">{blobId}</code>
      </p>
    </div>
  {/if}

  {#if state === 'failure' && failureKey}
    <div class="recovery-verify-alert" role="alert" data-testid="recovery-verify-error">
      {t(failureKey)}
    </div>
  {/if}
</section>

<style>
  .recovery-verify-section {
    margin-block-start: 1.25rem;
  }
  .recovery-verify-field {
    display: block;
    margin-block-end: 1rem;
  }
  .recovery-verify-field label {
    display: block;
    font-weight: 500;
    margin-block-end: 0.375rem;
  }
  .recovery-verify-field input[type='file'] {
    display: block;
    font-family: var(--font-sans);
    font-size: 0.875rem;
    color: var(--color-fg);
  }
  .recovery-verify-file-name {
    margin-block: 0.375rem 0;
    color: var(--color-fg-muted);
    font-family: var(--font-mono);
    font-size: 0.8125rem;
  }
  .recovery-verify-passphrase {
    display: block;
    width: 100%;
    min-height: 2.75rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-family: var(--font-mono);
    font-size: 1rem;
    letter-spacing: 0.02em;
  }
  .recovery-verify-passphrase:focus-visible {
    outline: 2px solid var(--color-focus-inner);
    outline-offset: 1px;
    box-shadow: 0 0 0 4px var(--color-focus-outer);
  }
  .recovery-verify-helper {
    margin-block: 0.375rem 0;
    color: var(--color-fg-muted);
    font-size: 0.8125rem;
  }
  .recovery-verify-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-block-start: 0.75rem;
  }
  .recovery-verify-primary {
    background: var(--color-accent);
    color: var(--color-accent-fg);
    border-color: var(--color-accent);
  }
  .recovery-verify-primary:hover:not(:disabled) {
    background: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
    opacity: 1;
  }
  .recovery-verify-success {
    margin-block: 1rem 0;
    padding: 0.75rem 1rem;
    border: 1px solid var(--color-tint-green-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
  }
  .recovery-verify-success strong {
    display: block;
    margin-block-end: 0.25rem;
    font-weight: 600;
  }
  .recovery-verify-success p {
    margin: 0;
  }
  .recovery-verify-blob-id {
    margin-block-start: 0.5rem;
    font-size: 0.8125rem;
  }
  .recovery-verify-blob-id code {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    word-break: break-all;
  }
  .recovery-verify-alert {
    margin-block: 1rem 0;
    padding: 0.75rem 1rem;
    border: 1px solid var(--color-tint-red-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
  }
</style>
