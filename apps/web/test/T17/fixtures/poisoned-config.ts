/**
 * T17 — F-84 poisoned-config fixture (compile-time fail surface).
 *
 * Scope: this file is the type-level half of F-84 (no caller-supplied
 * `object_ref` / `table_list` / `lock_duration_ms` on `BackupPassConfig`).
 * It is INTENTIONALLY structured so that `tsc --noEmit` against this file
 * fails with an `excess property` error on each of the three forbidden
 * fields. The `@ts-expect-error` directives below are LOAD-BEARING — if the
 * implementer ever widens `BackupPassConfig` to surface any of these
 * fields, the suppression directive becomes unused and tsc fails the build
 * (which is the F-84 signal).
 *
 * Source obligations:
 *   - ADR-0018 §11 — BackupPassConfig deliberately omits lock_duration_ms,
 *     object_ref, and table_list.
 *   - ADR-0018 §6 — cooperative-caller defense: library uses
 *     BACKUP_OBJECT_LOCK_DAYS exclusively; caller cannot weaken the lock.
 *   - threat-model §3.10 F-84 — "TypeScript-level assertion + runtime test
 *     that constructing a BackupPassConfig with these fields type-errors."
 *   - threat-model §3.10 cross-cutting property (a) — "No caller-supplied
 *     `object_ref` / `table_list` / `lock_duration_ms` compiles."
 *
 * This file is NEVER imported at runtime by the test suite — it lives in
 * the test build path so `tsc --noEmit` includes it, but its only purpose
 * is to assert the three forbidden fields fail compile.
 *
 * The implementer MUST keep `BackupPassConfig` narrow per ADR-0018 §11.
 * Adding any of `object_ref`, `table_list`, or `lock_duration_ms` re-opens
 * F-84 and ADR-0018 simultaneously.
 */

import type { BackupPassConfig } from '../../../src/lib/backup';

// ---------------------------------------------------------------------------
// (1) Forbidden field: lock_duration_ms
//     Cooperative-caller defense — library derives lock duration from
//     BACKUP_OBJECT_LOCK_DAYS exclusively. A caller-supplied value would
//     allow weakening the lock window below 42d.
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_LOCK_DURATION: BackupPassConfig = {
  dry_run: false,
  // @ts-expect-error — F-84: BackupPassConfig MUST NOT surface lock_duration_ms.
  lock_duration_ms: 1000
};

// ---------------------------------------------------------------------------
// (2) Forbidden field: object_ref
//     Library derives object_ref structurally from
//     (BACKUP_OBJECT_REF_PREFIX, manifest.run_id, manifest.committed_at_ms).
//     A caller-supplied path could target a destination outside the
//     backup namespace.
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_OBJECT_REF: BackupPassConfig = {
  dry_run: false,
  // @ts-expect-error — F-84: BackupPassConfig MUST NOT surface object_ref.
  object_ref: 'attacker-controlled/path/evil.dump'
};

// ---------------------------------------------------------------------------
// (3) Forbidden field: table_list
//     Library uses the closed `BACKUP_TABLES` allowlist exclusively. A
//     caller-supplied list could expand the dump scope (exfil) or contract
//     it (drop a target table, making RA-2 trigger #3 fire on the next
//     reconciliation because the head-pointer would not match the live
//     chain).
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_TABLE_LIST: BackupPassConfig = {
  dry_run: false,
  // @ts-expect-error — F-84: BackupPassConfig MUST NOT surface table_list.
  table_list: ['audit_log']
};

// ---------------------------------------------------------------------------
// (4) Composite poisoning — all three at once. The compiler must reject
//     EACH field on its own; this asserts no field is conditionally
//     allowed when paired with the others.
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_ALL: BackupPassConfig = {
  dry_run: false,
  // @ts-expect-error — F-84: lock_duration_ms forbidden.
  lock_duration_ms: 86400000,
  // @ts-expect-error — F-84: object_ref forbidden.
  object_ref: 'rogue/path',
  // @ts-expect-error — F-84: table_list forbidden.
  table_list: ['audit_log', 'concerns']
};
