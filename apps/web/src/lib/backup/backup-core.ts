/**
 * Backup pass orchestration (T17; ADR-0018 §5 algorithm).
 *
 * `runBackupPass(opts)` + `runBackupRetentionPass(opts)` are the SOLE entry
 * points. Library-only — the caller injects a `BackupStore`.
 * SupabaseBackupStore (T17.1) and MemoryBackupStore (this dir) both satisfy
 * the production interface.
 *
 * Algorithm (per ADR-0018 §5):
 *   1. Lease check (F-59 mirror).
 *   2. Look up current committee_data_key.kid (F-73).
 *   3. Extract audit_log head pointer (F-76, RA-2 follow-up anchor).
 *   4. Per-event histogram (F-77; G-T16-RECONCILE-CEILING).
 *   5. Snapshot retention_sweep_runs ts (F-83 join anchor).
 *   6. Dump the closed allowlist (F-70; no caller-supplied list).
 *   7. Compute sha256 (F-78; G-T11-23 pinned-determinism).
 *   8. Derive object_ref structurally (F-84; no caller-supplied paths).
 *   9. Write manifest in `pending` status FIRST (F-72; F-24 inversion).
 *  10. Upload with object lock (F-71; library-controlled lock duration).
 *  11. Transition manifest to `committed` (F-72 state machine).
 *  12. Emit `backup.manifest_written` audit row AS THE LAST step
 *      (F-79; G-T16-PRIV-1 actor_pseudonym at top level only).
 *
 * Retention pass (per ADR-0018 §5 step 11 + §9 Layer 2):
 *   1. List committed manifests.
 *   2. For each whose `committed_at_ms + 42d <= nowMs`:
 *        - `deleteObjectIfUnlocked(object_ref)`.
 *        - `{deleted: true}` → hard-delete the manifest row.
 *        - `{deleted: false, reason: 'still_locked'}` → flag A-BACKUP-001.
 *
 * No PII in errors (F-81): every error_code is a closed literal.
 */

import { createHash, randomUUID } from 'node:crypto';
import { BACKUP_TABLES } from './backup-tables';
import type {
  BackupManifestWrittenAuditRow,
  BackupStore,
  BackupUploadRejectionReason
} from './backup-store';
import type {
  BackupAuditLogHead,
  BackupPassConfig,
  BackupPassErrorCode,
  BackupPassResult,
  BackupRetentionPassConfig,
  BackupRetentionPassResult
} from './types';
import {
  BACKUP_DEFAULT_LEASE_WINDOW_MS,
  BACKUP_HARD_DELETE_DAYS,
  BACKUP_MS_PER_DAY,
  BACKUP_OBJECT_LOCK_DAYS,
  BACKUP_OBJECT_REF_PREFIX
} from './types';

/**
 * Pseudonym + phone shapes — used by `generateRunId` to rejection-sample
 * UUIDv4 values whose hex pattern could collide with the F-81 PII probes.
 * Mirrors T16's `generateRunId` (G-T16-PRIV-3 lineage).
 */
const PHONE_SHAPE = /\+1\d{10}|\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/;
const PSEUDONYM_SHAPE = /\b[0-9a-f]{32}\b/i;

function generateRunId(): string {
  // Run-id shape: `br_` prefix + dash-bearing UUIDv4 tail. The `br_` prefix
  // breaks any 32-hex word-boundary match, and the dashes inside the UUID
  // break the pseudonym shape too. We rejection-sample defensively in case
  // the underlying randomness drifts (mirrors T16 generateRunId).
  for (let i = 0; i < 32; i++) {
    const candidate = `br_${randomUUID()}`;
    if (!PHONE_SHAPE.test(candidate) && !PSEUDONYM_SHAPE.test(candidate)) {
      return candidate;
    }
  }
  // Structural fallback — deterministic shape that cannot match either probe.
  return `br_fallback_${Date.now().toString(36)}`;
}

/**
 * Derive `object_ref` structurally — F-84: never caller-supplied.
 *
 * Shape: `<prefix>/<YYYYMMDD>/<run_id>.dump`. Date prefix gives the storage
 * bucket a human-scannable folder hierarchy without leaking any PII shape.
 */
function deriveObjectRef(runId: string, committedAtMs: number): string {
  const d = new Date(committedAtMs);
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${BACKUP_OBJECT_REF_PREFIX}/${yyyy}${mm}${dd}/${runId}.dump`;
}

function hexSha256(blob: Uint8Array): string {
  return createHash('sha256').update(blob).digest('hex');
}

/**
 * Translate a structured upload rejection reason into a closed-literal
 * error_code. The mapping is one-way — the `error_code` literal union
 * never widens to `string` (F-82 type-narrow assertion).
 */
function errorCodeForUploadRejection(reason: BackupUploadRejectionReason): BackupPassErrorCode {
  switch (reason) {
    case 'object_lock_policy_rejected':
      return 'object_lock_policy_rejected';
    case 'cross_region_destination_refused':
      return 'cross_region_destination_refused';
    case 'unknown_storage_error':
      return 'backup_upload_failed';
    default: {
      const _exhaustive: never = reason;
      throw new Error(`unhandled upload-rejection reason: ${String(_exhaustive)}`);
    }
  }
}

function abortedStatusForUploadRejection(
  reason: BackupUploadRejectionReason
): 'aborted_object_lock_policy_rejected' | 'aborted_cross_region_destination_refused' | 'aborted_unknown_storage_error' {
  switch (reason) {
    case 'object_lock_policy_rejected':
      return 'aborted_object_lock_policy_rejected';
    case 'cross_region_destination_refused':
      return 'aborted_cross_region_destination_refused';
    case 'unknown_storage_error':
      return 'aborted_unknown_storage_error';
    default: {
      const _exhaustive: never = reason;
      throw new Error(`unhandled upload-rejection reason: ${String(_exhaustive)}`);
    }
  }
}

export interface RunBackupPassOpts {
  readonly store: BackupStore;
  readonly config?: BackupPassConfig;
}

export interface RunBackupRetentionPassOpts {
  readonly store: BackupStore;
  readonly config?: BackupRetentionPassConfig;
}

/**
 * `runBackupPass` — the SOLE entry point for a backup pass.
 *
 * Closed-allowlist: never accepts a caller-supplied object_ref, table list,
 * or lock duration (F-84). The result's `error_code` is a closed literal
 * union (F-82).
 */
export async function runBackupPass(opts: RunBackupPassOpts): Promise<BackupPassResult> {
  const { store, config = {} } = opts;
  const lease_window_ms = config.lease_window_ms ?? BACKUP_DEFAULT_LEASE_WINDOW_MS;
  const dry_run = config.dry_run === true;

  // Step 1 — lease check (F-59 mirror).
  const startedAtMs = store.nowMs();
  if (await store.hasOpenBackupRunWithinWindow(startedAtMs, lease_window_ms)) {
    return { status: 'skipped', reason: 'pass_already_in_window' };
  }

  const run_id = generateRunId();

  // Step 2 — current kid (F-73).
  let kid: string;
  try {
    kid = await store.getCurrentKid();
  } catch {
    return { status: 'errored', run_id, error_code: 'kid_lookup_failed' };
  }

  // Step 3 — head pointer (F-76; RA-2 follow-up anchor). Captured BEFORE the
  // dump so the head corresponds to the chain state at the moment the dump
  // begins (a head captured AFTER would race the sweep + new inserts).
  let auditLogHead: BackupAuditLogHead | null;
  try {
    auditLogHead = await store.extractAuditLogHead();
  } catch {
    return { status: 'errored', run_id, error_code: 'head_pointer_failed' };
  }

  // Step 6 — dump the closed allowlist (the per-event histogram + the
  // retention sweep ts come bundled with the snapshot).
  const dump = await store.dumpClosedAllowlist();

  // Step 7 — sha256 over the dump bytes (F-78; G-T11-23 hash-determinism pin).
  const sha256 = hexSha256(dump.blob);

  // Step 8 — derive object_ref structurally (F-84).
  const object_ref = deriveObjectRef(run_id, startedAtMs);

  // Dry-run short-circuit: compute the manifest shape but skip the upload.
  if (dry_run) {
    return { status: 'dry_run', run_id };
  }

  // Step 5 — F-71 cooperative-caller defense: lock duration is LIBRARY-
  // controlled. The caller cannot weaken it via config (F-84).
  const lock_until_ms = startedAtMs + BACKUP_OBJECT_LOCK_DAYS * BACKUP_MS_PER_DAY;

  // Step 9 — F-72: manifest WRITTEN in `pending` status BEFORE the upload.
  try {
    await store.writeManifestPending({
      run_id,
      started_at_ms: startedAtMs,
      object_ref,
      sha256,
      bytes: dump.blob.byteLength,
      lock_until_ms,
      committee_data_key_kid: kid,
      audit_log_head: auditLogHead,
      per_table_row_counts: dump.per_table_row_counts,
      per_event_row_counts: dump.per_event_row_counts,
      retention_sweep_runs_snapshot_ts_ms: dump.retention_sweep_runs_snapshot_ts_ms
    });
  } catch {
    return { status: 'errored', run_id, error_code: 'manifest_write_failed' };
  }

  // Step 10 — upload with object lock. Structured rejection (G-T11-29).
  const putResult = await store.putWithObjectLock(object_ref, dump.blob, lock_until_ms);
  if (putResult.committed === false) {
    const abortedStatus = abortedStatusForUploadRejection(putResult.reason);
    const errorCode = errorCodeForUploadRejection(putResult.reason);
    // Transition is best-effort; failure here is non-fatal to the structured
    // error return (the in-flight pending manifest is itself the audit anchor).
    try {
      await store.transitionManifestStatus(run_id, abortedStatus, store.nowMs());
    } catch {
      // Swallow: the pending row remains the audit anchor; no PII leak.
    }
    return { status: 'errored', run_id, error_code: errorCode };
  }

  // Step 11 — transition manifest to `committed`.
  const committedAtMs = store.nowMs();
  await store.transitionManifestStatus(run_id, 'committed', committedAtMs);

  // Step 12 — emit `backup.manifest_written` audit row AS THE LAST step.
  // G-T16-PRIV-1: actor_pseudonym at TOP LEVEL only; never duplicated into meta.
  const auditRow: BackupManifestWrittenAuditRow = {
    event_type: 'backup.manifest_written',
    ts_ms: store.nowMs(),
    target_id: null,
    actor_pseudonym: store.systemActorPseudonym(),
    meta: {
      run_id,
      sha256,
      bytes: dump.blob.byteLength,
      retention_class: '42d',
      table_list: BACKUP_TABLES,
      status: 'committed',
      committee_data_key_kid: kid,
      audit_log_head: auditLogHead,
      per_event_row_counts: dump.per_event_row_counts,
      per_table_row_counts: dump.per_table_row_counts,
      retention_sweep_runs_snapshot_ts_ms: dump.retention_sweep_runs_snapshot_ts_ms
    }
  };
  await store.emitBackupManifestWritten(auditRow);

  return { status: 'completed', run_id, manifest_ref: object_ref };
}

/**
 * `runBackupRetentionPass` — explicit hard-delete-at-age-out pass
 * (ADR-0018 §5 step 11; Decision §9 Layer 2). The S3-compatible bucket's
 * lifecycle policy is the defense-in-depth backstop (T17.1).
 *
 * "Deletion is real deletion" — neither pseudonymizes-but-retains; both
 * hard-delete (constraints.md anchor).
 */
export async function runBackupRetentionPass(
  opts: RunBackupRetentionPassOpts
): Promise<BackupRetentionPassResult> {
  const { store } = opts;
  const nowMs = store.nowMs();
  const hardDeleteCutoffMs = BACKUP_HARD_DELETE_DAYS * BACKUP_MS_PER_DAY;

  let committed: readonly { run_id: string; object_ref: string; committed_at_ms: number }[];
  try {
    committed = await store.listCommittedManifests();
  } catch {
    return { status: 'errored', error_code: 'retention_list_failed' };
  }

  let deleted_count = 0;
  let stillLockedPastWindow = false;

  for (const m of committed) {
    if (nowMs - m.committed_at_ms < hardDeleteCutoffMs) {
      continue;
    }
    const result = await store.deleteObjectIfUnlocked(m.object_ref);
    if (result.deleted === true) {
      await store.hardDeleteManifestRow(m.run_id, store.nowMs());
      deleted_count += 1;
      continue;
    }
    // F-75: past-window manifest that the bucket still refuses to delete.
    // Surface the alert symbol; the actual sink wires in T17.1.
    if (result.deleted === false && result.reason === 'still_locked') {
      stillLockedPastWindow = true;
    }
  }

  if (stillLockedPastWindow) {
    return {
      status: 'completed',
      deleted_count,
      would_fire_alert: 'A-BACKUP-001'
    };
  }
  return { status: 'completed', deleted_count };
}
