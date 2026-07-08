<script lang="ts">
  /**
   * CommitteeRoster — the renderable read-only co-chair roster surface
   * (ADR-0029 P1-8b / Surface K, screen 1).
   *
   * The authenticated sibling of the /concerns + /reprisal state ladders, with a
   * Surface-K-specific "not a co-chair" stop. The route shell constructs the
   * committee-op client and forwards it here; this component owns the visible
   * state machine + the a11y packet (list/group semantics, live-region role
   * split, aria-busy, color-never-alone badges).
   *
   * Injection (REAL Svelte props with a production-safe default; NO __test_* per
   * ADR-0020 Decision 8):
   *   - client — an object exposing `listRoster()`. The route wires
   *              `createSupabaseCommitteeClient`; the default is an inert client
   *              that maps to the generic error state (never crashes).
   * The signed-in gate reads the production `$isSignedIn` store — the signed-out
   * branch short-circuits BEFORE any read (F-178: no roster PI is even fetched
   * for a signed-out visitor).
   *
   * Role-gate (the load-bearing mechanism): there is NO committee-role claim in
   * the JWT, so the ONLY co-chair signal is the roster read itself. A non-co-chair
   * `listRoster()` returns `{ ok:false, reason:'rls_denied', status:403 }` — mapped
   * to the calm not-a-co-chair stop (polite role="status"). `status:401` →
   * session-expired (assertive). Any other failure → the generic error state.
   *
   * F-178 / F-176 invariants enforced here:
   *   - no member PI / raw uid is written to a URL / history / storage / log.
   *   - the read is parameterless (whole-committee, JWT-bound).
   *   - a NULL display_name renders a fallback label + an 8-char uid FRAGMENT —
   *     the full user_id is never rendered.
   *   - the raw `reason` enum / HTTP status is never echoed to the user.
   */
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { isSignedIn } from '$lib/auth/session-jwt-svelte';
  import type { RosterRow, CommitteeOpResult } from './supabase-committee-client';

  type CommitteeClient = {
    listRoster: () => Promise<CommitteeOpResult<RosterRow[]>>;
  };

  /** @see createSupabaseCommitteeClient — production wires the real client. */
  export let client: CommitteeClient = {
    // Production-safe default: an inert client that maps to the generic error
    // state rather than throwing when a caller forgets to wire the real one.
    listRoster: async () => ({ ok: false, reason: 'unknown', status: 0 })
  };

  // Surface-K state machine (signed-out is derived from $isSignedIn, ahead of
  // these phases). 'loading' is the initial phase for a signed-in mount.
  type Phase = 'loading' | 'not_co_chair' | 'session_expired' | 'error' | 'empty' | 'list';
  let phase: Phase = 'loading';
  let rows: RosterRow[] = [];

  // aria-busy is true only while a read is genuinely in flight for a signed-in
  // co-chair — never in the signed-out short-circuit.
  $: busy = $isSignedIn && phase === 'loading';

  onMount(() => {
    // Signed-out gate — short-circuit BEFORE any listRoster() read (F-178).
    if (!$isSignedIn) return;
    void load();
  });

  async function load(): Promise<void> {
    phase = 'loading';
    const result = await client.listRoster();
    if (result.ok) {
      rows = result.data;
      phase = rows.length === 0 ? 'empty' : 'list';
      return;
    }
    // Branch on STATUS, not the reason enum (401 ≠ 403 despite a shared reason).
    if (result.status === 401) {
      phase = 'session_expired';
    } else if (result.status === 403) {
      phase = 'not_co_chair';
    } else {
      // Any other failure (500 / network status 0 / unexpected reason) — generic
      // error. The raw reason enum is mapped away, never rendered (F-176).
      phase = 'error';
    }
  }

  type BadgeKind = 'active' | 'pending_grant' | 'awaiting_identity' | 'pending_invite' | 'inactive';

  /**
   * Derive the grant-state badge CLIENT-SIDE from the RosterRow columns
   * (Amendment A-8.1 pinned predicates; no server badge field). `active` is the
   * authoritative live/not-live gate; activated_at/deactivated_at only
   * disambiguate the two inactive sub-states.
   */
  function badgeKind(row: RosterRow): BadgeKind {
    if (row.active) {
      if (!row.has_identity_key) return 'awaiting_identity';
      return row.has_live_wrap ? 'active' : 'pending_grant';
    }
    if (row.deactivated_at != null) return 'inactive';
    return 'pending_invite';
  }

  const BADGE_CLASS: Record<BadgeKind, string> = {
    active: 'badge-resolved',
    pending_grant: 'badge-pending',
    awaiting_identity: 'badge-info',
    pending_invite: 'badge-info',
    inactive: 'badge-neutral'
  };

  /** ISO YYYY-MM-DD (§7) — clock-independent slice of the server ISO string. */
  function isoDate(s: string | null): string {
    return s ? s.slice(0, 10) : '';
  }
</script>

<section
  class="card committee-card"
  data-testid="committee-page"
  aria-busy={busy ? 'true' : 'false'}
>
  <h1>{t('committee.roster.title')}</h1>

  {#if !$isSignedIn}
    <p role="status" data-testid="committee-signed-out">
      <a href="/sign-in">{t('committee.roster.signed_out')}</a>
    </p>
  {:else if phase === 'loading'}
    <p role="status" class="committee-loading" data-testid="committee-loading">
      {t('committee.roster.loading')}
    </p>
  {:else if phase === 'not_co_chair'}
    <div
      class="committee-banner committee-banner-info"
      role="status"
      data-testid="committee-not-co-chair"
    >
      <svg class="committee-banner-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
        <path
          d="M12 11v5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
        <path
          d="M12 8h.01"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
      </svg>
      <div>
        <h2 class="committee-banner-heading">{t('committee.roster.not_co_chair.heading')}</h2>
        <p class="committee-banner-body">{t('committee.roster.not_co_chair.body')}</p>
        <a href="/more" class="cta committee-back">{t('committee.roster.not_co_chair.back')}</a>
      </div>
    </div>
  {:else if phase === 'session_expired'}
    <p role="alert" data-testid="committee-session-expired">
      <a href="/sign-in">{t('committee.roster.session_expired')}</a>
    </p>
  {:else if phase === 'error'}
    <div
      class="committee-banner committee-banner-danger"
      role="alert"
      data-testid="committee-list-error"
    >
      <svg class="committee-banner-icon" viewBox="0 0 24 24" aria-hidden="true">
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
        <h2 class="committee-banner-heading">{t('committee.roster.error.heading')}</h2>
        <p class="committee-banner-body">{t('committee.roster.error.body')}</p>
        <button type="button" class="btn committee-retry" on:click={() => load()}>
          {t('committee.roster.error.retry')}
        </button>
      </div>
    </div>
  {:else if phase === 'empty'}
    <div class="committee-empty" role="status" data-testid="committee-empty">
      <svg class="committee-empty-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <circle cx="9" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="2" />
        <path
          d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <h2 class="committee-empty-heading">{t('committee.roster.empty.heading')}</h2>
      <p class="committee-empty-body">{t('committee.roster.empty.body')}</p>
    </div>
  {:else if phase === 'list'}
    <p role="status" class="sr-only" data-testid="committee-roster-loaded">
      {t('a11y.committee.roster.loaded', { count: rows.length })}
    </p>
    <ul
      class="committee-list"
      data-testid="committee-roster-list"
      aria-label={t('committee.roster.list_aria')}
    >
      {#each rows as row, i (row.user_id)}
        {@const kind = badgeKind(row)}
        <li class="committee-row" data-testid="committee-roster-row">
          <div
            class="committee-row-group"
            class:committee-row-removed={kind === 'inactive'}
            role="group"
            aria-labelledby={`committee-member-${i}`}
          >
            <span id={`committee-member-${i}`} class="committee-row-name">
              {#if row.display_name}
                {row.display_name}
              {:else}
                <span class="committee-row-unnamed">{t('committee.roster.row.unnamed')}</span>
                <span class="committee-row-uid">{row.user_id.slice(0, 8)}</span>
              {/if}
            </span>

            <span class="badge {BADGE_CLASS[kind]}" data-testid="committee-badge">
              <svg class="badge-icon" viewBox="0 0 24 24" aria-hidden="true">
                {#if kind === 'active'}
                  <circle
                    cx="12"
                    cy="12"
                    r="9"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  />
                  <path
                    d="m8.5 12 2.5 2.5 4.5-5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                {:else if kind === 'pending_grant'}
                  <path
                    d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                  <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
                {:else if kind === 'awaiting_identity'}
                  <path
                    d="M5 22h14M5 2h14"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                  <path
                    d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                  <path
                    d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                {:else if kind === 'pending_invite'}
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
                {:else if kind === 'inactive'}
                  <path
                    d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                  <circle cx="9" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="2" />
                  <path
                    d="m17 8 5 5m0-5-5 5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                {/if}
              </svg>
              <span class="badge-text" aria-hidden="true">
                {t(`committee.roster.badge.${kind}.text`)}
              </span>
              <span class="sr-only" data-testid="committee-badge-sr">
                {t(`committee.roster.badge.${kind}.sr`)}
              </span>
            </span>

            {#if row.roles.length > 0}
              <p class="committee-row-meta committee-row-roles">
                {row.roles.map((r) => t(`committee.roster.role.${r}`)).join(', ')}
              </p>
            {/if}

            {#if row.off_employer_contact}
              <p class="committee-row-meta committee-row-contact">
                {t('committee.roster.row.contact_label')}: {row.off_employer_contact}
              </p>
            {/if}

            {#if kind === 'active'}
              <p class="committee-row-meta committee-row-date">
                {t('committee.roster.row.date_member_since', { date: isoDate(row.activated_at) })}
              </p>
            {:else if kind === 'pending_grant' || kind === 'awaiting_identity'}
              <p class="committee-row-meta committee-row-date">
                {t('committee.roster.row.date_joined', { date: isoDate(row.activated_at) })}
              </p>
            {:else if kind === 'pending_invite'}
              <p class="committee-row-meta committee-row-date">
                {t('committee.roster.row.date_invited', { date: isoDate(row.invited_at) })}
              </p>
            {:else if kind === 'inactive'}
              <p class="committee-row-meta committee-row-date">
                {t('committee.roster.row.date_removed', { date: isoDate(row.deactivated_at) })}
              </p>
              {#if row.grace_until}
                <p class="committee-row-meta committee-row-date">
                  {t('committee.roster.row.date_grace_until', { date: isoDate(row.grace_until) })}
                </p>
              {/if}
            {/if}
          </div>
        </li>
      {/each}
    </ul>

    <p class="committee-footer">
      <a href="/more" data-testid="committee-back-to-more">{t('committee.roster.back_to_more')}</a>
    </p>
  {/if}
</section>

<style>
  /*
   * Surface K roster. Single card section inside the app-shell <main>. All
   * colour / radius / shadow / border come from the app's CSS-variable token
   * palette (app.html boot sheet); the two-layer AODA focus ring is inherited
   * from app.css :focus-visible. The badge chrome (.badge / .badge-*) is the
   * shared app.css token-bound treatment.
   */
  .committee-card {
    margin-block-start: 1rem;
  }

  .committee-loading {
    color: var(--color-fg-muted);
  }

  /* Alert-banner strips (icon + text — colour never alone, anti-pattern 3). */
  .committee-banner {
    display: flex;
    gap: 0.625rem;
    align-items: flex-start;
    margin-block-start: 1rem;
    padding: 0.75rem 1rem;
    border: var(--border-width-default) solid transparent;
    border-radius: var(--radius-md);
  }
  .committee-banner-icon {
    width: 1.25rem;
    height: 1.25rem;
    flex: none;
    margin-block-start: 0.125rem;
  }
  .committee-banner-heading {
    margin: 0;
    font-size: 1rem;
  }
  .committee-banner-body {
    margin-block: 0.25rem 0;
  }
  .committee-banner-info {
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    border-color: var(--color-tint-blue-border);
  }
  .committee-banner-danger {
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-color: var(--color-tint-red-border);
  }
  .committee-back {
    margin-block-start: 0.75rem;
  }
  .committee-retry {
    margin-block-start: 0.75rem;
  }

  .committee-empty {
    margin-block-start: 1rem;
    text-align: center;
    color: var(--color-fg-muted);
  }
  .committee-empty-icon {
    width: 2rem;
    height: 2rem;
    color: var(--color-fg-subtle);
  }
  .committee-empty-heading {
    margin-block: 0.5rem 0.25rem;
    font-size: 1rem;
  }
  .committee-empty-body {
    margin: 0 auto;
    max-width: 32rem;
  }

  .committee-list {
    list-style: none;
    margin: 1rem 0 0;
    padding: 0;
    display: grid;
    gap: 0.75rem;
  }
  .committee-row {
    padding: 0.75rem 1rem;
    border: var(--border-width-hairline) solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background-color: var(--color-bg-elevated);
  }
  .committee-row-group {
    display: grid;
    justify-items: start;
    gap: 0.25rem;
  }
  .committee-row-removed {
    color: var(--color-fg-subtle);
  }
  .committee-row-name {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-fg);
  }
  .committee-row-removed .committee-row-name {
    color: var(--color-fg-muted);
  }
  .committee-row-unnamed {
    font-weight: 500;
    color: var(--color-fg-muted);
  }
  .committee-row-uid {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--color-fg-muted);
  }
  .committee-row-meta {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--color-fg-muted);
  }
  .committee-row-date {
    color: var(--color-fg-subtle);
  }

  .badge-icon {
    width: 0.75rem;
    height: 0.75rem;
    flex: none;
  }

  .committee-footer {
    margin-block-start: 1rem;
  }

  /* Visually-hidden live region + SR badge label (mirrors RedeemCard). */
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
