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
        rows="8"></textarea>
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
   * Worker-hub visual language port — same migration as PR for
   * ConcernIntakeForm. Every colour reads from a --color-* token
   * defined in apps/web/src/app.html's boot stylesheet (cool-slate
   * surfaces + worker-hub blue accent + status tints); spacing uses
   * the 8pt grid in rem (matching apps/web/src/app.css); the
   * two-layer AODA focus ring is preserved on every focusable.
   *
   * Before this PR the form's CSS used a legacy --color-foreground-* /
   * --space-* / --typography-* token namespace that this app's boot
   * stylesheet doesn't expose, so the form rendered with browser
   * defaults. The form is unmounted today; this port readies it for
   * the /reprisal route mount (T13.1 wire-up) so the surface lands
   * in the worker-hub palette out of the box.
   */
  .reprisal-intake-form {
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

  .lead {
    font-family: var(--font-sans);
    font-size: 0.9375rem;
    color: var(--color-fg-muted);
    margin-block-end: 1rem;
  }

  .consent-bullets {
    display: block;
    padding-inline-start: 1rem;
    margin-block-end: 0.75rem;
    color: var(--color-fg);
  }

  .consent-bullets li {
    margin-block-end: 0.5rem;
    line-height: 1.55;
  }

  /*
   * OHSA reminder — C4 sensitivity callout. Until a dedicated
   * --color-c4-* token group lands in the boot stylesheet, we use the
   * red tint (semantically the closest available); the design-tokens
   * deep-burgundy C4 palette is on the design-system roadmap.
   */
  .ohsa-reminder {
    background-color: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-inline-start-style: solid;
    border-inline-start-width: 4px;
    border-inline-start-color: var(--color-tint-red-border);
    padding-block: 0.75rem;
    padding-inline: 0.875rem;
    border-radius: var(--radius-md);
    margin-block-end: 1rem;
  }

  .field {
    display: block;
    margin-block-end: 1.25rem;
  }

  .consent-field {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    margin-block-end: 1rem;
  }

  .consent-field input[type='checkbox'] {
    width: 1.25rem;
    height: 1.25rem;
    margin-block-start: 0.15rem;
    flex-shrink: 0;
    accent-color: var(--color-accent);
  }

  label {
    display: block;
    font-weight: 500;
    margin-block-end: 0.25rem;
  }

  input[type='text'],
  input[type='password'],
  textarea {
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
  button:focus-visible {
    outline: none;
    /*
     * Two-layer AODA focus ring (preserved): a 2px inner foreground
     * line + a 3px outer halo. The inner layer is the WCAG 1.4.11
     * conformance path; removing it is forbidden.
     */
    box-shadow:
      0 0 0 2px var(--color-focus-inner),
      0 0 0 5px var(--color-focus-outer);
    border-color: var(--color-focus-inner);
  }

  .helper,
  .form-error {
    font-family: var(--font-sans);
    font-size: 0.8125rem;
    color: var(--color-fg-muted);
    margin-block-start: 0.25rem;
  }

  .form-error {
    color: var(--color-destructive);
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

  .actions .primary:hover:not([aria-disabled='true']) {
    background-color: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
  }

  .actions .primary[aria-disabled='true'] {
    cursor: not-allowed;
    opacity: 0.55;
  }

  /*
   * Reduced-motion — the boot stylesheet's global @media query
   * already zeros transition + animation durations app-wide; this
   * rule is defense-in-depth for the form's specific transitions.
   */
  @media (prefers-reduced-motion: reduce) {
    input,
    textarea,
    button {
      transition-duration: 0ms;
    }
  }
</style>
