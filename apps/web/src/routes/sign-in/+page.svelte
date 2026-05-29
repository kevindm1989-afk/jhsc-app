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
   *   4. On success, the state machine transitions to `signed-in` and
   *      the caller can navigate (route nav is a follow-up; the
   *      MVP surface shows the session_id + a manual nav link).
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
  import { setJwt } from '../../lib/auth/session-jwt-store';
  import { signInViaMintSession } from '../../lib/auth/sign-in-flow';
  import { webauthnGetAssertion } from '../../lib/auth/webauthn-assertion';
  import { createSupabaseMintSessionClient } from '../../lib/server-client/mint-session-client-factory';

  const baseUrl = env.PUBLIC_SUPABASE_URL ?? 'http://localhost:54321';
  const client = createSupabaseMintSessionClient({ baseUrl });

  // State machine values:
  //   'idle' | 'signing-in' | 'cancelled' | 'failed' | 'signed-in'
  let state = 'idle';
  let lastError = '';
  let sessionId = '';

  async function signIn() {
    if (state === 'signing-in') return;
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
      sessionId = result.session_id;
      state = 'signed-in';
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
  <title>Sign in — JHSC</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section>
  <h1>Sign in</h1>
  <p>Use the passkey on this device to sign in to JHSC.</p>

  <button
    type="button"
    on:click={signIn}
    disabled={state === 'signing-in' || state === 'signed-in'}
    data-testid="sign-in-button"
  >
    {#if state === 'signing-in'}
      Signing in…
    {:else if state === 'signed-in'}
      Signed in
    {:else}
      Sign in with passkey
    {/if}
  </button>

  {#if state === 'cancelled'}
    <p role="alert" data-testid="sign-in-cancelled">Sign-in cancelled.</p>
  {/if}

  {#if state === 'failed'}
    <p role="alert" data-testid="sign-in-failed">
      Sign-in failed: {lastError}
    </p>
  {/if}

  {#if state === 'signed-in'}
    <p data-testid="sign-in-success">
      Session established (session_id <code>{sessionId}</code>).
    </p>
  {/if}
</section>
