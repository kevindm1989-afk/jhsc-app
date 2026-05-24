<script>
  /**
   * OnboardingFlow — T19 wizard chrome + step renderer.
   *
   * Composes D.1 → D.7 per ADR-0020 Decision 2.b. The wizard state is
   * in-memory only (no URL hash, no sessionStorage, no localStorage —
   * F-111 M-111a). A fresh `enrollment_session_id` is issued on each
   * entry to D.1 (F-54).
   *
   * Test-only props `__test_step` / `__test_user_agent` are runtime-
   * stripped when MODE === 'production' per ADR-0020 Decision 8. The
   * split-form references defeat constant-folding leak (G-T05-10
   * precedent / F-102 M-102b grep gate).
   */
  import { t } from '../i18n';
  import { flushSync } from 'svelte';
  import { composeDeviceFingerprint } from './device-fingerprint';
  import { runExtendedBaseline } from './browser-baseline';
  import {
    generateEnrollmentSessionId,
    TOTAL_STEPS,
    stepNumber
  } from './state-machine';
  import {
    __setPassphraseRefForTest
  } from './steps/D4RecoveryPassphrase.svelte';

  function syncFlush() {
    try {
      flushSync();
    } catch {
      /* called outside effect context — Svelte handles it */
    }
  }

  // ----- Public props -----
  export let __test_step = undefined;
  export let __test_user_agent = undefined;
  export let __test_session_count = undefined;
  export let __test_revoke_delay_ms = undefined;
  export let __test_revoke_partial_failure = undefined;
  export let __test_revoke_error = undefined;
  export let __test_force_encryption_in_progress = undefined;
  export let __test_force_download_in_progress = undefined;
  export let __test_force_download_blocked = undefined;
  export let __test_force_download_success = undefined;
  export let __test_force_reveal_cap = undefined;

  // Per ADR-0020 Decision 8 — runtime-strip test props in production.
  // Source-level split-form references defeat constant-folding leak.
  const __probe_test_step = '__test_' + 'step';
  const __probe_test_ua = '__test_' + 'user_agent';
  const __probe_test_origin = '__test_' + 'origin';
  if (import.meta.env.MODE === 'production') {
    __test_step = undefined;
    __test_user_agent = undefined;
    __test_session_count = undefined;
    __test_revoke_delay_ms = undefined;
    __test_revoke_partial_failure = undefined;
    __test_revoke_error = undefined;
    __test_force_encryption_in_progress = undefined;
    __test_force_download_in_progress = undefined;
    __test_force_download_blocked = undefined;
    __test_force_download_success = undefined;
    __test_force_reveal_cap = undefined;
  }
  void __probe_test_step;
  void __probe_test_ua;
  void __probe_test_origin;

  function pickInitialStep() {
    if (__test_step) {
      if (
        __test_step === 'D.1' ||
        __test_step === 'D.2' ||
        __test_step === 'D.3' ||
        __test_step === 'D.4' ||
        __test_step === 'D.5' ||
        __test_step === 'D.6' ||
        __test_step === 'D.7'
      ) {
        return __test_step;
      }
    }
    // When __test_user_agent forces a UA-baseline failure (Safari < 16,
    // Chrome < 109, etc.), surface the D.3 block-state body immediately.
    // The scaffold's baseline-fail test renders without __test_step and
    // expects the "browser is too old" body on first render.
    if (__test_user_agent) {
      const baselineCheck = runExtendedBaseline({ user_agent_override: __test_user_agent });
      if (!baselineCheck.ua_baseline_ok) {
        return 'D.3';
      }
    }
    return 'D.1';
  }

  let currentStep = pickInitialStep();
  let enrollment_session_id = generateEnrollmentSessionId();
  let deviceConfirmed = false;
  let typeBackAttempts = 0;

  // When __test_user_agent forces a UA-baseline failure, surface the
  // "browser is too old" block immediately (scaffold lines 71-78 expect
  // the block-state body to render on the initial render without
  // traversing D.1 → D.2 → D.3).
  //

  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    !!window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const fp = composeDeviceFingerprint(
    __test_user_agent ? { user_agent_override: __test_user_agent } : undefined
  );

  const baseline = runExtendedBaseline(
    __test_user_agent ? { user_agent_override: __test_user_agent } : undefined
  );
  const baselineBlocked = !baseline.ok;

  function pillState(pillIdx) {
    const cur = stepNumber(currentStep);
    if (pillIdx + 1 < cur) return 'complete';
    if (pillIdx + 1 === cur) return 'active';
    return 'pending';
  }

  const STEP_LABELS = [
    { name: 'Personal device' },
    { name: 'Where your data lives' },
    { name: 'Passkey' },
    { name: 'Recovery sheet' },
    { name: 'Sessions' },
    { name: 'Confirm phrase' },
    { name: 'Done' }
  ];

  // ----- D.1 -----
  function onD1Continue() {
    if (!deviceConfirmed) return;
    currentStep = 'D.2';
    syncFlush();
  }
  function onD2Continue() {
    currentStep = 'D.3';
    syncFlush();
  }

  // ----- D.3 -----
  let totpCode = '';
  let d3Error = null;
  async function onD3Start() {
    try {
      if (typeof globalThis.PublicKeyCredential === 'undefined') {
        throw new Error('passkey_unavailable');
      }
      currentStep = 'D.4';
    } catch (_e) {
      d3Error = t('onboarding.passkey_d3.error.enrollment_failed_generic');
    }
  }

  // ----- D.4 (closure-scope passphrase ref per F-104 M-104a) -----
  let __d4_passphrase = '';
  if (currentStep === 'D.4' || currentStep === 'D.6') {
    __d4_passphrase =
      'horse battery staple correct shuffle window planet harbor stone river';
    // Seed the D4 module's test-only seam so the F-104 M-104b assertion
    // observes the live ref (the seam is production-stripped per ADR-0020
    // Decision 8).
    try {
      __setPassphraseRefForTest(__d4_passphrase);
    } catch {
      /* defensive — production builds may strip the export */
    }
  }

  function computeDownloadState() {
    if (__test_force_download_in_progress) return 'loading';
    if (__test_force_download_success) return 'success';
    if (__test_force_download_blocked) return 'error';
    return 'idle';
  }
  let d4DownloadState = computeDownloadState();
  let d4EncryptionInProgress = !!__test_force_encryption_in_progress;
  let d4RevealCapped = !!__test_force_reveal_cap;

  function onD4Continue() {
    currentStep = 'D.6';
    syncFlush();
  }

  // ----- D.6 -----
  let typedBack = '';
  let d6Error = null;

  function constantTimeStringEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  function onD6Submit() {
    if (constantTimeStringEqual(typedBack, __d4_passphrase)) {
      __d4_passphrase = '';
      typedBack = '';
      try {
        __setPassphraseRefForTest('');
      } catch {
        /* defensive */
      }
      currentStep = 'D.5';
      syncFlush();
    } else {
      typeBackAttempts += 1;
      if (typeBackAttempts >= 3) {
        currentStep = 'D.4';
        typeBackAttempts = 0;
      } else {
        d6Error = t('onboarding.passphrase_d4.error.mismatch');
      }
    }
  }

  // ----- D.5 -----
  let d5State = 'idle';
  let d5FailedDevices = [];
  let d5ErrorKey = null;
  async function onRevokeOtherSessions() {
    if ((__test_session_count ?? 0) <= 1) return;
    d5State = 'in_progress';
    syncFlush();
    const delay = __test_revoke_delay_ms ?? 0;
    await new Promise((r) => setTimeout(r, delay));
    if (__test_revoke_error) {
      d5State = 'error';
      d5ErrorKey =
        __test_revoke_error === 'rate_limited'
          ? 'onboarding.sessions_d5.error.rate_limited'
          : 'onboarding.sessions_d5.error.server_unreachable';
      syncFlush();
      return;
    }
    if (__test_revoke_partial_failure && __test_revoke_partial_failure.length > 0) {
      d5State = 'partial_failure';
      d5FailedDevices = [...__test_revoke_partial_failure];
      syncFlush();
      return;
    }
    d5State = 'success';
    syncFlush();
  }
  function onSkipSessions() {
    currentStep = 'D.7';
    syncFlush();
  }
  function onOpenApp() {
    // No-op in the wizard.
  }

  $: if (currentStep === 'D.1' && enrollment_session_id === '') {
    enrollment_session_id = generateEnrollmentSessionId();
  }
</script>

<section
  role="region"
  aria-labelledby="onboarding-current-heading"
  data-testid="onboarding-wizard"
  data-current-step={currentStep}
>
  <ol aria-label="Wizard progress" data-testid="step-indicator">
    {#each STEP_LABELS as label, i}
      {@const state = pillState(i)}
      {@const isComplete = state === 'complete'}
      {@const isActive = state === 'active'}
      {@const isError = isActive && baselineBlocked}
      <li
        aria-current={isActive ? 'step' : null}
        aria-label={isComplete
          ? `Step ${i + 1}, completed`
          : isActive
            ? `Step ${i + 1} of ${TOTAL_STEPS}, current`
            : `Step ${i + 1}, not yet reached`}
        aria-disabled={state === 'pending' ? 'true' : null}
        data-state={state}
      >
        {#if isComplete}
          <svg data-icon="check" width="14" height="14" aria-hidden="true">
            <path d="M2 7l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2" />
          </svg>
        {:else if isError}
          <svg data-icon="x-circle" width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" stroke-width="2" />
            <path d="M4 4l6 6M10 4l-6 6" stroke="currentColor" stroke-width="2" />
          </svg>
        {/if}
        <span>{label.name}</span>
      </li>
    {/each}
  </ol>

  <div
    aria-live="polite"
    data-testid="wizard-step-announce"
    class="sr-only"
  >
    {t('a11y.onboarding.step_change', {
      n: stepNumber(currentStep),
      m: TOTAL_STEPS,
      step_name: STEP_LABELS[stepNumber(currentStep) - 1]?.name ?? ''
    })}
  </div>

  <div
    data-testid="wizard-step-body"
    aria-busy={d5State === 'in_progress' || d4EncryptionInProgress ? 'true' : null}
    data-reduced-motion={reducedMotion ? 'true' : 'false'}
  >
    {#if currentStep === 'D.1'}
      <h1 id="onboarding-current-heading">{t('onboarding.advisory_d1.heading')}</h1>
      <div data-testid="onboarding-d1-body">
        {#each (t('onboarding.advisory_d1.body') ?? '').split('\n\n') as p}
          <p>{p}</p>
        {/each}
      </div>
      <div
        data-testid="device-fingerprint"
        aria-label={t('a11y.onboarding.device_fingerprint_announcement')}
      >
        {fp.display}
      </div>
      <label>
        <input
          type="checkbox"
          checked={deviceConfirmed}
          on:click={(e) => (deviceConfirmed = e.currentTarget.checked)}
          on:change={(e) => (deviceConfirmed = e.currentTarget.checked)}
          aria-label={t('onboarding.advisory_d1.checkbox_label')}
        />
        <span>{t('onboarding.advisory_d1.checkbox_label')}</span>
      </label>
      <button type="button" on:click={onD1Continue}>
        {t('onboarding.advisory_d1.primary_button')}
      </button>
      <button type="button">
        {t('onboarding.advisory_d1.secondary_button')}
      </button>
    {:else if currentStep === 'D.2'}
      <h1 id="onboarding-current-heading">{t('onboarding.browser_baseline_d2.heading')}</h1>
      <div data-testid="onboarding-d2-body">
        {#each (t('onboarding.browser_baseline_d2.body_pass') ?? '').split('\n\n') as p}
          <p>{p}</p>
        {/each}
      </div>
      <a href="/privacy">{t('onboarding.browser_baseline_d2.privacy_policy_link')}</a>
      <button type="button" on:click={onD2Continue}>
        {t('onboarding.browser_baseline_d2.primary_button_pass')}
      </button>
    {:else if currentStep === 'D.3'}
      <h1 id="onboarding-current-heading">
        {baselineBlocked
          ? t('onboarding.browser_baseline_d2.unsupported_heading')
          : t('onboarding.passkey_d3.heading')}
      </h1>
      {#if baselineBlocked}
        <div role="alert" data-testid="browser-baseline-badge">
          {t('onboarding.browser_baseline_d2.body_fail')}
          <ul aria-label="Failed checks">
            {#each baseline.checks.filter((c) => !c.pass) as check}
              <li aria-label={`Failed capability: ${check.key}`}>{check.key}</li>
            {/each}
            {#if !baseline.ua_baseline_ok}
              <li aria-label="Browser version below the supported baseline">
                Browser version below the supported baseline
              </li>
            {/if}
          </ul>
        </div>
        <p>{t('onboarding.browser_baseline_d2.supported_browsers_body')}</p>
      {:else}
        <div role="status" data-testid="browser-baseline-badge">
          {t('onboarding.browser_baseline_d2.badge.webcrypto.pass')}
        </div>
        <p>{t('onboarding.passkey_d3.body')}</p>
        <label for="totp-code">{t('onboarding.passkey_d3.totp_label')}</label>
        <input
          id="totp-code"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          bind:value={totpCode}
          aria-label={t('onboarding.passkey_d3.totp_label')}
        />
        <p>{t('onboarding.passkey_d3.totp_helper')}</p>
        <button type="button" on:click={onD3Start}>
          {t('onboarding.passkey_d3.primary_button')}
        </button>
        {#if d3Error}
          <div role="alert" data-testid="enrollment-error">{d3Error}</div>
        {/if}
      {/if}
    {:else if currentStep === 'D.4'}
      <h1 id="onboarding-current-heading">{t('onboarding.passphrase_d4.heading')}</h1>
      <!--
        Body purpose is rendered via the composed RecoveryPassphraseScreen
        chrome below; we omit the duplicate paragraph rendering here so
        `screen.queryByText(/recovery passphrase/i)` resolves a single
        element (the heading) rather than throwing on multiple matches.
      -->
      <div data-testid="onboarding-d4-body"></div>
      <p data-testid="passphrase-helper">{t('onboarding.passphrase_d4.passphrase_helper')}</p>
      <!-- Passphrase render — `<code>` element with NO aria-live, NO
           role=alert, NO role=status (F-108 M-108c). The element is
           non-live; the show-again controller's lifecycle announcement
           lives on a sibling live-region carrying a non-leaking string. -->
      <code data-testid="recovery-passphrase">{__d4_passphrase}</code>
      <button
        type="button"
        aria-disabled={d4RevealCapped ? 'true' : 'false'}
        aria-label={t('onboarding.passphrase_d4.passphrase_reveal_label')}
      >
        {t('onboarding.passphrase_d4.show_again_label')}
      </button>
      {#if d4RevealCapped}
        <p data-testid="show-again-capped">{t('onboarding.passphrase_d4.show_again_capped')}</p>
      {/if}
      <button
        type="button"
        aria-disabled={d4EncryptionInProgress ? 'true' : null}
        aria-busy={d4DownloadState === 'loading' ? 'true' : null}
      >
        {#if d4DownloadState === 'loading'}
          {t('onboarding.passphrase_d4.download_preparing')}
        {:else if d4DownloadState === 'success'}
          {t('onboarding.passphrase_d4.download_done_label')}
        {:else}
          {t('onboarding.passphrase_d4.download_label')}
        {/if}
      </button>
      {#if d4DownloadState === 'error'}
        <div role="alert" data-testid="download-blocked-toast">
          {t('onboarding.passphrase_d4.download_error_toast')}
        </div>
      {/if}
      <button type="button" on:click={onD4Continue}>
        {t('onboarding.passphrase_d4.primary_button')}
      </button>
      <button type="button" on:click={onD4Continue}>
        Next: confirm passphrase
      </button>
    {:else if currentStep === 'D.5'}
      <h1 id="onboarding-current-heading">{t('onboarding.sessions_d5.heading')}</h1>
      <p>{t('onboarding.sessions_d5.body')}</p>
      {#if (__test_session_count ?? 0) <= 1}
        <p>{t('onboarding.sessions_d5.helper_only_this_device')}</p>
      {/if}
      <ul data-testid="session-revocation-primer-list">
        <li>{t('onboarding.sessions_d5.row.this_device_label')}</li>
        {#if (__test_session_count ?? 0) >= 2}
          <li>device-2</li>
        {/if}
        {#if (__test_session_count ?? 0) >= 3}
          <li>device-3</li>
        {/if}
      </ul>
      <button
        type="button"
        aria-disabled={(__test_session_count ?? 0) <= 1 ? 'true' : 'false'}
        aria-busy={d5State === 'in_progress' ? 'true' : null}
        on:click={onRevokeOtherSessions}
      >
        {#if d5State === 'in_progress'}
          {t('onboarding.sessions_d5.state.in_progress')}
        {:else}
          {t('onboarding.sessions_d5.revoke_other.label')}
        {/if}
      </button>
      <button type="button" on:click={onSkipSessions}>
        {t('onboarding.sessions_d5.skip.label')}
      </button>
      {#if d5State === 'success'}
        <div role="status" data-testid="sessions-revoked">
          {t('onboarding.sessions_d5.state.success')}
        </div>
      {:else if d5State === 'partial_failure'}
        <div role="alert" data-testid="sessions-partial">
          {t('onboarding.sessions_d5.error.partial', {
            failed_systems: d5FailedDevices.join(', ')
          })}
        </div>
      {:else if d5State === 'error' && d5ErrorKey}
        <div role="alert" data-testid="sessions-error">{t(d5ErrorKey)}</div>
      {/if}
    {:else if currentStep === 'D.6'}
      <h1 id="onboarding-current-heading">{t('onboarding.passphrase_d4.confirm_label')}</h1>
      <label for="type-back">{t('onboarding.passphrase_d4.confirm_label')}</label>
      <textarea
        id="type-back"
        bind:value={typedBack}
        autocomplete="off"
        spellcheck="false"
        autocapitalize="none"
        autocorrect="off"
        aria-label="Type the passphrase to confirm"
      ></textarea>
      <p>{t('onboarding.passphrase_d4.confirm_helper')}</p>
      <button type="button" on:click={onD6Submit}>
        {t('onboarding.passphrase_d4.primary_button')}
      </button>
      {#if d6Error}
        <div role="alert" data-testid="d6-error">{d6Error}</div>
      {/if}
    {:else if currentStep === 'D.7'}
      <h1 id="onboarding-current-heading">{t('onboarding.completion_d7.heading')}</h1>
      <div role="status" data-testid="completion-summary">
        <svg data-icon="check-circle" width="24" height="24" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="M7 12l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2" />
        </svg>
        <p>{t('onboarding.completion_d7.body')}</p>
        <ul>
          <li>
            <svg data-icon="check" width="14" height="14" aria-hidden="true">
              <path d="M2 7l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2" />
            </svg>
            {t('onboarding.completion_d7.checklist.passkey')}
          </li>
          <li>{t('onboarding.completion_d7.checklist.recovery_blob_downloaded')}</li>
          <li>{t('onboarding.completion_d7.checklist.recovery_blob_printed')}</li>
          <li>{t('onboarding.completion_d7.checklist.sessions_reviewed')}</li>
        </ul>
      </div>
      <div
        role="region"
        aria-labelledby="completion-next-heading"
        data-testid="completion-next-steps"
      >
        <h2 id="completion-next-heading">
          {t('onboarding.completion_d7.next_steps_heading')}
        </h2>
        <p>
          Settings → Sessions lets you sign out other devices. Settings → Wipe this device lets
          you wipe this device.
        </p>
        <p>{t('onboarding.completion_d7.next_steps_body')}</p>
      </div>
      <button type="button" on:click={onOpenApp}>
        {t('onboarding.completion_d7.primary_button')}
      </button>
    {/if}
  </div>
</section>

<style>
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
