<script>
  /**
   * RedeemCard — the renderable /redeem member-invite redemption surface
   * (ADR-0029 P1-7 / Surface J).
   *
   * The unauthenticated, REPEATABLE sibling of /bootstrap's ceremony, with the
   * /sign-in state machine's role/aria-busy discipline. A brand-new member opens
   * /redeem?invite_id=… (the link carries invite_id ONLY — the 6-digit code is
   * member-ENTERED, never in the URL, F-170/F-176), enters their one-time code,
   * and runs the WebAuthn REGISTRATION ceremony to bind their first passkey and
   * activate their pending membership. On success it forwards to /sign-in (a hard
   * seam — /redeem never runs sign-in / identity-enroll / recovery itself).
   *
   * Injection (REAL Svelte props with production-safe defaults; NO __test_* per
   * ADR-0020 Decision 8):
   *   - inviteId    — the route passes this from ?invite_id=.
   *   - transport   — the challenge/register EF transport seam; production wires
   *                   a fetch to /functions/v1/redeem-invite (the route shell).
   *   - credentials — a CredentialsContainer; defaults to navigator.credentials.
   *   - navigate    — the /sign-in forward; defaults to a real location assign.
   *
   * The ceremony itself is the EXTRACTED redeemViaProduction orchestrator
   * (Amendment A-7.4); this component is the thin caller that owns the visible
   * state machine + the a11y packet (focus, live-region roles, aria-busy,
   * aria-describedby error association, color-never-alone icons).
   *
   * F-170/F-176 invariants enforced here:
   *   - the 6-digit code lives ONLY in the field + the register POST body — never
   *     a URL, never sessionStorage/localStorage, never a log.
   *   - the 422 redeem_invalid collapses to ONE message (no sub-condition split).
   *   - the returned user_id is NEVER rendered (operator-only).
   *   - no console.* / log of the code or user_id.
   */
  import { onMount, tick } from 'svelte';
  import { t } from '$lib/i18n';
  import { redeemViaProduction } from './redeem-flow';

  /** @type {string} The opaque invite id from the link (?invite_id=). NOT secret. */
  export let inviteId = '';
  /** @type {(body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>} */
  export let transport;
  /** @type {CredentialsContainer} */
  export let credentials =
    typeof navigator !== 'undefined' ? navigator.credentials : /** @type {any} */ (undefined);
  /** @type {(path: string) => void} */
  export let navigate = (path) => {
    if (typeof window !== 'undefined') window.location.assign(path);
  };

  // Surface J state machine. Terminal states layer over the one card/form.
  //   'idle' | 'requesting_challenge' | 'awaiting_ceremony' | 'verifying'
  //   | 'ok' | 'invalid' | 'rate_limited' | 'cancelled' | 'unsupported'
  //   | 'system_error'
  let state = 'idle';
  let code = '';

  // Stable ids for the label/helper/error aria-describedby association.
  const inputId = 'redeem-code';
  const helperId = 'redeem-code-helper';
  const errorId = 'redeem-error-banner';

  /** @type {HTMLInputElement|null} */
  let inputEl = null;
  /** @type {HTMLButtonElement|null} */
  let submitEl = null;
  /** @type {HTMLElement|null} */
  let errorHeadingEl = null;
  /** @type {HTMLElement|null} */
  let successHeadingEl = null;

  $: inFlight =
    state === 'requesting_challenge' || state === 'awaiting_ceremony' || state === 'verifying';
  // The error-banner id is appended to the input's aria-describedby ONLY for the
  // field-level normalized invalid error (so an SR user re-focusing the field
  // hears it); the helper id is always retained (never replaced).
  $: describedBy = state === 'invalid' ? `${helperId} ${errorId}` : helperId;

  const incomplete = () => !inviteId || inviteId.trim().length === 0;

  onMount(() => {
    // Surface J: initial focus on the code field (skip when the link is
    // incomplete — there is no field then).
    if (!incomplete() && inputEl) inputEl.focus();
  });

  /** @param {string} b64url → bytes (mirror /bootstrap). */
  function fromBase64Url(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  /** @param {ArrayBuffer|Uint8Array} buf → base64url (mirror /bootstrap). */
  function toBase64Url(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * The WebAuthn registration ceremony callback handed to redeemViaProduction.
   * It performs the visible state transitions (awaiting → verifying) AROUND the
   * platform credentials.create call, so the "follow your device prompt" note is
   * in the DOM BEFORE the OS dialog opens (Surface J §3.1). A cancel surfaces as
   * a thrown NotAllowedError/AbortError or a null credential — redeemViaProduction
   * maps both to 'cancelled'.
   *
   * @param {string} challenge
   */
  async function runCeremony(challenge) {
    state = 'awaiting_ceremony';
    // Let the waiting note paint BEFORE create() opens the OS dialog.
    await tick();

    // rpId binds the credential's rp.id to the live host (WebAuthn restriction,
    // mirror /bootstrap). origin/rpId for the wire calls are derived once in
    // submit() and threaded through redeemViaProduction.
    const rpId = window.location.hostname;
    const userHandle = new Uint8Array(16);
    crypto.getRandomValues(userHandle);

    const cred = /** @type {PublicKeyCredential|null} */ (
      await credentials.create({
        publicKey: {
          challenge: fromBase64Url(challenge),
          rp: { name: 'JHSC', id: rpId },
          user: { id: userHandle, name: 'committee-member', displayName: 'Committee member' },
          // ES256 (-7) preferred; RS256 (-257) accepted (server enforces the set).
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 }
          ],
          authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
          attestation: 'none',
          timeout: 60_000
        }
      })
    );
    if (!cred) return null; // user dismissed → cancelled

    state = 'verifying';
    const att = /** @type {AuthenticatorAttestationResponse} */ (cred.response);
    return {
      credentialId: cred.id,
      attestationObject: toBase64Url(att.attestationObject),
      clientDataJSON: toBase64Url(att.clientDataJSON),
      transports: typeof att.getTransports === 'function' ? att.getTransports() : []
    };
  }

  async function submit() {
    if (inFlight || incomplete()) return;

    // Feature-detect WebAuthn BEFORE the challenge call (Surface J: no transport
    // hit on an unsupported device).
    if (typeof globalThis.PublicKeyCredential === 'undefined') {
      state = 'unsupported';
      await focusErrorHeading();
      return;
    }

    state = 'requesting_challenge';
    const origin = window.location.origin;
    const rpId = window.location.hostname;

    const result = await redeemViaProduction({
      transport,
      rpId,
      origin,
      inviteId,
      totpCode: code,
      deviceLabel: 'member-redeem',
      runCeremony
    });

    if (result.status === 'ok') {
      // F-176: the returned user_id is NEVER captured into render state.
      state = 'ok';
      await focusSuccessHeading();
      return;
    }
    if (result.status === 'cancelled') {
      state = 'cancelled';
      await tick();
      if (submitEl) submitEl.focus();
      return;
    }
    if (result.status === 'redeem_invalid') {
      state = 'invalid';
      await focusErrorHeading();
      return;
    }
    if (result.status === 'rate_limited') {
      state = 'rate_limited';
      await focusErrorHeading();
      return;
    }
    state = 'system_error';
    await focusErrorHeading();
  }

  async function focusErrorHeading() {
    await tick();
    if (errorHeadingEl) errorHeadingEl.focus();
  }
  async function focusSuccessHeading() {
    await tick();
    if (successHeadingEl) successHeadingEl.focus();
  }

  /** @param {SubmitEvent} e */
  function onSubmit(e) {
    e.preventDefault();
    submit();
  }
</script>

<svelte:head>
  <title>{t('redeem.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card redeem-card">
  <h1>{t('redeem.title')}</h1>

  {#if incomplete()}
    <!--
      Incomplete link (missing invite_id) — a graceful state, NOT a crash and
      NOT a ceremony attempt. The member opened a truncated link.
    -->
    <div class="panel panel-danger" role="alert" data-testid="redeem-incomplete-link">
      <svg
        class="panel-icon"
        viewBox="0 0 24 24"
        aria-hidden="true"
        data-testid="redeem-incomplete-link-icon"
      >
        <path
          d="M12 8v5m0 3h.01M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0z"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <div>
        <h2 class="panel-heading">{t('redeem.incomplete_link.heading')}</h2>
        <p class="panel-body">{t('redeem.incomplete_link.body')}</p>
      </div>
    </div>
  {:else}
    <p class="muted">{t('redeem.intro')}</p>

    <!--
      aria-busy mirrors the /sign-in form-level pattern: while the ceremony is in
      flight the container announces itself busy so AT users get a loading hint.
    -->
    <div
      class="redeem-ceremony"
      data-testid="redeem-ceremony"
      aria-busy={inFlight ? 'true' : 'false'}
    >
      {#if state !== 'ok'}
        <form on:submit={onSubmit} novalidate>
          <label for={inputId} class="field-label">{t('redeem.code_label')}</label>
          <input
            bind:this={inputEl}
            bind:value={code}
            id={inputId}
            class="totp-input"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            aria-describedby={describedBy}
            disabled={inFlight}
            data-testid="redeem-code-input"
          />
          <p id={helperId} class="field-helper">{t('redeem.code_helper')}</p>

          <button
            bind:this={submitEl}
            type="submit"
            class="redeem-primary"
            disabled={inFlight || state === 'unsupported'}
            data-testid="redeem-submit"
          >
            {#if state === 'requesting_challenge'}
              <svg class="spinner" viewBox="0 0 24 24" aria-hidden="true">
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                  opacity="0.25"
                />
                <path
                  d="M22 12a10 10 0 0 1-10 10"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                  stroke-linecap="round"
                />
              </svg>
              {t('redeem.button.requesting')}
            {:else if state === 'awaiting_ceremony' || state === 'verifying'}
              <svg class="spinner" viewBox="0 0 24 24" aria-hidden="true">
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                  opacity="0.25"
                />
                <path
                  d="M22 12a10 10 0 0 1-10 10"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                  stroke-linecap="round"
                />
              </svg>
              {t('redeem.button.verifying')}
            {:else}
              {t('redeem.button.idle')}
            {/if}
          </button>
        </form>
      {/if}

      {#if state === 'awaiting_ceremony'}
        <!-- Polite: the OS dialog is up; do not interrupt. Rendered BEFORE
             create() opens the dialog (Surface J §3.1 / a11y test). -->
        <p class="waiting" role="status" aria-live="polite" data-testid="redeem-waiting">
          {t('redeem.waiting')}
        </p>
      {/if}

      {#if state === 'requesting_challenge' || state === 'verifying'}
        <!-- WCAG 4.1.3 (a11y review Finding 1): the pre-dialog (requesting) and
             post-dialog (verifying) phases each get a phase-specific polite
             announcement, mutually exclusive with the visible "follow your
             device prompt" note above (no double-announce). SR-only — the
             button label + aria-busy carry the visible signal. -->
        <p class="sr-only" role="status" aria-live="polite" data-testid="redeem-progress">
          {state === 'requesting_challenge'
            ? t('a11y.redeem.requesting')
            : t('a11y.redeem.verifying')}
        </p>
      {/if}
    </div>

    {#if state === 'ok'}
      <div class="panel panel-success" role="status" data-testid="redeem-success">
        <svg
          class="panel-icon"
          viewBox="0 0 24 24"
          aria-hidden="true"
          data-testid="redeem-success-icon"
        >
          <path
            d="M20 6 9 17l-5-5"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <div>
          <h2
            class="panel-heading"
            tabindex="-1"
            bind:this={successHeadingEl}
            data-testid="redeem-success-heading"
          >
            {t('redeem.success.heading')}
          </h2>
          <p class="panel-body">{t('redeem.success.body')}</p>
          <!--
            A REAL anchor (keyboard + SR operable; the hard seam to /sign-in).
            on:click delegates to the injected `navigate` for SPA-router
            environments + testability; the href is the no-JS fallback. Both the
            tag (`a`) and the href (`/sign-in`) are load-bearing (Surface J).
          -->
          <a
            href="/sign-in"
            class="cta redeem-cta"
            data-testid="redeem-success-cta"
            on:click={() => navigate('/sign-in')}
          >
            {t('redeem.success.cta')}
          </a>
        </div>
      </div>
    {/if}

    {#if state === 'invalid'}
      <div class="panel panel-danger" role="alert" id={errorId} data-testid="redeem-error">
        <svg
          class="panel-icon"
          viewBox="0 0 24 24"
          aria-hidden="true"
          data-testid="redeem-error-icon"
        >
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
          <path
            d="m15 9-6 6m0-6 6 6"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
        <div>
          <h2
            class="panel-heading"
            tabindex="-1"
            bind:this={errorHeadingEl}
            data-testid="redeem-error-heading"
          >
            {t('redeem.error.invalid.heading')}
          </h2>
          <p class="panel-body">{t('redeem.error.invalid.body')}</p>
        </div>
      </div>
    {/if}

    {#if state === 'rate_limited'}
      <div class="panel panel-warning" role="alert" data-testid="redeem-rate-limited">
        <svg
          class="panel-icon"
          viewBox="0 0 24 24"
          aria-hidden="true"
          data-testid="redeem-rate-limited-icon"
        >
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
          <path
            d="M12 7v5l3 2"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <div>
          <h2 class="panel-heading" tabindex="-1" bind:this={errorHeadingEl}>
            {t('redeem.error.rate_limited.heading')}
          </h2>
          <p class="panel-body">{t('redeem.error.rate_limited.body')}</p>
        </div>
      </div>
    {/if}

    {#if state === 'system_error'}
      <div class="panel panel-danger" role="alert" data-testid="redeem-system-error">
        <svg
          class="panel-icon"
          viewBox="0 0 24 24"
          aria-hidden="true"
          data-testid="redeem-system-error-icon"
        >
          <path
            d="M12 8v5m0 3h.01M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0z"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <div>
          <h2 class="panel-heading" tabindex="-1" bind:this={errorHeadingEl}>
            {t('redeem.error.system.heading')}
          </h2>
          <p class="panel-body">{t('redeem.error.system.body')}</p>
        </div>
      </div>
    {/if}

    {#if state === 'unsupported'}
      <div class="panel panel-danger" role="alert" data-testid="redeem-unsupported">
        <svg
          class="panel-icon"
          viewBox="0 0 24 24"
          aria-hidden="true"
          data-testid="redeem-unsupported-icon"
        >
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
          <path
            d="m15 9-6 6m0-6 6 6"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
        <div>
          <h2 class="panel-heading" tabindex="-1" bind:this={errorHeadingEl}>
            {t('redeem.error.unsupported.heading')}
          </h2>
          <p class="panel-body">{t('redeem.error.unsupported.body')}</p>
        </div>
      </div>
    {/if}

    {#if state === 'cancelled'}
      <!-- Polite: the cancellation was user-initiated; do not interrupt. -->
      <p class="panel panel-neutral" role="status" data-testid="redeem-cancelled">
        {t('redeem.cancelled')}
      </p>
    {/if}
  {/if}
</section>

<style>
  /*
   * Surface J redeem card. Single centered card; the form + the in-flight /
   * terminal states layer over it. All colour / radius / shadow come from the
   * app's CSS-variable token palette (app.html boot sheet); the two-layer AODA
   * focus ring is inherited from app.css :focus-visible. Reduced-motion zeros the
   * spinner animation globally (app.html @media prefers-reduced-motion).
   */
  .redeem-card {
    max-width: 35rem;
    margin-inline: auto;
  }

  .field-label {
    display: block;
    margin-block-start: 1rem;
    margin-block-end: 0.375rem;
    color: var(--color-fg);
    font-weight: 500;
  }
  .field-helper {
    margin-block: 0.375rem 0;
    color: var(--color-fg-muted);
    font-size: 0.875rem;
  }

  /* TOTP input — large tabular mono, mirrors D3PasskeyEnrollment. */
  .totp-input {
    display: block;
    width: 100%;
    max-width: 16rem;
    padding: 0.625rem 0.75rem;
    border: var(--border-width-default) solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-family: var(--font-mono);
    font-size: 1.0625rem;
    letter-spacing: 0.1em;
  }
  .totp-input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .redeem-primary {
    margin-block-start: 1rem;
    background: var(--color-accent);
    color: var(--color-accent-fg);
    border-color: var(--color-accent);
  }
  .redeem-primary:hover:not(:disabled) {
    background: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
    opacity: 1;
  }

  .spinner {
    width: 1rem;
    height: 1rem;
    flex: none;
    animation: redeem-spin 0.9s linear infinite;
  }
  @keyframes redeem-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .waiting {
    margin-block-start: 0.75rem;
    color: var(--color-fg-muted);
  }

  /* Visually-hidden polite live region (mirrors D5SessionRevocationPrimer). */
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

  .redeem-cta {
    margin-block-start: 0.75rem;
  }

  /* Tinted state panels (icon + text — colour never alone, anti-pattern 3). */
  .panel {
    display: flex;
    gap: 0.625rem;
    align-items: flex-start;
    margin-block-start: 1rem;
    padding: 0.75rem 1rem;
    border: var(--border-width-default) solid transparent;
    border-radius: var(--radius-md);
  }
  .panel-icon {
    width: 1.25rem;
    height: 1.25rem;
    flex: none;
    margin-block-start: 0.125rem;
  }
  .panel-heading {
    margin: 0;
    font-size: 1rem;
  }
  .panel-body {
    margin-block: 0.25rem 0;
  }
  .panel-success {
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
    border-color: var(--color-tint-green-border);
  }
  .panel-danger {
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-color: var(--color-tint-red-border);
  }
  .panel-warning {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-color: var(--color-tint-amber-border);
  }
  .panel-neutral {
    background: var(--color-tint-neutral-bg);
    color: var(--color-tint-neutral-fg);
    border-color: var(--color-tint-neutral-border);
  }
</style>
