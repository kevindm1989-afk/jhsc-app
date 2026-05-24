/**
 * Audit-integrity orchestration (T18; ADR-0019 §5 + §7 algorithms).
 *
 * `runIntegrityCheck(opts)` + `runWeeklyChainAnchor(opts)` are the SOLE
 * entry points. Library-only — the caller injects an `IntegrityStore`.
 * SupabaseIntegrityStore (T18.1) and MemoryIntegrityStore (this dir) both
 * satisfy the production interface.
 *
 * Algorithm (per ADR-0019 §5):
 *   1.  Lease check (F-59 mirror).
 *   2.  Generate run_id (G-T16-PRIV-3 PII-shape rejection sample; `ic_` prefix).
 *   3.  Read latest committed backup manifest (Phase-0 → null).
 *   4.  Runtime-pin coherence check (G-T11-23 / F-93) — OPERATIONAL not A-AUDIT-001.
 *   5.  Write run row in `status: 'running'` FIRST (F-72 state machine + F-24 inversion).
 *   6.  Snapshot for rollback (F-58 mirror).
 *   7.  Chain walk in batches; accumulate mismatches.
 *   8.  Backup-diff (only if manifest non-null AND head non-null); apply
 *       1-hour buffer per RA-2 §4297 + reconciliation rule per Option G.
 *   9.  Determine alert symbols (F-95 distinct causes).
 *   10. Emit mismatches FIRST then ran-row LAST (F-87 + F-88); on emit
 *       failure → restore snapshot → return `audit_emit_failed`.
 *   11. Build IntegrityRunResult.
 *
 * `runWeeklyChainAnchor` (per ADR-0019 §7):
 *   1. Read chain head → null on empty → return `skipped`.
 *   2. Emit `audit.chain_anchor.weekly` row with head triple.
 *   3. Return `completed` with the head triple.
 *
 * No PII in errors (F-100): every error_code is a closed literal.
 */

import { randomUUID } from 'node:crypto';
import type {
  ChainAnchorWeeklyAuditRow,
  IntegrityCheckMismatchRow,
  IntegrityCheckRanAuditRow,
  IntegrityStore
} from './integrity-store';
import {
  INTEGRITY_BACKUP_DIFF_BUFFER_MS,
  INTEGRITY_CHAIN_WALK_BATCH_SIZE,
  INTEGRITY_DEFAULT_LEASE_WINDOW_MS,
  INTEGRITY_MAX_ROWS_PER_PASS,
  INTEGRITY_RUN_ID_PREFIX,
  type AuditChainRowMaterialized,
  type BackupManifestSnapshot,
  type IntegrityAlertSymbol,
  type IntegrityAnchorResult,
  type IntegrityCheckRunConfig,
  type IntegrityCheckTrigger,
  type IntegrityMismatchMeta,
  type IntegrityRunResult,
  type RetentionSweepRunSnapshot
} from './types';

/**
 * Pseudonym + phone shapes — used by `generateRunId` to rejection-sample
 * UUIDv4 values whose hex pattern could collide with the F-100 PII probes.
 * Mirrors T16 / T17 `generateRunId` (G-T16-PRIV-3 lineage).
 */
const PHONE_SHAPE = /\+1\d{10}|\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/;
const PSEUDONYM_SHAPE = /\b[0-9a-f]{32}\b/i;
const RUN_ID_REJECTION_SAMPLE_LIMIT = 32;

function generateRunId(): string {
  // Run-id shape: `ic_` prefix + dash-bearing UUIDv4 tail. The prefix breaks
  // any 32-hex word-boundary match (the pseudonym shape); the dashes inside
  // the UUID break it again. Rejection-sample defensively per G-T16-PRIV-3.
  for (let i = 0; i < RUN_ID_REJECTION_SAMPLE_LIMIT; i++) {
    const candidate = `${INTEGRITY_RUN_ID_PREFIX}${randomUUID()}`;
    if (!PHONE_SHAPE.test(candidate) && !PSEUDONYM_SHAPE.test(candidate)) {
      return candidate;
    }
  }
  return `${INTEGRITY_RUN_ID_PREFIX}fallback_${Date.now().toString(36)}`;
}

/**
 * Closed-switch on the trigger discriminator. The exhaustive `never` cast
 * on the default branch enforces F-19 / F-97 at compile time.
 */
function assertValidTrigger(trigger: IntegrityCheckTrigger): IntegrityCheckTrigger {
  switch (trigger) {
    case 'scheduled':
    case 'post_rotation':
    case 'post_export':
      return trigger;
    default: {
      const _exhaustive: never = trigger;
      throw new Error(`trigger outside closed allowlist: ${_exhaustive as string}`);
    }
  }
}

/** Numeric-aware id comparator. Matches MemoryIntegrityStore's. */
function compareIds(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn) && String(an) === a && String(bn) === b) {
    return an - bn;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Pure helper: detect whether two ids are sequential (b == a + 1) for numeric ids. */
function isNextSequentialId(prev: string, next: string): boolean {
  const pn = Number(prev);
  const nn = Number(next);
  if (Number.isFinite(pn) && Number.isFinite(nn) && String(pn) === prev && String(nn) === next) {
    return nn === pn + 1;
  }
  // Non-numeric ids: cannot assert sequentiality; treat as sequential (no gap).
  return true;
}

interface ChainWalkOutcome {
  readonly mismatches: ReadonlyArray<MismatchAccumulator>;
  readonly rows_walked: number;
  readonly last_walked_id: string | null;
  readonly truncated: boolean;
}

/**
 * Accumulator carrying the structural mismatch fields. The library composes
 * IntegrityCheckMismatchRow from these at emission time so the audit row
 * meta carries ONLY the allowlisted structural keys (G-T17-PRIV-7 / F-94).
 */
interface MismatchAccumulator {
  readonly detected_via: 'chain_walk' | 'backup_diff';
  readonly row_id: string;
  readonly expected_hash: string;
  readonly actual_hash: string | null;
  readonly prev_hash_match: boolean;
  readonly attribution_attempted: boolean;
  readonly backup_manifest_run_id?: string;
}

/**
 * Chain-walk in batches; detects in-place hash corruption + prev_hash
 * breakage + sequential-id gaps. Sweep-attribution for gaps is permissive:
 * a gap covered by a sweep_run with `per_event_counts[evt] > 0` is not a
 * mismatch (F-90 attributed direction).
 */
async function walkChain(opts: {
  readonly store: IntegrityStore;
  readonly start_after_id: string | null;
  readonly sweep_runs: ReadonlyArray<RetentionSweepRunSnapshot>;
}): Promise<ChainWalkOutcome> {
  const out: MismatchAccumulator[] = [];
  let walked = 0;
  let lastId: string | null = opts.start_after_id;
  let prevRow: AuditChainRowMaterialized | null = null;
  let truncated = false;

  while (walked < INTEGRITY_MAX_ROWS_PER_PASS) {
    const remaining = INTEGRITY_MAX_ROWS_PER_PASS - walked;
    const batchSize = Math.min(INTEGRITY_CHAIN_WALK_BATCH_SIZE, remaining);
    const batch = await opts.store.readChainSegment({
      start_after_id: lastId,
      max_rows: batchSize
    });
    if (batch.length === 0) break;

    for (const row of batch) {
      // In-place hash corruption — the stored `hash` no longer matches the
      // canonical recompute. F-89 primary surface.
      if (row.hash !== row.canonical_hash) {
        out.push({
          detected_via: 'chain_walk',
          row_id: row.id,
          expected_hash: row.canonical_hash,
          actual_hash: row.hash,
          prev_hash_match: prevRow === null ? true : row.prev_hash === prevRow.hash,
          attribution_attempted: false
        });
      }

      // Sequential-id gap detection. If the previous row's id + 1 != this
      // row's id, attempt sweep-attribution before flagging.
      if (prevRow !== null && !isNextSequentialId(prevRow.id, row.id)) {
        // The gap's missing rows would have ts between prevRow.ts and row.ts.
        // Attribute if ANY sweep_run covers that range AND has any
        // per_event_counts > 0 (we don't know the missing rows' event_type,
        // so we accept any non-empty bucket as attribution candidate).
        const gapLow = Math.min(prevRow.ts_ms, row.ts_ms);
        const gapHigh = Math.max(prevRow.ts_ms, row.ts_ms);
        const attributed = opts.sweep_runs.some((sw) => {
          if (sw.completed_at_ms < gapLow) return false;
          if (sw.started_at_ms > gapHigh) return false;
          for (const k of Object.keys(sw.per_event_counts)) {
            if (k === '__ceiling__') continue;
            const v = sw.per_event_counts[k];
            if (typeof v === 'number' && v > 0) return true;
          }
          return false;
        });
        if (!attributed) {
          out.push({
            detected_via: 'chain_walk',
            row_id: row.id,
            expected_hash: prevRow.hash,
            actual_hash: row.prev_hash,
            prev_hash_match: row.prev_hash === prevRow.hash,
            attribution_attempted: false
          });
        }
      }

      walked += 1;
      lastId = row.id;
      prevRow = row;
      if (walked >= INTEGRITY_MAX_ROWS_PER_PASS) {
        truncated = true;
        break;
      }
    }

    if (truncated) break;
    if (batch.length < batchSize) break;
  }

  return { mismatches: out, rows_walked: walked, last_walked_id: lastId, truncated };
}

interface BackupDiffOutcome {
  readonly mismatches: ReadonlyArray<MismatchAccumulator>;
  readonly attributable_count: number;
  readonly unattributable_count: number;
}

/**
 * Backup-diff against the manifest's snapshot of the dump's row range.
 * Applies the RA-2 §4297 1-hour buffer: rows whose ts_ms is NOT older than
 * `committed_at_ms - INTEGRITY_BACKUP_DIFF_BUFFER_MS` are structurally
 * excluded (F-91 counter-test).
 *
 * For rows in the dump but absent from the live chain, applies the
 * Option G reconciliation rule:
 *   - Greedy attribution from sweep_runs whose window contains the row's ts
 *     AND whose `per_event_counts[row.event_type] > 0`.
 *   - `__ceiling__` is NEVER read (G-T16-RECONCILE-CEILING).
 *   - Missing keys = zero (G-T17-9).
 */
function diffAgainstManifest(opts: {
  readonly manifest: BackupManifestSnapshot;
  readonly live_rows_by_id: ReadonlyMap<string, AuditChainRowMaterialized>;
  readonly sweep_runs: ReadonlyArray<RetentionSweepRunSnapshot>;
}): BackupDiffOutcome {
  const out: MismatchAccumulator[] = [];
  const cutoffTsMs = opts.manifest.committed_at_ms - INTEGRITY_BACKUP_DIFF_BUFFER_MS;

  // Mutable per-event attribution budgets — greedy first-eligible-sweep.
  const sweepBudgets = opts.sweep_runs.map((sw) => ({
    started_at_ms: sw.started_at_ms,
    completed_at_ms: sw.completed_at_ms,
    budgets: { ...sw.per_event_counts } as Record<string, number>
  }));

  let attributable_count = 0;
  let unattributable_count = 0;

  for (const dumpRow of opts.manifest.audit_log_rows_in_dump) {
    // RA-2 §4297: only walk rows OLDER than the cutoff.
    if (dumpRow.ts_ms >= cutoffTsMs) continue;

    const live = opts.live_rows_by_id.get(dumpRow.id);
    if (live === undefined) {
      // Reconciliation: dump has the row, live does not.
      let attributed = false;
      for (const sw of sweepBudgets) {
        if (sw.started_at_ms > dumpRow.ts_ms) continue;
        if (sw.completed_at_ms < dumpRow.ts_ms) continue;
        // G-T16-RECONCILE-CEILING: NEVER read `__ceiling__`.
        const key = dumpRow.event_type;
        if (key === '__ceiling__') continue;
        const remaining = sw.budgets[key];
        if (typeof remaining === 'number' && remaining > 0) {
          sw.budgets[key] = remaining - 1;
          attributed = true;
          break;
        }
      }
      if (attributed) {
        attributable_count += 1;
      } else {
        unattributable_count += 1;
        out.push({
          detected_via: 'backup_diff',
          row_id: dumpRow.id,
          expected_hash: dumpRow.hash,
          actual_hash: null,
          prev_hash_match: false,
          attribution_attempted: true,
          backup_manifest_run_id: opts.manifest.run_id
        });
      }
      continue;
    }

    // Pivot-rewrite detection (F-91 LOAD-BEARING): live hash differs from
    // dump hash for a row old enough to be in the diff window.
    if (live.hash !== dumpRow.hash) {
      out.push({
        detected_via: 'backup_diff',
        row_id: dumpRow.id,
        expected_hash: dumpRow.hash,
        actual_hash: live.hash,
        prev_hash_match: live.prev_hash === dumpRow.prev_hash,
        attribution_attempted: false,
        backup_manifest_run_id: opts.manifest.run_id
      });
    }
  }

  return { mismatches: out, attributable_count, unattributable_count };
}

/**
 * De-duplicate mismatches by (row_id, detected_via) so the same row reported
 * by chain-walk and backup-diff doesn't double-count. The chain-walk entry
 * wins for the same row_id under `detected_via === 'chain_walk'`; backup-diff
 * entries for OTHER rows pass through.
 */
function mergeMismatches(
  chainWalk: ReadonlyArray<MismatchAccumulator>,
  backupDiff: ReadonlyArray<MismatchAccumulator>
): ReadonlyArray<MismatchAccumulator> {
  const seen = new Set<string>();
  const out: MismatchAccumulator[] = [];
  const key = (m: MismatchAccumulator): string => `${m.row_id}|${m.detected_via}`;
  for (const m of chainWalk) {
    const k = key(m);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  for (const m of backupDiff) {
    const k = key(m);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

/**
 * Compose the mismatch row meta object using ONLY the allowlisted
 * structural keys (G-T17-PRIV-7 / F-94). The `backup_manifest_run_id`
 * key is present only when the mismatch originated from the backup-diff
 * surface; the absence on chain-walk rows is intentional.
 */
function composeMismatchMeta(m: MismatchAccumulator, run_id: string): IntegrityMismatchMeta {
  if (m.backup_manifest_run_id !== undefined) {
    return {
      run_id,
      detected_via: m.detected_via,
      row_id: m.row_id,
      expected_hash: m.expected_hash,
      actual_hash: m.actual_hash,
      prev_hash_match: m.prev_hash_match,
      attribution_attempted: m.attribution_attempted,
      backup_manifest_run_id: m.backup_manifest_run_id
    };
  }
  return {
    run_id,
    detected_via: m.detected_via,
    row_id: m.row_id,
    expected_hash: m.expected_hash,
    actual_hash: m.actual_hash,
    prev_hash_match: m.prev_hash_match,
    attribution_attempted: m.attribution_attempted
  };
}

export interface RunIntegrityCheckOpts {
  readonly store: IntegrityStore;
  readonly config: IntegrityCheckRunConfig;
}

export interface RunWeeklyChainAnchorOpts {
  readonly store: IntegrityStore;
}

/**
 * `runIntegrityCheck` — the SOLE entry point for an integrity-check pass.
 *
 * Closed-allowlist: never accepts a caller-supplied predicate, WHERE,
 * pivot, row-range, runtime_pin, table-name, manifest selector, max_rows,
 * or batch_size (F-97). The result's `error_code` is a closed literal
 * union (F-100).
 */
export async function runIntegrityCheck(
  opts: RunIntegrityCheckOpts
): Promise<IntegrityRunResult> {
  const { store, config } = opts;
  const trigger = assertValidTrigger(config.trigger);
  const lease_window_ms = config.lease_window_ms ?? INTEGRITY_DEFAULT_LEASE_WINDOW_MS;

  // Step 1 — lease check.
  const startedAtMs = store.nowMs();
  if (await store.hasOpenIntegrityRunWithinWindow(startedAtMs, lease_window_ms)) {
    return { status: 'skipped', reason: 'pass_already_in_window' };
  }

  // Step 2 — generate run_id.
  const run_id = generateRunId();

  // Step 3 — read manifest BEFORE writing the run row so a manifest-read
  // failure doesn't leave a `running` row behind.
  let manifest: BackupManifestSnapshot | null;
  try {
    manifest = await store.readLatestCommittedBackupManifest();
  } catch {
    return { status: 'errored', run_id, error_code: 'head_read_failed' };
  }

  // Step 4 — runtime-pin coherence (F-93). OPERATIONAL not A-AUDIT-001.
  if (manifest !== null) {
    const livePin = store.readNodeRuntimePin();
    if (
      livePin.node_version !== manifest.node_runtime_pin.node_version ||
      livePin.openssl_version !== manifest.node_runtime_pin.openssl_version
    ) {
      return { status: 'errored', run_id, error_code: 'runtime_pin_mismatch' };
    }
  }

  // Step 5 — record run row in `running` status.
  try {
    await store.recordIntegrityRunStarted({ run_id, trigger, started_at_ms: startedAtMs });
  } catch {
    return { status: 'errored', run_id, error_code: 'run_start_failed' };
  }

  // Step 6 — snapshot for rollback.
  const snapshotToken = store.snapshot();

  // Step 7 — chain walk.
  let sweepRuns: ReadonlyArray<RetentionSweepRunSnapshot> = [];
  if (manifest !== null) {
    try {
      sweepRuns = await store.listRetentionSweepRunsThrough(
        manifest.retention_sweep_runs_snapshot_ts_ms
      );
    } catch {
      store.restore(snapshotToken);
      return { status: 'errored', run_id, error_code: 'chain_walk_failed' };
    }
  }

  let chainWalkOutcome: ChainWalkOutcome;
  try {
    chainWalkOutcome = await walkChain({ store, start_after_id: null, sweep_runs: sweepRuns });
  } catch {
    store.restore(snapshotToken);
    return { status: 'errored', run_id, error_code: 'chain_walk_failed' };
  }

  // Step 8 — backup-diff (only if manifest non-null AND head non-null).
  let backupDiffOutcome: BackupDiffOutcome = {
    mismatches: [],
    attributable_count: 0,
    unattributable_count: 0
  };
  const backup_diff_performed = manifest !== null && manifest.audit_log_head !== null;
  if (manifest !== null && manifest.audit_log_head !== null) {
    try {
      // Build a live-rows-by-id map for the dump's id range. The cap is the
      // dump's row count + a safety margin; in MVP we read the whole chain
      // segment up to the head pointer.
      const liveSegment = await store.readChainSegment({
        start_after_id: null,
        max_rows: manifest.audit_log_rows_in_dump.length + INTEGRITY_CHAIN_WALK_BATCH_SIZE
      });
      const liveById = new Map<string, AuditChainRowMaterialized>();
      for (const r of liveSegment) liveById.set(r.id, r);
      backupDiffOutcome = diffAgainstManifest({
        manifest,
        live_rows_by_id: liveById,
        sweep_runs: sweepRuns
      });
    } catch {
      store.restore(snapshotToken);
      return { status: 'errored', run_id, error_code: 'backup_diff_failed' };
    }
  }

  // Step 9 — merge mismatches, determine alert symbols.
  const allMismatches = mergeMismatches(chainWalkOutcome.mismatches, backupDiffOutcome.mismatches);

  const alerts: IntegrityAlertSymbol[] = [];
  if (allMismatches.length > 0) alerts.push('A-AUDIT-001');
  if (backupDiffOutcome.unattributable_count > 0) alerts.push('A-INTEGRITY-002');

  // Step 10 — compose mismatch rows + ran row; emit.
  const completedAtMs = store.nowMs();
  const status: 'completed' | 'capped' = chainWalkOutcome.truncated ? 'capped' : 'completed';
  const actor = store.systemActorPseudonym();
  const livePin = store.readNodeRuntimePin();

  const mismatchRows: IntegrityCheckMismatchRow[] = allMismatches.map((m) => ({
    event_type: 'audit.integrity_check.mismatch',
    ts_ms: completedAtMs,
    target_id: null,
    actor_pseudonym: actor,
    target_class: 'C1',
    severity: 'alert',
    meta: composeMismatchMeta(m, run_id)
  }));

  const ranRowMeta: Record<string, unknown> = {
    run_id,
    trigger,
    started_at_ms: startedAtMs,
    completed_at_ms: completedAtMs,
    status,
    rows_walked: chainWalkOutcome.rows_walked,
    mismatches_count: allMismatches.length,
    attributable_count: backupDiffOutcome.attributable_count,
    unattributable_count: backupDiffOutcome.unattributable_count,
    backup_diff_performed,
    backup_manifest_run_id: manifest === null ? null : manifest.run_id,
    resume_after_id:
      status === 'capped' ? chainWalkOutcome.last_walked_id : null,
    node_runtime_pin: { ...livePin },
    schedule_hash: manifest === null ? null : manifest.schedule_hash
  };

  const ranRow: IntegrityCheckRanAuditRow = {
    event_type: 'audit.integrity_check.ran',
    ts_ms: completedAtMs,
    target_id: null,
    actor_pseudonym: actor,
    target_class: 'C1',
    severity: 'info',
    meta: ranRowMeta
  };

  try {
    await store.emitIntegrityCheckRunAndMismatches({
      run: {
        run_id,
        trigger,
        started_at_ms: startedAtMs,
        completed_at_ms: completedAtMs,
        status,
        rows_walked: chainWalkOutcome.rows_walked,
        mismatches_count: allMismatches.length,
        attributable_count: backupDiffOutcome.attributable_count,
        unattributable_count: backupDiffOutcome.unattributable_count,
        backup_diff_performed,
        backup_manifest_run_id: manifest === null ? null : manifest.run_id,
        resume_after_id:
          status === 'capped' ? chainWalkOutcome.last_walked_id : null,
        node_runtime_pin: livePin,
        schedule_hash: manifest === null ? null : manifest.schedule_hash
      },
      mismatches: mismatchRows,
      ran_row: ranRow
    });
  } catch {
    store.restore(snapshotToken);
    return { status: 'errored', run_id, error_code: 'audit_emit_failed' };
  }

  // Step 11 — build result.
  const would_fire_alert: IntegrityAlertSymbol | readonly IntegrityAlertSymbol[] | undefined =
    alerts.length === 0
      ? undefined
      : alerts.length === 1
        ? alerts[0]
        : (alerts.slice() as readonly IntegrityAlertSymbol[]);

  if (status === 'capped') {
    const resume_after_id = chainWalkOutcome.last_walked_id ?? '';
    if (would_fire_alert === undefined) {
      return {
        status: 'capped',
        run_id,
        trigger,
        rows_walked: chainWalkOutcome.rows_walked,
        mismatches_count: allMismatches.length,
        attributable_count: backupDiffOutcome.attributable_count,
        unattributable_count: backupDiffOutcome.unattributable_count,
        backup_diff_performed,
        truncated_to_row_cap: true,
        resume_after_id
      };
    }
    return {
      status: 'capped',
      run_id,
      trigger,
      rows_walked: chainWalkOutcome.rows_walked,
      mismatches_count: allMismatches.length,
      attributable_count: backupDiffOutcome.attributable_count,
      unattributable_count: backupDiffOutcome.unattributable_count,
      backup_diff_performed,
      truncated_to_row_cap: true,
      resume_after_id,
      would_fire_alert
    };
  }

  if (would_fire_alert === undefined) {
    return {
      status: 'completed',
      run_id,
      trigger,
      rows_walked: chainWalkOutcome.rows_walked,
      mismatches_count: allMismatches.length,
      attributable_count: backupDiffOutcome.attributable_count,
      unattributable_count: backupDiffOutcome.unattributable_count,
      backup_diff_performed
    };
  }
  return {
    status: 'completed',
    run_id,
    trigger,
    rows_walked: chainWalkOutcome.rows_walked,
    mismatches_count: allMismatches.length,
    attributable_count: backupDiffOutcome.attributable_count,
    unattributable_count: backupDiffOutcome.unattributable_count,
    backup_diff_performed,
    would_fire_alert
  };
}

/**
 * `runWeeklyChainAnchor` — emits exactly one `audit.chain_anchor.weekly`
 * row carrying the chain head triple. No alerts fire on a publication
 * action (RA-2 manual backstop per ADR-0019 §7 / §4298).
 */
export async function runWeeklyChainAnchor(
  opts: RunWeeklyChainAnchorOpts
): Promise<IntegrityAnchorResult> {
  const { store } = opts;
  let head: AuditChainRowMaterialized | null;
  try {
    head = await store.readChainHead();
  } catch {
    return { status: 'errored', error_code: 'head_read_failed' };
  }
  if (head === null) {
    return { status: 'skipped', reason: 'empty_chain' };
  }
  const run_id = generateRunId();
  const anchor_at_ms = store.nowMs();
  const row: ChainAnchorWeeklyAuditRow = {
    event_type: 'audit.chain_anchor.weekly',
    ts_ms: anchor_at_ms,
    target_id: null,
    actor_pseudonym: store.systemActorPseudonym(),
    target_class: 'C1',
    severity: 'notice',
    meta: {
      anchor_at_ms,
      head: { id: head.id, ts_ms: head.ts_ms, hash: head.hash }
    }
  };
  try {
    await store.emitChainAnchorWeekly(row);
  } catch {
    return { status: 'errored', error_code: 'audit_emit_failed' };
  }
  return {
    status: 'completed',
    run_id,
    anchor_at_ms,
    head: { id: head.id, ts_ms: head.ts_ms, hash: head.hash },
    emitted: true
  };
}

// compareIds is reserved for future ordering work but unused by the current
// orchestrator path (the store returns rows already ordered). Re-export
// to document the contract and avoid a no-unused-locals notice.
export { compareIds };
