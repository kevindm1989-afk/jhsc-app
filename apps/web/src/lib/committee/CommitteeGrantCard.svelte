<script lang="ts">
  /**
   * CommitteeGrantCard — Surface K screen 3 (ADR-0029 P1-8d): the co-chair-side
   * grant of committee-key access to a `pending-grant` member, with the F-172
   * out-of-band fingerprint confirm.
   *
   * The ceremony (one disclosure → confirm → seal), per design-system.md §4:
   *   idle → (Grant tap) → disclosing → confirm → (It matches) → granting →
   *          granted | failed | not_ready
   *
   * Load-bearing security posture (threat-model §3.18 F-172/F-179/F-180/F-181):
   *   - SINGLE disclosure (F-179 / A-8.7): `client.getMemberPubkey` fires ONCE, on
   *     the deliberate Grant tap — never on mount, never on hover. The disclosed
   *     `{public_key, fingerprint}` is passed down to `wrapMemberInViaProduction`
   *     (A-8.6); the composition never re-discloses.
   *   - CONFIRMED == SEALED (F-172): the bytes the human compared ARE the bytes
   *     sealed — the same `disclosed` object feeds the fingerprint render AND the
   *     seal (the composition re-derives + self-consistency-asserts).
   *   - ADVISORY, not load-bearing (F-180): the compare is a human double-check
   *     layered over server controls; the confirm CTA is NOT behind a forced "I
   *     checked" gate (the affirmative claim lives in the button label), and the
   *     copy never says the compare "secures/verifies" the key.
   *   - SERVER-TRUTHED terminals (F-181): `granted`/`failed`/`not_ready` render
   *     ONLY from the `WrapMemberInResult` return — never optimistically.
   *
   * The disclosed-fingerprint block is the SHARED FingerprintCompareBlock the P1-9
   * member waiting screen (Surface L) also consumes, so the two humans compare
   * group-for-group by construction (the cross-surface F-172 invariant).
   *
   * No private key material ever enters the DOM / clipboard / logs — only the
   * PUBLIC fingerprint (SHA-256 of the public key). No `console.*` here.
   */
  import { tick } from 'svelte';
  import { t } from '$lib/i18n';
  import { getCurrentUserId } from '$lib/auth/jwt-claims';
  import FingerprintCompareBlock from '$lib/crypto/FingerprintCompareBlock.svelte';
  import { wrapMemberInViaProduction } from '$lib/crypto/production-flows';
  import type {
    SupabaseT07Client,
    CommitteeKeyHolder,
    LocalIdentityStore,
    WrapMemberInResult
  } from '$lib/crypto';

  /** The `pending-grant` roster member this card grants access to. */
  export let member: { user_id: string; display_name: string | null };
  /** Production t07 client — the sole owner of the single `getMemberPubkey` disclosure. */
  export let client: SupabaseT07Client;
  /** The actor's committee-key holder (the data key sealed to the member). */
  export let holder: CommitteeKeyHolder;
  /** Device-local identity store — threaded to the wrap composition's Step-1 unwrap. */
  export let localIdentity: LocalIdentityStore;

  type Phase = 'idle' | 'disclosing' | 'confirm' | 'granting' | 'granted' | 'failed' | 'not_ready';
  type FailReason =
    | 'pubkey_disclosure_denied'
    | 'actor_has_no_wrap'
    | 'data_key_unwrap_failed'
    | 'wrap_post_failed'
    | 'decrypt_failed'
    | 'invalid_pubkey'
    | 'unknown';

  let phase: Phase = 'idle';

  // The ONE server disclosure this screen owns (A-8.6). Held only for the life of
  // the open panel; cleared on close so no member's disclosed bytes leak across
  // two grant attempts (a fresh instance / fresh disclosure per open).
  let disclosedPublicKey: Uint8Array | null = null;
  let disclosedFingerprint = '';

  let failReason: FailReason = 'unknown';

  // Focus targets — a single deliberate move per transition (§3.1 modal-return
  // discipline applied to the inline panel).
  let ctaEl: HTMLButtonElement | null = null;
  let disclosingHeadingEl: HTMLHeadingElement | null = null;
  let confirmHeadingEl: HTMLHeadingElement | null = null;
  let grantedHeadingEl: HTMLHeadingElement | null = null;
  let failedHeadingEl: HTMLHeadingElement | null = null;
  let notReadyHeadingEl: HTMLHeadingElement | null = null;

  $: panelOpen = phase !== 'idle';
  $: isBusy = phase === 'disclosing' || phase === 'granting';
  $: panelId = `committee-grant-panel-${member.user_id}`;
  // The name used for the copy fills — a nameless member gets the roster's
  // unnamed fallback (never the raw uid) so no PI-shaped uid enters the copy.
  $: nameForCopy = member.display_name ?? t('committee.roster.row.unnamed');

  // The retryable reason set (design-system.md §4 reason→copy table). The
  // disclosure-step / provisioning / unlock failures are not retryable in place.
  const RETRYABLE: ReadonlySet<FailReason> = new Set([
    'wrap_post_failed',
    'invalid_pubkey',
    'unknown'
  ]);
  $: retryable = RETRYABLE.has(failReason);

  /** Map a WrapMemberInResult.reason (+ disclosure denial) onto its actionable
   * body key — NEVER the raw enum (F-176). */
  function failedBodyKeyFor(reason: FailReason): string {
    switch (reason) {
      case 'pubkey_disclosure_denied':
        return 'committee.grant.failed.disclosure_denied.body';
      case 'actor_has_no_wrap':
        return 'committee.grant.failed.no_actor_wrap.body';
      case 'data_key_unwrap_failed':
      case 'decrypt_failed':
        return 'committee.grant.failed.unlock.body';
      case 'wrap_post_failed':
        return 'committee.grant.failed.wrap_post.body';
      case 'invalid_pubkey':
      case 'unknown':
      default:
        return 'committee.grant.failed.generic.body';
    }
  }
  $: failedBodyKey = failedBodyKeyFor(failReason);

  function focusEl(el: HTMLElement | null): void {
    if (el && typeof el.focus === 'function') el.focus();
  }

  /**
   * idle → disclosing → confirm | not_ready | failed. Runs the SINGLE
   * `getMemberPubkey` disclosure on the deliberate Grant tap (A-8.7 — never a
   * pre-fetch).
   */
  async function onGrant(): Promise<void> {
    if (phase !== 'idle') return;
    phase = 'disclosing';
    await tick();
    focusEl(disclosingHeadingEl);

    let disclosure: Awaited<ReturnType<typeof client.getMemberPubkey>>;
    try {
      disclosure = await client.getMemberPubkey({ target_user_id: member.user_id });
    } catch {
      // F-148: a transport throw maps to the caller-side disclosure denial —
      // never a crash, never a leaked error.
      await enterFailed('pubkey_disclosure_denied');
      return;
    }

    if (disclosure.ok) {
      disclosedPublicKey = disclosure.data.public_key;
      disclosedFingerprint = disclosure.data.fingerprint;
      await enterConfirm();
      return;
    }

    // The member has no enrolled identity yet → the calm "not ready" stop
    // (Amendment A-2 collapse). Every other denial → the caller-side failure.
    if (
      disclosure.reason === 'member_not_enrolled' ||
      disclosure.reason === 'not_found' ||
      disclosure.reason === 'invalid_input'
    ) {
      await enterNotReady();
      return;
    }
    await enterFailed('pubkey_disclosure_denied');
  }

  /** confirm → granting → granted | failed | not_ready (server-truthed only). */
  async function onConfirm(): Promise<void> {
    if (phase !== 'confirm') return;
    phase = 'granting';
    await runGrant();
  }

  async function runGrant(): Promise<void> {
    const pub = disclosedPublicKey;
    if (!pub) {
      await enterFailed('unknown');
      return;
    }
    let result: WrapMemberInResult;
    try {
      result = await wrapMemberInViaProduction({
        client,
        holder,
        localIdentity,
        user_id: getCurrentUserId() ?? '',
        target_user_id: member.user_id,
        // A-8.6: the confirmed bytes ARE the sealed bytes (F-172 TOCTOU closed).
        disclosed: { public_key: pub, fingerprint: disclosedFingerprint }
      });
    } catch {
      // F-148: a thrown/rejected wrap renders the generic failure — never a crash,
      // never a false `granted`.
      await enterFailed('unknown');
      return;
    }

    if (result.status === 'ok') {
      await enterGranted();
    } else if (result.status === 'member_not_enrolled') {
      // Defensive wrap-time not-enrolled → the same calm not_ready stop.
      await enterNotReady();
    } else {
      await enterFailed(result.reason);
    }
  }

  /** Retry re-runs the seal from the ALREADY-disclosed bytes (no second disclosure). */
  async function onRetry(): Promise<void> {
    if (!disclosedPublicKey) {
      await closePanel();
      return;
    }
    phase = 'granting';
    await runGrant();
  }

  async function enterConfirm(): Promise<void> {
    phase = 'confirm';
    await tick();
    focusEl(confirmHeadingEl);
  }
  async function enterGranted(): Promise<void> {
    phase = 'granted';
    await tick();
    focusEl(grantedHeadingEl);
  }
  async function enterFailed(reason: FailReason): Promise<void> {
    failReason = reason;
    phase = 'failed';
    await tick();
    focusEl(failedHeadingEl);
  }
  async function enterNotReady(): Promise<void> {
    phase = 'not_ready';
    await tick();
    focusEl(notReadyHeadingEl);
  }

  /** Cancel / Close / Done — unmount the panel, return focus to the Grant CTA. */
  async function closePanel(): Promise<void> {
    phase = 'idle';
    disclosedPublicKey = null;
    disclosedFingerprint = '';
    await tick();
    focusEl(ctaEl);
  }
</script>

<div class="grant-root">
  <button
    type="button"
    class="grant-cta"
    data-testid={`committee-grant-cta-${member.user_id}`}
    aria-label={t('committee.grant.row.cta_aria', { name: nameForCopy })}
    aria-expanded={panelOpen ? 'true' : 'false'}
    aria-controls={panelOpen ? panelId : null}
    disabled={panelOpen}
    bind:this={ctaEl}
    on:click={onGrant}
  >
    {t('committee.grant.row.cta')}
  </button>

  {#if phase !== 'idle'}
    <div id={panelId} class="grant-panel card" aria-busy={isBusy ? 'true' : 'false'}>
      {#if phase === 'disclosing'}
        <div data-testid="committee-grant-disclosing">
          <h2 class="grant-heading" tabindex="-1" bind:this={disclosingHeadingEl}>
            {t('committee.grant.panel.heading')}
          </h2>
          <p class="grant-member">{nameForCopy}</p>
          <p class="grant-status" role="status" aria-live="polite">
            {t('committee.grant.disclosing')}
          </p>
        </div>
      {:else if phase === 'confirm' || phase === 'granting'}
        <div data-testid={phase === 'confirm' ? 'committee-grant-confirm' : undefined}>
          <h2 class="grant-heading" tabindex="-1" bind:this={confirmHeadingEl}>
            {t('committee.grant.panel.heading')}
          </h2>

          <!-- (1) member-identity line — who you're granting to. -->
          <p class="grant-member">
            {#if member.display_name}
              <span class="grant-member-name">{member.display_name}</span>
            {:else}
              <span class="grant-member-unnamed">{t('committee.roster.row.unnamed')}</span>
              <span class="grant-member-uid">{member.user_id.slice(0, 8)}</span>
            {/if}
          </p>

          <!-- (2) lead — check you're granting to the right person. -->
          <p class="grant-lead">{t('committee.grant.confirm.lead')}</p>

          <!-- Leading polite announcement: the fingerprint shape + the co-chair's
               job (compare group-for-group). -->
          <p class="visually-hidden" role="status" aria-live="polite">
            {t('a11y.committee.grant.fingerprint.ready', { name: nameForCopy })}
          </p>

          <!-- (3) the disclosed-fingerprint block — the SHARED cross-surface mirror. -->
          <span class="grant-fp-label" aria-hidden="true">
            {t('committee.grant.fingerprint_label')}
          </span>
          <FingerprintCompareBlock
            fingerprint={disclosedFingerprint}
            regionLabel={t('a11y.committee.grant.fingerprint.region_label', { name: nameForCopy })}
            testid="committee-grant-fingerprint"
            showCopy={true}
            copyLabelKey="committee.grant.confirm.copy"
            copiedKey="committee.grant.confirm.copied"
            copyErrorKey="committee.grant.confirm.copy_failed"
            copiedAnnounceKey="a11y.committee.grant.fingerprint.copied"
            errorAnnounceKey="committee.grant.confirm.copy_failed"
          />

          <!-- (4) the compare callout — calm info framing (F-180 advisory). -->
          <div class="grant-callout grant-callout-info">
            <svg class="grant-callout-icon" viewBox="0 0 24 24" aria-hidden="true">
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
              <h3 class="grant-callout-heading">{t('committee.grant.compare.heading')}</h3>
              <p class="grant-callout-body">
                {t('committee.grant.compare.body', { name: nameForCopy })}
              </p>
            </div>
          </div>

          <!-- (5) actions. In `confirm` the affirmative CTA + Cancel; in `granting`
               the loading state (server-truthed terminal only). -->
          <div class="grant-actions">
            {#if phase === 'confirm'}
              <button type="button" class="grant-primary" on:click={onConfirm}>
                {t('committee.grant.confirm.cta')}
              </button>
              <button type="button" class="btn-outline" on:click={closePanel}>
                {t('committee.grant.confirm.cancel')}
              </button>
            {:else}
              <div class="grant-granting" data-testid="committee-grant-granting">
                <span class="grant-loading-label" aria-hidden="true">
                  {t('committee.grant.granting')}
                </span>
                <span class="visually-hidden" role="status" aria-live="polite">
                  {t('a11y.committee.grant.granting')}
                </span>
              </div>
              <button type="button" class="btn-outline" disabled>
                {t('committee.grant.confirm.cancel')}
              </button>
            {/if}
          </div>
        </div>
      {:else if phase === 'granted'}
        <div
          class="grant-terminal grant-success"
          data-testid="committee-grant-granted"
          role="status"
        >
          <svg class="grant-terminal-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
            <path
              d="m8.5 12 2.5 2.5 4.5-5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <div>
            <h2 class="grant-terminal-heading" tabindex="-1" bind:this={grantedHeadingEl}>
              {t('committee.grant.granted.heading')}
            </h2>
            <p class="grant-terminal-body">
              {t('committee.grant.granted.body', { name: nameForCopy })}
            </p>
            <span class="visually-hidden"
              >{t('a11y.committee.grant.granted', { name: nameForCopy })}</span
            >
            <button type="button" class="grant-primary" on:click={closePanel}>
              {t('committee.grant.granted.done')}
            </button>
          </div>
        </div>
      {:else if phase === 'failed'}
        <div class="grant-terminal grant-danger" data-testid="committee-grant-failed" role="alert">
          <svg class="grant-terminal-icon" viewBox="0 0 24 24" aria-hidden="true">
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
            <h2 class="grant-terminal-heading" tabindex="-1" bind:this={failedHeadingEl}>
              {t('committee.grant.failed.heading')}
            </h2>
            <p class="grant-terminal-body">{t(failedBodyKey)}</p>
            <span class="visually-hidden">{t('a11y.committee.grant.failed')}</span>
            <div class="grant-actions">
              {#if retryable}
                <button type="button" class="grant-primary" on:click={onRetry}>
                  {t('committee.grant.failed.retry')}
                </button>
              {/if}
              <button type="button" class="btn-outline" on:click={closePanel}>
                {t('committee.grant.failed.close')}
              </button>
            </div>
          </div>
        </div>
      {:else if phase === 'not_ready'}
        <div
          class="grant-terminal grant-callout-info"
          data-testid="committee-grant-not-ready"
          role="status"
        >
          <svg class="grant-terminal-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M6 2h12M6 22h12M6 2c0 5 4 5 6 10 2-5 6-5 6-10M6 22c0-5 4-5 6-10 2 5 6 5 6 10"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <div>
            <h2 class="grant-terminal-heading" tabindex="-1" bind:this={notReadyHeadingEl}>
              {t('committee.grant.not_ready.heading')}
            </h2>
            <p class="grant-terminal-body">{t('committee.grant.not_ready.body')}</p>
            <button type="button" class="btn-outline" on:click={closePanel}>
              {t('committee.grant.not_ready.close')}
            </button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Colour / radius / shadow / border bind to the app CSS-variable token palette
     (app.css boot sheet); the two-layer AODA focus ring is inherited from
     app.css :focus-visible on every native control. Spacing + type sizing use
     rem literals matching the sibling SetupCommitteeEncryptionCard / roster
     convention (this project exposes no spacing-scale custom properties). */
  .grant-root {
    margin-block-start: 0.5rem;
  }
  .grant-cta {
    align-self: start;
  }
  .grant-panel {
    margin-block-start: 0.75rem;
  }
  .grant-heading {
    margin: 0 0 0.5rem;
    font-size: 1.0625rem;
  }
  .grant-member {
    margin: 0 0 0.5rem;
    color: var(--color-fg);
  }
  .grant-member-name {
    font-weight: 600;
  }
  .grant-member-unnamed {
    font-weight: 500;
    color: var(--color-fg-muted);
  }
  .grant-member-uid {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--color-fg-muted);
  }
  .grant-lead {
    margin: 0 0 0.75rem;
    color: var(--color-fg);
  }
  .grant-status {
    margin: 0.5rem 0 0;
    color: var(--color-fg-muted);
  }
  .grant-fp-label {
    display: block;
    margin-block-start: 0.75rem;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-fg-muted);
  }

  /* Callout — calm info framing (icon + text, colour never alone). */
  .grant-callout {
    display: flex;
    gap: 0.625rem;
    align-items: flex-start;
    margin-block-start: 1rem;
    padding: 0.75rem 1rem;
    border: var(--border-width-default) solid transparent;
    border-inline-start-width: var(--border-width-thick);
    border-radius: var(--radius-md);
  }
  .grant-callout-icon {
    width: 1.25rem;
    height: 1.25rem;
    flex: none;
    margin-block-start: 0.125rem;
  }
  .grant-callout-heading {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
  }
  .grant-callout-body {
    margin-block: 0.25rem 0;
    font-size: 0.875rem;
  }
  .grant-callout-info {
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    border-color: var(--color-tint-blue-border);
  }

  .grant-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.625rem;
    align-items: center;
    margin-block-start: 1rem;
  }
  .grant-primary {
    background: var(--color-accent);
    color: var(--color-accent-fg);
    border-color: var(--color-accent);
  }
  .grant-primary:hover {
    background: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
    opacity: 1;
  }
  .grant-granting {
    display: inline-flex;
    align-items: center;
  }
  .grant-loading-label {
    color: var(--color-fg-muted);
    font-size: 0.875rem;
    font-weight: 500;
  }

  /* Terminal panels — each pairs its tint with an icon AND text (never
     colour-only). */
  .grant-terminal {
    display: flex;
    gap: 0.625rem;
    align-items: flex-start;
    padding: 0.875rem 1rem;
    border: var(--border-width-default) solid transparent;
    border-radius: var(--radius-md);
  }
  .grant-terminal-icon {
    width: 1.25rem;
    height: 1.25rem;
    flex: none;
    margin-block-start: 0.125rem;
  }
  .grant-terminal-heading {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  .grant-terminal-body {
    margin-block: 0.25rem 0.75rem;
    font-size: 0.9375rem;
  }
  .grant-success {
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
    border-color: var(--color-tint-green-border);
  }
  .grant-danger {
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-color: var(--color-tint-red-border);
    border-inline-start-width: var(--border-width-c4-stripe, var(--border-width-thick));
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
