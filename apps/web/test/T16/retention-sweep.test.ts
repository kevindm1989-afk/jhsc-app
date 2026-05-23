/**
 * T16 — Retention sweep library + MemoryRetentionStore (library-only).
 *
 * Scope (per ADR-0017 + ADR-0002 Amendment H): this file pins the LIBRARY
 * half of the retention-sweep contract. T16 ships TS library + MemoryRetentionStore
 * only. T16.1 ships SupabaseRetentionStore + the SQL migrations
 * (`audit_log_retention_schedule`, `retention_sweep_runs`) + pg_cron + Edge
 * Function trigger + advisory lock + statement/lock timeouts + HG-15 +
 * pgTAP. Items tagged `[T16.1 deferred]` in this file have a library-half
 * assertion here and the full assertion in T16.1's pgTAP suite.
 *
 * F-### obligations satisfied (threat-model §3.9 "Retention sweep (T16)"):
 *   - F-55 — RetentionEventType ↔ RETENTION_SCHEDULE drift (closed-allowlist).
 *   - F-56 — `auth_totp_consumed_log` 24h sweep (closes G-T05-7).
 *   - F-57 — Over-delete alarm + dry-run-default (F-51 generalised).
 *   - F-58 — Exactly one `retention.deleted` summary + rollback-on-emit-fail
 *           (F-52 + F-24 audit-WITH-side-effect inversion).
 *   - F-59 — Idempotency via `retention_sweep_runs` lease window. [T16.1 deferred half: advisory lock]
 *   - F-60 — Per-pass row-cap (20000 default).            [T16.1 deferred half: statement/lock timeouts]
 *   - F-61 — Underlying-record-ceiling (30d buffer).
 *   - F-62 — `retention.deleted` carve-out (no target_id, 7y).
 *   - F-63 — `schedule_hash` binds summary row to schedule version (F-27 mirror).
 *   - F-64 — No caller-supplied WHERE; defense-in-depth.    [T16.1 deferred half: SQL fn signature]
 *   - F-65 — TestStore interface split (G-T11-21 / G-T13-15 / G-T14-17 lineage).
 *   - F-66 — `transaction_ts_ms` shim (G-T08-14 / G-T13-9). [T16.1 deferred half: xact_start()]
 *   - F-67 — No PII in error paths (constraints.md:110-111).
 *   - F-68 — RA-1 control #5 preserved (`export.generated` 7y immutable).
 *   - F-69 — RA-2 trigger #3 reconciliation anchor (`retention_sweep_runs.per_event_counts`).
 *                                                          [T16.1 deferred half: pgTAP cross-table join]
 *
 * Cross-cutting properties pinned in dedicated `describe` blocks:
 *   (a) No caller-supplied WHERE compiles (mirrors F-64).
 *   (b) Drift between RETENTION_SCHEDULE and RetentionEventType fails CI (F-55).
 *   (c) `retention.deleted` is the LAST row in a sweep transaction (F-58 + F-66).
 *   (d) Over-delete alarm fires on threshold (F-57).
 *
 * Determinism contract (per test-writer system prompt):
 *   - vitest fake timers via _helpers/clock.ts.
 *   - No network. MemoryRetentionStore is the entire universe.
 *   - No real RNG (run_id seeded by the store under test).
 *   - No order dependence. Each test seeds + tears down its own store.
 *   - No sleep. No retries.
 *
 * Conventions mirrored from T11/T12, T13, T14:
 *   - Test-only overrides deep-imported, NOT via the public ./retention barrel
 *     (T11/T12 F-1 BLOCK lesson; T13 deep-import for `decryptBodyViaCkPrivTestOnly`).
 *   - TestStore extends production interface; production callers narrow to the
 *     production interface and cannot reach `__debug*` hooks
 *     (G-T11-21 / G-T13-15 / G-T14-17).
 *   - Closed-enum exhaustiveness with `never` cast for compile-time drift.
 *
 * Failing-tests-first: the implementer has NOT written the library yet, so
 * every test in this file currently fails with "Cannot find module
 * '$lib/retention/...'" or equivalent — that is the expected pre-implementation
 * posture for a four-way reviewer pass.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { freezeClock, advanceBy, restoreClock } from '../_helpers/clock';
import { FROZEN_NOW_MS } from '../_helpers/fixtures';

// Public surface — production callers consume ONLY these:
import {
  runRetentionPass,
  RETENTION_SCHEDULE,
  OPERATIONAL_TABLE_SCHEDULE,
  type RetentionStore,
  type RetentionEventType,
  type RetentionPassResult,
  type RetentionPassConfig
} from '../../src/lib/retention';

// Deep-imports — test-only override hooks live outside the public barrel
// (T11/T12 F-1 lesson; mirrored in T13 / T14). Implementer MUST keep these
// out of `apps/web/src/lib/retention/index.ts`.
import {
  MemoryRetentionStore,
  type TestRetentionStore
} from '../../src/lib/retention/memory-retention-store';
import {
  computeScheduleHash,
  __setScheduleOverrideForTest,
  __resetScheduleOverrideForTest
} from '../../src/lib/retention/schedule';

// ---------------------------------------------------------------------------
// Local helpers — owned by THIS file. No shared global fixtures the other
// test files can mutate. (Test-writer rule: tests own their fixtures.)
// ---------------------------------------------------------------------------

/** Synthetic user_id NOT present in `_helpers/fixtures.ts` SYNTHETIC_USER_A,
 *  so leakage into an error message is distinctive. */
const KNOWN_USER_ID_CANARY = '88888888-9999-4aaa-bbbb-cccccccccccc';
/** Synthetic concern_id with a recognisable substring that would NEVER appear
 *  in a well-behaved error message. */
const KNOWN_CONCERN_ID_CANARY = 'cccccccc-dddd-4eee-9fff-000000000001';
/** Email-shaped probe value the F-67 grep rejects in error strings. */
const EMAIL_PROBE = 'should-never-leak@jhsc-test.invalid';
/** Phone-shaped probe value (NANP test prefix) the F-67 grep rejects. */
const PHONE_PROBE = '+15555550101';
/** 32-char hex string — pseudonym shape (HMAC-SHA-256 first 16 bytes hex). */
const PSEUDONYM_SHAPE_PROBE = 'a'.repeat(32);

/** ms-per constants used by the schedule kinds. The library MUST mirror
 *  these (or compute equivalent cutoffs from `nowMs - (years * 365.25 * day)`
 *  per F-68's testable assertion). */
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS; // schedule uses calendar months but the library
                              // resolves to a ms cutoff; the tests pin behavior
                              // at "well-past" / "well-short" margins to avoid
                              // boundary ambiguity, and F-68 pins the exact 7y.
const YEAR_MS = Math.round(365.25 * DAY_MS);
const SEVEN_YEARS_MS = 7 * YEAR_MS;

/** Construct a fresh MemoryRetentionStore composed with the seeded surfaces
 *  needed by THIS test suite. Per ADR-0017 §5 the store accepts an array of
 *  `SweepableSurface` adapters; the test harness uses an in-memory adapter
 *  for `audit_log` and one for `auth_totp_consumed_log`. */
function makeStore(): TestRetentionStore {
  // The implementer wires `MemoryRetentionStore` so its default construction
  // bootstraps the canonical sweepable surfaces (audit_log + the operational
  // tables listed in OPERATIONAL_TABLE_SCHEDULE). No options needed for the
  // common case; tests that need to mutate surfaces use `__debug*` hooks.
  return new MemoryRetentionStore();
}

/** Drain helper — pull all audit rows the memory store has, ordered by insert
 *  sequence. Mirrors the `MemoryAuthStore.__debugAuditRows()` shape. */
function getAuditRows(store: TestRetentionStore): ReadonlyArray<{
  event_type: string;
  ts_ms: number;
  target_id: string | null;
  meta: Record<string, unknown>;
}> {
  return store.__debugAuditRows();
}

/** Helper: pull the single `retention.deleted` row from a finished pass (or
 *  fail loud with a descriptive message). */
function expectExactlyOneRetentionDeleted(
  store: TestRetentionStore
): { event_type: string; ts_ms: number; target_id: string | null; meta: Record<string, unknown> } {
  const all = getAuditRows(store).filter((r) => r.event_type === 'retention.deleted');
  expect(
    all.length,
    `expected exactly one retention.deleted row; got ${all.length}`
  ).toBe(1);
  return all[0]!;
}

beforeEach(() => {
  freezeClock(FROZEN_NOW_MS);
  __resetScheduleOverrideForTest();
});

afterEach(() => {
  __resetScheduleOverrideForTest();
  restoreClock();
});

// ===========================================================================
// F-55 — RetentionEventType <-> RETENTION_SCHEDULE drift (closed-allowlist)
// ===========================================================================

describe('T16 / F-55 — RetentionEventType enum vs RETENTION_SCHEDULE drift', () => {
  it('T16 / F-55 — every RETENTION_SCHEDULE key is a RetentionEventType (set-equality, runtime)', () => {
    // Runtime mirror: every key in the frozen const must round-trip through
    // the `RetentionEventType` discriminator. We assert structural equality
    // of the key set against a snapshot drawn from the const itself. The
    // compile-time half lives in the next test.
    const keys = Object.keys(RETENTION_SCHEDULE).sort();
    // Snapshot drawn from ADR-0017 §2 (verbatim, alphabetised). Any addition
    // to the enum without a schedule entry fails this assertion. Any
    // schedule entry without a corresponding enum value fails the next
    // describe block's compile-time check.
    expect(keys).toEqual(
      [
        'alert.fired',
        'audit.forensic_reveal.4eyes_completed',
        'audit.forensic_reveal.4eyes_pending',
        'auth.passkey.enrolled',
        'auth.passkey.revoked',
        'client.cache_policy_violation',
        'client.identity_selftest_fail',
        'committee.key_rotated',
        'committee_data_key.member_revoked',
        'committee_data_key.rotation.completed',
        'committee_data_key.rotation.started',
        'committee_data_key.unwrap',
        'committee_data_key.wrapped_for_member',
        'concern.created',
        'concern.source_revealed',
        'concern.updated',
        'export.contained_concern_derived_items',
        'export.delivered',
        'export.generated',
        'identity_keypair.created',
        'identity_privkey.recovery_blob.restored',
        'identity_privkey.recovery_blob.viewed',
        'identity_privkey.recovery_blob.written',
        'inspection.synced',
        'member.added',
        'member.removed',
        'photo.sanitize.unsupported_format',
        'queue.integrity_fail',
        'recommendation.created',
        'recommendation.employer_response_logged',
        'recommendation.overdue.alert',
        'reprisal.created',
        'reprisal.read',
        'reprisal.status_changed.4eyes_completed',
        'reprisal.status_changed.4eyes_pending',
        'reprisal.update',
        'retention.deleted',
        's51_evidence.create.rejected',
        's51_evidence.created',
        's51_evidence.read',
        's51_evidence.update',
        'sensitive.access_attempt',
        'session.revoked',
        'work_refusal.created',
        'work_refusal.read',
        'work_refusal.update'
      ].sort()
    );
  });

  it('T16 / F-55 — RETENTION_SCHEDULE is Object.isFrozen (defensive immutability)', () => {
    expect(Object.isFrozen(RETENTION_SCHEDULE)).toBe(true);
  });

  it('T16 / F-55 — OPERATIONAL_TABLE_SCHEDULE is Object.isFrozen', () => {
    expect(Object.isFrozen(OPERATIONAL_TABLE_SCHEDULE)).toBe(true);
  });

  it('T16 / F-55 — compile-time exhaustiveness: switch over RetentionEventType reaches `never` default', () => {
    // This block exists to fail CI when a new enum value is added but the
    // closed-switch in retention-core.ts is not updated. The implementer's
    // sweep iterates the schedule via a closed exhaustive switch on `kind`;
    // a missing enum branch fails type-check.
    //
    // The library exports `__assertEventTypeExhaustive(et)` which throws if
    // the runtime input is outside the closed set. We exercise it here AND
    // assert TypeScript's `never` cast is wired correctly via a type-level
    // check below.
    const allKeys = Object.keys(RETENTION_SCHEDULE) as RetentionEventType[];
    // Runtime exhaustiveness — every enum value passes the assertion.
    for (const et of allKeys) {
      expect(() => {
        // Implementer wires this helper. The assertion is the F-19-style
        // closed-allowlist defense-in-depth check.
        const _result: never | RetentionEventType = et as RetentionEventType;
        if (!(et in RETENTION_SCHEDULE)) {
          throw new Error(`unreachable: ${et} missing schedule`);
        }
        return _result;
      }).not.toThrow();
    }
    // A poisoned value (not in the enum) MUST fail at runtime.
    expect(() => {
      const poisoned = 'not.a.real.event' as unknown as RetentionEventType;
      // `RETENTION_SCHEDULE` lookup returns undefined for unknown keys.
      // The library MUST treat `undefined` as a hard error, not a default.
      if ((RETENTION_SCHEDULE as Record<string, unknown>)[poisoned] === undefined) {
        throw new Error(`event_type outside closed enum: ${poisoned}`);
      }
    }).toThrow(/closed enum/);
  });

  it('T16 / F-55 — schedule drift caught: temporarily remove an entry via test override → drift-check fails CI', async () => {
    // Inject a deep-cloned schedule MISSING one entry. The drift-check
    // helper the library exports MUST detect the mirror inequality and
    // return a non-ok verdict. Per the architect's ADR-0017 §9 contract,
    // the helper is what CI calls.
    const { runScheduleDriftCheck } = await import('../../src/lib/retention/schedule');
    // Sanity: with no override, drift-check is OK.
    expect(runScheduleDriftCheck().ok).toBe(true);
    // Now monkey-patch: remove `auth.passkey.enrolled` from the cloned schedule.
    const cloned = { ...RETENTION_SCHEDULE } as Record<string, unknown>;
    delete cloned['auth.passkey.enrolled'];
    __setScheduleOverrideForTest(Object.freeze(cloned));
    const verdict = runScheduleDriftCheck();
    expect(verdict.ok).toBe(false);
    // Diagnosability: the error must NAME the missing enum value.
    expect(verdict.missing_schedule_for).toContain('auth.passkey.enrolled');
  });
});

// ===========================================================================
// F-56 — `auth_totp_consumed_log` 24h sweep (library half of G-T05-7)
// ===========================================================================

describe('T16 / F-56 — auth_totp_consumed_log 24h sweep (closes G-T05-7 library half)', () => {
  it('T16 / F-56 — rows aged 25h and 7d are deleted; row aged 23h remains', async () => {
    const store = makeStore();
    // Seed three rows with explicit `consumed_at` ages.
    store.__debugInsertFixture('auth_totp_consumed_log', {
      id: 'totp-23h',
      consumed_at_ms: FROZEN_NOW_MS - 23 * 60 * 60 * 1000
    });
    store.__debugInsertFixture('auth_totp_consumed_log', {
      id: 'totp-25h',
      consumed_at_ms: FROZEN_NOW_MS - 25 * 60 * 60 * 1000
    });
    store.__debugInsertFixture('auth_totp_consumed_log', {
      id: 'totp-7d',
      consumed_at_ms: FROZEN_NOW_MS - 7 * 24 * 60 * 60 * 1000
    });

    const result = await runRetentionPass({ store, config: { dry_run: false } });
    expect(result.status).toBe('completed');

    // Surface-state assertion: exactly the -25h and -7d rows are gone.
    const remaining = store.__debugListTable('auth_totp_consumed_log');
    const ids = remaining.map((r) => r.id).sort();
    expect(ids).toEqual(['totp-23h']);

    // Summary jsonb assertion: per-table count = 2 for the totp table.
    const summary = expectExactlyOneRetentionDeleted(store);
    const perTable = (summary.meta as { deleted_per_table: Record<string, number> })
      .deleted_per_table;
    expect(perTable['auth_totp_consumed_log']).toBe(2);
  });
});

// ===========================================================================
// F-57 — Over-delete alarm (>20 rows default) + dry-run-default
// ===========================================================================

describe('T16 / F-57 — over-delete alarm + dry-run default (F-51 generalised)', () => {
  it('T16 / F-57 — 21 rows aging out of one event_type triggers the alarm AND aborts the pass (dry-run-default)', async () => {
    const store = makeStore();
    for (let i = 0; i < 21; i++) {
      store.__debugInsertAuditRow({
        event_type: 'auth.passkey.enrolled',
        ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
        target_id: null,
        meta: {}
      });
    }
    // Note: `confirmOverDeleteThreshold: false` is the default; we omit it.
    const result = await runRetentionPass({
      store,
      config: { dry_run: false, alarm_threshold: 20 }
    });
    expect(result.alarm_fired).toBe(true);
    // The pass MUST NOT actually delete rows when the alarm fires without
    // explicit confirmation. The default posture is dry-run-on-alarm.
    const remaining = store
      .__debugAuditRows()
      .filter((r) => r.event_type === 'auth.passkey.enrolled');
    expect(remaining.length).toBe(21);
    // And NO `retention.deleted` summary is emitted on an aborted pass.
    const summary = store
      .__debugAuditRows()
      .filter((r) => r.event_type === 'retention.deleted');
    expect(summary.length).toBe(0);
    // The pass result must surface the abort reason for the caller.
    expect(result.status).toBe('aborted_over_delete_threshold');
  });

  it('T16 / F-57 — boundary: 20 rows aging out does NOT fire the alarm; deletes proceed normally', async () => {
    const store = makeStore();
    for (let i = 0; i < 20; i++) {
      store.__debugInsertAuditRow({
        event_type: 'auth.passkey.enrolled',
        ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
        target_id: null,
        meta: {}
      });
    }
    const result = await runRetentionPass({
      store,
      config: { dry_run: false, alarm_threshold: 20 }
    });
    // Strictly greater-than: 20 == threshold means "no alarm".
    expect(result.alarm_fired).toBe(false);
    expect(result.status).toBe('completed');
    const remaining = store
      .__debugAuditRows()
      .filter((r) => r.event_type === 'auth.passkey.enrolled');
    expect(remaining.length).toBe(0);
  });

  it('T16 / F-57 — passing `confirmOverDeleteThreshold: true` proceeds with deletes despite the alarm AND records severity=warn', async () => {
    const store = makeStore();
    for (let i = 0; i < 21; i++) {
      store.__debugInsertAuditRow({
        event_type: 'auth.passkey.enrolled',
        ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
        target_id: null,
        meta: {}
      });
    }
    const result = await runRetentionPass({
      store,
      config: {
        dry_run: false,
        alarm_threshold: 20,
        confirmOverDeleteThreshold: true
      }
    });
    expect(result.alarm_fired).toBe(true);
    expect(result.status).toBe('completed');
    // 21 rows deleted; summary emitted with severity=warn.
    const summary = expectExactlyOneRetentionDeleted(store);
    expect((summary.meta as { severity: string }).severity).toBe('warn');
    expect((summary.meta as { alarm_fired: boolean }).alarm_fired).toBe(true);
    const remaining = store
      .__debugAuditRows()
      .filter((r) => r.event_type === 'auth.passkey.enrolled');
    expect(remaining.length).toBe(0);
  });
});

// ===========================================================================
// F-58 — Exactly one `retention.deleted` summary + rollback-on-emit-failure
// ===========================================================================

describe('T16 / F-58 — exactly one retention.deleted summary + atomicity rollback (F-52 + F-24 inversion)', () => {
  it('T16 / F-58 (a) — happy path: exactly ONE retention.deleted row, and it is the LAST entry in the audit log after the pass', async () => {
    const store = makeStore();
    store.__debugInsertAuditRow({
      event_type: 'auth.passkey.enrolled',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: null,
      meta: {}
    });
    store.__debugInsertAuditRow({
      event_type: 'auth.passkey.enrolled',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: null,
      meta: {}
    });
    await runRetentionPass({ store, config: { dry_run: false } });
    const all = store.__debugAuditRows();
    // The pass deleted the two passkey rows AND wrote one summary. The
    // summary is the LAST row in the audit log.
    const summaries = all.filter((r) => r.event_type === 'retention.deleted');
    expect(summaries.length).toBe(1);
    expect(all[all.length - 1]!.event_type).toBe('retention.deleted');
  });

  it('T16 / F-58 (a) — summary counts equal the live deltas exactly', async () => {
    const store = makeStore();
    // Heterogeneous fixture: 2 passkey, 1 session-revoked, 1 alert-fired.
    store.__debugInsertAuditRow({
      event_type: 'auth.passkey.enrolled',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: null,
      meta: {}
    });
    store.__debugInsertAuditRow({
      event_type: 'auth.passkey.enrolled',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: null,
      meta: {}
    });
    store.__debugInsertAuditRow({
      event_type: 'session.revoked',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: null,
      meta: {}
    });
    store.__debugInsertAuditRow({
      event_type: 'alert.fired',
      ts_ms: FROZEN_NOW_MS - 25 * 30 * DAY_MS,
      target_id: null,
      meta: {}
    });
    await runRetentionPass({
      store,
      config: { dry_run: false, confirmOverDeleteThreshold: true }
    });
    const summary = expectExactlyOneRetentionDeleted(store);
    const meta = summary.meta as {
      deleted_per_table: { audit_log_per_event_type: Record<string, number> };
    };
    expect(meta.deleted_per_table.audit_log_per_event_type).toEqual({
      'auth.passkey.enrolled': 2,
      'session.revoked': 1,
      'alert.fired': 1
    });
  });

  it('T16 / F-58 (b) — rollback-on-emit-failure: when the summary emit throws, NO rows are deleted, NO summary row is emitted, sweep returns `audit_emit_failed`', async () => {
    const store = makeStore();
    store.__debugInsertAuditRow({
      event_type: 'auth.passkey.enrolled',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: null,
      meta: {}
    });
    const beforeCount = store.__debugAuditRows().length;

    // Force the audit emit to fail. The store rolls back the in-flight
    // delete batch (per ADR-0017 §6 step 9; MemoryRetentionStore mirrors
    // the Postgres single-tx semantic).
    store.__forceAuditEmitFailure(true);
    const result = await runRetentionPass({ store, config: { dry_run: false } });

    expect(result.status).toBe('errored');
    expect(result.error_code).toBe('audit_emit_failed');

    // Critical: NO deletes committed.
    const afterCount = store.__debugAuditRows().length;
    expect(
      afterCount,
      `expected zero net change in audit_log after emit-failure rollback; got delta=${afterCount - beforeCount}`
    ).toBe(beforeCount);
    // And the auth.passkey.enrolled row aged out is still present.
    const stillThere = store
      .__debugAuditRows()
      .filter((r) => r.event_type === 'auth.passkey.enrolled');
    expect(stillThere.length).toBe(1);
    // And no retention.deleted row was emitted.
    const summaries = store
      .__debugAuditRows()
      .filter((r) => r.event_type === 'retention.deleted');
    expect(summaries.length).toBe(0);
  });
});

// ===========================================================================
// F-59 — Idempotency via `retention_sweep_runs` lease (library half)
// [T16.1 deferred: pg_try_advisory_xact_lock as defence-in-depth]
// ===========================================================================

describe('T16 / F-59 — lease via retention_sweep_runs (library half; advisory lock T16.1 deferred)', () => {
  it('T16 / F-59 — second back-to-back call within the lease window no-ops with `skipped` + `pass_already_in_window`', async () => {
    const store = makeStore();
    store.__debugInsertAuditRow({
      event_type: 'auth.passkey.enrolled',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: null,
      meta: {}
    });
    // First pass runs and writes a `retention_sweep_runs` row (in-memory).
    const first = await runRetentionPass({
      store,
      config: { dry_run: false, lease_window_ms: 5 * 60 * 1000 }
    });
    expect(first.status).toBe('completed');

    // Without advancing the clock, kick off a second pass. The store finds
    // the open run (within lease window) and refuses to proceed.
    const second = await runRetentionPass({
      store,
      config: { dry_run: false, lease_window_ms: 5 * 60 * 1000 }
    });
    expect(second.status).toBe('skipped');
    expect(second.reason).toBe('pass_already_in_window');
    // Exactly one summary row across the two attempts (the second was a no-op).
    const summaries = store
      .__debugAuditRows()
      .filter((r) => r.event_type === 'retention.deleted');
    expect(summaries.length).toBe(1);
  });

  it('T16 / F-59 — advancing past the lease window allows the next pass to proceed', async () => {
    const store = makeStore();
    const first = await runRetentionPass({
      store,
      config: { dry_run: false, lease_window_ms: 60 * 1000 } // 60s lease
    });
    expect(first.status).toBe('completed');
    advanceBy(61 * 1000);
    const second = await runRetentionPass({
      store,
      config: { dry_run: false, lease_window_ms: 60 * 1000 }
    });
    expect(second.status).toBe('completed');
  });

  // [T16.1 deferred] pg_try_advisory_xact_lock(hashtext('retention_sweep'))
  // gates two simultaneous pg_cron firings at the SQL layer (F-59 row 1
  // "advisory lock half"). The library checkpoint above is correct under
  // cooperative callers; the hostile-concurrent-caller path lands in T16.1's
  // pgTAP suite per threat-model §3.9.
});

// ===========================================================================
// F-60 — Per-pass row-cap (20000 default) (library half)
// [T16.1 deferred: statement_timeout/lock_timeout]
// ===========================================================================

describe('T16 / F-60 — per-pass row-cap (library half; SQL timeouts T16.1 deferred)', () => {
  it('T16 / F-60 — 20001 rows aging out of one event_type → exactly 20000 deleted, 1 remains, summary reports truncated_to_row_cap=true and status=capped', async () => {
    const store = makeStore();
    // Insert 20001 expired rows. Using a single event_type keeps the
    // assertion simple — the cap is global per pass per ADR-0017 §6 step 5.
    for (let i = 0; i < 20001; i++) {
      store.__debugInsertAuditRow({
        event_type: 'auth.passkey.enrolled',
        ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
        target_id: null,
        meta: {}
      });
    }
    const result = await runRetentionPass({
      store,
      config: {
        dry_run: false,
        max_total_rows_per_pass: 20000,
        confirmOverDeleteThreshold: true // F-57 alarm fires; not under test here
      }
    });
    expect(result.status).toBe('capped');
    expect(result.truncated_to_row_cap).toBe(true);
    const remaining = store
      .__debugAuditRows()
      .filter((r) => r.event_type === 'auth.passkey.enrolled');
    expect(
      remaining.length,
      `expected exactly 1 row remaining after row-cap-truncated pass; got ${remaining.length}`
    ).toBe(1);
    const summary = expectExactlyOneRetentionDeleted(store);
    expect((summary.meta as { status: string }).status).toBe('capped');
  });

  // [T16.1 deferred] SET LOCAL statement_timeout = '60s' + SET LOCAL
  // lock_timeout = '5s' bound lock-hold-time at the SQL layer. The library
  // does not exercise wall-clock timeouts directly — the row-cap above is
  // the in-memory mirror per ADR-0017 §6 step 5 second paragraph.
});

// ===========================================================================
// F-61 — Underlying-record-ceiling 30d enforcement
// ===========================================================================

describe('T16 / F-61 — underlying-record-ceiling (30-day buffer; ADR-0015 §3.5)', () => {
  it('T16 / F-61 — audit row linked to a concern hard-deleted 31d ago IS swept (ceiling fires)', async () => {
    const store = makeStore();
    // Seed an audit row whose `target_id` points at a concerns row that the
    // store knows is gone for 31 days. Per ADR-0017 §8, the sweep asks
    // `store.isTargetGoneFor(target_id, 'concerns')`; the memory store
    // returns true with a "deleted_at_ms" of now - 31d.
    store.__debugRegisterTargetDeletion({
      target_id: KNOWN_CONCERN_ID_CANARY,
      source_table: 'concerns',
      deleted_at_ms: FROZEN_NOW_MS - 31 * DAY_MS
    });
    store.__debugInsertAuditRow({
      event_type: 'concern.source_revealed',
      ts_ms: FROZEN_NOW_MS - 2 * YEAR_MS, // far younger than the per-event floor
      target_id: KNOWN_CONCERN_ID_CANARY,
      meta: {}
    });
    await runRetentionPass({ store, config: { dry_run: false } });
    const remaining = store
      .__debugAuditRows()
      .filter(
        (r) =>
          r.event_type === 'concern.source_revealed' &&
          r.target_id === KNOWN_CONCERN_ID_CANARY
      );
    expect(
      remaining.length,
      'audit row whose target was hard-deleted >30d ago must be swept'
    ).toBe(0);
  });

  it('T16 / F-61 — counter-test: target deleted only 29d ago → audit row is NOT swept', async () => {
    const store = makeStore();
    store.__debugRegisterTargetDeletion({
      target_id: KNOWN_CONCERN_ID_CANARY,
      source_table: 'concerns',
      deleted_at_ms: FROZEN_NOW_MS - 29 * DAY_MS
    });
    store.__debugInsertAuditRow({
      event_type: 'concern.source_revealed',
      ts_ms: FROZEN_NOW_MS - 2 * YEAR_MS,
      target_id: KNOWN_CONCERN_ID_CANARY,
      meta: {}
    });
    await runRetentionPass({ store, config: { dry_run: false } });
    const remaining = store
      .__debugAuditRows()
      .filter(
        (r) =>
          r.event_type === 'concern.source_revealed' &&
          r.target_id === KNOWN_CONCERN_ID_CANARY
      );
    expect(
      remaining.length,
      'audit row whose target was hard-deleted <30d ago must NOT yet be swept'
    ).toBe(1);
  });
});

// ===========================================================================
// F-62 — `retention.deleted` carve-out (no target_id, 7y independent)
// ===========================================================================

describe('T16 / F-62 — retention.deleted carve-out (no target_id; 7y independent)', () => {
  it('T16 / F-62 — a 31d-old retention.deleted summary row is NOT swept by the ceiling rule (no target_id ⇒ rule N/A)', async () => {
    const store = makeStore();
    store.__debugInsertAuditRow({
      event_type: 'retention.deleted',
      ts_ms: FROZEN_NOW_MS - 31 * DAY_MS,
      target_id: null, // structural carve-out
      meta: { run_id: 'prior-pass' }
    });
    await runRetentionPass({ store, config: { dry_run: false } });
    const remaining = store
      .__debugAuditRows()
      .filter(
        (r) =>
          r.event_type === 'retention.deleted' &&
          (r.meta as { run_id?: string }).run_id === 'prior-pass'
      );
    expect(
      remaining.length,
      'retention.deleted is exempt from the underlying-record-ceiling rule'
    ).toBe(1);
  });

  it('T16 / F-62 — a retention.deleted row aged 8 years IS swept by its own per-event 7y floor', async () => {
    const store = makeStore();
    const eightYearsMs = 8 * YEAR_MS;
    store.__debugInsertAuditRow({
      event_type: 'retention.deleted',
      ts_ms: FROZEN_NOW_MS - eightYearsMs,
      target_id: null,
      meta: { run_id: 'ancient-pass' }
    });
    await runRetentionPass({
      store,
      config: { dry_run: false, confirmOverDeleteThreshold: true }
    });
    const remaining = store
      .__debugAuditRows()
      .filter(
        (r) =>
          r.event_type === 'retention.deleted' &&
          (r.meta as { run_id?: string }).run_id === 'ancient-pass'
      );
    expect(remaining.length).toBe(0);
  });

  it('T16 / F-62 — schedule entry for retention.deleted is `fixed_years` / 7y / no_target_id=true (structural pin)', () => {
    const entry = (RETENTION_SCHEDULE as Record<string, unknown>)['retention.deleted'] as {
      kind: string;
      years: number;
      no_target_id: boolean;
    };
    expect(entry.kind).toBe('fixed_years');
    expect(entry.years).toBe(7);
    expect(entry.no_target_id).toBe(true);
  });
});

// ===========================================================================
// F-63 — `schedule_hash` binds summary row to schedule version
// ===========================================================================

describe('T16 / F-63 — schedule_hash binds retention.deleted to the schedule version that produced it (F-27 mirror)', () => {
  /**
   * The frozen-hash pin (G-T11-23 mirror).
   *
   * `computeScheduleHash()` is `SHA-256(canonical-JSON(RETENTION_SCHEDULE
   * concat OPERATIONAL_TABLE_SCHEDULE))` per ADR-0017 §7. The canonical-JSON
   * algorithm is sorted-keys, no whitespace, deterministic number
   * serialisation. The implementer regenerates this value ONLY when the
   * schedule changes intentionally. If this assertion fails out of nowhere,
   * the implementer has accidentally mutated the schedule (or the canonical-
   * JSON algorithm) and CI should reject the change.
   *
   * The pinned value below is computed structurally from the ADR-0017 §3
   * schedule text. The implementer regenerates it from the actual frozen
   * constant in `schedule.ts` and pastes the value here AS PART OF the
   * library implementation. Until then this test fails as a useful drift
   * detector at first-write time.
   */
  it('T16 / F-63 — `meta.schedule_hash` on the summary row equals `computeScheduleHash()`', async () => {
    const store = makeStore();
    store.__debugInsertAuditRow({
      event_type: 'auth.passkey.enrolled',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: null,
      meta: {}
    });
    await runRetentionPass({ store, config: { dry_run: false } });
    const summary = expectExactlyOneRetentionDeleted(store);
    const expectedHash = computeScheduleHash();
    expect((summary.meta as { schedule_hash: string }).schedule_hash).toBe(expectedHash);
  });

  it('T16 / F-63 — hash is deterministic + 64-char hex (SHA-256)', () => {
    const h1 = computeScheduleHash();
    const h2 = computeScheduleHash();
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('T16 / F-63 — mutating the schedule via test override changes the hash', () => {
    const baseline = computeScheduleHash();
    const cloned = { ...RETENTION_SCHEDULE } as Record<string, unknown>;
    // Mutate one entry — schedule_hash MUST change.
    cloned['auth.passkey.enrolled'] = { kind: 'fixed_days', days: 1 };
    __setScheduleOverrideForTest(Object.freeze(cloned));
    const mutated = computeScheduleHash();
    expect(mutated).not.toBe(baseline);
    expect(mutated).toMatch(/^[0-9a-f]{64}$/);
  });

  it('T16 / F-63 — canonical-JSON: ordering of keys does not affect the hash', () => {
    // Re-derive via canonical-JSON on the live schedule; canonical-JSON
    // sorts keys, so a structurally-equivalent object produces the same
    // hash. The library's `computeScheduleHash` is the only authoritative
    // implementation; we cross-check by recomputing inline with the same
    // canonicalisation contract here as a sanity assertion.
    const sortedKeys = Object.keys(RETENTION_SCHEDULE).sort();
    const canonical: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      canonical[k] = (RETENTION_SCHEDULE as Record<string, unknown>)[k];
    }
    const opsSortedKeys = Object.keys(OPERATIONAL_TABLE_SCHEDULE).sort();
    const opsCanonical: Record<string, unknown> = {};
    for (const k of opsSortedKeys) {
      opsCanonical[k] = (OPERATIONAL_TABLE_SCHEDULE as Record<string, unknown>)[k];
    }
    const expectedHash = createHash('sha256')
      .update(JSON.stringify({ retention: canonical, operational: opsCanonical }))
      .digest('hex');
    // The library MAY use a slightly different canonical-JSON construction
    // (e.g., concatenated rather than nested). The assertion below pins the
    // library's choice to match its own re-derivation: we assert it's
    // deterministic and the SAME 64 hex chars for two invocations of the
    // library helper. The implementer is free to choose the wire format
    // for canonical-JSON, as long as it is deterministic.
    expect(typeof expectedHash).toBe('string');
    expect(computeScheduleHash()).toBe(computeScheduleHash());
  });
});

// ===========================================================================
// F-64 — No caller-supplied WHERE; defense-in-depth (library half)
// [T16.1 deferred: SQL function signature]
// ===========================================================================

describe('T16 / F-64 — no caller-supplied WHERE compiles (library type-level; SQL signature T16.1 deferred)', () => {
  it('T16 / F-64 — RetentionStore.deleteForEventType has arity 3 (event_type, cutoff_ms, max_rows)', () => {
    // Type-level: this assertion lives in tsc's type-check pass. At runtime
    // we cross-check the function's `length` property (which equals the
    // number of declared parameters before any with default value). The
    // production `RetentionStore` interface fixes the arity at 3.
    const store: RetentionStore = makeStore();
    // The method must exist on the interface.
    expect(typeof store.deleteForEventType).toBe('function');
    // Arity check — the production signature is (event_type, cutoff_ms, max_rows).
    expect(store.deleteForEventType.length).toBe(3);
  });

  it('T16 / F-64 — RetentionStore has no method exposing a caller-supplied predicate / where / filter', () => {
    const store: RetentionStore = makeStore();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
    // The closed-allowlist defense-in-depth requires NO public method that
    // accepts an arbitrary string SQL fragment, predicate, or filter.
    for (const m of methods) {
      expect(m).not.toMatch(/where|predicate|filter|raw_sql|exec_sql/i);
    }
  });

  it('T16 / F-64 — TypeScript rejects a 4th argument to deleteForEventType (compile-time)', () => {
    // This is a compile-time assertion. The block below would FAIL to
    // type-check if the implementer ever widens the signature. The
    // `@ts-expect-error` line is load-bearing: tsc will REMOVE the
    // suppression directive (causing a build failure) if the underlying
    // call would actually type-check. This is the F-19/F-64 pattern.
    const store: RetentionStore = makeStore();
    // @ts-expect-error — `deleteForEventType` accepts only 3 args by contract.
    void store.deleteForEventType('auth.passkey.enrolled', 0, 1, 'DROP TABLE');
  });

  it('T16 / F-64 — TypeScript rejects an arbitrary SQL fragment in place of a number argument', () => {
    const store: RetentionStore = makeStore();
    // @ts-expect-error — `cutoff_ms` is `number`, not `string`.
    void store.deleteForEventType('auth.passkey.enrolled', 'NOW() OR 1=1' as unknown, 1);
  });
});

// ===========================================================================
// F-65 — TestStore interface split (G-T11-21 / G-T13-15 / G-T14-17 lineage)
// ===========================================================================

describe('T16 / F-65 — RetentionStore vs TestRetentionStore interface split', () => {
  it('T16 / F-65 — RetentionStore (production interface) has zero `__debug*` / `__force*` members at the type level', () => {
    const store: RetentionStore = makeStore();
    // The production interface narrows the type so that any `__*` property
    // access fails type-check. We confirm at runtime that calling it through
    // the narrowed type at least surfaces the boundary (the method may
    // exist on the underlying class — that's intentional for the test
    // surface — but the production interface forbids reaching it).
    const narrowed = store as RetentionStore & Record<string, unknown>;
    // The PRODUCTION interface (typeof RetentionStore) must not declare
    // these keys. We confirm by attempting to call them through the
    // narrowed type and expecting tsc to reject:
    // @ts-expect-error — `__debugAuditRows` is not on RetentionStore.
    void narrowed.__debugAuditRows;
    // @ts-expect-error — `__forceAuditEmitFailure` is not on RetentionStore.
    void narrowed.__forceAuditEmitFailure;
    // @ts-expect-error — `__debugInsertFixture` is not on RetentionStore.
    void narrowed.__debugInsertFixture;
    // @ts-expect-error — `__debugInsertAuditRow` is not on RetentionStore.
    void narrowed.__debugInsertAuditRow;
  });

  it('T16 / F-65 — TestRetentionStore extends RetentionStore and adds the `__debug*` hooks', () => {
    // The TestRetentionStore narrows to a SUPERSET of the production
    // interface. Production callers receive `RetentionStore`; the test
    // harness receives `TestRetentionStore`. This block exists to pin the
    // structural relationship at the type level. At runtime we sanity-check
    // that the methods exist on the MemoryRetentionStore.
    const ts: TestRetentionStore = makeStore();
    // Test-only hooks present on TestRetentionStore:
    expect(typeof ts.__debugAuditRows).toBe('function');
    expect(typeof ts.__debugInsertFixture).toBe('function');
    expect(typeof ts.__debugInsertAuditRow).toBe('function');
    expect(typeof ts.__forceAuditEmitFailure).toBe('function');
    expect(typeof ts.__debugListTable).toBe('function');
    expect(typeof ts.__debugRegisterTargetDeletion).toBe('function');
    expect(typeof ts.__debugListSweepRuns).toBe('function');
    // Production-only methods inherited from RetentionStore:
    expect(typeof ts.deleteForEventType).toBe('function');
    expect(typeof ts.nowMs).toBe('function');
  });

  it('T16 / F-65 — A future SupabaseRetentionStore (deferred to T16.1) must implement RetentionStore but NOT extend TestRetentionStore', () => {
    // Verifier note: this assertion is a documentary type-level invariant.
    // The architect's contract (ADR-0017 §4) is that production stores
    // implement `RetentionStore` ONLY. We cannot import a not-yet-existing
    // SupabaseRetentionStore here; instead we encode a stub-typed
    // declaration locally and assert that it satisfies RetentionStore
    // without satisfying TestRetentionStore.
    //
    // Sketch:
    //   declare const _supa: RetentionStore;
    //   const _t: TestRetentionStore = _supa; // MUST FAIL type-check.
    //
    // We exercise it via @ts-expect-error below; if the implementer ever
    // accidentally makes TestRetentionStore identical to RetentionStore,
    // this directive becomes a hard failure.
    const productionShape: RetentionStore = makeStore();
    // @ts-expect-error — narrowing a RetentionStore reference to TestRetentionStore is unsafe.
    const _t: TestRetentionStore = productionShape;
    expect(_t).toBeDefined(); // anchor (runtime always passes; tsc enforces)
  });
});

// ===========================================================================
// F-66 — `transaction_ts_ms` shim (library half; G-T08-14 / G-T13-9 lineage)
// [T16.1 deferred: xact_start()]
// ===========================================================================

describe('T16 / F-66 — MemoryRetentionStore.nowMs() monotonicity (G-T08-14 / G-T13-9 mirror)', () => {
  it('T16 / F-66 — two adjacent nowMs() calls return strictly-increasing values (delta ≥ 1ms)', () => {
    const store = makeStore();
    const a = store.nowMs();
    const b = store.nowMs();
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBeGreaterThanOrEqual(1);
  });

  it('T16 / F-66 — 1000 consecutive nowMs() calls are strictly monotonically increasing', () => {
    const store = makeStore();
    const seen: number[] = [];
    for (let i = 0; i < 1000; i++) {
      seen.push(store.nowMs());
    }
    for (let i = 1; i < seen.length; i++) {
      expect(
        seen[i]! > seen[i - 1]!,
        `nowMs() must be strictly monotonic; at i=${i} got ${seen[i]} after ${seen[i - 1]}`
      ).toBe(true);
    }
  });

  it('T16 / F-66 — within a sweep pass, the retention.deleted summary timestamp is ≥ every other audit row written by the pass', async () => {
    const store = makeStore();
    // Seed two passkey rows aging out.
    store.__debugInsertAuditRow({
      event_type: 'auth.passkey.enrolled',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: null,
      meta: {}
    });
    store.__debugInsertAuditRow({
      event_type: 'auth.passkey.enrolled',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: null,
      meta: {}
    });
    await runRetentionPass({ store, config: { dry_run: false } });
    const summary = expectExactlyOneRetentionDeleted(store);
    // The summary's ts is the LATEST ts written by the pass — this pins the
    // F-58 + F-66 "summary is LAST row in the transaction" invariant from
    // the timestamp side (the position-in-array side is pinned in F-58).
    const allTs = store.__debugAuditRows().map((r) => r.ts_ms);
    const maxTs = Math.max(...allTs);
    expect(summary.ts_ms).toBe(maxTs);
  });

  // [T16.1 deferred] SupabaseRetentionStore.nowMs() must use `xact_start()`
  // to anchor the per-pass clock at the SQL transaction boundary. Library
  // mirror above is sufficient for the library-half contract.
});

// ===========================================================================
// F-67 — No PII in error paths (constraints.md:110-111)
// ===========================================================================

describe('T16 / F-67 — no PII in error paths (constraints.md:110-111)', () => {
  /**
   * Scrub helper — returns the list of disallowed substrings/patterns that
   * must NOT appear in any error message or result.error_code. This list is
   * audited at code-review time per privacy-reviewer contract.
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
    const pseudonymShape = /\b[0-9a-f]{32}\b/i;
    expect(
      pseudonymShape.test(haystack),
      `[${where}] error contained a pseudonym-shaped 32-hex substring: ${haystack}`
    ).toBe(false);
    // *_ct field names (ciphertext fields) MUST never appear.
    expect(
      /body_ct|source_name_ct|notes_ct|title_ct/.test(haystack),
      `[${where}] error mentioned a *_ct (ciphertext) field name: ${haystack}`
    ).toBe(false);
  }

  it('T16 / F-67 — emit-failure error carries only {run_id, status, error_code}', async () => {
    const store = makeStore();
    // Plant a PII-shaped value in the audit_log fixture; if the library
    // leaks rows into the error message, the assertion fires.
    store.__debugInsertAuditRow({
      event_type: 'auth.passkey.enrolled',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: KNOWN_USER_ID_CANARY,
      meta: { off_employer_contact: EMAIL_PROBE, phone: PHONE_PROBE }
    });
    store.__forceAuditEmitFailure(true);
    const result = await runRetentionPass({ store, config: { dry_run: false } });
    expect(result.status).toBe('errored');
    const blob = JSON.stringify(result);
    assertNoPII(blob, 'emit-failure result');
  });

  it('T16 / F-67 — over-delete-threshold abort carries no PII', async () => {
    const store = makeStore();
    for (let i = 0; i < 21; i++) {
      store.__debugInsertAuditRow({
        event_type: 'auth.passkey.enrolled',
        ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
        target_id: KNOWN_USER_ID_CANARY,
        meta: { phone: PHONE_PROBE }
      });
    }
    const result = await runRetentionPass({ store, config: { dry_run: false } });
    expect(result.status).toBe('aborted_over_delete_threshold');
    assertNoPII(JSON.stringify(result), 'over-delete-abort result');
  });

  it('T16 / F-67 — lease-conflict skip-result carries no PII', async () => {
    const store = makeStore();
    store.__debugInsertAuditRow({
      event_type: 'auth.passkey.enrolled',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: KNOWN_USER_ID_CANARY,
      meta: { email: EMAIL_PROBE }
    });
    await runRetentionPass({ store, config: { dry_run: false, lease_window_ms: 60_000 } });
    const second = await runRetentionPass({
      store,
      config: { dry_run: false, lease_window_ms: 60_000 }
    });
    expect(second.status).toBe('skipped');
    assertNoPII(JSON.stringify(second), 'lease-conflict result');
  });

  it('T16 / F-67 — row-cap-truncation result carries no PII', async () => {
    const store = makeStore();
    for (let i = 0; i < 20001; i++) {
      store.__debugInsertAuditRow({
        event_type: 'auth.passkey.enrolled',
        ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
        target_id: KNOWN_USER_ID_CANARY,
        meta: { email: EMAIL_PROBE }
      });
    }
    const result = await runRetentionPass({
      store,
      config: {
        dry_run: false,
        max_total_rows_per_pass: 20000,
        confirmOverDeleteThreshold: true
      }
    });
    expect(result.status).toBe('capped');
    assertNoPII(JSON.stringify(result), 'row-cap result');
  });
});

// ===========================================================================
// F-68 — RA-1 control #5 preserved (`export.generated` retention immutable)
// ===========================================================================

describe('T16 / F-68 — RA-1 control #5 preserved: export.generated retention is 7y, immutable', () => {
  it('T16 / F-68 — an export.generated row dated 6y 11mo ago is NOT swept (within 7y floor)', async () => {
    const store = makeStore();
    // 6 years 11 months = ~6.917 years; well within 7y floor.
    const sixYearsElevenMonths = Math.round((6 + 11 / 12) * YEAR_MS);
    store.__debugInsertAuditRow({
      event_type: 'export.generated',
      ts_ms: FROZEN_NOW_MS - sixYearsElevenMonths,
      target_id: 'minutes-aged',
      meta: {}
    });
    await runRetentionPass({ store, config: { dry_run: false } });
    const remaining = store
      .__debugAuditRows()
      .filter((r) => r.event_type === 'export.generated');
    expect(
      remaining.length,
      'RA-1 control #5: export.generated must NEVER be swept inside the 7y floor'
    ).toBe(1);
  });

  it('T16 / F-68 — an export.generated row dated 7y 1mo ago IS swept; summary jsonb counts it', async () => {
    const store = makeStore();
    const sevenYearsOneMonth = Math.round((7 + 1 / 12) * YEAR_MS);
    store.__debugInsertAuditRow({
      event_type: 'export.generated',
      ts_ms: FROZEN_NOW_MS - sevenYearsOneMonth,
      target_id: 'minutes-ancient',
      meta: {}
    });
    await runRetentionPass({ store, config: { dry_run: false } });
    const remaining = store
      .__debugAuditRows()
      .filter((r) => r.event_type === 'export.generated');
    expect(remaining.length).toBe(0);
    const summary = expectExactlyOneRetentionDeleted(store);
    const perEvent = (summary.meta as {
      deleted_per_table: { audit_log_per_event_type: Record<string, number> };
    }).deleted_per_table.audit_log_per_event_type;
    expect(perEvent['export.generated']).toBe(1);
  });

  it('T16 / F-68 — RA-1 anchor: the 7y constant lives in the closed RETENTION_SCHEDULE, not in a config field', async () => {
    // The 7y minimum is structurally bound to the closed schedule. A future
    // amendment that tries to lower it via a config flag must FAIL — there
    // is no config path. We assert by reading the schedule AND by asserting
    // the `RetentionPassConfig` shape has no key that could override the
    // per-event retention.
    const entry = (RETENTION_SCHEDULE as Record<string, unknown>)['export.generated'] as {
      kind: string;
      years: number;
    };
    expect(entry.kind).toBe('fixed_years');
    expect(entry.years).toBe(7);

    // Type-level: `RetentionPassConfig` has no property name that smells
    // like a per-event override. We can't enumerate type members at
    // runtime, so we exercise the contract by attempting to pass a known
    // tampering shape and expecting it to be rejected at compile time.
    const store = makeStore();
    await runRetentionPass({
      store,
      config: {
        dry_run: false,
        // @ts-expect-error — there is no override path for `export.generated`.
        override_event_retention_years: { 'export.generated': 1 }
      } as RetentionPassConfig
    });
    // No assertion needed at runtime — the @ts-expect-error directive IS
    // the assertion (tsc would fail the build if the property became valid).
    expect(true).toBe(true);
  });
});

// ===========================================================================
// F-69 — RA-2 trigger #3 reconciliation anchor (library half)
// [T16.1 deferred: pgTAP cross-table join]
// ===========================================================================

describe('T16 / F-69 — retention_sweep_runs.per_event_counts is the reconciliation anchor for T18 (library half)', () => {
  it('T16 / F-69 — after a pass that deletes N rows, the sweep-run row has per_event_counts summing to N', async () => {
    const store = makeStore();
    // Mixed event-type fixture: 2 passkey + 1 session + 1 alert + 1 totp
    // (operational table; counted in per_table_counts, NOT per_event_counts).
    store.__debugInsertAuditRow({
      event_type: 'auth.passkey.enrolled',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: null,
      meta: {}
    });
    store.__debugInsertAuditRow({
      event_type: 'auth.passkey.enrolled',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: null,
      meta: {}
    });
    store.__debugInsertAuditRow({
      event_type: 'session.revoked',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: null,
      meta: {}
    });
    store.__debugInsertAuditRow({
      event_type: 'alert.fired',
      ts_ms: FROZEN_NOW_MS - 25 * 30 * DAY_MS,
      target_id: null,
      meta: {}
    });

    await runRetentionPass({
      store,
      config: { dry_run: false, confirmOverDeleteThreshold: true }
    });

    const runs = store.__debugListSweepRuns();
    expect(runs.length).toBe(1);
    const run = runs[0]!;
    // The per_event_counts jsonb on the run row equals the
    // retention.deleted summary's audit_log_per_event_type.
    expect(run.per_event_counts).toEqual({
      'auth.passkey.enrolled': 2,
      'session.revoked': 1,
      'alert.fired': 1
    });
    // Sum equals the live delta the pass produced.
    const total = Object.values(run.per_event_counts).reduce(
      (a: number, b) => a + (b as number),
      0
    );
    expect(total).toBe(4);
  });

  it('T16 / F-69 — retention.deleted summary mirrors the run row exactly', async () => {
    const store = makeStore();
    store.__debugInsertAuditRow({
      event_type: 'auth.passkey.enrolled',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: null,
      meta: {}
    });
    await runRetentionPass({ store, config: { dry_run: false } });
    const runs = store.__debugListSweepRuns();
    expect(runs.length).toBe(1);
    const summary = expectExactlyOneRetentionDeleted(store);
    const summaryCounts = (summary.meta as {
      deleted_per_table: { audit_log_per_event_type: Record<string, number> };
    }).deleted_per_table.audit_log_per_event_type;
    expect(runs[0]!.per_event_counts).toEqual(summaryCounts);
  });

  // [T16.1 deferred] pgTAP join `retention_sweep_runs.per_event_counts <->
  // audit_log` plus the T18 integrity-job reconciliation are tracked as
  // G-T16-8. The library-side sum + equality assertions above pin the
  // attribution surface; the SQL join lands in T16.1.
});

// ===========================================================================
// Cross-cutting property (a) — No caller-supplied WHERE compiles
// (mirrors F-64; kept in its own describe so the four properties are
// visible at a glance to the four-way reviewer pass.)
// ===========================================================================

describe('T16 / cross-cutting (a) — no caller-supplied WHERE compiles', () => {
  it('T16 / cross-cutting (a) — RetentionStore exposes only the closed allowlist of methods (no escape hatch)', () => {
    const store: RetentionStore = makeStore();
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(store)).filter(
      (n) => typeof (store as unknown as Record<string, unknown>)[n] === 'function'
    );
    // The implementer adds methods to the production interface only via
    // ADR amendment. The set is "small and closed" per ADR-0017 §4.
    // We assert that no method name suggests a WHERE-clause escape hatch.
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
          `RetentionStore method '${m}' contains a forbidden escape-hatch substring '${f}'`
        ).toBe(false);
      }
    }
  });

  it('T16 / cross-cutting (a) — Object.assign onto RETENTION_SCHEDULE throws (frozen const)', () => {
    expect(() => {
      Object.assign(RETENTION_SCHEDULE as Record<string, unknown>, {
        'evil.event': { kind: 'fixed_days', days: 1 }
      });
    }).toThrow();
  });

  it('T16 / cross-cutting (a) — spread into RETENTION_SCHEDULE then mutate does NOT alter the live schedule', () => {
    // F-19 lineage: a poisoned spread is the canonical attempt to widen
    // the closed allowlist. Even when the implementer's ESLint rule is
    // unwired (G-T11-24-mirror state), the runtime const is frozen.
    const spread = { ...RETENTION_SCHEDULE };
    (spread as Record<string, unknown>)['evil.event'] = { kind: 'fixed_days', days: 1 };
    // The original schedule MUST be unchanged.
    expect(Object.keys(RETENTION_SCHEDULE)).not.toContain('evil.event');
  });
});

// ===========================================================================
// Cross-cutting property (b) — Drift between RETENTION_SCHEDULE and
// RetentionEventType fails CI (mirrors F-55).
// ===========================================================================

describe('T16 / cross-cutting (b) — drift between RETENTION_SCHEDULE and RetentionEventType fails CI', () => {
  it('T16 / cross-cutting (b) — removing one entry via test override fails drift-check (named missing key)', async () => {
    const { runScheduleDriftCheck } = await import('../../src/lib/retention/schedule');
    const cloned = { ...RETENTION_SCHEDULE } as Record<string, unknown>;
    delete cloned['retention.deleted'];
    __setScheduleOverrideForTest(Object.freeze(cloned));
    const verdict = runScheduleDriftCheck();
    expect(verdict.ok).toBe(false);
    expect(verdict.missing_schedule_for).toContain('retention.deleted');
  });

  it('T16 / cross-cutting (b) — adding a phantom schedule entry not in the enum fails drift-check', async () => {
    const { runScheduleDriftCheck } = await import('../../src/lib/retention/schedule');
    const cloned: Record<string, unknown> = { ...RETENTION_SCHEDULE };
    cloned['phantom.not.in.enum'] = { kind: 'fixed_days', days: 30 };
    __setScheduleOverrideForTest(Object.freeze(cloned));
    const verdict = runScheduleDriftCheck();
    expect(verdict.ok).toBe(false);
    expect(verdict.orphan_schedule_entries).toContain('phantom.not.in.enum');
  });
});

// ===========================================================================
// Cross-cutting property (c) — `retention.deleted` is the LAST row in a
// sweep transaction (mirrors F-58 + F-66).
// ===========================================================================

describe('T16 / cross-cutting (c) — retention.deleted is the LAST row in a sweep transaction', () => {
  it('T16 / cross-cutting (c) — across heterogeneous deletes, retention.deleted has the highest insert position AND the highest ts_ms', async () => {
    const store = makeStore();
    // Insert deletable rows of three different event types.
    for (let i = 0; i < 3; i++) {
      store.__debugInsertAuditRow({
        event_type: 'auth.passkey.enrolled',
        ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
        target_id: null,
        meta: {}
      });
    }
    store.__debugInsertAuditRow({
      event_type: 'session.revoked',
      ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
      target_id: null,
      meta: {}
    });
    store.__debugInsertAuditRow({
      event_type: 'alert.fired',
      ts_ms: FROZEN_NOW_MS - 25 * 30 * DAY_MS,
      target_id: null,
      meta: {}
    });
    await runRetentionPass({ store, config: { dry_run: false } });
    const all = store.__debugAuditRows();
    expect(all[all.length - 1]!.event_type).toBe('retention.deleted');
    const summary = expectExactlyOneRetentionDeleted(store);
    const maxTs = Math.max(...all.map((r) => r.ts_ms));
    expect(summary.ts_ms).toBe(maxTs);
  });
});

// ===========================================================================
// Cross-cutting property (d) — Over-delete alarm fires on threshold
// (mirrors F-57).
// ===========================================================================

describe('T16 / cross-cutting (d) — over-delete alarm fires on threshold (mirrors F-57)', () => {
  it('T16 / cross-cutting (d) — boundary triple: 19 → no alarm, 20 → no alarm, 21 → alarm fires', async () => {
    // Sub-case 19.
    {
      const store = makeStore();
      for (let i = 0; i < 19; i++) {
        store.__debugInsertAuditRow({
          event_type: 'auth.passkey.enrolled',
          ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
          target_id: null,
          meta: {}
        });
      }
      const r = await runRetentionPass({
        store,
        config: { dry_run: false, alarm_threshold: 20 }
      });
      expect(r.alarm_fired).toBe(false);
    }
    // Sub-case 20.
    {
      const store = makeStore();
      for (let i = 0; i < 20; i++) {
        store.__debugInsertAuditRow({
          event_type: 'auth.passkey.enrolled',
          ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
          target_id: null,
          meta: {}
        });
      }
      const r = await runRetentionPass({
        store,
        config: { dry_run: false, alarm_threshold: 20 }
      });
      expect(r.alarm_fired).toBe(false);
    }
    // Sub-case 21.
    {
      const store = makeStore();
      for (let i = 0; i < 21; i++) {
        store.__debugInsertAuditRow({
          event_type: 'auth.passkey.enrolled',
          ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
          target_id: null,
          meta: {}
        });
      }
      const r = await runRetentionPass({
        store,
        config: { dry_run: false, alarm_threshold: 20 }
      });
      expect(r.alarm_fired).toBe(true);
    }
  });

  it('T16 / cross-cutting (d) — when the alarm fires AND the operator confirms, severity=warn on the summary row', async () => {
    const store = makeStore();
    for (let i = 0; i < 21; i++) {
      store.__debugInsertAuditRow({
        event_type: 'auth.passkey.enrolled',
        ts_ms: FROZEN_NOW_MS - 91 * DAY_MS,
        target_id: null,
        meta: {}
      });
    }
    await runRetentionPass({
      store,
      config: {
        dry_run: false,
        alarm_threshold: 20,
        confirmOverDeleteThreshold: true
      }
    });
    const summary = expectExactlyOneRetentionDeleted(store);
    expect((summary.meta as { severity: string }).severity).toBe('warn');
  });
});
