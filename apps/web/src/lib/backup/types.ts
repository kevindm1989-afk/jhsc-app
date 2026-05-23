/**
 * Backup library types (T17; library-only per ADR-0002 Amendment H).
 *
 * Closed enum + discriminated unions per ADR-0018 §2/§5/§7/§11. The library
 * never accepts a caller-supplied predicate, table list, object_ref, or lock
 * duration; the closed `BACKUP_TABLES` allowlist + the library-controlled
 * `BACKUP_OBJECT_LOCK_DAYS` constant are the only inputs (F-19/F-84 lineage).
 *
 * Source obligations (threat-model §3.10): F-70..F-85.
 */

/**
 * Closed `BackupTable` enum — verbatim from ADR-0018 §2 (alphabetized).
 *
 * Set-equality with `BACKUP_TABLES` const enforced by
 * `runBackupTablesDriftCheck` (F-70).
 */
export type BackupTable =
  | 'audit_log'
  | 'audit_log_retention_schedule'
  | 'committee_data_keys'
  | 'committee_key_wraps'
  | 'committee_key_wraps_history'
  | 'concerns'
  | 'identity_keys'
  | 'inspection_photos'
  | 'inspections'
  | 'members'
  | 'minutes_final'
  | 'recommendations'
  | 'recovery_blob_resets'
  | 'recovery_blobs'
  | 'reprisal_log'
  | 'retention_sweep_runs'
  | 's51_evidence'
  | 'training_records'
  | 'work_refusal';

/**
 * Head pointer on a committed manifest (RA-2 trigger #3 join surface).
 * Triple is structurally exact — no additional fields per F-83.
 */
export interface BackupAuditLogHead {
  readonly id: string;
  readonly ts_ms: number;
  readonly hash: string;
}

/**
 * Manifest status discriminator (ADR-0018 §7).
 *
 * `pending` -> `committed` is the happy path (F-72).
 * `pending` -> `aborted_*` on upload failure (F-72 + F-82).
 * `committed` -> `hard_deleted` on age-out (F-74).
 */
export type BackupManifestStatus =
  | 'pending'
  | 'committed'
  | 'aborted_upload_failed'
  | 'aborted_object_lock_policy_rejected'
  | 'aborted_cross_region_destination_refused'
  | 'aborted_unknown_storage_error'
  | 'hard_deleted';

/**
 * One row per backup pass — ADR-0018 §7 layout.
 *
 * Field names are LOAD-BEARING per F-83 (snapshot-pinned). A future rename
 * fails CI before merge.
 *
 * G-T16-PRIV-7: no pseudonym fields at any level (F-80 structural seal).
 */
export interface BackupManifest {
  readonly run_id: string;
  readonly status: BackupManifestStatus;
  readonly started_at_ms: number;
  readonly committed_at_ms: number | null;
  readonly finalized_at_ms: number | null;
  readonly hard_deleted_at_ms: number | null;
  readonly object_ref: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly retention_class: '42d';
  readonly lock_until_ms: number;
  readonly committee_data_key_kid: string;
  readonly audit_log_head: BackupAuditLogHead | null;
  readonly per_table_row_counts: Readonly<Record<string, number>>;
  readonly per_event_row_counts: Readonly<Record<string, number>>;
  readonly retention_sweep_runs_snapshot_ts_ms: number;
  /** SHA-256 of the live `RETENTION_SCHEDULE` + `OPERATIONAL_TABLE_SCHEDULE`
   *  at pass-start; lets T18 attribute legitimate schedule drift across the
   *  reconciliation join (ADR-0018 §7). */
  readonly schedule_hash: string;
  /** Node + OpenSSL versions at pass-start; the hash-determinism toolchain
   *  anchor (G-T11-23 lineage; F-78 test obligation per threat-model §3.10). */
  readonly node_runtime_pin: BackupNodeRuntimePin;
}

export interface BackupNodeRuntimePin {
  readonly node_version: string;
  readonly openssl_version: string;
}

/**
 * Pass-level configuration consumed by `runBackupPass`.
 *
 * Deliberately narrow per ADR-0018 §11 + F-84:
 *   - NO `object_ref` field — library derives from run_id.
 *   - NO `table_list` field — library uses `BACKUP_TABLES` exclusively.
 *   - NO `lock_duration_ms` field — library uses `BACKUP_OBJECT_LOCK_DAYS`.
 *
 * The poisoned-config fixture asserts adding any of these fails tsc.
 * `exactOptionalPropertyTypes: true` in tsconfig is what makes the
 * excess-property check fire on the @ts-expect-error directives.
 */
export interface BackupPassConfig {
  /** Default: false. Dry-run mode computes manifest shape but skips upload. */
  readonly dry_run?: boolean;
  /** Default: BACKUP_DEFAULT_LEASE_WINDOW_MS. Lease guard window (F-59 mirror). */
  readonly lease_window_ms?: number;
}

/**
 * Retention-pass configuration. Library-controlled; no caller-supplied cutoffs.
 */
export interface BackupRetentionPassConfig {
  /** Default: false. Dry-run mode computes candidates but performs no deletes. */
  readonly dry_run?: boolean;
}

/**
 * Closed literal union of error_codes (F-82). A random string fails tsc when
 * compared to `BackupPassResult.errored.error_code`.
 */
export type BackupPassErrorCode =
  | 'backup_upload_failed'
  | 'object_lock_policy_rejected'
  | 'cross_region_destination_refused'
  | 'manifest_write_failed'
  | 'head_pointer_failed'
  | 'kid_lookup_failed'
  | 'dump_failed'
  | 'lease_check_failed'
  | 'transition_failed'
  | 'audit_emit_failed';

/**
 * Result discriminated union for `runBackupPass` (F-65 pattern; F-82 closed).
 */
export type BackupPassResult =
  | {
      readonly status: 'completed';
      readonly run_id: string;
      readonly manifest_ref: string;
    }
  | {
      readonly status: 'skipped';
      readonly reason: 'pass_already_in_window';
    }
  | {
      readonly status: 'dry_run';
      readonly run_id: string;
    }
  | {
      readonly status: 'errored';
      readonly run_id: string;
      readonly error_code: BackupPassErrorCode;
    };

/**
 * Closed literal union of retention-pass error codes.
 */
export type BackupRetentionErrorCode = 'retention_delete_failed' | 'retention_list_failed';

/**
 * Result discriminated union for `runBackupRetentionPass`. The
 * `would_fire_alert` symbol surfaces the F-75 still-locked-past-window
 * structural condition; the actual alert sink wires in T17.1.
 */
export type BackupRetentionPassResult =
  | {
      readonly status: 'completed';
      readonly deleted_count: number;
      readonly would_fire_alert?: 'A-BACKUP-001';
    }
  | {
      readonly status: 'dry_run';
      readonly would_delete_count: number;
    }
  | {
      readonly status: 'errored';
      readonly error_code: BackupRetentionErrorCode;
    };

/** ms-per constants used by lock-window arithmetic (no magic numbers). */
export const BACKUP_MS_PER_SECOND = 1000;
export const BACKUP_MS_PER_MINUTE = 60 * BACKUP_MS_PER_SECOND;
export const BACKUP_MS_PER_HOUR = 60 * BACKUP_MS_PER_MINUTE;
export const BACKUP_MS_PER_DAY = 24 * BACKUP_MS_PER_HOUR;

/**
 * Object-lock window (ADR-0018 §6 + §J; ADR-0012 amendment HG-8).
 *
 * Library uses this constant exclusively. No caller-supplied lock duration
 * (cooperative-caller defense; F-71 + F-84).
 */
export const BACKUP_OBJECT_LOCK_DAYS = 42;

/**
 * Hard-delete-at-age-out window. Mirrors BACKUP_OBJECT_LOCK_DAYS per
 * ADR-0018 §J — three-mirror coordination required to change.
 */
export const BACKUP_HARD_DELETE_DAYS = 42;

/** Default lease window — backup pass is heavier than retention pass. */
export const BACKUP_DEFAULT_LEASE_WINDOW_MS = 30 * BACKUP_MS_PER_MINUTE;

/** Structural prefix for derived object_ref (F-84; no caller-supplied paths). */
export const BACKUP_OBJECT_REF_PREFIX = 'backups';

/** Clock floor for monotonic nowMs() advance (mirrors T16 NOW_MS_MIN_INCREMENT). */
export const BACKUP_NOW_MS_MIN_INCREMENT = 1;
