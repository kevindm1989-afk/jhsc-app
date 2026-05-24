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

<section>
  <h2>{t('onboarding.passphrase_d4.confirm_label')}</h2>
  <label for="d6-type-back">{t('onboarding.passphrase_d4.confirm_label')}</label>
  <textarea
    id="d6-type-back"
    bind:value={typed_value}
    autocomplete="off"
    spellcheck="false"
    autocapitalize="none"
    autocorrect="off"
  ></textarea>
</section>
