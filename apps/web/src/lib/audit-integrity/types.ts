/**
 * Audit-integrity library types (T18; library-only per ADR-0002 Amendment H).
 *
 * Closed enum + discriminated unions per ADR-0019 §1/§5/§6/§8/§9/§10/§11/§12.
 * The library never accepts a caller-supplied predicate, WHERE-fragment,
 * pivot, row-range, runtime_pin, table-name, manifest selector, max_rows,
 * or batch_size; the trigger discriminator is the SOLE caller input
 * (F-19/F-97 lineage).
 *
 * Source obligations (threat-model §3.11): F-86..F-100.
 */

/**
 * Closed `IntegrityCheckEventType` enum — verbatim from ADR-0019 §2.
 *
 * Set-equality with `INTEGRITY_CHECK_EVENT_TYPES` const enforced by
 * `runIntegrityEventTypesDriftCheck` (F-86).
 */
export type IntegrityCheckEventType =
  | 'audit.integrity_check.ran'
  | 'audit.integrity_check.mismatch'
  | 'audit.chain_anchor.weekly';

/**
 * Closed `IntegrityCheckTrigger` enum — verbatim from ADR-0019 §6.
 *
 * The exhaustive switch in `runIntegrityCheck` terminates with a `never`
 * cast on the default branch (F-97 defense-in-depth).
 */
export type IntegrityCheckTrigger = 'scheduled' | 'post_rotation' | 'post_export';

/**
 * Live runtime pin (G-T11-23 hash-determinism). The library compares the
 * live pin against the manifest's recorded pin BEFORE any chain walk or
 * backup-diff; a divergence routes to the OPERATIONAL `runtime_pin_mismatch`
 * error code (F-93), NOT to A-AUDIT-001 (toolchain upgrades are not tamper).
 */
export interface IntegrityNodeRuntimePin {
  readonly node_version: string;
  readonly openssl_version: string;
}

/**
 * Audit-chain row as materialized for the chain-walk + backup-diff surface.
 *
 * The library hashes over `(id, ts_ms, actor_pseudonym, event_type,
 * target_id, target_class, severity, request_id, rotation_id, meta,
 * prev_hash)`; the recompute output is `canonical_hash`. `hash` is the LIVE
 * stored hash (mutable via `__debugCorruptRowHash` in tests; produced by
 * the SQL trigger in production).
 *
 * In-memory mirror semantics (ADR-0019 §4): `canonical_hash` is the
 * snapshot recorded at insert time; T18.1's SupabaseIntegrityStore reads
 * the SQL trigger's output for the same row.
 */
export interface AuditChainRowMaterialized {
  readonly id: string;
  readonly ts_ms: number;
  readonly actor_pseudonym: string;
  readonly event_type: string;
  readonly target_id: string | null;
  readonly target_class: string;
  readonly severity: string;
  readonly request_id: string | null;
  readonly rotation_id: string | null;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly prev_hash: string;
  readonly hash: string;
  readonly canonical_hash: string;
}

/**
 * Backup-manifest snapshot — the structural subset T18 consumes from a
 * committed manifest (G-T17-RA2-ANCHOR-CONSUMER snapshot-pinned fields).
 *
 * Augmented with the dump's audit_log row range so the backup-diff surface
 * can re-walk it without a re-read against the object-locked bucket (MVP
 * mirror per ADR-0019 §5 step 8 note; T18.1 reads from the bucket).
 */
export interface BackupManifestSnapshot {
  readonly run_id: string;
  readonly committed_at_ms: number;
  readonly audit_log_head: {
    readonly id: string;
    readonly ts_ms: number;
    readonly hash: string;
  } | null;
  readonly per_event_row_counts: Readonly<Record<string, number>>;
  readonly retention_sweep_runs_snapshot_ts_ms: number;
  readonly schedule_hash: string;
  readonly node_runtime_pin: IntegrityNodeRuntimePin;
  /**
   * Dump's view of the audit_log row range, captured at manifest-insertion
   * time per ADR-0019 §5 step 8 MVP note. Each entry pins the row's
   * `(id, ts_ms, hash, prev_hash, event_type)` as the dump saw it. T18.1
   * fetches this via the object-lock bucket dump bytes.
   */
  readonly audit_log_rows_in_dump: ReadonlyArray<{
    readonly id: string;
    readonly ts_ms: number;
    readonly hash: string;
    readonly prev_hash: string;
    readonly event_type: string;
  }>;
}

/**
 * Retention-sweep-run snapshot — the structural subset T18 consumes for
 * the reconciliation join (Option G binding rule). G-T17-9: missing
 * per_event_counts keys are treated as zero; G-T16-RECONCILE-CEILING:
 * `__ceiling__` is NEVER read.
 */
export interface RetentionSweepRunSnapshot {
  readonly run_id: string;
  readonly started_at_ms: number;
  readonly completed_at_ms: number;
  readonly per_event_counts: Readonly<Record<string, number>>;
  readonly status: 'completed' | 'capped';
}

/**
 * Integrity-check run row — the F-72 state-machine carrier. Lives in
 * `integrity_check_runs` in T18.1 production.
 */
export interface IntegrityCheckRunRow {
  readonly run_id: string;
  readonly trigger: IntegrityCheckTrigger;
  readonly started_at_ms: number;
  readonly completed_at_ms: number | null;
  readonly status: 'running' | 'completed' | 'capped' | 'errored';
  readonly rows_walked: number;
  readonly mismatches_count: number;
  readonly attributable_count: number;
  readonly unattributable_count: number;
  readonly backup_diff_performed: boolean;
  readonly backup_manifest_run_id: string | null;
  readonly resume_after_id: string | null;
  readonly node_runtime_pin: IntegrityNodeRuntimePin;
  readonly schedule_hash: string | null;
}

/**
 * Per-mismatch audit-row meta (ADR-0019 §8). Structural fields only; no
 * row content excerpts; no pseudonym; no target_id of the mismatching row.
 * G-T17-PRIV-7 + G-T16-PRIV-1.
 */
export interface IntegrityMismatchMeta {
  readonly run_id: string;
  readonly detected_via: 'chain_walk' | 'backup_diff';
  readonly row_id: string;
  readonly expected_hash: string;
  readonly actual_hash: string | null;
  readonly prev_hash_match: boolean;
  readonly attribution_attempted: boolean;
  readonly backup_manifest_run_id?: string;
}

/**
 * Pass-level configuration consumed by `runIntegrityCheck`.
 *
 * Deliberately narrow per ADR-0019 §6 + §11 + F-97:
 *   - NO `predicate` / `where` / `pivot` / `row_range` / `start_id` /
 *     `end_id` / `table_name` / `backup_manifest_id` / `runtime_pin` /
 *     `max_rows` / `batch_size` fields.
 *   - `trigger` is a closed union (`scheduled` | `post_rotation` | `post_export`).
 *
 * Each forbidden field is typed `?: never` so TS reports an individual
 * type error on EACH excess property (TS2322 "Type X is not assignable
 * to type 'never'") rather than collapsing them into a single
 * excess-property TS2353. This makes every `@ts-expect-error` directive
 * in `apps/web/test/T18/fixtures/poisoned-config.ts` fire individually
 * — required for the composite POISONED_CONFIG_ALL fixture which lists
 * all eleven forbidden fields in one object literal.
 *
 * `exactOptionalPropertyTypes: true` in tsconfig is what makes the
 * nominal `?: never` rejection bite on each property.
 */
export interface IntegrityCheckRunConfig {
  readonly trigger: IntegrityCheckTrigger;
  /** Default: INTEGRITY_DEFAULT_LEASE_WINDOW_MS (5 minutes, F-50 mirror). */
  readonly lease_window_ms?: number;
  /** Default: false. Dry-run computes the walk without writing audit rows. */
  readonly dry_run?: boolean;
  // ---------------------------------------------------------------------
  // F-97 cooperative-caller defenses. Each forbidden field is nominally
  // typed `?: never`; ANY caller-supplied value triggers an individual
  // type error so the poisoned-config fixture's @ts-expect-error
  // directives all fire (one per excess property).
  // ---------------------------------------------------------------------
  readonly predicate?: never;
  readonly where?: never;
  readonly pivot?: never;
  readonly row_range?: never;
  readonly start_id?: never;
  readonly end_id?: never;
  readonly table_name?: never;
  readonly backup_manifest_id?: never;
  readonly runtime_pin?: never;
  readonly max_rows?: never;
  readonly batch_size?: never;
}

/**
 * Closed literal union of error_codes (F-100). A random string fails tsc
 * when compared to `IntegrityRunResult.errored.error_code`.
 */
export type IntegrityErrorCode =
  | 'run_start_failed'
  | 'runtime_pin_mismatch'
  | 'chain_walk_failed'
  | 'backup_diff_failed'
  | 'audit_emit_failed'
  | 'head_read_failed'
  | 'lease_check_failed';

/**
 * Closed literal union of error_codes for the weekly anchor. Disjoint from
 * `IntegrityErrorCode` so the type narrows precisely on the anchor result.
 */
export type IntegrityAnchorErrorCode = 'head_read_failed' | 'audit_emit_failed';

/**
 * Closed allowlist of alert symbols the integrity-check pass surfaces.
 * A-AUDIT-001 fires on any mismatch (chain_walk OR backup_diff);
 * A-INTEGRITY-002 fires ONLY on unattributable reconciliation. The
 * library returns the symbols; T18.1 wires the sink (F-95).
 */
export type IntegrityAlertSymbol = 'A-AUDIT-001' | 'A-INTEGRITY-002';

/**
 * Result discriminated union for `runIntegrityCheck` (ADR-0019 §5 step 11).
 *
 * `would_fire_alert` carries a SINGLE symbol on chain-walk-only mismatch;
 * an array on combined mismatch + unattributable reconciliation (per
 * F-95 distinct-cause property + resultIncludesAlert helper in tests).
 */
export type IntegrityRunResult =
  | {
      readonly status: 'completed';
      readonly run_id: string;
      readonly trigger: IntegrityCheckTrigger;
      readonly rows_walked: number;
      readonly mismatches_count: number;
      readonly attributable_count: number;
      readonly unattributable_count: number;
      readonly backup_diff_performed: boolean;
      readonly would_fire_alert?: IntegrityAlertSymbol | readonly IntegrityAlertSymbol[];
    }
  | {
      readonly status: 'capped';
      readonly run_id: string;
      readonly trigger: IntegrityCheckTrigger;
      readonly rows_walked: number;
      readonly mismatches_count: number;
      readonly attributable_count: number;
      readonly unattributable_count: number;
      readonly backup_diff_performed: boolean;
      readonly truncated_to_row_cap: true;
      readonly resume_after_id: string;
      readonly would_fire_alert?: IntegrityAlertSymbol | readonly IntegrityAlertSymbol[];
    }
  | {
      readonly status: 'dry_run';
      readonly run_id: string;
      readonly trigger: IntegrityCheckTrigger;
      readonly rows_walked: number;
      readonly mismatches_count: number;
      readonly attributable_count: number;
      readonly unattributable_count: number;
      readonly backup_diff_performed: boolean;
      readonly would_fire_alert?: IntegrityAlertSymbol | readonly IntegrityAlertSymbol[];
    }
  | {
      readonly status: 'errored';
      readonly run_id: string;
      readonly error_code: IntegrityErrorCode;
    }
  | {
      readonly status: 'skipped';
      readonly reason: 'pass_already_in_window';
    };

/**
 * Result discriminated union for `runWeeklyChainAnchor` (ADR-0019 §7).
 */
export type IntegrityAnchorResult =
  | {
      readonly status: 'completed';
      readonly run_id: string;
      readonly anchor_at_ms: number;
      readonly head: { readonly id: string; readonly ts_ms: number; readonly hash: string };
      readonly emitted: true;
    }
  | {
      readonly status: 'skipped';
      readonly reason: 'empty_chain';
    }
  | {
      readonly status: 'errored';
      readonly error_code: IntegrityAnchorErrorCode;
    };

/** ms-per constants used by lease + buffer arithmetic (no magic numbers). */
export const INTEGRITY_MS_PER_SECOND = 1000;
export const INTEGRITY_MS_PER_MINUTE = 60 * INTEGRITY_MS_PER_SECOND;
export const INTEGRITY_MS_PER_HOUR = 60 * INTEGRITY_MS_PER_MINUTE;

/**
 * F-50 triggered upper bound — 5 minutes between trigger fire and integrity
 * pass start. Doubles as the lease-window default (mirrors T16/T17 pattern).
 */
export const INTEGRITY_DEFAULT_LEASE_WINDOW_MS = 5 * INTEGRITY_MS_PER_MINUTE;

/**
 * Per-batch chain-walk size (ADR-0019 §12). Memory-bounded; the library
 * batches reads at this granularity. Production T18.1 sets the same on
 * the SQL side.
 */
export const INTEGRITY_CHAIN_WALK_BATCH_SIZE = 1000;

/**
 * Hard row-cap per pass (ADR-0019 §12; F-60 mirror). When walked count
 * reaches the cap, status flips to `capped` with `resume_after_id` set.
 */
export const INTEGRITY_MAX_ROWS_PER_PASS = 20000;

/**
 * RA-2 §4297 verbatim 1-hour buffer. Rows whose `ts_ms < manifest.committed_at_ms
 * - INTEGRITY_BACKUP_DIFF_BUFFER_MS` are eligible for the backup-diff window.
 * Rows INSIDE the buffer (fresher than the cutoff) are structurally excluded.
 *
 * Changing this requires three-mirror coordination (ADR-0019 §12 + RA-2 §4297
 * + apps/web/test/T18/backup-diff-mismatch.test.ts) per ADR-0019 §Reversibility.
 */
export const INTEGRITY_BACKUP_DIFF_BUFFER_MS = 1 * INTEGRITY_MS_PER_HOUR;

/** Clock floor for monotonic nowMs() advance (mirrors T16/T17 NOW_MS_MIN_INCREMENT). */
export const INTEGRITY_NOW_MS_MIN_INCREMENT = 1;

/** Genesis prev_hash sentinel — 32 zero bytes hex (ADR-0019 §A / audit-log.md §2). */
export const INTEGRITY_GENESIS_PREV_HASH = '0'.repeat(64);

/** Run-id prefix — breaks the 32-hex pseudonym word boundary (G-T16-PRIV-3). */
export const INTEGRITY_RUN_ID_PREFIX = 'ic_';
