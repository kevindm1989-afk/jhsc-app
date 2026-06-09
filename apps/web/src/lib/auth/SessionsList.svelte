<script>
  /**
   * SessionsList — Surface H, worker-side sessions management.
   *
   * Lists every active session the caller owns (auth.uid() = user_id
   * enforced server-side by the SupabaseAuthStore wrappers), highlights
   * the row corresponding to the CURRENT browser session (jti =
   * decodeJwtClaims(getJwt()).jti), and exposes per-row "Revoke" plus a
   * bulk "Revoke all other sessions" action.
   *
   * F-39 contract:
   *   - The revoke ops route through SupabaseAuthStore.revokeSession /
   *     revokeAllForUser → SECURITY DEFINER `revoke_my_session` /
   *     `revoke_all_my_sessions` (migrations 0012 + 0013). The function
   *     verifies auth.uid() ownership in-function (G-T05-3 defense).
   *   - Revoking the CURRENT session is allowed (worker explicitly
   *     "sign out of everything"); the dispatcher's 401-on-stale-JWT
   *     path is what clears the local JWT after the server forgets
   *     the session.
   *   - The list is refreshed after every revoke so the user sees the
   *     post-revoke state without a page reload.
   *
   * The component does NOT decode session_id semantics into anything
   * pretty (device fingerprint, last seen). The AuthSession shape
   * carries `session_id`, `iat`, `exp`, optional `device_fingerprint`;
   * everything else is server-side only. We render iat/exp as
   * ISO timestamps for evidence-grade clarity (no relative-time
   * formatting that could drift across timezones / clock skew).
   *
   * Source: ADR-0023 (session shape), F-39 (revocation propagation),
   * Designer §G Surface H (sessions list visual).
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { getCurrentSessionId, getCurrentUserId } from './jwt-claims';

  /**
   * Production AuthStore (constructed via createSupabaseAuthStore in
   * the parent route). The component itself is store-agnostic — any
   * AuthStore-shaped object with listActiveSessions / revokeSession /
   * revokeAllForUser works for tests.
   *
   * No `lang="ts"` and no TS type annotations on `let` per G-T07-13:
   * Svelte 5's esrap codegen cannot serialize TS annotations on
   * variable declarations. We rely on JSDoc + structural duck-typing.
   *
   * @type {import('./supabase-auth-store').SupabaseAuthStore | undefined}
   */
  export let authStore = undefined;

  // Local state — JSDoc types only.
  /** @type {import('./types').AuthSession[]} */
  let sessions = [];
  /** @type {string | null} */
  let userId = null;
  /** @type {string | null} */
  let currentSessionId = null;
  let loading = true;
  let loadError = false;
  /** @type {Record<string, boolean>} */
  let revoking = {};
  let bulkRevoking = false;
  let lastError = '';
  // Success feedback — set after a successful revoke (per-row OR bulk).
  // Polite live-region; AT users hear "Session revoked" or
  // "All other sessions revoked" without an interrupt. Auto-clears on
  // the next user action (any revoke / refresh) so it doesn't linger
  // through a follow-on error state.
  let successMessage = '';

  onMount(async () => {
    userId = getCurrentUserId();
    currentSessionId = getCurrentSessionId();
    if (!userId) {
      loading = false;
      loadError = true;
      lastError = t('settings.sessions.error.signed_out');
      return;
    }
    await refresh();
  });

  async function refresh() {
    if (!userId) return;
    loading = true;
    loadError = false;
    lastError = '';
    try {
      const list = await authStore.listActiveSessions(userId);
      // Sort newest-first by `iat` so the most recent session shows at
      // the top (the user's current session is usually newest).
      sessions = [...list].sort((a, b) => (b.iat ?? 0) - (a.iat ?? 0));
    } catch {
      loadError = true;
      lastError = t('settings.sessions.error.load_failed');
    } finally {
      loading = false;
    }
  }

  /** @param {string} session_id */
  async function onRevoke(session_id) {
    if (revoking[session_id]) return;
    revoking = { ...revoking, [session_id]: true };
    lastError = '';
    successMessage = '';
    try {
      await authStore.revokeSession(session_id, Date.now());
      await refresh();
      successMessage = t('settings.sessions.success.one_revoked');
    } catch {
      lastError = t('settings.sessions.error.revoke_failed');
    } finally {
      // Drop the session_id key from `revoking` without an unused
      // throwaway binding (no-unused-vars hates `const {[k]: _, ...} = …`).
      const rest = { ...revoking };
      delete rest[session_id];
      revoking = rest;
    }
  }

  async function onRevokeAllOthers() {
    if (!userId || bulkRevoking) return;
    bulkRevoking = true;
    lastError = '';
    successMessage = '';
    try {
      await authStore.revokeAllForUser(userId, Date.now());
      await refresh();
      successMessage = t('settings.sessions.success.all_revoked');
    } catch {
      lastError = t('settings.sessions.error.revoke_all_failed');
    } finally {
      bulkRevoking = false;
    }
  }

  /**
   * @param {number | null | undefined} ms
   * @returns {string}
   */
  function formatTimestamp(ms) {
    if (!ms || typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
    try {
      return new Date(ms).toISOString().replace('T', ' ').replace('.000Z', 'Z');
    } catch {
      return '—';
    }
  }

  $: hasOtherSessions = sessions.some((s) => s.session_id !== currentSessionId);
</script>

<section
  class="sessions-section"
  aria-labelledby="sessions-heading"
  aria-busy={loading || bulkRevoking ? 'true' : 'false'}
  data-testid="sessions-list-section"
>
  <h2 id="sessions-heading">{t('settings.sessions.heading')}</h2>
  <p class="muted">{t('settings.sessions.intro')}</p>

  {#if loading}
    <p class="muted" role="status" data-testid="sessions-loading">
      {t('settings.sessions.loading')}
    </p>
  {:else if loadError}
    <p class="sessions-alert" role="alert" data-testid="sessions-load-error">
      {lastError || t('settings.sessions.error.load_failed')}
    </p>
  {:else if sessions.length === 0}
    <p class="muted" role="status" data-testid="sessions-empty">
      {t('settings.sessions.empty')}
    </p>
  {:else}
    <ul class="sessions-list" data-testid="sessions-list">
      {#each sessions as session (session.session_id)}
        {@const isCurrent = session.session_id === currentSessionId}
        <li class="session-row" class:current={isCurrent} data-testid="session-row">
          <div class="session-meta">
            {#if isCurrent}
              <span class="session-badge" data-testid="session-current-badge">
                {t('settings.sessions.this_device_label')}
              </span>
            {/if}
            <span class="session-id" data-testid="session-id">{session.session_id}</span>
            <span class="session-times">
              {t('settings.sessions.issued_label')}: <time>{formatTimestamp(session.iat)}</time>
              · {t('settings.sessions.expires_label')}: <time>{formatTimestamp(session.exp)}</time>
            </span>
          </div>
          <button
            type="button"
            class="btn-outline session-revoke"
            on:click={() => onRevoke(session.session_id)}
            disabled={revoking[session.session_id] || bulkRevoking}
            aria-busy={revoking[session.session_id] ? 'true' : 'false'}
            data-testid="session-revoke-button"
          >
            {revoking[session.session_id]
              ? t('settings.sessions.revoking')
              : t('settings.sessions.revoke')}
          </button>
        </li>
      {/each}
    </ul>

    {#if hasOtherSessions}
      <div class="sessions-bulk-row">
        <button
          type="button"
          class="btn-destructive"
          on:click={onRevokeAllOthers}
          disabled={bulkRevoking}
          aria-busy={bulkRevoking ? 'true' : 'false'}
          data-testid="sessions-revoke-all-button"
        >
          {bulkRevoking ? t('settings.sessions.revoking_all') : t('settings.sessions.revoke_all')}
        </button>
      </div>
    {/if}

    {#if successMessage}
      <p class="sessions-success" role="status" data-testid="sessions-success">
        {successMessage}
      </p>
    {/if}

    {#if lastError}
      <p class="sessions-alert" role="alert" data-testid="sessions-error">{lastError}</p>
    {/if}
  {/if}
</section>

<style>
  /*
   * Surface H sessions list — worker-hub language. Bordered row stack
   * (one row per session), monospaced session_id + ISO timestamps for
   * evidence-grade clarity (no relative-time strings that drift across
   * clock skew / timezone). The current-session row carries a tinted-
   * blue "This device" badge so the worker knows which row IS them.
   */
  .sessions-section {
    margin-block-start: 1.25rem;
  }
  .sessions-list {
    list-style: none;
    padding: 0;
    margin: 0.75rem 0 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .session-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.75rem 0.875rem;
    background: var(--color-bg-elevated);
    color: var(--color-fg);
  }
  .session-row + .session-row {
    border-block-start: 1px solid var(--color-border);
  }
  .session-row.current {
    background: var(--color-tint-blue-bg);
  }
  .session-meta {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
    flex: 1 1 18rem;
  }
  .session-badge {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    padding: 0.125rem 0.5rem;
    border: 1px solid var(--color-tint-blue-border);
    border-radius: var(--radius-sm);
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .session-id {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--color-fg);
    word-break: break-all;
  }
  .session-times {
    font-size: 0.75rem;
    color: var(--color-fg-muted);
  }
  .session-times time {
    font-family: var(--font-mono);
  }
  .session-revoke {
    flex: none;
    min-height: 2.25rem;
    padding-inline: 0.875rem;
    font-size: 0.8125rem;
  }
  .sessions-bulk-row {
    margin-block-start: 0.75rem;
  }
  .sessions-alert {
    margin-block: 0.75rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-red-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
  }
  /* Polite success — green-tinted panel; matches /sign-in's success
     surface (same --color-tint-green-* tokens). role="status" on the
     element gives AT users a non-interrupting announcement. */
  .sessions-success {
    margin-block: 0.75rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-green-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
  }
</style>
