/**
 * T18 — F-91 LOAD-BEARING RA-2 trigger #3 pre-snapshot.
 *
 * Source obligations:
 *   - ADR-0019 Decision §5 step 8 — backup-diff detection surface.
 *   - ADR-0019 Decision §12 — `INTEGRITY_BACKUP_DIFF_BUFFER_MS = 1 hour`.
 *   - ADR-0018 §7 — backup-manifest field surface (`audit_log_head`,
 *     `per_event_row_counts`, `retention_sweep_runs_snapshot_ts_ms`,
 *     `schedule_hash`, `node_runtime_pin`, `committed_at_ms`).
 *   - RA-2 §4297 verbatim: "audit-log vs latest backup head diff for all rows
 *     whose `ts < (latest_dump_ts - 1 hour)`" — the 1h buffer is RA-2 §4297
 *     LITERAL. Do not relax without architect + threat-modeler sign-off.
 *   - threat-model §3.11 F-91 — "LOAD-BEARING for RA-2 trigger #3 …
 *     Breaking this test re-opens RA-2 by construction."
 *   - threat-model §3.11 Architect ask #1 verdict — pivot-rewrite walk-through:
 *     chain-walk alone CANNOT detect a pivot-rewrite because a chain
 *     re-hashed forward from row K is internally consistent. Only the
 *     backup-diff catches this attack.
 *   - threat-model §3.11 G-T18-RA2-PRE-SNAPSHOT carry-forward.
 *
 * =====================================================================
 *  Breaking this test re-opens RA-2 by construction (per threat-model
 *  §3.11 F-91). The 1-hour buffer is RA-2 §4297 verbatim. Do not relax
 *  without architect + threat-modeler sign-off.
 * =====================================================================
 *
 * What this file pins (architect-spec-verbatim test obligations):
 *
 *   1. SEED 50 chain rows + insert a backup-manifest fixture whose
 *      `audit_log_head` points at row 50 AND whose `committed_at_ms`
 *      makes rows older than (committed_at_ms - 1h) eligible for the
 *      backup-diff window.
 *   2. MUTATE row #5's hash directly (pivot-rewrite attack; chain re-hashed
 *      forward from row 5 would be internally consistent so chain-walk
 *      MISSES this — only backup-diff catches).
 *   3. Run integrity check with `trigger: 'scheduled'`.
 *   4. ASSERT: `audit.integrity_check.mismatch` row emitted with
 *      `meta.detected_via: 'backup_diff'`, `meta.row_id: '<row5 id>'`,
 *      `meta.expected_hash: <row 5's dump hash>`,
 *      `meta.actual_hash: <corrupted hash>`,
 *      `meta.backup_manifest_run_id: <fixture.run_id>`.
 *   5. Result carries `would_fire_alert: 'A-AUDIT-001'` (or an array
 *      containing it; F-95 distinct-cause property holds).
 *
 *   COUNTER-TEST: a row NEWER than `committed_at_ms - 1h` (inside the 1h
 *   buffer) that's mutated must NOT fire A-AUDIT-001 from backup-diff.
 *   Pin the buffer logic.
 *
 *   NULL-MANIFEST: with no committed manifest, backup-diff is SKIPPED;
 *   chain-walk proceeds independently. This is the Phase-0 / cold-start
 *   path per ADR-0019 Decision §5 step 5.
 *
 * Determinism contract (per test-writer system prompt):
 *   - vitest fake timers via _helpers/clock.ts.
 *   - No network. MemoryIntegrityStore is the entire universe.
 *   - No real RNG (run_id seeded by the store under test).
 *   - No order dependence. Each test seeds + tears down its own store.
 *   - No sleep. No retries.
 *
 * Failing-tests-first: the implementer has NOT written the library yet,
 * so every test in this file currently fails with "Cannot find module
 * '../../src/lib/audit-integrity/...'" or equivalent — that is the
 * expected pre-implementation posture for a four-way reviewer pass.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freezeClock, advanceBy, restoreClock } from '../_helpers/clock';
import { FROZEN_NOW_MS } from '../_helpers/fixtures';

// Public surface — production callers consume ONLY these:
import {
  runIntegrityCheck,
  INTEGRITY_BACKUP_DIFF_BUFFER_MS,
  INTEGRITY_MS_PER_HOUR
} from '../../src/lib/audit-integrity';

// Deep-import — test-only override hooks live outside the public barrel
// (T11/T12 F-1 + T16/T17 ESLint pattern). Implementer MUST keep these
// out of `apps/web/src/lib/audit-integrity/index.ts`.
import {
  MemoryIntegrityStore,
  type TestIntegrityStore
} from '../../src/lib/audit-integrity/memory-integrity-store';

// ---------------------------------------------------------------------------
// Local helpers — owned by THIS file. No shared global fixtures the other
// test files can mutate.
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;

/** Construct a fresh MemoryIntegrityStore. */
function makeStore(): TestIntegrityStore {
  return new MemoryIntegrityStore();
}

/** Seed N chain rows with explicit ids, ts_ms, and BLAKE2b-256-shape hashes.
 *  The store seeds prev_hash linkage internally so the resulting chain is
 *  walkable (every prev_hash matches the preceding row's hash). Each row's
 *  ts_ms is `FROZEN_NOW_MS - (N - i) * HOUR_MS` so row 1 is oldest and
 *  row N is newest. */
function seedChain(
  store: TestIntegrityStore,
  count: number,
  opts: { event_type?: string } = {}
): ReadonlyArray<{ id: string; ts_ms: number; hash: string; event_type: string }> {
  const rows: { id: string; ts_ms: number; hash: string; event_type: string }[] = [];
  for (let i = 1; i <= count; i++) {
    const ts_ms = FROZEN_NOW_MS - (count - i + 1) * HOUR_MS;
    const id = String(i);
    const hash = i.toString(16).padStart(64, '0');
    const event_type = opts.event_type ?? 'concern.created';
    store.__debugInsertChainRow({
      id,
      ts_ms,
      hash,
      event_type,
      // The store seeds prev_hash linkage; tests do not pin prev_hash
      // values explicitly here (chain-walk recompute uses the stored
      // hash for next-row prev_hash derivation).
      prev_hash: i === 1 ? '0'.repeat(64) : (i - 1).toString(16).padStart(64, '0'),
      actor_pseudonym: '0'.repeat(32),
      target_id: null,
      target_class: 'C1',
      severity: 'info',
      request_id: null,
      rotation_id: null,
      meta: {}
    });
    rows.push({ id, ts_ms, hash, event_type });
  }
  return rows;
}

/** Filter mismatch audit rows out of the store's emitted-rows list. */
function listMismatchRows(store: TestIntegrityStore): ReadonlyArray<{
  event_type: string;
  meta: Record<string, unknown>;
}> {
  return store
    .__debugListAuditRows()
    .filter((r) => r.event_type === 'audit.integrity_check.mismatch') as ReadonlyArray<{
      event_type: string;
      meta: Record<string, unknown>;
    }>;
}

/** Helper: did the result carry the alert symbol (either as a single symbol
 *  or as an element of a readonly array)? F-95 distinguishes the array
 *  vs single-symbol shape; F-91 just needs "A-AUDIT-001 is in the result". */
function resultIncludesAlert(
  result: unknown,
  symbol: 'A-AUDIT-001' | 'A-INTEGRITY-002'
): boolean {
  const r = result as { would_fire_alert?: string | readonly string[] };
  if (r.would_fire_alert === undefined) return false;
  if (typeof r.would_fire_alert === 'string') return r.would_fire_alert === symbol;
  return r.would_fire_alert.includes(symbol);
}

beforeEach(() => {
  freezeClock(FROZEN_NOW_MS);
});

afterEach(() => {
  restoreClock();
});

// ===========================================================================
// F-91 — LOAD-BEARING RA-2 PRE-SNAPSHOT
//        Pivot-rewrite attack: chain re-hashed forward from row K is
//        internally consistent (chain-walk passes). Only backup-diff catches.
//        Per threat-model §3.11 Architect ask #1 verdict + G-T18-RA2-PRE-SNAPSHOT.
// ===========================================================================

describe('T18 / F-91 — backup-diff detects pivot-rewrite (LOAD-BEARING RA-2 trigger #3)', () => {
  it('T18 / F-91 — seed 50 + manifest fixture + clock advance 1h + corrupt row 5 (older than 1h buffer) → backup_diff mismatch fires A-AUDIT-001', async () => {
    // ----------------------------------------------------------------------
    // STEP 1 — Seed 50 chain rows. Row N has ts_ms = FROZEN_NOW_MS - (50-N+1)*HOUR_MS,
    //          so row 1 is at -50h, row 5 at -46h, row 50 at -1h.
    // ----------------------------------------------------------------------
    const store = makeStore();
    const rows = seedChain(store, 50);
    const row5 = rows[4]!;
    const row50 = rows[49]!;
    // Original hashes are zero-padded hex of the id — invariant for this
    // fixture. Implementer SHOULD NOT alter the seed hash shape.
    expect(row5.hash).toBe('5'.padStart(64, '0'));
    expect(row50.hash).toBe('32'.padStart(64, '0'));

    // ----------------------------------------------------------------------
    // STEP 2 — Insert a backup-manifest fixture whose `audit_log_head` points
    //          at row 50 (id, ts_ms, hash) AND whose `committed_at_ms` is
    //          FROZEN_NOW_MS. After clock advance (step 3), rows whose
    //          ts < committed_at_ms - 1h are inside the backup-diff window.
    // ----------------------------------------------------------------------
    const manifestRunId = 'bp_F91_fixture_001';
    const committedAtMs = FROZEN_NOW_MS;
    store.__debugInsertBackupManifestFixture({
      run_id: manifestRunId,
      committed_at_ms: committedAtMs,
      audit_log_head: { id: row50.id, ts_ms: row50.ts_ms, hash: row50.hash },
      // The manifest snapshots the dump's view of the rows; the in-memory
      // store models this as the chain state AT manifest-insertion time.
      per_event_row_counts: { 'concern.created': 50 },
      retention_sweep_runs_snapshot_ts_ms: FROZEN_NOW_MS,
      schedule_hash: 'sched_v1',
      node_runtime_pin: store.readNodeRuntimePin()
    });

    // ----------------------------------------------------------------------
    // STEP 3 — Advance clock 1h + 1ms so EVERY row in the seeded chain is
    //          older than `committed_at_ms - 1h` (i.e. inside the diff window).
    //          Per ADR-0019 Decision §12 + RA-2 §4297 — buffer is 1h exactly.
    // ----------------------------------------------------------------------
    advanceBy(1 * HOUR_MS + 1);

    // Sanity-check: row 5's ts_ms is well below the cutoff.
    const cutoffTsMs = committedAtMs - INTEGRITY_BACKUP_DIFF_BUFFER_MS;
    expect(
      row5.ts_ms < cutoffTsMs,
      `row 5 (ts=${row5.ts_ms}) must be older than cutoff (${cutoffTsMs}) for the backup-diff window`
    ).toBe(true);

    // ----------------------------------------------------------------------
    // STEP 4 — Pivot-rewrite attack: mutate row 5's hash. In a real attack,
    //          the adversary would re-hash row 5 + every subsequent row to
    //          keep prev_hash linkage intact (chain-walk would then PASS).
    //          For the library test, we only need to mutate the one row —
    //          the backup-diff catches it independent of chain-walk state.
    // ----------------------------------------------------------------------
    const corruptedHash = 'deadbeef'.repeat(8); // 64-char hex; distinct from row 5's original
    store.__debugCorruptRowHash(row5.id, corruptedHash);

    // ----------------------------------------------------------------------
    // STEP 5 — Run the integrity check (scheduled trigger).
    // ----------------------------------------------------------------------
    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });

    // ----------------------------------------------------------------------
    // ASSERTIONS — backup-diff mismatch detected on row 5; alert fires.
    // ----------------------------------------------------------------------
    expect(
      result.status,
      `expected status:'completed' on a successful detection pass; got: ${JSON.stringify(result)}`
    ).toBe('completed');

    // Filter to backup_diff mismatches only (chain-walk may also fire on
    // the single-row mutation because prev_hash linkage breaks at row 6;
    // F-89 covers that; here we pin the backup_diff surface explicitly).
    const allMismatches = listMismatchRows(store);
    const backupDiffMismatches = allMismatches.filter(
      (m) => (m.meta as { detected_via: string }).detected_via === 'backup_diff'
    );
    expect(
      backupDiffMismatches.length,
      `expected ≥1 backup_diff mismatch row; got ${backupDiffMismatches.length} (all mismatches: ${JSON.stringify(allMismatches)})`
    ).toBeGreaterThanOrEqual(1);

    // The mismatch on row 5 is the load-bearing assertion.
    const row5Mismatch = backupDiffMismatches.find(
      (m) => (m.meta as { row_id: string }).row_id === row5.id
    );
    expect(
      row5Mismatch,
      `expected a backup_diff mismatch row with meta.row_id === '${row5.id}'`
    ).toBeDefined();
    const meta = row5Mismatch!.meta as Record<string, unknown>;
    expect(meta.detected_via).toBe('backup_diff');
    expect(meta.row_id).toBe(row5.id);
    expect(meta.expected_hash).toBe(row5.hash);
    expect(meta.actual_hash).toBe(corruptedHash);
    expect(meta.backup_manifest_run_id).toBe(manifestRunId);
    expect(meta.attribution_attempted).toBe(false); // live row present; reconciliation walker not run

    // Result carries the alert symbol. F-95 covers the distinct-cause shape;
    // here we accept either a single 'A-AUDIT-001' OR an array containing it.
    expect(
      resultIncludesAlert(result, 'A-AUDIT-001'),
      `expected would_fire_alert to include 'A-AUDIT-001'; got: ${JSON.stringify((result as { would_fire_alert?: unknown }).would_fire_alert)}`
    ).toBe(true);
  });

  // ===========================================================================
  // F-91 COUNTER-TEST — a row NEWER than `committed_at_ms - 1h` (inside the
  // 1h buffer) that's mutated must NOT fire A-AUDIT-001 from backup-diff.
  // Pin the buffer logic. RA-2 §4297 verbatim — "rows whose ts < (latest_dump_ts
  // - 1 hour)" — rows INSIDE the buffer are STRUCTURALLY EXCLUDED.
  // ===========================================================================

  it('T18 / F-91 (counter-test) — corrupting a row INSIDE the 1h buffer does NOT fire backup_diff (no false-positive on fresh rows)', async () => {
    const store = makeStore();

    // Seed 5 rows all in the LAST hour. Row 1 at -50min, row 2 at -40min, ...
    // row 5 at -10min. None of them are older than (committed_at_ms - 1h).
    const rows: { id: string; ts_ms: number; hash: string; event_type: string }[] = [];
    for (let i = 1; i <= 5; i++) {
      const ts_ms = FROZEN_NOW_MS - (60 - i * 10) * 60 * 1000; // -50m, -40m, -30m, -20m, -10m
      const id = `inside-buf-${i}`;
      const hash = i.toString(16).padStart(64, '0');
      store.__debugInsertChainRow({
        id,
        ts_ms,
        hash,
        event_type: 'concern.created',
        prev_hash: i === 1 ? '0'.repeat(64) : (i - 1).toString(16).padStart(64, '0'),
        actor_pseudonym: '0'.repeat(32),
        target_id: null,
        target_class: 'C1',
        severity: 'info',
        request_id: null,
        rotation_id: null,
        meta: {}
      });
      rows.push({ id, ts_ms, hash, event_type: 'concern.created' });
    }
    const headRow = rows[4]!;

    // Insert manifest fixture pointing at the head, committed NOW.
    store.__debugInsertBackupManifestFixture({
      run_id: 'bp_F91_counter_001',
      committed_at_ms: FROZEN_NOW_MS,
      audit_log_head: { id: headRow.id, ts_ms: headRow.ts_ms, hash: headRow.hash },
      per_event_row_counts: { 'concern.created': 5 },
      retention_sweep_runs_snapshot_ts_ms: FROZEN_NOW_MS,
      schedule_hash: 'sched_v1',
      node_runtime_pin: store.readNodeRuntimePin()
    });

    // DO NOT advance the clock. All rows are still inside the 1h buffer.
    // Sanity check: row 2 (ts_ms = -40min) is NEWER than cutoff = committed - 1h.
    const cutoffTsMs = FROZEN_NOW_MS - INTEGRITY_BACKUP_DIFF_BUFFER_MS;
    expect(
      rows[1]!.ts_ms > cutoffTsMs,
      `row 2 (ts=${rows[1]!.ts_ms}) must be NEWER than cutoff (${cutoffTsMs}) for the counter-test`
    ).toBe(true);

    // Corrupt row 2's hash — INSIDE the buffer. backup-diff MUST NOT catch.
    store.__debugCorruptRowHash(rows[1]!.id, 'cafebabe'.repeat(8));

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });

    // backup_diff must NOT produce a mismatch for this row (the inversion).
    const backupDiffMismatchesOnRow2 = listMismatchRows(store).filter(
      (m) =>
        (m.meta as { detected_via: string }).detected_via === 'backup_diff' &&
        (m.meta as { row_id: string }).row_id === rows[1]!.id
    );
    expect(
      backupDiffMismatchesOnRow2.length,
      `backup_diff MUST NOT fire on a row newer than committed_at_ms - 1h (RA-2 §4297). got: ${JSON.stringify(backupDiffMismatchesOnRow2)}`
    ).toBe(0);
  });

  it('T18 / F-91 (counter-test) — corrupting a row INSIDE the 1h buffer still fires chain_walk (the other detection surface; F-89)', async () => {
    // Same setup as above. We assert that the chain-walk surface still
    // catches the in-place mutation — backup-diff is the buffer-excluded
    // surface; chain-walk is unconditional. This pins that backup-diff's
    // exclusion does NOT also degrade chain-walk.
    const store = makeStore();
    const rows: { id: string; ts_ms: number; hash: string; event_type: string }[] = [];
    for (let i = 1; i <= 5; i++) {
      const ts_ms = FROZEN_NOW_MS - (60 - i * 10) * 60 * 1000;
      const id = `inside-buf-cw-${i}`;
      const hash = i.toString(16).padStart(64, '0');
      store.__debugInsertChainRow({
        id,
        ts_ms,
        hash,
        event_type: 'concern.created',
        prev_hash: i === 1 ? '0'.repeat(64) : (i - 1).toString(16).padStart(64, '0'),
        actor_pseudonym: '0'.repeat(32),
        target_id: null,
        target_class: 'C1',
        severity: 'info',
        request_id: null,
        rotation_id: null,
        meta: {}
      });
      rows.push({ id, ts_ms, hash, event_type: 'concern.created' });
    }
    const headRow = rows[4]!;
    store.__debugInsertBackupManifestFixture({
      run_id: 'bp_F91_counter_cw_001',
      committed_at_ms: FROZEN_NOW_MS,
      audit_log_head: { id: headRow.id, ts_ms: headRow.ts_ms, hash: headRow.hash },
      per_event_row_counts: { 'concern.created': 5 },
      retention_sweep_runs_snapshot_ts_ms: FROZEN_NOW_MS,
      schedule_hash: 'sched_v1',
      node_runtime_pin: store.readNodeRuntimePin()
    });

    store.__debugCorruptRowHash(rows[1]!.id, 'cafebabe'.repeat(8));
    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });

    // chain_walk fires on the in-place mutation regardless of buffer.
    const chainWalkMismatches = listMismatchRows(store).filter(
      (m) => (m.meta as { detected_via: string }).detected_via === 'chain_walk'
    );
    expect(
      chainWalkMismatches.length,
      `chain_walk MUST still fire on a row mutation even when inside the backup-diff buffer (the two surfaces are independent); got ${chainWalkMismatches.length}`
    ).toBeGreaterThanOrEqual(1);
    expect(
      resultIncludesAlert(result, 'A-AUDIT-001'),
      'chain_walk mismatch still surfaces A-AUDIT-001 (F-89 contract)'
    ).toBe(true);
  });
});

// ===========================================================================
// F-91 — Null-manifest path (Phase-0 / cold-start).
//        Per ADR-0019 Decision §5 step 5: if no committed manifest exists,
//        backup-diff is SKIPPED; chain-walk proceeds independently.
// ===========================================================================

describe('T18 / F-91 — null manifest: backup-diff skipped, chain-walk proceeds independently', () => {
  it('T18 / F-91 — no manifest committed: backup-diff produces ZERO backup_diff mismatches; chain-walk still detects in-place mutation', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5);
    // No __debugInsertBackupManifestFixture call — store returns null from
    // readLatestCommittedBackupManifest, exercising the Phase-0 / cold-start
    // branch of the algorithm (ADR-0019 Decision §5 step 5).
    store.__debugCorruptRowHash(rows[2]!.id, 'badbad00'.repeat(8));

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('completed');

    const allMismatches = listMismatchRows(store);
    const backupDiffMismatches = allMismatches.filter(
      (m) => (m.meta as { detected_via: string }).detected_via === 'backup_diff'
    );
    expect(
      backupDiffMismatches.length,
      `with null manifest, backup_diff MUST NOT emit any mismatch (it is SKIPPED). got ${backupDiffMismatches.length}`
    ).toBe(0);

    // chain_walk still fires (the other detection surface).
    const chainWalkMismatches = allMismatches.filter(
      (m) => (m.meta as { detected_via: string }).detected_via === 'chain_walk'
    );
    expect(
      chainWalkMismatches.length,
      'chain_walk MUST still fire on in-place mutation even with no manifest'
    ).toBeGreaterThanOrEqual(1);

    // The result reflects that backup-diff was not performed.
    expect(
      (result as { backup_diff_performed?: boolean }).backup_diff_performed,
      'result.backup_diff_performed MUST be false when no manifest is committed'
    ).toBe(false);
  });
});

// ===========================================================================
// F-91 — Buffer-constant pin (RA-2 §4297 three-mirror coordination).
//        Changing INTEGRITY_BACKUP_DIFF_BUFFER_MS without updating RA-2
//        §4297 + this test fails CI per ADR-0019 §Reversibility.
// ===========================================================================

describe('T18 / F-91 — INTEGRITY_BACKUP_DIFF_BUFFER_MS is exactly 1 hour (RA-2 §4297)', () => {
  it('T18 / F-91 — INTEGRITY_BACKUP_DIFF_BUFFER_MS equals INTEGRITY_MS_PER_HOUR (1 hour) per ADR-0019 §12 + RA-2 §4297', () => {
    expect(
      INTEGRITY_BACKUP_DIFF_BUFFER_MS,
      'INTEGRITY_BACKUP_DIFF_BUFFER_MS MUST be 1 hour exactly per RA-2 §4297. ' +
        'Changing this requires three-mirror coordination (ADR-0019 §12 + RA-2 §4297 + this test).'
    ).toBe(INTEGRITY_MS_PER_HOUR);
    expect(INTEGRITY_BACKUP_DIFF_BUFFER_MS).toBe(60 * 60 * 1000);
  });
});

// ===========================================================================
// AC TRACEABILITY (F-91)
//
//   F-91 (LOAD-BEARING RA-2 pre-snapshot)  →
//     T18 / F-91 (pivot-rewrite on row 5)
//     T18 / F-91 (counter-test inside buffer)
//     T18 / F-91 (counter-test chain_walk still fires)
//     T18 / F-91 (null-manifest skips backup-diff)
//     T18 / F-91 (buffer-constant pin)
//
// Breaking ANY of these re-opens RA-2 trigger #3 by construction
// (per threat-model §3.11 F-91 + Architect ask #1 verdict).
// ===========================================================================
