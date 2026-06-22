<script>
  /**
   * /concerns — JHSC concerns register (live, end-to-end).
   *
   * Phase 2a PR2 cutover (ADR-0027 Decisions 4 / 6 / 7; P2a-8 + P2a-9):
   *   - The demo data-source helpers are gone; the live path drives the
   *     surface end-to-end via the production compositions below.
   *   - State-probe guard FIRST (`getCommitteeKeyState`): if the actor has
   *     no committee-key wrap, render the "Complete encryption setup in
   *     Settings" link (`data-testid="concerns-needs-setup"`) and STOP — no
   *     unwrap RPC is hit, no list is fetched (F-144).
   *   - When the actor has a wrap, mount the intake form behind a "Log a
   *     concern" CTA (`data-testid="concerns-log-cta"`), wired to
   *     `submitConcernViaProduction`.
   *   - List rows render the F-149 / F-150 projection: pseudonym + hazard +
   *     severity + days-since-filed; NO raw actor_id, NO status (Decision 6
   *     — status is out of Phase 2a; no status filter chip rail).
   *   - Per-row reveal-source affordance (`data-testid="concerns-reveal-source"`)
   *     for `has_named_source` rows — passphrase input → routes through
   *     `revealConcernSourceViaProduction` → temporary plaintext display in
   *     a role=status region. The server emits `concern.source_revealed`
   *     BEFORE returning the ciphertext (F-150 audit-before-decrypt).
   *
   * Live wiring mirrors the Settings page (the canonical client-construction
   * site): `createSupabaseT07Client` + `createSupabaseConcernClient` over the
   * shared fetch transport, `getJwt` + `clearJwt` from the session-jwt-store,
   * `new BrowserLocalIdentityStore()` for device-local privkey access, and
   * `getSessionCommitteeKeyHolder()` for the session-scoped key dwell.
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13 — same posture as Settings.
   */
  import { onMount } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { t } from '$lib/i18n';
  import ConcernIntakeForm from '$lib/concerns/ConcernIntakeForm.svelte';
  import {
    listConcernsViaProduction,
    revealConcernSourceViaProduction,
    submitConcernViaProduction
  } from '$lib/concerns';
  import { createSupabaseConcernClient } from '$lib/server-client/concern-client-factory';
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
  const concernClient = createSupabaseConcernClient({
    baseUrl,
    getJwt,
    onSessionRevoked: clearJwt
  });
  const keyHolder = getSessionCommitteeKeyHolder();

  // Worker-without-Phase-0a guard state (Decision 7 / AC-7). `needsSetup`
  // flips true when the probe reports no wrap; the page then renders the
  // setup-link surface and never reaches the disclosure RPC.
  let needsSetup = false;
  /** @type {Array<import('$lib/concerns/production-flows').ListedConcern>} */
  let items = [];
  let listLoading = true;
  let listError = '';
  let listSessionExpired = false;

  // "Log a concern" CTA toggles the form mount. Per ADR-0007 Amendment, the
  // form re-renders on EVERY intake (anonymous default-lock); we honour that
  // by toggling the mount, so each "Log a concern" click is a fresh component.
  let formOpen = false;

  // Source-reveal per-row state. Keyed by concern id so multiple reveal
  // affordances on the page don't collide.
  /** @type {Record<string, { open: boolean; passphrase: string; sourceName: string; error: string; loading: boolean }>} */
  let revealStates = {};

  /** @param {string} id */
  function ensureRevealState(id) {
    if (!revealStates[id]) {
      revealStates[id] = { open: false, passphrase: '', sourceName: '', error: '', loading: false };
    }
    return revealStates[id];
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
      // Not signed in — show empty state via the isSignedIn branch below.
      listLoading = false;
      return;
    }
    const r = await listConcernsViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id
    });
    listLoading = false;
    if (r.status === 'needs_setup') {
      needsSetup = true;
      return;
    }
    if (r.status === 'session_expiry') {
      listSessionExpired = true;
      return;
    }
    if (r.status !== 'ok') {
      listError = t('concern.viewer.error.load_failed');
      return;
    }
    items = r.items;
    needsSetup = false;
  }

  /** @param {import('$lib/concerns/types').ConcernIntake} intake */
  async function onSubmit(intake) {
    const user_id = getCurrentUserId();
    if (!user_id) return { status: 'session_expiry' };
    const r = await submitConcernViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id,
      intake
    });
    if (r.status === 'ok') {
      // Successful submit — refresh the list so the new row appears.
      void refresh();
    } else if (r.status === 'needs_setup') {
      needsSetup = true;
    }
    return r;
  }

  /** @param {string} id */
  async function onRevealSource(id) {
    const state = ensureRevealState(id);
    state.error = '';
    state.loading = true;
    state.sourceName = '';
    revealStates = { ...revealStates };
    const user_id = getCurrentUserId();
    if (!user_id) {
      state.loading = false;
      state.error = t('concern.intake.errors.session_expiry');
      revealStates = { ...revealStates };
      return;
    }
    const r = await revealConcernSourceViaProduction({
      client: t07Client,
      concernClient,
      keyHolder,
      localIdentity,
      user_id,
      id,
      passphrase: state.passphrase.length > 0 ? state.passphrase : null
    });
    state.loading = false;
    if (r.status === 'ok') {
      state.sourceName = r.source_name;
    } else if (r.status === 'anonymous') {
      state.sourceName = '';
      state.error = t('concern.viewer.source.anonymous');
    } else if (r.status === 'invalid_passphrase') {
      state.error = t('concern.intake.errors.rls_denied');
    } else if (r.status === 'session_expiry') {
      state.error = t('concern.intake.errors.session_expiry');
    } else if (r.status === 'needs_setup') {
      needsSetup = true;
      state.error = t('concern.intake.errors.needs_setup');
    } else if (r.status === 'rls_denied') {
      state.error = t('concern.intake.errors.rls_denied');
    } else {
      state.error = t('concern.viewer.error.load_failed');
    }
    revealStates = { ...revealStates };
  }

  /** @param {string} id */
  function toggleReveal(id) {
    const state = ensureRevealState(id);
    state.open = !state.open;
    if (!state.open) {
      // Closing the affordance clears any temporary plaintext from the DOM.
      state.sourceName = '';
      state.passphrase = '';
      state.error = '';
    }
    revealStates = { ...revealStates };
  }

  function toggleForm() {
    formOpen = !formOpen;
  }
</script>

<svelte:head>
  <title>{t('concern.page.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="card con-card" data-testid="concerns-page">
  <h1>{t('concern.viewer.heading')}</h1>

  {#if !$isSignedIn}
    <p role="status" data-testid="concerns-signed-out">
      <a href="/sign-in">{t('common.errors.session_expired')}</a>
    </p>
  {:else if needsSetup}
    <p data-testid="concerns-needs-setup" role="status" class="con-needs-setup">
      <a href="/settings">{t('concern.intake.errors.needs_setup')}</a>
    </p>
  {:else}
    <div class="con-toolbar">
      <button type="button" class="primary" on:click={toggleForm} data-testid="concerns-log-cta">
        {formOpen ? t('common.actions.cancel') : t('concern.page.log_button')}
      </button>
    </div>

    {#if formOpen}
      {#key formOpen}
        <ConcernIntakeForm
          submit={onSubmit}
          onSubmitted={() => {
            formOpen = false;
          }}
        />
      {/key}
    {/if}

    {#if listSessionExpired}
      <p role="alert" data-testid="concerns-session-expired">
        {t('concern.intake.errors.session_expiry')}
      </p>
    {:else if listError}
      <p role="alert" data-testid="concerns-list-error">{listError}</p>
    {:else if listLoading}
      <p role="status" data-testid="concerns-loading">{t('concern.viewer.loading')}</p>
    {:else if items.length === 0}
      <p role="status" data-testid="concerns-empty">{t('concern.viewer.empty')}</p>
    {:else}
      <ul class="con-list" data-testid="concerns-list">
        {#each items as item (item.id)}
          {@const rs = ensureRevealState(item.id)}
          <li class="con-row">
            <h2 class="con-title">{item.title}</h2>
            <p class="con-meta">
              <span data-testid="concerns-row-pseudonym">{item.actor_pseudonym}</span>
              ·
              <span>{t(`concern.viewer.hazard.${item.hazard_class}`)}</span>
              ·
              <span>{t(`concern.viewer.severity.${item.severity}`)}</span>
              ·
              <span>{item.days_since_filed} {t('concern.viewer.days_label')}</span>
            </p>
            <p class="con-body">{item.body}</p>
            {#if item.has_named_source}
              <div class="con-reveal">
                <button
                  type="button"
                  class="btn-outline"
                  data-testid="concerns-reveal-source"
                  on:click={() => toggleReveal(item.id)}
                >
                  {revealStates[item.id]?.open
                    ? t('concern.viewer.source.protected')
                    : t('concern.list.row_named_label')}
                </button>
                {#if revealStates[item.id]?.open}
                  <label for={`concern-reveal-passphrase-${item.id}`}>
                    {t('concern.intake.reveal.passphrase_label')}
                  </label>
                  <input
                    id={`concern-reveal-passphrase-${item.id}`}
                    type="password"
                    autocomplete="off"
                    bind:value={rs.passphrase}
                    data-testid={`concerns-reveal-passphrase-${item.id}`}
                  />
                  <button
                    type="button"
                    class="primary"
                    on:click={() => onRevealSource(item.id)}
                    disabled={revealStates[item.id]?.loading}
                  >
                    {revealStates[item.id]?.loading
                      ? t('concern.intake.actions.saving')
                      : t('concern.intake.reveal.reveal_button')}
                  </button>
                  {#if revealStates[item.id]?.error}
                    <p role="alert" class="con-reveal-error">{revealStates[item.id]?.error}</p>
                  {/if}
                  {#if revealStates[item.id]?.sourceName}
                    <p
                      role="status"
                      class="con-reveal-name"
                      data-testid={`concerns-reveal-source-name-${item.id}`}
                    >
                      {revealStates[item.id]?.sourceName}
                    </p>
                  {/if}
                {/if}
              </div>
            {:else}
              <p class="con-anon-note">{t('concern.list.row_anon_label')}</p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  <p class="con-footer" data-print="hide">
    <a href="/" data-testid="concerns-back-to-home">
      {t('common.concernsPage.back_to_home_cta')}
    </a>
  </p>
</section>

<style>
  .con-card {
    margin-block-start: 1rem;
  }
  .con-toolbar {
    display: flex;
    gap: 0.5rem;
    margin-block-end: 1rem;
  }
  .con-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.75rem;
  }
  .con-row {
    padding: 0.75rem 1rem;
    border: var(--border-width-hairline) solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background-color: var(--color-bg-elevated);
  }
  .con-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  .con-meta {
    margin-block: 0.25rem;
    font-size: 0.875rem;
    color: var(--color-fg-muted);
  }
  .con-body {
    margin-block: 0.5rem 0;
    white-space: pre-wrap;
  }
  .con-reveal {
    display: grid;
    gap: 0.5rem;
    margin-block-start: 0.5rem;
  }
  .con-reveal-error {
    color: var(--color-destructive);
    margin: 0;
  }
  .con-reveal-name {
    font-weight: 600;
  }
  .con-anon-note {
    margin-block-start: 0.5rem;
    color: var(--color-fg-muted);
    font-size: 0.8125rem;
  }
  .con-needs-setup {
    padding-block: 0.75rem;
    padding-inline: 0.875rem;
    border-radius: var(--radius-md);
    background-color: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border: var(--border-width-hairline) solid var(--color-tint-amber-border);
  }
  .con-footer {
    margin-block-start: 1rem;
  }
</style>
