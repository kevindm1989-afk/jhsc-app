/**
 * T18 — F-97 poisoned-config fixture (compile-time fail surface).
 *
 * Scope: this file is the TYPE-LEVEL half of F-97 (no caller-supplied
 * `predicate` / `where` / `pivot` / `row_range` / `start_id` / `end_id` /
 * `table_name` / `backup_manifest_id` / `runtime_pin` / `max_rows` /
 * `batch_size` on `IntegrityCheckRunConfig`). It is INTENTIONALLY structured
 * so that `tsc --noEmit` against this file fails with an `excess property`
 * error on each of the eleven forbidden fields. The `@ts-expect-error`
 * directives below are LOAD-BEARING — if the implementer ever widens
 * `IntegrityCheckRunConfig` to surface any of these fields, the suppression
 * directive becomes unused and tsc fails the build (which is the F-97
 * signal).
 *
 * Source obligations:
 *   - ADR-0019 Decision §6 + §11 — `IntegrityCheckRunConfig` deliberately
 *     omits caller-supplied predicate / WHERE / pivot / row-range /
 *     runtime_pin / backup_manifest_id / table_name / max_rows / batch_size.
 *   - threat-model §3.11 F-97 — "`IntegrityCheckRunConfig` has no field whose
 *     name matches /predicate|where|pivot|row_range|start_id|end_id|
 *     table_name|backup_manifest_id|runtime_pin/i".
 *   - threat-model §3.11 cross-cutting property (a) — "No caller-supplied
 *     predicate / pivot / WHERE compiles."
 *   - F-19 lineage (T11/T12 + T16 + T17 + ADR-0018 F-84 mirror).
 *
 * This file is NEVER imported at runtime by the test suite — it lives in
 * the test build path so `tsc --noEmit` includes it, but its only purpose
 * is to assert the eleven forbidden fields fail compile.
 *
 * The implementer MUST keep `IntegrityCheckRunConfig` narrow per ADR-0019
 * §6 + §11. Adding any of the forbidden fields re-opens F-97 and ADR-0019
 * simultaneously, and re-opens RA-2 trigger #3 reasoning (per ADR-0019
 * §Reversibility — cooperative-caller defense removal).
 */

import type { IntegrityCheckRunConfig } from '../../../src/lib/audit-integrity';

// ---------------------------------------------------------------------------
// (1) Forbidden field: predicate
//     Cooperative-caller defense — library hard-codes the closed allowlist
//     of integrity-check inputs. A caller-supplied predicate could scope
//     the chain walk to skip a tamper.
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_PREDICATE: IntegrityCheckRunConfig = {
  trigger: 'scheduled',
  // @ts-expect-error — F-97: IntegrityCheckRunConfig MUST NOT surface `predicate`.
  predicate: 'id < 100'
};

// ---------------------------------------------------------------------------
// (2) Forbidden field: where
//     Same rationale as predicate — caller-supplied WHERE fragment opens an
//     injection + scoping bypass surface.
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_WHERE: IntegrityCheckRunConfig = {
  trigger: 'scheduled',
  // @ts-expect-error — F-97: IntegrityCheckRunConfig MUST NOT surface `where`.
  where: "event_type = 'concern.created'"
};

// ---------------------------------------------------------------------------
// (3) Forbidden field: pivot
//     The pivot-rewrite attack class IS the F-91 detection surface — a
//     caller-supplied pivot would let an adversary scope the walk to skip
//     the pivot id.
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_PIVOT: IntegrityCheckRunConfig = {
  trigger: 'scheduled',
  // @ts-expect-error — F-97: IntegrityCheckRunConfig MUST NOT surface `pivot`.
  pivot: '42'
};

// ---------------------------------------------------------------------------
// (4) Forbidden field: row_range
//     Scoping the walk to a narrow window defeats both detection surfaces.
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_ROW_RANGE: IntegrityCheckRunConfig = {
  trigger: 'scheduled',
  // @ts-expect-error — F-97: IntegrityCheckRunConfig MUST NOT surface `row_range`.
  row_range: [10, 50]
};

// ---------------------------------------------------------------------------
// (5) Forbidden field: start_id
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_START_ID: IntegrityCheckRunConfig = {
  trigger: 'scheduled',
  // @ts-expect-error — F-97: IntegrityCheckRunConfig MUST NOT surface `start_id`.
  start_id: '10'
};

// ---------------------------------------------------------------------------
// (6) Forbidden field: end_id
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_END_ID: IntegrityCheckRunConfig = {
  trigger: 'scheduled',
  // @ts-expect-error — F-97: IntegrityCheckRunConfig MUST NOT surface `end_id`.
  end_id: '50'
};

// ---------------------------------------------------------------------------
// (7) Forbidden field: table_name
//     Library reads only `audit_log` (chain), `retention_sweep_runs`
//     (attribution), `backup_manifests` (secondary witness). A
//     caller-supplied table_name would expand the read surface.
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_TABLE_NAME: IntegrityCheckRunConfig = {
  trigger: 'scheduled',
  // @ts-expect-error — F-97: IntegrityCheckRunConfig MUST NOT surface `table_name`.
  table_name: 'audit_log'
};

// ---------------------------------------------------------------------------
// (8) Forbidden field: backup_manifest_id
//     Library ALWAYS reads the latest committed manifest via
//     `store.readLatestCommittedBackupManifest()` — selecting a stale
//     manifest could cause silent false-negatives on the backup-diff path.
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_BACKUP_MANIFEST_ID: IntegrityCheckRunConfig = {
  trigger: 'scheduled',
  // @ts-expect-error — F-97: IntegrityCheckRunConfig MUST NOT surface `backup_manifest_id`.
  backup_manifest_id: 'bp_xxx'
};

// ---------------------------------------------------------------------------
// (9) Forbidden field: runtime_pin
//     Library ALWAYS reads the live runtime pin via
//     `store.readNodeRuntimePin()` (G-T11-23). A caller-supplied runtime_pin
//     could bypass the F-93 coherence check.
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_RUNTIME_PIN: IntegrityCheckRunConfig = {
  trigger: 'scheduled',
  // @ts-expect-error — F-97: IntegrityCheckRunConfig MUST NOT surface `runtime_pin`.
  runtime_pin: { node_version: '22.0.0', openssl_version: '3.1.0' }
};

// ---------------------------------------------------------------------------
// (10) Forbidden field: max_rows
//      Row cap is a LIBRARY constant `INTEGRITY_MAX_ROWS_PER_PASS = 20000`
//      (ADR-0019 Decision §12) — never caller-supplied.
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_MAX_ROWS: IntegrityCheckRunConfig = {
  trigger: 'scheduled',
  // @ts-expect-error — F-97: IntegrityCheckRunConfig MUST NOT surface `max_rows`.
  max_rows: 1000
};

// ---------------------------------------------------------------------------
// (11) Forbidden field: batch_size
//      Batch size is a LIBRARY constant `INTEGRITY_CHAIN_WALK_BATCH_SIZE =
//      1000` (ADR-0019 Decision §12) — never caller-supplied.
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_BATCH_SIZE: IntegrityCheckRunConfig = {
  trigger: 'scheduled',
  // @ts-expect-error — F-97: IntegrityCheckRunConfig MUST NOT surface `batch_size`.
  batch_size: 500
};

// ---------------------------------------------------------------------------
// (12) Composite poisoning — all eleven at once. The compiler must reject
//      EACH field on its own; this asserts no field is conditionally
//      allowed when paired with the others.
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_ALL: IntegrityCheckRunConfig = {
  trigger: 'scheduled',
  // @ts-expect-error — F-97: predicate forbidden.
  predicate: 'id < 100',
  // @ts-expect-error — F-97: where forbidden.
  where: "event_type = 'x'",
  // @ts-expect-error — F-97: pivot forbidden.
  pivot: '42',
  // @ts-expect-error — F-97: row_range forbidden.
  row_range: [1, 2],
  // @ts-expect-error — F-97: start_id forbidden.
  start_id: '1',
  // @ts-expect-error — F-97: end_id forbidden.
  end_id: '2',
  // @ts-expect-error — F-97: table_name forbidden.
  table_name: 'audit_log',
  // @ts-expect-error — F-97: backup_manifest_id forbidden.
  backup_manifest_id: 'bp_xxx',
  // @ts-expect-error — F-97: runtime_pin forbidden.
  runtime_pin: { node_version: '22.0.0', openssl_version: '3.1.0' },
  // @ts-expect-error — F-97: max_rows forbidden.
  max_rows: 1000,
  // @ts-expect-error — F-97: batch_size forbidden.
  batch_size: 500
};

// ---------------------------------------------------------------------------
// (13) Closed `trigger` union: NON-allowlisted trigger MUST fail compile.
//      The closed allowlist is `'scheduled' | 'post_rotation' | 'post_export'`
//      (ADR-0019 Decision §6).
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_BAD_TRIGGER: IntegrityCheckRunConfig = {
  // @ts-expect-error — F-97: `trigger` is a closed union; 'manual' is not in the allowlist.
  trigger: 'manual'
};

// ---------------------------------------------------------------------------
// (14) Closed `trigger` union: caller-supplied empty-string MUST fail compile.
// ---------------------------------------------------------------------------
export const POISONED_CONFIG_EMPTY_TRIGGER: IntegrityCheckRunConfig = {
  // @ts-expect-error — F-97: `trigger` is a closed union; '' is not in the allowlist.
  trigger: ''
};
