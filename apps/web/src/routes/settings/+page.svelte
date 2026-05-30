<script>
  /**
   * /settings — production mount point for the PanicWipeModal
   * (T19.1 follow-up; closes the panic-wipe end-to-end loop).
   *
   * Wiring:
   *   1. Construct a SupabaseT07Client over a fetch transport, reading
   *      the project base URL from PUBLIC_SUPABASE_URL. When the env
   *      var is missing (local builds without Supabase wired) the
   *      factory still works — the transport just consistently fails
   *      with status 0, which the BrowserWipeStore catches as
   *      {ok: false} and surfaces as `audit_failed`, keeping the
   *      audit-before-side-effect contract holds even in misconfigured
   *      deployments.
   *   2. Wrap the client as a PanicWipeAuditEmitter (one-line adapter
   *      from `t07-client-factory.ts`).
   *   3. Construct a BrowserWipeStore with the emitter wired.
   *   4. Pass the store to PanicWipeModal via the new `wipeStore` prop.
   *
   * JWT provider: today returns null (auth session storage lands in a
   * later increment; the unauthenticated client is fine because
   * BrowserWipeStore's transport-error fail-closed branch covers the
   * 401 case identically to the network-down case). When the auth
   * session store lands, swap `getJwt` for `() => authStore.jwt`.
   *
   * NOTE: no `lang="ts"` — same reason as `/onboarding/+page.svelte`:
   * PanicWipeModal.svelte is a plain-JS Svelte component and svelte-check's
   * strict implicit-any check rejects importing it from a TS-annotated
   * parent. The route is a thin wiring shell with no logic of its own.
   */
  import { onDestroy } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { t } from '$lib/i18n';
  import PanicWipeModal from '../../lib/lock/PanicWipeModal.svelte';
  import { BrowserWipeStore } from '../../lib/lock/wipe-store';
  import { clearJwt, getJwt, subscribeToJwt } from '../../lib/auth/session-jwt-store';
  import {
    createPanicWipeAuditEmitter,
    createSupabaseT07Client
  } from '../../lib/server-client/t07-client-factory';

  let modalOpen = false;
  // `signedOut` reflects CURRENT JWT state (reactive), not just the
  // user-initiated sign-out click. So side-channel clears (401
  // revocation from another tab's call, panic-wipe post-cleanup hook,
  // a future Settings → Sessions revoke) all flip this UI in real
  // time. Initialized from `getJwt()` so a not-yet-signed-in user
  // landing here directly sees the correct state at mount.
  let signedOut = getJwt() === null;
  const __unsubscribeJwt = subscribeToJwt((jwt) => {
    signedOut = jwt === null;
  });
  onDestroy(__unsubscribeJwt);

  // Read the base URL at runtime (env may be undefined at build time).
  const baseUrl = env.PUBLIC_SUPABASE_URL ?? 'http://localhost:54321';

  // JWT provider reads the in-memory session-jwt store
  // (`lib/auth/session-jwt-store.ts`). Before the sign-in flow lands
  // the store is empty (`getJwt()` returns null) — the unauthenticated
  // client still works for the audit-emit transport: when the server
  // denies (rls_denied / 401) the WipeStore's fail-closed branch
  // leaves local state intact. After the sign-in flow lands, `setJwt`
  // is called once mint-session succeeds; this factory picks up the
  // value lazily on every call so no client reconstruction is needed.
  //
  // `onSessionRevoked: clearJwt` honors the F-39 contract documented in
  // session-jwt-store: a 401 from t07-op (server's session_is_live
  // gate denied the request) MUST clear the in-memory JWT so subsequent
  // calls don't keep posting the stale token. Same wiring as the
  // default-store client in hooks.client.ts — every t07-client in the
  // app must honor this loop, not just the central one.
  const client = createSupabaseT07Client({
    baseUrl,
    getJwt,
    onSessionRevoked: clearJwt
  });
  const wipeStore = new BrowserWipeStore({
    auditEmitter: createPanicWipeAuditEmitter(client)
  });

  function openWipeModal() {
    modalOpen = true;
  }

  function onWipeRequestClose() {
    modalOpen = false;
  }

  // Sign-out: clear the in-memory JWT. The `signedOut` flag flips
  // reactively via the subscribeToJwt subscriber above, so no manual
  // `signedOut = true` line is needed here — that lets side-channel
  // clears (401 revocation from another tab, panic-wipe post-cleanup,
  // a future Settings → Sessions revoke) reuse the same code path.
  //
  // The server-side jti remains live until natural expiry (≤300s per
  // F-116) or until a future Edge Function exposes the auth_admin-only
  // revoke_session RPC to authenticated users. Until that follow-up
  // lands, this is client-side sign-out only: the in-memory bearer is
  // gone, so subsequent Edge Function calls post without Authorization
  // and the server's session_is_live gate denies them. The next-best-
  // thing to immediate revocation; for immediate device cleanup the
  // panic-wipe modal below is the canonical destruction path.
  function signOut() {
    clearJwt();
  }
</script>

<svelte:head>
  <title>{t('settings.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section>
  <h1>{t('settings.title')}</h1>

  <h2>{t('signOut.heading')}</h2>
  <p>{t('signOut.intro')}</p>
  <button type="button" on:click={signOut} data-testid="sign-out-button" disabled={signedOut}>
    {t('signOut.button')}
  </button>
  {#if signedOut}
    <p role="status" data-testid="signed-out-confirmation">{t('signOut.signed_out')}</p>
    <p>
      <a href="/sign-in" data-testid="signed-out-sign-in-again">
        {t('signOut.sign_in_again_cta')}
      </a>
    </p>
  {/if}

  <h2>{t('settings.device_data.heading')}</h2>
  <p>
    {t('settings.device_data.intro_before_emphasis')}<strong
      >{t('settings.device_data.intro_emphasis')}</strong
    >{t('settings.device_data.intro_after_emphasis')}
  </p>
  <button type="button" on:click={openWipeModal} data-testid="open-panic-wipe">
    {t('settings.device_data.wipe_button')}
  </button>
</section>

<PanicWipeModal
  bind:open={modalOpen}
  surface="settings"
  {wipeStore}
  on:cancel={onWipeRequestClose}
  on:complete={onWipeRequestClose}
  on:close={onWipeRequestClose}
/>
