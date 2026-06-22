<script>
  /**
   * /reprisal — JHSC C4 reprisal log (live, end-to-end).
   *
   * Phase 2b PR1 cutover (ADR-0028 Decisions 5 / 6; threat-model §3.17):
   *   - The demo data-source helpers (the prior synthetic register provider)
   *     are gone; the live path drives the surface end-to-end via the
   *     production compositions below.
   *   - State-probe guard FIRST (`getCommitteeKeyState`): if the actor has no
   *     committee-key wrap (`actor_has_wrap === false`), render the "Complete
   *     encryption setup in Settings" link (`data-testid="reprisal-needs-setup"`)
   *     and STOP — the intake form is NOT mounted, no unwrap RPC is hit
   *     (F-163). The feed itself is pseudonymized + ciphertext-free (F-166), so
   *     `listReprisalFeedViaProduction` deliberately holds no key; the probe
   *     here is the explicit no-wrap gate for the WRITE/READ affordances.
   *   - When the actor has a wrap, mount the intake form behind a "Report a
   *     reprisal" CTA (`data-testid="reprisal-log-cta"`), wired to
   *     `submitReprisalViaProduction`.
   *   - Feed rows render the F-166 projection: target id + class + event +
   *     bucketed timestamp; NO raw actor_id, NO ciphertext (the
   *     ReprisalFeedRow shape enforces the absence structurally).
   *   - Per-row "read" affordance (`data-testid="reprisal-read-*"`) — passphrase
   *     input → routes through `readReprisalViaProduction` → temporary plaintext
   *     in a role=status region. The server emits `reprisal.read` BEFORE
   *     returning ciphertext (F-165 audit-before-decrypt); a wrong/absent
   *     passphrase or missing row collapses to a single `unavailable` (the wire
   *     cannot tell them apart — never an invented invalid_passphrase).
   *
   * Live wiring mirrors the /concerns cutover (the canonical client-construction
   * site): `createSupabaseT07Client` + `createSupabaseReprisalClient` over the
   * shared fetch transport, `getJwt` + `clearJwt` from the session-jwt-store,
   * `new BrowserLocalIdentityStore()` for device-local privkey access, and
   * `getSessionCommitteeKeyHolder()` for the session-scoped key dwell.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13 — same posture as Settings.
   */
  import { onMount } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { t } from '$lib/i18n';
  import ReprisalIntakeForm from '$lib/reprisal/ReprisalIntakeForm.svelte';
  import {
    listReprisalFeedViaProduction,
    readReprisalViaProduction,
    submitReprisalViaProduction
  } from '$lib/reprisal';
  import { createSupabaseReprisalClient } from '$lib/server-client/reprisal-client-factory';
  import { createSupabaseT07Client } from '$lib/server-client/t07-client-factory';
  import { BrowserLocalIdentityStore } from '$lib/crypto/browser-local-identity-store';
  import { getSessionCommitteeKeyHolder } from '$lib/crypto/committee-key-holder';
  import { clearJwt, getJwt } from '$lib/auth/session-jwt-store';
  import { isSignedIn } from '$lib/auth/session-jwt-svelte';
  import { getCurrentUserId } from '$lib/auth/jwt-claims';

  const baseUrl = env.PUBLIC_SUPABASE_URL ?? 'http://localhost:54321';
  const localIdentity = new BrowserLocalIdentityStore();
  const t07Client = createSupabaseT07Client({
    baseUrl,
    getJwt,
    onSessionRevoked: clearJwt,
    localIdentity
  });
  const reprisalClient = createSupabaseReprisalClient({
    baseUrl,
    getJwt,
    onSessionRevoked: clearJwt
  });
  const keyHolder = getSessionCommitteeKeyHolder();

  // Worker-without-Phase-0a guard state (Decision 6 / F-163). `needsSetup`
  // flips true when the probe reports no wrap; the page then renders the
  // setup-link surface and never mounts the form / reaches the disclosure RPC.
  let needsSetup = false;
  /** @type {Array<import('$lib/reprisal').ReprisalFeedRow>} */
  let items = [];
  let listLoading = true;
  let listError = '';
  let listSessionExpired = false;

  // "Report a reprisal" CTA toggles the form mount. Per ADR-0007 amendment the
  // consent surface re-renders on EVERY intake; toggling the mount makes each
  // open a fresh component (no stale consent / passphrase lingering).
  let formOpen = false;

  // Per-row read state. Keyed by reprisal id so multiple read affordances on
  // the page don't collide.
  /** @type {Record<string, { open: boolean; passphrase: string; title: string; body: string; error: string; loading: boolean }>} */
  let readStates = {};

  /** @param {string} id */
  function ensureReadState(id) {
    if (!readStates[id]) {
      readStates[id] = {
        open: false,
        passphrase: '',
        title: '',
        body: '',
        error: '',
        loading: false
      };
    }
    return readStates[id];
  }

  onMount(() => {
    void refresh();
  });

  async function refresh() {
    listLoading = true;
    listError = '';
    listSessionExpired = false;
    const user_id = getCurrentUserId();
    if (!user_id) {
      // Not signed in — the isSignedIn branch below renders the empty state.
      listLoading = false;
      return;
    }

    // Probe-first guard (F-163). The feed itself needs no key, but the no-wrap
    // actor must be steered to setup BEFORE the write/read affordances appear.
    const probe = await t07Client.getCommitteeKeyState({ actor_user_id: user_id });
    if (probe.ok && probe.data && probe.data.actor_has_wrap === false) {
      needsSetup = true;
      listLoading = false;
      return;
    }
    if (!probe.ok && probe.status === 401) {
      listSessionExpired = true;
      listLoading = false;
      return;
    }

    const r = await listReprisalFeedViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id
    });
    listLoading = false;
    if (r.status === 'session_expiry') {
      listSessionExpired = true;
      return;
    }
    if (r.status !== 'ok') {
      listError = t('reprisal.viewer.error.load_failed');
      return;
    }
    items = r.items;
    needsSetup = false;
  }

  /** @param {import('$lib/reprisal/types').ReprisalIntake} intake */
  async function onSubmit(intake) {
    const user_id = getCurrentUserId();
    if (!user_id) return { status: 'session_expiry' };
    const r = await submitReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id,
      intake
    });
    if (r.status === 'ok') {
      void refresh();
    } else if (r.status === 'needs_setup') {
      needsSetup = true;
    }
    return r;
  }

  /** @param {string} id */
  async function onRead(id) {
    const state = ensureReadState(id);
    state.error = '';
    state.loading = true;
    state.title = '';
    state.body = '';
    readStates = { ...readStates };
    const user_id = getCurrentUserId();
    if (!user_id) {
      state.loading = false;
      state.error = t('reprisal.intake.errors.session_expiry');
      readStates = { ...readStates };
      return;
    }
    const r = await readReprisalViaProduction({
      reprisalClient,
      t07Client,
      keyHolder,
      localIdentity,
      user_id,
      id,
      passphrase: state.passphrase.length > 0 ? state.passphrase : null
    });
    state.loading = false;
    if (r.status === 'ok') {
      state.title = r.title;
      state.body = r.body;
    } else if (r.status === 'unavailable') {
      state.error = t('reprisal.page.read.unavailable');
    } else if (r.status === 'session_expiry') {
      state.error = t('reprisal.intake.errors.session_expiry');
    } else if (r.status === 'needs_setup') {
      needsSetup = true;
      state.error = t('reprisal.intake.errors.needs_setup');
    } else if (r.status === 'rls_denied') {
      state.error = t('reprisal.intake.errors.rls_denied');
    } else {
      state.error = t('reprisal.page.read.error');
    }
    readStates = { ...readStates };
  }

  /** @param {string} id */
  function toggleRead(id) {
    const state = ensureReadState(id);
    state.open = !state.open;
    if (!state.open) {
      // Closing the affordance clears the temporary plaintext from the DOM.
      state.title = '';
      state.body = '';
      state.passphrase = '';
      state.error = '';
    }
    readStates = { ...readStates };
  }

  function toggleForm() {
    formOpen = !formOpen;
  }
</script>

<svelte:head>
  <title>{t('common.reprisalPage.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card reprisal-card" data-testid="reprisal-page">
  <h1>{t('reprisal.viewer.heading')}</h1>

  {#if !$isSignedIn}
    <p role="status" data-testid="reprisal-signed-out">
      <a href="/sign-in">{t('common.errors.session_expired')}</a>
    </p>
  {:else if needsSetup}
    <p data-testid="reprisal-needs-setup" role="status" class="rep-needs-setup">
      <a href="/settings">{t('reprisal.page.needs_setup')}</a>
    </p>
  {:else}
    <div class="rep-toolbar">
      <button type="button" class="primary" on:click={toggleForm} data-testid="reprisal-log-cta">
        {formOpen ? t('common.actions.cancel') : t('reprisal.page.log_button')}
      </button>
    </div>

    {#if formOpen}
      {#key formOpen}
        <ReprisalIntakeForm
          submit={onSubmit}
          onSubmitted={() => {
            formOpen = false;
          }}
        />
      {/key}
    {/if}

    {#if listSessionExpired}
      <p role="alert" data-testid="reprisal-session-expired">
        {t('reprisal.intake.errors.session_expiry')}
      </p>
    {:else if listError}
      <p role="alert" data-testid="reprisal-list-error">{listError}</p>
    {:else if listLoading}
      <p role="status" data-testid="reprisal-loading">{t('reprisal.viewer.loading')}</p>
    {:else if items.length === 0}
      <p role="status" data-testid="reprisal-empty">{t('reprisal.viewer.empty')}</p>
    {:else}
      <ul class="rep-list" data-testid="reprisal-list">
        {#each items as item (item.id)}
          <!-- The per-row read affordance is keyed off `target_id` (the
               reprisal_log.id) — NOT `item.id` (the audit_log.id). The
               reprisal_read RPC looks up the reprisal row by reprisal_log.id
               or it returns null → "unavailable". The audit feed's row id is
               unrelated to that lookup. -->
          {@const rowId = String(item.target_id)}
          {@const rs = ensureReadState(rowId)}
          <li class="rep-row">
            <p class="rep-meta">
              <span data-testid="reprisal-row-event">{item.event_type}</span>
              ·
              <span>{item.target_class}</span>
              ·
              <span>{item.target_id}</span>
            </p>
            <div class="rep-read">
              <button
                type="button"
                class="btn-outline"
                data-testid={`reprisal-read-${rowId}`}
                on:click={() => toggleRead(rowId)}
              >
                {readStates[rowId]?.open
                  ? t('reprisal.page.read.close_button')
                  : t('reprisal.page.read.open_button')}
              </button>
              {#if readStates[rowId]?.open}
                <label for={`reprisal-read-passphrase-${rowId}`}>
                  {t('reprisal.page.read.passphrase_label')}
                </label>
                <input
                  id={`reprisal-read-passphrase-${rowId}`}
                  type="password"
                  autocomplete="off"
                  bind:value={rs.passphrase}
                  data-testid={`reprisal-read-passphrase-${rowId}`}
                />
                <button
                  type="button"
                  class="primary"
                  on:click={() => onRead(rowId)}
                  disabled={readStates[rowId]?.loading}
                >
                  {readStates[rowId]?.loading
                    ? t('reprisal.create.actions.saving')
                    : t('reprisal.page.read.reveal_button')}
                </button>
                {#if readStates[rowId]?.error}
                  <p role="alert" class="rep-read-error">{readStates[rowId]?.error}</p>
                {/if}
                {#if readStates[rowId]?.title || readStates[rowId]?.body}
                  <div
                    role="status"
                    class="rep-read-plaintext"
                    data-testid={`reprisal-read-region-${rowId}`}
                  >
                    <p class="rep-read-title">{readStates[rowId]?.title}</p>
                    <p class="rep-read-body">{readStates[rowId]?.body}</p>
                  </div>
                {/if}
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  <p class="rep-footer" data-print="hide">
    <a href="/" data-testid="reprisal-back-to-home">
      {t('common.reprisalPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  /*
   * Preserves the destructive-red 4px inline-start border the placeholder
   * card established for the C4 sensitivity tier.
   */
  .reprisal-card {
    margin-block-start: 1rem;
    border-inline-start-style: solid;
    border-inline-start-width: var(--border-width-c4-stripe);
    border-inline-start-color: var(--color-destructive);
  }
  .rep-toolbar {
    display: flex;
    gap: 0.5rem;
    margin-block-end: 1rem;
  }
  .rep-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.75rem;
  }
  .rep-row {
    padding: 0.75rem 1rem;
    border: var(--border-width-hairline) solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background-color: var(--color-bg-elevated);
  }
  .rep-meta {
    margin-block: 0.25rem;
    font-size: 0.875rem;
    color: var(--color-fg-muted);
  }
  .rep-read {
    display: grid;
    gap: 0.5rem;
    margin-block-start: 0.5rem;
  }
  .rep-read-error {
    color: var(--color-destructive);
    margin: 0;
  }
  .rep-read-plaintext {
    border: var(--border-width-hairline) solid var(--color-border-strong);
    border-radius: var(--radius-md);
    padding: 0.5rem 0.75rem;
    background-color: var(--color-bg);
  }
  .rep-read-title {
    margin: 0;
    font-weight: 600;
  }
  .rep-read-body {
    margin-block: 0.25rem 0;
    white-space: pre-wrap;
  }
  .rep-needs-setup {
    padding-block: 0.75rem;
    padding-inline: 0.875rem;
    border-radius: var(--radius-md);
    background-color: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border: var(--border-width-hairline) solid var(--color-tint-amber-border);
  }
  .rep-footer {
    margin-block-start: 0.75rem;
  }
</style>
