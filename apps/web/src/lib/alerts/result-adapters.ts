/**
 * Result adapters — translate library result discriminated unions
 * into `dispatchAlert(...)` calls.
 *
 * Each adapter is a pure inspect-and-dispatch function; the library
 * never reaches into this module. Tests can install a recording sink
 * via `setAlertSink` and assert the adapter fired what was expected.
 *
 * No PI EVER lands in meta — only structural counts + ids the
 * structured-log allowlist already permits.
 *
 * Source: §C M9 roadmap deliverable.
 */

import type { BackupRetentionPassResult } from '../backup';
import type { IntegrityRunResult } from '../audit-integrity';
import type { RetentionPassResult } from '../retention/types';
import { dispatchAlert, type AlertSymbol } from './dispatch';

/**
 * Retention pass result -> A-RETENTION-001.
 *
 * The retention library carries `alarm_fired: boolean` on its result
 * shapes (F-57 over-delete alarm). The pass either:
 *   - aborts pre-delete with `status: 'aborted_over_delete_threshold'`
 *     (alarm fires, no rows deleted) — A-RETENTION-001 page; OR
 *   - completes with `alarm_fired: true` if the operator opted in via
 *     `confirmOverDeleteThreshold` — still a page (operator wanted us
 *     to record the alarm even though they confirmed the over-delete).
 *
 * `status: 'errored'` does NOT fire A-RETENTION-001 — `error_code` is
 * routed through the per-error-code observability path, not alerts.
 */
export function dispatchRetentionAlerts(result: RetentionPassResult, ts_ms: number): void {
  if (result.status === 'aborted_over_delete_threshold') {
    dispatchAlert('A-RETENTION-001', 'retention', ts_ms, {
      'alert.run_id': result.run_id,
      'alert.would_delete_total': result.would_delete_total,
      'alert.outcome': 'aborted_over_delete_threshold'
    });
    return;
  }
  // `completed` and `capped` result shapes both carry `alarm_fired`.
  if ((result.status === 'completed' || result.status === 'capped') && result.alarm_fired) {
    dispatchAlert('A-RETENTION-001', 'retention', ts_ms, {
      'alert.run_id': result.run_id,
      'alert.deleted_total': result.deleted_total,
      'alert.outcome': result.status
    });
  }
}

/**
 * Backup retention pass result -> A-BACKUP-001.
 *
 * The library surfaces `would_fire_alert: 'A-BACKUP-001'` on the
 * `completed` shape when at least one manifest object refused delete
 * because the object-lock window had not yet expired (F-75). The
 * `dry_run` and `errored` shapes never fire.
 */
export function dispatchBackupRetentionAlerts(
  result: BackupRetentionPassResult,
  ts_ms: number
): void {
  if (result.status === 'completed' && result.would_fire_alert === 'A-BACKUP-001') {
    dispatchAlert('A-BACKUP-001', 'backup', ts_ms, {
      'alert.deleted_count': result.deleted_count,
      'alert.outcome': 'still_locked_past_window'
    });
  }
}

/**
 * Audit-integrity pass result -> A-AUDIT-001 / A-INTEGRITY-002.
 *
 * The library's `would_fire_alert` carries:
 *   - 'A-AUDIT-001' on any chain_walk OR backup_diff mismatch (M-T18-1).
 *   - 'A-INTEGRITY-002' on unattributable reconciliation count > 0.
 *   - both as an array when both fire.
 *
 * dry_run + errored shapes never fire.
 */
export function dispatchIntegrityAlerts(result: IntegrityRunResult, ts_ms: number): void {
  if (result.status !== 'completed' && result.status !== 'dry_run') return;
  const wfa = result.would_fire_alert;
  if (wfa === undefined) return;
  const symbols: readonly AlertSymbol[] = Array.isArray(wfa) ? wfa : [wfa];
  for (const sym of symbols) {
    dispatchAlert(sym, 'audit-integrity', ts_ms, {
      'alert.run_id': 'run_id' in result ? result.run_id : '',
      'alert.outcome': result.status
    });
  }
}
