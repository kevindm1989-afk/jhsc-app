/**
 * T17 — Backup object-lock library + MemoryBackupStore (library-only).
 *
 * Scope (per ADR-0018 + ADR-0002 Amendment H): this file pins the LIBRARY
 * half of the backup-pass contract. T17 ships TS library + MemoryBackupStore
 * only. T17.1 ships SupabaseBackupStore + the SQL migration that creates
 * `backup_manifests` + the Supabase Storage bucket (`backups-ca-central-1`)
 * with object-lock policy + pg_cron + the audit-log enum extension dance for
 * `backup.manifest_written` / `backup.hard_deleted` + A-BACKUP-001/002/003
 * alert wiring + restore runbook + HG-15 re-ratification. Items tagged
 * `[T17.1 deferred]` in this file have a library-half assertion here and the
 * full assertion in T17.1's pgTAP suite.
 *
 * F-### obligations satisfied (threat-model §3.10 "Backup posture (T17)"):
 *   - F-70 — Closed-allowlist drift (BACKUP_TABLES <-> BackupTable union).
 *                                                          [T17.1 deferred half: cross-mirror SQL drift]
 *   - F-71 — Object-lock cooperative-caller defense (NEW SURFACE).
 *                                                          [T17.1 deferred half: bucket policy ratification]
 *   - F-72 — F-24 inversion: manifest-WRITTEN-pending-before-upload state machine.
 *                                                          [T17.1 deferred half: single-tx wrapper]
 *   - F-73 — Encryption-key kid recording (ADR-0007 wrap anchor).
 *   - F-74 — Hard-delete-at-age-out explicit pass (constraints.md "Deletion is real").
 *                                                          [T17.1 deferred half: bucket lifecycle policy backstop]
 *   - F-75 — Hard-delete refusal pre-window + would_fire_alert: 'A-BACKUP-001'.
 *                                                          [T17.1 deferred half: alert-sink wire-up]
 *   - F-76 — Head-pointer extraction (RA-2 follow-up anchor).
 *                                                          [T17.1 deferred half: SQL xact_start() ordering]
 *   - F-77 — Per-event attribution preservation (G-T16-RECONCILE-CEILING).
 *   - F-78 — Hash-determinism pin on manifest sha256 (G-T11-23 lesson).
 *   - F-79 — actor_pseudonym NOT duplicated into meta (G-T16-PRIV-1).
 *                                                          [T17.1 deferred half: pgTAP column assertion]
 *   - F-80 — Manifest carries no pseudonyms (G-T16-PRIV-7).
 *                                                          [T17.1 deferred half: pgTAP column-name assertion]
 *   - F-81 — No PII in errors (G-T16-PRIV-3 / G-T11-29; constraints.md:110-111).
 *   - F-82 — Structured upload-failure rejection (G-T11-29 stub-side-effects lesson).
 *   - F-83 — RA-2 compensating control #4 preservation — LOAD-BEARING; snapshot-pinned.
 *                                                          [T17.1 deferred half: T18 integrity-job consumer]
 *   - F-84 — No caller-supplied object_ref / table_list / lock_duration_ms (F-19 generalized).
 *                                                          [Type-level half: ./fixtures/poisoned-config.ts]
 *   - F-85 — TestBackupStore interface split (G-T11-21 / G-T13-15 / G-T14-17 / G-T16-PRIV-1).
 *
 * Five cross-cutting properties pinned in dedicated `describe` blocks:
 *   (a) No caller-supplied object_ref / table_list / lock_duration_ms compiles (F-84).
 *   (b) Closed-allowlist drift fails CI (F-70).
 *   (c) Manifest pending -> committed -> audit-row write order (F-72 state machine).
 *   (d) F-83 head-pointer field present + structurally typed (snapshot-pin on field names).
 *   (e) Hard-delete refusal pre-window returns structured `still_locked` rejection (F-71 + F-75).
 *
 * Determinism contract (per test-writer system prompt):
 *   - vitest fake timers via _helpers/clock.ts.
 *   - No network. MemoryBackupStore is the entire universe.
 *   - No real RNG (run_id seeded by the store under test).
 *   - No order dependence. Each test seeds + tears down its own store.
 *   - No sleep. No retries.
 *
 * Conventions mirrored from T11/T12, T13, T14, T16:
 *   - Test-only overrides deep-imported, NOT via the public ./backup barrel
 *     (T11/T12 F-1 BLOCK lesson; T13 deep-import for `decryptBodyViaCkPrivTestOnly`;
 *     T16 deep-import for `MemoryRetentionStore` + `TestRetentionStore`).
 *   - TestBackupStore extends BackupStore; production callers narrow to the
 *     production interface and cannot reach `__force*` / `__debug*` hooks
 *     (G-T11-21 / G-T13-15 / G-T14-17 / G-T16-PRIV-1).
 *   - Closed-enum exhaustiveness with `never` cast for compile-time drift
 *     (mirrors T16's `RetentionEventType` switch).
 *
 * Failing-tests-first: the implementer has NOT written the library yet, so
 * every test in this file currently fails with "Cannot find module
 * '../../src/lib/backup/...'" or equivalent — that is the expected
 * pre-implementation posture for a four-way reviewer pass.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { freezeClock, advanceBy, restoreClock } from '../_helpers/clock';
import { FROZEN_NOW_MS } from '../_helpers/fixtures';

// Public surface — production callers consume ONLY these:
import {
  runBackupPass,
  runBackupRetentionPass,
  BACKUP_TABLES,
  BACKUP_OBJECT_LOCK_DAYS,
  BACKUP_HARD_DELETE_DAYS,
  type BackupStore,
  type BackupTable,
  type BackupManifest,
  type BackupPassConfig,
  type BackupPassResult
} from '../../src/lib/backup';

// Deep-imports — test-only override hooks live outside the public barrel
// (T11/T12 F-1 lesson; mirrored in T13 / T14 / T16). Implementer MUST keep
// these out of `apps/web/src/lib/backup/index.ts`.
import {
  MemoryBackupStore,
  type TestBackupStore
} from '../../src/lib/backup/memory-backup-store';
import { runBackupTablesDriftCheck } from '../../src/lib/backup/backup-tables';

// ---------------------------------------------------------------------------
// Local helpers — owned by THIS file. No shared global fixtures the other
// test files can mutate. (Test-writer rule: tests own their fixtures.)
// ---------------------------------------------------------------------------

/** ms-per constants used by the lock-window / hard-delete tests. */
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Synthetic user_id NOT present in `_helpers/fixtures.ts` SYNTHETIC_USER_A,
 *  so leakage into an error message is distinctive. */
const KNOWN_USER_ID_CANARY = '88888888-9999-4aaa-bbbb-cccccccccccc';
/** Synthetic concern_id with a recognisable substring that would NEVER appear
 *  in a well-behaved error message. */
const KNOWN_CONCERN_ID_CANARY = 'cccccccc-dddd-4eee-9fff-000000000001';
/** Email-shaped probe value the F-81 grep rejects in error strings. */
const EMAIL_PROBE = 'should-never-leak@jhsc-test.invalid';
/** Phone-shaped probe value (NANP test prefix) the F-81 grep rejects. */
const PHONE_PROBE = '+15555550101';
/** 32-char hex string — pseudonym shape (HMAC-SHA-256 first 16 bytes hex). */
const PSEUDONYM_SHAPE_PROBE = 'a'.repeat(32);
/** A synthetic kid the F-81 grep rejects in error strings. */
const KID_CANARY = 'kid_canary_v1';

/** Pseudonym-shape regex — 32 contiguous hex chars (HMAC-SHA-256 prefix per
 *  ADR-0016). Used by F-80 + F-81 + cross-cutting (d) field grep. */
const PSEUDONYM_SHAPE = /\b[0-9a-f]{32}\b/i;

/** The exhaustive, alphabetised list of `BACKUP_TABLES` per ADR-0018 §2.
 *  This is duplicated here on purpose: the F-70 drift test asserts the
 *  live const matches this snapshot. A future addition to the system that
 *  forgets to mirror to the §PI inventory / SQL grant / ADR-0016 schedule
 *  fails this single source of truth first. */
const EXPECTED_BACKUP_TABLES_SORTED: ReadonlyArray<string> = [
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

/** Construct a fresh MemoryBackupStore. The implementer wires the store so
 *  default construction bootstraps the canonical surfaces (empty audit_log,
 *  empty objects map, empty manifests array, a default kid). Tests that
 *  need specific surfaces use the `__*` hooks. */
function makeStore(): TestBackupStore {
  return new MemoryBackupStore();
}

/** Pull all manifests the memory store has, ordered by insert sequence. */
function getManifests(store: TestBackupStore): ReadonlyArray<BackupManifest> {
  return store.__debugListManifests();
}

/** Pull all audit rows the memory store has, ordered by insert sequence. */
function getAuditRows(store: TestBackupStore): ReadonlyArray<{
  event_type: string;
  ts_ms: number;
  target_id: string | null;
  actor_pseudonym: string;
  meta: Record<string, unknown>;
}> {
  return store.__debugListAuditRows();
}

/** Helper: pull the single committed manifest (or fail loud with a
 *  descriptive message). */
function expectExactlyOneCommittedManifest(store: TestBackupStore): BackupManifest {
  const committed = getManifests(store).filter((m) => m.status === 'committed');
  expect(
    committed.length,
    `expected exactly one committed manifest; got ${committed.length}`
  ).toBe(1);
  return committed[0]!;
}

/** Helper: pull the single `backup.manifest_written` audit row (or fail loud). */
function expectExactlyOneManifestWrittenRow(store: TestBackupStore): {
  event_type: string;
  ts_ms: number;
  target_id: string | null;
  actor_pseudonym: string;
  meta: Record<string, unknown>;
} {
  const rows = getAuditRows(store).filter((r) => r.event_type === 'backup.manifest_written');
  expect(
    rows.length,
    `expected exactly one backup.manifest_written audit row; got ${rows.length}`
  ).toBe(1);
  return rows[0]!;
}

/** Recursively walk an object and collect every string value across all keys
 *  and nested values. Used by F-80 + F-81 to grep for forbidden shapes. */
function collectAllStringValues(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string') {
      out.push(v);
      return;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (typeof v === 'object') {
      for (const key of Object.keys(v as Record<string, unknown>)) {
        out.push(key); // collect KEYS too so F-80's pseudonym field-name grep catches them
        visit((v as Record<string, unknown>)[key]);
      }
    }
  };
  visit(value);
  return out;
}

/** Collect every nested key name (recursive Object.keys). Used by F-80
 *  `/pseudonym/i` field-name search. */
function collectAllKeys(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (typeof v === 'object') {
      for (const key of Object.keys(v as Record<string, unknown>)) {
        out.push(key);
        visit((v as Record<string, unknown>)[key]);
      }
    }
  };
  visit(value);
  return out;
}

beforeEach(() => {
  freezeClock(FROZEN_NOW_MS);
});

afterEach(() => {
  restoreClock();
});

// ===========================================================================
// F-70 — Closed-allowlist drift (BACKUP_TABLES <-> BackupTable union)
//        Mirrors F-55 from T16 (RETENTION_SCHEDULE).
// ===========================================================================

describe('T17 / F-70 — BACKUP_TABLES closed-allowlist drift (mirrors F-55)', () => {
  it('T17 / F-70 (a) — BACKUP_TABLES is Object.isFrozen (defensive immutability; spread-then-mutate defense)', () => {
    expect(
      Object.isFrozen(BACKUP_TABLES),
      'BACKUP_TABLES MUST be Object.freeze([...] as const) per ADR-0018 §3'
    ).toBe(true);
  });

  it('T17 / F-70 (a) — BACKUP_TABLES content (sorted) equals the ADR-0018 §2 verbatim allowlist', () => {
    const live = [...BACKUP_TABLES].sort();
    expect(live).toEqual(EXPECTED_BACKUP_TABLES_SORTED);
  });

  it('T17 / F-70 (b) — BackupTable union exactly equals the const array element type (compile-time, runtime mirror)', () => {
    // Compile-time: the const is `as const`, so its element type IS the union.
    // The implementer wires `type BackupTable = typeof BACKUP_TABLES[number]`.
    // We mirror at runtime by asserting `BACKUP_TABLES` length matches the
    // snapshot length and every element round-trips through the union
    // discriminator without compile error.
    expect(BACKUP_TABLES.length).toBe(EXPECTED_BACKUP_TABLES_SORTED.length);
    for (const t of BACKUP_TABLES) {
      // The cast below would fail tsc if `t` was not assignable to `BackupTable`.
      const narrowed: BackupTable = t;
      expect(narrowed).toBe(t);
    }
  });

  it('T17 / F-70 (c) — runBackupTablesDriftCheck() returns {ok: true} on the canonical state', () => {
    const verdict = runBackupTablesDriftCheck();
    expect(
      verdict.ok,
      `expected drift check OK on canonical BACKUP_TABLES; got: ${JSON.stringify(verdict)}`
    ).toBe(true);
  });

  it('T17 / F-70 (c) — drift caught: removing an entry from a deep-cloned copy fails the drift check (named missing)', () => {
    // Pass a deep-cloned, mutated copy through the drift helper's
    // test-injection point. The verdict surfaces the missing key by name.
    const cloned = [...BACKUP_TABLES].filter((t) => t !== 'concerns');
    const verdict = runBackupTablesDriftCheck({ __overrideForTest: cloned });
    expect(verdict.ok).toBe(false);
    // Diagnosability: the verdict names which entry is missing.
    expect((verdict as { missing?: string[] }).missing).toContain('concerns');
  });

  it('T17 / F-70 (c) — drift caught: adding a phantom entry (not in BackupTable union) fails the drift check', () => {
    const cloned = [...BACKUP_TABLES, 'phantom_table_not_in_union'] as ReadonlyArray<string>;
    const verdict = runBackupTablesDriftCheck({ __overrideForTest: cloned });
    expect(verdict.ok).toBe(false);
    expect((verdict as { orphan?: string[] }).orphan).toContain('phantom_table_not_in_union');
  });
});

// ===========================================================================
// F-71 — Object-lock cooperative-caller defense
//        NEW SURFACE — store-side invariant: across the 42d lock window,
//        no actor (including the writing role itself) can overwrite/delete.
// ===========================================================================

describe('T17 / F-71 — Object-lock cooperative-caller defense (NEW SURFACE)', () => {
  it('T17 / F-71 (a) — isObjectLocked returns true within the lock window and false after it expires', async () => {
    const store = makeStore();
    const ref = 'backups/test/F-71-within-window.dump';
    const blob = new Uint8Array([0x01, 0x02, 0x03]);
    const lockUntilMs = FROZEN_NOW_MS + BACKUP_OBJECT_LOCK_DAYS * DAY_MS;
    const putResult = await store.putWithObjectLock(ref, blob, lockUntilMs);
    expect(putResult.committed).toBe(true);

    // Within the lock window — lock is asserted.
    expect(await store.isObjectLocked(ref)).toBe(true);

    // One ms before expiry — still locked.
    advanceBy(BACKUP_OBJECT_LOCK_DAYS * DAY_MS - 1);
    expect(await store.isObjectLocked(ref)).toBe(true);

    // At expiry boundary — released.
    advanceBy(2); // crosses lockUntilMs by 1ms
    expect(await store.isObjectLocked(ref)).toBe(false);
  });

  it('T17 / F-71 (b) — deleteObjectIfUnlocked refuses with `still_locked` inside the window; succeeds after expiry', async () => {
    const store = makeStore();
    const ref = 'backups/test/F-71-delete.dump';
    const blob = new Uint8Array([0xff]);
    const lockUntilMs = FROZEN_NOW_MS + BACKUP_OBJECT_LOCK_DAYS * DAY_MS;
    await store.putWithObjectLock(ref, blob, lockUntilMs);

    // Immediate delete attempt — refused with structured reason.
    const inside = await store.deleteObjectIfUnlocked(ref);
    expect(inside.deleted).toBe(false);
    expect((inside as { reason?: string }).reason).toBe('still_locked');

    // Advance past the lock window.
    advanceBy(BACKUP_OBJECT_LOCK_DAYS * DAY_MS + 1);
    const after = await store.deleteObjectIfUnlocked(ref);
    expect(after.deleted).toBe(true);
  });

  it('T17 / F-71 — BACKUP_OBJECT_LOCK_DAYS is 42 (ADR-0018 §6 + ADR-0012 amendment HG-8)', () => {
    expect(
      BACKUP_OBJECT_LOCK_DAYS,
      'BACKUP_OBJECT_LOCK_DAYS MUST be 42 per ADR-0018 §6 + ADR-0012 amendment HG-8; changes require three-mirror coordination'
    ).toBe(42);
  });
});

// ===========================================================================
// F-72 — F-24 inversion: manifest-WRITTEN-pending-before-upload state machine
// ===========================================================================

describe('T17 / F-72 — F-24 inversion: manifest-pending-before-upload state machine', () => {
  it('T17 / F-72 (a) — happy path: manifest is WRITTEN in pending status BEFORE the upload, transitions to committed after ACK, then the audit row is emitted LAST', async () => {
    const store = makeStore();
    const result = await runBackupPass({ store, config: { dry_run: false } });

    expect(result.status).toBe('completed');

    // Exactly one manifest exists; its final status is committed.
    const manifest = expectExactlyOneCommittedManifest(store);

    // committed_at_ms is the moment of upload-ACK; finalized_at_ms is the
    // moment of audit-row emission. Both must be present on a committed
    // manifest, and committed_at_ms must precede or equal finalized_at_ms.
    expect(manifest.committed_at_ms).not.toBeNull();
    expect(manifest.finalized_at_ms).not.toBeNull();
    expect(manifest.started_at_ms).toBeLessThanOrEqual(manifest.committed_at_ms!);
    expect(manifest.committed_at_ms!).toBeLessThanOrEqual(manifest.finalized_at_ms!);

    // The store's per-call recorder confirms the upload was attempted AFTER
    // the pending-manifest write. Order check via the recorder's sequence.
    const puts = store.__debugListPutCalls();
    expect(
      puts.length,
      `expected exactly one putWithObjectLock call on the happy path; got ${puts.length}`
    ).toBe(1);
    const pendingWriteSeq = store.__debugManifestWriteSequence();
    expect(
      pendingWriteSeq < puts[0]!.sequence,
      'manifest pending-write MUST precede putWithObjectLock per F-72 (F-24 inversion)'
    ).toBe(true);

    // The audit row is the LAST step of the pass — emitted only on committed.
    const auditRow = expectExactlyOneManifestWrittenRow(store);
    expect(auditRow.ts_ms).toBeGreaterThanOrEqual(manifest.committed_at_ms!);
  });

  it('T17 / F-72 (b) — upload failure: manifest transitions to aborted_upload_failed (or stays pending); NO backup.manifest_written audit row emitted; result returns structured `backup_upload_failed`', async () => {
    const store = makeStore();
    // Force the upload to fail with a structured rejection reason.
    store.__forceUploadFailure(true);
    const result = await runBackupPass({ store, config: { dry_run: false } });

    expect(result.status).toBe('errored');
    expect((result as { error_code?: string }).error_code).toBe('backup_upload_failed');

    // The manifest exists (audit anchor for the failed upload) but is NOT
    // in `committed` status. Per ADR-0018 §5 step 8 — the library writes
    // the manifest in `pending` first, then transitions to
    // `aborted_<reason>` on upload failure.
    const manifests = getManifests(store);
    expect(manifests.length).toBe(1);
    expect(manifests[0]!.status).not.toBe('committed');
    expect(
      ['pending', 'aborted_upload_failed', 'aborted_unknown_storage_error', 'aborted_object_lock_policy_rejected', 'aborted_cross_region_destination_refused'].includes(manifests[0]!.status),
      `unexpected manifest status on upload failure: ${manifests[0]!.status}`
    ).toBe(true);

    // The audit row is NOT emitted on aborted passes — only committed passes
    // emit the `backup.manifest_written` row (per ADR-0018 §5 step 10 +
    // G-T11-29 lesson — no silent success).
    const writtenRows = getAuditRows(store).filter(
      (r) => r.event_type === 'backup.manifest_written'
    );
    expect(
      writtenRows.length,
      'backup.manifest_written MUST NOT be emitted on an aborted pass'
    ).toBe(0);
  });
});

// ===========================================================================
// F-73 — Encryption-key kid recording (ADR-0007 wrap anchor)
// ===========================================================================

describe('T17 / F-73 — committee_data_key kid recorded on manifest', () => {
  it('T17 / F-73 — every committed manifest carries a non-empty committee_data_key_kid equal to the current kid at pass start', async () => {
    const store = makeStore();
    store.__setCurrentKid('kid_v1');
    await runBackupPass({ store, config: { dry_run: false } });
    const manifest = expectExactlyOneCommittedManifest(store);
    expect(manifest.committee_data_key_kid).toBe('kid_v1');
    expect(typeof manifest.committee_data_key_kid).toBe('string');
    expect(manifest.committee_data_key_kid.length).toBeGreaterThan(0);
  });

  it('T17 / F-73 — rotation between two passes: the second manifest records the NEW kid; the first manifest retains the OLD kid (old backups stay decryptable via historical wrap)', async () => {
    const store = makeStore();
    store.__setCurrentKid('kid_v1');
    await runBackupPass({ store, config: { dry_run: false } });
    // Advance past the lease window so the second pass is admitted.
    advanceBy(2 * HOUR_MS);
    store.__setCurrentKid('kid_v2');
    await runBackupPass({ store, config: { dry_run: false } });

    const committed = getManifests(store).filter((m) => m.status === 'committed');
    expect(committed.length).toBe(2);
    // Manifests are insertion-ordered.
    expect(committed[0]!.committee_data_key_kid).toBe('kid_v1');
    expect(committed[1]!.committee_data_key_kid).toBe('kid_v2');
  });
});

// ===========================================================================
// F-74 — Hard-delete at age-out (explicit pass; "Deletion is real")
// ===========================================================================

describe('T17 / F-74 — hard-delete at age-out (explicit retention pass)', () => {
  it('T17 / F-74 — manifests at -41d, -43d, -100d (committed): the -43d and -100d are hard-deleted (manifest + object); the -41d is preserved', async () => {
    const store = makeStore();

    // Insert three committed manifests at the requested ages. The fixture
    // helper places the corresponding object_ref into the store's objects
    // map with `unlocked_at_ms` already in the PAST (so the lock is not
    // the gating predicate — it's the manifest age vs the cutoff).
    store.__insertManifestFixture({
      run_id: 'run-41d',
      object_ref: 'backups/test/run-41d.dump',
      committed_at_ms: FROZEN_NOW_MS - 41 * DAY_MS,
      unlocked_at_ms: FROZEN_NOW_MS - 1 // already unlocked
    });
    store.__insertManifestFixture({
      run_id: 'run-43d',
      object_ref: 'backups/test/run-43d.dump',
      committed_at_ms: FROZEN_NOW_MS - 43 * DAY_MS,
      unlocked_at_ms: FROZEN_NOW_MS - 1 * DAY_MS
    });
    store.__insertManifestFixture({
      run_id: 'run-100d',
      object_ref: 'backups/test/run-100d.dump',
      committed_at_ms: FROZEN_NOW_MS - 100 * DAY_MS,
      unlocked_at_ms: FROZEN_NOW_MS - 58 * DAY_MS
    });

    await runBackupRetentionPass({ store, config: {} });

    // The -43d and -100d manifests are now hard_deleted in status; the -41d
    // remains in `committed`.
    const manifests = getManifests(store);
    const byRunId = new Map(manifests.map((m) => [m.run_id, m]));
    expect(byRunId.get('run-41d')!.status).toBe('committed');
    expect(byRunId.get('run-43d')!.status).toBe('hard_deleted');
    expect(byRunId.get('run-100d')!.status).toBe('hard_deleted');

    // Real deletion (constraints.md "Deletion is real deletion"): the
    // underlying objects are GONE from the in-memory bucket — not soft-
    // deleted, not retained under a different key.
    const objects = store.__debugListObjects();
    const refs = objects.map((o) => o.object_ref);
    expect(refs).toContain('backups/test/run-41d.dump');
    expect(refs).not.toContain('backups/test/run-43d.dump');
    expect(refs).not.toContain('backups/test/run-100d.dump');
  });

  it('T17 / F-74 — BACKUP_HARD_DELETE_DAYS is 42 (ADR-0018 §J — mirrors BACKUP_OBJECT_LOCK_DAYS)', () => {
    expect(BACKUP_HARD_DELETE_DAYS).toBe(42);
    expect(
      BACKUP_HARD_DELETE_DAYS,
      'BACKUP_HARD_DELETE_DAYS MUST equal BACKUP_OBJECT_LOCK_DAYS per ADR-0018 §J'
    ).toBe(BACKUP_OBJECT_LOCK_DAYS);
  });
});

// ===========================================================================
// F-75 — Hard-delete refusal pre-window + would_fire_alert: 'A-BACKUP-001'
// ===========================================================================

describe('T17 / F-75 — hard-delete refusal pre-window fires A-BACKUP-001 symbol', () => {
  it('T17 / F-75 — harness-forced state (manifest aged 45d but object still locked) → delete refused with `still_locked`; result carries would_fire_alert: A-BACKUP-001; manifest NOT deleted', async () => {
    const store = makeStore();
    // Harness-forced state: manifest committed 45d ago but the bucket's
    // object_lock answer says "still locked" (simulating an adversarial
    // bucket-policy mutation or a lifecycle misconfiguration where the
    // lock has not been auto-released).
    store.__insertManifestFixture({
      run_id: 'run-45d-still-locked',
      object_ref: 'backups/test/run-45d-still-locked.dump',
      committed_at_ms: FROZEN_NOW_MS - 45 * DAY_MS,
      // Lock-until is in the FUTURE — impossible under production semantics
      // (the library always computes lock_until_ms = committed_at_ms + 42d)
      // but achievable via this test mutator for the F-75 invariant.
      unlocked_at_ms: FROZEN_NOW_MS + 1 * DAY_MS
    });

    const result = await runBackupRetentionPass({ store, config: {} });

    // Library-side: the alert SYMBOL is carried in the result. The actual
    // alert sink wires in T17.1 + observability-setup.
    expect(
      (result as { would_fire_alert?: string }).would_fire_alert,
      'result.would_fire_alert MUST be "A-BACKUP-001" when a past-window manifest is refused with still_locked'
    ).toBe('A-BACKUP-001');

    // The manifest is NOT deleted — its status remains committed, and the
    // underlying object is still in the store.
    const manifest = getManifests(store).find((m) => m.run_id === 'run-45d-still-locked');
    expect(manifest).toBeDefined();
    expect(manifest!.status).toBe('committed');

    const objects = store.__debugListObjects();
    expect(objects.map((o) => o.object_ref)).toContain(
      'backups/test/run-45d-still-locked.dump'
    );
  });

  it('T17 / F-75 — normal post-window state (manifest aged 45d, lock expired) → delete succeeds; NO alert fires', async () => {
    const store = makeStore();
    store.__insertManifestFixture({
      run_id: 'run-45d-released',
      object_ref: 'backups/test/run-45d-released.dump',
      committed_at_ms: FROZEN_NOW_MS - 45 * DAY_MS,
      unlocked_at_ms: FROZEN_NOW_MS - 3 * DAY_MS
    });

    const result = await runBackupRetentionPass({ store, config: {} });

    expect((result as { would_fire_alert?: string }).would_fire_alert).toBeUndefined();
    const manifest = getManifests(store).find((m) => m.run_id === 'run-45d-released');
    expect(manifest!.status).toBe('hard_deleted');
  });
});

// ===========================================================================
// F-76 — Head-pointer extraction (RA-2 follow-up anchor)
// ===========================================================================

describe('T17 / F-76 — head-pointer extraction (RA-2 anchor)', () => {
  it('T17 / F-76 — N audit rows seeded; manifest.audit_log_head equals {id, ts_ms, hash} of the HIGHEST id at dump-start', async () => {
    const store = makeStore();
    // Seed audit rows with explicit ids + hashes. The store records the
    // insertion-ordered "highest id" as a stand-in for SQL's
    // `ORDER BY id DESC LIMIT 1`.
    const seeded = [
      { id: 'row-001', ts_ms: FROZEN_NOW_MS - 5 * HOUR_MS, hash: 'a'.repeat(64) },
      { id: 'row-002', ts_ms: FROZEN_NOW_MS - 4 * HOUR_MS, hash: 'b'.repeat(64) },
      { id: 'row-xyz', ts_ms: FROZEN_NOW_MS - 1 * HOUR_MS, hash: 'c'.repeat(64) }
    ];
    for (const r of seeded) {
      store.__debugInsertAuditChainRow({
        id: r.id,
        ts_ms: r.ts_ms,
        hash: r.hash,
        event_type: 'concern.created'
      });
    }

    await runBackupPass({ store, config: { dry_run: false } });
    const manifest = expectExactlyOneCommittedManifest(store);

    expect(manifest.audit_log_head).not.toBeNull();
    expect(manifest.audit_log_head!.id).toBe('row-xyz');
    expect(manifest.audit_log_head!.ts_ms).toBe(FROZEN_NOW_MS - 1 * HOUR_MS);
    expect(manifest.audit_log_head!.hash).toBe('c'.repeat(64));
  });

  it('T17 / F-76 — empty audit_log produces audit_log_head: null (committed manifests on empty chains are still legal)', async () => {
    const store = makeStore();
    await runBackupPass({ store, config: { dry_run: false } });
    const manifest = expectExactlyOneCommittedManifest(store);
    expect(
      manifest.audit_log_head,
      'empty audit_log MUST produce audit_log_head: null per ADR-0018 §7'
    ).toBeNull();
  });
});

// ===========================================================================
// F-77 — Per-event attribution preservation (G-T16-RECONCILE-CEILING)
// ===========================================================================

describe('T17 / F-77 — per_event_row_counts preserves per-event attribution (no __ceiling__)', () => {
  it('T17 / F-77 — manifest.per_event_row_counts has exactly the seeded event_type keys with correct counts; NO aggregate keys', async () => {
    const store = makeStore();
    // Seed audit rows across three event types: 5 + 3 + 2.
    for (let i = 0; i < 5; i++) {
      store.__debugInsertAuditChainRow({
        id: `concern-created-${i}`,
        ts_ms: FROZEN_NOW_MS - 6 * HOUR_MS,
        hash: 'a'.repeat(64),
        event_type: 'concern.created'
      });
    }
    for (let i = 0; i < 3; i++) {
      store.__debugInsertAuditChainRow({
        id: `inspection-synced-${i}`,
        ts_ms: FROZEN_NOW_MS - 5 * HOUR_MS,
        hash: 'b'.repeat(64),
        event_type: 'inspection.synced'
      });
    }
    for (let i = 0; i < 2; i++) {
      store.__debugInsertAuditChainRow({
        id: `export-generated-${i}`,
        ts_ms: FROZEN_NOW_MS - 4 * HOUR_MS,
        hash: 'c'.repeat(64),
        event_type: 'export.generated'
      });
    }

    await runBackupPass({ store, config: { dry_run: false } });
    const manifest = expectExactlyOneCommittedManifest(store);

    expect(manifest.per_event_row_counts).toEqual({
      'concern.created': 5,
      'inspection.synced': 3,
      'export.generated': 2
    });

    // No aggregate / synthetic keys.
    const keys = Object.keys(manifest.per_event_row_counts);
    expect(keys).not.toContain('__ceiling__');
    expect(keys).not.toContain('__total__');
    expect(keys).not.toContain('__all__');
    for (const k of keys) {
      expect(
        k.startsWith('__'),
        `per_event_row_counts MUST NOT contain synthetic keys like ${k}; G-T16-RECONCILE-CEILING bars aggregation`
      ).toBe(false);
    }
  });

  it('T17 / F-77 — empty audit_log → per_event_row_counts is an empty object (not null, not a sentinel)', async () => {
    const store = makeStore();
    await runBackupPass({ store, config: { dry_run: false } });
    const manifest = expectExactlyOneCommittedManifest(store);
    expect(manifest.per_event_row_counts).toEqual({});
  });
});

// ===========================================================================
// F-78 — Hash-determinism pin on manifest sha256 (G-T11-23 lesson)
// ===========================================================================

describe('T17 / F-78 — sha256 hash-determinism pin (G-T11-23)', () => {
  /**
   * The frozen-hash pin: a known-content Uint8Array `[0..255]` MUST produce
   * the well-known SHA-256 hex below. A future Node/OpenSSL upgrade that
   * silently changes the hash output fails this test BEFORE merge. This is
   * the literal G-T11-23 lesson — pinning the hex makes a toolchain shift
   * visible.
   *
   * Computed via `crypto.createHash('sha256').update(Uint8Array.from(
   * Array.from({length:256}, (_,i)=>i))).digest('hex')` — this is the
   * canonical hash for the 0..255 byte sequence and is invariant across
   * SHA-256 implementations.
   */
  const KNOWN_BLOB_0_THROUGH_255_SHA256 =
    '40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880';

  it('T17 / F-78 — fixed-content blob [0..255] produces the pinned sha256 hex', async () => {
    // Validate the pinned hex against Node's native crypto first — if THIS
    // line fails, the test fixture itself is broken (not the library).
    const fixedBlob = Uint8Array.from(Array.from({ length: 256 }, (_, i) => i));
    const directHash = createHash('sha256').update(fixedBlob).digest('hex');
    expect(
      directHash,
      `the pinned hex MUST match the SHA-256 of [0..255]; if this fails the test fixture is wrong, not the library`
    ).toBe(KNOWN_BLOB_0_THROUGH_255_SHA256);

    // Now: have the store dump produce the SAME bytes, and assert the
    // manifest's sha256 matches the pinned hex.
    const store = makeStore();
    store.__setDumpBlobOverride(fixedBlob);
    await runBackupPass({ store, config: { dry_run: false } });
    const manifest = expectExactlyOneCommittedManifest(store);
    expect(manifest.sha256).toBe(KNOWN_BLOB_0_THROUGH_255_SHA256);
  });

  it('T17 / F-78 — two passes against the same fixed content produce byte-equal sha256 (determinism)', async () => {
    const fixedBlob = Uint8Array.from(Array.from({ length: 256 }, (_, i) => i));

    const store1 = makeStore();
    store1.__setDumpBlobOverride(fixedBlob);
    await runBackupPass({ store: store1, config: { dry_run: false } });
    const h1 = expectExactlyOneCommittedManifest(store1).sha256;

    const store2 = makeStore();
    store2.__setDumpBlobOverride(fixedBlob);
    await runBackupPass({ store: store2, config: { dry_run: false } });
    const h2 = expectExactlyOneCommittedManifest(store2).sha256;

    expect(h1).toBe(h2);
  });

  it('T17 / F-78 — mutating one byte changes the sha256 (avalanche property; sanity check)', async () => {
    const blobA = Uint8Array.from(Array.from({ length: 256 }, (_, i) => i));
    const blobB = Uint8Array.from(blobA);
    blobB[0] = 0xff; // mutate one byte

    const storeA = makeStore();
    storeA.__setDumpBlobOverride(blobA);
    await runBackupPass({ store: storeA, config: { dry_run: false } });
    const hA = expectExactlyOneCommittedManifest(storeA).sha256;

    const storeB = makeStore();
    storeB.__setDumpBlobOverride(blobB);
    await runBackupPass({ store: storeB, config: { dry_run: false } });
    const hB = expectExactlyOneCommittedManifest(storeB).sha256;

    expect(hA).not.toBe(hB);
  });
});

// ===========================================================================
// F-79 — actor_pseudonym NOT duplicated into meta (G-T16-PRIV-1)
// ===========================================================================

describe('T17 / F-79 — actor_pseudonym at TOP LEVEL only (G-T16-PRIV-1)', () => {
  it('T17 / F-79 — backup.manifest_written audit row carries actor_pseudonym at the top level; meta does NOT contain actor_pseudonym', async () => {
    const store = makeStore();
    await runBackupPass({ store, config: { dry_run: false } });

    const row = expectExactlyOneManifestWrittenRow(store);

    // Top-level actor_pseudonym is the HMAC of 'system:backup-pass' — a
    // non-empty 32-char hex string per ADR-0016 + G-T16-PRIV-5.
    expect(typeof row.actor_pseudonym).toBe('string');
    expect(
      row.actor_pseudonym,
      `actor_pseudonym MUST be HMAC-shape (32-char hex); got ${row.actor_pseudonym}`
    ).toMatch(PSEUDONYM_SHAPE);

    // The HMAC value MUST be the deterministic HMAC of 'system:backup-pass'
    // under the store's HMAC key (mirrors ADR-0017 §6 systemActorPseudonym).
    const expectedPseudonym = store.__debugSystemActorPseudonym();
    expect(row.actor_pseudonym).toBe(expectedPseudonym);

    // meta MUST NOT contain a top-level `actor_pseudonym` key.
    expect(
      'actor_pseudonym' in row.meta,
      'meta.actor_pseudonym MUST NOT exist (G-T16-PRIV-1: pseudonym at top level only)'
    ).toBe(false);
  });

  it('T17 / F-79 — deep-grep of meta for ANY 32-hex pseudonym-shape value returns zero matches', async () => {
    const store = makeStore();
    await runBackupPass({ store, config: { dry_run: false } });
    const row = expectExactlyOneManifestWrittenRow(store);

    const allStrings = collectAllStringValues(row.meta);
    for (const s of allStrings) {
      expect(
        PSEUDONYM_SHAPE.test(s),
        `meta value contained a 32-hex pseudonym-shape substring: ${s}`
      ).toBe(false);
    }
  });
});

// ===========================================================================
// F-80 — Manifest carries no pseudonyms (G-T16-PRIV-7)
// ===========================================================================

describe('T17 / F-80 — manifest carries no pseudonyms (G-T16-PRIV-7)', () => {
  it('T17 / F-80 — no field name on the committed manifest matches /pseudonym/i (recursive)', async () => {
    const store = makeStore();
    await runBackupPass({ store, config: { dry_run: false } });
    const manifest = expectExactlyOneCommittedManifest(store);

    const allKeys = collectAllKeys(manifest);
    for (const k of allKeys) {
      expect(
        /pseudonym/i.test(k),
        `manifest contained a pseudonym-shaped field name: ${k}`
      ).toBe(false);
    }
  });

  it('T17 / F-80 — no field VALUE on the committed manifest matches the 32-hex pseudonym shape (G-T16-PRIV-7 structural seal)', async () => {
    const store = makeStore();
    // Seed audit rows with a head pointer hash that is 64-char hex (NOT
    // 32-char — the chain hash is 64-char SHA-256). The pseudonym shape
    // is 32-char; a 64-char hex does NOT match `\b[0-9a-f]{32}\b` as a
    // word-boundary match unless we miscount. We assert exactly that.
    store.__debugInsertAuditChainRow({
      id: 'row-test',
      ts_ms: FROZEN_NOW_MS - 1 * HOUR_MS,
      hash: 'a'.repeat(64),
      event_type: 'concern.created'
    });
    await runBackupPass({ store, config: { dry_run: false } });
    const manifest = expectExactlyOneCommittedManifest(store);

    // Build a list of values to grep. We exclude `sha256` and
    // `audit_log_head.hash` from the grep because those ARE explicit hex
    // fields per ADR-0018 §7 (64-char SHA-256 hex). The pseudonym shape
    // is 32-char hex with word boundaries; we walk every other field.
    const valuesToGrep = collectAllStringValues({
      ...manifest,
      sha256: '<<excluded-explicit-field>>',
      audit_log_head: manifest.audit_log_head
        ? { ...manifest.audit_log_head, hash: '<<excluded-explicit-field>>' }
        : null
    });
    for (const v of valuesToGrep) {
      expect(
        PSEUDONYM_SHAPE.test(v),
        `manifest field value contained a 32-hex pseudonym-shape substring: ${v}`
      ).toBe(false);
    }
  });
});

// ===========================================================================
// F-81 — No PII in errors (G-T16-PRIV-3 / G-T11-29; constraints.md:110-111)
// ===========================================================================

describe('T17 / F-81 — no PII in error paths (constraints.md:110-111)', () => {
  /**
   * Scrub helper — returns the list of disallowed substrings/patterns that
   * MUST NOT appear in any error result or thrown message. Mirrors T16's
   * F-67 grep verbatim plus the kid canary (which is a NEW shape T17
   * introduces on the manifest).
   */
  function assertNoPII(haystack: string, where: string): void {
    const expectAbsent = (needle: string, label: string): void => {
      expect(
        haystack.includes(needle),
        `[${where}] error message leaked ${label} (${needle.slice(0, 30)}…): ${haystack}`
      ).toBe(false);
    };
    expectAbsent(KNOWN_USER_ID_CANARY, 'known user_id');
    expectAbsent(KNOWN_CONCERN_ID_CANARY, 'known concern_id');
    expectAbsent(EMAIL_PROBE, 'email');
    expectAbsent(PHONE_PROBE, 'phone');
    expectAbsent(PSEUDONYM_SHAPE_PROBE, 'pseudonym-shaped 32-hex string');
    expectAbsent(KID_CANARY, 'kid');
    // Pattern-level checks (defense in depth):
    const emailLike = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
    expect(
      emailLike.test(haystack),
      `[${where}] error contained an email-shaped substring: ${haystack}`
    ).toBe(false);
    const phoneLike = /\+1\d{10}|\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/;
    expect(
      phoneLike.test(haystack),
      `[${where}] error contained a phone-shaped substring: ${haystack}`
    ).toBe(false);
    // Pseudonym shape — 32 contiguous hex chars (HMAC-SHA-256 prefix).
    expect(
      PSEUDONYM_SHAPE.test(haystack),
      `[${where}] error contained a pseudonym-shaped 32-hex substring: ${haystack}`
    ).toBe(false);
    // *_ct field names (ciphertext fields) MUST never appear in errors.
    expect(
      /body_ct|source_name_ct|notes_ct|title_ct/.test(haystack),
      `[${where}] error mentioned a *_ct (ciphertext) field name: ${haystack}`
    ).toBe(false);
  }

  it('T17 / F-81 — upload-failure error path: result carries no PII', async () => {
    const store = makeStore();
    store.__setCurrentKid(KID_CANARY); // plant the kid canary
    store.__debugInsertAuditChainRow({
      id: KNOWN_USER_ID_CANARY, // plant a UUID canary in the chain
      ts_ms: FROZEN_NOW_MS - HOUR_MS,
      hash: 'd'.repeat(64),
      event_type: 'concern.created'
    });
    store.__forceUploadFailure(true);
    const result = await runBackupPass({ store, config: { dry_run: false } });
    expect(result.status).toBe('errored');
    assertNoPII(JSON.stringify(result), 'upload-failure result');
  });

  it('T17 / F-81 — manifest-persist failure: result carries no PII', async () => {
    const store = makeStore();
    store.__setCurrentKid(KID_CANARY);
    store.__forceManifestWriteFailure(true);
    const result = await runBackupPass({ store, config: { dry_run: false } });
    expect(result.status).toBe('errored');
    assertNoPII(JSON.stringify(result), 'manifest-write-failure result');
  });

  it('T17 / F-81 — head-pointer extraction failure: result carries no PII', async () => {
    const store = makeStore();
    store.__setCurrentKid(KID_CANARY);
    store.__forceHeadPointerFailure(true);
    const result = await runBackupPass({ store, config: { dry_run: false } });
    expect(result.status).toBe('errored');
    assertNoPII(JSON.stringify(result), 'head-pointer-failure result');
  });

  it('T17 / F-81 — kid lookup failure: result carries no PII (must not leak the kid string or any embedded canary)', async () => {
    const store = makeStore();
    store.__setCurrentKid(KID_CANARY);
    store.__forceKidLookupFailure(true);
    const result = await runBackupPass({ store, config: { dry_run: false } });
    expect(result.status).toBe('errored');
    assertNoPII(JSON.stringify(result), 'kid-lookup-failure result');
  });

  it('T17 / F-81 — retention-pass forced failure path: result carries no PII', async () => {
    const store = makeStore();
    store.__insertManifestFixture({
      run_id: 'run-100d-leaky',
      object_ref: `backups/test/${KNOWN_CONCERN_ID_CANARY}.dump`, // canary in object_ref
      committed_at_ms: FROZEN_NOW_MS - 100 * DAY_MS,
      unlocked_at_ms: FROZEN_NOW_MS - 58 * DAY_MS
    });
    store.__forceDeleteFailure(true);
    const result = await runBackupRetentionPass({ store, config: {} });
    assertNoPII(JSON.stringify(result), 'retention-pass forced-failure result');
  });
});

// ===========================================================================
// F-82 — Structured upload-failure rejection (G-T11-29)
// ===========================================================================

describe('T17 / F-82 — structured upload-failure rejection (G-T11-29)', () => {
  it('T17 / F-82 — upload returns {committed: false, reason: ...} → pass returns {status: errored, error_code: backup_upload_failed} and NEVER {status: completed}', async () => {
    const store = makeStore();
    store.__forceUploadFailure(true);
    const result = await runBackupPass({ store, config: { dry_run: false } });
    expect(result.status).toBe('errored');
    expect(result.status).not.toBe('completed');
    expect((result as { error_code?: string }).error_code).toBe('backup_upload_failed');
  });

  it('T17 / F-82 — error_code is from a closed literal union; assigning a random string fails type-check', async () => {
    const store = makeStore();
    store.__forceUploadFailure(true);
    const result = await runBackupPass({ store, config: { dry_run: false } });
    // Type-narrowing: error_code is a closed literal union. The
    // @ts-expect-error directive below would fail compile if the
    // implementer ever widened `error_code` to `string`.
    if (result.status === 'errored') {
      // @ts-expect-error — error_code is a closed literal union, not `string`.
      const _bad: 'completely_random_string' = result.error_code;
      void _bad;
    }
    expect(result.status).toBe('errored');
  });

  it('T17 / F-82 — forcing upload-failure does NOT emit a backup.manifest_written audit row (no silent success per G-T11-29 lesson)', async () => {
    const store = makeStore();
    store.__forceUploadFailure(true);
    await runBackupPass({ store, config: { dry_run: false } });
    const writtenRows = getAuditRows(store).filter(
      (r) => r.event_type === 'backup.manifest_written'
    );
    expect(writtenRows.length).toBe(0);
  });
});

// ===========================================================================
// F-83 — RA-2 compensating control #4 preservation — LOAD-BEARING
//        Snapshot-pin on the three field names (rename detection).
// ===========================================================================

describe('T17 / F-83 — RA-2 compensating control #4 preservation (LOAD-BEARING; snapshot-pin)', () => {
  it('T17 / F-83 — every committed manifest carries the three structural anchor fields with the EXACT names ADR-0018 §7 pins (snapshot-pin: rename fails CI)', async () => {
    const store = makeStore();
    store.__debugInsertAuditChainRow({
      id: 'row-anchor',
      ts_ms: FROZEN_NOW_MS - 30 * 60 * 1000,
      hash: 'e'.repeat(64),
      event_type: 'concern.created'
    });
    await runBackupPass({ store, config: { dry_run: false } });
    const manifest = expectExactlyOneCommittedManifest(store);

    // Snapshot-pin: the three field NAMES are pinned literally. A future
    // refactor that renames `audit_log_head` to `chain_head` (etc.) fails
    // this assertion BEFORE merge. Per threat-model §3.10 architect ask #3:
    // "Test obligation is a snapshot-pin (rename detection), not just an
    // existence check — that's the structural seal."
    const keys = Object.keys(manifest);
    expect(
      keys,
      'manifest MUST include the exact field name `audit_log_head` per ADR-0018 §7 (T18 reconciliation join surface)'
    ).toContain('audit_log_head');
    expect(
      keys,
      'manifest MUST include the exact field name `per_event_row_counts` per ADR-0018 §7'
    ).toContain('per_event_row_counts');
    expect(
      keys,
      'manifest MUST include the exact field name `retention_sweep_runs_snapshot_ts_ms` per ADR-0018 §7'
    ).toContain('retention_sweep_runs_snapshot_ts_ms');
  });

  it('T17 / F-83 — audit_log_head is structurally typed: {id: string, ts_ms: number, hash: string} | null', async () => {
    const store = makeStore();
    store.__debugInsertAuditChainRow({
      id: 'row-typed',
      ts_ms: FROZEN_NOW_MS - HOUR_MS,
      hash: 'f'.repeat(64),
      event_type: 'inspection.synced'
    });
    await runBackupPass({ store, config: { dry_run: false } });
    const manifest = expectExactlyOneCommittedManifest(store);

    expect(manifest.audit_log_head).not.toBeNull();
    expect(typeof manifest.audit_log_head!.id).toBe('string');
    expect(typeof manifest.audit_log_head!.ts_ms).toBe('number');
    expect(typeof manifest.audit_log_head!.hash).toBe('string');
    // The triple must carry EXACTLY these three keys — no extras leaking
    // additional structural surface that T18 might silently rely on.
    expect(Object.keys(manifest.audit_log_head!).sort()).toEqual(['hash', 'id', 'ts_ms']);
  });

  it('T17 / F-83 — per_event_row_counts is Record<string, number> (well-typed, possibly empty)', async () => {
    const store = makeStore();
    await runBackupPass({ store, config: { dry_run: false } });
    const manifest = expectExactlyOneCommittedManifest(store);

    expect(typeof manifest.per_event_row_counts).toBe('object');
    expect(manifest.per_event_row_counts).not.toBeNull();
    for (const v of Object.values(manifest.per_event_row_counts)) {
      expect(typeof v).toBe('number');
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('T17 / F-83 — retention_sweep_runs_snapshot_ts_ms is a non-zero number (ALWAYS set, even on a fresh project)', async () => {
    const store = makeStore();
    await runBackupPass({ store, config: { dry_run: false } });
    const manifest = expectExactlyOneCommittedManifest(store);

    expect(typeof manifest.retention_sweep_runs_snapshot_ts_ms).toBe('number');
    expect(
      manifest.retention_sweep_runs_snapshot_ts_ms,
      'retention_sweep_runs_snapshot_ts_ms MUST NEVER be zero on a committed manifest (per ADR-0018 §7 / threat-model §3.10 F-83)'
    ).toBeGreaterThan(0);
  });
});

// ===========================================================================
// F-84 — No caller-supplied object_ref / table_list / lock_duration_ms
//        Type-level half lives in `./fixtures/poisoned-config.ts`.
// ===========================================================================

describe('T17 / F-84 — no caller-supplied object_ref / table_list / lock_duration_ms (F-19 generalized)', () => {
  it('T17 / F-84 — BackupPassConfig surface (runtime arity): runBackupPass accepts only {store, config}; config supports only dry_run + lease_window_ms', () => {
    // The poisoned-config fixture (`./fixtures/poisoned-config.ts`) is the
    // compile-time half. This runtime check pins arity + structural
    // intent. The signature has exactly 1 arg: an object literal.
    expect(typeof runBackupPass).toBe('function');
    expect(runBackupPass.length).toBe(1);
    expect(typeof runBackupRetentionPass).toBe('function');
    expect(runBackupRetentionPass.length).toBe(1);
  });

  it('T17 / F-84 — runBackupPass computes lock_until_ms exclusively via BACKUP_OBJECT_LOCK_DAYS (intercepted via __debugListPutCalls)', async () => {
    const store = makeStore();
    await runBackupPass({ store, config: { dry_run: false } });
    const puts = store.__debugListPutCalls();
    expect(puts.length).toBe(1);
    const computedLockUntil = FROZEN_NOW_MS + BACKUP_OBJECT_LOCK_DAYS * DAY_MS;
    // The library MUST compute lock_until_ms = nowMs + 42d exclusively
    // (per ADR-0018 §6). Any deviation is the cooperative-caller weakening
    // surface F-71 + F-84 guard.
    expect(
      Math.abs(puts[0]!.lock_until_ms - computedLockUntil),
      `expected lock_until_ms ≈ nowMs + ${BACKUP_OBJECT_LOCK_DAYS}d; got delta ${puts[0]!.lock_until_ms - computedLockUntil}`
    ).toBeLessThanOrEqual(1);
  });

  it('T17 / F-84 — TypeScript rejects unknown properties on BackupPassConfig (compile-time excess-property check)', () => {
    const store = makeStore();
    // @ts-expect-error — `object_ref` is NOT on BackupPassConfig per ADR-0018 §11.
    const _badObjectRef: BackupPassConfig = { dry_run: false, object_ref: 'attacker/path' };
    // @ts-expect-error — `table_list` is NOT on BackupPassConfig per ADR-0018 §11.
    const _badTableList: BackupPassConfig = { dry_run: false, table_list: ['audit_log'] };
    // @ts-expect-error — `lock_duration_ms` is NOT on BackupPassConfig per ADR-0018 §6.
    const _badLock: BackupPassConfig = { dry_run: false, lock_duration_ms: 1000 };
    void _badObjectRef;
    void _badTableList;
    void _badLock;
    void store; // anchor
  });
});

// ===========================================================================
// F-85 — TestBackupStore interface split (G-T11-21 / G-T13-15 / G-T14-17 / G-T16-PRIV-1)
// ===========================================================================

describe('T17 / F-85 — BackupStore vs TestBackupStore interface split', () => {
  it('T17 / F-85 — BackupStore (production interface) has zero `__` properties at the type level', () => {
    const store: BackupStore = makeStore();
    const narrowed = store as BackupStore & Record<string, unknown>;
    // The PRODUCTION interface MUST NOT declare these keys. We confirm at
    // compile time via @ts-expect-error directives; tsc fails the build if
    // any of the suppressed lines actually type-checks (which would mean
    // the implementer leaked a `__*` hook onto BackupStore).
    // @ts-expect-error — `__debugListManifests` is not on BackupStore.
    void narrowed.__debugListManifests;
    // @ts-expect-error — `__forceUploadFailure` is not on BackupStore.
    void narrowed.__forceUploadFailure;
    // @ts-expect-error — `__setCurrentKid` is not on BackupStore.
    void narrowed.__setCurrentKid;
    // @ts-expect-error — `__advanceObjectLockClock` is not on BackupStore.
    void narrowed.__advanceObjectLockClock;
    // @ts-expect-error — `__insertManifestFixture` is not on BackupStore.
    void narrowed.__insertManifestFixture;
    // @ts-expect-error — `__debugListPutCalls` is not on BackupStore.
    void narrowed.__debugListPutCalls;
    // @ts-expect-error — `__debugListAuditRows` is not on BackupStore.
    void narrowed.__debugListAuditRows;
  });

  it('T17 / F-85 — TestBackupStore extends BackupStore and adds the `__*` test mutators (architect-listed set)', () => {
    const ts: TestBackupStore = makeStore();
    // Test-only mutators (per task spec — "__forceUploadFailure,
    // __setCurrentKid, __advanceObjectLockClock, __insertManifestFixture"):
    expect(typeof ts.__forceUploadFailure).toBe('function');
    expect(typeof ts.__setCurrentKid).toBe('function');
    expect(typeof ts.__insertManifestFixture).toBe('function');
    // Production methods inherited from BackupStore:
    expect(typeof ts.putWithObjectLock).toBe('function');
    expect(typeof ts.isObjectLocked).toBe('function');
    expect(typeof ts.deleteObjectIfUnlocked).toBe('function');
  });

  it('T17 / F-85 — narrowing a BackupStore reference back to TestBackupStore fails type-check', () => {
    const productionShape: BackupStore = makeStore();
    // @ts-expect-error — narrowing a BackupStore reference to TestBackupStore is unsafe.
    const _t: TestBackupStore = productionShape;
    expect(_t).toBeDefined(); // anchor (runtime always passes; tsc enforces)
  });

  it('T17 / F-85 — the public index barrel does NOT re-export MemoryBackupStore, TestBackupStore, or any `__` symbol', async () => {
    const indexModule = await import('../../src/lib/backup');
    const exportedKeys = Object.keys(indexModule);
    // Public surface (closed allowlist):
    expect(exportedKeys).toContain('runBackupPass');
    expect(exportedKeys).toContain('runBackupRetentionPass');
    expect(exportedKeys).toContain('BACKUP_TABLES');
    expect(exportedKeys).toContain('BACKUP_OBJECT_LOCK_DAYS');
    expect(exportedKeys).toContain('BACKUP_HARD_DELETE_DAYS');
    // Forbidden re-exports (deep-import surface only):
    expect(exportedKeys).not.toContain('MemoryBackupStore');
    expect(exportedKeys).not.toContain('TestBackupStore');
    for (const k of exportedKeys) {
      expect(
        k.startsWith('__'),
        `public barrel re-exported a __ symbol (${k}); per T11/T12 F-1 BLOCK lesson these must be deep-import only`
      ).toBe(false);
    }
  });
});

// ===========================================================================
// Cross-cutting (a) — No caller-supplied object_ref / table_list /
//                    lock_duration_ms compiles (mirrors F-84).
// ===========================================================================

describe('T17 / cross-cutting (a) — no caller-supplied config compiles', () => {
  it('T17 / cross-cutting (a) — BackupStore exposes only the closed allowlist of methods (no escape hatch via predicate/raw_sql/exec_sql)', () => {
    const store: BackupStore = makeStore();
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(store)).filter(
      (n) => typeof (store as unknown as Record<string, unknown>)[n] === 'function'
    );
    const forbiddenSubstrings = [
      'where',
      'predicate',
      'filter',
      'raw_sql',
      'exec_sql',
      'execute_sql',
      'arbitrary'
    ];
    for (const m of methodNames) {
      for (const f of forbiddenSubstrings) {
        expect(
          m.toLowerCase().includes(f),
          `BackupStore method "${m}" matches forbidden substring "${f}"; no caller-supplied predicate path`
        ).toBe(false);
      }
    }
  });

  it('T17 / cross-cutting (a) — @ts-expect-error smoke: each of the three forbidden fields fails compile when added to BackupPassConfig', () => {
    // The dedicated poisoned-config fixture file lives at
    // `./fixtures/poisoned-config.ts` and provides the full tsc --noEmit
    // surface. This inline smoke proves the same property at the spot
    // where the test reader can see it.
    // @ts-expect-error — F-84: lock_duration_ms forbidden.
    const _a: BackupPassConfig = { lock_duration_ms: 1 };
    // @ts-expect-error — F-84: object_ref forbidden.
    const _b: BackupPassConfig = { object_ref: 'x' };
    // @ts-expect-error — F-84: table_list forbidden.
    const _c: BackupPassConfig = { table_list: ['audit_log'] };
    void _a;
    void _b;
    void _c;
  });
});

// ===========================================================================
// Cross-cutting (b) — Closed-allowlist drift fails CI (mirrors F-70).
// ===========================================================================

describe('T17 / cross-cutting (b) — closed-allowlist drift fails CI', () => {
  it('T17 / cross-cutting (b) — removing one entry from a deep-cloned BACKUP_TABLES copy fails drift-check (named missing)', () => {
    const cloned = [...BACKUP_TABLES].filter((t) => t !== 'audit_log');
    const verdict = runBackupTablesDriftCheck({ __overrideForTest: cloned });
    expect(verdict.ok).toBe(false);
    expect((verdict as { missing?: string[] }).missing).toContain('audit_log');
  });

  it('T17 / cross-cutting (b) — adding a phantom entry not in the BackupTable union fails drift-check (named orphan)', () => {
    const cloned = [...BACKUP_TABLES, 'phantom_orphan_table'] as ReadonlyArray<string>;
    const verdict = runBackupTablesDriftCheck({ __overrideForTest: cloned });
    expect(verdict.ok).toBe(false);
    expect((verdict as { orphan?: string[] }).orphan).toContain('phantom_orphan_table');
  });
});

// ===========================================================================
// Cross-cutting (c) — Manifest pending -> committed -> audit-row write
//                    order (F-72 state machine).
// ===========================================================================

describe('T17 / cross-cutting (c) — manifest pending -> committed -> audit-row order', () => {
  it('T17 / cross-cutting (c) — happy pass: committed_at_ms exists iff the audit row exists; the audit row\'s ts_ms is >= committed_at_ms', async () => {
    const store = makeStore();
    await runBackupPass({ store, config: { dry_run: false } });

    const manifest = expectExactlyOneCommittedManifest(store);
    const auditRow = expectExactlyOneManifestWrittenRow(store);

    // The order assertion (per task spec verbatim): "at any in-flight
    // inspection point, if committed_at_ms is set, the audit row exists."
    expect(manifest.committed_at_ms).not.toBeNull();
    expect(auditRow).toBeDefined();
    expect(auditRow.ts_ms).toBeGreaterThanOrEqual(manifest.committed_at_ms!);
  });

  it('T17 / cross-cutting (c) — aborted pass: manifest is in aborted_* or pending status AND NO audit row exists (no false-completion claim)', async () => {
    const store = makeStore();
    store.__forceUploadFailure(true);
    const result = await runBackupPass({ store, config: { dry_run: false } });
    expect(result.status).toBe('errored');

    const manifest = getManifests(store)[0]!;
    expect(manifest.status).not.toBe('committed');

    const auditRows = getAuditRows(store).filter(
      (r) => r.event_type === 'backup.manifest_written'
    );
    expect(auditRows.length).toBe(0);
  });
});

// ===========================================================================
// Cross-cutting (d) — F-83 head-pointer field is present and structurally
//                    typed (snapshot-pin on the manifest structural shape).
// ===========================================================================

describe('T17 / cross-cutting (d) — F-83 RA-2 anchor field snapshot-pin', () => {
  /**
   * Snapshot-pin on the THREE structural anchor field names. A future
   * refactor that renames any of these fails CI BEFORE merge. The pin is
   * the literal field name + the JavaScript typeof of its value (or 'null'
   * when null). This is the "structural seal" the threat-modeler calls
   * load-bearing.
   */
  it('T17 / cross-cutting (d) — manifest structural shape pin: {audit_log_head, per_event_row_counts, retention_sweep_runs_snapshot_ts_ms} are present with the correct typeof', async () => {
    const store = makeStore();
    store.__debugInsertAuditChainRow({
      id: 'row-d',
      ts_ms: FROZEN_NOW_MS - 5 * 60 * 1000,
      hash: '1'.repeat(64),
      event_type: 'concern.created'
    });
    await runBackupPass({ store, config: { dry_run: false } });
    const manifest = expectExactlyOneCommittedManifest(store);

    // Inline snapshot of the structural shape: field name + typeof value.
    // The snapshot is small + stable; never timestamp-bearing. Any rename
    // fails this assertion explicitly.
    const shape = {
      audit_log_head: manifest.audit_log_head === null ? 'null' : typeof manifest.audit_log_head,
      per_event_row_counts: typeof manifest.per_event_row_counts,
      retention_sweep_runs_snapshot_ts_ms: typeof manifest.retention_sweep_runs_snapshot_ts_ms
    };
    expect(shape).toEqual({
      audit_log_head: 'object',
      per_event_row_counts: 'object',
      retention_sweep_runs_snapshot_ts_ms: 'number'
    });
  });

  it('T17 / cross-cutting (d) — across a fixture suite of multiple committed manifests, every one carries the three anchor fields', async () => {
    const store = makeStore();
    // Run three back-to-back passes (advancing past the lease window
    // between each) and snapshot-pin every committed manifest's shape.
    for (let i = 0; i < 3; i++) {
      await runBackupPass({ store, config: { dry_run: false } });
      advanceBy(2 * HOUR_MS);
    }
    const committed = getManifests(store).filter((m) => m.status === 'committed');
    expect(committed.length).toBeGreaterThanOrEqual(3);
    for (const m of committed) {
      expect(Object.keys(m)).toContain('audit_log_head');
      expect(Object.keys(m)).toContain('per_event_row_counts');
      expect(Object.keys(m)).toContain('retention_sweep_runs_snapshot_ts_ms');
      expect(typeof m.retention_sweep_runs_snapshot_ts_ms).toBe('number');
      expect(m.retention_sweep_runs_snapshot_ts_ms).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// Cross-cutting (e) — Hard-delete refusal pre-window returns structured
//                    `still_locked` rejection (F-71 + F-75).
//                    Boundary-day triple: 41d, 42d, 43d.
// ===========================================================================

describe('T17 / cross-cutting (e) — hard-delete refusal pre-window boundary triple', () => {
  it('T17 / cross-cutting (e) — boundary triple: at 41d the manifest is preserved; at 42d (boundary) it is deleted; at 43d it is deleted', async () => {
    const store = makeStore();

    // -41d: committed_at_ms = now - 41d; lock_until_ms = committed_at_ms + 42d
    //       → lock_until_ms is in the future (now + 1d). MUST be preserved.
    store.__insertManifestFixture({
      run_id: 'cce-41d',
      object_ref: 'backups/cce/run-41d.dump',
      committed_at_ms: FROZEN_NOW_MS - 41 * DAY_MS,
      unlocked_at_ms: FROZEN_NOW_MS - 41 * DAY_MS + BACKUP_OBJECT_LOCK_DAYS * DAY_MS
      // i.e. now + 1d
    });

    // -42d: committed_at_ms = now - 42d; lock_until_ms = exactly now.
    //       The boundary is "lock has just expired"; MUST be deletable.
    store.__insertManifestFixture({
      run_id: 'cce-42d',
      object_ref: 'backups/cce/run-42d.dump',
      committed_at_ms: FROZEN_NOW_MS - 42 * DAY_MS,
      unlocked_at_ms: FROZEN_NOW_MS - 1 // already in the past by 1ms
    });

    // -43d: committed_at_ms = now - 43d; lock_until_ms = now - 1d.
    //       Past the lock; MUST be deletable.
    store.__insertManifestFixture({
      run_id: 'cce-43d',
      object_ref: 'backups/cce/run-43d.dump',
      committed_at_ms: FROZEN_NOW_MS - 43 * DAY_MS,
      unlocked_at_ms: FROZEN_NOW_MS - 1 * DAY_MS
    });

    await runBackupRetentionPass({ store, config: {} });

    const byRunId = new Map(getManifests(store).map((m) => [m.run_id, m]));
    expect(byRunId.get('cce-41d')!.status).toBe('committed');
    expect(byRunId.get('cce-42d')!.status).toBe('hard_deleted');
    expect(byRunId.get('cce-43d')!.status).toBe('hard_deleted');

    // Underlying objects: 41d preserved; 42d + 43d gone.
    const refs = store.__debugListObjects().map((o) => o.object_ref);
    expect(refs).toContain('backups/cce/run-41d.dump');
    expect(refs).not.toContain('backups/cce/run-42d.dump');
    expect(refs).not.toContain('backups/cce/run-43d.dump');
  });

  it('T17 / cross-cutting (e) — structured rejection shape: deleteObjectIfUnlocked returns {deleted: false, reason: "still_locked"} on a locked object (no thrown error; reason is the literal string)', async () => {
    const store = makeStore();
    const ref = 'backups/cce/locked.dump';
    await store.putWithObjectLock(
      ref,
      new Uint8Array([0]),
      FROZEN_NOW_MS + BACKUP_OBJECT_LOCK_DAYS * DAY_MS
    );
    const result = await store.deleteObjectIfUnlocked(ref);
    expect(result.deleted).toBe(false);
    expect((result as { reason?: string }).reason).toBe('still_locked');
    // Defense-in-depth: the structured rejection is a known-literal union,
    // never a thrown error or an undefined return.
    expect(result).toMatchObject({ deleted: false, reason: 'still_locked' });
  });
});

// ===========================================================================
// AC TRACEABILITY (for the four-way reviewer pass)
//
// Each architect AC (F-70..F-85) maps to at least one test above:
//   F-70 -> T17 / F-70 (a)-(c) + cross-cutting (b)
//   F-71 -> T17 / F-71 (a)-(b) + the BACKUP_OBJECT_LOCK_DAYS pin + cross-cutting (e)
//   F-72 -> T17 / F-72 (a)-(b) + cross-cutting (c)
//   F-73 -> T17 / F-73 (single + rotation between passes)
//   F-74 -> T17 / F-74 (age-boundary + hard-delete constant pin)
//   F-75 -> T17 / F-75 (refusal + no-alert) + cross-cutting (e)
//   F-76 -> T17 / F-76 (highest-id + empty chain)
//   F-77 -> T17 / F-77 (5+3+2 histogram + empty chain)
//   F-78 -> T17 / F-78 (pinned hex + determinism + avalanche)
//   F-79 -> T17 / F-79 (top-level present + meta deep-grep)
//   F-80 -> T17 / F-80 (field-name grep + value grep)
//   F-81 -> T17 / F-81 (5 forced-error paths + retention forced-delete)
//   F-82 -> T17 / F-82 (no false completion + closed literal union + no audit row)
//   F-83 -> T17 / F-83 (snapshot-pin + structural shape + non-zero) + cross-cutting (d)
//   F-84 -> T17 / F-84 (arity + computed lock_until_ms + ts-expect-error inline)
//                + ./fixtures/poisoned-config.ts (tsc --noEmit fail half)
//                + cross-cutting (a)
//   F-85 -> T17 / F-85 (BackupStore @ts-expect-error + TestBackupStore + barrel grep)
// ===========================================================================
