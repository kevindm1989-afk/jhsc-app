<script lang="ts">
  // INVARIANT: T19 does NOT confer any role. Workplace bootstrap is a
  // separate task. Any future change adding a role-write here re-opens
  // F-114 (first-user-no-membership-yet bootstrap; admin-role grant on
  // D.7 completion). The integration test enforces this by asserting
  // zero `role.%` audit rows after D.1 → D.7 traversal.
  import { t } from '../../i18n';
</script>

<section role="status" data-testid="completion-summary">
  <h2>{t('onboarding.completion_d7.heading')}</h2>
  <svg data-icon="check-circle" width="24" height="24" aria-hidden="true">
    <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" />
    <path d="M7 12l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2" />
  </svg>
  <p>{t('onboarding.completion_d7.body')}</p>
  <ul>
    <li>{t('onboarding.completion_d7.checklist.passkey')}</li>
    <li>{t('onboarding.completion_d7.checklist.recovery_blob_downloaded')}</li>
    <li>{t('onboarding.completion_d7.checklist.recovery_blob_printed')}</li>
    <li>{t('onboarding.completion_d7.checklist.sessions_reviewed')}</li>
  </ul>
</section>

<section
  role="region"
  aria-labelledby="d7-next-steps-heading"
  data-testid="completion-next-steps"
>
  <h3 id="d7-next-steps-heading">{t('onboarding.completion_d7.next_steps_heading')}</h3>
  <p>{t('onboarding.completion_d7.next_steps_body')}</p>
</section>
