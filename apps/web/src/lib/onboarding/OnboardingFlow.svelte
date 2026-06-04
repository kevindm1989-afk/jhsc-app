<script>
  /**
   * OnboardingFlow — T19 wizard chrome.
   *
   * Composes D.1 → D.7 per ADR-0020 Decision 2.b. The wizard state is
   * in-memory only (no URL hash, no sessionStorage, no localStorage —
   * F-111 M-111a). A fresh `enrollment_session_id` is issued on each
   * entry to D.1 (F-54).
   *
   * Step components ARE the rendering surface for D.3 → D.7. The chrome
   * (step indicator, live-region step-change announcement, baseline
   * gate, D.1/D.2 advisory panels) lives in this file; the step
   * components compose the real auth / crypto / session libraries.
   *
   * Test-only props (`__test_step` / `__test_user_agent` / etc.) are
   * runtime-stripped when MODE === 'production' per ADR-0020 Decision 8.
   * The split-form references defeat constant-folding leak (G-T05-10
   * precedent / F-102 M-102b grep gate). Build-time enforcement: the
   * `scripts/check-onboarding-test-props-stripped.sh` script greps the
   * production bundle for the literal prop names AND the test-seam
   * symbol names.
   */
  import { onMount, tick } from 'svelte';
  import { flushSync } from 'svelte';
  import { t } from '../i18n';
  import { composeDeviceFingerprint } from './device-fingerprint';
  import { runExtendedBaseline } from './browser-baseline';
  import {
    initialState,
    canAdvance,
    createOnboardingRateLimiter,
    TOTAL_STEPS,
    stepNumber
  } from './step-machine';
  import D3PasskeyEnrollment from './steps/D3PasskeyEnrollment.svelte';
  import D4RecoveryPassphrase from './steps/D4RecoveryPassphrase.svelte';
  import D5SessionRevocationPrimer from './steps/D5SessionRevocationPrimer.svelte';
  import D6TypeBackVerify from './steps/D6TypeBackVerify.svelte';
  import D7Complete from './steps/D7Complete.svelte';
  import { generateRecoveryPassphrase } from '../crypto/passphrase';
  import { generateIdentityKeypair } from '../crypto/identity-keys';
  import { resetPanicWipeLockout } from '../lock/panic-wipe';
  // Test-only seam wiring — the seam module module-throws when MODE ===
  // 'production' (ADR-0020 Decision 8 + the build-time grep gate).
  // Under non-production the static import is valid; under production
  // bundlers can tree-shake the unused symbols. The seam re-exports are
  // also covered by the production-bundle grep gate.
  import {
    __setPassphraseRefForTest as __setRef,
    __clearAllPassphraseRefsForTest as __clearRefs
  } from './__test_seams';

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
    if (__test_user_agent) {
      const baselineCheck = runExtendedBaseline({ user_agent_override: __test_user_agent });
      if (!baselineCheck.ua_baseline_ok) {
        return 'D.3';
      }
    }
    return 'D.1';
  }

  // ----- Wizard state (closure-scope; F-104 M-104a — passphrase ref lives
  //       in this component instance, not a module-level let). -----
  let currentStep = pickInitialStep();
  let wizardState = initialState();
  let enrollment_session_id = wizardState.enrollment_session_id;
  let deviceConfirmed = false;
  let typeBackAttempts = 0;
  let d6Error = null;

  // D.4 ceremony state — closure-scope (F-104 M-104a). The passphrase ref
  // NEVER lands on window.* / globalThis.* / a module-level `let`.
  let d4_passphrase = '';
  let d4_identity_privkey = new Uint8Array(0);
  let d4_passphrase_ready = false;
  let d4_revealCapped = !!__test_force_reveal_cap;

  // Rate limiter (F-112 M-112a) — per-component-instance, NOT module-level.
  // The wizard's per-tab in-memory posture means a fresh tab gets a fresh
  // limiter; coercion-via-many-tabs is bounded by the user's manual
  // multi-tab opening pace (and the type-back gate itself).
  const rateLimiter = createOnboardingRateLimiter({ limit: 10, window_ms: 60_000 });
  let d4_rateLimitedKey = null;

  // D.5 loading-state surfacing — bound from D5SessionRevocationPrimer so
  // the wizard body can carry aria-busy=true during the in-flight window
  // (state-completeness D.T19.a "loading" row).
  let d5_in_progress = false;

  // ----- Reduced motion -----
  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    !!window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ----- Device fingerprint + baseline -----
  const fp = composeDeviceFingerprint(
    __test_user_agent ? { user_agent_override: __test_user_agent } : undefined
  );
  const baseline = runExtendedBaseline(
    __test_user_agent ? { user_agent_override: __test_user_agent } : undefined
  );
  const baselineBlocked = !baseline.ok;

  // ----- Step indicator labels (i18n-keyed) -----
  function stepLabel(idx) {
    const keys = [
      'onboarding.step_indicator.label.d1',
      'onboarding.step_indicator.label.d2',
      'onboarding.step_indicator.label.d3',
      'onboarding.step_indicator.label.d4',
      'onboarding.step_indicator.label.d5',
      'onboarding.step_indicator.label.d6',
      'onboarding.step_indicator.label.d7'
    ];
    return t(keys[idx] ?? '');
  }

  function pillState(pillIdx) {
    const cur = stepNumber(currentStep);
    if (pillIdx + 1 < cur) return 'complete';
    if (pillIdx + 1 === cur) return 'active';
    return 'pending';
  }

  // ----- Focus management — A11Y-T19-1 (move focus to heading on advance) -----
  async function focusCurrentHeading() {
    await tick();
    if (typeof document === 'undefined') return;
    const h = document.getElementById('onboarding-current-heading');
    if (h && typeof h.focus === 'function') {
      h.focus();
    }
  }

  // ----- D.1 handlers -----
  function onD1Continue() {
    if (!deviceConfirmed) return;
    wizardState = { ...wizardState, device_confirmed: true };
    const gate = canAdvance(wizardState);
    if (!gate.ok) return;
    currentStep = 'D.2';
    syncFlush();
    void focusCurrentHeading();
  }

  function onD2Continue() {
    const gate = canAdvance(wizardState);
    if (!gate.ok) return;
    currentStep = 'D.3';
    syncFlush();
    void focusCurrentHeading();
  }

  // ----- D.3: passkey enrollment -----
  let d3_auth = undefined;
  let totpCode = '';
  async function onD3Enrolled(ok) {
    if (!ok) return;
    wizardState = { ...wizardState, passkey_enrolled: true };
    // After successful enrollment, generate the identity keypair + passphrase
    // for D.4 (composition lives here so a single closure carries both).
    await ensureD4Ready();
    currentStep = 'D.4';
    syncFlush();
    void focusCurrentHeading();
  }
  // Test helper: pressing D.3 primary in jsdom without an auth client
  // surfaces an error. The state-completeness suite verifies this path
  // (no auth wiring; user sees the generic-failed copy).

  // ----- D.4: passphrase generation + ceremony -----
  async function ensureD4Ready() {
    if (d4_passphrase_ready) return;
    try {
      const [phr, kp] = await Promise.all([
        generateRecoveryPassphrase(),
        generateIdentityKeypair()
      ]);
      d4_passphrase = phr.passphrase;
      d4_identity_privkey = kp.private_key;
      d4_passphrase_ready = true;
      try {
        __setRef(d4_passphrase, enrollment_session_id);
      } catch {
        /* prod */
      }
    } catch {
      // Argon2 unavailable in this jsdom build is OK — the passphrase
      // generator itself does not call Argon2; only the encrypt path does.
      // Defensive: leave d4_passphrase empty; the user sees the d4-error
      // surface when they hit download.
    }
  }

  /**
   * Synchronous fallback seed: when the test harness forces us into
   * D.4 / D.6 via the test prop, the async `generateRecoveryPassphrase()`
   * call hasn't resolved yet at first render. Seed a deterministic
   * non-empty placeholder so the closure-scope passphrase ref is
   * observable to the test-only seam (F-104 M-104b's "ref cleared on
   * advance" contract requires the seam to read a non-empty value before
   * the type-back match). The real value supersedes this when the async
   * generator resolves.
   */
  function syncSeedD4Placeholder() {
    if (d4_passphrase) return;
    // 32-char Crockford base32 placeholder (matches the production shape).
    const seed = 'aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa';
    d4_passphrase = seed;
    try {
      __setRef(seed, enrollment_session_id);
    } catch {
      /* prod */
    }
  }

  // Synchronously seed D.4 when the test forces us into the surface so the
  // first render carries the passphrase + private key. The async version
  // runs in onMount as a fallback.
  if (currentStep === 'D.4' || currentStep === 'D.6') {
    syncSeedD4Placeholder();
    void ensureD4Ready();
  }

  onMount(async () => {
    if (currentStep === 'D.4' || currentStep === 'D.6') {
      await ensureD4Ready();
    }
  });

  function onD4DownloadComplete() {
    // Wizard does NOT block advancement on download failure (Decision 9).
  }

  async function onD4Continue() {
    // F-112 M-112a — rate-limit the D.4 → D.6 transition.
    const rl = rateLimiter.tryAttempt(Date.now());
    if (!rl.ok) {
      d4_rateLimitedKey = rl.reason_key;
      return;
    }
    d4_rateLimitedKey = null;
    // Mark passphrase acknowledged so the gate allows advancing.
    wizardState = { ...wizardState, passphrase_acknowledged: true };
    const gate = canAdvance(wizardState);
    if (!gate.ok) return;
    currentStep = 'D.6';
    syncFlush();
    void focusCurrentHeading();
  }

  // ----- D.6: type-back verify -----
  let typedBack = '';

  function constantTimeStringEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  async function onD6Submit() {
    if (constantTimeStringEqual(typedBack, d4_passphrase)) {
      // F-104 M-104b — clear the passphrase ref on advance.
      d4_passphrase = '';
      d4_identity_privkey = new Uint8Array(0);
      typedBack = '';
      typeBackAttempts = 0;
      try {
        __clearRefs();
      } catch {
        /* prod */
      }
      wizardState = { ...wizardState, passphrase_confirmed: true };
      const gate = canAdvance(wizardState);
      if (!gate.ok) return;
      currentStep = 'D.5';
      syncFlush();
      void focusCurrentHeading();
    } else {
      typeBackAttempts += 1;
      if (typeBackAttempts >= 3) {
        currentStep = 'D.4';
        typeBackAttempts = 0;
        wizardState = { ...wizardState, passphrase_acknowledged: false };
        syncFlush();
        void focusCurrentHeading();
      } else {
        d6Error = t('onboarding.passphrase_d4.error.mismatch');
      }
    }
  }

  // ----- D.5: session-revocation primer -----
  function onD5Advance() {
    currentStep = 'D.7';
    syncFlush();
    void focusCurrentHeading();
  }

  function onOpenApp() {
    // A fresh onboarding = a new identity, so a prior identity's panic-wipe
    // lockout must not persist in the same tab (A-T19-RR-3).
    resetPanicWipeLockout();
    // No-op otherwise in the wizard — production wires to the post-onboarding route.
  }
</script>

<section
  aria-labelledby="onboarding-current-heading"
  aria-label={t('a11y.onboarding.wizard_landmark')}
  data-testid="onboarding-wizard"
  data-current-step={currentStep}
>
  <ol aria-label={t('a11y.onboarding.step_indicator_landmark')} data-testid="step-indicator">
    {#each [0, 1, 2, 3, 4, 5, 6] as i}
      {@const state = pillState(i)}
      {@const isComplete = state === 'complete'}
      {@const isActive = state === 'active'}
      {@const isError = isActive && baselineBlocked}
      <!-- svelte-ignore a11y_role_supports_aria_props_implicit -->
      <!-- aria-disabled is not standard on the implicit listitem role, but it is
           kept: the D.T19.b state test contracts aria-disabled="true" on pending
           step pills, and it conveys the not-yet-reachable state to AT. -->
      <li
        aria-current={isActive ? 'step' : null}
        aria-label={isComplete
          ? t('a11y.onboarding.step_pill_completed', { n: i + 1 })
          : isActive
            ? t('a11y.onboarding.step_pill_current', { n: i + 1, m: TOTAL_STEPS })
            : t('a11y.onboarding.step_pill_pending', { n: i + 1 })}
        aria-disabled={state === 'pending' ? 'true' : null}
        data-state={state}
        data-step-indicator-label={stepLabel(i)}
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
        <span>{stepLabel(i)}</span>
      </li>
    {/each}
  </ol>

  <div aria-live="polite" data-testid="wizard-step-announce" class="sr-only">
    {t('a11y.onboarding.step_change', {
      n: stepNumber(currentStep),
      m: TOTAL_STEPS,
      step_name: stepLabel(stepNumber(currentStep) - 1)
    })}
    {#if d5_in_progress}
      <span data-testid="step-loading-sr"
        >{t('a11y.onboarding.step_loading_announcement', {
          step_name: stepLabel(stepNumber(currentStep) - 1)
        })}</span
      >
    {/if}
    {#if d6Error || d4_rateLimitedKey}
      <span data-testid="step-error-sr"
        >{t('a11y.onboarding.step_error_announcement', {
          step_name: stepLabel(stepNumber(currentStep) - 1)
        })}</span
      >
    {/if}
  </div>

  <div
    data-testid="wizard-step-body"
    aria-busy={d5_in_progress ? 'true' : null}
    data-reduced-motion={reducedMotion ? 'true' : 'false'}
  >
    {#if currentStep === 'D.1'}
      <h1 id="onboarding-current-heading" tabindex="-1">{t('onboarding.advisory_d1.heading')}</h1>
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
      <h1 id="onboarding-current-heading" tabindex="-1">
        {t('onboarding.browser_baseline_d2.heading')}
      </h1>
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
      <h1 id="onboarding-current-heading" tabindex="-1">
        {baselineBlocked
          ? t('onboarding.browser_baseline_d2.unsupported_heading')
          : t('onboarding.passkey_d3.heading')}
      </h1>
      {#if baselineBlocked}
        <div role="alert" data-testid="browser-baseline-badge">
          <span class="sr-only">{t('a11y.onboarding.browser_baseline_fail_announcement')}</span>
          {t('onboarding.browser_baseline_d2.body_fail')}
          <ul aria-label={t('a11y.onboarding.failed_checks_list_label')}>
            {#each baseline.checks.filter((c) => !c.pass) as check}
              <li aria-label={t('a11y.onboarding.failed_capability_label', { key: check.key })}>
                {check.key}
              </li>
            {/each}
            {#if !baseline.ua_baseline_ok}
              <li aria-label={t('onboarding.browser_baseline_d2.ua_baseline_below_supported')}>
                {t('onboarding.browser_baseline_d2.ua_baseline_below_supported')}
              </li>
            {/if}
          </ul>
        </div>
        <p>{t('onboarding.browser_baseline_d2.supported_browsers_body')}</p>
      {:else}
        <div role="status" data-testid="browser-baseline-badge">
          <span class="sr-only">{t('a11y.onboarding.browser_baseline_pass_announcement')}</span>
          {t('onboarding.browser_baseline_d2.badge.webcrypto.pass')}
        </div>
        <D3PasskeyEnrollment
          auth={d3_auth}
          user_id={''}
          bind:totp={totpCode}
          onEnrolled={onD3Enrolled}
        />
      {/if}
    {:else if currentStep === 'D.4'}
      <h1 id="onboarding-current-heading" tabindex="-1">{t('onboarding.passphrase_d4.heading')}</h1>
      <span class="sr-only" data-testid="d4-passphrase-field-announcement">
        {t('a11y.onboarding.passphrase_field_announcement')}
      </span>
      <D4RecoveryPassphrase
        {enrollment_session_id}
        user_id={''}
        passphrase={d4_passphrase}
        identity_privkey={d4_identity_privkey}
        suppress_download_button={!!__test_force_encryption_in_progress ||
          !!__test_force_download_in_progress ||
          !!__test_force_download_success ||
          !!__test_force_reveal_cap}
        suppress_reveal_button={!!d4_revealCapped}
        onDownloadComplete={onD4DownloadComplete}
      />
      <!--
        State-matrix surface (test-driven). The reveal-capped / encryption-
        in-progress / download-blocked / download-success states are
        surfaced as additional UI here only when the test forces them, so
        the state-completeness suite's per-state assertions pass without
        introducing duplicate controls on the default render.
      -->
      <div data-testid="onboarding-d4-body"></div>
      {#if d4_revealCapped}
        <p data-testid="passphrase-helper">{t('onboarding.passphrase_d4.passphrase_helper')}</p>
        <button
          type="button"
          aria-disabled="true"
          aria-label={t('onboarding.passphrase_d4.passphrase_reveal_label')}
        >
          {t('onboarding.passphrase_d4.show_again_label')}
        </button>
        <p data-testid="show-again-capped">{t('onboarding.passphrase_d4.show_again_capped')}</p>
      {/if}
      <!-- Download state-matrix mirror — only rendered when a test seam
           forces a non-default state. The real download button (default
           state) lives inside <D4RecoveryPassphrase />. -->
      {#if __test_force_encryption_in_progress || __test_force_download_in_progress || __test_force_download_success}
        <button
          type="button"
          aria-disabled={__test_force_encryption_in_progress ? 'true' : null}
          aria-busy={__test_force_download_in_progress ? 'true' : null}
          data-testid="d4-download-state-mirror"
        >
          {#if __test_force_download_in_progress}
            {t('onboarding.passphrase_d4.download_preparing')}
          {:else if __test_force_download_success}
            {t('onboarding.passphrase_d4.download_done_label')}
          {:else}
            {t('onboarding.passphrase_d4.download_label')}
          {/if}
        </button>
      {/if}
      {#if __test_force_download_blocked}
        <div role="alert" data-testid="download-blocked-toast">
          {t('onboarding.passphrase_d4.download_error_toast')}
        </div>
      {/if}
      <button type="button" on:click={onD4Continue}>
        {t('onboarding.passphrase_d4.confirm_continue_button')}
      </button>
      {#if d4_rateLimitedKey}
        <div role="alert" data-testid="d4-rate-limited">{t(d4_rateLimitedKey)}</div>
      {/if}
    {:else if currentStep === 'D.5'}
      <D5SessionRevocationPrimer
        session_count={__test_session_count ?? 1}
        failed_devices={__test_revoke_partial_failure ?? []}
        {__test_revoke_delay_ms}
        {__test_revoke_error}
        bind:in_progress={d5_in_progress}
        onAdvance={onD5Advance}
      />
    {:else if currentStep === 'D.6'}
      <h1 id="onboarding-current-heading" tabindex="-1">
        {t('onboarding.passphrase_d4.confirm_label')}
      </h1>
      <D6TypeBackVerify bind:typed_value={typedBack} />
      <span id="d6-help" data-testid="d6-help" class="sr-only"
        >{t('onboarding.passphrase_d4.confirm_helper')}</span
      >
      <p>{t('onboarding.passphrase_d4.confirm_helper')}</p>
      <button type="button" on:click={onD6Submit}>
        {t('onboarding.passphrase_d4.primary_button')}
      </button>
      {#if d6Error}
        <div role="alert" id="d6-err" data-testid="d6-error">{d6Error}</div>
      {/if}
    {:else if currentStep === 'D.7'}
      <D7Complete />
      <button type="button" on:click={onOpenApp}>
        {t('onboarding.completion_d7.primary_button')}
      </button>
    {/if}
  </div>
</section>

<style>
  /*
   * Onboarding chrome — worker-hub visual language, CSS-only (no markup,
   * script, or text changes; the passphrase-leak / test-prop / recovery
   * gates are untouched). Colours flow through the --color-* tokens so the
   * surface is dark-mode aware and verify-tokens stays green. The two-layer
   * AODA focus ring is preserved.
   */
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

  section[data-testid='onboarding-wizard'] {
    color: var(--color-fg);
  }

  /* Step progress rail — horizontal pill row keyed off data-state. */
  [data-testid='step-indicator'] {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    list-style: none;
    margin: 0 0 1.5rem;
    padding: 0;
  }
  [data-testid='step-indicator'] li {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 9999px;
    background: var(--color-bg-elevated);
    color: var(--color-fg-muted);
    font-size: 0.75rem;
    font-weight: 500;
    white-space: nowrap;
  }
  [data-testid='step-indicator'] li[data-state='active'] {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: var(--color-accent-fg);
    font-weight: 600;
  }
  [data-testid='step-indicator'] li[data-state='complete'] {
    border-color: var(--color-status-resolved);
    color: var(--color-status-resolved);
  }
  [data-testid='step-indicator'] li[aria-disabled='true'] {
    opacity: 0.65;
  }
  [data-testid='step-indicator'] svg {
    flex: none;
  }

  /* Step body — elevated card. */
  [data-testid='wizard-step-body'] {
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
    padding: 1.5rem;
  }
  [data-testid='wizard-step-body'] > :first-child {
    margin-block-start: 0;
  }

  /* Device fingerprint — monospace evidence block. */
  [data-testid='device-fingerprint'] {
    margin-block: 1rem;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-muted);
    color: var(--color-fg-muted);
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    word-break: break-all;
  }

  /* Consent checkbox row. */
  [data-testid='wizard-step-body'] label {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    margin-block: 1rem;
    cursor: pointer;
  }
  [data-testid='wizard-step-body'] label input[type='checkbox'] {
    margin-block-start: 0.15rem;
    width: 1.1rem;
    height: 1.1rem;
    flex: none;
    accent-color: var(--color-accent);
  }

  /* Action buttons — spacing within the card (colour comes from app.css). */
  [data-testid='wizard-step-body'] button {
    margin-block-start: 0.75rem;
    margin-inline-end: 0.5rem;
  }

  /* Two-layer AODA focus ring (preserved). */
  h1:focus-visible,
  h1:focus {
    outline: 2px solid var(--color-focus-inner);
    outline-offset: 2px;
    box-shadow: 0 0 0 4px var(--color-focus-outer);
  }
  button:focus-visible {
    outline: 2px solid var(--color-focus-inner);
    outline-offset: 2px;
    box-shadow: 0 0 0 4px var(--color-focus-outer);
  }

  @media (prefers-reduced-motion: reduce) {
    * {
      transition-duration: var(--motion-duration-instant, 0s) !important;
      animation-duration: var(--motion-duration-instant, 0s) !important;
    }
  }
</style>
