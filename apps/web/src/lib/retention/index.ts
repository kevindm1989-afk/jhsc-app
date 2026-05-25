/**
 * Retention library (T16; library-only per ADR-0002 Amendment H).
 *
 * Public surface only — test-only override hooks are reachable ONLY via
 * deep-import (T11/T12 F-1 BLOCK lesson). The barrel deliberately omits:
 *   - `__setScheduleOverrideForTest`
 *   - `__resetScheduleOverrideForTest`
 *   - `MemoryRetentionStore` (deep-import from `./memory-retention-store`)
 *   - `TestRetentionStore`         (deep-import from `./memory-retention-store`)
 *   - `__debug*` / `__force*` hooks (live on `MemoryRetentionStore`)
 *
 * Production callers consume:
 *   - `runRetentionPass(opts)` — the single entry point (ADR-0017 §6).
 *   - `RetentionStore` interface — the SupabaseRetentionStore in T16.1
 *     implements this; the library calls only its closed allowlist.
 *   - Closed-allowlist constants — `RETENTION_SCHEDULE`,
 *     `OPERATIONAL_TABLE_SCHEDULE`.
 *   - Type aliases — `RetentionEventType`, `RetentionPassResult`,
 *     `RetentionPassConfig`.
 */

export type {
  RetentionEventType,
  RetentionPassConfig,
  RetentionPassResult,
  RetentionScheduleEntry,
  OperationalTableScheduleEntry
} from './types';

export {
  DEFAULT_ALARM_THRESHOLD,
  DEFAULT_LEASE_WINDOW_MS,
  DEFAULT_MAX_TOTAL_ROWS_PER_PASS,
  UNDERLYING_RECORD_CEILING_DAYS
} from './types';

export { RETENTION_SCHEDULE, OPERATIONAL_TABLE_SCHEDULE, computeScheduleHash } from './schedule';

export type {
  RetentionStore,
  DeleteBatchResult,
  RetentionDeletedAuditRow
} from './retention-store';

export { runRetentionPass } from './retention-core';
export type { RunRetentionPassOpts } from './retention-core';
