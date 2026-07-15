/**
 * Shared safeFields allowlist — browser + edge surfaces import from here.
 *
 * Source of truth: observability/logging.md §3.
 *
 * Adding a key here requires the same PR to amend logging.md §3 and (where
 * a new attribute crosses a data-classification boundary) the PI inventory
 * in `.context/decisions.md`.
 *
 * The allowlist is a closed set; anything not on it is dropped at emit
 * (logging.md §2 forbidden-fields rule).
 */

export const SAFE_FIELDS: ReadonlySet<string> = new Set([
  // Universal
  'route',
  'outcome',
  'latency_ms',
  'attempt',
  'rate_limit_key_class',
  'feature_flag',
  'release',

  // Auth (T05)
  'auth.method',
  'auth.result',
  'auth.totp_consumed',
  'auth.session_id_pseudonym',
  // ADR-0023 Amendment A / F-128: mint-session race-loss detector. The
  // value is a closed-set literal ('mismatch' | 'ok'); no PI surface.
  'auth.mint.outcome',
  // ADR-0024 §2: cold-start HMAC pseudonym key parity check outcome.
  // The value is a closed-set literal ('mismatch' | 'ok'); the actual
  // SHA values NEVER appear in any log emission (verify-no-sha-in-logs.sh
  // enforces this structurally).
  'key_parity.outcome',
  'key_parity.surface', // 'cold_start' | 'deploy_time' — never the SHA

  // Audit-log echo
  'audit.event_type',
  'audit.target_class',
  'audit.target_id_pseudonym',
  'audit.rotation_id',

  // Concern intake (T08)
  'concern.action',
  'concern.anonymous_default',
  'concern.hazard_class',
  'concern.severity',

  // Inspections / sync (T10)
  'sync.entries_drained',
  'sync.entries_rejected_hmac_fail',
  'sync.queue_depth',
  'cache.policy_violation',
  'cache.allowlist_version',

  // Export (T11 / T12)
  'export.kind',
  'export.field_set_hash',
  'export.derived_from_concerns_count',
  'export.recipient_role',

  // Reprisal / C4 reads (T13 / T14)
  'c4.table',
  'c4.read_via',
  'c4.access_attempt_outcome',

  // Retention (T16)
  'retention.table',
  'retention.deleted_count',
  'retention.dry_run',

  // Audit-log integrity (T18)
  'integrity.last_good_seq',
  'integrity.first_bad_seq',
  'integrity.trigger',

  // Backup / drift (T17)
  'backup.bucket',
  'backup.age_hours',
  'drift.field',
  'drift.expected',
  'drift.observed',

  // M9 alert dispatch (lib/alerts).
  'alert.symbol',
  'alert.severity',
  'alert.source',
  'alert.ts_ms',
  'alert.run_id',
  'alert.outcome',
  'alert.would_delete_total',
  'alert.deleted_total',
  'alert.deleted_count',

  // Baseline multi-epoch anti-lockout read miss (F182-9 / ADR-0031 Decision 5 /
  // F-183-B-OBS). Key-material-FREE telemetry ONLY — a COUNT of held epochs +
  // two booleans that separate a benign missing-epoch boundary from a genuine
  // corrupt/tampered row. NEVER a key_id VALUE, key bytes, or plaintext (F-148).
  'epochs_held',
  'escalated',
  'row_epoch_held'
]);

/**
 * Stable identifier for the allowlist. Both browser and edge surfaces
 * expose the same id so a structural drift test can prove a single source
 * of truth (per logging.md §3).
 *
 * The value is a content hash of the sorted keys at module load. It MUST
 * be stable across browser + edge runtimes; both import this file.
 */
function computeAllowlistId(): string {
  const sorted = [...SAFE_FIELDS].sort();
  // Tiny, deterministic FNV-1a-shaped hash. Not cryptographic — just a
  // structural fingerprint.
  let h = 0x811c9dc5;
  for (const k of sorted) {
    for (let i = 0; i < k.length; i++) {
      h ^= k.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return `safe-fields/v1/${h.toString(16).padStart(8, '0')}`;
}

export const SAFE_FIELDS_ALLOWLIST_ID = computeAllowlistId();

/**
 * Closed denylist that MUST be silently dropped at emit (logging.md §2).
 * Defense in depth: even if SAFE_FIELDS expands to accidentally include
 * one of these, the deny path wins.
 */
export const PI_DENYLIST: ReadonlySet<string> = new Set([
  'display_name',
  'displayname',
  'off_employer_contact',
  'email',
  'phone',
  'phone_number',
  'contact',
  'address',
  'home_address',
  'cookie',
  'set-cookie',
  'authorization',
  'jwt',
  'access_token',
  'refresh_token',
  'totp',
  'totp_code',
  'totp_secret',
  'passkey',
  'passkey_assertion',
  'webauthn_response',
  'webauthn_credential',
  'api_key',
  'apikey',
  'session_token',
  'csrf_token',
  'password',
  'recovery_passphrase',
  'recovery_blob',
  'user_id',
  'user_uuid',
  'supabase_uid',
  'auth_uid',
  'sub',
  'body',
  'payload',
  'form',
  'form_data',
  'formdata',
  'req_body',
  'request_body',
  'message',
  // C3/C4 ciphertext column names
  'title_ct',
  'title_ciphertext',
  'body_ct',
  'body_ciphertext',
  'notes_ct',
  'notes_ciphertext',
  'draft_body_ct',
  'draft_body_ciphertext',
  'final_body_ct',
  'final_body_ciphertext',
  'employer_response_ct',
  'employer_response_ciphertext',
  'source_name_ct',
  'source_name_ciphertext',
  'reprisal_body_ct',
  'reprisal_body_ciphertext',
  'work_refusal_notes_ct',
  'work_refusal_notes_ciphertext',
  's51_evidence_ct',
  's51_evidence_ciphertext',
  's51_photo_ct',
  'evidence_ct',
  'evidence_ciphertext'
]);
