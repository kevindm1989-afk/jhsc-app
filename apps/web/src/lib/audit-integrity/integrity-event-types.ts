/**
 * Frozen `INTEGRITY_CHECK_EVENT_TYPES` closed-allowlist + drift check (T18; F-86).
 *
 * The const is `Object.freeze([...] as const) satisfies readonly
 * IntegrityCheckEventType[]` so its element type IS the
 * `IntegrityCheckEventType` union by construction; the runtime set-equality
 * assertion runs against the canonical enum keys list below.
 *
 * `runIntegrityEventTypesDriftCheck` accepts an `__overrideForTest`
 * deep-import-only hook so the test file can inject a mutated copy without
 * touching production state (mirrors T16's `__setScheduleOverrideForTest`
 * lineage + T17's `runBackupTablesDriftCheck`).
 *
 * Source: ADR-0019 §2; threat-model §3.11 F-86.
 */

import type { IntegrityCheckEventType } from './types';

/**
 * Closed-allowlist of integrity-check event types. Verbatim from ADR-0019 §2.
 *
 * `Object.freeze` is the runtime defense against the F-19 spread-then-mutate
 * attack — assigning into `INTEGRITY_CHECK_EVENT_TYPES[0]` throws under
 * strict mode.
 */
export const INTEGRITY_CHECK_EVENT_TYPES = Object.freeze([
  'audit.integrity_check.ran',
  'audit.integrity_check.mismatch',
  'audit.chain_anchor.weekly'
] as const) satisfies readonly IntegrityCheckEventType[];

/**
 * Canonical enum-key list — the union side of the set-equality check. Any
 * future addition to the `IntegrityCheckEventType` union MUST add the
 * matching entry to this list (and to `INTEGRITY_CHECK_EVENT_TYPES` above).
 * The drift check fails CI on any single-mirror update.
 */
const INTEGRITY_CHECK_EVENT_TYPE_KEYS_RUNTIME: readonly IntegrityCheckEventType[] = [
  'audit.integrity_check.ran',
  'audit.integrity_check.mismatch',
  'audit.chain_anchor.weekly'
];

/**
 * Structured drift verdict. `missing` names entries present in the
 * `IntegrityCheckEventType` enum but absent from the (possibly-overridden)
 * allowlist; `orphan` names entries present in the allowlist but absent
 * from the enum.
 *
 * Arrays are typed `string[]` so the test contract's structural cast
 * `(verdict as {missing?: string[]}).missing` succeeds.
 */
export interface IntegrityEventTypesDriftVerdict {
  readonly ok: boolean;
  readonly missing: string[];
  readonly orphan: string[];
}

export interface RunIntegrityEventTypesDriftCheckOpts {
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
export function runIntegrityEventTypesDriftCheck(
  opts?: RunIntegrityEventTypesDriftCheckOpts
): IntegrityEventTypesDriftVerdict {
  const liveList =
    opts?.__overrideForTest !== undefined
      ? opts.__overrideForTest
      : (INTEGRITY_CHECK_EVENT_TYPES as readonly string[]);
  const liveSet = new Set<string>(liveList);
  const enumSet = new Set<string>(INTEGRITY_CHECK_EVENT_TYPE_KEYS_RUNTIME);

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
 * `__assertEventTypeExhaustive` and T17's `__assertBackupTableExhaustive`).
 * Adding a new entry to `IntegrityCheckEventType` without a matching switch
 * branch fails type-check.
 */
export function __assertIntegrityEventTypeExhaustive(t: never): never {
  throw new Error(`closed enum exhausted by unexpected value: ${String(t)}`);
}
