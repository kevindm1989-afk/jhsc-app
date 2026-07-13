<script lang="ts">
  /**
   * CommitteeInvite — the co-chair "Invite a member" surface (ADR-0029 P1-8c /
   * Surface K, screen 2). The renderable sibling of CommitteeRoster; the
   * /committee route mounts it at the top of the roster section and forwards the
   * committee-op client.
   *
   * State machine (Surface K screen 2):
   *   idle (CTA only) → form (roles-only, ≥1 role, worker_member default) →
   *   submitting (client mints a crypto 6-digit code, calls issueInvite) →
   *   code_shown (the shared one-time-code custody card) | mapped errors.
   *
   * F-170: the 6-digit code is minted CLIENT-SIDE (crypto.getRandomValues, never
   * Math.random) and shown in the custody card, which copies the LINK only. F-176:
   * the code lives in ONE in-memory variable (`shownCode`); it is never written to
   * a URL / storage / log / DOM attribute, and the response `invitee_user_id` /
   * `bootstrap_id` are never rendered. `issueInvite` is called with
   * `ttl_minutes === INVITE_TTL_MINUTES` (10080 = 7-day invite TTL, NOT the 15-min
   * TOTP window).
   *
   * Error mapping (orchestrator resolution 2026-07-13): rls_denied(403) →
   * not-a-co-chair boundary; invalid_role → role error; ANY other incl. 429 /
   * membership_exists → generic. The raw reason enum is NEVER rendered.
   *
   * Injection mirrors CommitteeRoster (real Svelte props; production-safe inert
   * default). NO __test_* props (ADR-0020 Decision 8).
   */
  import { tick } from 'svelte';
  import { t } from '$lib/i18n';
  import OneTimeCodeCard from './OneTimeCodeCard.svelte';
  import { INVITE_TTL_MINUTES, generateInviteCode } from './invite-code';
  import type { SupabaseCommitteeClient } from './supabase-committee-client';

  // The subset of the committee-op client this surface needs. Tests inject a
  // structural fake; production wires the real SupabaseCommitteeClient.
  type CommitteeClient = Pick<SupabaseCommitteeClient, 'issueInvite' | 'reissueTotp'>;

  /** @see createSupabaseCommitteeClient — production wires the real client. */
  export let client: CommitteeClient = {
    issueInvite: async () => ({ ok: false, reason: 'unknown', status: 0 }),
    reissueTotp: async () => ({ ok: false, reason: 'unknown', status: 0 })
  };

  /**
   * Optional "Reload roster" hook for the not-a-co-chair boundary (the route can
   * re-run listRoster()). Default: a no-op that re-enables the form.
   */
  export let onReloadRoster: () => void = () => {};

  type ErrorKind = null | 'authz' | 'role' | 'generic';

  let open = false;
  let state: 'form' | 'submitting' | 'code_shown' = 'form';
  let errorKind: ErrorKind = null;
  let showRolesRequired = false;

  // Roles-only form (multi-select text[]); worker_member pre-checked default.
  let roleWorkerMember = true;
  let roleWorkerCoChair = false;
  let roleCertifiedMember = false;

  // F-176: the code + invite id live in memory only, cleared on Done/close.
  let shownCode = '';
  let shownInviteId = '';

  const panelId = 'committee-invite-panel';
  const noteId = 'committee-invite-cochair-note';
  const rolesReqId = 'committee-invite-roles-required';

  let panelHeadingEl: HTMLHeadingElement | null = null;
  let ctaEl: HTMLButtonElement | null = null;
  let errorHeadingEl: HTMLElement | null = null;

  $: selectedRoles = [
    ...(roleWorkerMember ? ['worker_member'] : []),
    ...(roleWorkerCoChair ? ['worker_co_chair'] : []),
    ...(roleCertifiedMember ? ['certified_member'] : [])
  ];

  function resetForm(): void {
    roleWorkerMember = true;
    roleWorkerCoChair = false;
    roleCertifiedMember = false;
    errorKind = null;
    showRolesRequired = false;
    shownCode = '';
    shownInviteId = '';
    state = 'form';
  }

  async function openPanel(): Promise<void> {
    resetForm();
    open = true;
    await tick();
    panelHeadingEl?.focus();
  }

  async function closePanel(): Promise<void> {
    open = false;
    shownCode = '';
    shownInviteId = '';
    await tick();
    ctaEl?.focus();
  }

  function togglePanel(): void {
    if (open) void closePanel();
    else void openPanel();
  }

  /**
   * Public: open the invite panel from OUTSIDE (the expired-row "Invite again" /
   * invalid re-invite in PendingInvites hands off here via the route). Idempotent
   * when already open.
   */
  export async function openInvitePanel(): Promise<void> {
    if (!open) await openPanel();
  }

  function mapError(result: { reason: string; status: number }): ErrorKind {
    if (result.status === 403) return 'authz';
    if (result.reason === 'invalid_role') return 'role';
    // Any other / unexpected — INCLUDING 429 (defensive-only) and
    // membership_exists — collapses to the generic error (F-176: never echo
    // the raw reason / status).
    return 'generic';
  }

  async function focusError(): Promise<void> {
    await tick();
    errorHeadingEl?.focus();
  }

  async function submit(): Promise<void> {
    if (state === 'submitting') return;
    if (selectedRoles.length === 0) {
      showRolesRequired = true;
      errorKind = null;
      await tick();
      panelHeadingEl?.focus();
      return;
    }
    showRolesRequired = false;
    errorKind = null;
    state = 'submitting';

    // F-176: the code is minted here (CSPRNG), held in one variable, and passed
    // straight into issueInvite. It is never persisted / logged / URL-appended.
    const code = generateInviteCode();
    const result = await client.issueInvite({
      roles: selectedRoles,
      code,
      ttl_minutes: INVITE_TTL_MINUTES
    });

    if (result.ok) {
      shownCode = code;
      shownInviteId = result.data.invite_id;
      state = 'code_shown';
      return;
    }
    state = 'form';
    errorKind = mapError(result);
    await focusError();
  }

  async function handleDone(): Promise<void> {
    await closePanel();
  }

  async function handleResendNow(): Promise<void> {
    // "Send a different code" — re-mint a fresh code for the SAME invite; the old
    // one dies server-side. Replaces the displayed code without re-moving focus.
    const code = generateInviteCode();
    const result = await client.reissueTotp({ invite_id: shownInviteId, code });
    if (result.ok) {
      shownCode = code;
      return;
    }
    // On failure the once-shown code is spent — fall back to the generic error
    // (screen 2 has no invite_invalid state) and re-show the form.
    state = 'form';
    errorKind = result.status === 403 ? 'authz' : 'generic';
    await focusError();
  }

  function reloadRoster(): void {
    onReloadRoster();
    errorKind = null;
  }
</script>

<div class="invite-root">
  <button
    type="button"
    class="invite-cta"
    data-testid="committee-invite-cta"
    aria-expanded={open}
    aria-controls={panelId}
    bind:this={ctaEl}
    on:click={togglePanel}
  >
    <svg class="invite-cta-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 5v14M5 12h14"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      />
    </svg>
    {t('committee.invite.cta')}
  </button>

  {#if open}
    <div
      id={panelId}
      class="card invite-panel"
      role="group"
      aria-labelledby="committee-invite-heading"
      aria-busy={state === 'submitting' ? 'true' : 'false'}
    >
      {#if state === 'code_shown'}
        <h2 id="committee-invite-heading" class="sr-only">{t('committee.invite.code.heading')}</h2>
        <OneTimeCodeCard
          code={shownCode}
          inviteId={shownInviteId}
          heading={t('committee.invite.code.heading')}
          codeReadyAnnounce={t('a11y.committee.invite.code_ready')}
          cardTestid="committee-invite-code"
          valueTestid="committee-invite-code-value"
          onDone={handleDone}
          onResendNow={handleResendNow}
        />
      {:else}
        <h2
          id="committee-invite-heading"
          class="invite-heading"
          tabindex="-1"
          bind:this={panelHeadingEl}
        >
          {t('committee.invite.form.heading')}
        </h2>

        {#if errorKind === 'authz'}
          <div
            class="invite-banner invite-banner-warning"
            role="alert"
            data-testid="committee-invite-error-authz"
          >
            <svg class="invite-banner-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
              <path
                d="M12 8v5m0 3h.01"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
            <div>
              <h3 class="invite-banner-heading" tabindex="-1" bind:this={errorHeadingEl}>
                {t('committee.invite.error.not_co_chair.heading')}
              </h3>
              <p class="invite-banner-body">{t('committee.invite.error.not_co_chair.body')}</p>
              <button type="button" class="invite-reload" on:click={reloadRoster}>
                {t('committee.invite.error.reload')}
              </button>
            </div>
          </div>
        {:else if errorKind === 'role'}
          <div
            class="invite-banner invite-banner-danger"
            role="alert"
            data-testid="committee-invite-error-role"
          >
            <svg class="invite-banner-icon" viewBox="0 0 24 24" aria-hidden="true">
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
              <h3 class="invite-banner-heading" tabindex="-1" bind:this={errorHeadingEl}>
                {t('committee.invite.error.invalid_role.heading')}
              </h3>
              <p class="invite-banner-body">{t('committee.invite.error.invalid_role.body')}</p>
            </div>
          </div>
        {:else if errorKind === 'generic'}
          <div
            class="invite-banner invite-banner-danger"
            role="alert"
            data-testid="committee-invite-error"
          >
            <svg class="invite-banner-icon" viewBox="0 0 24 24" aria-hidden="true">
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
              <h3 class="invite-banner-heading" tabindex="-1" bind:this={errorHeadingEl}>
                {t('committee.invite.error.generic.heading')}
              </h3>
              <p class="invite-banner-body">{t('committee.invite.error.generic.body')}</p>
            </div>
          </div>
        {/if}

        <form
          class="invite-form"
          data-testid="committee-invite-form"
          novalidate
          on:submit|preventDefault={submit}
        >
          <fieldset
            class="invite-fieldset"
            aria-describedby={showRolesRequired ? rolesReqId : undefined}
          >
            <legend class="invite-legend">{t('committee.invite.roles.legend')}</legend>

            <div class="invite-role-row">
              <input
                id="committee-invite-role-worker-member"
                type="checkbox"
                bind:checked={roleWorkerMember}
                disabled={state === 'submitting'}
              />
              <label for="committee-invite-role-worker-member">
                {t('committee.invite.role.worker_member')}
              </label>
            </div>

            <div class="invite-role-row">
              <input
                id="committee-invite-role-worker-co-chair"
                type="checkbox"
                bind:checked={roleWorkerCoChair}
                aria-describedby={noteId}
                disabled={state === 'submitting'}
              />
              <label for="committee-invite-role-worker-co-chair">
                {t('committee.invite.role.worker_co_chair')}
              </label>
              <p id={noteId} class="invite-role-note">{t('committee.invite.role.co_chair_note')}</p>
            </div>

            <div class="invite-role-row">
              <input
                id="committee-invite-role-certified-member"
                type="checkbox"
                bind:checked={roleCertifiedMember}
                disabled={state === 'submitting'}
              />
              <label for="committee-invite-role-certified-member">
                {t('committee.invite.role.certified_member')}
              </label>
            </div>
          </fieldset>

          {#if showRolesRequired}
            <div class="invite-required" role="alert" id={rolesReqId}>
              {t('committee.invite.roles.required')}
            </div>
          {/if}

          <div class="invite-form-actions">
            <button
              type="submit"
              class="invite-submit"
              disabled={state === 'submitting' || errorKind === 'authz'}
            >
              {#if state === 'submitting'}
                <svg class="invite-spinner" viewBox="0 0 24 24" aria-hidden="true">
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
                {t('committee.invite.form.submitting')}
              {:else}
                {t('committee.invite.form.submit')}
              {/if}
            </button>
            <button
              type="button"
              class="invite-cancel"
              on:click={closePanel}
              disabled={state === 'submitting'}
            >
              {t('committee.invite.form.cancel')}
            </button>
          </div>

          {#if state === 'submitting'}
            <p class="sr-only" role="status">{t('a11y.committee.invite.submitting')}</p>
          {/if}
        </form>
      {/if}
    </div>
  {/if}
</div>

<style>
  .invite-root {
    margin-block-start: 1rem;
  }
  .invite-cta {
    background: var(--color-accent);
    color: var(--color-accent-fg);
    border-color: var(--color-accent);
  }
  .invite-cta:hover:not(:disabled) {
    background: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
    opacity: 1;
  }
  .invite-cta-icon {
    width: 1rem;
    height: 1rem;
    flex: none;
  }

  .invite-panel {
    margin-block-start: 0.75rem;
  }
  .invite-heading {
    margin: 0 0 0.75rem;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--color-fg);
  }

  .invite-fieldset {
    margin: 0;
    padding: 0;
    border: 0;
    display: grid;
    gap: 1.25rem;
  }
  .invite-legend {
    padding: 0;
    margin-block-end: 0.75rem;
    font-weight: 600;
    color: var(--color-fg);
  }
  .invite-role-row {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    column-gap: 0.5rem;
    row-gap: 0.25rem;
  }
  .invite-role-row input[type='checkbox'] {
    min-height: auto;
    width: 1.15rem;
    height: 1.15rem;
    accent-color: var(--color-accent);
  }
  .invite-role-row label {
    color: var(--color-fg);
    font-weight: 500;
  }
  .invite-role-note {
    grid-column: 2;
    margin: 0;
    font-size: 0.8125rem;
    color: var(--color-fg-muted);
  }

  .invite-required {
    margin-block-start: 0.75rem;
    padding: 0.5rem 0.75rem;
    border: var(--border-width-default) solid var(--color-tint-red-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    font-size: 0.875rem;
  }

  .invite-form-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-block-start: 1.25rem;
  }
  .invite-submit {
    background: var(--color-accent);
    color: var(--color-accent-fg);
    border-color: var(--color-accent);
  }
  .invite-submit:hover:not(:disabled) {
    background: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
    opacity: 1;
  }
  .invite-cancel {
    background: transparent;
    color: var(--color-fg-muted);
    border-color: transparent;
  }
  .invite-cancel:hover:not(:disabled) {
    background: var(--color-muted);
    color: var(--color-fg);
    opacity: 1;
  }
  .invite-reload {
    margin-block-start: 0.5rem;
    min-height: 2.25rem;
    background: transparent;
    color: inherit;
    border-color: currentColor;
  }

  .invite-spinner {
    width: 1rem;
    height: 1rem;
    flex: none;
    animation: invite-spin 0.9s linear infinite;
  }
  @keyframes invite-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .invite-banner {
    display: flex;
    gap: 0.625rem;
    align-items: flex-start;
    margin-block-end: 1rem;
    padding: 0.75rem 1rem;
    border: var(--border-width-default) solid transparent;
    border-radius: var(--radius-md);
  }
  .invite-banner-icon {
    width: 1.25rem;
    height: 1.25rem;
    flex: none;
    margin-block-start: 0.125rem;
  }
  .invite-banner-heading {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
  }
  .invite-banner-body {
    margin-block: 0.25rem 0;
    font-size: 0.875rem;
  }
  .invite-banner-warning {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-color: var(--color-tint-amber-border);
  }
  .invite-banner-danger {
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-color: var(--color-tint-red-border);
  }

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
