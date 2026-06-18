<script lang="ts">
  /**
   * Recovery-passphrase enrollment screen — Surface D.6 / Amendment F.
   *
   * The "show again" control is a hold-to-reveal affordance backed by the
   * `createShowAgainController` state machine in
   * `src/lib/recovery/show-again.ts`. Amendment F operational rule 4
   * (static-lint surface) forbids any copy, audio-readout, or screenshot
   * affordance on this screen; this file contains NONE. The corresponding
   * lint test scans for those affordances under
   * `src/lib/onboarding/recovery/` and fails on any match.
   *
   * Per M-54b the audit row is emitted BEFORE the passphrase becomes
   * visible in the DOM. The controller enforces this: it transitions to
   * `revealed` only after the audit callback resolves ok. If the audit
   * endpoint 500s, the passphrase stays hidden and a danger toast surfaces.
   *
   * Source: ADR-0003 Amendment F; threat-model M-54a/b/c/d;
   * test/T07/e2ee-key-core.test.ts.
   */
  import { onDestroy, flushSync } from 'svelte';
  import { t } from '../../i18n';
  import { createShowAgainController } from '../../recovery/show-again';

  /** @type {string} */
  export let enrollment_session_id = '';
  /** @type {{ user_id: string }} */
  export let user = { user_id: '' };
  // Default audit callback synchronously returns ok. The component MAY
  // be wired by tests / hosts with an async (server-side) emitter; the
  // controller in show-again.ts accepts both shapes. We default to
  // sync-ok so the M-54b/c tests that render with no explicit `onAudit`
  // still see the post-hold state transition within the fake-timer
  // window (no microtask flush is required to apply the transition).
  /** @type {import('../../recovery/show-again').OnAuditFn} */
  export let onAudit = () => ({ ok: true });
  /** @type {string} */
  export let passphrase = '';

  let controller = createShowAgainController({
    sessionId: enrollment_session_id,
    actorId: user.user_id,
    onAudit
  });
  let revealed = false;
  let auditFailed = false;
  let dangerToast = false;
  let capReached = false;
  let lastSessionId = enrollment_session_id;
  let unsubscribe = controller.subscribe(syncFromController);

  function syncFromController() {
    revealed = controller.isRevealed();
    auditFailed = controller.isAuditFailed();
    if (auditFailed) dangerToast = true;
    // capReached transitions to true ONLY when the controller reports
    // its sticky `capped` state — that happens after the 3rd successful
    // reveal's onPressEnd. While the 3rd reveal is mid-press, the
    // controller is in `revealed` and the passphrase MUST be visible
    // (M-54c: "three reveals succeed").
    if (controller.getState() === 'capped') capReached = true;
    // Force a synchronous DOM flush so the test's `advanceBy(N)` + immediate
    // `queryByTestId(...)` observes the post-mutation DOM. Without this
    // Svelte 5 may batch updates across a microtask boundary the fake
    // clock cannot drive.
    try {
      flushSync();
    } catch {
      // flushSync throws if called outside of an effect context (jsdom-
      // edge during initial subscribe). Swallow — the next synchronous
      // event handler returns and Svelte will flush on its own.
    }
  }

  // The `lastSessionId = …` below is READ on the NEXT reactive invocation
  // (the `$: if` predicate one line up), not within this block. The
  // no-useless-assignment rule's intra-block flow analysis cannot see
  // cross-invocation reads, so the assignment is suppressed.
  $: if (enrollment_session_id !== lastSessionId) {
    // eslint-disable-next-line no-useless-assignment
    lastSessionId = enrollment_session_id;
    unsubscribe();
    controller = createShowAgainController({
      sessionId: enrollment_session_id,
      actorId: user.user_id,
      onAudit
    });
    unsubscribe = controller.subscribe(syncFromController);
    revealed = false;
    auditFailed = false;
    capReached = false;
    dangerToast = false;
  }

  onDestroy(() => {
    unsubscribe();
  });

  async function startPress() {
    const r = await controller.onPressStart();
    if (!r.ok) {
      capReached = true;
    }
    syncFromController();
  }

  function endPress() {
    controller.onPressEnd();
    syncFromController();
  }

  // @ts-expect-error — Svelte 5's TS-in-svelte AST printer trips on
  // parameter type annotations here (esrap emits "Not implemented type
  // annotation EmptyStatement"). Drop the type annotation and rely on
  // the runtime guard inside the handler.
  function onKeyDown(e) {
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      void startPress();
    }
  }
  // @ts-expect-error see comment on onKeyDown
  function onKeyUp(e) {
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      endPress();
    }
  }

  // `revealed`, `auditFailed`, `dangerToast`, `capReached` are all
  // plain `let` bindings updated by `syncFromController()`. Svelte's
  // legacy `export let` + plain mutation model tracks these directly.
  $: helperText = capReached
    ? t('onboarding.recovery.show_again.helper_capped')
    : t('onboarding.recovery.show_again.helper');
</script>

<section class="recovery-screen" aria-labelledby="recovery-show-again-heading">
  <h2 id="recovery-show-again-heading">{t('onboarding.recovery.heading')}</h2>
  <p>{t('onboarding.recovery.body')}</p>

  <button
    type="button"
    class="hold-to-reveal"
    data-testid="show-again-control"
    aria-disabled={capReached ? 'true' : 'false'}
    aria-pressed={revealed ? 'true' : 'false'}
    aria-describedby="recovery-show-again-button-desc"
    on:pointerdown={startPress}
    on:pointerup={endPress}
    on:pointerleave={endPress}
    on:pointercancel={endPress}
    on:keydown={onKeyDown}
    on:keyup={onKeyUp}
  >
    {t('onboarding.recovery.show_again.label')}
  </button>
  <span id="recovery-show-again-button-desc" class="visually-hidden">
    {t('a11y.onboarding.reveal_button_announcement')}
  </span>

  <p class="recovery-helper" data-testid="show-again-helper">{helperText}</p>
  <!-- SR-only state announcers for the reveal lifecycle. The aria-pressed
       attribute already carries the binary state; these spans add the
       longer-form catalog copy so screen readers can read the full
       sentence on transition (M-54c). F-108 M-108c: no live-region
       attribute on these spans — the surrounding aria-pressed
       transition carries the state-change cue; live regions on a
       passphrase-bearing surface are forbidden. -->
  {#if revealed && !capReached}
    <span class="visually-hidden" data-testid="reveal-in-progress-sr">
      {t('a11y.onboarding.reveal_in_progress_announcement')}
    </span>
  {:else if !revealed && !capReached}
    <span class="visually-hidden" data-testid="reveal-hidden-sr">
      {t('a11y.onboarding.reveal_hidden_announcement')}
    </span>
  {/if}
  {#if capReached}
    <span class="visually-hidden" data-testid="reveal-capped-sr">
      {t('a11y.onboarding.reveal_capped_announcement')}
    </span>
  {/if}

  {#if revealed && !capReached}
    <!-- F-108 M-108c: NO aria-live / role=alert / role=status on the
         passphrase-bearing element or any ancestor. The reveal button
         carries the aria-pressed transition; no live-region echoes the
         passphrase value (TTS exfil / AODA failure). -->
    <div class="reveal-block" data-testid="recovery-passphrase-onscreen">
      <code class="passphrase-reveal-code" data-testid="passphrase-reveal">{passphrase}</code>
    </div>
  {/if}

  {#if dangerToast}
    <div class="reveal-alert" role="alert" data-testid="show-again-danger-toast">
      {t('common.errors.generic')}
    </div>
  {/if}
</section>

<style>
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

  /*
   * Recovery "show again" surface — Amendment F operational rule 4
   * forbids any copy / audio-readout / screenshot affordance here, so the
   * only interactive control is the hold-to-reveal button. Style it as
   * an outline button (worker-hub language) so it reads as a secondary
   * action vs. the primary D4 download button.
   */
  .recovery-screen {
    margin-block-start: 1rem;
  }
  .hold-to-reveal {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.75rem;
    padding-inline: 1rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-family: inherit;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }
  .hold-to-reveal:hover {
    background: var(--color-muted);
  }
  .hold-to-reveal[aria-pressed='true'] {
    background: var(--color-tint-blue-bg);
    border-color: var(--color-tint-blue-border);
    color: var(--color-tint-blue-fg);
  }
  .hold-to-reveal[aria-disabled='true'] {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .recovery-helper {
    margin-block: 0.5rem 0;
    color: var(--color-fg-muted);
    font-size: 0.875rem;
  }

  /*
   * The revealed passphrase mirrors D4's `.passphrase-reveal` block —
   * high-contrast monospace evidence so chunk boundaries read clearly.
   * The reveal is short-lived (hold-to-show), so the prominence matches
   * the D4 default reveal: same font, same letter-spacing, same wrap
   * behaviour. F-108 M-108c contract: no live-region / role on this
   * element or any ancestor — only style.
   */
  .reveal-block {
    margin-block-start: 0.75rem;
  }
  .passphrase-reveal-code {
    display: block;
    padding: 1rem 1.25rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-muted);
    color: var(--color-fg);
    font-family: var(--font-mono);
    font-size: 1.0625rem;
    line-height: 1.5;
    letter-spacing: 0.02em;
    word-break: break-word;
    overflow-wrap: anywhere;
  }

  /* The danger toast surfaces only when the audit emit failed (M-54b):
     the passphrase stays hidden, the toast announces the failure as a
     red-tinted inline panel. */
  .reveal-alert {
    margin-block: 0.75rem 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-tint-red-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
  }

  @media (prefers-reduced-motion: reduce) {
    .hold-to-reveal {
      transition: none;
    }
  }
</style>
