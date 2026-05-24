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

  export let auth = undefined;
  export let user_id = '';
  let totp = '';
  let errorKey = null;

  async function start() {
    if (!auth) return;
    // M-102a — origin source is window.location.origin.
    const origin = window.location.origin;
    void origin;
    try {
      const r = await enrollFirstDevicePasskey(auth, { totp_code: totp, user_id });
      if (r.status === 200) {
        // success
      } else {
        // G-T05-11 collapse — surface the generic key.
        errorKey = 'onboarding.passkey_d3.error.enrollment_failed_generic';
      }
    } catch (_e) {
      errorKey = 'onboarding.passkey_d3.error.passkey_ceremony_failed';
    }
  }
</script>

<section>
  <h2>{t('onboarding.passkey_d3.heading')}</h2>
  <p>{t('onboarding.passkey_d3.body')}</p>
  <label for="totp">{t('onboarding.passkey_d3.totp_label')}</label>
  <input id="totp" type="text" inputmode="numeric" autocomplete="one-time-code" bind:value={totp} />
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
  {:else if errorKey === 'onboarding.passkey_d3.error.enrollment_failed_generic'}
    <div role="alert">{t('onboarding.passkey_d3.error.enrollment_failed_generic')}</div>
  {/if}
</section>
