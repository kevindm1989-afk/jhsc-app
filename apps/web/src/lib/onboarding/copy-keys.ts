/**
 * Closed-allowlist of i18n catalog keys consumed by T19 surfaces.
 *
 * Per ADR-0020 Decision 11 + F-110 M-110a: every user-facing error AND
 * label in the wizard surfaces resolves to a key declared HERE. The CI
 * grep gate at `i18n-catalog-coverage.test.ts` checks that every entry
 * in this list exists in either the scoped catalog
 * (`apps/web/src/lib/i18n/onboarding.en-CA.json`) or the root catalog
 * (`/home/user/agent-os/i18n/en-CA.json`).
 *
 * Defense-in-depth: components MUST reference these keys via the
 * `COPY_KEYS.<name>` accessor (or as literal strings — both shapes are
 * accepted by the grep gate). Dynamic key lookups (e.g.,
 * `t('onboarding.' + dynamic + '.foo')`) are forbidden because they
 * defeat the closed-allowlist.
 *
 * The full enumeration also satisfies the orphan-key contract: every
 * scoped catalog key MUST be referenced from at least one source file.
 * Listing every key here means the catalog and the source allowlist
 * stay in sync without forcing each component to enumerate.
 */

/* eslint-disable */
export const COPY_KEYS = Object.freeze([
  // ----- Step indicator -----
  'onboarding.step_indicator.pending',
  'onboarding.step_indicator.active',
  'onboarding.step_indicator.complete',
  'onboarding.step_indicator.step_n_of_m',

  // ----- D.1 advisory -----
  'onboarding.advisory_d1.heading',
  'onboarding.advisory_d1.body',
  'onboarding.advisory_d1.checkbox_label',
  'onboarding.advisory_d1.primary_button',
  'onboarding.advisory_d1.secondary_button',
  'onboarding.advisory_d1.fingerprint_label',
  'onboarding.advisory_d1.stop_confirm_heading',
  'onboarding.advisory_d1.stop_confirm_body',
  'onboarding.advisory_d1.show_again_label',

  // ----- D.2 hosting tradeoff / browser baseline -----
  'onboarding.browser_baseline_d2.heading',
  'onboarding.browser_baseline_d2.body_pass',
  'onboarding.browser_baseline_d2.body_fail',
  'onboarding.browser_baseline_d2.badge.webcrypto.checking',
  'onboarding.browser_baseline_d2.badge.webcrypto.pass',
  'onboarding.browser_baseline_d2.badge.webcrypto.fail',
  'onboarding.browser_baseline_d2.badge.indexeddb.checking',
  'onboarding.browser_baseline_d2.badge.indexeddb.pass',
  'onboarding.browser_baseline_d2.badge.indexeddb.fail',
  'onboarding.browser_baseline_d2.badge.service_worker.checking',
  'onboarding.browser_baseline_d2.badge.service_worker.pass',
  'onboarding.browser_baseline_d2.badge.service_worker.fail',
  'onboarding.browser_baseline_d2.badge.sab.checking',
  'onboarding.browser_baseline_d2.badge.sab.pass',
  'onboarding.browser_baseline_d2.badge.sab.fail',
  'onboarding.browser_baseline_d2.badge.locks.checking',
  'onboarding.browser_baseline_d2.badge.locks.pass',
  'onboarding.browser_baseline_d2.badge.locks.fail',
  'onboarding.browser_baseline_d2.badge.passkey.checking',
  'onboarding.browser_baseline_d2.badge.passkey.pass',
  'onboarding.browser_baseline_d2.badge.passkey.fail',
  'onboarding.browser_baseline_d2.badge.argon2id.checking',
  'onboarding.browser_baseline_d2.badge.argon2id.pass',
  'onboarding.browser_baseline_d2.badge.argon2id.fail',
  'onboarding.browser_baseline_d2.unsupported_heading',
  'onboarding.browser_baseline_d2.primary_button_pass',
  'onboarding.browser_baseline_d2.primary_button_fail',
  'onboarding.browser_baseline_d2.secondary_button_fail',
  'onboarding.browser_baseline_d2.supported_browsers_heading',
  'onboarding.browser_baseline_d2.supported_browsers_body',
  'onboarding.browser_baseline_d2.privacy_policy_link',
  'onboarding.browser_baseline_d2.error.webcrypto.unavailable',
  'onboarding.browser_baseline_d2.error.indexeddb.unavailable',
  'onboarding.browser_baseline_d2.error.service_worker.unavailable',

  // ----- D.3 passkey + TOTP -----
  'onboarding.passkey_d3.heading',
  'onboarding.passkey_d3.body',
  'onboarding.passkey_d3.totp_label',
  'onboarding.passkey_d3.totp_helper',
  'onboarding.passkey_d3.primary_button',
  'onboarding.passkey_d3.waiting_label',
  'onboarding.passkey_d3.done_label',
  'onboarding.passkey_d3.continue_button',
  'onboarding.passkey_d3.error.totp_invalid',
  'onboarding.passkey_d3.error.totp_rate_limited',
  'onboarding.passkey_d3.error.totp_locked',
  'onboarding.passkey_d3.error.passkey_ceremony_failed',
  'onboarding.passkey_d3.error.passkey_unavailable',
  'onboarding.passkey_d3.error.rp_mismatch',
  'onboarding.passkey_d3.error.enrollment_failed_generic',

  // ----- D.4 recovery passphrase -----
  'onboarding.passphrase_d4.heading',
  'onboarding.passphrase_d4.body_purpose',
  'onboarding.passphrase_d4.passphrase_label',
  'onboarding.passphrase_d4.passphrase_helper',
  'onboarding.passphrase_d4.passphrase_reveal_label',
  'onboarding.passphrase_d4.passphrase_conceal_label',
  'onboarding.passphrase_d4.confirm_label',
  'onboarding.passphrase_d4.confirm_helper',
  'onboarding.passphrase_d4.primary_button',
  'onboarding.passphrase_d4.back_button',
  'onboarding.passphrase_d4.skip_print_button',
  'onboarding.passphrase_d4.error.mismatch',
  'onboarding.passphrase_d4.error.too_short',
  'onboarding.passphrase_d4.error.too_common',
  'onboarding.passphrase_d4.error.argon2id_failed',
  'onboarding.passphrase_d4.error.argon2_unavailable',
  'onboarding.passphrase_d4.error.rate_limited',
  'onboarding.passphrase_d4.print_link',
  'onboarding.passphrase_d4.print_modal_heading',
  'onboarding.passphrase_d4.print_modal_body',
  'onboarding.passphrase_d4.print_modal_confirm',
  'onboarding.passphrase_d4.print_modal_cancel',
  'onboarding.passphrase_d4.show_again_label',
  'onboarding.passphrase_d4.show_again_helper',
  'onboarding.passphrase_d4.show_again_capped',
  'onboarding.passphrase_d4.download_label',
  'onboarding.passphrase_d4.download_helper',
  'onboarding.passphrase_d4.download_preparing',
  'onboarding.passphrase_d4.download_done_label',
  'onboarding.passphrase_d4.download_error_toast',

  // ----- D.5 sessions primer -----
  'onboarding.sessions_d5.heading',
  'onboarding.sessions_d5.body',
  'onboarding.sessions_d5.helper',
  'onboarding.sessions_d5.helper_only_this_device',
  'onboarding.sessions_d5.revoke_other.label',
  'onboarding.sessions_d5.skip.label',
  'onboarding.sessions_d5.state.ready_delay',
  'onboarding.sessions_d5.state.in_progress',
  'onboarding.sessions_d5.state.partial_failure',
  'onboarding.sessions_d5.state.success',
  'onboarding.sessions_d5.error.rate_limited',
  'onboarding.sessions_d5.error.server_unreachable',
  'onboarding.sessions_d5.error.partial',
  'onboarding.sessions_d5.row.this_device_label',
  'onboarding.sessions_d5.row.last_seen_label',

  // ----- D.6 panic-wipe -----
  'onboarding.panic_wipe_d6.trigger_button',
  'onboarding.panic_wipe_d6.modal_heading',
  'onboarding.panic_wipe_d6.modal_body_what_happens',
  'onboarding.panic_wipe_d6.modal_body_what_doesnt',
  'onboarding.panic_wipe_d6.modal_residual_risk_callout',
  'onboarding.panic_wipe_d6.modal_recovery_reminder',
  'onboarding.panic_wipe_d6.type_back_label',
  'onboarding.panic_wipe_d6.type_back_value',
  'onboarding.panic_wipe_d6.type_back_helper',
  'onboarding.panic_wipe_d6.type_back_placeholder',
  'onboarding.panic_wipe_d6.primary_button_destructive',
  'onboarding.panic_wipe_d6.cancel_button',
  'onboarding.panic_wipe_d6.state.confirming',
  'onboarding.panic_wipe_d6.state.wiping',
  'onboarding.panic_wipe_d6.state.complete',
  'onboarding.panic_wipe_d6.error.type_back_mismatch',
  'onboarding.panic_wipe_d6.error.audit_emit_failed',
  'onboarding.panic_wipe_d6.error.partial_wipe',
  'onboarding.panic_wipe_d6.error.already_wiped',
  'onboarding.panic_wipe_d6.completion_heading',
  'onboarding.panic_wipe_d6.completion_body',
  'onboarding.panic_wipe_d6.completion_next_steps',

  // ----- D.7 completion -----
  'onboarding.completion_d7.heading',
  'onboarding.completion_d7.body',
  'onboarding.completion_d7.checklist.passkey',
  'onboarding.completion_d7.checklist.recovery_blob_downloaded',
  'onboarding.completion_d7.checklist.recovery_blob_printed',
  'onboarding.completion_d7.checklist.sessions_reviewed',
  'onboarding.completion_d7.next_steps_heading',
  'onboarding.completion_d7.next_steps_body',
  'onboarding.completion_d7.primary_button',

  // ----- show_again (root catalog co-located) -----
  'onboarding.show_again.remind_me_next_time_label',
  'onboarding.show_again.dont_show_again_label',

  // ----- a11y namespace -----
  'a11y.onboarding.step_change',
  'a11y.onboarding.wizard_landmark',
  'a11y.onboarding.passphrase_field_announcement',
  'a11y.onboarding.reveal_button_announcement',
  'a11y.onboarding.reveal_in_progress_announcement',
  'a11y.onboarding.reveal_hidden_announcement',
  'a11y.onboarding.reveal_capped_announcement',
  'a11y.onboarding.modal_open_announcement',
  'a11y.onboarding.modal_close_announcement',
  'a11y.onboarding.destructive_confirm_announcement',
  'a11y.onboarding.panic_wipe_in_progress_announcement',
  'a11y.onboarding.panic_wipe_complete_announcement',
  'a11y.onboarding.panic_wipe_partial_failure_announcement',
  'a11y.onboarding.session_revoked_announcement',
  'a11y.onboarding.browser_baseline_pass_announcement',
  'a11y.onboarding.browser_baseline_fail_announcement',
  'a11y.onboarding.step_loading_announcement',
  'a11y.onboarding.step_error_announcement',
  'a11y.onboarding.device_fingerprint_announcement'
] as const);

export type CopyKey = (typeof COPY_KEYS)[number];
