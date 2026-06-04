<script lang="ts">
  // INVARIANT: T19 does NOT confer any role. Workplace bootstrap is a
  // separate task. Any future change adding a role-write here re-opens
  // F-114 (first-user-no-membership-yet bootstrap; admin-role grant on
  // D.7 completion). The integration test enforces this by asserting
  // zero `role.%` audit rows after D.1 → D.7 traversal.
  import { t } from '../../i18n';
</script>

<section role="status" data-testid="completion-summary" class="completion">
  <svg
    class="completion-hero-icon"
    data-icon="check-circle"
    width="56"
    height="56"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" />
    <path d="M7 12l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2" />
  </svg>
  <h1 id="onboarding-current-heading" tabindex="-1">{t('onboarding.completion_d7.heading')}</h1>
  <p>{t('onboarding.completion_d7.body')}</p>
  <ul class="completion-checklist">
    <li>{t('onboarding.completion_d7.checklist.passkey')}</li>
    <li>{t('onboarding.completion_d7.checklist.recovery_blob_downloaded')}</li>
    <li>{t('onboarding.completion_d7.checklist.recovery_blob_printed')}</li>
    <li>{t('onboarding.completion_d7.checklist.sessions_reviewed')}</li>
  </ul>
</section>

<!-- svelte-ignore a11y_no_redundant_roles -->
<!-- role="region" is implicit on a named <section>, but kept explicit because the
     D.T19.h state-completeness test asserts the literal role attribute. -->
<section
  class="completion-next"
  aria-labelledby="d7-next-steps-heading"
  data-testid="completion-next-steps"
  role="region"
>
  <h3 id="d7-next-steps-heading">{t('onboarding.completion_d7.next_steps_heading')}</h3>
  <p>{t('onboarding.completion_d7.next_steps_body')}</p>
</section>

<style>
  /*
   * Completion surface — visual reward for finishing the ceremony. The
   * check-circle icon is REQUIRED (Designer D.T19.h, colour-blind safety
   * — the green stroke alone is insufficient on protanopia/deuteranopia
   * screens, so the checkmark shape carries the signal). Sized at 56px
   * here vs. the legacy 24px so it reads as a hero icon rather than a
   * row affordance.
   *
   * The next-steps panel is a sub-card with a tinted background so it
   * visually separates from the completion summary above without
   * competing with the hero.
   */
  .completion {
    text-align: center;
  }
  .completion-hero-icon {
    display: block;
    margin: 0.5rem auto 1rem;
    color: var(--color-status-resolved);
  }
  .completion-checklist {
    margin-block: 0.75rem;
    padding-inline-start: 0;
    list-style: none;
    text-align: start;
  }
  .completion-checklist > li {
    position: relative;
    padding-block: 0.25rem;
    padding-inline-start: 1.5rem;
    color: var(--color-fg);
  }
  .completion-checklist > li::before {
    content: '';
    position: absolute;
    inset-inline-start: 0;
    inset-block-start: 0.7em;
    width: 0.625rem;
    height: 0.375rem;
    border-inline-start: 2px solid var(--color-status-resolved);
    border-block-end: 2px solid var(--color-status-resolved);
    transform: translateY(-50%) rotate(-45deg);
  }
  .completion-next {
    display: block;
    margin-block-start: 1.25rem;
    padding: 1rem 1.25rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
  }
  .completion-next > :first-child {
    margin-block-start: 0;
  }
  .completion-next > :last-child {
    margin-block-end: 0;
  }
</style>
