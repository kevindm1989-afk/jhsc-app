<script>
  /**
   * AboutCard — version + key links surface on /settings.
   *
   * Useful for:
   *   - Confirming the app version a worker is reporting against (an
   *     in-app version label avoids "what version are you running?"
   *     friction with co-chair / support).
   *   - Surfacing the canonical security disclosure path
   *     (/.well-known/security.txt — RFC 9116) so a researcher who
   *     stumbles into a problem knows where to send the report.
   *   - Linking to the public threat-model + decisions docs in the
   *     repo so curious committee members can read the contracts the
   *     app enforces.
   *
   * No PI. No network roundtrip. All copy via t() (English placeholders
   * today; the lawyer-review pass refines the disclosure language).
   *
   * `<script>` (no lang="ts") + JSDoc per G-T07-13.
   */
  import { t } from '$lib/i18n';

  // Version is sourced from the build at injection time. For now we
  // read import.meta.env.VITE_APP_VERSION if the build wires it,
  // otherwise fall back to a placeholder so the card still renders
  // useful content. A future build-config PR can wire vite-plugin-
  // version-injector or similar so this is automatic.
  const APP_VERSION =
    /** @type {Record<string, string | undefined>} */ (import.meta.env).VITE_APP_VERSION ?? 'dev';

  // The repo + docs URLs are intentionally hardcoded constants here
  // (not env-driven) — they're public-by-design and a future repo
  // move/rename is a deliberate change, not a deployment-config knob.
  const REPO_URL = 'https://github.com/kevindm1989-afk/jhsc-app';
  const SECURITY_TXT_URL = '/.well-known/security.txt';
  const THREAT_MODEL_URL = `${REPO_URL}/blob/main/.context/threat-model.md`;
  const DECISIONS_URL = `${REPO_URL}/blob/main/.context/decisions.md`;
</script>

<section class="about-section" aria-labelledby="about-heading" data-testid="about-section">
  <h2 id="about-heading">{t('settings.about.heading')}</h2>
  <p class="muted">{t('settings.about.intro')}</p>

  <dl class="about-list">
    <div class="about-row" data-testid="about-app">
      <dt>{t('settings.about.label.app')}</dt>
      <dd>{t('common.app_name')}</dd>
    </div>
    <div class="about-row" data-testid="about-version">
      <dt>{t('settings.about.label.version')}</dt>
      <dd><code data-testid="about-version-value">{APP_VERSION}</code></dd>
    </div>
    <div class="about-row" data-testid="about-security">
      <dt>{t('settings.about.label.security')}</dt>
      <dd>
        <a href={SECURITY_TXT_URL} rel="noopener" data-testid="about-security-link">
          {t('settings.about.security_link')}
        </a>
      </dd>
    </div>
    <div class="about-row" data-testid="about-threat-model">
      <dt>{t('settings.about.label.threat_model')}</dt>
      <dd>
        <a
          href={THREAT_MODEL_URL}
          rel="noopener external"
          target="_blank"
          data-testid="about-threat-model-link"
        >
          {t('settings.about.threat_model_link')}
        </a>
      </dd>
    </div>
    <div class="about-row" data-testid="about-decisions">
      <dt>{t('settings.about.label.decisions')}</dt>
      <dd>
        <a
          href={DECISIONS_URL}
          rel="noopener external"
          target="_blank"
          data-testid="about-decisions-link"
        >
          {t('settings.about.decisions_link')}
        </a>
      </dd>
    </div>
  </dl>

  <p class="muted about-license-note" data-testid="about-license-note">
    {t('settings.about.license_note')}
  </p>
</section>

<style>
  .about-section {
    margin-block-start: 1.25rem;
  }
  .about-list {
    display: block;
    margin-block: 0.75rem 0;
    padding: 0;
  }
  .about-row {
    display: grid;
    grid-template-columns: minmax(8rem, 12rem) 1fr;
    gap: 0.5rem 1rem;
    padding-block: 0.5rem;
    border-block-end: 1px solid var(--color-border);
  }
  .about-row:last-of-type {
    border-block-end: 0;
  }
  .about-row dt {
    color: var(--color-fg-muted);
    font-weight: 500;
    font-size: 0.8125rem;
  }
  .about-row dd {
    margin: 0;
    color: var(--color-fg);
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }
  .about-row dd code {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
  }
  .about-row dd a {
    color: var(--color-accent);
  }
  .about-row dd a:hover {
    color: var(--color-accent-hover);
  }
  .about-license-note {
    margin-block: 1rem 0;
    font-size: 0.75rem;
  }
</style>
