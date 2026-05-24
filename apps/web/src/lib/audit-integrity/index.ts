/**
 * Audit-integrity library (T18; library-only per ADR-0002 Amendment H).
 *
 * Public surface only — test-only override hooks are reachable ONLY via
 * deep-import (T11/T12 F-1 BLOCK lesson; mirrors T16/T17). The barrel
 * deliberately omits:
 *   - `MemoryIntegrityStore` (deep-import from `./memory-integrity-store`)
 *   - `TestIntegrityStore`   (deep-import from `./memory-integrity-store`)
 *   - `__debug*` / `__force*` / `__set*` hooks (live on `MemoryIntegrityStore`;
 *     reachable only via deep-import)
 *   - `runIntegrityEventTypesDriftCheck` (deep-import from `./integrity-event-types`)
 *   - `__assertIntegrityEventTypeExhaustive`
 *
 * Production callers consume:
 *   - `runIntegrityCheck(opts)` — the SOLE entry point for a pass.
 *   - `runWeeklyChainAnchor(opts)` — the weekly anchor emission.
 *   - `IntegrityStore` interface — SupabaseIntegrityStore (T18.1) implements
 *     this; the library calls only its closed allowlist.
 *   - Closed-allowlist constants — `INTEGRITY_CHECK_EVENT_TYPES`,
 *     `INTEGRITY_MAX_ROWS_PER_PASS`, `INTEGRITY_CHAIN_WALK_BATCH_SIZE`,
 *     `INTEGRITY_DEFAULT_LEASE_WINDOW_MS`, `INTEGRITY_BACKUP_DIFF_BUFFER_MS`,
 *     `INTEGRITY_MS_PER_HOUR`, `INTEGRITY_MS_PER_MINUTE`.
 *   - Type aliases — `IntegrityCheckEventType`, `IntegrityCheckTrigger`,
 *     `IntegrityCheckRunConfig`, `IntegrityRunResult`, `IntegrityAnchorResult`,
 *     `IntegrityErrorCode`, `IntegrityAlertSymbol`.
 */

export type {
  AuditChainRowMaterialized,
  BackupManifestSnapshot,
  IntegrityAlertSymbol,
  IntegrityAnchorErrorCode,
  IntegrityAnchorResult,
  IntegrityCheckEventType,
  IntegrityCheckRunConfig,
  IntegrityCheckRunRow,
  IntegrityCheckTrigger,
  IntegrityErrorCode,
  IntegrityMismatchMeta,
  IntegrityNodeRuntimePin,
  IntegrityRunResult,
  RetentionSweepRunSnapshot
} from './types';

export {
  INTEGRITY_BACKUP_DIFF_BUFFER_MS,
  INTEGRITY_CHAIN_WALK_BATCH_SIZE,
  INTEGRITY_DEFAULT_LEASE_WINDOW_MS,
  INTEGRITY_MAX_ROWS_PER_PASS,
  INTEGRITY_MS_PER_HOUR,
  INTEGRITY_MS_PER_MINUTE,
  INTEGRITY_MS_PER_SECOND
} from './types';

export { INTEGRITY_CHECK_EVENT_TYPES } from './integrity-event-types';

export type { IntegrityStore } from './integrity-store';

export { runIntegrityCheck, runWeeklyChainAnchor } from './integrity-core';
export type { RunIntegrityCheckOpts, RunWeeklyChainAnchorOpts } from './integrity-core';
