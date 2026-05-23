/**
 * Backup library (T17; library-only per ADR-0002 Amendment H).
 *
 * Public surface only — test-only override hooks are reachable ONLY via
 * deep-import (T11/T12 F-1 BLOCK lesson; mirrors T16's pattern). The barrel
 * deliberately omits:
 *   - `MemoryBackupStore` (deep-import from `./memory-backup-store`)
 *   - `TestBackupStore`   (deep-import from `./memory-backup-store`)
 *   - `__debug*` / `__force*` / `__set*` / `__insert*` / `__advance*` hooks
 *     (live on `MemoryBackupStore`; reachable only via deep-import)
 *   - `runBackupTablesDriftCheck` (deep-import from `./backup-tables`)
 *
 * Production callers consume:
 *   - `runBackupPass(opts)` — the single entry point (ADR-0018 §5).
 *   - `runBackupRetentionPass(opts)` — the explicit hard-delete pass.
 *   - `BackupStore` interface — SupabaseBackupStore (T17.1) implements this;
 *     the library calls only its closed allowlist.
 *   - Closed-allowlist constants — `BACKUP_TABLES`, `BACKUP_OBJECT_LOCK_DAYS`,
 *     `BACKUP_HARD_DELETE_DAYS`.
 *   - Type aliases — `BackupTable`, `BackupManifest`, `BackupManifestStatus`,
 *     `BackupPassConfig`, `BackupPassResult`, `BackupRetentionPassConfig`,
 *     `BackupRetentionPassResult`, `BackupPassErrorCode`.
 */

export type {
  BackupAuditLogHead,
  BackupManifest,
  BackupManifestStatus,
  BackupPassConfig,
  BackupPassErrorCode,
  BackupPassResult,
  BackupRetentionErrorCode,
  BackupRetentionPassConfig,
  BackupRetentionPassResult,
  BackupTable
} from './types';

export {
  BACKUP_HARD_DELETE_DAYS,
  BACKUP_OBJECT_LOCK_DAYS,
  BACKUP_OBJECT_REF_PREFIX,
  BACKUP_DEFAULT_LEASE_WINDOW_MS
} from './types';

export { BACKUP_TABLES } from './backup-tables';

export type {
  BackupDeleteResult,
  BackupDumpSnapshot,
  BackupManifestPendingInput,
  BackupManifestWrittenAuditRow,
  BackupPutResult,
  BackupStore,
  BackupUploadRejectionReason,
  CommittedManifestSummary
} from './backup-store';

export { runBackupPass, runBackupRetentionPass } from './backup-core';
export type { RunBackupPassOpts, RunBackupRetentionPassOpts } from './backup-core';
