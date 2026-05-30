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
   *   4. On success, `setJwt(token)` fires which triggers the
   *      subscribeToJwt subscriber below — `isSignedIn` flips to true
   *      and the UI swaps to the success state with a /settings link.
   *
   * Reactive JWT state (parity with /settings, PR #58): the route
   * subscribes to the session-jwt-store at mount, so a user with an
   * existing session who lands on /sign-in sees the "already signed
   * in" affordance instead of a second-ceremony button. The same
   * subscriber also flips back to the idle state if an external
   * channel (panic-wipe post-cleanup, 401 from another tab's
   * t07-op call, future server-side revoke) clears the JWT.
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
  import { onDestroy } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { t } from '$lib/i18n';
  import { getJwt, setJwt, subscribeToJwt } from '../../lib/auth/session-jwt-store';
  import { signInViaMintSession } from '../../lib/auth/sign-in-flow';
  import { webauthnGetAssertion } from '../../lib/auth/webauthn-assertion';
  import { createSupabaseMintSessionClient } from '../../lib/server-client/mint-session-client-factory';

  const baseUrl = env.PUBLIC_SUPABASE_URL ?? 'http://localhost:54321';
  const client = createSupabaseMintSessionClient({ baseUrl });

  // Local ceremony state machine:
  //   'idle' | 'signing-in' | 'cancelled' | 'failed'
  // The "signed-in" terminal state lives in the reactive `isSignedIn`
  // flag below — derived from the JWT store rather than this local
  // machine, so any external clear flips back to idle uniformly.
  let state = 'idle';
  let lastError = '';
  let sessionId = '';

  // `isSignedIn` reflects CURRENT JWT state (reactive). Initialised
  // from `getJwt()` so a returning user with an existing session sees
  // the correct affordance immediately (no flash of the sign-in
  // button). When the JWT goes null via any channel, `sessionId` also
  // resets so a stale success message can't survive a sign-out.
  let isSignedIn = getJwt() !== null;
  const __unsubscribeJwt = subscribeToJwt((jwt) => {
    isSignedIn = jwt !== null;
    if (jwt === null) {
      sessionId = '';
    }
  });
  onDestroy(__unsubscribeJwt);

  async function signIn() {
    if (state === 'signing-in' || isSignedIn) return;
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
      // `isSignedIn` flips via the subscribeToJwt subscriber above —
      // we just capture the session_id so the success message can
      // distinguish "just signed in" from "already signed in".
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

<section>
  <h1>{t('signIn.title')}</h1>

  {#if isSignedIn}
    {#if sessionId}
      <p data-testid="sign-in-success">
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
      <p role="alert" data-testid="sign-in-cancelled">{t('signIn.cancelled')}</p>
    {/if}

    {#if state === 'failed'}
      <p role="alert" data-testid="sign-in-failed">
        {t('signIn.failed', { reason: lastError })}
      </p>
    {/if}
  {/if}
</section>
