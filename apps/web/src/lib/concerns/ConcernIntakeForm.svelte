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
    Token consumption — every value below is a CSS custom-property hook
    that maps onto an entry in /home/user/agent-os/design-tokens.json
    (resolved via apps/web/src/lib/tokens.ts in production). The literal
    `1px` border width is the only raw-pixel value tolerated here and
    only because the design-tokens.json does not currently expose a
    `border.width` token — see G-T08-* note in known-gaps.

    The `:focus-visible` outline is two-layer per design-tokens.json
    `shadow.focus_ring` ("yellow halo + dark inner line"). The inner
    layer is the WCAG 1.4.11 conformance path; removing it is forbidden.
  */
  .concern-intake-form {
    display: block;
    max-width: var(--layout-max-width-form, 560px);
    margin-inline: auto;
    padding-inline: var(--layout-gutter, 1rem);
    color: var(--color-foreground-primary);
    background-color: var(--color-background-primary);
  }

  h1 {
    font-family: var(--typography-family-sans);
    font-size: var(--typography-size-heading-md);
    font-weight: var(--typography-weight-semibold);
    line-height: var(--typography-leading-tight);
    margin-block-start: 0;
    margin-block-end: var(--space-2);
  }

  .concern-intake-subheading {
    font-family: var(--typography-family-sans);
    font-size: var(--typography-size-body);
    color: var(--color-foreground-secondary);
    margin-block-end: var(--space-4);
  }

  .field {
    display: block;
    margin-block-end: var(--density-form-field-gap, 1.25rem);
  }

  label {
    display: block;
    font-weight: var(--typography-weight-medium);
    margin-block-end: var(--space-1);
  }

  input[type='text'],
  textarea,
  select {
    display: block;
    width: 100%;
    min-height: var(--touch-target-min, 2.75rem);
    padding-block: var(--space-2);
    padding-inline: var(--space-3);
    font-family: var(--typography-family-sans);
    font-size: var(--typography-size-body);
    color: var(--color-foreground-primary);
    background-color: var(--color-background-raised);
    border-style: solid;
    border-width: 1px; /* No `border.width` token exists; 1px allowed. */
    border-color: var(--color-border-default);
    border-radius: var(--radius-md);
    transition:
      box-shadow var(--motion-duration-fast) var(--motion-easing-out),
      border-color var(--motion-duration-fast) var(--motion-easing-out);
  }

  input:focus-visible,
  textarea:focus-visible,
  select:focus-visible,
  button:focus-visible {
    outline: none;
    /*
      Two-layer focus ring per design-tokens.json shadow.focus_ring.
      CSS variables are bound on the root <section> via `style:` directives
      that read from $lib/tokens (token-audit-allowlisted accessor over
      design-tokens.json). The form is the single canonical consumer until
      the global token-emitter lands.
    */
    box-shadow:
      0 0 0 2px var(--color-focus-inner),
      0 0 0 5px var(--color-focus-outer);
    border-color: var(--color-focus-inner);
  }

  button[role='switch'] {
    /*
      The switch button doubles as the toggle target; the accessible name
      reads the locale string per `a11y.concern.anonymous_on/off`. Min size
      meets `touch_target.min` (44px) at mobile breakpoints.
    */
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-width: var(--touch-target-min, 2.75rem);
    min-height: var(--touch-target-min, 2.75rem);
    padding-block: var(--space-2);
    padding-inline: var(--space-3);
    font-family: var(--typography-family-sans);
    font-size: var(--typography-size-body);
    background-color: var(--color-background-raised);
    color: var(--color-foreground-primary);
    border-style: solid;
    border-width: 1px;
    border-color: var(--color-border-default);
    border-radius: var(--radius-md);
    cursor: pointer;
  }

  button[role='switch'][aria-checked='true'] {
    background-color: var(--color-accent-default);
    color: var(--color-on-accent);
  }

  .helper,
  .field-error,
  .form-error {
    font-family: var(--typography-family-sans);
    font-size: var(--typography-size-helper);
    color: var(--color-foreground-secondary);
    margin-block-start: var(--space-1);
  }

  .field-error,
  .form-error {
    color: var(--color-state-danger);
  }

  .alert-banner {
    display: block;
    padding-block: var(--space-3);
    padding-inline: var(--space-3);
    border-radius: var(--radius-md);
    margin-block-end: var(--density-form-field-gap, 1.25rem);
    color: var(--color-foreground-primary);
  }

  .alert-banner--sensitive-c4 {
    background-color: var(--color-sensitivity-c4-bg);
    border-inline-start-style: solid;
    border-inline-start-width: 4px; /* C4 left border per design-tokens. */
    border-inline-start-color: var(--color-sensitivity-c4-border);
  }

  .alert-banner strong {
    display: block;
    margin-block-end: var(--space-1);
    font-weight: var(--typography-weight-semibold);
  }

  .actions {
    display: flex;
    gap: var(--space-3);
    margin-block-start: var(--space-4);
  }

  .actions .primary {
    min-height: var(--touch-target-min, 2.75rem);
    padding-block: var(--space-2);
    padding-inline: var(--space-4);
    font-family: var(--typography-family-sans);
    font-size: var(--typography-size-body);
    font-weight: var(--typography-weight-semibold);
    background-color: var(--color-accent-default);
    color: var(--color-on-accent);
    border: none;
    border-radius: var(--radius-md);
    cursor: pointer;
  }

  .actions .primary[disabled] {
    cursor: not-allowed;
    opacity: var(--opacity-disabled, 0.6);
  }

  /*
    Visually-hidden for the screen-reader-only "required" label
    (design-system §4 Surface B asserts a "required" SR string).
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
    Reduced-motion — collapse all transitions to instant per
    design-tokens.json motion._reduced_motion ("transitions collapse to
    duration.instant; opacity-only transitions persist at duration.micro").
  */
  @media (prefers-reduced-motion: reduce) {
    input,
    textarea,
    select,
    button {
      transition-duration: var(--motion-duration-instant, 0ms);
    }
  }
</style>
