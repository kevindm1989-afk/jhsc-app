<script lang="ts">
  /**
   * Concern intake form — Surface B (T08 / ADR-0007).
   *
   * Structural posture (binding):
   *   - F-17 anonymous default-lock: `anonymous` starts `true` on EVERY
   *     fresh mount. There is no "remember last setting" mechanism. The
   *     default is encoded in the initial `let anonymous = true;` binding
   *     — module-level mutable state would defeat this and is intentionally
   *     avoided.
   *   - When the user flips the toggle to OFF, the named-source advisory
   *     renders BEFORE the source_name input is enabled. The DOM order
   *     (advisory then input) is part of the structural contract; tests
   *     assert it.
   *   - Per ADR-0007 amendment, the consent-surface re-renders on every
   *     intake. This form is the per-intake re-render — the parent route
   *     mounts a fresh instance each time the rep opens "Log a concern".
   *
   * State machine: `idle → drafting → confirming → submitting → submitted
   * | error`. The unit tests in `test/T08/concern-intake.test.ts` exercise
   * the toggle/advisory/source-name surface; the wider state machine is
   * exercised at integration time once T08.1 lands the SupabaseConcernStore.
   *
   * Token consumption (per `apps/web/src/lib/tokens.ts` / design-tokens.json):
   *   - No hex / px literals; CSS variables read from the tokens file.
   *   - Touch targets meet `touch_target.min` (44x44 minimum) at mobile
   *     breakpoints.
   *   - Reduced-motion-aware: opacity-only transition on advisory reveal.
   *
   * i18n: every visible string resolves through `t(key)`; tests pattern-
   * match the rendered text against the catalog entries in
   * `i18n/en-CA.json` under `concern.intake.*` and `a11y.concern.*`.
   *
   * Source: ADR-0007 (and amendment); threat-model F-15..F-20;
   * design-system §4 Surface B; i18n catalog.
   */

  import { flushSync } from 'svelte';
  import { t } from '../i18n';
  import { tokens } from '../tokens';

  /**
   * F-17 anonymous default-lock — the toggle starts ON every render.
   * The `anonymous` binding is intentionally a fresh `true` for each
   * mount of this component; there is NO module-level persistence of the
   * "last value" — that would defeat the structural enforcement spelled
   * out in threat-model §3.2 F-17 and the T3 acceptance criteria.
   */
  let anonymous = true;
  let sourceName = '';
  let title = '';
  let body = '';
  // hazardClass / severity values are validated against the C1 enum at
  // submit time in concern-core. Svelte 5's TS-in-svelte AST printer
  // (esrap) does not yet emit TS union annotations on `let` declarations
  // — see G-T07-13 in `.context/known-gaps.md`. Drop the annotations and
  // rely on the submit-side validation.
  let hazardClass = '';
  let severity = '';
  let locationId = '';

  // Surface B state machine values:
  //   'idle' | 'drafting' | 'confirming' | 'submitting' | 'submitted' | 'error'
  // (Type alias omitted per G-T07-13.)
  let state = 'idle';
  let errorMessage = '';

  // Stable ids for aria-describedby wiring. Per design-system §4 Surface B
  // the source_name input MUST be `aria-describedby`-linked to the named-
  // source advisory so screen readers hear the disclosure before the
  // field receives focus.
  const advisoryId = 'concern-named-advisory';
  const helperOnId = 'concern-anon-helper-on';
  const titleErrId = 'concern-title-err';
  const bodyErrId = 'concern-body-err';

  /**
   * Toggle handler — routes through the consent gate before mutating
   * `anonymous`. The gate is the form's own advisory render: turning the
   * toggle OFF causes the advisory to appear AND the source_name field
   * to become available, but the field is empty (no name lingers from a
   * prior state).
   *
   * Per F-17 the toggle's audit-relevant effect is captured at submit
   * time (the `concern.created` row carries `anonymous_default_kept`),
   * not on every flip — flipping the toggle is not an audited action.
   */
  function onToggleAnonymous() {
    anonymous = !anonymous;
    if (anonymous === true) {
      // Defensive: clear any name the user may have typed before flipping
      // back to anonymous so submit cannot include stale plaintext.
      sourceName = '';
    }
    state = state === 'idle' ? 'drafting' : state;
    // Force a synchronous DOM flush so a `fireEvent.click(...)` followed
    // immediately by a `queryByTestId(...)` in tests observes the post-
    // mutation DOM. Without this, Svelte 5 may batch updates across a
    // microtask boundary that the fake clock does not drive. Mirrors the
    // pattern in `apps/web/src/lib/onboarding/recovery/RecoveryPassphraseScreen.svelte`.
    try {
      flushSync();
    } catch {
      // flushSync throws if called outside an effect context (jsdom edge
      // during initial event); swallow — Svelte will flush on its own.
    }
  }

  // @ts-expect-error G-T07-13 — Svelte 5's esrap printer cannot emit TS
  // parameter annotations on event handlers; the runtime guard
  // `e.key === ' ' || ...` carries the type discipline.
  function onKeyDownToggle(e) {
    if (e.key === ' ' || e.key === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      onToggleAnonymous();
    }
  }

  // Validation helpers — surface inline errors; do NOT submit on invalid.
  $: titleInvalid = state === 'error' && title.trim().length === 0;
  $: bodyInvalid = state === 'error' && body.trim().length === 0;
</script>

<!--
  Surface B layout, single column. Section headings appear when the form
  has more than the basic fields populated; for the unit tests only the
  switch / advisory / source-name shapes are load-bearing.
-->
<section
  class="concern-intake-form"
  aria-labelledby="concern-intake-heading"
  data-testid="concern-intake-form"
  aria-busy={state === 'submitting' ? 'true' : 'false'}
  style:--color-focus-inner={tokens.focus.inner}
  style:--color-focus-outer={tokens.focus.outer}
>
  <h1 id="concern-intake-heading">{t('concern.intake.heading')}</h1>
  <p class="concern-intake-subheading">{t('concern.intake.subheading')}</p>

  <form
    on:submit|preventDefault={() => {
      // Validation gate — surface inline errors instead of submitting.
      if (title.trim().length === 0 || body.trim().length === 0) {
        state = 'error';
        errorMessage = t('common.errors.generic');
        return;
      }
      state = 'submitting';
    }}
    novalidate
  >
    <!--
      Anonymous toggle — F-17 structural default-lock. The `switch` role
      + aria-checked + accessible-name pattern is the WCAG 2.0 AA shape
      for an on/off control. The accessible name reads:
        ON  → "Anonymous source, on. Press to switch off and record a name."
        OFF → "Named source, on. Press to switch back to anonymous."
      These two strings are the `a11y.concern.anonymous_on` / `.anonymous_off`
      i18n keys.
    -->
    <div class="field">
      <button
        type="button"
        role="switch"
        aria-checked={anonymous ? 'true' : 'false'}
        aria-label={anonymous ? t('a11y.concern.anonymous_on') : t('a11y.concern.anonymous_off')}
        aria-describedby={anonymous ? helperOnId : advisoryId}
        data-testid="concern-anonymous-toggle"
        on:click={onToggleAnonymous}
        on:keydown={onKeyDownToggle}
      >
        {anonymous ? t('concern.intake.anon.on_label') : t('concern.intake.anon.off_label')}
      </button>

      {#if anonymous}
        <p id={helperOnId} class="helper" data-testid="anonymous-helper">
          {t('concern.intake.anon.helper_on')}
        </p>
      {/if}
    </div>

    <!--
      Named-source advisory + source_name field. DOM order is load-bearing:
      the advisory MUST precede the input so screen-readers and visual
      reading order both receive the disclosure first. `role="status"` lets
      assistive tech announce the advisory once on flip.
    -->
    {#if !anonymous}
      <div
        id={advisoryId}
        role="status"
        class="alert-banner alert-banner--sensitive-c4"
        data-testid="named-source-advisory"
      >
        <strong>{t('concern.intake.named.advisory_heading')}</strong>
        <p>{t('concern.intake.named.advisory_body')}</p>
      </div>

      <div class="field">
        <label for="concern-source-name">
          {t('concern.intake.field.source_name')}
          <span class="sr-only">{t('common.labels.required')}</span>
        </label>
        <input
          id="concern-source-name"
          type="text"
          autocomplete="off"
          inputmode="text"
          bind:value={sourceName}
          aria-describedby={advisoryId}
          aria-required="true"
          data-testid="concern-source-name"
        />
      </div>
    {/if}

    <div class="field">
      <label for="concern-title">{t('concern.intake.field.title')}</label>
      <input
        id="concern-title"
        type="text"
        autocomplete="off"
        inputmode="text"
        bind:value={title}
        aria-required="true"
        aria-invalid={titleInvalid ? 'true' : 'false'}
        aria-describedby={titleInvalid ? titleErrId : undefined}
        data-testid="concern-title"
      />
      {#if titleInvalid}
        <p id={titleErrId} role="alert" class="field-error">
          {t('concern.intake.validation.title_required')}
        </p>
      {/if}
    </div>

    <div class="field">
      <label for="concern-body">{t('concern.intake.field.body')}</label>
      <textarea
        id="concern-body"
        bind:value={body}
        aria-required="true"
        aria-invalid={bodyInvalid ? 'true' : 'false'}
        aria-describedby={bodyInvalid ? bodyErrId : undefined}
        data-testid="concern-body"
        rows="6"
      ></textarea>
      {#if bodyInvalid}
        <p id={bodyErrId} role="alert" class="field-error">
          {t('concern.intake.validation.body_required')}
        </p>
      {/if}
    </div>

    <div class="field">
      <label for="concern-hazard">{t('concern.intake.field.hazard_class')}</label>
      <select id="concern-hazard" bind:value={hazardClass} data-testid="concern-hazard">
        <option value="">--</option>
        <option value="physical">physical</option>
        <option value="chemical">chemical</option>
        <option value="biological">biological</option>
        <option value="ergonomic">ergonomic</option>
        <option value="psychosocial">psychosocial</option>
        <option value="other">other</option>
      </select>
    </div>

    <div class="field">
      <label for="concern-severity">{t('concern.intake.field.severity')}</label>
      <select id="concern-severity" bind:value={severity} data-testid="concern-severity">
        <option value="">--</option>
        <option value="low">low</option>
        <option value="medium">medium</option>
        <option value="high">high</option>
        <option value="critical">critical</option>
      </select>
    </div>

    <div class="field">
      <label for="concern-location">{t('concern.intake.field.location')}</label>
      <input
        id="concern-location"
        type="text"
        autocomplete="off"
        bind:value={locationId}
        data-testid="concern-location"
      />
    </div>

    <div class="actions">
      <button
        type="submit"
        class="primary"
        disabled={state === 'submitting'}
        data-testid="concern-save"
      >
        {state === 'submitting'
          ? t('concern.intake.actions.saving')
          : t('concern.intake.actions.save')}
      </button>
    </div>

    {#if state === 'error' && errorMessage}
      <div role="alert" class="form-error" data-testid="concern-form-error">
        {errorMessage}
      </div>
    {/if}
  </form>
</section>

<style>
  /*
   * Worker-hub visual language port. Every colour reads from a
   * --color-* token defined in apps/web/src/app.html's boot stylesheet
   * (cool-slate surfaces + worker-hub blue accent + status tints);
   * spacing uses the 8pt grid in rem (matching apps/web/src/app.css);
   * the two-layer AODA focus ring is preserved on every focusable.
   *
   * Before this PR the form's CSS used a legacy --color-foreground-* /
   * --space-* / --typography-* token namespace that this app's boot
   * stylesheet doesn't expose, so the form rendered with browser
   * defaults (no spacing, no accent, no surface tint). The form is
   * unmounted today; this port readies it for the /concerns route
   * mount (T08.1 wire-up) so the surface lands in the worker-hub
   * palette out of the box.
   *
   * verify-tokens.sh is satisfied: every colour goes through a token;
   * raw rem/px values inside <style> blocks are allowed (the gate
   * only flags raw colour literals and inline-style px/rem).
   */
  .concern-intake-form {
    display: block;
    max-width: 34rem;
    margin-inline: auto;
    padding-inline: 1rem;
    color: var(--color-fg);
    background-color: var(--color-bg);
  }

  h1 {
    font-family: var(--font-sans);
    font-size: 1.25rem;
    font-weight: 600;
    line-height: 1.25;
    margin-block-start: 0;
    margin-block-end: 0.5rem;
  }

  .concern-intake-subheading {
    font-family: var(--font-sans);
    font-size: 0.9375rem;
    color: var(--color-fg-muted);
    margin-block-end: 1rem;
  }

  .field {
    display: block;
    margin-block-end: 1.25rem;
  }

  label {
    display: block;
    font-weight: 500;
    margin-block-end: 0.25rem;
  }

  input[type='text'],
  textarea,
  select {
    display: block;
    width: 100%;
    min-height: 2.75rem;
    padding-block: 0.5rem;
    padding-inline: 0.75rem;
    font-family: var(--font-sans);
    font-size: 0.9375rem;
    color: var(--color-fg);
    background-color: var(--color-bg-elevated);
    border-style: solid;
    border-width: 1px;
    border-color: var(--color-border-strong);
    border-radius: var(--radius-md);
    transition:
      box-shadow 150ms ease,
      border-color 150ms ease;
  }

  input:focus-visible,
  textarea:focus-visible,
  select:focus-visible,
  button:focus-visible {
    outline: none;
    /*
     * Two-layer AODA focus ring (preserved from the worker-hub
     * baseline): a 2px inner foreground line + a 3px outer halo. The
     * inner layer is the WCAG 1.4.11 conformance path; removing it is
     * forbidden.
     */
    box-shadow:
      0 0 0 2px var(--color-focus-inner),
      0 0 0 5px var(--color-focus-outer);
    border-color: var(--color-focus-inner);
  }

  button[role='switch'] {
    /*
     * The switch button doubles as the toggle target; the accessible
     * name reads the locale string per a11y.concern.anonymous_on/off.
     * Min size meets the 44px touch-target floor at mobile breakpoints.
     */
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 2.75rem;
    min-height: 2.75rem;
    padding-block: 0.5rem;
    padding-inline: 0.75rem;
    font-family: var(--font-sans);
    font-size: 0.9375rem;
    background-color: var(--color-bg-elevated);
    color: var(--color-fg);
    border-style: solid;
    border-width: 1px;
    border-color: var(--color-border-strong);
    border-radius: var(--radius-md);
    cursor: pointer;
  }

  button[role='switch'][aria-checked='true'] {
    background-color: var(--color-accent);
    color: var(--color-accent-fg);
    border-color: var(--color-accent);
  }

  .helper,
  .field-error,
  .form-error {
    font-family: var(--font-sans);
    font-size: 0.8125rem;
    color: var(--color-fg-muted);
    margin-block-start: 0.25rem;
  }

  .field-error,
  .form-error {
    color: var(--color-destructive);
  }

  /*
   * C4 sensitivity callout — distinct from the standard red status
   * tint so a sensitive surface is never confused with a generic
   * error. Until a dedicated --color-c4-* token group lands in the
   * boot stylesheet, we use the red tint here (semantically the
   * closest available); the design-tokens.json C4 palette (deep
   * burgundy bg + striped fill) is on the design-system roadmap.
   */
  .alert-banner {
    display: block;
    padding-block: 0.75rem;
    padding-inline: 0.875rem;
    border-radius: var(--radius-md);
    margin-block-end: 1.25rem;
    color: var(--color-fg);
  }

  .alert-banner--sensitive-c4 {
    background-color: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-inline-start-style: solid;
    border-inline-start-width: 4px;
    border-inline-start-color: var(--color-tint-red-border);
  }

  .alert-banner strong {
    display: block;
    margin-block-end: 0.25rem;
    font-weight: 600;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-block-start: 1rem;
  }

  .actions .primary {
    min-height: 2.75rem;
    padding-block: 0.5rem;
    padding-inline: 1rem;
    font-family: var(--font-sans);
    font-size: 0.9375rem;
    font-weight: 600;
    background-color: var(--color-accent);
    color: var(--color-accent-fg);
    border: 1px solid var(--color-accent);
    border-radius: var(--radius-md);
    cursor: pointer;
  }

  .actions .primary:hover:not([disabled]) {
    background-color: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
  }

  .actions .primary[disabled] {
    cursor: not-allowed;
    opacity: 0.55;
  }

  /*
   * Visually-hidden for the screen-reader-only "required" label
   * (design-system §4 Surface B asserts a "required" SR string).
   */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /*
   * Reduced-motion — collapse all transitions to instant. The boot
   * stylesheet's global @media query already zeros transition +
   * animation durations app-wide; this rule is defense-in-depth for
   * the form's specific transitions.
   */
  @media (prefers-reduced-motion: reduce) {
    input,
    textarea,
    select,
    button {
      transition-duration: 0ms;
    }
  }
</style>
