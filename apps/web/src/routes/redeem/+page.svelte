<script>
  /**
   * /redeem — production mount for the member invite-redemption ceremony
   * (ADR-0029 P1-7 / Surface J).
   *
   * The unauthenticated, REPEATABLE sibling of /bootstrap. The route shell is a
   * thin wiring layer: it reads `invite_id` from the query string (F-170: the
   * link carries invite_id ONLY — the 6-digit code is member-ENTERED, never in
   * the URL), builds a fetch transport pointed at the `redeem-invite` Edge
   * Function, and composes the renderable RedeemCard lib component (where the
   * state machine + a11y packet live).
   *
   * Origin / rpId are derived inside RedeemCard from `window.location` at submit
   * time (SSR is disabled in +page.ts, so window is always defined when the
   * ceremony runs — mirrors /sign-in + /bootstrap). The success CTA forwards to
   * /sign-in (a hard seam; /redeem never runs sign-in / identity-enroll itself).
   *
   * `<script>` (no lang="ts") — same posture as /sign-in: the route is a thin
   * shell, dropping lang="ts" keeps svelte-check's strict implicit-any path
   * uniform with the rest of the route layer.
   */
  import { page } from '$app/stores';
  import { env } from '$env/dynamic/public';
  import { t } from '$lib/i18n';
  import RedeemCard from '$lib/redeem/RedeemCard.svelte';

  const baseUrl = env.PUBLIC_SUPABASE_URL ?? 'http://localhost:54321';
  const anonKey = env.PUBLIC_SUPABASE_ANON_KEY ?? '';

  // F-170: invite_id is the ONLY thing read off the URL; the code is typed.
  $: inviteIdFromLink = $page.url.searchParams.get('invite_id') ?? '';

  /**
   * The challenge/register transport for the redeem-invite Edge Function. The
   * EF is verify_jwt=false (unauthenticated, invite+TOTP-gated), so no bearer is
   * sent — only the anon apikey, exactly like /bootstrap's ceremony driver.
   * F-176: the request body (which on the register action carries the code) is
   * never logged here; it travels straight to the EF.
   *
   * @param {Record<string, unknown>} body
   * @returns {Promise<{ status: number; body: unknown }>}
   */
  async function transport(body) {
    const res = await fetch(`${baseUrl}/functions/v1/redeem-invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: anonKey },
      body: JSON.stringify(body)
    });
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      // Empty / non-JSON body — leave parsed as null; the card maps a non-OK
      // status to its system-error state.
    }
    return { status: res.status, body: parsed };
  }
</script>

<svelte:head>
  <title>{t('redeem.title')} — {t('common.app_name')}</title>
  <meta name="robots" content="noindex,nofollow" />
  <meta name="description" content={t('redeem.intro')} />
</svelte:head>

<RedeemCard inviteId={inviteIdFromLink} {transport} />
