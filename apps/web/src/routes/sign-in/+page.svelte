<script>
  /**
   * /sign-in — production mount for the mint-session sign-in flow
   * (T19.1 / ADR-0023).
   *
   * Wiring (closes the chain from PRs #43 → #46 → #51 → #52 → #53):
   *   1. Construct a SupabaseMintSessionClient via
   *      createSupabaseMintSessionClient (factory hard-wires
   *      Authorization-header omission + no F-39 revocation hook —
   *      see mint-session-client-factory.ts header).
   *   2. The user clicks "Sign in with passkey" → `signIn` handler.
   *   3. signInViaMintSession orchestrates:
   *        challenge → webauthnGetAssertion → assertCredential → setJwt.
   *      The `setJwt` call here is THE moment all four Edge Function
   *      factories' lazy getJwt() start seeing a real bearer for the
   *      first time in production.
   *   4. On success, `setJwt(token)` fires which updates the
   *      underlying session-jwt-store; the `$isSignedIn` Svelte
   *      readable store (from `$lib/auth/session-jwt-svelte`) flips
   *      to true and the UI swaps to the success state with a
   *      /settings link.
   *
   * Reactive JWT state (parity with /settings + landing): consumes
   * the `$isSignedIn` Svelte readable wrapper (introduced PR #63,
   * this route migrated PR #64). A user with an existing session who
   * lands on /sign-in sees the "already signed in" affordance instead
   * of a second-ceremony button. The same store flips back to the
   * idle state if an external channel (panic-wipe post-cleanup, 401
   * from another tab's t07-op call, cross-tab sign-out broadcast,
   * future server-side revoke) clears the JWT.
   *
   * Origin / rpId resolution: read at click time from `window.location`.
   * SSR is disabled (+page.ts) so window is always defined when the
   * handler runs. The rpId is derived from `location.hostname` — for
   * production deployments under a single registrable domain this is
   * correct (e.g. `jhsc.example` for the page served at
   * https://app.jhsc.example/sign-in). Multi-subdomain deployments
   * need an explicit rpId per ADR-0002, which is a follow-up the
   * deployment-config layer handles.
   *
   * NOTE: no `lang="ts"` — same reason as /onboarding/+page.svelte
   * and /settings/+page.svelte: the route is a thin wiring shell, and
   * dropping `lang="ts"` keeps svelte-check's strict implicit-any path
   * uniform with the rest of the route layer.
   */
  import { env } from '$env/dynamic/public';
  import { t } from '$lib/i18n';
  import { setJwt } from '../../lib/auth/session-jwt-store';
  import { isSignedIn } from '../../lib/auth/session-jwt-svelte';
  import { signInViaMintSession } from '../../lib/auth/sign-in-flow';
  import { webauthnGetAssertion } from '../../lib/auth/webauthn-assertion';
  import { createSupabaseMintSessionClient } from '../../lib/server-client/mint-session-client-factory';

  const baseUrl = env.PUBLIC_SUPABASE_URL ?? 'http://localhost:54321';
  const client = createSupabaseMintSessionClient({ baseUrl });

  // Local ceremony state machine:
  //   'idle' | 'signing-in' | 'cancelled' | 'failed'
  // The "signed-in" terminal state lives in the reactive `$isSignedIn`
  // store (from the Svelte wrapper over session-jwt-store, introduced
  // in PR #63) — derived from the JWT store rather than this local
  // machine, so any external clear flips back to idle uniformly.
  let state = 'idle';
  let lastError = '';
  let sessionId = '';

  // Closed allowlist of friendly-reason catalog keys we'll resolve
  // via t(). Anything outside this set falls through to the generic
  // `signIn.reason.unknown` message — defends against t() being
  // handed an attacker-influenced reason code (today the codes come
  // from the SupabaseMintSessionClient's MintSessionReason union, but
  // pinning the allowlist makes the contract explicit and dynamic
  // catalog-key resolution safe).
  const KNOWN_REASONS = new Set([
    'bad_request',
    'assertion_invalid',
    'unknown_credential',
    'mint_failed'
  ]);

  // `friendlyError` resolves the raw `lastError` reason code (e.g.
  // 'assertion_invalid') through the i18n catalog to a user-facing
  // sentence like "Your passkey couldn't be verified. Try again…".
  // Without this mapping, /sign-in's failed state rendered raw
  // server enum values to end users.
  $: friendlyError =
    state === 'failed'
      ? KNOWN_REASONS.has(lastError)
        ? t(`signIn.reason.${lastError}`)
        : t('signIn.reason.unknown')
      : '';

  // Reset the stale success message when the JWT clears via any
  // channel (panic-wipe post-cleanup, 401 from another tab's t07-op
  // call, cross-tab sign-out broadcast, future server-side revoke).
  // Reactively tracks `$isSignedIn` flipping false through the
  // session-jwt-svelte wrapper.
  $: if (!$isSignedIn) sessionId = '';

  async function signIn() {
    if (state === 'signing-in' || $isSignedIn) return;
    state = 'signing-in';
    lastError = '';
    sessionId = '';

    const origin = window.location.origin;
    const rpId = window.location.hostname;

    const result = await signInViaMintSession({
      client,
      rpId,
      origin,
      getAssertion: (challenge) => webauthnGetAssertion({ challenge, rpId }),
      setJwt
    });

    if (result.status === 'ok') {
      // `$isSignedIn` flips via the session-jwt-svelte wrapper above
      // (setJwt updates the underlying store; the wrapper notifies
      // the auto-subscribed template). We just capture the session_id
      // so the success message can distinguish "just signed in" from
      // "already signed in".
      sessionId = result.session_id;
      state = 'idle';
      return;
    }
    if (result.status === 'cancelled') {
      state = 'cancelled';
      return;
    }
    // failed
    lastError = result.reason;
    state = 'failed';
  }
</script>

<svelte:head>
  <title>{t('signIn.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section aria-busy={state === 'signing-in' ? 'true' : 'false'}>
  <!--
    `aria-busy` mirrors the form-level pattern from ConcernIntakeForm
    + ReprisalIntakeForm: while the WebAuthn ceremony is in flight
    (state === 'signing-in'), the section announces itself as busy so
    AT users get a "loading" announcement on update. There is no
    <form> element on this route (the ceremony is a single button
    click that opens the OS WebAuthn modal), so the <section> is the
    nearest analog. The aria-busy attribute only meaningfully applies
    while the {:else} branch (the button + status messages) is
    rendered; in the signed-in branch ($isSignedIn === true) the
    state machine is back to 'idle' so aria-busy reads 'false'.
  -->
  <h1>{t('signIn.title')}</h1>

  {#if $isSignedIn}
    {#if sessionId}
      <!--
        `role="status"` makes the success message a polite live region
        so screen readers announce "Session established …" when the
        WebAuthn ceremony resolves OK. Without this, an SR user has
        to navigate to the paragraph to hear the outcome — the same
        a11y gap the cancelled / failed paths already avoid via
        `role="alert"` (assertive). Success uses `status` (polite)
        instead of `alert` (assertive) because the transition is
        expected by the user and doesn't need to interrupt.
      -->
      <p role="status" data-testid="sign-in-success">
        {t('signIn.success', { sessionId })}
      </p>
    {:else}
      <p data-testid="sign-in-already-signed-in">{t('signIn.already_signed_in')}</p>
    {/if}
    <p>
      <a href="/settings" data-testid="sign-in-go-to-settings">{t('signIn.go_to_settings_cta')}</a>
    </p>
  {:else}
    <p>{t('signIn.intro')}</p>

    <button
      type="button"
      on:click={signIn}
      disabled={state === 'signing-in'}
      data-testid="sign-in-button"
    >
      {#if state === 'signing-in'}
        {t('signIn.button.signing_in')}
      {:else}
        {t('signIn.button.idle')}
      {/if}
    </button>

    {#if state === 'cancelled'}
      <!--
        `role="status"` (polite) — the cancellation was user-initiated
        (they closed the WebAuthn prompt or hit Escape), not a server
        error. The user already knows what they did; a polite live-
        region announcement is enough. role="alert" (assertive) is
        reserved for the `failed` state below where the system rejects
        the user's action.
      -->
      <p role="status" data-testid="sign-in-cancelled">{t('signIn.cancelled')}</p>
    {/if}

    {#if state === 'failed'}
      <p role="alert" data-testid="sign-in-failed">
        {friendlyError}
      </p>
    {/if}
  {/if}
</section>
