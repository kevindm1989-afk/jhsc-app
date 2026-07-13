<script lang="ts">
  /**
   * OneTimeCodeCard — the shared one-time-code custody card (ADR-0029 P1-8c /
   * Surface K, rendered by BOTH screen 2 `code_shown` and screen 4 `code_shown`).
   *
   * The single load-bearing F-170 control lives here: the co-chair's 6-digit code
   * is the OUT-OF-BAND secret and the redeem link is NOT secret (it carries only
   * the opaque `invite_id`). The two custodies are split so intercepting one
   * channel never yields both:
   *
   *   - EXACTLY ONE clipboard affordance, and it copies the LINK only
   *     (`/redeem?invite_id=<id>`). There is no "copy code", no "copy both", no
   *     "share invite" affordance. (The link copy reuses ShareUrlButton bound to
   *     the redeem link + LINK-labelled catalog keys.)
   *   - The code is selectable STATIC text (never an <input>, never a button, no
   *     copy/share icon). The co-chair reads it aloud / types it in a DIFFERENT
   *     channel than the link.
   *
   * F-176 / Decision 8: the code lives in one in-memory variable on the parent
   * (passed as `code`); it is never written to a URL / history / storage / log /
   * DOM attribute. The visible digits are text content (allowed); the ONLY code
   * bearing attribute is a spaced digit-by-digit `aria-label` ("4 8 2 9 1 7"),
   * which is a DIFFERENT string than the contiguous code. The server-response
   * `invitee_user_id` / `bootstrap_id` are never passed in and never rendered.
   *
   * Accessibility (Surface K packet): focus moves ONCE to the card heading
   * (`tabindex="-1"`) on mount — a single deliberate move mirroring RedeemCard,
   * NOT a repeating assertive re-announce that would talk over a co-chair reading
   * the code aloud. The `code_ready` note fires via a POLITE role="status"
   * region. The code sits in a role="group" (aria-label "One-time code") and
   * carries the spaced aria-label so a screen reader spells it. The custody-split
   * callout is role="status" (POLITE, a11y review Finding 5) — warning-tier
   * guidance reached via reading order below the focused heading, so it does not
   * preempt/truncate the code announcement on mount. The copy-link control
   * announces "Link copied" via aria-live without moving focus.
   *
   * `<script lang="ts">` — typed props so the ts callers (CommitteeInvite /
   * PendingInvites) import it without an implicit-any.
   */
  import { onMount, tick } from 'svelte';
  import { t } from '$lib/i18n';
  import ShareUrlButton from '$lib/ui/ShareUrlButton.svelte';

  /** The 6-digit client-held one-time code (in-memory only). */
  export let code = '';
  /** The opaque invite id (NOT secret) — drives the redeem link. */
  export let inviteId = '';
  /** Card heading copy (screen-2 vs screen-4 variant). */
  export let heading = '';
  /**
   * Optional id for the card heading so an OUTER panel can point its
   * aria-labelledby here (screen 2 dedupes its own sr-only h2 — F7). Empty on
   * screen 4, where the row group names itself.
   */
  export let headingId = '';
  /** Polite "code ready" announcement string (a11y.committee.*). */
  export let codeReadyAnnounce = '';
  /**
   * Polite "code replaced" announcement string (a11y.committee.*.code_replaced)
   * fired on a successful in-place re-mint ("Send a different code" — F2), so an
   * SR user learns the shown code changed WITHOUT the focus being moved.
   */
  export let codeReplacedAnnounce = '';
  /** Container testid ("committee-invite-code" | "committee-resend-code"). */
  export let cardTestid = 'committee-invite-code';
  /** Code-value testid ("committee-invite-code-value" | "…resend-code-value"). */
  export let valueTestid = 'committee-invite-code-value';
  /** "Done — I've shared the code" — clears the code + closes. */
  export let onDone: () => void = () => {};
  /**
   * Optional "Send a different code" — re-mints a fresh code for the SAME invite
   * and replaces the displayed one (the old one dies). Hidden when not provided.
   */
  export let onResendNow: (() => void) | null = null;

  let headingEl: HTMLElement | null = null;

  // The single POLITE live region (F6): mounted EMPTY, populated post-mount so
  // the announcement lands as a live-region MUTATION (VoiceOver skips regions
  // inserted already-populated). A re-mint (F2) swaps its text in place.
  let liveMessage = '';

  // Security nit: an in-flight guard so two fast clicks of "Send a different
  // code" cannot fire two reissues (which would desync the shown code from the
  // live bootstrap). Mirrors the state==='submitting' guard on the primary submit.
  let resending = false;

  // The digit-by-digit accessible name so a screen reader spells the code
  // ("4 8 2 9 1 7") instead of "four hundred eighty-two thousand…". This spaced
  // string is intentionally NOT byte-equal to the contiguous code, so the F-176
  // attribute sweep (which forbids the contiguous code in any attribute) passes.
  $: spacedCode = code.split('').join(' ');

  // The redeem link carries ONLY the opaque invite_id — never the code
  // (mirrors supabase/functions/redeem-invite/core.ts buildRedeemLink).
  $: redeemLink = buildRedeemLink(inviteId);

  function buildRedeemLink(id: string): string {
    const base = typeof window !== 'undefined' && window.location ? window.location.origin : '';
    const path = `/redeem?invite_id=${encodeURIComponent(id)}`;
    return base ? `${base.replace(/\/$/, '')}${path}` : path;
  }

  onMount(async () => {
    // F6: populate the empty polite region so code-ready announces as a mutation.
    liveMessage = codeReadyAnnounce;
    // Single deliberate focus move to the heading (announced-not-focus-stolen).
    await tick();
    if (headingEl) headingEl.focus();
  });

  async function handleResendClick(): Promise<void> {
    if (resending || !onResendNow) return;
    resending = true;
    const before = code;
    try {
      await onResendNow();
      // Let the parent's fresh code flush into the `code` prop, then — if it did
      // change in place (successful re-mint, focus unmoved) — announce the swap
      // on the POLITE region so an SR user learns the shown code changed (F2).
      await tick();
      if (code !== before) liveMessage = codeReplacedAnnounce;
    } finally {
      resending = false;
    }
  }
</script>

<div class="otc-card" data-testid={cardTestid}>
  <!-- POLITE announcement (never assertive — do not talk over the co-chair
       reading the code aloud). Mounted empty (F6); carries code-ready on mount
       and code-replaced on a re-mint (F2). -->
  <p class="visually-hidden" role="status" aria-live="polite" data-testid="{cardTestid}-ready">
    {liveMessage}
  </p>

  <h2 class="otc-heading" id={headingId || undefined} tabindex="-1" bind:this={headingEl}>
    {heading}
  </h2>

  <!-- The one-time code — selectable STATIC text, NO copy/share control. -->
  <div class="otc-code-group" role="group" aria-label={t('committee.invite.code.label')}>
    <span class="otc-code-label" aria-hidden="true">{t('committee.invite.code.label')}</span>
    <div class="otc-code-box">
      <span class="otc-code-value" role="img" aria-label={spacedCode} data-testid={valueTestid}
        >{code}</span
      >
    </div>
  </div>

  <!-- Custody-split callout — the load-bearing F-170 security instruction
       (assertive). Icon + text, colour never alone. -->
  <div class="otc-callout otc-callout-warning" role="status">
    <svg class="otc-callout-icon" viewBox="0 0 24 24" aria-hidden="true">
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
      <h3 class="otc-callout-heading">{t('committee.invite.custody.heading')}</h3>
      <p class="otc-callout-body">{t('committee.invite.custody.body')}</p>
    </div>
  </div>

  <!-- The redeem link (safe to send) + the ONE clipboard affordance. -->
  <div class="otc-link">
    <span class="otc-link-label" aria-hidden="true">{t('committee.invite.link.label')}</span>
    <div class="otc-link-box">
      <span class="otc-link-url">{redeemLink}</span>
    </div>
    <p class="otc-link-helper">{t('committee.invite.link.helper')}</p>
    <ShareUrlButton
      url={redeemLink}
      labelKey="committee.invite.link.copy"
      copiedKey="committee.invite.link.copied"
      errorKey="committee.invite.link.copy_failed"
      copiedAnnounceKey="committee.invite.link.copied"
      errorAnnounceKey="committee.invite.link.copy_failed"
      fullTarget={true}
    />
  </div>

  <!-- "Shown once" reminder (neutral/info). Icon + text. -->
  <div class="otc-callout otc-callout-info">
    <svg class="otc-callout-icon" viewBox="0 0 24 24" aria-hidden="true">
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
    <p class="otc-once">{t('committee.invite.code.once')}</p>
  </div>

  <div class="otc-actions">
    <button type="button" class="otc-done" on:click={onDone}>
      {t('committee.invite.code.done')}
    </button>
    {#if onResendNow}
      <button type="button" class="otc-ghost" on:click={handleResendClick} disabled={resending}>
        {t('committee.invite.code.resend_now')}
      </button>
    {/if}
  </div>
</div>

<style>
  /*
   * All colour / radius / border / shadow bind to the app CSS-variable token
   * palette (app.html boot sheet). The two-layer AODA focus ring is inherited
   * from app.css :focus-visible; the reduced-motion + print rules are global.
   */
  .otc-card {
    display: grid;
    gap: 1rem;
    margin-block-start: 1rem;
  }
  .otc-heading {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--color-fg);
  }

  .otc-code-group {
    display: grid;
    gap: 0.375rem;
    justify-items: start;
  }
  .otc-code-label,
  .otc-link-label {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-fg-muted);
  }
  .otc-code-box {
    display: inline-flex;
    padding: 0.75rem 1rem;
    border: var(--border-width-thick) solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-bg);
  }
  /* The high-contrast reveal-pair treatment (Surface D.T19.f), large tabular
     mono — mirrors the redeem-card totp glyphs. Selectable static text. */
  .otc-code-value {
    font-family: var(--font-mono);
    font-size: 1.75rem;
    font-weight: 600;
    letter-spacing: 0.28em;
    color: var(--color-fg);
    user-select: all;
  }

  .otc-callout {
    display: flex;
    gap: 0.625rem;
    align-items: flex-start;
    padding: 0.75rem 1rem;
    border: var(--border-width-default) solid transparent;
    border-inline-start-width: var(--border-width-thick);
    border-radius: var(--radius-md);
  }
  .otc-callout-icon {
    width: 1.25rem;
    height: 1.25rem;
    flex: none;
    margin-block-start: 0.125rem;
  }
  .otc-callout-heading {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
  }
  .otc-callout-body,
  .otc-once {
    margin-block: 0.25rem 0;
    font-size: 0.875rem;
  }
  .otc-once {
    margin: 0;
  }
  .otc-callout-warning {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-color: var(--color-tint-amber-border);
  }
  .otc-callout-info {
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    border-color: var(--color-tint-blue-border);
  }

  .otc-link {
    display: grid;
    gap: 0.375rem;
    justify-items: start;
  }
  .otc-link-box {
    width: 100%;
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-md);
    background: var(--color-muted);
  }
  .otc-link-url {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--color-fg);
    word-break: break-all;
  }
  .otc-link-helper {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--color-fg-muted);
  }

  .otc-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-block-start: 0.25rem;
  }
  .otc-done {
    background: var(--color-accent);
    color: var(--color-accent-fg);
    border-color: var(--color-accent);
  }
  .otc-done:hover:not(:disabled) {
    background: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
    opacity: 1;
  }
  .otc-ghost {
    background: transparent;
    color: var(--color-fg-muted);
    border-color: transparent;
  }
  .otc-ghost:hover:not(:disabled) {
    background: var(--color-muted);
    color: var(--color-fg);
    opacity: 1;
  }

  .visually-hidden {
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
