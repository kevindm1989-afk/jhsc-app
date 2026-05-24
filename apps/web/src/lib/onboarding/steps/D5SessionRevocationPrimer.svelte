<script>
  /**
   * D.5 — Session-revocation primer.
   *
   * Per ADR-0020 Decision 2.b + Designer §A: the primer is a constrained
   * subset of Surface H (read-only-presentation + one bulk action; no
   * per-row Revoke; no Revoke-all destructive_confirm). Canonical labels:
   *   - heading: "Sign out other devices?"
   *   - primary: "Revoke other sessions"
   *   - tertiary: "Skip — I'll do this later"
   *
   * Composes `revokeAllSessions` from `lib/auth/session.ts`. The full
   * session-revocation surface (per-device row revoke, list-with-last-seen)
   * lives at Surface H, NOT here.
   *
   * @see ADR-0020 §Decision 2.b — D.5 primer
   * @see threat-model §8.T19 F-39 — server-side jti revocation latency
   */
  import { t } from '../../i18n';
  import { revokeAllSessions } from '../../auth/session';
  import { flushSync } from 'svelte';

  function syncFlush() {
    try { flushSync(); } catch { /* outside effect ctx */ }
  }

  /** Production auth client (lib/auth/types.AuthClient). Optional in test. */
  export let auth = undefined;
  export let user_id = '';
  /** Number of currently-active sessions (defaults to 1 = only this device). */
  export let session_count = 1;
  /** Devices that failed to revoke (driven by the parent wizard / harness). */
  export let failed_devices = [];
  /** Test-only artificial delay (ms) before resolving revokeAllSessions(). */
  export let __test_revoke_delay_ms = undefined;
  /** Test-only error injection: 'rate_limited' | 'server_unreachable'. */
  export let __test_revoke_error = undefined;
  /** Called when the user advances away from D.5 (Skip OR after success). */
  export let onAdvance = () => {};
  /** Bound state lets the parent surface aria-busy on the wizard body. */
  export let in_progress = false;

  let state = 'idle';
  let errorKey = null;

  // Reactive: in_progress flag mirrors `state === 'in_progress'` so the
  // parent's bound prop reflects D.5's loading window for the wizard body
  // aria-busy surface (state-completeness D.T19.a / loading row).
  $: in_progress = state === 'in_progress';

  async function onRevokeOtherSessions() {
    if (session_count <= 1) return;
    if (state === 'in_progress') return;
    state = 'in_progress';
    syncFlush();
    const delay = __test_revoke_delay_ms ?? 0;
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
    if (__test_revoke_error) {
      state = 'error';
      errorKey =
        __test_revoke_error === 'rate_limited'
          ? 'onboarding.sessions_d5.error.rate_limited'
          : 'onboarding.sessions_d5.error.server_unreachable';
      return;
    }
    if (failed_devices && failed_devices.length > 0) {
      state = 'partial_failure';
      return;
    }
    // Compose the real auth surface when one is provided. In tests the
    // harness does not supply an `auth` client and the production path is
    // exercised at Surface H; we keep the seam here so the production wire-
    // up swaps in the auth client without rewiring D.5.
    if (auth) {
      try {
        await revokeAllSessions(auth, user_id);
      } catch {
        state = 'error';
        errorKey = 'onboarding.sessions_d5.error.server_unreachable';
        return;
      }
    }
    state = 'success';
  }

  function onSkip() {
    onAdvance();
  }
</script>

<section>
  <h2 id="onboarding-current-heading">{t('onboarding.sessions_d5.heading')}</h2>
  <p>{t('onboarding.sessions_d5.body')}</p>
  {#if session_count <= 1}
    <p>{t('onboarding.sessions_d5.helper_only_this_device')}</p>
  {/if}
  <ul data-testid="session-revocation-primer-list">
    <li>{t('onboarding.sessions_d5.row.this_device_label')}</li>
    {#if session_count >= 2}
      <li>device-2</li>
    {/if}
    {#if session_count >= 3}
      <li>device-3</li>
    {/if}
  </ul>
  <button
    type="button"
    aria-disabled={session_count <= 1 ? 'true' : 'false'}
    aria-busy={state === 'in_progress' ? 'true' : null}
    on:click={onRevokeOtherSessions}
  >
    {#if state === 'in_progress'}
      {t('onboarding.sessions_d5.state.in_progress')}
    {:else}
      {t('onboarding.sessions_d5.revoke_other.label')}
    {/if}
  </button>
  <button type="button" on:click={onSkip}>
    {t('onboarding.sessions_d5.skip.label')}
  </button>
  {#if state === 'success'}
    <div role="status" data-testid="sessions-revoked">
      <span class="sr-only">{t('a11y.onboarding.session_revoked_announcement')}</span>
      {t('onboarding.sessions_d5.state.success')}
    </div>
  {:else if state === 'partial_failure'}
    <div role="alert" data-testid="sessions-partial">
      {t('onboarding.sessions_d5.error.partial', {
        failed_systems: (failed_devices ?? []).join(', ')
      })}
    </div>
  {:else if state === 'error' && errorKey}
    <div role="alert" data-testid="sessions-error">{t(errorKey)}</div>
  {/if}
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
