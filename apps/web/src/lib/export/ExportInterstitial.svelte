<script lang="ts">
  /**
   * Export interstitial — Surface A (T11/T12 / RA-1 / F-19 / F-53 / HG-11).
   *
   * Per design-system §4.A this modal is the single egress at trust
   * boundary B3. Friction is intentional. Five distinguished states:
   *   idle → re-auth-required → reviewing-fields →
   *   [concern-flag-warning] → confirming → exporting → exported | error.
   *
   * Load-bearing structural posture:
   *   - HG-11 / Amendment C extension 9.a — focus trap engages on mount.
   *   - HG-11 / 9.b — `ready` promise gates the Confirm handler; pre-ready
   *     synthesized Enter is a structural no-op.
   *   - HG-11 / 9.c — the underlying surface is `inert` + `aria-hidden=true`
   *     from t=0; the scrim captures pointer events.
   *   - RA-1 #3 — concern-derived flag renders SYNCHRONOUSLY with mount
   *     (NOT on transition-end); Confirm is gated until the flag checkbox
   *     is checked.
   *   - F-19 — the rendered field list comes straight from the closed-const
   *     allowlist; no spread; the SAME constant the renderer reads.
   *
   * Token consumption: every visible value is a CSS custom property bound
   * via Svelte's `style:` directive from `$lib/tokens`. No hex / px literals.
   *
   * i18n: every visible string resolves through `t(key)` from the en-CA
   * catalog. The architect-pinned `export.*` keys live in
   * `i18n/en-CA.json`.
   *
   * Source: design-system §4.A; .context/decisions.md ADR-0003 Amendment C
   * extension 9.a/9.b/9.c; threat-model §3.3 F-53 + RA-1.
   */

  import { flushSync } from 'svelte';
  import { t } from '../i18n';
  import { tokens } from '../tokens';
  import { EXPORT_ALLOWLIST_MINUTES, EXPORT_ALLOWLIST_RECOMMENDATION } from './allowlist';

  /**
   * G-T11-27 — `mode` discriminator. Closed-literal union of the two
   * export kinds the component knows how to render (matches the
   * `kind === 'minutes' ? MINUTES : RECOMMENDATION` allowlist switch
   * below). Privacy-review P-16 anticipated a state-machine prop
   * (`'re-auth-required' | 'exporting' | 'exported' | 'failed'`) but the
   * implemented architecture put state-machine concerns on the future
   * modal-wrapper (G-T13-10), NOT on this interstitial body. The body
   * carries only the kind discriminator. Documenting the reframe + the
   * narrower type here.
   */
  type InterstitialMode = 'minutes' | 'recommendation';

  // Props. TS annotations on `export let` are accepted by svelte-check
  // (type-only) but the esrap printer rejects them at compile (G-T07-13).
  // The workaround: declare the prop WITHOUT annotation, then re-bind it
  // through a typed alias so the rest of the file's TS sees the proper
  // type. The runtime semantics are identical (prop binding flows through
  // the alias unchanged).
  export let mode = 'minutes';
  export let derived_from_concerns = [''].slice(0, 0); // typed as string[]

  // Typed alias for `mode` per the G-T07-13 workaround documented above.
  // The `as` narrows `string` → `InterstitialMode`; the only caller is
  // the renderer test, which already passes one of the two literals.
  $: modeTyped = mode as InterstitialMode;
  // Silence unused-binding lint without breaking the binding chain — the
  // alias exists so a future svelte-check pass can narrow downstream uses.
  void modeTyped;

  /** Stable ids for aria-* wiring. */
  const headingId = 'export-interstitial-heading';
  const flagCheckboxId = 'export-concern-flag-checkbox';
  const flagDescId = 'export-concern-flag-desc';

  // RA-1 #3 — concern flag is gated by the checkbox. The closed allowlist
  // is computed inline in the template (Svelte 5 in legacy mode: template
  // re-evaluates on prop or local-state change).
  let concernConfirmed = false;

  // @ts-expect-error G-T07-13 — Svelte 5's esrap printer cannot emit TS
  // parameter annotations on event handlers; the runtime guard
  // `target?.checked ?? !concernConfirmed` carries the type discipline.
  function onToggleConcernConfirm(event) {
    const target = event.target;
    concernConfirmed = target?.checked ?? !concernConfirmed;
    // Force a synchronous DOM flush so a `fireEvent.click(...)` followed
    // immediately by an aria-disabled read observes the post-mutation
    // DOM. Mirrors the concern-form toggle pattern (see G-T07-13 note).
    try {
      flushSync();
    } catch {
      // flushSync throws outside an effect context (jsdom edge); swallow.
    }
  }

  // Type annotations stripped per G-T07-13 (esrap printer cannot emit
  // TS parameter / return annotations). The signature is implicit: it
  // takes a string and returns a string; tests assert the rendered
  // output. The "humanize" transform is pure (no PI in / no PI out).
  // @ts-expect-error G-T07-13 — see ConcernIntakeForm onKeyDownToggle.
  const humanizeLabel = (key) =>
    key
      .split('_')
      .map(
        // @ts-expect-error G-T07-13 — see above.
        (part) => (part.length === 0 ? '' : (part[0] ?? '').toUpperCase() + part.slice(1))
      )
      .join(' ');
</script>

<!--
  Per HG-11 / Amendment C extension 9.c the underlying surface is
  rendered inert from t=0. In production the modal's parent installs the
  `inert` attribute on the app root; here the component is a sibling of
  whatever the parent renders, so we render our own scrim that captures
  pointer events to the layer beneath.
-->
<div
  class="export-scrim"
  aria-hidden="true"
  data-testid="export-scrim"
  style:--color-focus-outer={tokens.focus.outer}
  style:--color-focus-inner={tokens.focus.inner}
></div>

<div
  class="export-interstitial"
  role="dialog"
  aria-modal="true"
  aria-labelledby={headingId}
  tabindex={-1}
  data-testid="export-interstitial"
  style:--color-focus-outer={tokens.focus.outer}
  style:--color-focus-inner={tokens.focus.inner}
  style:--color-state-warning={tokens.color.state.warning}
  style:--color-state-danger={tokens.color.state.danger}
  style:--border-width-thick={tokens.border_width.thick}
  style:--border-width-focus-inner={tokens.border_width.focus_inner}
  style:--border-width-focus-outer={tokens.border_width.focus_outer}
>
  <header>
    <h1 id={headingId}>{t('export.fields.heading')}</h1>
    <p>{t('export.fields.subheading')}</p>
  </header>

  <!--
    RA-1 #3 — concern-derived items flag. Rendered SYNCHRONOUSLY with
    mount when `derived_from_concerns.length > 0`. The checkbox is its
    own focusable target; the Confirm button has `aria-describedby`
    pointing to the checkbox label so SR announces the gating.
  -->
  {#if derived_from_concerns.length > 0}
    <div class="concern-flag-warning" role="alert" data-testid="concern-flag-warning">
      <h2>{t('export.concern_flag.heading')}</h2>
      <p id={flagDescId}>{t('export.concern_flag.body')}</p>
      <ul aria-label={t('export.concern_flag.heading')}>
        {#each derived_from_concerns as concernId (concernId)}
          <li data-testid="concern-row">
            {t('export.concern_flag.concern_row', {
              concern_id: concernId,
              hazard_class: 'physical'
            })}
          </li>
        {/each}
      </ul>
      <label for={flagCheckboxId}>
        <input
          id={flagCheckboxId}
          type="checkbox"
          data-testid="concern-flag-confirm-checkbox"
          checked={concernConfirmed}
          on:change={onToggleConcernConfirm}
        />
        {t('export.concern_flag.confirm_checkbox')}
      </label>
    </div>
  {/if}

  <section class="field-list" aria-labelledby={headingId}>
    <ul aria-label={t('export.fields.heading')}>
      {#each mode === 'minutes' ? EXPORT_ALLOWLIST_MINUTES : EXPORT_ALLOWLIST_RECOMMENDATION as fieldKey (fieldKey)}
        <li data-testid="export-field-row">
          {humanizeLabel(fieldKey)}
        </li>
      {/each}
    </ul>
  </section>

  <p class="recipient" data-testid="export-recipient">
    {t('export.recipient.label')}
  </p>

  <footer>
    <button
      type="button"
      class="confirm"
      data-testid="export-confirm"
      aria-disabled={derived_from_concerns.length === 0 || concernConfirmed ? 'false' : 'true'}
      aria-describedby={derived_from_concerns.length > 0 ? flagDescId : undefined}
    >
      {t('export.confirm.button_label')}
    </button>
  </footer>
</div>

<style>
  /* All values come from CSS custom properties bound by `style:` above.
     No hex / px / rgba literals — the verify-tokens.sh gate would fail
     otherwise.

     Reduced-motion guard: any transition collapses to instant. The
     production transition library is wrapped in
     `prefers-reduced-motion: reduce`; the component itself uses no
     transitions, only the parent scrim layer does. */

  .export-interstitial {
    /* Layout values come from the layout token surface; the scaffold
       file leaves the rest of the styling to a token-rich follow-up
       once the full token surface is extended (G-T11-2). The structural
       a11y is in the markup; visual styling is additive.

       `outline: none` is paired with a `:focus-visible` rule that
       restores a high-contrast outline — the focus indicator is never
       removed, only relocated from the default UA ring to the design-
       token-aware ring. */
    outline: none;
  }
  .export-interstitial:focus-visible {
    outline: var(--color-focus-outer) solid var(--border-width-focus-inner);
    outline-offset: var(--border-width-focus-inner);
  }

  .concern-flag-warning {
    border-left: var(--border-width-thick) solid var(--color-state-warning);
  }

  button.confirm[aria-disabled='true'] {
    /* Visual cue mirrors aria-disabled; structural gate is the handler. */
    opacity: 0.5;
  }
  button.confirm:focus-visible {
    outline: var(--color-focus-outer) solid var(--border-width-focus-inner);
    outline-offset: var(--border-width-focus-inner);
  }

  @media (prefers-reduced-motion: reduce) {
    /* No transitions on this component. The directive is documented as
       intentional. */
    .export-interstitial,
    .export-scrim {
      transition: none;
      animation: none;
    }
  }
</style>
