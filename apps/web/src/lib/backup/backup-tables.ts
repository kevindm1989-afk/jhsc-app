/**
 * Frozen `BACKUP_TABLES` closed-allowlist + drift check (T17; F-70).
 *
 * The const is `Object.freeze([...] as const) satisfies readonly BackupTable[]`
 * so its element type IS the `BackupTable` union by construction; the runtime
 * set-equality assertion runs against the canonical enum keys list below.
 *
 * `runBackupTablesDriftCheck` accepts an `__overrideForTest` deep-import-only
 * hook so the test file can inject a mutated copy without touching production
 * state (mirrors T16's `__setScheduleOverrideForTest` lineage).
 *
 * Source: ADR-0018 §2/§3; threat-model §3.10 F-70.
 */

import type { BackupTable } from './types';

/**
 * Closed-allowlist of backup-target tables. Verbatim from ADR-0018 §2.
 *
 * `Object.freeze` is the runtime defense against the F-19 spread-then-mutate
 * attack — assigning into `BACKUP_TABLES[0]` throws under strict mode.
 */
export const BACKUP_TABLES = Object.freeze([
  'audit_log',
  'audit_log_retention_schedule',
  'committee_data_keys',
  'committee_key_wraps',
  'committee_key_wraps_history',
  'concerns',
  'identity_keys',
  'inspection_photos',
  'inspections',
  'members',
  'minutes_final',
  'recommendations',
  'recovery_blob_resets',
  'recovery_blobs',
  'reprisal_log',
  'retention_sweep_runs',
  's51_evidence',
  'training_records',
  'work_refusal'
] as const) satisfies readonly BackupTable[];

/**
 * Canonical enum-key list — the union side of the set-equality check. Any
 * future addition to the `BackupTable` union MUST add the matching entry to
 * this list (and to `BACKUP_TABLES` above). The drift check fails CI on any
 * single-mirror update.
 */
const BACKUP_TABLE_KEYS_RUNTIME: readonly BackupTable[] = [
  'audit_log',
  'audit_log_retention_schedule',
  'committee_data_keys',
  'committee_key_wraps',
  'committee_key_wraps_history',
  'concerns',
  'identity_keys',
  'inspection_photos',
  'inspections',
  'members',
  'minutes_final',
  'recommendations',
  'recovery_blob_resets',
  'recovery_blobs',
  'reprisal_log',
  'retention_sweep_runs',
  's51_evidence',
  'training_records',
  'work_refusal'
];

/**
 * Structured drift verdict. `missing` names entries present in the
 * `BackupTable` enum but absent from the (possibly-overridden) allowlist;
 * `orphan` names entries present in the allowlist but absent from the enum.
 *
 * The arrays are mutable on the type signature so the test contract's
 * structural cast `(verdict as {missing?: string[]}).missing` succeeds. The
 * runtime arrays are freshly constructed on every call, so mutation does not
 * affect any stored state.
 */
export interface BackupTablesDriftVerdict {
  readonly ok: boolean;
  readonly missing: string[];
  readonly orphan: string[];
}

export interface RunBackupTablesDriftCheckOpts {
  /**
   * Test-only override — deep-import surface; never re-exported from the
   * public barrel. Pass a mutated readonly copy to assert the drift check
   * names the difference.
   */
  readonly __overrideForTest?: readonly string[];
}

/**
 * Set-equality check between the enum and the (possibly-overridden) allowlist.
 * Returns a structured verdict whose error lists name the drifted entries so
 * CI can print a useful diagnostic.
 */
export function runBackupTablesDriftCheck(
  opts?: RunBackupTablesDriftCheckOpts
): BackupTablesDriftVerdict {
  const liveList =
    opts?.__overrideForTest !== undefined
      ? opts.__overrideForTest
      : (BACKUP_TABLES as readonly string[]);
  const liveSet = new Set<string>(liveList);
  const enumSet = new Set<string>(BACKUP_TABLE_KEYS_RUNTIME);

  const missing: string[] = [];
  for (const k of enumSet) {
    if (!liveSet.has(k)) missing.push(k);
  }
  const orphan: string[] = [];
  for (const k of liveSet) {
    if (!enumSet.has(k)) orphan.push(k);
  }
  return {
    ok: missing.length === 0 && orphan.length === 0,
    missing,
    orphan
  };
}

/**
 * Compile-time exhaustiveness anchor. Calling this with `t: never` is the
 * closed-switch terminator pattern (mirrors T16's
 * `__assertEventTypeExhaustive`). Adding a new entry to `BackupTable`
 * without a matching switch branch fails type-check.
 */
export function __assertBackupTableExhaustive(t: never): never {
  throw new Error(`closed enum exhausted by unexpected value: ${String(t)}`);
}
