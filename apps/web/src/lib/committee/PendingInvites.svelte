<script lang="ts">
  /**
   * PendingInvites — the co-chair "Pending invites" + per-row re-send surface
   * (ADR-0029 P1-8c / Surface K, screen 4). A DISTINCT section rendered BELOW the
   * roster on /committee (A-8.2 read-boundary: the B2 `listPendingInvites`
   * projection, NOT interleaved into the B1 roster list). The route wires the
   * committee-op client + forwards it.
   *
   * Per row: status pill (waiting / expired, icon + text), roles, INVITE-TTL
   * dates, and an action. A not-yet-expired invite offers "Re-send code" →
   * confirm gate → `reissueTotp({ invite_id, code })` with a FRESH crypto 6-digit
   * code → the shared one-time-code custody card. A past-TTL (expired) invite
   * switches to "Invite again" and hands off to the screen-2 panel via
   * `onReinvite` WITHOUT calling reissueTotp (an expired invite only returns
   * invite_invalid).
   *
   * F-170 / F-176: same custody posture as screen 2 — the re-send card copies the
   * LINK only; the fresh code lives in ONE in-memory variable and never leaks to
   * URL / storage / log / DOM attribute; the reissue-response `bootstrap_id` is
   * never rendered. Error mapping: invite_invalid(422) → a SINGLE normalized "no
   * longer valid" message (consumed ≡ expired oracle defense); ANY other incl.
   * 429 / rls_denied → generic error. The raw reason enum is NEVER rendered.
   */
  import { onMount, tick } from 'svelte';
  import { t } from '$lib/i18n';
  import OneTimeCodeCard from './OneTimeCodeCard.svelte';
  import { generateInviteCode } from './invite-code';
  import type { PendingInvite, SupabaseCommitteeClient } from './supabase-committee-client';

  // The subset of the committee-op client this surface needs. Tests inject a
  // structural fake; production wires the real SupabaseCommitteeClient.
  type CommitteeClient = Pick<SupabaseCommitteeClient, 'listPendingInvites' | 'reissueTotp'>;

  /** @see createSupabaseCommitteeClient — production wires the real client. */
  export let client: CommitteeClient = {
    listPendingInvites: async () => ({ ok: false, reason: 'unknown', status: 0 }),
    reissueTotp: async () => ({ ok: false, reason: 'unknown', status: 0 })
  };

  /** Opens the screen-2 invite panel (expired-row "Invite again" / invalid re-invite). */
  export let onReinvite: () => void = () => {};

  type Phase = 'loading' | 'empty' | 'error' | 'list';
  type RowPhase = 'confirm' | 'submitting' | 'code_shown' | 'invalid' | 'error';

  let phase: Phase = 'loading';
  let rows: PendingInvite[] = [];

  // Only one row acts at a time (one confirm / one code_shown / one error).
  let activeId: string | null = null;
  let rowPhase: RowPhase = 'confirm';
  // F-176: the fresh re-send code lives in memory only.
  let shownCode = '';

  const actionBtns: Record<string, HTMLButtonElement> = {};
  let confirmHeadingEl: HTMLElement | null = null;
  let invalidHeadingEl: HTMLElement | null = null;
  let errorHeadingEl: HTMLElement | null = null;
  let listErrorHeadingEl: HTMLElement | null = null;

  $: busy = phase === 'loading';

  onMount(() => {
    void load();
  });

  async function load(): Promise<void> {
    phase = 'loading';
    activeId = null;
    shownCode = '';
    const result = await client.listPendingInvites();
    if (result.ok) {
      rows = result.data;
      phase = rows.length === 0 ? 'empty' : 'list';
      return;
    }
    // Any failure → generic list error (raw reason mapped away, never rendered).
    phase = 'error';
    await tick();
    listErrorHeadingEl?.focus();
  }

  /** ISO YYYY-MM-DD (§7) — clock-independent slice of the server ISO string. */
  function isoDate(s: string): string {
    return s ? s.slice(0, 10) : '';
  }

  /** A past-TTL invite (expires_at <= now) re-invites instead of re-sending. */
  function isExpired(row: PendingInvite): boolean {
    return new Date(row.expires_at).getTime() <= Date.now();
  }

  /** display_name, or the roster's unnamed fallback label. */
  function rowName(row: PendingInvite): string {
    return row.display_name ?? t('committee.roster.row.unnamed');
  }

  function rolesText(row: PendingInvite): string {
    return row.roles.map((r) => t(`committee.roster.role.${r}`)).join(', ');
  }

  async function startResend(row: PendingInvite): Promise<void> {
    activeId = row.invite_id;
    rowPhase = 'confirm';
    await tick();
    confirmHeadingEl?.focus();
  }

  async function cancelConfirm(row: PendingInvite): Promise<void> {
    activeId = null;
    await tick();
    actionBtns[row.invite_id]?.focus();
  }

  async function confirmGo(row: PendingInvite): Promise<void> {
    rowPhase = 'submitting';
    // F-176: fresh code minted here (CSPRNG), held in one variable.
    const code = generateInviteCode();
    const result = await client.reissueTotp({ invite_id: row.invite_id, code });
    if (result.ok) {
      shownCode = code;
      rowPhase = 'code_shown';
      return;
    }
    if (result.reason === 'invite_invalid') {
      rowPhase = 'invalid';
      await tick();
      invalidHeadingEl?.focus();
      return;
    }
    // Any other incl. 429 / rls_denied → generic (never echo the raw reason).
    rowPhase = 'error';
    await tick();
    errorHeadingEl?.focus();
  }

  async function doneResend(row: PendingInvite): Promise<void> {
    activeId = null;
    shownCode = '';
    await tick();
    actionBtns[row.invite_id]?.focus();
  }

  async function resendNowAgain(row: PendingInvite): Promise<void> {
    // "Send a different code" — re-mint a fresh code for the SAME invite.
    const code = generateInviteCode();
    const result = await client.reissueTotp({ invite_id: row.invite_id, code });
    if (result.ok) {
      shownCode = code;
      return;
    }
    if (result.reason === 'invite_invalid') {
      rowPhase = 'invalid';
      await tick();
      invalidHeadingEl?.focus();
      return;
    }
    rowPhase = 'error';
    await tick();
    errorHeadingEl?.focus();
  }

  function reinvite(): void {
    activeId = null;
    onReinvite();
  }
</script>

<section
  class="card pending-card"
  data-testid="committee-pending"
  aria-busy={busy ? 'true' : 'false'}
>
  <h2 class="pending-heading">{t('committee.resend.section.heading')}</h2>
  <p class="pending-blurb">{t('committee.resend.section.blurb')}</p>

  {#if phase === 'loading'}
    <p class="pending-loading" role="status" data-testid="committee-pending-loading">
      {t('committee.resend.loading')}
    </p>
  {:else if phase === 'error'}
    <div
      class="pending-banner pending-banner-danger"
      role="alert"
      data-testid="committee-pending-error"
    >
      <svg class="pending-banner-icon" viewBox="0 0 24 24" aria-hidden="true">
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
        <h3 class="pending-banner-heading" tabindex="-1" bind:this={listErrorHeadingEl}>
          {t('committee.resend.error.generic.heading')}
        </h3>
        <p class="pending-banner-body">{t('committee.resend.error.generic.body')}</p>
        <button type="button" class="pending-retry" on:click={load}>
          {t('committee.roster.error.retry')}
        </button>
      </div>
    </div>
  {:else if phase === 'empty'}
    <div class="pending-empty" role="status" data-testid="committee-pending-empty">
      <h3 class="pending-empty-heading">{t('committee.resend.empty.heading')}</h3>
      <p class="pending-empty-body">{t('committee.resend.empty.body')}</p>
    </div>
  {:else if phase === 'list'}
    <ul
      class="pending-list"
      data-testid="committee-pending-list"
      aria-label={t('committee.resend.list_aria')}
    >
      {#each rows as row, i (row.invite_id)}
        {@const expired = isExpired(row)}
        {@const active = activeId === row.invite_id}
        <li class="pending-row" data-testid="committee-pending-row">
          <div class="pending-row-group" role="group" aria-labelledby={`pending-name-${i}`}>
            <span id={`pending-name-${i}`} class="pending-row-name">
              {#if row.display_name}
                {row.display_name}
              {:else}
                <span class="pending-row-unnamed">{t('committee.roster.row.unnamed')}</span>
                <span class="pending-row-uid">{row.target_user_id.slice(0, 8)}</span>
              {/if}
            </span>

            {#if expired}
              <span class="badge badge-pending pending-status">
                <svg class="pending-status-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <circle
                    cx="12"
                    cy="12"
                    r="9"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  />
                  <path
                    d="M12 7v5l3 2"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                {t('committee.resend.status.expired')}
              </span>
            {:else}
              <span class="badge badge-info pending-status">
                <svg class="pending-status-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <rect
                    x="2"
                    y="4"
                    width="20"
                    height="16"
                    rx="2"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  />
                  <path
                    d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                {t('committee.resend.status.waiting')}
              </span>
            {/if}

            {#if row.roles.length > 0}
              <p class="pending-row-meta pending-row-roles">{rolesText(row)}</p>
            {/if}

            <p class="pending-row-meta pending-row-date">
              {t('committee.resend.row.issued', { date: isoDate(row.issued_at) })}
            </p>
            <p class="pending-row-meta pending-row-date">
              {t('committee.resend.row.expires', { date: isoDate(row.expires_at) })}
            </p>

            {#if expired}
              <button
                type="button"
                class="pending-action"
                bind:this={actionBtns[row.invite_id]}
                on:click={reinvite}
              >
                {t('committee.resend.row.reinvite')}
              </button>
            {:else}
              <button
                type="button"
                class="pending-action btn-outline"
                aria-label={t('committee.resend.row.action_aria', { name: rowName(row) })}
                bind:this={actionBtns[row.invite_id]}
                disabled={active && rowPhase === 'submitting'}
                on:click={() => startResend(row)}
              >
                {#if active && rowPhase === 'submitting'}
                  <svg class="pending-spinner" viewBox="0 0 24 24" aria-hidden="true">
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
                  {t('committee.resend.submitting')}
                {:else}
                  {t('committee.resend.row.action')}
                {/if}
              </button>
            {/if}

            {#if active && rowPhase === 'submitting'}
              <p class="sr-only" role="status">{t('a11y.committee.resend.submitting')}</p>
            {/if}

            {#if active && rowPhase === 'confirm'}
              <div
                class="pending-confirm"
                role="group"
                aria-labelledby="committee-resend-confirm-heading"
                data-testid="committee-resend-confirm"
              >
                <svg class="pending-confirm-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0z"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                  <path
                    d="M12 9v4m0 3h.01"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
                <div class="pending-confirm-body">
                  <h3
                    id="committee-resend-confirm-heading"
                    class="pending-confirm-heading"
                    tabindex="-1"
                    bind:this={confirmHeadingEl}
                  >
                    {t('committee.resend.confirm.heading')}
                  </h3>
                  <p class="pending-confirm-text">{t('committee.resend.confirm.body')}</p>
                  <div class="pending-confirm-actions">
                    <button
                      type="button"
                      class="pending-confirm-go"
                      on:click={() => confirmGo(row)}
                    >
                      {t('committee.resend.confirm.go')}
                    </button>
                    <button
                      type="button"
                      class="pending-confirm-cancel"
                      on:click={() => cancelConfirm(row)}
                    >
                      {t('committee.resend.confirm.cancel')}
                    </button>
                  </div>
                </div>
              </div>
            {:else if active && rowPhase === 'code_shown'}
              <OneTimeCodeCard
                code={shownCode}
                inviteId={row.invite_id}
                heading={t('committee.resend.code.heading')}
                codeReadyAnnounce={t('a11y.committee.resend.code_ready')}
                cardTestid="committee-resend-code"
                valueTestid="committee-resend-code-value"
                onDone={() => doneResend(row)}
                onResendNow={() => resendNowAgain(row)}
              />
            {:else if active && rowPhase === 'invalid'}
              <div
                class="pending-banner pending-banner-warning"
                role="alert"
                data-testid="committee-resend-invalid"
              >
                <svg class="pending-banner-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0z"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                  <path
                    d="M12 9v4m0 3h.01"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
                <div>
                  <h3 class="pending-banner-heading" tabindex="-1" bind:this={invalidHeadingEl}>
                    {t('committee.resend.invalid.heading')}
                  </h3>
                  <p class="pending-banner-body">{t('committee.resend.invalid.body')}</p>
                  <button type="button" class="pending-reinvite" on:click={reinvite}>
                    {t('committee.resend.invalid.reinvite')}
                  </button>
                </div>
              </div>
            {:else if active && rowPhase === 'error'}
              <div
                class="pending-banner pending-banner-danger"
                role="alert"
                data-testid="committee-resend-error"
              >
                <svg class="pending-banner-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <circle
                    cx="12"
                    cy="12"
                    r="9"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  />
                  <path
                    d="m15 9-6 6m0-6 6 6"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
                <div>
                  <h3 class="pending-banner-heading" tabindex="-1" bind:this={errorHeadingEl}>
                    {t('committee.resend.error.generic.heading')}
                  </h3>
                  <p class="pending-banner-body">{t('committee.resend.error.generic.body')}</p>
                </div>
              </div>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .pending-card {
    margin-block-start: 1rem;
  }
  .pending-heading {
    margin: 0 0 0.25rem;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--color-fg);
  }
  .pending-blurb {
    margin: 0;
    color: var(--color-fg-muted);
    font-size: 0.875rem;
  }
  .pending-loading {
    margin-block-start: 1rem;
    color: var(--color-fg-muted);
  }

  .pending-empty {
    margin-block-start: 1rem;
    color: var(--color-fg-muted);
  }
  .pending-empty-heading {
    margin: 0 0 0.25rem;
    font-size: 1rem;
  }
  .pending-empty-body {
    margin: 0;
    max-width: 32rem;
  }

  .pending-list {
    list-style: none;
    margin: 1rem 0 0;
    padding: 0;
    display: grid;
    gap: 0.75rem;
  }
  .pending-row {
    padding: 0.75rem 1rem;
    border: var(--border-width-hairline) solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background-color: var(--color-bg-elevated);
  }
  .pending-row-group {
    display: grid;
    justify-items: start;
    gap: 0.375rem;
  }
  .pending-row-name {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-fg);
  }
  .pending-row-unnamed {
    font-weight: 500;
    color: var(--color-fg-muted);
  }
  .pending-row-uid {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--color-fg-muted);
  }
  .pending-status {
    gap: 0.25rem;
  }
  .pending-status-icon {
    width: 0.75rem;
    height: 0.75rem;
    flex: none;
  }
  .pending-row-meta {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--color-fg-muted);
  }
  .pending-row-date {
    color: var(--color-fg-subtle);
  }
  .pending-action {
    margin-block-start: 0.5rem;
  }

  .pending-spinner {
    width: 1rem;
    height: 1rem;
    flex: none;
    animation: pending-spin 0.9s linear infinite;
  }
  @keyframes pending-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .pending-confirm {
    display: flex;
    gap: 0.625rem;
    align-items: flex-start;
    width: 100%;
    margin-block-start: 0.5rem;
    padding: 0.75rem 1rem;
    border: var(--border-width-default) solid var(--color-tint-amber-border);
    border-inline-start-width: var(--border-width-thick);
    border-radius: var(--radius-md);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
  }
  .pending-confirm-icon {
    width: 1.25rem;
    height: 1.25rem;
    flex: none;
    margin-block-start: 0.125rem;
  }
  .pending-confirm-body {
    flex: 1;
  }
  .pending-confirm-heading {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
  }
  .pending-confirm-text {
    margin-block: 0.25rem 0.5rem;
    font-size: 0.875rem;
  }
  .pending-confirm-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .pending-confirm-go {
    background: var(--color-accent);
    color: var(--color-accent-fg);
    border-color: var(--color-accent);
    min-height: 2.75rem;
  }
  .pending-confirm-go:hover:not(:disabled) {
    background: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
    opacity: 1;
  }
  .pending-confirm-cancel {
    background: transparent;
    color: inherit;
    border-color: currentColor;
    min-height: 2.75rem;
  }

  .pending-banner {
    display: flex;
    gap: 0.625rem;
    align-items: flex-start;
    width: 100%;
    margin-block-start: 0.5rem;
    padding: 0.75rem 1rem;
    border: var(--border-width-default) solid transparent;
    border-radius: var(--radius-md);
  }
  .pending-banner-icon {
    width: 1.25rem;
    height: 1.25rem;
    flex: none;
    margin-block-start: 0.125rem;
  }
  .pending-banner-heading {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
  }
  .pending-banner-body {
    margin-block: 0.25rem 0;
    font-size: 0.875rem;
  }
  .pending-banner-warning {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-color: var(--color-tint-amber-border);
  }
  .pending-banner-danger {
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-color: var(--color-tint-red-border);
  }
  .pending-retry,
  .pending-reinvite {
    margin-block-start: 0.5rem;
    min-height: 2.25rem;
    background: transparent;
    color: inherit;
    border-color: currentColor;
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
