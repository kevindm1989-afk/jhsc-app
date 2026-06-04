<script>
  /**
   * D.6 — Type-back verification.
   *
   * Per F-104 M-104c the type-back input carries `autocomplete="off"`,
   * `spellcheck="false"`, `autocapitalize="none"`, `autocorrect="off"`
   * (defense against Chromium cloud-spellcheck round-tripping the
   * passphrase to Google).
   *
   * Per F-104 M-104d the match is constant-time: the comparison helper
   * walks the full string. This file MUST NOT use `===` on the
   * passphrase or typed value.
   */
  import { t } from '../../i18n';

  export let typed_value = '';
</script>

<section class="type-back">
  <h2>{t('onboarding.passphrase_d4.confirm_label')}</h2>
  <label for="d6-type-back">{t('onboarding.passphrase_d4.confirm_label')}</label>
  <textarea
    id="d6-type-back"
    class="type-back-input"
    bind:value={typed_value}
    autocomplete="off"
    spellcheck="false"
    autocapitalize="none"
    autocorrect="off"
  ></textarea>
</section>

<style>
  /*
   * Type-back surface — the user is re-typing the passphrase they were
   * just shown at D.4. Monospace + letter-spacing matches the D.4
   * passphrase-reveal block so chunk boundaries read identically; the
   * textarea is sized for a full ~32-char passphrase across two lines
   * without overflowing on a narrow mobile viewport.
   *
   * The defensive autocomplete/spellcheck/autocapitalize/autocorrect
   * attributes are set in markup (F-104 M-104c — defense against
   * Chromium cloud-spellcheck round-tripping the passphrase to Google);
   * the test pins those literal attribute values, not the style.
   */
  .type-back label[for='d6-type-back'] {
    display: block;
    margin-block: 0.5rem 0.375rem;
    color: var(--color-fg);
    font-weight: 500;
  }
  .type-back-input {
    display: block;
    width: 100%;
    min-height: 5rem;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-family: var(--font-mono);
    font-size: 1rem;
    line-height: 1.5;
    letter-spacing: 0.02em;
    resize: vertical;
  }
  .type-back-input:focus-visible {
    outline: 2px solid var(--color-focus-inner);
    outline-offset: 1px;
    box-shadow: 0 0 0 4px var(--color-focus-outer);
  }
</style>
