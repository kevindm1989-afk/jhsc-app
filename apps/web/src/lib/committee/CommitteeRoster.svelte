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
  import { onMount, tick } from 'svelte';
  import { t } from '$lib/i18n';
  import { isSignedIn } from '$lib/auth/session-jwt-svelte';
  import { getCurrentUserId } from '$lib/auth/jwt-claims';
  import CommitteeGrantCard from './CommitteeGrantCard.svelte';
  import CommitteeManageMemberCard from './CommitteeManageMemberCard.svelte';
  import { deriveRemainingMembers } from './supabase-committee-client';
  import { makeRemoveRotationOrchestration } from './remove-rotation-orchestration';
  import type { RosterRow, CommitteeOpResult } from './supabase-committee-client';
  import type {
    SupabaseT07Client,
    CommitteeKeyHolder,
    LocalIdentityStore,
    RotateCommitteeKeyOnRemovalResult
  } from '$lib/crypto';

  /**
   * The committee-op client. `listRoster` is always required; the three
   * screen-5 governance ops (`setRoles`/`removeMember`/`reactivateMember`) are
   * OPTIONAL — present on the production `SupabaseCommitteeClient`, absent on the
   * inert default. When `manageEnabled` is set AND they are present, each row
   * mounts a `CommitteeManageMemberCard` (see the attach block below).
   */
  type CommitteeClient = {
    listRoster: () => Promise<CommitteeOpResult<RosterRow[]>>;
    // `_input` is a TYPE-SIGNATURE label only (never a runtime binding); the
    // underscore keeps no-unused-vars quiet on the optional method shapes.
    setRoles?: (_input: {
      target_user_id: string;
      roles: string[];
      second_approver_id?: string | null;
    }) => Promise<CommitteeOpResult<null>>;
    removeMember?: (_input: {
      target_user_id: string;
      second_approver_id?: string | null;
    }) => Promise<CommitteeOpResult<string>>;
    reactivateMember?: (_input: { target_user_id: string }) => Promise<CommitteeOpResult<null>>;
  };

  /** @see createSupabaseCommitteeClient — production wires the real client. */
  export let client: CommitteeClient = {
    // Production-safe default: an inert client that maps to the generic error
    // state rather than throwing when a caller forgets to wire the real one.
    listRoster: async () => ({ ok: false, reason: 'unknown', status: 0 })
  };

  // ── Screen 3 grant deps (ADR-0029 P1-8d) ──────────────────────────────────
  // The grant ceremony's three dependencies, threaded from the /committee route.
  // When ALL are wired, a `pending_grant` row reveals its per-row
  // CommitteeGrantCard (the first interactive per-row affordance). When they are
  // absent (the P1-8b read-only composition — the roster suite renders the
  // roster with `client` ONLY), the roster stays read-only signage: no grant
  // control mounts on any row.
  /** Production t07 client (the single `getMemberPubkey` disclosure owner). */
  export let grantClient: SupabaseT07Client | null = null;
  /** The actor's session committee-key holder. */
  export let grantHolder: CommitteeKeyHolder | null = null;
  /** The device-local identity store. */
  export let grantLocalIdentity: LocalIdentityStore | null = null;

  // ── Screen 5 management deps (ADR-0029 P1-8e) ─────────────────────────────
  // Mirrors the grant-card optional-deps attach: the /committee route sets
  // `manageEnabled` true (it renders the roster only for co-chairs), and the same
  // `client` now also carries the three governance ops. When enabled, each
  // active-family / removed row mounts its per-row CommitteeManageMemberCard
  // (change roles / remove / reactivate) inside the row's `role="group"`. When
  // absent (the P1-8b read-only + P1-8c/d compositions) the roster stays
  // read-only signage — no management control mounts on any row.
  export let manageEnabled = false;

  // The self-action discriminator + eligible-approver exclusion. Computed ONCE
  // for the whole roster (F-181): `eligibleApprovers` keys off the `active`
  // boolean + role membership (NOT the badge — a pending_grant/awaiting_identity
  // co-chair is `active===true` and IS a valid second approver per the SQL), self
  // excluded. Never used to compute "is last co-chair" — the server truths that.
  $: currentUserId = getCurrentUserId();
  $: eligibleApprovers = rows.filter(
    (r) => r.active && r.roles.includes('worker_co_chair') && r.user_id !== currentUserId
  );
  // Manage mounts only when enabled AND the client actually carries the ops (the
  // inert default does not), so an accidental enablement never no-ops loudly.
  $: manageReady =
    manageEnabled &&
    typeof client.setRoles === 'function' &&
    typeof client.removeMember === 'function' &&
    typeof client.reactivateMember === 'function';

  // ── F182-6 rotation seam (ADR-0030 Amendment C, Decision C4) ──────────────
  // The `rotateOnRemoval` orchestration is threaded ONLY when the three crypto
  // deps are present (mirrors the grant-card attach guard). A governance-only
  // mount threads NO rotation capability, so the card's Remove-CTA gate stays
  // honest (VC-1). The orchestration derives `actor_public_key` in the crypto
  // layer, never in the card (AC-C13); the card sees only opaque handles + a
  // status union.
  type CardRotateInput = {
    removed_member_id: string;
    remaining_members: ReadonlyArray<{ user_id: string }>;
    resume?: { rotation_id: string; new_key_id: string };
  };
  type ManageCardClient = {
    // `_i` are TYPE-SIGNATURE labels only (never a runtime binding); the leading
    // underscore keeps no-unused-vars quiet on the structural method shapes.
    setRoles: (_i: {
      target_user_id: string;
      roles: string[];
      second_approver_id?: string | null;
    }) => Promise<CommitteeOpResult<null>>;
    removeMember: (_i: {
      target_user_id: string;
      second_approver_id?: string | null;
    }) => Promise<CommitteeOpResult<string>>;
    reactivateMember: (_i: { target_user_id: string }) => Promise<CommitteeOpResult<null>>;
    rotateOnRemoval?: (_i: CardRotateInput) => Promise<RotateCommitteeKeyOnRemovalResult>;
  };

  $: rotateOnRemovalFn =
    grantClient && grantHolder && grantLocalIdentity && currentUserId
      ? makeRemoveRotationOrchestration({
          client: grantClient,
          holder: grantHolder,
          localIdentity: grantLocalIdentity,
          user_id: currentUserId
        })
      : null;

  $: manageCardClient = buildManageCardClient(rotateOnRemovalFn);

  function buildManageCardClient(
    rotate: ((_i: CardRotateInput) => Promise<RotateCommitteeKeyOnRemovalResult>) | null
  ): ManageCardClient {
    const base: ManageCardClient = {
      // ADV-1: wrap each op in an arrow so the ORIGINAL SupabaseCommitteeClient
      // instance stays `this` at call time (pulling the bare prototype methods
      // onto a literal would detach `this` and throw before the transport).
      setRoles: (i) => client.setRoles!(i),
      removeMember: (i) => client.removeMember!(i),
      reactivateMember: (i) => client.reactivateMember!(i)
    };
    if (rotate) base.rotateOnRemoval = rotate;
    return base;
  }

  // Surface-K state machine (signed-out is derived from $isSignedIn, ahead of
  // these phases). 'loading' is the initial phase for a signed-in mount.
  type Phase = 'loading' | 'not_co_chair' | 'session_expired' | 'error' | 'empty' | 'list';
  let phase: Phase = 'loading';
  let rows: RosterRow[] = [];

  // The persistent page heading (F1 / WCAG 2.4.3 focus target). It lives OUTSIDE
  // the {#if} state branches, so it survives every phase transition — including
  // the Retry reload that unmounts the error banner + its button.
  let headingEl: HTMLHeadingElement | null = null;

  // aria-busy is true only while a read is genuinely in flight for a signed-in
  // co-chair — never in the signed-out short-circuit.
  $: busy = $isSignedIn && phase === 'loading';

  // F2 (WCAG 4.1.3): a SINGLE persistent polite live region (mounted from the
  // first render, mutated in place) announces the loaded member count. NVDA and
  // some VoiceOver/browser combos DROP a live region that arrives already
  // populated, so the count is written as a MUTATION of an already-present node,
  // never an insertion. The visible role="status" loading line already owns the
  // loading announcement, so this region stays empty until the list resolves —
  // duplicating the loading text here would double-announce it.
  $: liveMessage =
    $isSignedIn && phase === 'list'
      ? t('a11y.committee.roster.loaded', { count: rows.length })
      : '';

  onMount(() => {
    // Signed-out gate — short-circuit BEFORE any listRoster() read (F-178).
    if (!$isSignedIn) return;
    // Initial mount does NOT move focus (mirrors RedeemCard scoping the focus
    // moves to explicit user actions, never the mount).
    void load();
  });

  async function load(): Promise<void> {
    // ADV-2: only the INITIAL load unmounts the list to show `loading`. A
    // post-mutation refetch (onChanged from a manage card) keeps the existing
    // list mounted and swaps `rows` in place, so the keyed {#each} preserves the
    // open card + its done modal + its focus across the server-truthed refresh.
    if (rows.length === 0) phase = 'loading';
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

  /**
   * F1 (WCAG 2.4.3): re-run the read from the error state, then move focus to
   * the persistent page <h1>. Activating Retry unmounts the alert banner + its
   * button, so without this the focus would fall to <body> and a keyboard/SR
   * user would lose their place. Mirrors RedeemCard's
   * focusErrorHeading()/focusSuccessHeading() — scoped to this explicit user
   * action only, never the initial mount.
   */
  async function retry(): Promise<void> {
    await load();
    await tick();
    headingEl?.focus();
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
  <h1 tabindex="-1" bind:this={headingEl}>{t('committee.roster.title')}</h1>

  <!--
    F2 (WCAG 4.1.3): the single persistent polite live region. Present from the
    first render across every phase; its text is MUTATED in place (empty →
    "Committee roster loaded. N members.") so the count is reliably announced
    rather than dropped as an already-populated insertion. Carries the
    `committee-roster-loaded` testid the a11y suite resolves after load.
  -->
  <p class="sr-only" role="status" aria-live="polite" data-testid="committee-roster-loaded">
    {liveMessage}
  </p>

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
        <button type="button" class="btn committee-retry" on:click={retry}>
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

            <!-- Screen 3 (P1-8d): the single per-row control, ONLY on a
                 pending-grant row AND ONLY when the grant ceremony deps are
                 wired (the /committee route threads them). It sits inside the
                 row's role="group" so the SR reads it as part of this member's
                 unit. The card owns the disclose → confirm → seal state machine. -->
            {#if kind === 'pending_grant' && grantClient && grantHolder && grantLocalIdentity}
              <CommitteeGrantCard
                member={{ user_id: row.user_id, display_name: row.display_name }}
                client={grantClient}
                holder={grantHolder}
                localIdentity={grantLocalIdentity}
              />
            {/if}

            <!-- Screen 5 (P1-8e): the per-row management card (change roles /
                 remove / reactivate). Mounts ONLY when the route wires the manage
                 deps (mirrors the grant-card attach). It owns the modal state
                 machine; on a clean server mutation it signals `onChanged`, and we
                 re-run the roster read (server-truthed badge refresh — no
                 optimistic flip, F-181). The card itself renders no control on a
                 pending_invite row. -->
            {#if manageReady}
              <CommitteeManageMemberCard
                member={row}
                isSelf={row.user_id === currentUserId}
                {eligibleApprovers}
                remainingMembers={rotateOnRemovalFn
                  ? deriveRemainingMembers(rows, row.user_id)
                  : []}
                client={manageCardClient}
                onChanged={load}
              />
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
