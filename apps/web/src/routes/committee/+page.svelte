<script>
  /**
   * /committee — production mount for the co-chair member-management surface
   * (ADR-0029 P1-8b / Surface K, screen 1: the read-only roster).
   *
   * A thin wiring layer (mirrors /concerns + /reprisal + /redeem): it constructs
   * the committee-op client over the shared fetch transport — `getJwt` for the
   * bearer, `onSessionRevoked=clearJwt` for the F-39 revocation loop — and
   * composes the renderable CommitteeRoster lib component (where the Surface-K
   * state machine + a11y packet live).
   *
   * Role-gate: there is NO committee-role claim in the JWT, so the ONLY co-chair
   * signal is the roster read itself. CommitteeRoster calls `listRoster()` on
   * mount; a non-co-chair's read RAISEs `rls_denied` (403) and lands on the calm
   * not-a-co-chair stop. Every signed-in member reaches this route from /more.
   *
   * F-178 / F-176: the roster read is PARAMETERLESS + JWT-bound — the route never
   * appends member PI or a raw uid to a URL / query string. Page is
   * noindex,nofollow (the roster is not indexed).
   *
   * `<script>` (no lang="ts") — same thin-shell posture as /redeem + /concerns.
   */
  import { env } from '$env/dynamic/public';
  import { t } from '$lib/i18n';
  import CommitteeInvite from '$lib/committee/CommitteeInvite.svelte';
  import CommitteeRoster from '$lib/committee/CommitteeRoster.svelte';
  import PendingInvites from '$lib/committee/PendingInvites.svelte';
  import { createSupabaseCommitteeClient } from '$lib/server-client/committee-client-factory';
  import { createSupabaseT07Client } from '$lib/server-client/t07-client-factory';
  import { BrowserLocalIdentityStore } from '$lib/crypto/browser-local-identity-store';
  import { getSessionCommitteeKeyHolder } from '$lib/crypto/committee-key-holder';
  import { clearJwt, getJwt } from '$lib/auth/session-jwt-store';

  const baseUrl = env.PUBLIC_SUPABASE_URL ?? 'http://localhost:54321';

  const committeeClient = createSupabaseCommitteeClient({
    baseUrl,
    getJwt,
    onSessionRevoked: clearJwt
  });

  // Screen-3 grant ceremony deps (ADR-0029 P1-8d). Mirrors the Settings /
  // /concerns client-construction site: a t07 client threaded with the
  // device-local identity store (the single getMemberPubkey disclosure + the
  // seal composition), the session-scoped committee-key holder, and the local
  // identity store. Threaded into CommitteeRoster so a pending-grant row can
  // reveal its CommitteeGrantCard. Same getJwt + F-39 revocation wiring as the
  // committee client above.
  const localIdentity = new BrowserLocalIdentityStore();
  const t07Client = createSupabaseT07Client({
    baseUrl,
    getJwt,
    onSessionRevoked: clearJwt,
    localIdentity
  });
  const keyHolder = getSessionCommitteeKeyHolder();

  // The screen-2 invite panel; the expired-row "Invite again" in the
  // Pending-invites section (screen 4) hands off here to open it.
  let inviteRef;
</script>

<svelte:head>
  <title>{t('committee.roster.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<CommitteeInvite bind:this={inviteRef} client={committeeClient} />

<CommitteeRoster
  client={committeeClient}
  grantClient={t07Client}
  grantHolder={keyHolder}
  grantLocalIdentity={localIdentity}
  manageEnabled={true}
/>

<PendingInvites client={committeeClient} onReinvite={() => inviteRef?.openInvitePanel()} />
