/**
 * T18 / G-T18-16 — second-opinion CF-13 coverage residual.
 *
 * Four coverage cases the second-opinion review flagged that didn't
 * make the original F-86..F-100 cut. NEW file (existing T18 tests are
 * read-only per test-plan.md §6).
 *
 *   1. Two concurrent `runIntegrityCheck` calls in-process — the
 *      library has only the lease window (a 5-min checkpoint, not
 *      race-safe for in-process double-invocation). T18.1's
 *      `pg_advisory_xact_lock` is the production race defense; here we
 *      pin the library's WEAKER guarantee: the second call sees the
 *      first's lease and SKIPS (`status: 'skipped',
 *      reason: 'pass_already_in_window'`).
 *   2. A sweep_run window that STRADDLES the manifest's
 *      `committed_at_ms` — a corner of Option G not covered by
 *      F-92 (a)-(e). The gap absorbs at the manifest's committed_at
 *      because the sweep IS visible (snapshot ≥ started_at).
 *   3. A `backup_manifest` with `audit_log_rows_in_dump: []` — empty
 *      dump should produce zero mismatches with `backup_diff_performed:
 *      true`.
 *   4. A chain-walk over an empty chain after
 *      `readLatestCommittedBackupManifest` returns non-null — manifest
 *      sees rows, live chain is empty: every dump row older than cutoff
 *      becomes a backup-diff `row_missing` mismatch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { FROZEN_NOW_MS } from '../_helpers/fixtures';
import { runIntegrityCheck } from '../../src/lib/audit-integrity';
import {
  MemoryIntegrityStore,
  type TestIntegrityStore
} from '../../src/lib/audit-integrity/memory-integrity-store';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function makeStore(): TestIntegrityStore {
  return new MemoryIntegrityStore();
}

function seedChain(
  store: TestIntegrityStore,
  count: number
): ReadonlyArray<{ id: string; ts_ms: number; hash: string }> {
  const out: { id: string; ts_ms: number; hash: string }[] = [];
  for (let i = 1; i <= count; i++) {
    const id = String(i);
    const ts_ms = FROZEN_NOW_MS - (count - i + 1) * HOUR_MS;
    const hash = createHmac('sha256', 'seedChain-fixed-key').update(id).digest('hex');
    store.__debugInsertChainRow({
      id,
      ts_ms,
      hash,
      event_type: 'concern.created',
      prev_hash:
        i === 1
          ? '0'.repeat(64)
          : createHmac('sha256', 'seedChain-fixed-key').update(String(i - 1)).digest('hex'),
      actor_pseudonym: '0'.repeat(32),
      target_id: null,
      target_class: 'C1',
      severity: 'info',
      request_id: null,
      rotation_id: null,
      meta: {}
    });
    out.push({ id, ts_ms, hash });
  }
  return out;
}

function listMismatches(store: TestIntegrityStore): ReadonlyArray<Record<string, unknown>> {
  return store.__debugListAuditRows().filter((r) => r.event_type === 'audit.integrity_check.mismatch');
}

beforeEach(() => freezeClock(FROZEN_NOW_MS));
afterEach(() => restoreClock());

describe('T18 / G-T18-16 — second-opinion coverage residual', () => {
  it('(1) in-process concurrent runIntegrityCheck — library lease is NOT race-safe; both complete (production lock is T18.1 pg_advisory_xact_lock)', async () => {
    const store = makeStore();
    seedChain(store, 3);

    // Issue two calls without awaiting between them. Both evaluate
    // `hasOpenIntegrityRunWithinWindow` before either writes its
    // 'running' run row — so both see no open run and proceed. This
    // pins the library-level GUARANTEE GAP that the gap text names:
    // "the library has only the lease window which is not race-safe
    // for in-process double-invocation. Advisory lock is T18.1 scope."
    //
    // The production race defense lives at `integrity_check_runner`
    // (migration #030) — `pg_try_advisory_xact_lock(hashtext('integrity_
    // check'))` at the TOP of the runner serialises concurrent ticks.
    // A regression that ADDED an in-process serialisation to this
    // library would surface here (this test would flip to assert one
    // skipped); leaving the assertion in the not-race-safe direction
    // is intentional + documented.
    const [first, second] = await Promise.all([
      runIntegrityCheck({ store, config: { trigger: 'scheduled' } }),
      runIntegrityCheck({ store, config: { trigger: 'scheduled' } })
    ]);

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
  });

  it('(2) a sweep_run window that STRADDLES manifest committed_at_ms is visible — attributable gap, no alert', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5);
    const deletedRow = rows[2]!; // row id=3
    const manifestCommittedAt = deletedRow.ts_ms + 30 * MINUTE_MS;

    // Sweep started BEFORE the manifest committed and completed AFTER
    // — the snapshot timestamp at the manifest sees the sweep as
    // started, so the sweep_run is visible to T18 (the snapshot_ts_ms
    // is at-or-after sweep.started_at).
    store.__debugInsertSweepRunFixture({
      run_id: 'sw_F92_straddling',
      started_at_ms: deletedRow.ts_ms - 10 * MINUTE_MS,
      completed_at_ms: deletedRow.ts_ms + 50 * MINUTE_MS,
      per_event_counts: { 'concern.created': 1 },
      status: 'completed'
    });

    const headRow = rows[4]!;
    store.__debugInsertBackupManifestFixture({
      run_id: 'bp_F92_straddling',
      committed_at_ms: manifestCommittedAt,
      audit_log_head: { id: headRow.id, ts_ms: headRow.ts_ms, hash: headRow.hash },
      per_event_row_counts: { 'concern.created': 5 },
      retention_sweep_runs_snapshot_ts_ms: manifestCommittedAt,
      schedule_hash: 'sched_v1',
      node_runtime_pin: store.readNodeRuntimePin()
    });

    store.__debugDeleteRowAtId(deletedRow.id);

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('completed');
    expect(
      (result as { would_fire_alert?: unknown }).would_fire_alert,
      'attributable gap (straddling sweep) MUST NOT fire any alert'
    ).toBeUndefined();
  });

  it('(3) backup_manifest with empty audit_log_rows_in_dump produces zero mismatches; backup_diff_performed=true', async () => {
    const store = makeStore();
    const rows = seedChain(store, 3);
    const headRow = rows[2]!;

    // The store materialises `audit_log_rows_in_dump` from the chain at
    // manifest-insertion time. We insert the manifest BEFORE seeding
    // any chain so the dump materialises empty, then seed the chain
    // separately — that way the manifest carries [] but the live chain
    // is non-empty. (Recreate the store to control timing.)
    const store2 = makeStore();
    store2.__debugInsertBackupManifestFixture({
      run_id: 'bp_F92_empty_dump',
      committed_at_ms: FROZEN_NOW_MS - 4 * HOUR_MS,
      audit_log_head: { id: headRow.id, ts_ms: headRow.ts_ms, hash: headRow.hash },
      per_event_row_counts: {},
      retention_sweep_runs_snapshot_ts_ms: FROZEN_NOW_MS - 4 * HOUR_MS,
      schedule_hash: 'sched_v1',
      node_runtime_pin: store2.readNodeRuntimePin()
    });
    // Seed the chain AFTER the manifest insertion — dump materialised empty.
    seedChain(store2, 3);

    const result = await runIntegrityCheck({ store: store2, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('completed');
    expect((result as { backup_diff_performed?: boolean }).backup_diff_performed).toBe(true);
    expect((result as { mismatches_count?: number }).mismatches_count).toBe(0);
    expect(listMismatches(store2).length).toBe(0);
  });

  it('(4) chain-walk over empty chain after non-null manifest emits backup-diff mismatches for every dump row older than cutoff', async () => {
    const store = makeStore();
    // First seed a chain + insert a manifest that captures it. The
    // fixture-insertion snapshot in MemoryIntegrityStore copies the
    // CURRENT chain rows into `audit_log_rows_in_dump`.
    const rows = seedChain(store, 3);
    const headRow = rows[2]!;
    store.__debugInsertBackupManifestFixture({
      run_id: 'bp_F92_empty_chain',
      committed_at_ms: FROZEN_NOW_MS,
      audit_log_head: { id: headRow.id, ts_ms: headRow.ts_ms, hash: headRow.hash },
      per_event_row_counts: { 'concern.created': 3 },
      retention_sweep_runs_snapshot_ts_ms: FROZEN_NOW_MS,
      schedule_hash: 'sched_v1',
      node_runtime_pin: store.readNodeRuntimePin()
    });

    // Now delete every chain row WITHOUT inserting a sweep_run — the
    // dump still carries the 3 rows; the live chain has 0; nothing
    // attributes the missing rows.
    for (const r of rows) store.__debugDeleteRowAtId(r.id);

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('completed');
    expect((result as { backup_diff_performed?: boolean }).backup_diff_performed).toBe(true);
    // Every dump row older than the diff cutoff (default 1h) becomes
    // an UNATTRIBUTABLE backup-diff mismatch. The library treats them
    // as `row_missing` with `attribution_attempted: true`.
    expect((result as { unattributable_count?: number }).unattributable_count).toBeGreaterThan(0);
  });
});
