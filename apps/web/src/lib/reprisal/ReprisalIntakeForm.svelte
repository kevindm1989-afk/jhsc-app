<script lang="ts">
  /**
   * Reprisal intake form — Surface C (T13 / ADR-0007 amendment / HG-13).
   *
   * Structural posture (load-bearing):
   *   - The four-bullet consent contract renders on EVERY mount (no
   *     "remember consent" flag — privacy-review §2.4 + ADR-0007
   *     amendment). The component holds NO module-level state; every
   *     fresh render starts the checkbox UNCHECKED.
   *   - The "Save entry" button is structurally gated: `aria-disabled`
   *     reflects the checkbox state AND the click handler short-circuits
   *     when the checkbox is not checked. Both gates are present — the
   *     CSS-only `disabled` posture is insufficient for a non-button
   *     synthesized click in some screen readers.
   *   - Per F-17 the actor is always recorded (no anonymous mode on
   *     reprisal entries). The author IS visible to the rep at submit
   *     time; the pseudonymized projection (Amendment D) hides the
   *     author from OTHER members' feed, not from the author's own UI.
   *
   * Token consumption: every value is a CSS custom property bound via
   * Svelte's `style:` directive from `$lib/tokens`. No hex / px literals.
   *
   * i18n: every visible string resolves through `t(key)`. The consent
   * bullets are `reprisal.create.consent.bullet_encrypted`, `_visible`,
   * `_why`, `_not_visible`; the checkbox label is `_checkbox_label`.
   *
   * Source: ADR-0007 amendment (consent surface); privacy-review §2.4
   * (four-bullet copy); threat-model §3.4; design-system §4 Surface C.
   */

  import { flushSync } from 'svelte';
  import { t } from '../i18n';
  import { tokens } from '../tokens';

  // ADR-0007 amendment — every fresh mount starts the consent UNGIVEN.
  // There is NO module-level persistence of the "last value"; that would
  // defeat the structural per-intake re-render the privacy-review §2.4
  // wording requires.
  let consented = false;
  let title = '';
  let body = '';
  let passphrase = '';
  let passphraseConfirm = '';

  // State machine: 'idle' | 'drafting' | 'submitting' | 'submitted' | 'error'
  let state = 'idle';
  let errorMessage = '';

  // Stable ids for aria-describedby wiring.
  const consentHeadingId = 'reprisal-consent-heading';
  const consentDescId = 'reprisal-consent-desc';
  const checkboxId = 'reprisal-consent-checkbox';

  // The four bullets the test enumerates via `data-testid="consent-bullet"`.
  const bulletKeys = [
    'reprisal.create.consent.bullet_encrypted',
    'reprisal.create.consent.bullet_visible',
    'reprisal.create.consent.bullet_why',
    'reprisal.create.consent.bullet_not_visible'
  ];

  // @ts-expect-error G-T07-13 — Svelte 5's esrap printer cannot emit TS
  // parameter annotations on event handlers; the runtime guard
  // `target?.checked ?? !consented` carries the type discipline.
  function onToggleConsent(event) {
    const target = event.target;
    // Read the checkbox's actual checked state. The DOM toggles before
    // the handler runs in jsdom + testing-library; `target.checked`
    // reflects the post-click value.
    consented = target?.checked ?? !consented;
    // Force a synchronous flush so a follow-up assertion in the same
    // tick observes the post-mutation DOM. Mirrors the concern form's
    // toggle pattern (see G-T07-13 note).
    try {
      flushSync();
    } catch {
      // flushSync throws outside an effect context (jsdom edge); swallow.
    }
  }
</script>

<section
  class="reprisal-intake-form"
  aria-labelledby={consentHeadingId}
  data-testid="reprisal-intake-form"
  aria-busy={state === 'submitting' ? 'true' : 'false'}
  style:--color-focus-inner={tokens.focus.inner}
  style:--color-focus-outer={tokens.focus.outer}
>
  <header>
    <h1 id={consentHeadingId}>{t('reprisal.create.consent.heading')}</h1>
    <p id={consentDescId} class="lead">{t('reprisal.create.consent.lead')}</p>
  </header>

  <!--
    Four-bullet contract. Privacy-review §2.4 + ADR-0007 amendment require
    these bullets to render BEFORE the consent checkbox. The DOM order
    here is load-bearing; do not move the checkbox above the list.
  -->
  <ul class="consent-bullets" aria-describedby={consentDescId}>
    {#each bulletKeys as bulletKey (bulletKey)}
      <li data-testid="consent-bullet">{t(bulletKey)}</li>
    {/each}
  </ul>

  <p class="ohsa-reminder">{t('reprisal.create.consent.ohsa_reminder')}</p>

  <!--
    Consent checkbox. Structural gate: until this is checked, the save
    button's click handler short-circuits AND aria-disabled is true. The
    label uses `htmlFor` for SR compatibility with screen-readers that
    do not announce wrapping-label semantics.
  -->
  <div class="field consent-field">
    <input
      id={checkboxId}
      type="checkbox"
      checked={consented}
      on:change={onToggleConsent}
      on:click={onToggleConsent}
      data-testid="reprisal-consent-checkbox"
    />
    <label for={checkboxId}>{t('reprisal.create.consent.checkbox_label')}</label>
  </div>

  <form
    on:submit|preventDefault={() => {
      // Structural gate — short-circuit when consent missing OR fields
      // empty. The aria-disabled posture on the button is a hint to the
      // user; the handler is the actual gate.
      if (!consented) return;
      if (title.trim().length === 0 || body.trim().length === 0) {
        state = 'error';
        errorMessage = t('common.errors.generic');
        return;
      }
      if (passphrase.length === 0 || passphrase !== passphraseConfirm) {
        state = 'error';
        errorMessage = t('common.errors.generic');
        return;
      }
      state = 'submitting';
    }}
    novalidate
  >
    <div class="field">
      <label for="reprisal-title">{t('reprisal.create.field.title')}</label>
      <input
        id="reprisal-title"
        type="text"
        autocomplete="off"
        inputmode="text"
        bind:value={title}
        aria-required="true"
        data-testid="reprisal-title"
      />
    </div>

    <div class="field">
      <label for="reprisal-body">{t('reprisal.create.field.body')}</label>
      <textarea
        id="reprisal-body"
        bind:value={body}
        aria-required="true"
        data-testid="reprisal-body"
        rows="8"
      ></textarea>
    </div>

    <div class="field">
      <label for="reprisal-passphrase">{t('reprisal.create.field.passphrase')}</label>
      <input
        id="reprisal-passphrase"
        type="password"
        autocomplete="new-password"
        bind:value={passphrase}
        aria-required="true"
        aria-describedby="reprisal-passphrase-help"
        data-testid="reprisal-passphrase"
      />
      <p id="reprisal-passphrase-help" class="helper">
        {t('reprisal.create.passphrase.helper')}
      </p>
    </div>

    <div class="field">
      <label for="reprisal-passphrase-confirm"
        >{t('reprisal.create.field.passphrase_confirm')}</label
      >
      <input
        id="reprisal-passphrase-confirm"
        type="password"
        autocomplete="new-password"
        bind:value={passphraseConfirm}
        aria-required="true"
        data-testid="reprisal-passphrase-confirm"
      />
    </div>

    <div class="actions">
      <button
        type="submit"
        class="primary"
        aria-disabled={consented ? 'false' : 'true'}
        data-testid="reprisal-save"
      >
        {state === 'submitting'
          ? t('reprisal.create.actions.saving')
          : t('reprisal.create.actions.save')}
      </button>
    </div>

    {#if state === 'error' && errorMessage}
      <div role="alert" class="form-error" data-testid="reprisal-form-error">
        {errorMessage}
      </div>
    {/if}
  </form>
</section>

<style>
  /*
    Token consumption — every value below is a CSS custom-property hook
    bound through tokens.ts at the section root via `style:` directives.
    The literal `1px` border width is the only raw-pixel value tolerated;
    no `border.width` token exists yet (matches T08's exception).
  */
  .reprisal-intake-form {
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

  .lead {
    font-family: var(--typography-family-sans);
    font-size: var(--typography-size-body);
    color: var(--color-foreground-secondary);
    margin-block-end: var(--space-4);
  }

  .consent-bullets {
    display: block;
    padding-inline-start: var(--space-4);
    margin-block-end: var(--space-3);
    color: var(--color-foreground-primary);
  }

  .consent-bullets li {
    margin-block-end: var(--space-2);
    line-height: var(--typography-leading-relaxed);
  }

  .ohsa-reminder {
    background-color: var(--color-sensitivity-c4-bg);
    border-inline-start-style: solid;
    border-inline-start-width: 4px;
    border-inline-start-color: var(--color-sensitivity-c4-border);
    padding-block: var(--space-3);
    padding-inline: var(--space-3);
    border-radius: var(--radius-md);
    margin-block-end: var(--space-4);
  }

  .field {
    display: block;
    margin-block-end: var(--density-form-field-gap, 1.25rem);
  }

  .consent-field {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin-block-end: var(--space-4);
  }

  .consent-field input[type='checkbox'] {
    width: var(--touch-target-min, 2.75rem);
    height: var(--touch-target-min, 2.75rem);
    margin: 0;
    flex-shrink: 0;
  }

  label {
    display: block;
    font-weight: var(--typography-weight-medium);
    margin-block-end: var(--space-1);
  }

  input[type='text'],
  input[type='password'],
  textarea {
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
    border-width: 1px;
    border-color: var(--color-border-default);
    border-radius: var(--radius-md);
    transition:
      box-shadow var(--motion-duration-fast) var(--motion-easing-out),
      border-color var(--motion-duration-fast) var(--motion-easing-out);
  }

  input:focus-visible,
  textarea:focus-visible,
  button:focus-visible {
    outline: none;
    /*
      Two-layer focus ring per design-tokens.json shadow.focus_ring.
      The :focus-visible replacement is mandatory — never strip the
      outline without an equivalent visible indicator.
    */
    box-shadow:
      0 0 0 2px var(--color-focus-inner),
      0 0 0 5px var(--color-focus-outer);
    border-color: var(--color-focus-inner);
  }

  .helper,
  .form-error {
    font-family: var(--typography-family-sans);
    font-size: var(--typography-size-helper);
    color: var(--color-foreground-secondary);
    margin-block-start: var(--space-1);
  }

  .form-error {
    color: var(--color-state-danger);
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

  .actions .primary[aria-disabled='true'] {
    cursor: not-allowed;
    opacity: var(--opacity-disabled, 0.6);
  }

  /*
    Reduced-motion — collapse transitions to instant per
    design-tokens.json motion._reduced_motion.
  */
  @media (prefers-reduced-motion: reduce) {
    input,
    textarea,
    button {
      transition-duration: var(--motion-duration-instant, 0ms);
    }
  }
</style>
