/**
 * Retention sweep orchestration (T16; ADR-0017 §6 algorithm).
 *
 * `runRetentionPass(opts)` is the single entry point. Library-only — the
 * caller injects a `RetentionStore`. SupabaseRetentionStore (T16.1) and
 * MemoryRetentionStore (this dir) both satisfy the interface.
 *
 * Algorithm (per ADR-0017 §6):
 *   1. Check the lease window (F-59); if open within window → skipped.
 *   2. Compute per-event-type cutoffs from RETENTION_SCHEDULE.
 *   3. Compute the underlying-record-ceiling cutoff (now - 30d).
 *   4. Count candidates per event_type + per operational table + ceiling.
 *   5. Apply the over-delete alarm (F-57) BEFORE any side effect:
 *        - alarm fires iff any single event_type's candidate-count > threshold;
 *        - if confirmOverDeleteThreshold is false → return aborted_over_delete_threshold;
 *        - if confirmOverDeleteThreshold is true → set severity='warn', proceed.
 *   6. Apply the row-cap (F-60); status flips to 'capped' when total reaches cap.
 *   7. Snapshot the store BEFORE the first delete (F-58 rollback prep).
 *   8. Execute the deletes (per event_type, then ceiling, then operational tables).
 *   9. Emit retention.deleted summary + register sweep_run row. If this throws,
 *      restore snapshot and return errored.
 *
 * The library never accepts a caller-supplied WHERE/predicate/filter (F-64).
 */

import {
  computeScheduleHash,
  getRetentionScheduleEntry,
  listRetentionEventTypes,
  OPERATIONAL_TABLE_SCHEDULE
} from './schedule';
import type { RetentionStore } from './retention-store';
import {
  DEFAULT_ALARM_THRESHOLD,
  DEFAULT_LEASE_WINDOW_MS,
  DEFAULT_MAX_TOTAL_ROWS_PER_PASS,
  DAYS_PER_MONTH_FOR_CUTOFF,
  DAYS_PER_YEAR_FOR_CUTOFF,
  MS_PER_DAY,
  MS_PER_HOUR,
  UNDERLYING_RECORD_CEILING_DAYS
} from './types';
import type {
  RetentionEventType,
  RetentionPassConfig,
  RetentionPassResult,
  RetentionScheduleEntry
} from './types';
import { randomUUID } from 'node:crypto';

/**
 * Generate a run_id that is structurally distinguishable from PII shapes.
 *
 * F-67: result payloads must never contain a phone-shaped or pseudonym-shaped
 * substring. A bare UUID's tail segment can collide with the
 * `\d{3}-\d{3}-\d{4}` phone pattern (probability ~1%). A bare 32-hex prefix
 * collides with the pseudonym `\b[0-9a-f]{32}\b` pattern. We rejection-sample
 * UUIDs until both shapes are absent. Bounded by max attempts; in practice
 * almost always returns on the first attempt.
 */
const PHONE_SHAPE = /\+1\d{10}|\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/;
const PSEUDONYM_SHAPE = /\b[0-9a-f]{32}\b/i;

function generateRunId(): string {
  // Bounded loop: at >99% success per attempt, 32 attempts is astronomical.
  for (let i = 0; i < 32; i++) {
    const candidate = randomUUID();
    if (!PHONE_SHAPE.test(candidate) && !PSEUDONYM_SHAPE.test(candidate)) {
      return candidate;
    }
  }
  // Structural fallback — deterministic shape that cannot match either probe.
  return `rs-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export interface RunRetentionPassOpts {
  readonly store: RetentionStore;
  readonly config?: RetentionPassConfig;
}

/**
 * Compute the ms-epoch cutoff for a schedule entry, given the pass's `now_ms`.
 *
 * Closed-switch on the entry's discriminator; `__assertEventTypeExhaustive`-style
 * via the `never` cast at the default branch. Adding a new schedule-entry
 * kind without a branch here fails type-check.
 */
function cutoffMsForScheduleEntry(entry: RetentionScheduleEntry, now_ms: number): number {
  switch (entry.kind) {
    case 'fixed_days':
      return now_ms - entry.days * MS_PER_DAY;
    case 'fixed_months':
      return now_ms - entry.months * DAYS_PER_MONTH_FOR_CUTOFF * MS_PER_DAY;
    case 'fixed_years':
      return now_ms - entry.years * DAYS_PER_YEAR_FOR_CUTOFF * MS_PER_DAY;
    case 'membership_plus_months':
      // Library half: treat membership as "now" — the production store handles
      // the membership anchor. This means the cutoff is "now - months", which
      // is a conservative under-delete; the SQL half (T16.1) refines it.
      return now_ms - entry.months * DAYS_PER_MONTH_FOR_CUTOFF * MS_PER_DAY;
    case 'membership_plus_years':
      return now_ms - entry.years * DAYS_PER_YEAR_FOR_CUTOFF * MS_PER_DAY;
    case 'years_from_rotation':
      // Same conservative posture: production refines from the rotation
      // anchor; in-memory tests treat now as the anchor.
      return now_ms - entry.years * DAYS_PER_YEAR_FOR_CUTOFF * MS_PER_DAY;
    case 'match_underlying':
      // The library does not delete `match_underlying` rows via the per-event
      // path — they flow through the ceiling rule. Returning -Infinity makes
      // the per-event candidate-count be 0 for these rows.
      return Number.NEGATIVE_INFINITY;
    default: {
      const _exhaustive: never = entry;
      throw new Error(`unhandled schedule-entry kind: ${String(_exhaustive)}`);
    }
  }
}

function cutoffMsForOperationalEntry(
  entry: { kind: 'fixed_hours'; hours: number } | { kind: 'fixed_days'; days: number },
  now_ms: number
): number {
  switch (entry.kind) {
    case 'fixed_hours':
      return now_ms - entry.hours * MS_PER_HOUR;
    case 'fixed_days':
      return now_ms - entry.days * MS_PER_DAY;
    default: {
      const _exhaustive: never = entry;
      throw new Error(`unhandled operational kind: ${String(_exhaustive)}`);
    }
  }
}

export async function runRetentionPass(opts: RunRetentionPassOpts): Promise<RetentionPassResult> {
  const { store, config = {} } = opts;
  const alarm_threshold = config.alarm_threshold ?? DEFAULT_ALARM_THRESHOLD;
  const max_total = config.max_total_rows_per_pass ?? DEFAULT_MAX_TOTAL_ROWS_PER_PASS;
  const lease_window_ms = config.lease_window_ms ?? DEFAULT_LEASE_WINDOW_MS;
  const confirmOverDelete = config.confirmOverDeleteThreshold === true;

  // Step 1 — lease check (F-59).
  const startedAtMs = store.nowMs();
  if (await store.hasOpenSweepRunWithinWindow(startedAtMs, lease_window_ms)) {
    return { status: 'skipped', reason: 'pass_already_in_window' };
  }

  // Step 2 — per-event-type cutoffs (closed-switch on schedule kind).
  const cutoffs = {} as Record<RetentionEventType, number>;
  for (const et of listRetentionEventTypes()) {
    cutoffs[et] = cutoffMsForScheduleEntry(getRetentionScheduleEntry(et), startedAtMs);
  }

  // Step 3 — underlying-record-ceiling cutoff (F-61).
  const ceilingCutoffMs = startedAtMs - UNDERLYING_RECORD_CEILING_DAYS * MS_PER_DAY;

  // Step 4 — count candidates per event_type + per operational table + ceiling.
  const perEventCounts = await store.countCandidatesPerEventType(cutoffs);
  const operationalCutoffs: Record<string, number> = {};
  const perTableCounts: Record<string, number> = {};
  for (const [tbl, entry] of Object.entries(OPERATIONAL_TABLE_SCHEDULE)) {
    const c = cutoffMsForOperationalEntry(entry, startedAtMs);
    operationalCutoffs[tbl] = c;
    perTableCounts[tbl] = await store.countCandidatesInOperationalTable(tbl, c);
  }
  const ceilingCount = await store.countCandidatesForCeiling(ceilingCutoffMs);

  // Step 5 — over-delete alarm (F-57). Fires when ANY single event_type's
  // candidate-count is STRICTLY greater than the threshold.
  let alarm_fired = false;
  for (const et of listRetentionEventTypes()) {
    if ((perEventCounts[et] ?? 0) > alarm_threshold) {
      alarm_fired = true;
      break;
    }
  }
  if (alarm_fired && !confirmOverDelete) {
    let would_delete_total = 0;
    for (const et of listRetentionEventTypes()) {
      would_delete_total += perEventCounts[et] ?? 0;
    }
    for (const t of Object.keys(perTableCounts)) {
      would_delete_total += perTableCounts[t] ?? 0;
    }
    would_delete_total += ceilingCount;
    return {
      status: 'aborted_over_delete_threshold',
      run_id: generateRunId(),
      alarm_fired: true,
      would_delete_total
    };
  }

  // Step 6 + 7 — apply row-cap as we go; snapshot before first delete.
  const snapshotToken = store.snapshot();

  let deletedTotal = 0;
  const liveEventCounts: Record<string, number> = {};
  const liveTableCounts: Record<string, number> = {};
  let truncated = false;

  // Helper — clamp a delete batch's max to the remaining cap.
  const remaining = (): number => Math.max(0, max_total - deletedTotal);

  try {
    // 8a — per-event-type deletes.
    for (const et of listRetentionEventTypes()) {
      if (remaining() === 0) {
        truncated = true;
        break;
      }
      const entry = getRetentionScheduleEntry(et);
      if (entry.kind === 'match_underlying') continue; // handled by ceiling
      const cutoff = cutoffs[et];
      const wanted = perEventCounts[et] ?? 0;
      if (wanted === 0) continue;
      const cap = Math.min(wanted, remaining());
      const r = await store.deleteForEventType(et, cutoff, cap);
      if (r.deleted_count > 0) liveEventCounts[et] = r.deleted_count;
      deletedTotal += r.deleted_count;
      if (r.deleted_count < wanted) truncated = true;
    }

    // 8b — underlying-record-ceiling deletes.
    if (remaining() > 0 && ceilingCount > 0) {
      const cap = Math.min(ceilingCount, remaining());
      const r = await store.deleteForUnderlyingRecordCeiling(ceilingCutoffMs, cap);
      // Per-event-type breakdown of ceiling-driven deletes is not exposed by
      // the store in the in-memory mirror; record the aggregate under a
      // structural key. T16.1's SQL path will fill the per-event breakdown.
      if (r.deleted_count > 0) {
        liveEventCounts['__ceiling__'] = r.deleted_count;
      }
      deletedTotal += r.deleted_count;
      if (r.deleted_count < ceilingCount) truncated = true;
    }

    // 8c — operational table deletes.
    for (const [tbl, c] of Object.entries(operationalCutoffs)) {
      if (remaining() === 0) {
        truncated = true;
        break;
      }
      const wanted = perTableCounts[tbl] ?? 0;
      if (wanted === 0) continue;
      const cap = Math.min(wanted, remaining());
      const r = await store.deleteOperationalTable(tbl, c, cap);
      if (r.deleted_count > 0) liveTableCounts[tbl] = r.deleted_count;
      deletedTotal += r.deleted_count;
      if (r.deleted_count < wanted) truncated = true;
    }
  } catch {
    store.restore(snapshotToken);
    return {
      status: 'errored',
      run_id: generateRunId(),
      error_code: 'audit_emit_failed'
    };
  }

  // Step 9 — emit summary + register run row, AS THE LAST step. If this
  // throws, rollback everything (F-58).
  //
  // Strip the synthetic `__ceiling__` aggregate before composing the
  // summary jsonb so it never appears on the wire.
  const auditLogPerEventType: Record<string, number> = {};
  for (const [k, v] of Object.entries(liveEventCounts)) {
    if (k === '__ceiling__') continue;
    auditLogPerEventType[k] = v;
  }

  const run_id = generateRunId();
  const schedule_hash = computeScheduleHash();
  const status: 'completed' | 'capped' = truncated ? 'capped' : 'completed';
  const completedAtMs = store.nowMs();

  const summaryMeta: Record<string, unknown> = {
    deleted_per_table: {
      ...liveTableCounts,
      audit_log_per_event_type: auditLogPerEventType
    },
    schedule_hash,
    status,
    truncated_to_row_cap: truncated,
    alarm_fired,
    run_id
  };
  if (alarm_fired) {
    summaryMeta.severity = 'warn';
  }

  try {
    await store.emitRetentionDeletedAndRegisterRun({
      row: {
        event_type: 'retention.deleted',
        ts_ms: completedAtMs,
        target_id: null,
        actor_pseudonym: store.systemActorPseudonym(),
        meta: summaryMeta
      },
      run: {
        run_id,
        started_at_ms: startedAtMs,
        completed_at_ms: completedAtMs,
        schedule_hash,
        per_event_counts: auditLogPerEventType,
        per_table_counts: liveTableCounts,
        truncated_to_row_cap: truncated,
        alarm_fired,
        status
      }
    });
  } catch {
    // F-58: emit failed → roll back ALL in-flight deletes. Structured error
    // code only; no PII (F-67).
    store.restore(snapshotToken);
    return {
      status: 'errored',
      run_id,
      error_code: 'audit_emit_failed'
    };
  }

  if (status === 'capped') {
    return {
      status: 'capped',
      run_id,
      alarm_fired,
      deleted_total: deletedTotal,
      truncated_to_row_cap: true
    };
  }
  return {
    status: 'completed',
    run_id,
    alarm_fired,
    deleted_total: deletedTotal
  };
}
