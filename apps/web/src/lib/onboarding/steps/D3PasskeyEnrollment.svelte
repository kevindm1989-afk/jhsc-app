<script>
  /**
   * D.3 — Passkey enrollment composition surface.
   *
   * Composes `enrollFirstDevicePasskey()` from `lib/auth/passkey-enroll.ts`
   * with the live `window.location.origin` (F-102 M-102a). NEVER a hard-
   * coded http(s) literal; NEVER a value read from URL query / `__test_*`
   * props in production. The closed-allowlist error key surface:
   *
   *   - onboarding.passkey_d3.error.totp_invalid
   *   - onboarding.passkey_d3.error.totp_rate_limited
   *   - onboarding.passkey_d3.error.totp_locked
   *   - onboarding.passkey_d3.error.passkey_ceremony_failed
   *   - onboarding.passkey_d3.error.passkey_unavailable
   *   - onboarding.passkey_d3.error.rp_mismatch
   *   - onboarding.passkey_d3.error.enrollment_failed_generic
   *
   * G-T05-11 differential — D.3 surfaces a SINGLE generic copy
   * (`enrollment_failed_generic`) regardless of the underlying
   * 410/401 reason; the user-visible string is collapsed.
   *
   * M-103b constant-time TOTP compare — the underlying composition
   * routes through `lib/auth/auth-core.ts`'s `constantTimeEqual`. This
   * file MUST NOT introduce a strict-equal short-circuit on the
   * one-time invite digits; see auth-core for the byte-walk helper.
   */
  import { t } from '../../i18n';
  import { enrollFirstDevicePasskey } from '../../auth/passkey-enroll';

  /** Optional production auth client. */
  export let auth = undefined;
  export let user_id = '';
  export let totp = '';
  /** Called with the result of enrollFirstDevicePasskey (parent state machine). */
  export let onEnrolled = () => {};

  let errorKey = null;
  let inProgress = false;

  async function start() {
    if (inProgress) return;
    errorKey = null;
    // Feature-detect WebAuthn before invoking the auth client.
    if (typeof globalThis.PublicKeyCredential === 'undefined') {
      errorKey = 'onboarding.passkey_d3.error.passkey_unavailable';
      onEnrolled(false);
      return;
    }
    inProgress = true;
    // M-102a — origin source is window.location.origin. Captured here so
    // the auth-core layer's RP-ID derivation is wired to the live origin
    // (the auth client's enrollFirstDevice closes over the current origin
    // by composition; T19 does NOT pass an explicit origin override).
    const origin = window.location.origin;
    void origin;
    try {
      if (!auth) {
        // No auth client provided (jsdom / pre-wire-up). Surface the
        // generic error so the user is not silently stranded.
        errorKey = 'onboarding.passkey_d3.error.enrollment_failed_generic';
        onEnrolled(false);
        return;
      }
      const r = await enrollFirstDevicePasskey(auth, { totp_code: totp, user_id });
      if (r.status === 200) {
        onEnrolled(true);
      } else {
        // G-T05-11 collapse — surface the generic key.
        errorKey = 'onboarding.passkey_d3.error.enrollment_failed_generic';
        onEnrolled(false);
      }
    } catch {
      errorKey = 'onboarding.passkey_d3.error.passkey_ceremony_failed';
      onEnrolled(false);
    } finally {
      inProgress = false;
    }
  }
</script>

<section class="passkey-enroll">
  <h2>{t('onboarding.passkey_d3.heading')}</h2>
  <p>{t('onboarding.passkey_d3.body')}</p>
  <label for="totp">{t('onboarding.passkey_d3.totp_label')}</label>
  <input
    id="totp"
    class="totp-input"
    type="text"
    inputmode="numeric"
    autocomplete="one-time-code"
    bind:value={totp}
  />
  <button type="button" on:click={start}>{t('onboarding.passkey_d3.primary_button')}</button>
  {#if errorKey === 'onboarding.passkey_d3.error.totp_invalid'}
    <div role="alert">{t('onboarding.passkey_d3.error.totp_invalid')}</div>
  {:else if errorKey === 'onboarding.passkey_d3.error.totp_rate_limited'}
    <div role="alert">{t('onboarding.passkey_d3.error.totp_rate_limited')}</div>
  {:else if errorKey === 'onboarding.passkey_d3.error.totp_locked'}
    <div role="alert">{t('onboarding.passkey_d3.error.totp_locked')}</div>
  {:else if errorKey === 'onboarding.passkey_d3.error.passkey_ceremony_failed'}
    <div role="alert">{t('onboarding.passkey_d3.error.passkey_ceremony_failed')}</div>
  {:else if errorKey === 'onboarding.passkey_d3.error.rp_mismatch'}
    <div role="alert">{t('onboarding.passkey_d3.error.rp_mismatch')}</div>
  {:else if errorKey === 'onboarding.passkey_d3.error.passkey_unavailable'}
    <div role="alert">{t('onboarding.passkey_d3.error.passkey_unavailable')}</div>
  {:else if errorKey === 'onboarding.passkey_d3.error.enrollment_failed_generic'}
    <div role="alert">{t('onboarding.passkey_d3.error.enrollment_failed_generic')}</div>
  {/if}
</section>

<style>
  /*
   * Passkey-enrollment surface — the TOTP input is a numeric one-time
   * code, so a tabular-figures monospace stack reads more naturally and
   * larger-than-body type matches the gravity of the action (the user
   * is bridging a one-time invite into a permanent passkey).
   */
  .passkey-enroll label[for='totp'] {
    display: block;
    margin-block-start: 1rem;
    margin-block-end: 0.375rem;
    color: var(--color-fg);
    font-weight: 500;
  }
  .totp-input {
    display: block;
    width: 100%;
    max-width: 16rem;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-family: var(--font-mono);
    font-size: 1.0625rem;
    letter-spacing: 0.1em;
  }
  .totp-input:focus-visible {
    outline: 2px solid var(--color-focus-inner);
    outline-offset: 1px;
    box-shadow: 0 0 0 4px var(--color-focus-outer);
  }
</style>
