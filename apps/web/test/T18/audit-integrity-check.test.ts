/**
 * T18 — Audit-log integrity library + MemoryIntegrityStore (library-only).
 *
 * Scope (per ADR-0019 + ADR-0002 Amendment H): this file pins the LIBRARY
 * half of the audit-log integrity contract. T18 ships TS library +
 * MemoryIntegrityStore only. T18.1 ships SupabaseIntegrityStore + the SQL
 * migration that creates `integrity_check_runs` + (optional)
 * `audit_chain_anchors` + pg_cron 04:30 ET daily + pg_cron Mon 00:00 ET
 * weekly + Edge Function `post_rotation` + `post_export` triggers +
 * `pg_advisory_xact_lock` coordination + A-AUDIT-001 / A-INTEGRITY-001 /
 * A-INTEGRITY-002 alert sinks + off-app weekly anchor email + the audit-log
 * enum extension dance for the three new event types + HG-15 re-ratification.
 * Items tagged `[T18.1 deferred]` in this file have a library-half assertion
 * here and the full assertion in T18.1's pgTAP suite.
 *
 * F-### obligations satisfied (threat-model §3.11 "Audit-log integrity (T18)"):
 *   - F-86 — Closed-allowlist drift on INTEGRITY_CHECK_EVENT_TYPES.
 *                                                          [T18.1 deferred half: cross-mirror SQL CHECK]
 *   - F-87 — Audit-before-alert-fanout (F-24 generalized).
 *                                                          [T18.1 deferred half: SECURITY DEFINER sink]
 *   - F-88 — Summary-LAST in tx + rollback-on-emit-failure (F-58 mirror).
 *                                                          [T18.1 deferred half: single-tx wrapper]
 *   - F-89 — Chain-walk mismatch detection (primary surface).
 *                                                          [T18.1 deferred half: SQL walk equivalence]
 *   - F-90 — Sequential-id gap detection with sweep attribution.
 *   - F-91 — Backup-diff mismatch (LOAD-BEARING). *** LIVES IN
 *            apps/web/test/T18/backup-diff-mismatch.test.ts per threat-model
 *            §3.11 architect ask + G-T18-RA2-PRE-SNAPSHOT carry-forward. ***
 *   - F-92 — Attributable-vs-unattributable reconciliation (Option G rule).
 *                                                          [T18.1 deferred half: SQL equivalence]
 *   - F-93 — Runtime-pin coherence — OPERATIONAL not A-AUDIT-001.
 *                                                          [T18.1 deferred half: SECURITY DEFINER pin read]
 *   - F-94 — No PII in mismatch / ran / anchor rows.
 *                                                          [T18.1 deferred half: pgTAP JSONB structure]
 *   - F-95 — A-AUDIT-001 vs A-INTEGRITY-002 distinct causes.
 *                                                          [T18.1 deferred half: alert sinks + observability]
 *   - F-96 — Weekly chain anchor emission (RA-2 manual backstop).
 *                                                          [T18.1 deferred half: Edge Function email delivery]
 *   - F-97 — No caller-supplied predicate / pivot / WHERE / row-range /
 *            runtime_pin (F-19 mirror).
 *                                                          [Type-level half: ./fixtures/poisoned-config.ts]
 *   - F-98 — TestStore split + barrel re-export check.
 *   - F-99 — Row-cap + `capped` state (`resume_after_id` semantic; F-60 mirror).
 *                                                          [T18.1 deferred half: statement_timeout / lock_timeout]
 *   - F-100 — No PII in errors (closed-literal error_code union).
 *
 * Five cross-cutting properties pinned in dedicated `describe` blocks:
 *   (a) No caller-supplied predicate / pivot / WHERE compiles (F-97 +
 *       ./fixtures/poisoned-config.ts).
 *   (b) Closed-allowlist drift fails CI (F-86).
 *   (c) Mismatch-row precedes alert-fanout (F-87).
 *   (d) Summary-LAST in tx (F-88).
 *   (e) F-92 attribution rule in BOTH directions (attributed + unattributable).
 *
 * Determinism contract (per test-writer system prompt):
 *   - vitest fake timers via _helpers/clock.ts.
 *   - No network. MemoryIntegrityStore is the entire universe.
 *   - No real RNG (run_id seeded by the store under test).
 *   - No order dependence. Each test seeds + tears down its own store.
 *   - No sleep. No retries.
 *
 * Conventions mirrored from T11/T12, T13, T14, T16, T17:
 *   - Test-only overrides deep-imported, NOT via the public ./audit-integrity
 *     barrel (T11/T12 F-1 BLOCK lesson; T16/T17 ESLint pattern).
 *   - TestIntegrityStore extends IntegrityStore; production callers narrow
 *     to the production interface and cannot reach `__debug*` hooks
 *     (G-T11-21 / G-T13-15 / G-T14-17 / G-T16-PRIV-1 / G-T17 F-85).
 *   - Closed-enum exhaustiveness with `never` cast for compile-time drift
 *     (mirrors T16 RetentionEventType / T17 BackupTable).
 *
 * Failing-tests-first: the implementer has NOT written the library yet,
 * so every test in this file currently fails with "Cannot find module
 * '../../src/lib/audit-integrity/...'" or equivalent — that is the
 * expected pre-implementation posture for a four-way reviewer pass.
 */

import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freezeClock, advanceBy, restoreClock } from '../_helpers/clock';
import { FROZEN_NOW_MS } from '../_helpers/fixtures';

// Public surface — production callers consume ONLY these:
import {
  runIntegrityCheck,
  runWeeklyChainAnchor,
  INTEGRITY_CHECK_EVENT_TYPES,
  INTEGRITY_MAX_ROWS_PER_PASS,
  INTEGRITY_CHAIN_WALK_BATCH_SIZE,
  INTEGRITY_DEFAULT_LEASE_WINDOW_MS,
  INTEGRITY_BACKUP_DIFF_BUFFER_MS,
  INTEGRITY_MS_PER_HOUR,
  INTEGRITY_MS_PER_MINUTE,
  type IntegrityStore,
  type IntegrityCheckEventType,
  type IntegrityCheckTrigger,
  type IntegrityCheckRunConfig,
  type IntegrityRunResult
} from '../../src/lib/audit-integrity';

// Deep-imports — test-only override hooks live outside the public barrel
// (T11/T12 F-1 + T16/T17 ESLint pattern). Implementer MUST keep these
// out of `apps/web/src/lib/audit-integrity/index.ts`.
import {
  MemoryIntegrityStore,
  type TestIntegrityStore
} from '../../src/lib/audit-integrity/memory-integrity-store';
import { runIntegrityEventTypesDriftCheck } from '../../src/lib/audit-integrity/integrity-event-types';

// ---------------------------------------------------------------------------
// Local helpers — owned by THIS file. No shared global fixtures the other
// test files can mutate.
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;

/** PII canaries — distinctive strings the F-94 / F-100 grep rejects. */
const KNOWN_USER_ID_CANARY = '88888888-9999-4aaa-bbbb-cccccccccccc';
const KNOWN_CONCERN_ID_CANARY = 'cccccccc-dddd-4eee-9fff-000000000001';
const EMAIL_PROBE = 'should-never-leak@jhsc-test.invalid';
const PHONE_PROBE = '+15555550101';
const PSEUDONYM_SHAPE_PROBE = 'a'.repeat(32);

/** Pseudonym-shape regex — 32 contiguous hex chars with word boundaries
 *  (HMAC-SHA-256 first 16 bytes hex per ADR-0016). */
const PSEUDONYM_SHAPE = /\b[0-9a-f]{32}\b/i;

/** Hex >64 chars (anything beyond the BLAKE2b-256 chain hash + the
 *  manifest sha256). Used as a structural canary. */
const HEX_OVER_64 = /\b[0-9a-f]{65,}\b/i;

/** Email-shape regex. */
const EMAIL_SHAPE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** Phone-shape regex (NANP). */
const PHONE_SHAPE = /\+1\d{10}|\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/;

/** UUID shape (any version). */
const UUID_SHAPE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

/** Construct a fresh MemoryIntegrityStore. */
function makeStore(): TestIntegrityStore {
  return new MemoryIntegrityStore();
}

/** Seed N chain rows. Row i has ts_ms = FROZEN_NOW_MS - (N-i+1)*HOUR_MS,
 *  so row 1 is oldest and row N is newest. */
function seedChain(
  store: TestIntegrityStore,
  count: number,
  opts: { event_type?: string } = {}
): ReadonlyArray<{ id: string; ts_ms: number; hash: string; event_type: string }> {
  const out: { id: string; ts_ms: number; hash: string; event_type: string }[] = [];
  for (let i = 1; i <= count; i++) {
    const ts_ms = FROZEN_NOW_MS - (count - i + 1) * HOUR_MS;
    const id = String(i);
    // BLAKE2b-256 production hashes are uniformly random hex; this seed mirrors
    // that entropy shape with HMAC-SHA-256(test-fixed-key, id) so digit-only
    // fixtures don't trip PHONE_SHAPE (G-T18-PRIV-11 in-cycle fix).
    const hash = createHmac('sha256', 'seedChain-fixed-key').update(id).digest('hex');
    const event_type = opts.event_type ?? 'concern.created';
    store.__debugInsertChainRow({
      id,
      ts_ms,
      hash,
      event_type,
      prev_hash: i === 1 ? '0'.repeat(64) : createHmac('sha256', 'seedChain-fixed-key').update(String(i - 1)).digest('hex'),
      actor_pseudonym: '0'.repeat(32),
      target_id: null,
      target_class: 'C1',
      severity: 'info',
      request_id: null,
      rotation_id: null,
      meta: {}
    });
    out.push({ id, ts_ms, hash, event_type });
  }
  return out;
}

/** Filter mismatch audit rows out of the store's emitted-rows list. */
function listMismatchRows(store: TestIntegrityStore): ReadonlyArray<{
  event_type: string;
  actor_pseudonym: string;
  ts_ms: number;
  target_id: string | null;
  meta: Record<string, unknown>;
}> {
  return store
    .__debugListAuditRows()
    .filter((r) => r.event_type === 'audit.integrity_check.mismatch') as ReadonlyArray<{
      event_type: string;
      actor_pseudonym: string;
      ts_ms: number;
      target_id: string | null;
      meta: Record<string, unknown>;
    }>;
}

/** Filter ran (summary) audit rows. */
function listRanRows(store: TestIntegrityStore): ReadonlyArray<{
  event_type: string;
  actor_pseudonym: string;
  ts_ms: number;
  target_id: string | null;
  meta: Record<string, unknown>;
}> {
  return store
    .__debugListAuditRows()
    .filter((r) => r.event_type === 'audit.integrity_check.ran') as ReadonlyArray<{
      event_type: string;
      actor_pseudonym: string;
      ts_ms: number;
      target_id: string | null;
      meta: Record<string, unknown>;
    }>;
}

/** Filter weekly-anchor audit rows. */
function listAnchorRows(store: TestIntegrityStore): ReadonlyArray<{
  event_type: string;
  actor_pseudonym: string;
  ts_ms: number;
  target_id: string | null;
  meta: Record<string, unknown>;
}> {
  return store
    .__debugListAuditRows()
    .filter((r) => r.event_type === 'audit.chain_anchor.weekly') as ReadonlyArray<{
      event_type: string;
      actor_pseudonym: string;
      ts_ms: number;
      target_id: string | null;
      meta: Record<string, unknown>;
    }>;
}

/** Helper: did the result carry the alert symbol (single OR in-array)? */
function resultIncludesAlert(
  result: unknown,
  symbol: 'A-AUDIT-001' | 'A-INTEGRITY-002'
): boolean {
  const r = result as { would_fire_alert?: string | readonly string[] };
  if (r.would_fire_alert === undefined) return false;
  if (typeof r.would_fire_alert === 'string') return r.would_fire_alert === symbol;
  return r.would_fire_alert.includes(symbol);
}

/** Recursively collect every string VALUE in an object (excluding keys). */
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
      for (const k of Object.keys(v as Record<string, unknown>)) {
        visit((v as Record<string, unknown>)[k]);
      }
    }
  };
  visit(value);
  return out;
}

/** Recursively collect every KEY name in an object. */
function collectAllKeys(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (typeof v === 'object') {
      for (const k of Object.keys(v as Record<string, unknown>)) {
        out.push(k);
        visit((v as Record<string, unknown>)[k]);
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
// F-86 — Closed-allowlist drift on INTEGRITY_CHECK_EVENT_TYPES
//        Three layers: (a) Object.freeze; (b) union exactly equals const
//        element type; (c) drift-check helper. Mirrors F-55 / F-70.
// ===========================================================================

describe('T18 / F-86 — INTEGRITY_CHECK_EVENT_TYPES closed-allowlist drift', () => {
  it('T18 / F-86 (a) — INTEGRITY_CHECK_EVENT_TYPES is Object.isFrozen (spread-then-mutate defense)', () => {
    expect(
      Object.isFrozen(INTEGRITY_CHECK_EVENT_TYPES),
      'INTEGRITY_CHECK_EVENT_TYPES MUST be Object.freeze([...] as const) per ADR-0019 Decision §2'
    ).toBe(true);
  });

  it('T18 / F-86 (a) — INTEGRITY_CHECK_EVENT_TYPES contains exactly the three ADR-0019 §2 verbatim event types', () => {
    const sorted = [...INTEGRITY_CHECK_EVENT_TYPES].sort();
    expect(sorted).toEqual(
      [
        'audit.chain_anchor.weekly',
        'audit.integrity_check.mismatch',
        'audit.integrity_check.ran'
      ].sort()
    );
  });

  it('T18 / F-86 (b) — IntegrityCheckEventType union exactly equals the const element type (compile-time + runtime mirror)', () => {
    // Compile-time: each entry must be assignable to IntegrityCheckEventType.
    // The implementer wires `type IntegrityCheckEventType = typeof INTEGRITY_CHECK_EVENT_TYPES[number]`.
    for (const et of INTEGRITY_CHECK_EVENT_TYPES) {
      const narrowed: IntegrityCheckEventType = et;
      expect(narrowed).toBe(et);
    }
    expect(INTEGRITY_CHECK_EVENT_TYPES.length).toBe(3);
  });

  it('T18 / F-86 (b) — compile-time exhaustiveness: switch over IntegrityCheckEventType reaches `never` default', () => {
    // Mirrors T16 F-55 / T17 F-70 closed-switch defense-in-depth.
    function classify(et: IntegrityCheckEventType): string {
      switch (et) {
        case 'audit.integrity_check.ran':
          return 'ran';
        case 'audit.integrity_check.mismatch':
          return 'mismatch';
        case 'audit.chain_anchor.weekly':
          return 'anchor';
        default: {
          const _exhaustive: never = et;
          throw new Error(`unreachable: event_type outside closed enum: ${_exhaustive as string}`);
        }
      }
    }
    for (const et of INTEGRITY_CHECK_EVENT_TYPES) {
      expect(() => classify(et)).not.toThrow();
    }
    // Runtime: a poisoned value (not in the union) MUST throw.
    expect(() => classify('audit.fake.event' as unknown as IntegrityCheckEventType)).toThrow(
      /closed enum|unreachable/i
    );
  });

  it('T18 / F-86 (c) — runIntegrityEventTypesDriftCheck() returns {ok: true} on the canonical state', () => {
    const verdict = runIntegrityEventTypesDriftCheck();
    expect(
      verdict.ok,
      `expected drift check OK on canonical INTEGRITY_CHECK_EVENT_TYPES; got: ${JSON.stringify(verdict)}`
    ).toBe(true);
  });

  it('T18 / F-86 (c) — drift caught: removing `audit.integrity_check.mismatch` fails drift-check (named missing)', () => {
    // Deep-clone, mutate, feed through the helper's test-injection point.
    const cloned = [...INTEGRITY_CHECK_EVENT_TYPES].filter(
      (e) => e !== 'audit.integrity_check.mismatch'
    );
    const verdict = runIntegrityEventTypesDriftCheck({ __overrideForTest: cloned });
    expect(verdict.ok).toBe(false);
    // Diagnosability: the verdict names which entry is missing.
    expect((verdict as { missing?: string[] }).missing).toContain(
      'audit.integrity_check.mismatch'
    );
  });

  it('T18 / F-86 (c) — drift caught: adding a phantom entry (not in IntegrityCheckEventType union) fails drift-check (named orphan)', () => {
    const cloned = [
      ...INTEGRITY_CHECK_EVENT_TYPES,
      'audit.integrity_check.phantom'
    ] as ReadonlyArray<string>;
    const verdict = runIntegrityEventTypesDriftCheck({ __overrideForTest: cloned });
    expect(verdict.ok).toBe(false);
    expect((verdict as { orphan?: string[] }).orphan).toContain('audit.integrity_check.phantom');
  });
});

// ===========================================================================
// F-87 — Audit-before-alert-fanout (F-24 generalized)
//        Mismatch row is written BEFORE the alert symbol is observable on
//        the IntegrityRunResult.
// ===========================================================================

describe('T18 / F-87 — audit row precedes alert-fanout (F-24 mirror)', () => {
  it('T18 / F-87 — force one mismatch: the mismatch row is present in __debugListAuditRows BEFORE the result carries would_fire_alert', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5);
    store.__debugCorruptRowHash(rows[2]!.id, 'badbad00'.repeat(8));

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('completed');

    // The mismatch row exists in the store BEFORE we read the alert symbol.
    const mismatches = listMismatchRows(store);
    expect(
      mismatches.length,
      'mismatch row MUST be visible in __debugListAuditRows before the alert assertion'
    ).toBeGreaterThanOrEqual(1);

    // NOW assert the alert symbol on the result — the mismatch precedes it.
    expect(
      resultIncludesAlert(result, 'A-AUDIT-001'),
      'result.would_fire_alert MUST contain A-AUDIT-001 (F-87 contract)'
    ).toBe(true);
  });

  it('T18 / F-87 — emission order within the same pass: every mismatch row precedes the ran row', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5);
    store.__debugCorruptRowHash(rows[1]!.id, 'aabb'.repeat(16));
    store.__debugCorruptRowHash(rows[3]!.id, 'ccdd'.repeat(16));

    await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });

    const all = store.__debugListAuditRows();
    const integrityRows = all.filter(
      (r) =>
        r.event_type === 'audit.integrity_check.mismatch' ||
        r.event_type === 'audit.integrity_check.ran'
    );
    // The last integrity row is the `ran` row; every prior is a mismatch.
    expect(integrityRows.length).toBeGreaterThanOrEqual(2);
    expect(
      integrityRows[integrityRows.length - 1]!.event_type,
      'the ran row is the LAST integrity-event-type write in the pass (F-87 + F-88)'
    ).toBe('audit.integrity_check.ran');
    for (let i = 0; i < integrityRows.length - 1; i++) {
      expect(integrityRows[i]!.event_type).toBe('audit.integrity_check.mismatch');
    }
  });

  it('T18 / F-87 — successful detection pass terminal status is `completed` (NOT `errored`); the alert symbol surfaces alongside completion', async () => {
    const store = makeStore();
    const rows = seedChain(store, 3);
    store.__debugCorruptRowHash(rows[1]!.id, 'feeb'.repeat(16));
    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('completed');
    expect(resultIncludesAlert(result, 'A-AUDIT-001')).toBe(true);
  });
});

// ===========================================================================
// F-88 — Summary-LAST in tx + rollback-on-emit-failure (F-58 mirror)
// ===========================================================================

describe('T18 / F-88 — audit.integrity_check.ran is LAST in tx + rollback on emit failure', () => {
  it('T18 / F-88 (a) — happy path with 3 forced mismatches: emission order is exactly [mismatch_1, mismatch_2, mismatch_3, ran]', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5);
    store.__debugCorruptRowHash(rows[0]!.id, '1111'.repeat(16));
    store.__debugCorruptRowHash(rows[2]!.id, '2222'.repeat(16));
    store.__debugCorruptRowHash(rows[4]!.id, '3333'.repeat(16));

    await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });

    const integrityRows = store
      .__debugListAuditRows()
      .filter(
        (r) =>
          r.event_type === 'audit.integrity_check.mismatch' ||
          r.event_type === 'audit.integrity_check.ran'
      );
    const seq = integrityRows.map((r) => r.event_type);
    expect(
      seq,
      `expected exactly [mismatch, mismatch, mismatch, ran]; got ${JSON.stringify(seq)}`
    ).toEqual([
      'audit.integrity_check.mismatch',
      'audit.integrity_check.mismatch',
      'audit.integrity_check.mismatch',
      'audit.integrity_check.ran'
    ]);
  });

  it('T18 / F-88 (b) — forced summary-emit failure: NO mismatch rows persist (full rollback); NO ran row; result is errored with `summary_emit_failed`', async () => {
    const store = makeStore();
    const rows = seedChain(store, 3);
    store.__debugCorruptRowHash(rows[1]!.id, 'dada'.repeat(16));
    // Force the ran-row emission to throw — the store's tx rolls back.
    store.__forceSummaryEmitFailure(true);

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });

    expect(result.status).toBe('errored');
    // The error_code is one of the closed-literal union. The architect spec
    // (and threat-model §3.11 F-88) names this as either `audit_emit_failed`
    // or the more specific `summary_emit_failed`. We assert the structural
    // property: it is one of the closed literals AND signals the failure.
    const errCode = (result as { error_code?: string }).error_code;
    expect(
      ['audit_emit_failed', 'summary_emit_failed'].includes(errCode ?? ''),
      `expected error_code in {audit_emit_failed, summary_emit_failed}; got: ${errCode}`
    ).toBe(true);

    // Full rollback: NO mismatch rows surface in the audit log.
    expect(
      listMismatchRows(store).length,
      'mismatch rows MUST NOT persist after a summary-emit rollback (F-58 + F-72 atomicity)'
    ).toBe(0);
    // NO ran row was emitted.
    expect(
      listRanRows(store).length,
      'the ran row MUST NOT be emitted on an errored pass (absence is the signal)'
    ).toBe(0);

    // NO `would_fire_alert` symbol on the errored result (alert firing
    // depends on the full emission succeeding; F-87 + F-88 coherence).
    expect((result as { would_fire_alert?: unknown }).would_fire_alert).toBeUndefined();
  });

  it('T18 / F-88 (b) — forced summary-emit failure: integrity_check_runs row does NOT transition to terminal status (rollback)', async () => {
    const store = makeStore();
    seedChain(store, 3);
    store.__forceSummaryEmitFailure(true);
    await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    // The run row, if present, MUST NOT carry a terminal `completed` status.
    // (The implementer may leave it in `running` to be reaped by the next
    //  pass's lease check, or delete it on rollback; either is acceptable.)
    const runs = store.__debugListRuns();
    for (const r of runs) {
      expect(
        r.status === 'completed',
        `integrity_check_runs row MUST NOT show status='completed' after rollback; got: ${JSON.stringify(r)}`
      ).toBe(false);
    }
  });
});

// ===========================================================================
// F-89 — Chain-walk mismatch detection (primary detection surface)
// ===========================================================================

describe('T18 / F-89 — chain-walk mismatch detection (primary surface)', () => {
  it('T18 / F-89 — corrupt row 3 in a 5-row chain → mismatch row carries detected_via:chain_walk + correct row_id; result fires A-AUDIT-001', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5);
    const targetRow = rows[2]!; // row 3 (id='3')
    store.__debugCorruptRowHash(targetRow.id, 'cafecafe'.repeat(8));

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('completed');

    const chainWalkMismatches = listMismatchRows(store).filter(
      (m) => (m.meta as { detected_via: string }).detected_via === 'chain_walk'
    );
    expect(
      chainWalkMismatches.length,
      `expected ≥1 chain_walk mismatch; got ${chainWalkMismatches.length}`
    ).toBeGreaterThanOrEqual(1);

    // The mismatch with our target row_id has the expected shape.
    const m = chainWalkMismatches.find(
      (mm) => (mm.meta as { row_id: string }).row_id === targetRow.id
    );
    expect(
      m,
      `expected a chain_walk mismatch with meta.row_id === '${targetRow.id}'`
    ).toBeDefined();
    expect((m!.meta as { detected_via: string }).detected_via).toBe('chain_walk');
    expect((m!.meta as { row_id: string }).row_id).toBe(targetRow.id);
    expect((m!.meta as { attribution_attempted: boolean }).attribution_attempted).toBe(false);

    expect(resultIncludesAlert(result, 'A-AUDIT-001')).toBe(true);
  });

  it('T18 / F-89 — clean fixture (no corruption): zero mismatches, no alert symbol', async () => {
    const store = makeStore();
    seedChain(store, 10);
    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('completed');
    expect(listMismatchRows(store).length).toBe(0);
    expect((result as { would_fire_alert?: unknown }).would_fire_alert).toBeUndefined();
  });
});

// ===========================================================================
// F-90 — Sequential-id gap detection with sweep attribution
// ===========================================================================

describe('T18 / F-90 — sequential-id gap detection with sweep attribution', () => {
  it('T18 / F-90 (a) — delete row 3 in a 5-row chain (no sweep accounting): gap detected; result fires A-AUDIT-001', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5);
    const deletedRow = rows[2]!; // id='3'
    store.__debugDeleteRowAtId(deletedRow.id);

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('completed');

    // A chain_walk mismatch surfaces on the row AFTER the gap (its prev_hash
    // no longer matches the preceding live row's hash).
    const mismatches = listMismatchRows(store);
    expect(
      mismatches.length,
      `expected ≥1 mismatch on the unattributed gap deletion; got ${mismatches.length}`
    ).toBeGreaterThanOrEqual(1);
    expect(resultIncludesAlert(result, 'A-AUDIT-001')).toBe(true);
  });

  it('T18 / F-90 (b) — delete row 3 BUT seed a matching retention_sweep_runs fixture: the gap is ATTRIBUTED; NO alert fires', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5, { event_type: 'concern.created' });
    const deletedRow = rows[2]!;

    // Seed a sweep_run that accounts for the deletion: per_event_counts has
    // the deleted row's event_type ≥ 1, and the sweep window contains the
    // deleted row's ts.
    store.__debugInsertSweepRunFixture({
      run_id: 'sw_F90_attributed',
      started_at_ms: deletedRow.ts_ms - 1,
      completed_at_ms: deletedRow.ts_ms + 1,
      per_event_counts: { 'concern.created': 1 },
      status: 'completed'
    });

    // Also seed a manifest whose retention_sweep_runs_snapshot_ts_ms is
    // AFTER the sweep_run's started_at (so the sweep is visible to T18).
    const headRow = rows[4]!;
    store.__debugInsertBackupManifestFixture({
      run_id: 'bp_F90_attributed',
      committed_at_ms: FROZEN_NOW_MS,
      audit_log_head: { id: headRow.id, ts_ms: headRow.ts_ms, hash: headRow.hash },
      per_event_row_counts: { 'concern.created': 5 },
      retention_sweep_runs_snapshot_ts_ms: FROZEN_NOW_MS,
      schedule_hash: 'sched_v1',
      node_runtime_pin: store.readNodeRuntimePin()
    });

    store.__debugDeleteRowAtId(deletedRow.id);

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('completed');

    // No alert fires.
    expect(
      (result as { would_fire_alert?: unknown }).would_fire_alert,
      'attributed gap MUST NOT fire any alert (Option G binding rule)'
    ).toBeUndefined();
  });
});

// ===========================================================================
// F-92 — Attributed-vs-unattributable reconciliation (Option G rule)
//        Five sub-directions per threat-model §3.11 architect ask #2.
// ===========================================================================

describe('T18 / F-92 — reconciliation attribution rule (Option G; 5 directions)', () => {
  // Helper: seed 50 rows + a manifest pointing at row 50, with optional
  // sweep fixtures. Returns the rows + the head id.
  function seedReconciliationScenario(
    store: TestIntegrityStore,
    sweepFixtures: ReadonlyArray<{
      run_id: string;
      started_at_ms: number;
      completed_at_ms: number;
      per_event_counts: Record<string, number>;
    }> = []
  ): { rows: ReadonlyArray<{ id: string; ts_ms: number; hash: string; event_type: string }> } {
    const rows = seedChain(store, 50, { event_type: 'concern.created' });
    const headRow = rows[49]!;
    // Advance 1h+ so the buffer-window allows backup-diff to walk all rows.
    advanceBy(1 * HOUR_MS + 1);
    store.__debugInsertBackupManifestFixture({
      run_id: 'bp_F92_scenario',
      committed_at_ms: FROZEN_NOW_MS,
      audit_log_head: { id: headRow.id, ts_ms: headRow.ts_ms, hash: headRow.hash },
      per_event_row_counts: { 'concern.created': 50 },
      retention_sweep_runs_snapshot_ts_ms: FROZEN_NOW_MS + 1 * HOUR_MS + 1,
      schedule_hash: 'sched_v1',
      node_runtime_pin: store.readNodeRuntimePin()
    });
    for (const sw of sweepFixtures) {
      store.__debugInsertSweepRunFixture({ ...sw, status: 'completed' });
    }
    return { rows };
  }

  // ---- Direction 1: attributed → no alert ----
  it('T18 / F-92 (a) attributed direction — row 30 deleted; matching sweep_run accounts for it → NO alert; mismatch absent; attributable_count:1', async () => {
    const store = makeStore();
    const { rows } = seedReconciliationScenario(store, []);
    const targetRow = rows[29]!;
    store.__debugInsertSweepRunFixture({
      run_id: 'sw_F92_attr',
      started_at_ms: targetRow.ts_ms - 1,
      completed_at_ms: targetRow.ts_ms + 1,
      per_event_counts: { 'concern.created': 1 },
      status: 'completed'
    });
    store.__debugDeleteRowAtId(targetRow.id);

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('completed');

    // No alert; no reconciliation-mismatch row for row 30.
    expect(
      (result as { would_fire_alert?: unknown }).would_fire_alert,
      'attributed deletion MUST NOT fire any alert'
    ).toBeUndefined();
    const row30Mismatches = listMismatchRows(store).filter(
      (m) => (m.meta as { row_id: string }).row_id === targetRow.id
    );
    expect(row30Mismatches.length).toBe(0);
    expect((result as { attributable_count?: number }).attributable_count).toBe(1);
    expect((result as { unattributable_count?: number }).unattributable_count).toBe(0);
  });

  // ---- Direction 2: unattributable → both alerts ----
  it('T18 / F-92 (b) unattributable direction — row 30 deleted; NO matching sweep_run → BOTH A-AUDIT-001 AND A-INTEGRITY-002 fire distinctly', async () => {
    const store = makeStore();
    const { rows } = seedReconciliationScenario(store, []);
    const targetRow = rows[29]!;
    // NO sweep fixture is inserted (or insert a non-matching one).
    store.__debugDeleteRowAtId(targetRow.id);

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('completed');

    expect(
      resultIncludesAlert(result, 'A-AUDIT-001'),
      'unattributable backup-diff divergence MUST fire A-AUDIT-001'
    ).toBe(true);
    expect(
      resultIncludesAlert(result, 'A-INTEGRITY-002'),
      'unattributable backup-diff divergence MUST fire A-INTEGRITY-002 (distinct cause)'
    ).toBe(true);

    expect((result as { unattributable_count?: number }).unattributable_count).toBe(1);

    // The mismatch row carries attribution_attempted: true + actual_hash: null
    // (live row absent; reconciliation walker ran but found no eligible sweep).
    const row30Mismatch = listMismatchRows(store).find(
      (m) => (m.meta as { row_id: string }).row_id === targetRow.id
    );
    expect(row30Mismatch).toBeDefined();
    expect((row30Mismatch!.meta as { detected_via: string }).detected_via).toBe('backup_diff');
    expect((row30Mismatch!.meta as { attribution_attempted: boolean }).attribution_attempted).toBe(
      true
    );
    expect((row30Mismatch!.meta as { actual_hash: unknown }).actual_hash).toBeNull();
  });

  // ---- Direction 3: zero-event-count convention (missing key = 0) ----
  it('T18 / F-92 (c) zero-event-count convention — sweep with `per_event_counts` MISSING the key entirely treats count as 0; row is unattributable', async () => {
    const store = makeStore();
    const { rows } = seedReconciliationScenario(store, []);
    const targetRow = rows[29]!;
    // Sweep exists in the window BUT does not list the target event_type.
    // G-T17-9: absent key = zero, NOT a wildcard.
    store.__debugInsertSweepRunFixture({
      run_id: 'sw_F92_zero_convention',
      started_at_ms: targetRow.ts_ms - 1,
      completed_at_ms: targetRow.ts_ms + 1,
      per_event_counts: { 'inspection.submitted': 1 }, // wrong event_type
      status: 'completed'
    });
    store.__debugDeleteRowAtId(targetRow.id);

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(
      resultIncludesAlert(result, 'A-AUDIT-001'),
      'missing per_event_counts[event_type] means count=0 (G-T17-9); row is unattributable; A-AUDIT-001 fires'
    ).toBe(true);
    expect(resultIncludesAlert(result, 'A-INTEGRITY-002')).toBe(true);
    expect((result as { unattributable_count?: number }).unattributable_count).toBe(1);
  });

  // ---- Direction 4: greedy attribution budget ----
  it('T18 / F-92 (d) greedy attribution budget — sweep with count=3; 5 rows absent; only 3 attributed; 2 remain unattributable', async () => {
    const store = makeStore();
    const { rows } = seedReconciliationScenario(store, []);

    // Choose 5 rows to delete. Window covers all of them.
    const toDelete = [rows[10]!, rows[15]!, rows[20]!, rows[25]!, rows[30]!];
    const minTs = Math.min(...toDelete.map((r) => r.ts_ms));
    const maxTs = Math.max(...toDelete.map((r) => r.ts_ms));

    store.__debugInsertSweepRunFixture({
      run_id: 'sw_F92_greedy',
      started_at_ms: minTs - 1,
      completed_at_ms: maxTs + 1,
      per_event_counts: { 'concern.created': 3 }, // budget for only 3
      status: 'completed'
    });
    for (const r of toDelete) store.__debugDeleteRowAtId(r.id);

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('completed');

    // 3 attributed, 2 unattributable.
    expect((result as { attributable_count?: number }).attributable_count).toBe(3);
    expect((result as { unattributable_count?: number }).unattributable_count).toBe(2);
    expect(
      resultIncludesAlert(result, 'A-AUDIT-001'),
      'partial attribution still fires A-AUDIT-001 on the residual unattributable rows'
    ).toBe(true);
    expect(resultIncludesAlert(result, 'A-INTEGRITY-002')).toBe(true);
  });

  // ---- Direction 5: __ceiling__ never read (G-T16-RECONCILE-CEILING) ----
  it('T18 / F-92 (e) `__ceiling__` never read — hostile sweep fixture with `per_event_counts[__ceiling__] = 99` provides ZERO attribution credit', async () => {
    const store = makeStore();
    const { rows } = seedReconciliationScenario(store, []);
    const targetRow = rows[29]!;

    // Hostile fixture: __ceiling__ is a sentinel an attacker MIGHT use to
    // try to absorb attribution; the library MUST NEVER read this key.
    store.__debugInsertSweepRunFixture({
      run_id: 'sw_F92_ceiling',
      started_at_ms: targetRow.ts_ms - 1,
      completed_at_ms: targetRow.ts_ms + 1,
      per_event_counts: { __ceiling__: 99 } as Record<string, number>,
      status: 'completed'
    });
    store.__debugDeleteRowAtId(targetRow.id);

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    // __ceiling__ provides NO credit; the row remains unattributable.
    expect(
      resultIncludesAlert(result, 'A-AUDIT-001'),
      '__ceiling__ MUST NEVER be read for attribution (G-T16-RECONCILE-CEILING)'
    ).toBe(true);
    expect((result as { unattributable_count?: number }).unattributable_count).toBe(1);
    expect((result as { attributable_count?: number }).attributable_count).toBe(0);
  });
});

// ===========================================================================
// F-93 — Runtime-pin coherence (OPERATIONAL not A-AUDIT-001)
// ===========================================================================

describe('T18 / F-93 — runtime-pin coherence is OPERATIONAL (not A-AUDIT-001)', () => {
  it('T18 / F-93 — manifest pin vs live pin mismatch → status:errored, error_code:runtime_pin_mismatch; NO mismatch rows; NO A-AUDIT-001 (false-positive prevention)', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5);
    const headRow = rows[4]!;
    // Insert a manifest with an OLD pin.
    store.__debugInsertBackupManifestFixture({
      run_id: 'bp_F93_pin_mismatch',
      committed_at_ms: FROZEN_NOW_MS,
      audit_log_head: { id: headRow.id, ts_ms: headRow.ts_ms, hash: headRow.hash },
      per_event_row_counts: { 'concern.created': 5 },
      retention_sweep_runs_snapshot_ts_ms: FROZEN_NOW_MS,
      schedule_hash: 'sched_v1',
      node_runtime_pin: { node_version: '21.5.0', openssl_version: '3.0.10' }
    });
    // Force the live pin to differ.
    store.__setLiveRuntimePin({ node_version: '22.10.1', openssl_version: '3.1.4' });

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });

    expect(result.status).toBe('errored');
    expect((result as { error_code?: string }).error_code).toBe('runtime_pin_mismatch');

    // NO mismatch rows emitted (chain-walk was skipped).
    expect(
      listMismatchRows(store).length,
      'NO mismatch rows on runtime_pin_mismatch (the error is operational, not adversarial)'
    ).toBe(0);

    // NO A-AUDIT-001 (false-positive prevention on toolchain upgrades).
    expect(
      (result as { would_fire_alert?: unknown }).would_fire_alert,
      'runtime_pin_mismatch MUST NOT fire A-AUDIT-001'
    ).toBeUndefined();
  });

  it('T18 / F-93 — clean pin (live matches manifest): proceeds normally; runtime_pin_mismatch does not fire', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5);
    const headRow = rows[4]!;
    store.__debugInsertBackupManifestFixture({
      run_id: 'bp_F93_clean_pin',
      committed_at_ms: FROZEN_NOW_MS,
      audit_log_head: { id: headRow.id, ts_ms: headRow.ts_ms, hash: headRow.hash },
      per_event_row_counts: { 'concern.created': 5 },
      retention_sweep_runs_snapshot_ts_ms: FROZEN_NOW_MS,
      schedule_hash: 'sched_v1',
      node_runtime_pin: store.readNodeRuntimePin() // live pin
    });
    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).not.toBe('errored');
  });

  it('T18 / F-93 — null manifest: coherence check SKIPPED entirely; chain-walk proceeds independently (no pin comparison happens)', async () => {
    const store = makeStore();
    seedChain(store, 5);
    // Even with live pin forced to a sentinel that wouldn't match anything,
    // the absence of a manifest means there's no pin to compare against.
    store.__setLiveRuntimePin({ node_version: 'sentinel', openssl_version: 'sentinel' });
    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).not.toBe('errored');
    expect((result as { error_code?: unknown }).error_code).toBeUndefined();
  });
});

// ===========================================================================
// F-94 — No PII in mismatch / ran / anchor rows
//        G-T17-PRIV-7 + G-T16-PRIV-1 structural seals.
// ===========================================================================

describe('T18 / F-94 — no PII in emitted audit rows', () => {
  it('T18 / F-94 — mismatch row: actor_pseudonym at TOP LEVEL only; NOT duplicated into meta (G-T16-PRIV-1)', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5);
    store.__debugCorruptRowHash(rows[2]!.id, 'feedface'.repeat(8));
    await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });

    const mismatches = listMismatchRows(store);
    expect(mismatches.length).toBeGreaterThanOrEqual(1);
    for (const m of mismatches) {
      // Top-level actor_pseudonym is the HMAC of 'system:integrity-check'.
      expect(typeof m.actor_pseudonym).toBe('string');
      expect(m.actor_pseudonym.length).toBeGreaterThan(0);
      // meta MUST NOT contain actor_pseudonym.
      expect(
        'actor_pseudonym' in m.meta,
        'meta.actor_pseudonym MUST NOT exist (G-T16-PRIV-1: pseudonym at top level only)'
      ).toBe(false);
    }
  });

  it('T18 / F-94 — mismatch row: meta contains ONLY structural fields (no row content excerpts; G-T17-PRIV-7)', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5);
    store.__debugCorruptRowHash(rows[2]!.id, 'feedface'.repeat(8));
    await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });

    const mismatches = listMismatchRows(store);
    expect(mismatches.length).toBeGreaterThanOrEqual(1);
    const allowedKeys = new Set([
      'run_id',
      'detected_via',
      'row_id',
      'expected_hash',
      'actual_hash',
      'prev_hash_match',
      'attribution_attempted',
      'backup_manifest_run_id'
    ]);
    for (const m of mismatches) {
      for (const k of Object.keys(m.meta)) {
        expect(
          allowedKeys.has(k),
          `mismatch row's meta contained an unexpected key "${k}"; allowed keys: ${[...allowedKeys].join(',')}`
        ).toBe(true);
      }
      // Specifically: no `event_type` of the mismatching row leaks (that
      // would correlate to a specific user's action).
      expect('event_type' in m.meta).toBe(false);
      expect('target_id' in m.meta).toBe(false);
      expect('severity' in m.meta).toBe(false);
    }
  });

  it('T18 / F-94 — mismatch row meta: no 32-hex pseudonym shape ANYWHERE in nested values (deep grep)', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5);
    // Plant a pseudonym-shape canary in the row's actor field. The row is
    // the source data; the mismatch row's meta MUST NOT carry it through.
    store.__debugInsertChainRow({
      id: 'planted-actor',
      ts_ms: FROZEN_NOW_MS - 6 * HOUR_MS,
      hash: 'eeee'.repeat(16),
      event_type: 'concern.created',
      prev_hash: rows[rows.length - 1]!.hash,
      actor_pseudonym: PSEUDONYM_SHAPE_PROBE, // 32-hex canary
      target_id: KNOWN_USER_ID_CANARY, // UUID canary
      target_class: 'C1',
      severity: 'info',
      request_id: null,
      rotation_id: null,
      meta: { email: EMAIL_PROBE, phone: PHONE_PROBE } // PII canaries
    });
    store.__debugCorruptRowHash('planted-actor', '0bad0bad'.repeat(8));

    await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    const mismatches = listMismatchRows(store);
    expect(mismatches.length).toBeGreaterThanOrEqual(1);

    for (const m of mismatches) {
      const allVals = collectAllStringValues(m.meta);
      for (const v of allVals) {
        // Pseudonym-shape canary: MUST NOT appear in meta.
        expect(
          v.includes(PSEUDONYM_SHAPE_PROBE),
          `mismatch row meta leaked a pseudonym-shape value: ${v}`
        ).toBe(false);
        // UUID-shape user_id canary: MUST NOT appear.
        expect(
          v.includes(KNOWN_USER_ID_CANARY),
          `mismatch row meta leaked a user_id UUID: ${v}`
        ).toBe(false);
        // Email-shape canary: MUST NOT appear.
        expect(
          EMAIL_SHAPE.test(v),
          `mismatch row meta leaked an email shape: ${v}`
        ).toBe(false);
        // Phone-shape canary: MUST NOT appear.
        expect(
          PHONE_SHAPE.test(v),
          `mismatch row meta leaked a phone shape: ${v}`
        ).toBe(false);
      }
    }
  });

  it('T18 / F-94 — ran row: meta layout structural (Decision §9); top-level actor_pseudonym only; no PII shapes', async () => {
    const store = makeStore();
    seedChain(store, 3);
    await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    const ranRows = listRanRows(store);
    expect(ranRows.length).toBe(1);
    const r = ranRows[0]!;
    expect('actor_pseudonym' in r.meta).toBe(false); // G-T16-PRIV-1
    // Layout per Decision §9 — these keys MUST exist.
    expect('run_id' in r.meta).toBe(true);
    expect('trigger' in r.meta).toBe(true);
    expect('status' in r.meta).toBe(true);
    expect('rows_walked' in r.meta).toBe(true);
    expect('mismatches_count' in r.meta).toBe(true);
    expect('attributable_count' in r.meta).toBe(true);
    expect('unattributable_count' in r.meta).toBe(true);
    expect('backup_diff_performed' in r.meta).toBe(true);
    expect('node_runtime_pin' in r.meta).toBe(true);
    // No PII shapes anywhere.
    const all = collectAllStringValues(r.meta);
    for (const v of all) {
      expect(EMAIL_SHAPE.test(v), `ran row meta leaked email shape: ${v}`).toBe(false);
      expect(PHONE_SHAPE.test(v), `ran row meta leaked phone shape: ${v}`).toBe(false);
    }
  });

  it('T18 / F-94 — chain_anchor.weekly row: meta is the head-pointer triple ONLY; no PII shapes', async () => {
    const store = makeStore();
    seedChain(store, 3);
    await runWeeklyChainAnchor({ store });
    const anchors = listAnchorRows(store);
    expect(anchors.length).toBe(1);
    const a = anchors[0]!;
    expect('actor_pseudonym' in a.meta).toBe(false);
    expect('anchor_at_ms' in a.meta).toBe(true);
    expect('head' in a.meta).toBe(true);
    const head = (a.meta as { head: { id: string; ts_ms: number; hash: string } | null }).head;
    expect(head).not.toBeNull();
    expect(Object.keys(head!).sort()).toEqual(['hash', 'id', 'ts_ms']);
    // No PII shapes anywhere.
    const all = collectAllStringValues(a.meta);
    for (const v of all) {
      expect(EMAIL_SHAPE.test(v), `anchor row meta leaked email: ${v}`).toBe(false);
      expect(PHONE_SHAPE.test(v), `anchor row meta leaked phone: ${v}`).toBe(false);
    }
  });
});

// ===========================================================================
// F-95 — A-AUDIT-001 vs A-INTEGRITY-002 distinct causes (matrix)
// ===========================================================================

describe('T18 / F-95 — A-AUDIT-001 vs A-INTEGRITY-002 distinct causes (three-scenario matrix)', () => {
  it('T18 / F-95 (a) — chain-walk mismatch ONLY → would_fire_alert contains A-AUDIT-001; does NOT contain A-INTEGRITY-002', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5);
    store.__debugCorruptRowHash(rows[2]!.id, 'aaaa'.repeat(16));
    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(resultIncludesAlert(result, 'A-AUDIT-001')).toBe(true);
    expect(
      resultIncludesAlert(result, 'A-INTEGRITY-002'),
      'chain-walk-only mismatch MUST NOT fire A-INTEGRITY-002 (no reconciliation walker ran)'
    ).toBe(false);
  });

  it('T18 / F-95 (b) — unattributable reconciliation → BOTH A-AUDIT-001 AND A-INTEGRITY-002 (distinct symbols)', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5);
    const headRow = rows[4]!;
    advanceBy(1 * HOUR_MS + 1);
    store.__debugInsertBackupManifestFixture({
      run_id: 'bp_F95_unattr',
      committed_at_ms: FROZEN_NOW_MS,
      audit_log_head: { id: headRow.id, ts_ms: headRow.ts_ms, hash: headRow.hash },
      per_event_row_counts: { 'concern.created': 5 },
      retention_sweep_runs_snapshot_ts_ms: FROZEN_NOW_MS + 1 * HOUR_MS + 1,
      schedule_hash: 'sched_v1',
      node_runtime_pin: store.readNodeRuntimePin()
    });
    // Delete a row with NO matching sweep_run.
    store.__debugDeleteRowAtId(rows[2]!.id);
    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(resultIncludesAlert(result, 'A-AUDIT-001')).toBe(true);
    expect(resultIncludesAlert(result, 'A-INTEGRITY-002')).toBe(true);
  });

  it('T18 / F-95 (c) — attributable reconciliation → NEITHER A-AUDIT-001 NOR A-INTEGRITY-002', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5);
    const targetRow = rows[2]!;
    const headRow = rows[4]!;
    advanceBy(1 * HOUR_MS + 1);
    store.__debugInsertBackupManifestFixture({
      run_id: 'bp_F95_attr',
      committed_at_ms: FROZEN_NOW_MS,
      audit_log_head: { id: headRow.id, ts_ms: headRow.ts_ms, hash: headRow.hash },
      per_event_row_counts: { 'concern.created': 5 },
      retention_sweep_runs_snapshot_ts_ms: FROZEN_NOW_MS + 1 * HOUR_MS + 1,
      schedule_hash: 'sched_v1',
      node_runtime_pin: store.readNodeRuntimePin()
    });
    store.__debugInsertSweepRunFixture({
      run_id: 'sw_F95_attr',
      started_at_ms: targetRow.ts_ms - 1,
      completed_at_ms: targetRow.ts_ms + 1,
      per_event_counts: { 'concern.created': 1 },
      status: 'completed'
    });
    store.__debugDeleteRowAtId(targetRow.id);

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(resultIncludesAlert(result, 'A-AUDIT-001')).toBe(false);
    expect(resultIncludesAlert(result, 'A-INTEGRITY-002')).toBe(false);
  });
});

// ===========================================================================
// F-96 — Weekly chain anchor emission (RA-2 manual backstop)
// ===========================================================================

describe('T18 / F-96 — weekly chain anchor emission (RA-2 manual backstop)', () => {
  it('T18 / F-96 — runWeeklyChainAnchor emits exactly one audit.chain_anchor.weekly row with meta.head matching highest-id row', async () => {
    const store = makeStore();
    const rows = seedChain(store, 10);
    const expectedHead = rows[rows.length - 1]!; // id='10'
    const result = await runWeeklyChainAnchor({ store });

    expect(result.status).toBe('completed');
    const anchors = listAnchorRows(store);
    expect(anchors.length).toBe(1);

    const meta = anchors[0]!.meta as {
      anchor_at_ms: number;
      head: { id: string; ts_ms: number; hash: string };
    };
    expect(meta.head.id).toBe(expectedHead.id);
    expect(meta.head.ts_ms).toBe(expectedHead.ts_ms);
    expect(meta.head.hash).toBe(expectedHead.hash);

    // No alerts fire on a publication action.
    expect((result as { would_fire_alert?: unknown }).would_fire_alert).toBeUndefined();
  });

  it('T18 / F-96 — empty chain: {status: skipped, reason: empty_chain}; NO row emitted', async () => {
    const store = makeStore();
    // No rows seeded.
    const result = await runWeeklyChainAnchor({ store });
    expect(result.status).toBe('skipped');
    expect((result as { reason?: string }).reason).toBe('empty_chain');
    expect(listAnchorRows(store).length).toBe(0);
  });

  it('T18 / F-96 — meta.head is the snapshot-pinned triple {id, ts_ms, hash} — NO extra keys (rename detection)', async () => {
    const store = makeStore();
    seedChain(store, 3);
    await runWeeklyChainAnchor({ store });
    const anchors = listAnchorRows(store);
    const head = (anchors[0]!.meta as { head: Record<string, unknown> }).head;
    expect(Object.keys(head).sort()).toEqual(['hash', 'id', 'ts_ms']);
  });
});

// ===========================================================================
// F-97 — No caller-supplied predicate / pivot / WHERE / row-range / runtime_pin
//        Type-level half lives in ./fixtures/poisoned-config.ts.
// ===========================================================================

describe('T18 / F-97 — no caller-supplied config beyond {trigger, lease_window_ms?, dry_run?}', () => {
  it('T18 / F-97 — runIntegrityCheck arity: accepts only one object arg ({store, config})', () => {
    expect(typeof runIntegrityCheck).toBe('function');
    expect(runIntegrityCheck.length).toBe(1);
  });

  it('T18 / F-97 — runWeeklyChainAnchor arity: accepts only one object arg ({store})', () => {
    expect(typeof runWeeklyChainAnchor).toBe('function');
    expect(runWeeklyChainAnchor.length).toBe(1);
  });

  it('T18 / F-97 — IntegrityCheckTrigger union is exactly {scheduled, post_rotation, post_export} (closed set)', () => {
    // Compile-time check: each literal narrows correctly.
    const t1: IntegrityCheckTrigger = 'scheduled';
    const t2: IntegrityCheckTrigger = 'post_rotation';
    const t3: IntegrityCheckTrigger = 'post_export';
    expect([t1, t2, t3]).toEqual(['scheduled', 'post_rotation', 'post_export']);
  });

  it('T18 / F-97 — @ts-expect-error smoke: each forbidden field fails compile when added to IntegrityCheckRunConfig', () => {
    // The poisoned-config fixture (`./fixtures/poisoned-config.ts`) is the
    // dedicated tsc --noEmit fail surface. This inline smoke proves the
    // property at the spot where the test reader can see it.
    // @ts-expect-error — F-97: predicate forbidden.
    const _a: IntegrityCheckRunConfig = { trigger: 'scheduled', predicate: 'id<100' };
    // @ts-expect-error — F-97: pivot forbidden.
    const _b: IntegrityCheckRunConfig = { trigger: 'scheduled', pivot: '42' };
    // @ts-expect-error — F-97: where forbidden.
    const _c: IntegrityCheckRunConfig = { trigger: 'scheduled', where: 'x=1' };
    // @ts-expect-error — F-97: runtime_pin forbidden.
    const _d: IntegrityCheckRunConfig = {
      trigger: 'scheduled',
      runtime_pin: { node_version: 'x', openssl_version: 'y' }
    };
    // @ts-expect-error — F-97: row_range forbidden.
    const _e: IntegrityCheckRunConfig = { trigger: 'scheduled', row_range: [1, 2] };
    // @ts-expect-error — F-97: max_rows forbidden.
    const _f: IntegrityCheckRunConfig = { trigger: 'scheduled', max_rows: 1000 };
    void _a;
    void _b;
    void _c;
    void _d;
    void _e;
    void _f;
  });

  it('T18 / F-97 — runtime: extras injected via `as any` have ZERO observable effect on runIntegrityCheck', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5);
    store.__debugCorruptRowHash(rows[2]!.id, 'cafe'.repeat(16));

    // Inject the same forbidden fields at runtime via `as any` — the
    // library MUST NOT read them.
    const poisonedCfg = {
      trigger: 'scheduled',
      predicate: 'id != 3',
      pivot: '3',
      where: 'id != 3',
      row_range: [1, 1],
      max_rows: 0,
      runtime_pin: { node_version: 'wrong', openssl_version: 'wrong' }
    } as unknown as IntegrityCheckRunConfig;

    const result = await runIntegrityCheck({ store, config: poisonedCfg });

    // The injected `pivot:'3'` did NOT cause the walker to skip row 3 — the
    // mismatch still surfaces.
    expect(result.status).toBe('completed');
    const m = listMismatchRows(store).find(
      (mm) => (mm.meta as { row_id: string }).row_id === '3'
    );
    expect(m, 'injected pivot MUST NOT scope the walk; row 3 mismatch still detected').toBeDefined();
    // The injected `max_rows:0` did NOT short-circuit the walk.
    expect((result as { rows_walked?: number }).rows_walked).toBeGreaterThan(0);
    // The injected `runtime_pin` did NOT cause runtime_pin_mismatch (it was
    // ignored; the library reads ONLY store.readNodeRuntimePin()).
    expect((result as { error_code?: unknown }).error_code).toBeUndefined();
  });

  it('T18 / F-97 — trigger discriminator is exhaustive-switched with `never` cast on default branch', () => {
    // The library hard-codes the closed allowlist; a poisoned trigger string
    // routed through the exhaustive switch MUST reach the `never` default.
    function pin(trigger: IntegrityCheckTrigger): string {
      switch (trigger) {
        case 'scheduled':
          return 's';
        case 'post_rotation':
          return 'r';
        case 'post_export':
          return 'e';
        default: {
          const _exhaustive: never = trigger;
          throw new Error(`trigger outside closed allowlist: ${_exhaustive as string}`);
        }
      }
    }
    for (const t of ['scheduled', 'post_rotation', 'post_export'] as const) {
      expect(() => pin(t)).not.toThrow();
    }
    expect(() => pin('manual' as unknown as IntegrityCheckTrigger)).toThrow(
      /closed allowlist|trigger/i
    );
  });
});

// ===========================================================================
// F-98 — TestStore split + barrel re-export check
//        Mirrors G-T11-21 / G-T16-PRIV-1 / G-T17 F-85.
// ===========================================================================

describe('T18 / F-98 — IntegrityStore vs TestIntegrityStore interface split', () => {
  it('T18 / F-98 — IntegrityStore (production) has zero `__` properties at the type level', () => {
    const store: IntegrityStore = makeStore();
    const narrowed = store as IntegrityStore & Record<string, unknown>;
    // Each suppressed line below MUST be unused at compile time; tsc fails
    // if the implementer leaks any `__debug*` hook onto IntegrityStore.
    // @ts-expect-error — `__debugCorruptRowHash` is not on IntegrityStore.
    void narrowed.__debugCorruptRowHash;
    // @ts-expect-error — `__debugInsertChainRow` is not on IntegrityStore.
    void narrowed.__debugInsertChainRow;
    // @ts-expect-error — `__debugInsertBackupManifestFixture` is not on IntegrityStore.
    void narrowed.__debugInsertBackupManifestFixture;
    // @ts-expect-error — `__debugInsertSweepRunFixture` is not on IntegrityStore.
    void narrowed.__debugInsertSweepRunFixture;
    // @ts-expect-error — `__forceSummaryEmitFailure` is not on IntegrityStore.
    void narrowed.__forceSummaryEmitFailure;
    // @ts-expect-error — `__setLiveRuntimePin` is not on IntegrityStore.
    void narrowed.__setLiveRuntimePin;
    // @ts-expect-error — `__debugListRuns` is not on IntegrityStore.
    void narrowed.__debugListRuns;
    // @ts-expect-error — `__debugListAuditRows` is not on IntegrityStore.
    void narrowed.__debugListAuditRows;
  });

  it('T18 / F-98 — TestIntegrityStore extends IntegrityStore and adds the `__debug*` mutators', () => {
    const ts: TestIntegrityStore = makeStore();
    // Test-only mutators (per architect spec):
    expect(typeof ts.__debugCorruptRowHash).toBe('function');
    expect(typeof ts.__debugInsertChainRow).toBe('function');
    expect(typeof ts.__debugInsertBackupManifestFixture).toBe('function');
    expect(typeof ts.__debugInsertSweepRunFixture).toBe('function');
    expect(typeof ts.__forceSummaryEmitFailure).toBe('function');
    expect(typeof ts.__setLiveRuntimePin).toBe('function');
    expect(typeof ts.__debugListRuns).toBe('function');
    expect(typeof ts.__debugListAuditRows).toBe('function');
    // Production methods inherited from IntegrityStore:
    expect(typeof ts.readNodeRuntimePin).toBe('function');
    expect(typeof ts.readLatestCommittedBackupManifest).toBe('function');
  });

  it('T18 / F-98 — narrowing an IntegrityStore reference back to TestIntegrityStore fails type-check', () => {
    const production: IntegrityStore = makeStore();
    // @ts-expect-error — narrowing IntegrityStore to TestIntegrityStore is unsafe.
    const _t: TestIntegrityStore = production;
    expect(_t).toBeDefined();
  });

  it('T18 / F-98 — public barrel does NOT re-export MemoryIntegrityStore, TestIntegrityStore, runIntegrityEventTypesDriftCheck, or any `__` symbol', async () => {
    const indexModule = await import('../../src/lib/audit-integrity');
    const exportedKeys = Object.keys(indexModule);
    // Public surface (closed allowlist per ADR-0019 Decision §1):
    expect(exportedKeys).toContain('runIntegrityCheck');
    expect(exportedKeys).toContain('runWeeklyChainAnchor');
    expect(exportedKeys).toContain('INTEGRITY_CHECK_EVENT_TYPES');
    expect(exportedKeys).toContain('INTEGRITY_MAX_ROWS_PER_PASS');
    expect(exportedKeys).toContain('INTEGRITY_CHAIN_WALK_BATCH_SIZE');
    expect(exportedKeys).toContain('INTEGRITY_DEFAULT_LEASE_WINDOW_MS');
    expect(exportedKeys).toContain('INTEGRITY_BACKUP_DIFF_BUFFER_MS');

    // Forbidden re-exports (deep-import only per Option J):
    expect(exportedKeys).not.toContain('MemoryIntegrityStore');
    expect(exportedKeys).not.toContain('TestIntegrityStore');
    expect(exportedKeys).not.toContain('runIntegrityEventTypesDriftCheck');
    for (const k of exportedKeys) {
      expect(
        k.startsWith('__'),
        `public barrel re-exported a __ symbol (${k}); deep-import only per T11/T12 F-1 + T16/T17 ESLint pattern`
      ).toBe(false);
    }
  });
});

// ===========================================================================
// F-99 — Row-cap + `capped` state (`resume_after_id` semantic; F-60 mirror)
// ===========================================================================

describe('T18 / F-99 — row-cap + capped state', () => {
  it('T18 / F-99 — INTEGRITY_MAX_ROWS_PER_PASS is exactly 20000 (ADR-0019 §12)', () => {
    expect(
      INTEGRITY_MAX_ROWS_PER_PASS,
      'INTEGRITY_MAX_ROWS_PER_PASS MUST be 20000 per ADR-0019 §12 (F-60 mirror)'
    ).toBe(20000);
  });

  it('T18 / F-99 — INTEGRITY_CHAIN_WALK_BATCH_SIZE is exactly 1000 (ADR-0019 §12)', () => {
    expect(INTEGRITY_CHAIN_WALK_BATCH_SIZE).toBe(1000);
  });

  it('T18 / F-99 — INTEGRITY_DEFAULT_LEASE_WINDOW_MS is exactly 5 minutes (F-50 mirror)', () => {
    expect(INTEGRITY_DEFAULT_LEASE_WINDOW_MS).toBe(5 * INTEGRITY_MS_PER_MINUTE);
  });

  it('T18 / F-99 — 20001 seeded rows, zero mismatches → status:capped, rows_walked:20000, resume_after_id set to row 20000 id', async () => {
    const store = makeStore();
    // Seed 20001 rows. We don't use seedChain (too slow w/ HOUR_MS spacing);
    // use a tighter seeder via __debugInsertChainRow directly.
    for (let i = 1; i <= 20001; i++) {
      store.__debugInsertChainRow({
        id: String(i),
        ts_ms: FROZEN_NOW_MS - (20001 - i + 1) * 1000, // 1s apart to keep total span manageable
        hash: createHmac('sha256', 'seedChain-fixed-key').update(String(i)).digest('hex'),
        event_type: 'concern.created',
        prev_hash: i === 1 ? '0'.repeat(64) : createHmac('sha256', 'seedChain-fixed-key').update(String(i - 1)).digest('hex'),
        actor_pseudonym: '0'.repeat(32),
        target_id: null,
        target_class: 'C1',
        severity: 'info',
        request_id: null,
        rotation_id: null,
        meta: {}
      });
    }
    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('capped');
    const capped = result as IntegrityRunResult & {
      rows_walked: number;
      resume_after_id: string;
      truncated_to_row_cap: boolean;
    };
    expect(capped.rows_walked).toBe(20000);
    expect(capped.truncated_to_row_cap).toBe(true);
    expect(capped.resume_after_id).toBe('20000');
  });

  it('T18 / F-99 — capped pass still emits ran row with meta.status:capped + meta.resume_after_id present', async () => {
    const store = makeStore();
    for (let i = 1; i <= 20001; i++) {
      store.__debugInsertChainRow({
        id: String(i),
        ts_ms: FROZEN_NOW_MS - (20001 - i + 1) * 1000,
        hash: createHmac('sha256', 'seedChain-fixed-key').update(String(i)).digest('hex'),
        event_type: 'concern.created',
        prev_hash: i === 1 ? '0'.repeat(64) : createHmac('sha256', 'seedChain-fixed-key').update(String(i - 1)).digest('hex'),
        actor_pseudonym: '0'.repeat(32),
        target_id: null,
        target_class: 'C1',
        severity: 'info',
        request_id: null,
        rotation_id: null,
        meta: {}
      });
    }
    await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    const ranRows = listRanRows(store);
    expect(ranRows.length).toBe(1);
    expect((ranRows[0]!.meta as { status: string }).status).toBe('capped');
    expect((ranRows[0]!.meta as { resume_after_id: string | null }).resume_after_id).toBe('20000');
  });
});

// ===========================================================================
// F-100 — No PII in errors (closed-literal error_code union)
// ===========================================================================

describe('T18 / F-100 — no PII in error paths (closed-literal error_code)', () => {
  /** Scrub helper — assert haystack contains none of the disallowed shapes. */
  function assertNoPII(haystack: string, where: string): void {
    expect(haystack.includes(KNOWN_USER_ID_CANARY), `[${where}] leaked user_id`).toBe(false);
    expect(haystack.includes(KNOWN_CONCERN_ID_CANARY), `[${where}] leaked concern_id`).toBe(false);
    expect(haystack.includes(EMAIL_PROBE), `[${where}] leaked email canary`).toBe(false);
    expect(haystack.includes(PHONE_PROBE), `[${where}] leaked phone canary`).toBe(false);
    expect(haystack.includes(PSEUDONYM_SHAPE_PROBE), `[${where}] leaked pseudonym canary`).toBe(false);
    expect(EMAIL_SHAPE.test(haystack), `[${where}] email-shape leak`).toBe(false);
    expect(PHONE_SHAPE.test(haystack), `[${where}] phone-shape leak`).toBe(false);
    expect(PSEUDONYM_SHAPE.test(haystack), `[${where}] pseudonym-shape (32-hex) leak`).toBe(false);
    expect(HEX_OVER_64.test(haystack), `[${where}] hex >64 chars leak`).toBe(false);
    expect(
      /body_ct|source_name_ct|notes_ct|title_ct/.test(haystack),
      `[${where}] *_ct field-name leak`
    ).toBe(false);
    // UUIDs other than the run_id (which uses `ic_` prefix per G-T16-PRIV-3
    // rejection-sample) and backup_manifest_run_id (which uses `bp_` prefix)
    // MUST NOT appear.
    const allUuids = haystack.match(UUID_SHAPE) ?? [];
    for (const u of allUuids) {
      // No UUIDs should appear in error results at all (run_id uses ic_).
      expect(
        false,
        `[${where}] error result contained a UUID shape: ${u} (allowed: ic_-prefixed run_id, bp_-prefixed manifest run_id only)`
      ).toBe(true);
    }
  }

  /** Helper: plant PII canaries in seeded fixture rows so any leak surfaces. */
  function plantPIICanaries(store: TestIntegrityStore): void {
    store.__debugInsertChainRow({
      id: KNOWN_USER_ID_CANARY,
      ts_ms: FROZEN_NOW_MS - 2 * HOUR_MS,
      hash: '0'.repeat(64),
      event_type: 'concern.created',
      prev_hash: '0'.repeat(64),
      actor_pseudonym: PSEUDONYM_SHAPE_PROBE,
      target_id: KNOWN_CONCERN_ID_CANARY,
      target_class: 'C1',
      severity: 'info',
      request_id: null,
      rotation_id: null,
      meta: { email: EMAIL_PROBE, phone: PHONE_PROBE }
    });
  }

  it('T18 / F-100 — runtime_pin_mismatch error: no PII in result', async () => {
    const store = makeStore();
    plantPIICanaries(store);
    const rows = seedChain(store, 3);
    const headRow = rows[2]!;
    store.__debugInsertBackupManifestFixture({
      run_id: 'bp_F100_pin',
      committed_at_ms: FROZEN_NOW_MS,
      audit_log_head: { id: headRow.id, ts_ms: headRow.ts_ms, hash: headRow.hash },
      per_event_row_counts: { 'concern.created': 3 },
      retention_sweep_runs_snapshot_ts_ms: FROZEN_NOW_MS,
      schedule_hash: 'sched_v1',
      node_runtime_pin: { node_version: '21.5.0', openssl_version: '3.0.10' }
    });
    store.__setLiveRuntimePin({ node_version: '22.10.1', openssl_version: '3.1.4' });
    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('errored');
    expect((result as { error_code?: string }).error_code).toBe('runtime_pin_mismatch');
    assertNoPII(JSON.stringify(result), 'runtime_pin_mismatch result');
  });

  it('T18 / F-100 — summary_emit_failed error: no PII in result', async () => {
    const store = makeStore();
    plantPIICanaries(store);
    seedChain(store, 3);
    store.__forceSummaryEmitFailure(true);
    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('errored');
    assertNoPII(JSON.stringify(result), 'summary_emit_failed result');
  });

  it('T18 / F-100 — error_code is from a closed literal union (assigning a random string fails type-check)', async () => {
    const store = makeStore();
    store.__forceSummaryEmitFailure(true);
    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('errored');
    if (result.status === 'errored') {
      // @ts-expect-error — error_code is a closed literal union, not `string`.
      const _bad: 'completely_random_string' = result.error_code;
      void _bad;
    }
  });

  it('T18 / F-100 — run_id uses the `ic_` prefix (G-T16-PRIV-3 rejection sample; breaks 32-hex pseudonym shape)', async () => {
    const store = makeStore();
    seedChain(store, 3);
    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    const runId = (result as { run_id?: string }).run_id;
    expect(runId, 'result.run_id MUST be present and start with `ic_`').toBeDefined();
    expect(runId!.startsWith('ic_')).toBe(true);
    // The prefix breaks the 32-hex pseudonym word boundary.
    expect(PSEUDONYM_SHAPE.test(runId!)).toBe(false);
  });

  it('T18 / F-100 — runWeeklyChainAnchor head_read_failed: no PII; closed-literal error_code', async () => {
    const store = makeStore();
    plantPIICanaries(store);
    // Force the head-read to throw via a dedicated mutator (the architect
    // spec lists this as a supported test hook). Post-G-T18-15 split:
    // this flag targets `readChainHead` only; the segment-read flag is
    // `__forceChainSegmentException`.
    store.__forceHeadReadException(true);
    const result = await runWeeklyChainAnchor({ store });
    expect(result.status).toBe('errored');
    expect((result as { error_code?: string }).error_code).toBe('head_read_failed');
    assertNoPII(JSON.stringify(result), 'head_read_failed result');
    // No anchor row emitted on errored path.
    expect(listAnchorRows(store).length).toBe(0);
  });
});

// ===========================================================================
// Cross-cutting (a) — No caller-supplied predicate / pivot / WHERE compiles
//                    (F-97 + ./fixtures/poisoned-config.ts).
// ===========================================================================

describe('T18 / cross-cutting (a) — no caller-supplied predicate / pivot / WHERE compiles', () => {
  it('T18 / cross-cutting (a) — IntegrityStore exposes only the closed allowlist of methods (no escape hatch via predicate/raw_sql/exec_sql)', () => {
    const store: IntegrityStore = makeStore();
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
          `IntegrityStore method "${m}" matches forbidden substring "${f}"; no caller-supplied predicate path`
        ).toBe(false);
      }
    }
  });

  it('T18 / cross-cutting (a) — composite @ts-expect-error smoke: all forbidden fields fail compile when added together', () => {
    // The dedicated poisoned-config fixture file at
    // `./fixtures/poisoned-config.ts` provides the full tsc --noEmit fail
    // surface. This composite inline smoke proves the property at the spot
    // where the test reader can see it.
    // @ts-expect-error — F-97: predicate forbidden.
    const _a: IntegrityCheckRunConfig = { trigger: 'scheduled', predicate: 'p' };
    // @ts-expect-error — F-97: pivot forbidden.
    const _b: IntegrityCheckRunConfig = { trigger: 'scheduled', pivot: 'x' };
    // @ts-expect-error — F-97: backup_manifest_id forbidden.
    const _c: IntegrityCheckRunConfig = { trigger: 'scheduled', backup_manifest_id: 'bp_x' };
    void _a;
    void _b;
    void _c;
  });
});

// ===========================================================================
// Cross-cutting (b) — Closed-allowlist drift fails CI (mirrors F-86).
// ===========================================================================

describe('T18 / cross-cutting (b) — closed-allowlist drift fails CI', () => {
  it('T18 / cross-cutting (b) — removing each of the three event types in turn fails drift-check', () => {
    for (const removed of [
      'audit.integrity_check.ran',
      'audit.integrity_check.mismatch',
      'audit.chain_anchor.weekly'
    ] as const) {
      const cloned = [...INTEGRITY_CHECK_EVENT_TYPES].filter((e) => e !== removed);
      const verdict = runIntegrityEventTypesDriftCheck({ __overrideForTest: cloned });
      expect(verdict.ok, `removing ${removed} MUST fail the drift check`).toBe(false);
      expect((verdict as { missing?: string[] }).missing).toContain(removed);
    }
  });

  it('T18 / cross-cutting (b) — adding a phantom event type fails drift-check (named orphan)', () => {
    const cloned = [
      ...INTEGRITY_CHECK_EVENT_TYPES,
      'audit.integrity_check.fictional'
    ] as ReadonlyArray<string>;
    const verdict = runIntegrityEventTypesDriftCheck({ __overrideForTest: cloned });
    expect(verdict.ok).toBe(false);
    expect((verdict as { orphan?: string[] }).orphan).toContain('audit.integrity_check.fictional');
  });
});

// ===========================================================================
// Cross-cutting (c) — Mismatch-row precedes alert-fanout (F-87).
//                    Pin emission order across multiple mismatches.
// ===========================================================================

describe('T18 / cross-cutting (c) — mismatch rows precede alert fan-out (F-87)', () => {
  it('T18 / cross-cutting (c) — across N=4 mismatches: every mismatch row exists in the audit log BEFORE the result alert symbol is read', async () => {
    const store = makeStore();
    const rows = seedChain(store, 8);
    for (const idx of [1, 3, 5, 7]) {
      store.__debugCorruptRowHash(rows[idx]!.id, idx.toString(16).repeat(32).slice(0, 64));
    }

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });

    // Step 1: read the emitted-rows list. The library wrote these atomically
    // BEFORE returning the result with the alert symbol.
    const mismatches = listMismatchRows(store);
    expect(mismatches.length).toBeGreaterThanOrEqual(4);

    // Step 2: NOW read the alert symbol on the result. The mismatch rows
    // already exist — F-87 audit-before-fanout pin.
    expect(resultIncludesAlert(result, 'A-AUDIT-001')).toBe(true);
  });

  it('T18 / cross-cutting (c) — the LAST integrity-event audit row in the pass is `audit.integrity_check.ran` (mismatches come BEFORE ran in the same tx)', async () => {
    const store = makeStore();
    const rows = seedChain(store, 6);
    for (const idx of [0, 2, 4]) {
      store.__debugCorruptRowHash(rows[idx]!.id, idx.toString(16).repeat(32).slice(0, 64));
    }
    await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });

    const integrityRows = store
      .__debugListAuditRows()
      .filter(
        (r) =>
          r.event_type === 'audit.integrity_check.mismatch' ||
          r.event_type === 'audit.integrity_check.ran'
      );
    expect(integrityRows[integrityRows.length - 1]!.event_type).toBe(
      'audit.integrity_check.ran'
    );
  });
});

// ===========================================================================
// Cross-cutting (d) — Summary-LAST in tx (F-88).
// ===========================================================================

describe('T18 / cross-cutting (d) — summary-LAST in tx (F-88)', () => {
  it('T18 / cross-cutting (d) — clean pass: ran row is the LAST audit row of the integrity-check event family in the pass', async () => {
    const store = makeStore();
    seedChain(store, 5);
    await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    const integrityRows = store
      .__debugListAuditRows()
      .filter(
        (r) =>
          r.event_type === 'audit.integrity_check.ran' ||
          r.event_type === 'audit.integrity_check.mismatch'
      );
    expect(integrityRows.length).toBe(1);
    expect(integrityRows[0]!.event_type).toBe('audit.integrity_check.ran');
  });

  it('T18 / cross-cutting (d) — full rollback on summary-emit failure: NO mismatch rows, NO ran row, run row NOT in `completed`', async () => {
    const store = makeStore();
    const rows = seedChain(store, 5);
    store.__debugCorruptRowHash(rows[1]!.id, '1111'.repeat(16));
    store.__debugCorruptRowHash(rows[3]!.id, '2222'.repeat(16));
    store.__forceSummaryEmitFailure(true);

    const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
    expect(result.status).toBe('errored');

    expect(listMismatchRows(store).length).toBe(0);
    expect(listRanRows(store).length).toBe(0);
    const runs = store.__debugListRuns();
    for (const r of runs) {
      expect(r.status === 'completed').toBe(false);
    }
  });
});

// ===========================================================================
// Cross-cutting (e) — F-92 attribution rule in BOTH directions
//                    (load-bearing structural separator).
// ===========================================================================

describe('T18 / cross-cutting (e) — F-92 attribution rule pinnable in BOTH directions', () => {
  it('T18 / cross-cutting (e) — paired attributed + unattributable scenarios in the SAME describe block (structural separator)', async () => {
    // Direction 1: attributed → no alert. (over-attribution failure mode
    // would cause silent tamper; pinned away)
    {
      const store = makeStore();
      const rows = seedChain(store, 10);
      const targetRow = rows[5]!;
      const headRow = rows[9]!;
      advanceBy(1 * HOUR_MS + 1);
      store.__debugInsertBackupManifestFixture({
        run_id: 'bp_cc_e_attr',
        committed_at_ms: FROZEN_NOW_MS,
        audit_log_head: { id: headRow.id, ts_ms: headRow.ts_ms, hash: headRow.hash },
        per_event_row_counts: { 'concern.created': 10 },
        retention_sweep_runs_snapshot_ts_ms: FROZEN_NOW_MS + 1 * HOUR_MS + 1,
        schedule_hash: 'sched_v1',
        node_runtime_pin: store.readNodeRuntimePin()
      });
      store.__debugInsertSweepRunFixture({
        run_id: 'sw_cc_e_attr',
        started_at_ms: targetRow.ts_ms - 1,
        completed_at_ms: targetRow.ts_ms + 1,
        per_event_counts: { 'concern.created': 1 },
        status: 'completed'
      });
      store.__debugDeleteRowAtId(targetRow.id);
      const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
      expect(
        (result as { would_fire_alert?: unknown }).would_fire_alert,
        'attributed direction MUST NOT fire ANY alert (silent-tamper failure mode pin)'
      ).toBeUndefined();
      expect((result as { attributable_count?: number }).attributable_count).toBe(1);
    }

    // Direction 2: unattributable → both alerts. (under-attribution failure
    // mode would flood operator → alert fatigue → real fires missed)
    {
      const store = makeStore();
      const rows = seedChain(store, 10);
      const targetRow = rows[5]!;
      const headRow = rows[9]!;
      advanceBy(1 * HOUR_MS + 1);
      store.__debugInsertBackupManifestFixture({
        run_id: 'bp_cc_e_unattr',
        committed_at_ms: FROZEN_NOW_MS,
        audit_log_head: { id: headRow.id, ts_ms: headRow.ts_ms, hash: headRow.hash },
        per_event_row_counts: { 'concern.created': 10 },
        retention_sweep_runs_snapshot_ts_ms: FROZEN_NOW_MS + 1 * HOUR_MS + 1,
        schedule_hash: 'sched_v1',
        node_runtime_pin: store.readNodeRuntimePin()
      });
      // NO sweep fixture inserted → unattributable.
      store.__debugDeleteRowAtId(targetRow.id);
      const result = await runIntegrityCheck({ store, config: { trigger: 'scheduled' } });
      expect(
        resultIncludesAlert(result, 'A-AUDIT-001'),
        'unattributable direction MUST fire A-AUDIT-001'
      ).toBe(true);
      expect(
        resultIncludesAlert(result, 'A-INTEGRITY-002'),
        'unattributable direction MUST fire A-INTEGRITY-002 as a DISTINCT symbol'
      ).toBe(true);
      expect((result as { unattributable_count?: number }).unattributable_count).toBe(1);
    }
  });
});

// ===========================================================================
// AC TRACEABILITY (for the four-way reviewer pass)
//
//   F-86 -> T18 / F-86 (a)-(c) + cross-cutting (b)
//   F-87 -> T18 / F-87 (mismatch precedes alert + emission order + completed status)
//             + cross-cutting (c)
//   F-88 -> T18 / F-88 (a)-(b) + cross-cutting (d)
//   F-89 -> T18 / F-89 (corrupt row 3 + clean fixture)
//   F-90 -> T18 / F-90 (a) unattributed + (b) attributed
//   F-91 -> apps/web/test/T18/backup-diff-mismatch.test.ts (LOAD-BEARING)
//   F-92 -> T18 / F-92 (a)-(e) five directions + cross-cutting (e)
//   F-93 -> T18 / F-93 (mismatch + clean + null manifest)
//   F-94 -> T18 / F-94 (top-level pseudonym + structural keys + deep grep +
//             ran row layout + anchor row layout)
//   F-95 -> T18 / F-95 (a) chain-walk only + (b) both + (c) neither
//   F-96 -> T18 / F-96 (head triple + empty chain + meta.head field-pin)
//   F-97 -> T18 / F-97 (arity + closed trigger union + ts-expect-error +
//             runtime extras ignored + exhaustive switch)
//             + ./fixtures/poisoned-config.ts (tsc --noEmit fail half)
//             + cross-cutting (a)
//   F-98 -> T18 / F-98 (production interface @ts-expect-error +
//             TestIntegrityStore mutators + narrowing fails + barrel grep)
//   F-99 -> T18 / F-99 (constants pin + 20001 → capped + ran row meta)
//   F-100 -> T18 / F-100 (runtime_pin_mismatch + summary_emit_failed +
//              closed-literal union + ic_ run_id + head_read_failed)
//
// Five cross-cutting properties pinned:
//   (a) No caller-supplied predicate / pivot / WHERE → cross-cutting (a) + F-97
//   (b) Closed-allowlist drift fails CI → cross-cutting (b) + F-86
//   (c) Mismatch-row precedes alert-fanout → cross-cutting (c) + F-87
//   (d) Summary-LAST in tx → cross-cutting (d) + F-88
//   (e) F-92 attribution rule in BOTH directions → cross-cutting (e) + F-92
//
// LOAD-BEARING RA-2 pre-snapshot test (F-91) lives in its own dedicated file:
//   apps/web/test/T18/backup-diff-mismatch.test.ts
// Breaking F-91 re-opens RA-2 trigger #3 by construction
// (per threat-model §3.11 F-91 + Architect ask #1 verdict).
// ===========================================================================
