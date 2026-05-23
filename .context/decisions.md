# Decisions

Architectural choices made for this project and why.

Append newest on top. Don't delete old entries — superseded decisions get a note
pointing to the new one. The history is the value.

---

## Format

```
## YYYY-MM-DD — Short decision title

**Context:** what we were choosing between and why it mattered.
**Decision:** what we picked.
**Rationale:** why this one over the alternatives.
**Reversibility:** how hard it would be to change later (low / medium / high).
**Superseded by:** (only if applicable, link to newer entry)
```

---

## Entries

---

## ADR-0017 — T16 retention sweep library + MemoryRetentionStore

**Status:** Accepted
**Date:** 2026-05-23
**Decider(s):** architect (T16 design pass on the carry-forward set G-T05-6 / G-T05-7 / G-T07-1+ / G-T08-1 / G-T10-4 / G-T11-1 / G-T13-1 / G-T14-1 and the ADR-0015 + ADR-0016 + ADR-0002 Amendment H constraint set). **No new HG fires in this pass** — T16 ships library-only per Amendment H; HG-15 fires on T16.1 when the two new physical tables (`retention_sweep_runs`, `audit_log_retention_schedule`) land. HG-14 was RATIFIED 2026-05-22 for the ADR-0015 schedule and does NOT re-fire in this pass.

**Source:** ADR-0015 (per-event audit-log retention schedule, authoritative), ADR-0016 (operational-table retention schedule + HMAC pseudonym standard, authoritative), ADR-0002 Amendment H (sibling-task pattern; library-only T_n + production-wire-up T_n.1), threat-model F-19 (closed-allowlist), F-24 (audit-before-side-effect), F-50 (chain-integrity), F-51 (retention bug), F-52 (retention-pass auditing), RA-1 compensating control #5 (post-export notification surface — sweep must not break), RA-2 trigger #3 (live-chain vs pg_dump divergence — sweep must respect backup window or document the race), G-T05-6 (`retention_class_for()` vs schedule-table drift), G-T05-7 (`auth_totp_consumed_log` 24h sweep), G-T07-3 / G-T07-10 (interface split + integration tests live in T_n.1), G-T08-14 / G-T13-9 (`transaction_ts_ms` shim), G-T11-21 / G-T13-15 / G-T14-17 (TestStore split). Cross-references **ADR-0012 amendment** (42-day backup hard-delete vs 7y longest audit retention coherence).

## Context

ADR-0015 and ADR-0016 ratify two schedules but stop short of specifying the sweep mechanism that enforces them. T16 is the sweep. Per Amendment H, T16 ships library code + `MemoryRetentionStore` only; T16.1 ships the `SupabaseRetentionStore` + the SQL migration that creates `audit_log_retention_schedule` (authoritative schedule table) and `retention_sweep_runs` (idempotency checkpoint) + the pg_cron schedule + the Edge Function trigger + the ADR-0016 schedule rows for the two new tables + the §PI inventory amendments + HG-15 re-ratification.

This ADR ratifies the library contract the sweep ships against and the open-question dispositions (a)–(g) the librarian briefing surfaced.

The carry-forward set this ADR closes (library-side) and defers (T16.1-side):

- **Closes in T16:** G-T05-6 (drift assertion is encoded as a `RETENTION_SCHEDULE` const + a CI test against the SQL function; the SQL-side mirror moves to T16.1's migration), G-T05-7 (sweep iterates `auth_totp_consumed_log` per the ADR-0016 schedule; library exercise lands against `MemoryRetentionStore`).
- **Defers to T16.1:** every operational-table SQL function + the `retention_sweep_runs` table + the `audit_log_retention_schedule` table + pg_cron + Edge Function + the ADR-0016 schedule rows for the two new T16-introduced tables + §PI inventory amendments + HG-15 re-ratification.

## Decision drivers

- **PIPEDA Principle 4.5 (Limiting Retention):** the only structural enforcer of the per-event-type floor + the underlying-record ceiling + the operational-table schedule is the sweep. Without it, every retention promise in ADR-0015 / ADR-0016 is aspirational.
- **F-51 (retention bug blast radius):** a deletion bug aged-out by clock drift or filter mistake can take out active reprisal entries (C4). The library must make dry-run the test default and emit an alert above a configurable per-pass threshold.
- **F-52 (retention itself audited):** every pass emits exactly one `retention.deleted` summary row with per-event-type and per-table counts in jsonb, hash-chained, before the deletes commit (F-24 ordering inverted: see Decision §5).
- **G-T05-6 (drift between code paths):** SQL `retention_class_for()`, TS `RETENTION_SCHEDULE` const, and the future `audit_log_retention_schedule` table are three mirrors of the same truth. The library's CI drift assertion is the structural backstop; SQL drift fails CI in T16.1, but the TS side fails CI now.
- **RA-1 control #5 (post-export notification):** the sweep must not delete the `export.generated` audit row before the post-export notification surface has a chance to read it. The 7y retention on `export.generated` (ADR-0015 §schedule) already covers this; the sweep must NOT shorten any retention.
- **RA-2 trigger #3 (live-chain vs backup divergence):** the sweep is the legitimate DELETE path on `audit_log`; a divergence between the live chain and the most recent pg_dump for a row older than the dump must be attributable to a sweep pass, not silently treated as a tamper. The sweep records `prev_pass_hash`, run id, ms-epoch start/end, and the rows-deleted-per-event-type so the T18 + RA-2 backstop check can reconcile.
- **Amendment H pattern:** the library ships against `MemoryRetentionStore`; tests are fast, deterministic, and do not depend on a Supabase local stack. SQL invariants land in T16.1's pgTAP suite.

## Options considered

### Option A: Sweep semantics — hard-delete uniformly (chosen)

ADR-0015 §"Retention job behaviour" reads `:queued for deletion on the next pass`. ADR-0016 §"Operational rules" reads `hard-deleted on consume` and `Scheduled sweep deletes rows where consumed_at < now() - interval '24 hours'`. The literal reading is hard-delete on every operational surface; pseudonym-only redaction is NOT specified anywhere and would re-introduce a "shape preserved but PI removed" surface that the privacy-reviewer has not approved. **We choose hard-delete uniformly** per ADR-0015 + ADR-0016 literal reading. Pseudonym-only is a v2 amendment if a regulator surfaces a "preserve the row, scrub the PI" request; documented as deferred in Follow-ups.

### Option B: Pseudonym-only redaction for `audit_log` rows whose `target_id` is gone (rejected)

Considered because it preserves the chain-integrity surface (T18 / F-50) without requiring chain-rebuild on delete. Rejected because (1) ADR-0015 §schema requirement #3's drift check already handles enum-vs-schedule alignment; (2) deletes leave the prev_hash/hash linkage in place (Postgres DELETE does not modify other rows); (3) the redaction surface adds a second "deletion-shaped operation" path that the threat-model would have to score independently. Hard-delete + the chain-detect-the-gap posture is simpler and the threat-model already covers it (F-50 + F-52).

### Option C: Idempotency — checkpoint table (chosen) vs advisory lock vs jsonb time window

Three mechanisms for "two simultaneous pg_cron firings, or a re-run after crash mid-pass, don't double-delete or double-emit":

- **(a) Checkpoint table `retention_sweep_runs`** with `(run_id, started_at_ms, ended_at_ms, status, prev_pass_hash, per_event_counts jsonb, per_table_counts jsonb)`. A pass that finds an open `status='running'` row younger than the configured lease window refuses to start. **Chosen.** It doubles as the F-52 forensic surface and the RA-2 trigger #3 reconciliation anchor.
- **(b) `pg_try_advisory_xact_lock` only.** Lighter, but no forensic surface; reconciling against the pg_dump backup for RA-2 trigger #3 has no anchor point.
- **(c) jsonb time window in `retention.deleted` meta only.** No idempotency outside the emitted row; a crashed pass leaves no breadcrumb. Rejected.

The checkpoint table lands in T16.1; the library's `MemoryRetentionStore` mirrors the semantic with an in-memory `runs` array. **HG-15 fires for `retention_sweep_runs` at T16.1 PR submission.**

### Option D: Recovery semantics — single transaction (chosen)

Per F-24 (audit-before-side-effect, generalized): the `retention.deleted` summary row commits BEFORE — or atomically WITH — the deletes it summarizes. We choose **single transaction**: emit the summary row, perform all per-event-type and per-table deletes, commit. On any failure mid-batch (lock timeout, statement timeout, deadlock), the entire pass rolls back and the next pass retries. **The summary row is the LAST row written in the transaction** (after the deletes) so its `meta.deleted_per_table` / `meta.deleted_per_event_type` counts are authoritative for what landed. F-24 generalizes here as "audit-WITH-side-effect" rather than "audit-BEFORE-side-effect"; the threat-modeler will score this as F-24 variant. Per-batch savepoints rejected: they admit a partial-state failure mode where some deletes commit and the summary row records fewer counts than actually landed.

The lock-hold-time risk on high-churn tables (`auth_sessions`) is mitigated by **per-event-type / per-table batch limits** (Decision §3 below) and a **per-pass row-cap** (Decision §6 below). A pass that hits the cap commits what it has + emits its summary; the next pass picks up the remainder.

### Option E: Interaction with RA-2 trigger #3 + T17 backup window — tolerate transient inconsistency (chosen)

ADR-0015 §Risks reads: "the retention job's next pass cleans them up; transient inconsistency is acceptable." We honour this. The sweep does NOT defer rows younger than the most recent successful backup; instead, the T18 integrity job + the RA-2 backstop check use the `retention_sweep_runs.per_event_counts` jsonb as the reconciliation anchor — if a row is missing from the live chain but its deletion is accounted for in a `retention_sweep_runs` row, that is the audited explanation. RA-2 trigger #3 fires only on **unattributed** divergence. This ADR commits to the reconciliation anchor; T18's integrity job inherits the check on its next pass (additive to T18 follow-ups; no new task).

### Option F: Pre-deletion user notification — none in v1 (chosen)

No ADR mandates pre-deletion copy. HG-10 (if it existed) is NOT fired in this pass; **HG-10 explicitly does NOT fire** by this ADR's design. A user's right of access (PIPEDA Principle 4.9) is preserved by retention floors that match the underlying record's retention — the user can query their own data while their membership is active and for the post-membership tail per ADR-0015 / ADR-0016. Deletion at the floor is the structural promise; pre-deletion notification would re-introduce a "deletion is pending; please confirm" surface that this design deliberately omits. Recorded as deferred for any future ADR amendment that surfaces a regulator-driven need.

### Option G: `retention_class` backfill — none required (confirmed)

T05 migration landed the column `audit_log.retention_class text NOT NULL` (per `supabase/migrations/00000000000001_auth.sql:84` and amendment pass #4 cross-cutting #2). Every row emitted via `audit_emit(...)` stamps the column at write time. **No backfill required.** The library's sweep reads the column directly.

### Option H: Schedule authority — `audit_log_retention_schedule` table is authoritative; `retention_class_for()` SQL function and `RETENTION_SCHEDULE` TS const are mirrors (chosen)

Per ADR-0015 §schema requirement #2 the table is authoritative. The SQL function (T05) and the TS const (this ADR) are both mirrors. CI drift assertion (G-T05-6 closure):

1. **Library CI test (lands in T16):** parses `RETENTION_SCHEDULE` const + asserts every value in the closed `EventType` enum (see Decision §2) has exactly one entry; every entry's `event_type` is in the enum.
2. **Cross-mirror CI test (lands in T16.1):** asserts `RETENTION_SCHEDULE` (TS const), `retention_class_for(p_event_type)` output (SQL function), and `SELECT event_type, retention_class FROM audit_log_retention_schedule` (SQL table) are pairwise-equal on the closed enum domain. Drift fails CI.

The library ships test (1); test (2) lands in T16.1's migration PR. The library's contract is that `RETENTION_SCHEDULE` is the authoritative TS source; T16.1's drift test pins the TS-vs-SQL parity.

## Decision

**We choose Options A + C(a) + D + E + F + G + H.**

### 1. File-level structure (binding for T16 ship)

Library lives under `apps/web/src/lib/retention/`:

```
apps/web/src/lib/retention/
  types.ts                  — RetentionEventType, RetentionClass, schedule shapes
  schedule.ts               — RETENTION_SCHEDULE frozen const + drift-check helpers
  retention-store.ts        — RetentionStore (production) + TestRetentionStore (test-only)
  memory-retention-store.ts — MemoryRetentionStore implements TestRetentionStore
  retention-core.ts         — runRetentionPass + per-event-type sweep iteration
  audit-emission.ts         — buildRetentionDeletedSummary + jsonb meta shape
  index.ts                  — public surface re-exports (RetentionStore, runRetentionPass, RETENTION_SCHEDULE)
```

No SQL ships in T16. No new physical tables ship in T16. PR-review-time assertion mirrors Amendment H's §Testable assertions: `git diff --name-only main...T16-branch -- supabase/migrations/` returns empty.

### 2. Closed `RetentionEventType` enum (binding; mirrors ADR-0015 + ADR-0016 verbatim)

The library defines a closed string-literal union `RetentionEventType` covering exactly the event types in the librarian briefing (29 event types as of this ADR). The union is exhaustive-switched in `retention-core.ts` with a `never` cast on the default branch (F-19 closed-allowlist pattern from T11/T12). ESLint rule `no-spread-into-retention-schedule` (added by implementer; mirrors T11/T12's spread ban) forbids spread-into-`RETENTION_SCHEDULE`.

**Enum (verbatim, alphabetized for review stability):**

```
'alert.fired'
'audit.forensic_reveal.4eyes_completed'
'audit.forensic_reveal.4eyes_pending'
'auth.passkey.enrolled'
'auth.passkey.revoked'
'client.cache_policy_violation'
'client.identity_selftest_fail'
'committee_data_key.member_revoked'
'committee_data_key.rotation.completed'
'committee_data_key.rotation.started'
'committee_data_key.unwrap'
'committee_data_key.wrapped_for_member'
'committee.key_rotated'
'concern.created'
'concern.source_revealed'
'concern.updated'
'export.contained_concern_derived_items'
'export.delivered'
'export.generated'
'identity_keypair.created'
'identity_privkey.recovery_blob.restored'
'identity_privkey.recovery_blob.viewed'
'identity_privkey.recovery_blob.written'
'inspection.synced'
'member.added'
'member.removed'
'photo.sanitize.unsupported_format'
'queue.integrity_fail'
'recommendation.created'
'recommendation.employer_response_logged'
'recommendation.overdue.alert'
'reprisal.created'
'reprisal.read'
'reprisal.status_changed.4eyes_completed'
'reprisal.status_changed.4eyes_pending'
'reprisal.update'
'retention.deleted'
's51_evidence.create.rejected'
's51_evidence.created'
's51_evidence.read'
's51_evidence.update'
'sensitive.access_attempt'
'session.revoked'
'work_refusal.created'
'work_refusal.read'
'work_refusal.update'
```

The enum is the closed allowlist for the sweep. Any new event type added to the system in a future task MUST add (a) a `RetentionEventType` entry, (b) a `RETENTION_SCHEDULE` entry, (c) a `retention_class_for()` branch (T16.1 SQL), and (d) a row in `audit_log_retention_schedule` (T16.1). All four mirror; CI drift fails on any single-mirror update.

### 3. `RETENTION_SCHEDULE` frozen const (binding; mirrors ADR-0015 §schedule verbatim)

`schedule.ts` exports:

```
export const RETENTION_SCHEDULE = Object.freeze({
  // ADR-0015 audit-log retention schedule, verbatim.
  'auth.passkey.enrolled':          { kind: 'fixed_days', days: 90 },
  'auth.passkey.revoked':           { kind: 'fixed_days', days: 90 },
  'session.revoked':                { kind: 'fixed_days', days: 90 },
  'client.cache_policy_violation':  { kind: 'fixed_days', days: 90 },
  'client.identity_selftest_fail':  { kind: 'fixed_days', days: 90 },
  'committee_data_key.unwrap':      { kind: 'fixed_months', months: 24 },
  'alert.fired':                    { kind: 'fixed_months', months: 24 },
  'identity_keypair.created':       { kind: 'fixed_years', years: 7 },
  'committee_data_key.rotation.started':   { kind: 'fixed_years', years: 7 },
  'committee_data_key.rotation.completed': { kind: 'fixed_years', years: 7 },
  'committee_data_key.member_revoked':     { kind: 'fixed_years', years: 7 },
  'committee.key_rotated':                 { kind: 'fixed_years', years: 7 },
  'export.generated':                       { kind: 'fixed_years', years: 7 },
  'export.contained_concern_derived_items': { kind: 'fixed_years', years: 7 },
  'export.delivered':                       { kind: 'fixed_years', years: 7 },
  'retention.deleted':                      { kind: 'fixed_years', years: 7, no_target_id: true },
  'audit.forensic_reveal.4eyes_pending':   { kind: 'fixed_years', years: 7 },
  'audit.forensic_reveal.4eyes_completed': { kind: 'fixed_years', years: 7 },
  'identity_privkey.recovery_blob.written':  { kind: 'membership_plus_months', months: 24 },
  'identity_privkey.recovery_blob.restored': { kind: 'membership_plus_months', months: 24 },
  'identity_privkey.recovery_blob.viewed':   { kind: 'membership_plus_months', months: 24 },
  'committee_data_key.wrapped_for_member':   { kind: 'years_from_rotation', years: 7 },
  'member.added':   { kind: 'membership_plus_years', years: 7 },
  'member.removed': { kind: 'membership_plus_years', years: 7 },
  // match_underlying — defers to the linked target row's retention + 30d ceiling.
  'concern.created':         { kind: 'match_underlying' },
  'concern.updated':         { kind: 'match_underlying' },
  'concern.source_revealed': { kind: 'match_underlying' },
  'inspection.synced':       { kind: 'match_underlying' },
  'queue.integrity_fail':    { kind: 'match_underlying' },
  'photo.sanitize.unsupported_format': { kind: 'match_underlying' },
  'recommendation.created':                       { kind: 'match_underlying' },
  'recommendation.employer_response_logged':      { kind: 'match_underlying' },
  'recommendation.overdue.alert':                 { kind: 'match_underlying' },
  'reprisal.created':                              { kind: 'match_underlying' },
  'reprisal.read':                                 { kind: 'match_underlying' },
  'reprisal.update':                               { kind: 'match_underlying' },
  'reprisal.status_changed.4eyes_pending':         { kind: 'match_underlying' },
  'reprisal.status_changed.4eyes_completed':       { kind: 'match_underlying' },
  'sensitive.access_attempt':                      { kind: 'match_underlying' },
  'work_refusal.created':       { kind: 'match_underlying' },
  'work_refusal.read':          { kind: 'match_underlying' },
  'work_refusal.update':        { kind: 'match_underlying' },
  's51_evidence.created':         { kind: 'match_underlying' },
  's51_evidence.read':            { kind: 'match_underlying' },
  's51_evidence.update':          { kind: 'match_underlying' },
  's51_evidence.create.rejected': { kind: 'match_underlying' }
} as const);
```

`kind` discriminator drives the sweep's filter construction. The schedule for operational tables (ADR-0016 §schedule) is a sibling const `OPERATIONAL_TABLE_SCHEDULE` in the same file, keyed by table name with the same discriminator shape.

### 4. `RetentionStore` interface vs `TestRetentionStore` test-only extension

Per the G-T11-21 / G-T13-15 / G-T14-17 pattern (TestStore split):

- `RetentionStore` — production interface. Methods: `listSweepableEventTypes()`, `countCandidatesForEventType(event_type, cutoff_ms)`, `deleteForEventType(event_type, cutoff_ms, max_rows)` returning `{deleted_count, oldest_remaining_ts_ms | null}`, `countCandidatesForTable(table_name, predicate)`, `deleteForTable(table_name, predicate, max_rows)`, `recordSweepRun(run)`, `findOpenRun(lease_window_ms)`, `closeSweepRun(run_id, end_state)`, `emitRetentionDeleted(summary)`, `nowMs()`.
- `TestRetentionStore extends RetentionStore` — adds `__debugListRuns()`, `__debugForceFail(table_name)`, `__debugSetClock(ms)`, `__debugInsertFixture(table_name, row)`. These hooks live ONLY on `TestRetentionStore`; production code paths receive `RetentionStore` and CANNOT reach the `__debug*` methods at type level.

The interface forbids caller-supplied WHERE clauses; the function body hard-codes the schedule lookup (defense-in-depth per the librarian's threat-model delta).

### 5. `MemoryRetentionStore` shape + composition with existing memory stores

`MemoryRetentionStore implements TestRetentionStore` is the canonical test-time double. It composes with existing memory stores via a **sweepable-surface registry** rather than inheritance — at construction it accepts an array of `SweepableSurface` adapters that wrap `MemoryAuthStore` / `MemoryConcernStore` / `MemoryExportStore` / `MemoryReprisalStore` / etc. Each adapter exposes:

```
interface SweepableSurface {
  readonly table_name: string;     // matches OPERATIONAL_TABLE_SCHEDULE key OR 'audit_log'
  count(predicate): Promise<number>;
  deleteWhere(predicate, max_rows): Promise<number>;
  // For target-linked audit rows under the underlying-record-ceiling rule:
  isTargetGoneFor?(target_id: string, table_name: string): Promise<boolean>;
}
```

This is **standalone-with-registry**, not inheritance. The library does not subclass existing memory stores; T16.1's `SupabaseRetentionStore` does not subclass `SupabaseAuthStore` etc. — it issues table-scoped DELETEs against a single Postgres connection with the `retention_service_role` GRANTs (T16.1).

The pseudonym key shim from `MemoryExportStore` (HMAC-SHA-256, per-store random or caller-supplied) is replicated so cross-store pseudonym equality holds for the `retention.deleted` audit row's `actor_pseudonym` (which is the synthetic `retention_service` pseudonym; see §6).

The `transaction_ts_ms` shim from G-T08-14 / G-T13-9 (`now() + 1` for ordering tests) is replicated: `MemoryRetentionStore.nowMs()` returns the per-store monotonic clock that advances by ≥1 on every call. T16.1's `SupabaseRetentionStore` uses `xact_start()`.

### 6. Sweep-pass algorithm (binding for T16 ship)

```
runRetentionPass({store, config}) -> RetentionPassResult
```

Algorithm:

1. **Acquire lease.** Call `store.findOpenRun(config.lease_window_ms)`. If a run row exists with `status='running'` and `started_at_ms > now - lease_window_ms`, **refuse to start** and return `{status: 'lease_held', existing_run_id}`. Otherwise `store.recordSweepRun({run_id: randomUUID(), started_at_ms: now, status: 'running'})` and proceed.
2. **Resolve cutoffs.** For each `RetentionEventType` in iteration order (alphabetized; deterministic), resolve the cutoff timestamp from `RETENTION_SCHEDULE`. For `match_underlying` events, the cutoff is "linked record has been deleted for >30 days OR underlying record's own retention floor has passed."
3. **Per-event-type batched delete.** For each event type, call `store.deleteForEventType(event_type, cutoff_ms, config.per_event_batch_size)`. Default `per_event_batch_size = 1000`. Accumulate `{event_type: deleted_count}` into `per_event_counts`.
4. **Per-operational-table batched delete.** Iterate `OPERATIONAL_TABLE_SCHEDULE` (alphabetized). For each, resolve the predicate from the `kind` discriminator and call `store.deleteForTable(table_name, predicate, config.per_table_batch_size)`. Default `per_table_batch_size = 1000`. Accumulate `{table_name: deleted_count}` into `per_table_counts`.
5. **Per-pass row-cap.** A `config.max_total_rows_per_pass` cap (default `20000`) bounds the pass. If the cap is reached mid-iteration, commit what was done + emit the summary + close the run with `status='capped'`; the next pass continues. Lock-hold-time on high-churn tables (`auth_sessions`) is implicitly bounded by the batch size + cap combination.
6. **F-51 over-delete alarm.** If the total deleted rows for this pass exceeds `config.alarm_threshold` (default `20` per F-51's testable mitigation), the pass marks `result.alarm_fired = true` and the caller (T16.1's Edge Function) emits `A-RETENTION-001`. Library returns the flag; alert wiring lives in T16.1.
7. **Emit summary.** Build the `retention.deleted` audit row via `audit-emission.ts buildRetentionDeletedSummary(...)` and call `store.emitRetentionDeleted(...)`. The summary row is the LAST write in the transaction.
8. **Close run.** `store.closeSweepRun(run_id, {status: 'completed' | 'capped' | 'errored', ended_at_ms, prev_pass_hash, per_event_counts, per_table_counts})`.
9. **Error recovery.** Any throw inside steps 3–7 rolls back the entire transaction (`SupabaseRetentionStore` wraps the whole pass in a single Postgres transaction; `MemoryRetentionStore` discards the in-flight delete batch and re-throws). The run row is closed with `status='errored'` and the error message (no PI; per `.context/constraints.md`).
10. **Dry-run mode (CI default).** `config.dry_run = true` causes every `deleteForEventType` / `deleteForTable` to be replaced with `countCandidatesForEventType` / `countCandidatesForTable`. The summary row is built but NOT emitted; the result returns the would-delete counts. Dry-run is the CI test default per F-51's testable mitigation.

### 7. The `retention.deleted` audit-row jsonb meta layout (binding; mirrors ADR-0015 §schema requirement #4)

```
{
  event_type: 'retention.deleted',
  actor_pseudonym: HMAC(synthetic_actor_id 'retention_service'),
  target_class: 'C1',
  severity: 'info' | 'warn',          // warn when alarm_fired
  retention_class: '7y',               // no target_id; ADR-0015 carve-out
  target_id: null,
  meta: {
    run_id: uuid,
    started_at_ms: number,
    ended_at_ms: number,
    status: 'completed' | 'capped' | 'errored',
    alarm_fired: boolean,
    deleted_per_table: { [table_name: string]: number },
    deleted_per_event_type: { [event_type: string]: number },
    schedule_hash: hex,                // SHA-256 of canonical-JSON serialization
                                       // of RETENTION_SCHEDULE + OPERATIONAL_TABLE_SCHEDULE;
                                       // binds the audit row to the schedule version
                                       // that produced it (mirrors F-27 from T11/T12).
    prev_pass_hash: hex | null,        // SHA-256 of the prior pass's summary row hash
    lease_window_ms: number,
    per_pass_row_cap: number,
    alarm_threshold: number,
    dry_run: boolean                   // false in production; preserved for test introspection
  }
}
```

### 8. Underlying-record-ceiling enforcement (binding; mirrors ADR-0015 §"underlying-record-ceiling rule" verbatim)

For every audit-log event whose `RETENTION_SCHEDULE` kind is `'match_underlying'`, the sweep applies:

1. **Floor:** the per-event-type floor (always `'match_underlying'` for these; effectively the linked record's own retention).
2. **Ceiling:** if `target_id` is set AND the linked record has been deleted for more than 30 days, the audit row is in scope for deletion.
3. **Carve-out:** `retention.deleted` is exempt (no `target_id`; 7y independent).
4. **Linked-record lookup:** the sweep asks `store.isTargetGoneFor(target_id, source_table)` to determine whether the linked record is gone. `source_table` is derived from a closed `EVENT_TYPE_TO_SOURCE_TABLE` mapping in `schedule.ts` (e.g., `concern.*` → `concerns`, `reprisal.*` → `reprisal_log`, etc.). The mapping is a frozen const; the same drift-check pattern applies.

### 9. F-19-style closed-allowlist drift assertion (binding; closes G-T05-6 library-side)

Library CI test (lands in T16, file `apps/web/test/T16/retention-schedule-drift.test.ts`):

```
test('every RetentionEventType has exactly one RETENTION_SCHEDULE entry')
test('every RETENTION_SCHEDULE key is a RetentionEventType')
test('every match_underlying event_type has an EVENT_TYPE_TO_SOURCE_TABLE entry')
test('every OPERATIONAL_TABLE_SCHEDULE key matches a table in the canonical list')
test('RETENTION_SCHEDULE is Object.isFrozen')
test('OPERATIONAL_TABLE_SCHEDULE is Object.isFrozen')
```

T16.1 adds the cross-mirror SQL drift test (TS const vs SQL function vs SQL schedule table). The library-side CI test is the prerequisite for the SQL test.

### 10. Acceptance criteria (F-### list — test-writer consumes)

The test-writer turns each into a test obligation. Numbering continues from existing F-### in the threat-model (next available range in §3.6 retention block; threat-modeler assigns; placeholders are F-Rxx for "retention-sweep family"):

- **F-R1 (closes G-T05-6, library half).** `RetentionEventType` enum and `RETENTION_SCHEDULE` const drift-check: every enum value has exactly one schedule entry; every schedule key is in the enum. Test: drift CI passes; remove a `RETENTION_SCHEDULE` entry; CI fails.
- **F-R2 (closes G-T05-7).** `auth_totp_consumed_log` rows older than 24h are deleted by the sweep. Test: fixture with rows at `consumed_at` of -23h, -25h, -100h; run sweep; assert -25h and -100h gone, -23h present.
- **F-R3 (F-51 generalized to all tables).** Dry-run is the CI default. Test: a fixture with 25 candidate rows triggers `alarm_fired = true` (default threshold = 20); the run summary `meta.alarm_fired = true`.
- **F-R4 (F-52 with F-24 inversion).** Exactly one `retention.deleted` summary row per pass, written in the SAME transaction as the deletes, AFTER the deletes (the row records what landed). Test: force `emitRetentionDeleted` to throw; assert deletes rolled back (no rows deleted); assert no summary row.
- **F-R5 (idempotency).** A pass that finds an open `retention_sweep_runs` row inside the lease window refuses to start. Test: open a fake `running` run; call `runRetentionPass`; assert `{status: 'lease_held'}`.
- **F-R6 (per-pass row-cap).** A pass that would delete > `max_total_rows_per_pass` commits the cap's worth, marks `status='capped'`, and the next pass picks up the remainder. Test: fixture of 25000 expired rows + cap of 20000; first pass deletes 20000 with `status='capped'`; second pass deletes 5000 with `status='completed'`.
- **F-R7 (underlying-record-ceiling).** A `concern.source_revealed` audit row whose linked `concerns` row was deleted 31 days ago IS swept. Same audit row at 29 days is NOT swept. Test: two fixtures; assert correct disposition.
- **F-R8 (retention.deleted carve-out).** `retention.deleted` rows are NOT swept by the underlying-record-ceiling rule (no `target_id`); they age out at 7y independently. Test: a `retention.deleted` row at 6y is preserved; at 7y+1d is swept.
- **F-R9 (schedule-hash binding).** The summary row's `meta.schedule_hash` matches `SHA-256(canonical-JSON(RETENTION_SCHEDULE + OPERATIONAL_TABLE_SCHEDULE))`. Test: monkey-patch the schedule between runs; assert different hashes; assert each summary row binds to its own pass's schedule version (mirrors F-27 from T11/T12).
- **F-R10 (closed-allowlist defense-in-depth).** No caller-supplied WHERE clause path exists in `RetentionStore`; the interface only exposes `deleteForEventType(event_type, cutoff_ms, max_rows)` and `deleteForTable(table_name, predicate, max_rows)` with the predicate constructed by the library from the schedule discriminator. Test: TypeScript compile failure on attempting to pass arbitrary SQL through the interface; ESLint rule rejects `RETENTION_SCHEDULE` spread outside `schedule.ts`.
- **F-R11 (TestStore interface split, mirrors G-T11-21 / G-T13-15 / G-T14-17).** `RetentionStore` does NOT expose `__debug*` methods; only `TestRetentionStore` does. Test: TypeScript type assertion that `RetentionStore` does not have `__debugListRuns` etc.
- **F-R12 (transaction_ts_ms shim, mirrors G-T08-14 / G-T13-9).** `MemoryRetentionStore.nowMs()` advances ≥1 per call for ordering tests; T16.1's `SupabaseRetentionStore` uses `xact_start()`. Test: two adjacent `nowMs()` calls return distinct values.
- **F-R13 (no PII in errors).** Every error path in `runRetentionPass` carries `{run_id, status, error_code}` and NEVER a row value, target_id, or PI shape. Test: force every error path; grep error message for PII shapes (uuids except run_id, email-shaped strings, pseudonym-shaped strings).
- **F-R14 (RA-1 control #5 preserved).** `export.generated` retention is 7y; the sweep MUST NOT shorten it. Test: snapshot the resolved cutoff for `export.generated`; assert it is exactly 7y back from `nowMs()`.
- **F-R15 (RA-2 trigger #3 reconciliation anchor).** Every sweep pass writes a `retention_sweep_runs` row with `per_event_counts` jsonb; the test-writer's reconciliation test (T18 carry-forward) joins live `audit_log` absences to `retention_sweep_runs.per_event_counts` for attribution. Test: delete N rows via sweep; assert `retention_sweep_runs.per_event_counts` sums to N.

### Threat-model F-### cross-reference (assigned 2026-05-23 by threat-modeler)

The threat-modeler's next pass scored F-R1..F-R15 above as the retention-sweep family and assigned final F-### identifiers in `.context/threat-model.md` §3.9 "Retention sweep (T16)" (titled per the ADR-0017 brief as "§3.6 Retention sweep (T16)"; numbered §3.9 in the threat-model file because §3.6, §3.7, §3.8 are pre-occupied by inspection sync, backup encryption, and audit-log integrity respectively). Mapping placeholder → final:

| ADR-0017 §10 placeholder | Final F-### in threat-model §3.9 | Lineage anchor | Library/SQL scope |
|---|---|---|---|
| F-R1 | F-55 | F-19 closed-allowlist | T16 library CI; T16.1 cross-mirror |
| F-R2 | F-56 | F-38 / G-T05-7 | T16 library; T16.1 SQL DELETE |
| F-R3 | F-57 | F-51 generalised | T16 library; T16.1 alert wire |
| F-R4 | F-58 | F-52 + F-24 inversion | T16 library; T16.1 pgTAP single-tx |
| F-R5 | F-59 | NEW SURFACE — pg_cron race | T16 checkpoint; T16.1 advisory lock |
| F-R6 | F-60 | NEW SURFACE — starvation | T16 cap; T16.1 timeouts + cron stagger |
| F-R7 | F-61 | ADR-0015 §3.5 | T16 library |
| F-R8 | F-62 | ADR-0015 schedule carve-out | T16 library |
| F-R9 | F-63 | F-27 allowlist hash | T16 library |
| F-R10 | F-64 | F-19 lineage | T16 type-level + ESLint; T16.1 SQL signature |
| F-R11 | F-65 | G-T11-21 / G-T13-15 / G-T14-17 | T16 library |
| F-R12 | F-66 | G-T08-14 / G-T13-9 | T16 library; T16.1 xact_start() |
| F-R13 | F-67 | constraints.md:110-111 | T16 library |
| F-R14 | F-68 | RA-1 control #5 | T16 library |
| F-R15 | F-69 | RA-2 trigger #3 | T16 library; T16.1 pgTAP; T18 join |

Verdicts (threat-modeler):
- **RA-1 control #5 NOT re-opened** — confirmed; F-68 is the standing assertion.
- **RA-2 trigger #3 NOT re-opened** — semantics unchanged; F-69 + G-T16-8 (T18 join inheritance) anchor attribution.
- **HG-10 NOT firing is defensible** — confirmed; no BLOCK from threat-modeler.
- **F-51 drives Medium → Low at the library boundary** when dry-run + row-cap + alarm-threshold all hold; production-untested Medium remains until T16.1 wires A-RETENTION-001.
- **F-58 is a coherent F-24 variant** (audit-WITH-side-effect), not a weakening of F-24.

T16.1-deferred carry-forwards (G-T16-1 through G-T16-10) are listed in threat-model §3.9 "Carry-forwards" and gate T16.1 PR clearance.

## Sibling task spec — T16.1 scope

T16.1 ships AFTER T16's four-way reviewer pass clears. T16.1 deliverables (no PR until HG-15 ratification arrives):

1. **`SupabaseRetentionStore implements RetentionStore`** — talks to the live Postgres schema via `SECURITY DEFINER` functions owned by `retention_service_role` (non-login; GRANT EXECUTE per F-19 pattern).
2. **SQL migration** at `supabase/migrations/0000000000000X_retention.sql` (X TBD by migration-handler) creating:
   - `audit_log_retention_schedule` (one row per `RetentionEventType` enum value; ADR-0015 §schema requirement #2). **HG-15 trigger.**
   - `retention_sweep_runs` (idempotency checkpoint + RA-2 trigger #3 reconciliation anchor). **HG-15 trigger.**
3. **SQL functions** (each SECURITY DEFINER, owner `migration_role`, GRANT EXECUTE to `retention_service_role`, per-function justification comment):
   - `sweep_for_event_type(p_event_type text, p_cutoff_ms bigint, p_max_rows int) returns int`
   - `sweep_for_table(p_table_name text, p_predicate_kind text, p_cutoff_ms bigint, p_max_rows int) returns int`
   - `record_sweep_run(...)`, `find_open_run(...)`, `close_sweep_run(...)`, `emit_retention_deleted(...)`
4. **CI drift test (cross-mirror)** asserting `RETENTION_SCHEDULE` (TS) = `retention_class_for(p_event_type)` (SQL function) = `audit_log_retention_schedule` (SQL table) on the closed enum domain.
5. **pg_cron schedule.** Daily 03:30 ET (after the 03:00 ET pg_dump per ADR-0012; tolerates the transient-inconsistency posture per Decision §5).
6. **Edge Function trigger** as the alternative to pg_cron for environments where pg_cron is unavailable. The Edge Function invokes a wrapping SQL function inside a single transaction.
7. **ADR-0016 schedule rows** for the two new tables (`audit_log_retention_schedule`, `retention_sweep_runs`). The schedule entries are: `audit_log_retention_schedule` = `permanent_schema_table` (no retention; schema artifact); `retention_sweep_runs` = `7y` (mirrors `retention.deleted` retention — they are a pair). **HG-15 re-ratifies.**
8. **§PI inventory amendments** for `retention_sweep_runs` (no PI; counts + run metadata only) and confirmation that `audit_log_retention_schedule` carries no PI. ~2 rows added.
9. **`retention_service_role` GRANT documentation** — explicit GRANT EXECUTE on each SECURITY DEFINER function; REVOKE on all base tables; the role is non-login (cannot be reached via JWT).
10. **pgTAP integration tests** covering every SECURITY DEFINER function + the cross-mirror drift test.
11. **HG-15 re-ratification** of the operational-table schedule with the two new rows. **The HG-15 trigger is named explicitly: T16.1 introduces `retention_sweep_runs` and `audit_log_retention_schedule` (two new physical tables).** Approval recorded in this ADR pre-T16.1 PR is not possible; user ratifies at T16.1 PR submission.
12. **A-RETENTION-001 alert wiring** for the F-R3 over-delete threshold; observability-setup's next pass after T16.1 wires the alert sink.

T16.1 does NOT ship until HG-15 ratification for the two new tables is recorded.

## Open-question dispositions (a)–(g) from the librarian briefing — answered

| Q | Disposition | Rationale |
|---|---|---|
| (a) Sweep semantics: hard-delete vs redact-but-retain-shape | **Hard-delete uniformly** | Option A above. ADR-0015 + ADR-0016 literal reading. Pseudonym-only is a v2 amendment if a regulator demands it. |
| (b) Idempotency mechanism | **Checkpoint table `retention_sweep_runs`** | Option C(a) above. Doubles as F-52 forensic surface + RA-2 trigger #3 reconciliation anchor. Library mirrors in-memory via `MemoryRetentionStore`. |
| (c) Recovery semantics mid-batch | **Single transaction; summary is LAST row** | Option D above. F-24 generalizes to audit-WITH-side-effect; on any failure the entire pass rolls back. Per-batch savepoints rejected. |
| (d) Interaction with T17 / RA-2 trigger #3 | **Tolerate transient inconsistency; `retention_sweep_runs` is the reconciliation anchor** | Option E above. ADR-0015 §Risks already commits to "transient inconsistency is acceptable." T18's integrity job inherits the reconciliation check (additive). |
| (e) Pre-deletion user notification | **No notification in v1** | Option F above. No ADR mandates; **HG-10 NOT fired.** Deferred for any future regulator-driven need. |
| (f) `retention_class` backfill | **None required** | Option G above. T05 migration landed the column; every row stamps at write time. |
| (g) Schedule-table vs `retention_class_for()` vs `RETENTION_SCHEDULE` authority | **`audit_log_retention_schedule` table is authoritative; SQL function and TS const are mirrors; CI drift assertion enforces equality** | Option H above. Library ships TS-side drift test in T16; T16.1 ships cross-mirror drift test. |

## Reversibility

**Easy** on schedule values (additive migration; `RETENTION_SCHEDULE` const edit + matching SQL row in T16.1). **Easy** on batch sizes / row cap / alarm threshold (config values). **Medium** on the sweep-pass algorithm itself (re-architecting requires changing both `MemoryRetentionStore` and the future `SupabaseRetentionStore` + the SQL functions). **Hard** on the closed `RetentionEventType` enum (every new event type touches the four mirrors — TS const, SQL function, SQL schedule table, and the ADR-0015 schedule itself). **Hard** on the hard-delete-uniformly semantics (reversing to pseudonym-only is a v2 ADR amendment + reviewer pass).

## Consequences

### Positive

- ADR-0015 + ADR-0016 retention promises are no longer aspirational; the sweep is the structural enforcer.
- G-T05-6 closes (library half); the drift between `RETENTION_SCHEDULE` (TS), `retention_class_for()` (SQL), and `audit_log_retention_schedule` (SQL table) is structurally caught by CI in T16 (TS half) and T16.1 (cross-mirror half).
- G-T05-7 closes (library exercise; SQL DELETE path lands in T16.1).
- F-51 / F-52 / F-19 / F-24 mitigations are all encoded in the library contract; the threat-modeler scores them with concrete test obligations rather than narrative mitigations.
- RA-1 control #5 is preserved (sweep cannot shorten `export.generated` retention; F-R14 asserts).
- RA-2 trigger #3 has a reconciliation anchor (`retention_sweep_runs.per_event_counts`); T18's integrity job inherits the check.
- Amendment H pattern is honoured: T16 library-only; T16.1 SQL + production wire-up + HG-15.

### Negative / accepted tradeoffs

- Two new physical tables (`audit_log_retention_schedule`, `retention_sweep_runs`) introduced by T16.1. **HG-15 fires.** Mitigated by the schedule-row addition being part of T16.1's deliverable, not amortized.
- Hard-delete-uniformly cannot be partially reversed without a v2 amendment.
- Cross-mirror drift surface (three mirrors: TS const, SQL function, SQL table). Mitigated by CI drift tests on every PR.

### Risks

- **Schedule-mirror drift between PRs.** A T16-only PR adds an event type to `RETENTION_SCHEDULE` (TS) without touching `retention_class_for()` (SQL) or `audit_log_retention_schedule` (SQL table). Mitigated: library-side drift test fails when the TS const has more keys than `RetentionEventType` enum; the cross-mirror test in T16.1 catches the SQL drift. Pre-T16.1, a new event type added in TS cannot affect production (no SQL execution path in T16).
- **Lock-hold-time on `auth_sessions` (high-churn).** Per-event-type batching + per-pass row-cap bound the lock window. Cap of 20000 rows + batch of 1000 = at most 20 batches per table per pass. Statement timeout in T16.1's SQL functions is set conservatively (default Postgres 30s; sweep functions override to 60s; recorded in T16.1's function comments).
- **`retention.deleted` rate vs `alarm_threshold`.** A backlog (e.g., first sweep after a long pause) trips the F-R3 alarm. The alarm is informational (does not block the pass); operator reviews and re-runs with a higher threshold if the backlog is legitimate.

## Compliance check

- [x] PIPEDA Principle 4.5 (Limiting Retention) — every persistent record now has an enforced deletion path.
- [x] PIPEDA Principle 4.9 (Individual Access) — underlying-record-ceiling rule preserves traceability while a record lives; deletion is structural at the floor.
- [x] `.context/constraints.md` data-lifecycle requirements (lines 130–131) — "Deletion is real deletion" honoured by hard-delete-uniformly; "Retention schedule defined per data type and ENFORCED" honoured by the sweep + the closed-allowlist drift test.
- [x] `.context/constraints.md` "No PII in app logs / error messages" — F-R13 asserts.
- [x] `.context/constraints.md` "Parameterized queries only" — `RetentionStore` interface forbids caller-supplied WHERE; the predicate is constructed from the schedule discriminator only.
- [x] Data residency — no new processor; no new cross-border flow.
- [x] ADR-0016 hard rule "every operational table touching PI MUST appear in this schedule before the table ships in any migration that lands in `main`" — `audit_log_retention_schedule` and `retention_sweep_runs` are added to the ADR-0016 schedule in T16.1 BEFORE the migration lands. Structurally enforced by Amendment H.
- [x] HG-14 (ADR-0015 schedule ratification) — RATIFIED 2026-05-22; not re-fired by this ADR.
- [x] HG-15 (operational-table retention gate) — fires at T16.1 PR submission for the two new tables; this ADR identifies the trigger explicitly.
- [x] HG-10 (user-facing pre-deletion copy) — explicitly NOT fired. Option F decision: no pre-deletion notification in v1.

## Validation pass (architect self-check)

- **RA-1 compensating control #5 re-open?** No. The sweep does NOT shorten `export.generated` retention (7y) and does NOT touch the post-export notification surface (which lives in `ExportStore.sendPostExportNotification` and is not a retention target). F-R14 is the test obligation that pins this.
- **RA-2 trigger #3 re-open?** No. The sweep introduces a structured reconciliation anchor (`retention_sweep_runs.per_event_counts`) so the T18 backstop check can attribute live-chain-vs-backup divergence to a sweep pass. Unattributed divergence still re-opens RA-2 (the trigger semantics are unchanged); attributed divergence is the audited expected case.
- **HG-15 trigger identified for new tables?** Yes. Two new physical tables (`retention_sweep_runs`, `audit_log_retention_schedule`) land in T16.1; HG-15 fires at T16.1 PR submission. T16 itself introduces ZERO new physical tables.
- **HG-10 explicitly NOT fired?** Confirmed. Option F decision: no user-facing pre-deletion copy in v1.
- **All carry-forward IDs this design closes:** G-T05-6 (library half — TS drift CI), G-T05-7 (library exercise; SQL DELETE deferred to T16.1).
- **All carry-forward IDs this design defers to T16.1:** G-T07-1+ (T07's SQL still pending T07.1; sweep can iterate the tables once they exist), G-T08-1, G-T10-4, G-T11-1, G-T13-1 (T13's hard-DELETE on `reprisal_log` is the T16 enforcer per HG-7; library-side honoured by the schedule, SQL DELETE lands in T16.1), G-T14-1.

## Task breakdown (ordered; each task ≤ 1 file of work)

| # | Title | Description | Deps | Acceptance (F-R# from §10) | Owner | Risk | Estimate |
|---|---|---|---|---|---|---|---|
| 1 | Add `types.ts` | `RetentionEventType` closed string-literal union; `RetentionClass` discriminator; schedule-shape types; `SweepableSurface` interface. | none | F-R1, F-R10 (type-level) | implementer | low | S (2h) |
| 2 | Add `schedule.ts` | `RETENTION_SCHEDULE` and `OPERATIONAL_TABLE_SCHEDULE` frozen consts; `EVENT_TYPE_TO_SOURCE_TABLE` map; canonical-JSON helper for `schedule_hash`. | 1 | F-R1, F-R8, F-R9 | implementer | low | M (3h) |
| 3 | Add `retention-store.ts` | `RetentionStore` (production) and `TestRetentionStore extends RetentionStore` (test-only) interfaces. ESLint comment header forbidding `__debug*` outside Test. | 1 | F-R10, F-R11 | implementer | low | S (1h) |
| 4 | Add `memory-retention-store.ts` | `MemoryRetentionStore implements TestRetentionStore`; registry-based composition with existing memory stores via `SweepableSurface`; `nowMs()` monotonic shim; HMAC pseudonym for synthetic `retention_service` actor. | 2, 3 | F-R11, F-R12 | implementer | medium | L (6h) |
| 5 | Add `audit-emission.ts` | `buildRetentionDeletedSummary(...)` constructs the F-52 jsonb meta with `schedule_hash`, `per_event_counts`, `per_table_counts`, `run_id`, `prev_pass_hash`, `lease_window_ms`, etc. | 2 | F-R4, F-R8, F-R9 | implementer | low | M (3h) |
| 6 | Add `retention-core.ts` | `runRetentionPass({store, config})` implementing the 10-step algorithm (Decision §6). Exhaustive switch on `RetentionEventType` with `never` cast. Dry-run mode. F-51 alarm flag. Per-pass row-cap. | 2, 3, 4, 5 | F-R2, F-R3, F-R4, F-R5, F-R6, F-R7, F-R13, F-R14, F-R15 | implementer | high | L (8h) |
| 7 | Add `index.ts` | Public surface re-exports. | 6 | (surface) | implementer | low | S (1h) |
| 8 | ESLint rule `no-spread-into-retention-schedule` | Mirrors T11/T12's allowlist spread ban; forbids spread-into-`RETENTION_SCHEDULE` outside `schedule.ts`. | 2 | F-R10 | implementer | low | S (2h) |
| 9 | Drift-check test file | `apps/web/test/T16/retention-schedule-drift.test.ts` covering F-R1, F-R8, F-R9 (schedule-vs-enum, `match_underlying`-vs-source-table, frozen-ness). | 2 | F-R1, F-R8, F-R9 | test-writer | low | M (3h) |
| 10 | Sweep algorithm test file | `apps/web/test/T16/retention-sweep.test.ts` covering F-R2, F-R3, F-R4, F-R5, F-R6, F-R7, F-R11, F-R12, F-R13, F-R14, F-R15. | 4, 5, 6 | (per F-R# above) | test-writer | medium | L (8h) |
| 11 | RA-1 control #5 regression test | `apps/web/test/T16/ra1-control-5-preserved.test.ts` — snapshot the resolved cutoff for `export.generated`; asserts exactly 7y. | 2, 6 | F-R14 | test-writer | low | S (1h) |
| 12 | F-19 / F-24 cross-task assertion | `apps/web/test/T16/closed-allowlist-and-audit-before.test.ts` — TypeScript-level type assertion that `RetentionStore` does not surface caller-supplied WHERE; behavioural assertion that summary row is written ONLY if deletes commit (rollback on emit failure). | 3, 6 | F-R4, F-R10 | test-writer | medium | M (3h) |

Total estimate: ~41h library implementer + test-writer (matches the T07 library precedent's order-of-magnitude).

## Cross-references

- **ADR-0015** — per-event-type audit-log retention schedule (authoritative; mirrored verbatim in `RETENTION_SCHEDULE`).
- **ADR-0016** — operational-table retention schedule (authoritative; mirrored verbatim in `OPERATIONAL_TABLE_SCHEDULE`).
- **ADR-0002 Amendment H** — sibling-task pattern; T16 = library, T16.1 = production wire-up.
- **ADR-0012 amendment** — 42-day backup hard-delete + 7y longest audit retention coherence; sweep respects ADR-0015 §Risks "transient inconsistency is acceptable."
- **RA-1 compensating control #5** — post-export notification surface; F-R14 pins `export.generated` retention.
- **RA-2 trigger #3** — live-chain vs pg_dump divergence; `retention_sweep_runs.per_event_counts` is the reconciliation anchor.
- **F-19 / F-24 (threat-model)** — closed-allowlist + audit-before-side-effect; both patterns reused.
- **F-50 / F-51 / F-52 (threat-model)** — chain-integrity / retention-bug / retention-itself-audited; F-51 and F-52 fully encoded; F-50 is T18's surface (sweep DELETE path is the only legitimate audit-row deletion path and is itself auditable via `retention_sweep_runs`).
- **G-T05-6 / G-T05-7** — closed library-side; SQL half deferred to T16.1.
- **G-T07-* / G-T08-1 / G-T10-4 / G-T11-1 / G-T13-1 / G-T14-1** — sweep iterates these tables once they exist (per task); SQL DELETE path lands in T16.1.
- **G-T08-14 / G-T13-9** — `transaction_ts_ms` shim mirrored.
- **G-T11-21 / G-T13-15 / G-T14-17** — TestStore interface split mirrored.

## Follow-ups

- [ ] **T16 implementer pass** — execute tasks 1–8 above in order.
- [ ] **T16 test-writer pass** — execute tasks 9–12 above.
- [ ] **T16 four-way reviewer pass** — security + second-opinion + privacy + threat-model cross-check on the library deliverable.
- [ ] **threat-modeler next pass** — add F-R1 through F-R15 to `.context/threat-model.md` under a new §3.6 "Retention sweep" sub-section. Map to existing F-19 / F-24 / F-51 / F-52 lineage explicitly. Score residuals.
- [ ] **T16.1 (sibling task)** — see "Sibling task spec — T16.1 scope" above. Runs before any deploy carrying real PI. HG-15 fires at T16.1 PR submission.
- [ ] **observability-setup next pass after T16.1** — wire `A-RETENTION-001` alert sink for F-R3 over-delete threshold.
- [ ] **T18 next pass** — additive reconciliation check (live `audit_log` absences vs `retention_sweep_runs.per_event_counts` attribution) per RA-2 trigger #3 anchor. No new task; additive to T18.

---

# Amendment pass #5 (2026-05-23) — T07 scope reduction + Argon2id fail-closed

**Decider(s):** architect (amendment pass #5 per privacy-review-t07 §12 BLOCKING findings T07-1 / T07-2 / T07-3 and the consolidated security/second-opinion/privacy reviewer blockers B1–B8 in commit `31f80d3`); **user** ratified the "drop migration to T07.1; fix the 3 small TS blockers" remediation path.

**Source:** `/home/user/agent-os/.context/privacy-review-t07.md` §12; consolidated reviewer blockers B1 (Argon2id fallback) / B2 (`issue_recovery_blob_reset` missing authz+audit) / B3 (`record_recovery_blob_viewed` missing server-side cap-of-3) / B4 (module-level rotation lock) / B5 (`Math.random()` fallback) / B6 (untested SQL) / B7 (ADR-0016 schedule rows missing) / B8 (`view_count` over-collection); commit `31f80d3` message.

**Hard rules for this pass (binding on this commit only):**
- Only `.context/decisions.md` is modified in this pass. Known-gaps additions are written by the orchestrator in a separate commit per the carry-forward list below.
- No application-code edits (`apps/web/`, `supabase/`, `observability/`, `i18n/`, test files all untouched).
- Newest amendment on top per file convention.

**The four ratified decisions and where they landed:**

1. **T07 scope reduced to TS library only.** SQL migration moves to T07.1 (sibling production-wire-up task). T07 ships the library code with 41/41 tests against `MemoryKeyStore`; T07.1 ships `SupabaseKeyStore` + SQL functions + integration tests against a Supabase local stack. Structural reduction closes B2 / B3 / B6 / B7 / B8 — no SQL function ships in this PR, no new physical tables ship in this PR, no `view_count` column ships in this PR. Privacy BLOCKING findings T07-1 / T07-2 / T07-3 from `/home/user/agent-os/.context/privacy-review-t07.md` are deferred to T07.1 by structural deferral of the schema itself. **Landed as ADR-0002 Amendment H below.** The Amendment H pattern is now the canonical sibling-task posture: each library task ships its in-memory store; its `Supabase*Store` production wire-up is a numbered sibling task (T05.1, T07.1, …) that runs before any deploy carrying real PI.

2. **Argon2id fallback: fail-closed.** `encryptRecoveryBlob` MUST throw `argon2id_unavailable_libsodium_wrappers_sumo_required` when `crypto_pwhash` is unavailable. No silent BLAKE2b substitution. Closes B1. **Landed as ADR-0003 Amendment G below** (sibling of Amendment F, not a folded extension of Amendment F's addendum block, because the fail-closed contract is architecturally distinct from the show-again accommodation and will be cross-referenced from T07.1's `libsodium-wrappers-sumo` swap).

3. **Rotation lock scoped to per-`KeyStore` instance.** Module-level `rotationLockBusy` replaced with a per-`KeyStore` lock. Closes B4. **No new ADR.** This is an implementation detail; SQL-side `pg_try_advisory_xact_lock` is the production source of truth (lands in T07.1). The per-store TS lock is for test determinism only. Implementer applies the fix per its in-house judgment; per-store scoping is the contract. Recorded here for traceability only.

4. **`Math.random()` → libsodium.** `generateRotationId()` in `committee-key.ts` uses `libsodium.randombytes_buf` exclusively; `Math.random()` fallback removed. Closes B5. **No new ADR.** Direct enforcement of **ADR-0003 Invariant 4** (libsodium-only primitives) as reaffirmed. Recorded here for traceability only.

**Advisories deliberately deferred to T07.1 / known-gaps (NOT ratified in this pass):**

- Security F4 — history-purge architectural choice. Privacy review §4 already verdicted "right call" (Principle 4.4 minimization wins; audit row carries attribution). The deliberate exception to "preserve history" is documented in ADR-0015 implicitly via the per-event-type retention of `committee_data_key.member_revoked` (7y) holding the forensic value. **No new ADR; recorded as carry-forward G-T07-* under the T07.1 wire-up so the privacy review of T07.1 can re-confirm the audit-before-purge ordering test (T07-A1) lands with the SQL function.**
- Security F5 — KeyStore interface accepts `private_key` (read interface should not surface private material). Split into two interfaces in T07.1.
- Security F6 — F-02 self-test is client-side only; server-issued nonce challenge lands in T07.1.
- Privacy T07-A1 — test-writer audit-row-ordering assertion on member-revoke (lands with T07.1 SQL function).
- Privacy T07-A2 — moot under Decision 1 (no `issue_recovery_blob_reset` SQL function ships in T07).
- Privacy T07-A3 — static-lint glob widening to `src/lib/recovery/`. Small implementer fix; the architect does NOT direct it in this pass (per hard rules, no implementer steering on file edits beyond the four ratified items). Recorded as carry-forward.
- Privacy Cross-cutting A — `identity_pubkey` relocation ADR documentation. Lands when T07.1 ships the migration; until then no drift exists because no `identity_keys` table exists.

**Carry-forwards the orchestrator will write to `.context/known-gaps.md` under a new T07 section (verbatim entries):**

- **G-T07-1: SQL migration deferred to T07.1.** The `supabase/migrations/00000000000002_identity.sql` file (and any sibling identity / recovery-blob / committee-key migrations) does NOT land in T07. It lands in T07.1 alongside `SupabaseKeyStore`. Closure: T07.1 migration-handler + privacy-reviewer re-run on the new tables.
- **G-T07-2: SupabaseKeyStore production wire-up (T07.1).** T07 ships `MemoryKeyStore` only. T07.1 implements `SupabaseKeyStore` against the live Postgres schema. Closure: T07.1 implementer respin with integration tests.
- **G-T07-3: Real Supabase integration tests for T07 SQL functions (T07.1).** The library's 41/41 tests cover `MemoryKeyStore`. SQL-function behaviour (`issue_recovery_blob_reset`, `record_recovery_blob_viewed`, member-revoke rotation, etc.) is tested only against the SupabaseKeyStore that lands in T07.1, using a Supabase local stack. Closure: T07.1 test-writer pass.
- **G-T07-4: ADR-0016 schedule rows for 6 tables (T07.1 — when migration actually lands).** `identity_keys`, `recovery_blobs`, `recovery_blob_resets`, `committee_data_keys`, `committee_key_wraps`, `committee_key_wraps_history`. Privacy review T07-1 BLOCKING is structurally deferred (no tables exist yet in main). Closure: ADR-0016 amendment + HG-15 re-ratification when T07.1 lands.
- **G-T07-5: §PI inventory amendments for 6 tables (T07.1).** ~20 new PI inventory rows + two amendments to existing rows for `identity_pubkey` / `identity_privkey_recovery_blob` relocation per the privacy review §11. Closure: T07.1 architect pass folds into §PI inventory.
- **G-T07-6: `view_count` decision (T07.1 — preferred removal at design time).** Privacy review T07-2 BLOCKING preferred-fix: remove `recovery_blobs.view_count`, derive at read-time from `audit_log` rows where `event_type='identity_privkey.recovery_blob.viewed'`. Closure: T07.1 migration-handler implements the preferred path; if the alternative (keep the column) is chosen instead, an ADR-0003 Amendment F addendum is required.
- **G-T07-7: Server-side cap-of-3 enforcement in `record_recovery_blob_viewed` (T07.1).** TS-side cap-of-3 from ADR-0003 Amendment F is necessary but not sufficient; the SQL function must enforce. Closes B3 in T07.1. Closure: T07.1 SQL function + test-writer assertion.
- **G-T07-8: `issue_recovery_blob_reset` authz + audit emission (T07.1).** Closes B2 + privacy T07-A2 in T07.1. Closure: T07.1 SQL function with caller-authz check + `audit_emit` row.
- **G-T07-9: Server-issued nonce for F-02 self-test (T07.1).** Closes security F6 in T07.1. Closure: T07.1 wires the self-test challenge to a server-issued nonce endpoint.
- **G-T07-10: KeyStore interface split (T07.1).** Read interface MUST NOT surface `private_key`. Closes security F5 in T07.1. Closure: T07.1 TS interface refactor + implementer respin.
- **G-T07-11: `identity_pubkey` relocation documentation (T07.1).** ADR-0002 Amendment G.3 addendum documenting the `users.identity_pubkey` → `identity_keys.public_key` relocation lands when T07.1 lands the migration. Also: test-harness query update + ADR-0003 Amendment A CI grep target update. Closure: T07.1 architect pass.
- **G-T07-12: `libsodium-wrappers-sumo` dep swap (T07.1) — production guard for the Argon2id fallback even though fail-closed makes it moot.** Per ADR-0003 Amendment G below, the library refuses to run without Argon2id, so production cannot silently downgrade. Swapping the dep to the `-sumo` variant in T07.1 makes the fallback unreachable rather than merely refused. Closure: T07.1 implementer pass + pnpm `lockfile-lint` rule.

**Reviewer re-run posture after this pass:**

Orchestrator drops the SQL migration from the T07 PR; implementer applies the three TS fixes (per Decisions 2, 3, 4); then the four-way reviewer re-run (security + second-opinion + privacy + threat-model cross-check) verifies T07 is now library-only with the fail-closed Argon2id contract intact and the four privacy/security advisories listed above explicitly carried forward to T07.1.

---

# ADR-0003 Amendment G (2026-05-23, amendment pass #5, B1 resolution): Recovery-blob encryption refuses to operate without Argon2id

**Amends ADR-0003** above. Trigger: consolidated reviewer blocker B1 (`/home/user/agent-os/.context/privacy-review-t07.md` §9 cross-cutting B / T07-A4 advisory; security-reviewer + second-opinion-reviewer + privacy-reviewer agreement). Cross-references **ADR-0003 Invariant 4** (libsodium-only crypto primitives — non-negotiable), **ADR-0003 Amendment F** (recovery-passphrase show-again accommodation; same module surface), and **carry-forward G-T07-12** (production `libsodium-wrappers-sumo` dep swap in T07.1).

### The problem

T07's library implementation of `encryptRecoveryBlob` (in the `src/lib/recovery/` module) historically degraded silently to BLAKE2b when `libsodium.crypto_pwhash` was unavailable at runtime. The KDF-params claim block in the resulting blob still labelled the algorithm `argon2id13`, while the actual derivation was BLAKE2b. Three downstream failures cascade from this:

1. **Restore-time forensic incoherence.** `decryptRecoveryBlob` reads `kdf_params.alg`, sees `argon2id13`, derives via Argon2id, and fails to match the BLAKE2b-derived key. The user's recovery sheet becomes unusable through no fault of theirs.
2. **PIPEDA Principle 4.7 (Safeguards) regression.** BLAKE2b without the work-factor properties of Argon2id is not "sensitivity-appropriate" for a long-lived offline-brute-force target (F-08). The label-vs-derivation drift makes the regression undetectable by inspection of the stored blob alone.
3. **Mixed-deployment data-integrity bomb.** A deployment where some nodes have `crypto_pwhash` and others do not produces blobs that the next node cannot restore. The failure mode is not flagged by tests that all run against the same build.

The four-reviewer agreement is unanimous: silent algorithm substitution in cryptographic code is unacceptable under Invariant 4. The two remediation paths were:

- **Path X: extend the alg field + add a forward-compat plan for old blobs.** Adds a new code path that the test matrix must cover; doubles the restore-time logic; widens the threat space.
- **Path Y: fail-closed at write-time.** No old blobs exist yet (T07 has not shipped). The smallest change that prevents the data-integrity bomb is to refuse to write a blob the deployment cannot honestly label.

### The amendment — fail-closed contract

`encryptRecoveryBlob` (in `src/lib/recovery/`) MUST throw the error message `argon2id_unavailable_libsodium_wrappers_sumo_required` when `libsodium.crypto_pwhash` is unavailable at the call site. The error MUST be thrown BEFORE any key derivation attempt. The error MUST NOT be caught and silently retried with a different KDF. `decryptRecoveryBlob` MUST also assert `kdf_params.alg === 'argon2id13'` against runtime capability and fail loudly on mismatch (this half is already specified by privacy-reviewer T07-A4; restated here for completeness).

**The fail-closed contract binds:**

1. **Write-time detection.** `encryptRecoveryBlob` checks `typeof libsodium.crypto_pwhash === 'function'` (or the equivalent feature-test the implementer chooses; the canonical wording is "crypto_pwhash is callable") at entry, BEFORE generating any randomness, BEFORE deriving any key, BEFORE allocating any buffer. If false, throws `argon2id_unavailable_libsodium_wrappers_sumo_required`.
2. **Error message is canonical.** The string `argon2id_unavailable_libsodium_wrappers_sumo_required` is the exact wording the test-writer asserts on. No prefix, no localization, no enriched JSON wrapper at this layer (higher layers may wrap; the bottom-layer throw is the canonical string).
3. **No silent BLAKE2b substitution.** Any code path that previously fell through to BLAKE2b is removed. Static lint asserts zero matches for `crypto_generichash` (or any BLAKE2b primitive) inside `src/lib/recovery/` outside the documented HMAC-of-blob-id allowlist if one exists. Implementer pass confirms.
4. **Test-harness override is explicit and documented.** Tests that need a fast KDF (because Argon2id at production work-factors is slow) MUST provide an explicit override flag (the implementer chooses the shape — environment variable, constructor argument, factory-function parameter); the override flag's existence is logged by the library at construction time when set, and the production build MUST NOT honor the override (a build-time assertion or runtime `NODE_ENV !== 'production'` guard is acceptable). The architect does NOT prescribe the flag shape; the implementer picks per its in-house judgment with the constraints above as the contract.

### Production posture (binding on T07.1 — see G-T07-12)

Production builds use `libsodium-wrappers-sumo`. The `-sumo` variant ships `crypto_pwhash` in all environments; the fail-closed throw becomes unreachable in production. A pnpm `lockfile-lint` rule (added by T07.1) asserts the production lockfile contains `libsodium-wrappers-sumo` rather than `libsodium-wrappers`. A boot-time assertion refusing to start if `crypto_pwhash` is absent and `NODE_ENV === 'production'` is added in T07.1 (privacy-reviewer T07-A4 fix list, item 1).

The architect's posture: the fail-closed throw is the smallest correct change at the library layer; the dep swap is the smallest correct change at the production layer; together they make the BLAKE2b code path structurally impossible to reach.

### Rationale (why fail-closed over alg-field extension)

- **Minimization.** No new code path means no new test surface and no new branch in restore-time logic.
- **No forward-compat debt.** T07 has not shipped; no blobs exist in any environment that would need to be readable by a future fail-closed-only version. The window to choose fail-closed is now.
- **Detectability of misconfiguration.** A fail-closed throw at write-time is louder than a label-vs-derivation drift discoverable only at restore-time (which may be months later, in the field, when the user needs the data).
- **Reviewer agreement.** Three independent reviewers chose fail-closed over alg-field extension. The architect ratifies.

### Reversibility

**Easy** on the library implementation (one module: `src/lib/recovery/`; one feature-test; one throw). **Hard** on the architectural posture: once T07.1 lands the dep swap and the boot-time assertion, downgrading the library to silent-substitute mode would require re-introducing a regression that three reviewers blocked.

### Compliance check additions

- [x] PIPEDA Principle 4.7 (Safeguards) — sensitivity-appropriate KDF is structurally enforced; no silent downgrade.
- [x] ADR-0003 Invariant 4 (libsodium-only crypto) — reaffirmed; the fail-closed throw is the enforcement mechanism at the library layer.
- [x] No new third-party processor.
- [x] No new cross-border flow.
- [x] Threat-model F-08 — long-lived offline-brute-force resistance is preserved; no BLAKE2b-derived blobs can be written.

### Testable assertions (T07 acceptance amended)

1. **Fail-closed throw on absent `crypto_pwhash`.** Stub libsodium with `crypto_pwhash` set to `undefined`; call `encryptRecoveryBlob(...)`; assert the call throws; assert the error message is exactly `argon2id_unavailable_libsodium_wrappers_sumo_required`.
2. **No silent BLAKE2b path.** Static lint asserts zero matches for `crypto_generichash` in `src/lib/recovery/` outside the test-fixture path (or the documented allowlist if one exists; implementer documents in the module).
3. **Test-harness override is explicit.** With the override flag NOT set: the library uses Argon2id (or throws). With the override flag set: the library uses the fast KDF AND logs a clear "test KDF override active" warning at construction time. In production-mode (build-time `NODE_ENV === 'production'`): setting the flag does NOT enable the fast KDF.
4. **`decryptRecoveryBlob` mismatch detection.** A blob with `kdf_params.alg = 'argon2id13'` in a runtime where `crypto_pwhash` is absent → `decryptRecoveryBlob` throws (does NOT silently substitute BLAKE2b and produce a wrong-key-derivation failure). Privacy T07-A4 fix-list item 3.

### Cross-references

- **ADR-0003 Invariant 4** — libsodium-only primitives; this amendment is the enforcement mechanism at the recovery-blob layer.
- **ADR-0003 Amendment F** — recovery-passphrase show-again accommodation; same module surface (`src/lib/recovery/`). Amendment G binds the cryptographic write path; Amendment F binds the reveal UX. They compose without conflict.
- **privacy-review-t07 §9 + T07-A4** — the source review verdict; the four fix-list items are split between this Amendment G (items 1, 3, the labelling assertion) and carry-forward G-T07-12 (production dep swap + boot-time assertion).
- **consolidated reviewer B1** — the source blocker.
- **carry-forward G-T07-12** — production `libsodium-wrappers-sumo` dep swap and boot-time assertion.

### Follow-ups (T07 + T07.1 acceptance amended — see ADR-0002 Amendment H below)

- [ ] **T07 acceptance amended** — implementer respin: write-time `crypto_pwhash` feature-test; canonical error message; test-harness override flag; lint assertion; restore-time mismatch detection. Tests 1–4 above land before the implementer touches the respun module.
- [ ] **T07.1 acceptance cross-referenced** — `libsodium-wrappers-sumo` dep swap; boot-time assertion; pnpm `lockfile-lint` rule (G-T07-12).
- [ ] **second-opinion-reviewer re-run** — confirms the fail-closed throw is the only path when `crypto_pwhash` is absent.
- [ ] **privacy-reviewer re-run** — confirms T07-A4 fix-list items 1 + 3 are addressed at the library layer; items 2 + 4 (boot-time assertion, `lockfile-lint`) deferred to T07.1 with explicit carry-forward.

---

# ADR-0002 Amendment H (2026-05-23, amendment pass #5): Sibling production-wire-up tasks (T05.1, T07.1, …) — library code ships in the parent task, `Supabase*Store` production wire-up ships in a numbered sibling before any deploy carrying real PI

**Amends ADR-0002** above (and the broader task-list posture established alongside ADR-0001 / ADR-0003). Trigger: privacy-review-t07 BLOCKING findings T07-1 / T07-2 / T07-3 (six new tables shipping without ADR-0016 schedule rows); consolidated reviewer blockers B2 / B3 / B6 / B7 / B8 (untested SQL, missing server-side authz/audit/cap-of-3 enforcement, missing schedule rows, `view_count` over-collection). Cross-references **ADR-0001** (the parent hosting + E2EE-as-load-bearing posture), **ADR-0003 Amendment G** (Argon2id fail-closed at the library layer — composable with this pattern), **ADR-0015** + **ADR-0016** (audit-log + operational-table retention schedules that gate any new physical table from landing in `main`), and **HG-15** (operational-table retention gate; bound to T05's tables historically and now to T07.1's tables prospectively).

### The pattern

Each library-shaped task in the plan (T05 auth core, T07 E2EE key core + recovery blob + committee key wrap + Amendment F, and any future analogous task) ships **only the library code** under its parent task number. The library code is exercised by tests against an **in-memory store** (`MemoryAuthStore`, `MemoryKeyStore`, …). The **production wire-up** — the `Supabase*Store` implementation that talks to the live Postgres schema, the SQL functions, the migrations that create the underlying tables, and the integration tests against a Supabase local stack — ships as a **numbered sibling task** (T05.1, T07.1, …) that runs **before any deploy carrying real PI**.

The pattern is binding on every future task whose acceptance includes both "library code with crypto / auth / privacy invariants" AND "Postgres tables / SQL functions / migrations that store or process the resulting PI."

### Why the pattern (the failure mode it prevents)

Reviewer history establishes that bundling library + production wire-up + schema + SQL functions + migrations into a single task produces:

1. **Reviewer overload.** Four parallel reviewers (security, second-opinion, privacy, threat-model) each find blockers on different surfaces; the consolidated blocker count exceeds what one implementer respin can address coherently. T07's eight blockers (B1–B8) are the worst-case demonstration.
2. **Schedule-gating drift.** ADR-0016's "every operational table touching PI MUST appear in this schedule before the table ships in any migration that lands in `main`" rule is structurally violated whenever a task's PR includes both the migration AND the schedule-row amendment; the order-of-operations becomes a reviewer dependency rather than a structural property.
3. **Test-coverage opacity.** Library tests against `MemoryStore` and integration tests against Supabase local stack measure different things; bundling them produces a single coverage number that masks gaps on either side.
4. **Irreversibility of half-shipped schemas.** A migration that lands in `main` is hard to retract (downstream tasks depend on it, ADR-0011 rolling-deploy posture assumes no backward-incompatible drops). Forcing the schema to land in a separate task with its own privacy + security review makes the retraction window explicit.

### The contract (binding on T05 / T05.1 retrospectively and on T07 / T07.1 in this pass; binding on all future library-shaped tasks prospectively)

For any task T_n whose acceptance includes "Postgres tables / SQL functions / migrations that store or process PI":

1. **T_n ships:** library code + `Memory*Store` implementation + library-layer tests (unit + property + fuzz where applicable) against `Memory*Store` + any TS-side invariants (e.g., ADR-0003 Amendment G fail-closed throw) + ADR amendments that bind the library-layer contract.
2. **T_n.1 ships:** `Supabase*Store` implementation + SQL functions + migrations + ADR-0016 schedule-row additions for any new operational tables + §PI inventory amendments + integration tests against a Supabase local stack + any SQL-side invariants (e.g., server-side cap-of-3 enforcement, server-side authz + audit emission) + HG-15 re-ratification when the new tables widen the operational-table schedule.
3. **T_n.1 runs before any deploy carrying real PI.** "Deploy carrying real PI" is defined as any deploy that creates `webauthn_credentials` rows for real users (post-T05.1), `identity_keys` rows (post-T07.1), `recovery_blobs` rows (post-T07.1), and any analogous future PI-bearing table.
4. **T_n's library code MAY use an injectable store interface that T_n.1 supplies the production implementation for.** The interface MUST NOT surface private key material on read APIs (per security-reviewer F5 carry-forward G-T07-10 for T07.1; the same posture binds future analogous tasks).
5. **T_n.1 carries its own four-way reviewer pass.** Privacy-reviewer re-runs against the new schema rows; security-reviewer + second-opinion-reviewer re-run against the SQL functions; threat-model cross-checks any new trust-boundary surface.

### Application to T05 / T05.1 (retrospective, formalizing the existing pattern)

T05 (auth core + auth migration) already shipped its `MemoryAuthStore` library code under its parent task number. ADR-0002 Amendment G (this file, lines ~2618–2763) folded the four T05-side blockers (B1–B4) into the auth ADR. The SQL migration + `SupabaseAuthStore` production wire-up was treated as a continuation of T05 historically. **In this Amendment H pass, the retrospective formalization is: T05's SQL migration + `SupabaseAuthStore` wire-up is the T05.1 sibling task**, even though it was not numbered T05.1 at the time. Future references to "T05.1" in this file and downstream refer to the auth-side production wire-up: `auth_totp_bootstraps`, `auth_totp_consumed_log`, `auth_sessions`, `webauthn_credentials`, `public.users` (auth side-table), and the `audit_emit` / `enroll_first_passkey` SQL functions.

### Application to T07 / T07.1 (this pass)

T07 (E2EE key core + recovery blob + committee key wrap + Amendment F) ships in this pass with library code only:

- `src/lib/recovery/` (recovery-blob encrypt + decrypt + show-again controller per Amendment F)
- `src/lib/identity/` (identity keypair generation + IndexedDB storage + recovery-blob round-trip)
- `src/lib/committee/` (committee-data-key wrap + unwrap + rotation orchestration at the library layer)
- `MemoryKeyStore` exercising all three modules; 41/41 tests passing
- ADR-0003 Amendment G fail-closed throw at the library layer

T07.1 (E2EE key core production wire-up) is the numbered sibling. T07.1 ships:

- `SupabaseKeyStore` against the live Postgres schema
- Migration creating `identity_keys`, `recovery_blobs`, `recovery_blob_resets`, `committee_data_keys`, `committee_key_wraps`, `committee_key_wraps_history` (six new tables)
- SQL functions `issue_recovery_blob_reset`, `record_recovery_blob_viewed`, `revoke_committee_member` (with the audit-row-emission-before-history-purge ordering per privacy review §4 + T07-A1), `rotate_committee_data_key` (with `pg_try_advisory_xact_lock` as the production source of truth for the rotation lock per Decision 3 of Amendment pass #5)
- ADR-0016 schedule rows for the six new tables (G-T07-4)
- §PI inventory amendments (~20 new rows; G-T07-5)
- Server-side cap-of-3 enforcement in `record_recovery_blob_viewed` (B3 / G-T07-7)
- Authz + audit emission in `issue_recovery_blob_reset` (B2 / G-T07-8)
- `libsodium-wrappers-sumo` dep swap + boot-time `crypto_pwhash` assertion + pnpm `lockfile-lint` (G-T07-12; the production half of ADR-0003 Amendment G)
- Server-issued nonce challenge for F-02 self-test (G-T07-9)
- KeyStore interface split — read interface MUST NOT surface `private_key` (G-T07-10)
- `identity_pubkey` relocation documentation: ADR-0002 Amendment G.3 addendum + test-harness query update + ADR-0003 Amendment A CI grep target update (G-T07-11)
- HG-15 re-ratification covering the six new tables

T07.1 runs before any deploy that creates `identity_keys` rows for real users.

### Reversibility

**Easy** on the task-numbering convention (renaming a numbered sibling is a plan-doc edit). **Hard** on the architectural posture: the four-reviewer overload + schedule-gating drift + test-coverage opacity + half-shipped-schema irreversibility that motivate the pattern do not go away if the pattern is abandoned. Future tasks of analogous shape must follow the pattern; deviation requires an explicit architect amendment.

### Compliance check additions

- [x] PIPEDA Principle 4.5 (Limiting Retention) — every new operational table goes through ADR-0016 schedule-row ratification in its T_n.1 sibling before landing in `main`; no schedule-gating drift.
- [x] PIPEDA Principle 4.7 (Safeguards) — server-side enforcement (cap-of-3, authz, audit emission) lands as part of the SQL function in T_n.1, with its own privacy + security review; not bundled with library tests that cannot exercise SQL invariants.
- [x] ADR-0016 hard rule "every operational table touching PI MUST appear in this schedule before the table ships in any migration that lands in `main`" — structurally enforced by the pattern (schedule rows are part of T_n.1's deliverable).
- [x] HG-15 — each T_n.1 sibling re-ratifies the schedule when it widens; the gate fires per-task rather than being amortized across multi-surface PRs.
- [x] No new third-party processor.
- [x] No new cross-border flow.

### Testable assertions (process-level, not code-level)

The pattern's adherence is verified at PR-review time, not in code-level tests:

1. **T07 PR (this pass) contains no SQL migration** in `supabase/migrations/`. PR-review-time assertion: `git diff --name-only main...T07-branch -- supabase/migrations/` returns empty (or contains only files that pre-existed T07).
2. **T07 PR contains no Postgres function definitions** in any migration file. PR-review-time assertion: a grep for `CREATE OR REPLACE FUNCTION` in T07-touched files in `supabase/migrations/` returns zero matches.
3. **T07 PR's library tests pass against `MemoryKeyStore`** with the 41-test count documented in the privacy-review-t07 source material.
4. **T07.1 PR (future) contains the six-table migration AND the ADR-0016 schedule rows AND the §PI inventory rows AND HG-15 re-ratification** in a single coherent privacy + security review pass.

### Cross-references

- **ADR-0001** — the parent hosting + E2EE-as-load-bearing posture; the four-reviewer overload risk this pattern mitigates is a function of how much PI surface lands per task, which is bounded by ADR-0001's "no third-party PI processor beyond Supabase" + ADR-0003's "server holds ciphertext only" combination.
- **ADR-0002 Amendment G** — the retrospective T05 / T05.1 split. Amendment H formalizes the pattern Amendment G already implicitly followed.
- **ADR-0003 Amendment G** — the Argon2id fail-closed contract at the library layer; composable with the pattern (T07's library code carries the throw; T07.1's production wire-up makes the throw unreachable via the dep swap).
- **ADR-0015** — per-event-type audit-log retention schedule; binding on any new event type a T_n.1 sibling introduces.
- **ADR-0016** — operational-table retention schedule; binding on any new physical table a T_n.1 sibling introduces. ADR-0016's hard rule on schedule-row presence pre-migration is the structural enforcement mechanism this pattern leans on.
- **HG-15** — the operational-table retention gate; fires per T_n.1 sibling.
- **privacy-review-t07 §12 + §14** — the source review that triggered this pass; the BLOCKING findings T07-1 / T07-2 / T07-3 are structurally closed by deferring the schema to T07.1.
- **consolidated reviewer B2 / B3 / B6 / B7 / B8** — the source blockers; structurally closed by the pattern (no SQL in T07 = no missing authz/audit, no missing cap-of-3, no untested SQL, no missing schedule rows, no `view_count` over-collection).

### Follow-ups (T07 + T07.1 + future task-list updates)

- [ ] **T07 acceptance amended** — library-only deliverable; 41/41 tests against `MemoryKeyStore`; ADR-0003 Amendment G fail-closed throw; per-`KeyStore` rotation lock (Decision 3, amendment pass #5); libsodium-only `generateRotationId` (Decision 4, amendment pass #5). No SQL migration in this PR. Implementer respin applies Decisions 2, 3, 4; four-way reviewer re-run verifies library-only posture.
- [ ] **T07.1 acceptance ratified (new task)** — see "Application to T07 / T07.1" above for the full deliverable list. Privacy-reviewer + security-reviewer + second-opinion-reviewer + threat-model cross-check all re-run on the T07.1 PR. HG-15 user re-ratification required.
- [ ] **Plan / task-list update** — the architect-coordinator / orchestrator folds the T05.1 + T07.1 naming convention into the canonical task list on its next pass. Future library-shaped tasks (TBD which) inherit the pattern at task-list-authoring time, not retrospectively.
- [ ] **observability-setup next pass** — no changes triggered by this Amendment H directly; the `identity_privkey.recovery_blob.viewed` event from ADR-0003 Amendment F lands its server-side audit emission in T07.1 (G-T07-7 / G-T07-8), at which point observability-setup verifies the integrity-checker + retention-job recognize it (ADR-0003 Amendment F follow-up item is preserved; no new observability work in amendment pass #5).
- [ ] **HG-15 — re-ratification posture** — Amendment pass #5 does NOT trigger HG-15 (no new operational tables ship in this pass). The next HG-15 fire is at T07.1 PR submission.

---

# ADR-0016: Operational-table retention schedule + HMAC pseudonymization standard for Postgres (HG-15)

**Status:** Accepted
**Date:** 2026-05-23
**Decider(s):** architect (amendment pass #4 per privacy-review-t05 §2.1 / §3 / §7 / §9 and consolidated security-reviewer blockers B1–B4); **HG-15 (NEW) — user ratification of (a) the operational-table retention schedule below and (b) the HMAC-SHA-256 + `app.hmac_pseudonym_key` GUC posture before T16 ships.**

**Source:** privacy-review-t05 §2.1 Findings 1+2 / §2.2 (24h retention) / §3 / §7 (PI inventory rows) / §8 cross-cuttings / §9 architect-amendment list (items 1, 3, 6); consolidated security-reviewer blockers B1 (HMAC-not-SHA), B2 (TOTP consumed-log documentation), B4 (drop plaintext `totp_code`); threat-model F-38 (TOTP code reuse-detection). Cross-references **ADR-0002** (passkeys + TOTP-enrollment bootstrap, the parent), **ADR-0002 Amendment G** (this pass; folds the four T05 auth-side-table decisions into the auth ADR), **ADR-0015** (audit-log per-event retention — this ADR is a sibling for *non-audit-log* operational tables), **observability/audit-log.md §2** (`actor_pseudonym = HMAC-BLAKE2b-256(uid)[:16hex]` — the canonical pseudonymization wording, which observability-setup updates on its next pass to permit HMAC-SHA-256 with `app.hmac_pseudonym_key`).

## Context

T05 (auth core + auth migration) introduced four classes of **operational, non-audit-log** Postgres tables that touch PI or PI-adjacent material:

- `auth_totp_bootstraps` — single-use TOTP bootstrap rows, 15-minute ceiling, hard-deleted on consume (F-43).
- `auth_totp_consumed_log` — F-38 reuse-detection log; persists past consume; **not previously documented**.
- `auth_sessions` — short-lived session rows + revocation history.
- `webauthn_credentials` — per-passkey credential rows.

ADR-0015 covers `audit_log` retention. It does **not** cover these tables. Without an explicit schedule for them, the retention job (T16) and the PI inventory have no source of truth, and the privacy-reviewer's PIPEDA Principle 4.5 "limited to purpose" defensibility cannot be asserted.

Separately, the T05 migration introduced **plain unkeyed `digest(X, 'sha256')`** as the pseudonymization primitive in four places (consumed-log code hash + cred_id pseudonym + session_id pseudonym + an `alert.fired`-shaped pseudonym). Plain SHA over a 10^6 TOTP space is brute-forceable in microseconds; plain SHA on credential / session IDs also breaks the cross-surface pseudonym equality property (audit_log ↔ structured log ↔ Sentry) because the TS-side pseudonymizer is already keyed-HMAC. This is the same Principle 4.7 (Safeguards) gap the privacy-reviewer named.

This ADR is the standard for both.

## Decision drivers

- **PIPEDA Principle 4.4 (Limiting Collection) + 4.5 (Limiting Use, Disclosure, Retention):** every operational table touching PI needs a documented purpose and retention.
- **PIPEDA Principle 4.7 (Safeguards):** pseudonymization must use a keyed primitive when the underlying value-space is brute-forceable (10^6 TOTP codes, but also any pseudonym whose collision space the adversary can enumerate offline).
- **Cross-surface pseudonym equality:** the same uid (or credential_id, or session_id) must produce the same pseudonym in `audit_log`, in structured logs, and in Sentry tags. This requires a shared HMAC key between the Postgres-side derivation and the TS-side derivation.
- **`observability/audit-log.md` §2:** the canonical wording today is "HMAC-BLAKE2b-256(uid)[:16hex]." The security property is provided by the keyed-HMAC; the specific hash is operationally fungible. PostgreSQL's `pgcrypto.hmac` is first-class for SHA-256 + SHA-512 + MD5 only; BLAKE2b-keyed in Postgres requires either `pgcrypto-blake2` (not bundled with Supabase) or a custom plpgsql wrapper. The TS-side library (`libsodium`) supports BLAKE2b natively.
- **Reversibility:** changing the hash function later is a one-time chain re-keying; changing the key-storage mechanism later is a deployment script change. Both are doable. Locking in a hash function the platform doesn't natively support is a constant ops tax.

## Options considered

### Option A: HMAC-BLAKE2b-256 in Postgres via custom function + `pgcrypto-blake2` ext (rejected for v1)

Supabase Cloud does not ship `pgcrypto-blake2`. A plpgsql wrapper is doable but adds a function in the security-critical path that has to be reviewed every release, and the test harness has to mirror it. The observability spec wording would be honoured verbatim, but at the cost of a non-standard function in the migration boundary.

### Option B: HMAC-SHA-256 in Postgres via `pgcrypto.hmac` (chosen)

Standard, well-understood, first-class in PostgreSQL. The security property of the pseudonymization is the **keyed HMAC**, not the choice of hash. SHA-256 collision resistance is more than adequate at the [:16hex] truncation length (effectively 64 bits — the truncation, not the hash, is the dominant collision floor). The observability spec wording at `observability/audit-log.md:131-138` is amended on the next observability-setup pass to read "HMAC-SHA-256 with `app.hmac_pseudonym_key` truncated to 16hex" (or to permit either function, with implementation choosing SHA-256). The architect does NOT modify `observability/*` per amendment-pass hard rules; the pointer is recorded here.

### Option C: Per-tenant key derived from a master (rejected for v1)

Single-tenant per ADR-0005. The complexity of a key hierarchy is unjustified. v2 multi-tenant work re-opens this.

### Key-storage sub-options (storing `HMAC_PSEUDONYM_KEY` for the Postgres side)

- **(a) Postgres GUC** via `current_setting('app.hmac_pseudonym_key')`, loaded by `ALTER DATABASE jhsc SET app.hmac_pseudonym_key = '...';` at deploy time. Read by `audit_emit` and any `SECURITY DEFINER` function that derives pseudonyms. **Chosen.**
- **(b) Supabase Vault** entry queried via `supabase_vault.decrypted_secrets`. Defensible, adds an extension dependency, query cost per derivation, and another surface to audit. Rejected for v1.
- **(c) Hardcoded in the SECURITY DEFINER function body.** Rejected up front (key is in source control; rotation requires a code change).

## Decision

**We choose Option B + key-storage sub-option (a).**

### The HMAC standard (binding for the Postgres side; applies to every migration in `supabase/migrations/`)

1. **Algorithm:** `pgcrypto.hmac(value, current_setting('app.hmac_pseudonym_key'), 'sha256')`. Truncate to 16 hex characters (`encode(...) :: text → substring(..., 1, 16)`) when matching the `actor_pseudonym varchar(16)` column shape per `observability/audit-log.md:130-133`.
2. **No bare `digest(..., 'sha256')` in any pseudonym derivation.** A semgrep rule (ratified in this pass; file added by migration-handler or implementer at `.semgrep/no-bare-sha256-in-migrations.yml`) bans the bare-`digest` pattern in `supabase/migrations/`. The rule MAY allow `digest()` in genuinely non-pseudonym contexts (checksums for content-addressable storage, for example); the pattern targets the pseudonym-assignment context (`= digest(`, `:= digest(`, `INSERT ... digest(`, returned-value-of-`digest()`-used-as-pseudonym). The implementer or migration-handler writes the file; this ADR ratifies the rule's existence and its scope.
3. **TS-side parity.** `apps/web/src/lib/log/safe-fields.ts` (and any other TS-side pseudonymizer) reads the same key from environment variable `HMAC_PSEUDONYM_KEY`. The deployment process is responsible for asserting `env.HMAC_PSEUDONYM_KEY === current_setting('app.hmac_pseudonym_key')`; a smoke test on boot (implementer respin) compares the SHA-of-the-key to a posted-from-Postgres SHA-of-the-key and refuses to start on mismatch. **The smoke test does NOT log the key.**
4. **Key rotation is out of scope for this ADR (still deferred per amendment pass #3 cross-cutting #3).** This ADR locks in the key-loading mechanism; the rotation cadence + era-encoding lands in a future ADR-0012 amendment per amendment pass #3.

### The operational-table retention schedule (binding; the canonical table for non-audit-log persistent tables touching PI)

| Table | Retention | Purpose | Hard-delete trigger | Classification ceiling |
|---|---|---|---|---|
| `auth_totp_bootstraps` | **15-minute ceiling**, hard-deleted on consume (F-43) | Single-use TOTP bootstrap for first-passkey enrollment per ADR-0002. | (a) consume (immediate, atomic with `enroll_first_passkey`); (b) 15-minute scheduled sweep for unconsumed rows. | C1 (user_id) + C2 (`secret_hash`). After this ADR's B4 decision, **no plaintext code column.** |
| `auth_totp_consumed_log` | **24 hours after `consumed_at`** | F-38 reuse-detection (block code re-submission within the ~15-min bootstrap lifetime + safety margin). | Scheduled sweep deletes rows where `consumed_at < now() - interval '24 hours'`. | C1 (user_id, HMAC-of-code, ts). |
| `auth_sessions` (active rows) | **15-minute TTL** on access tokens; row deleted when `revoked_at` is set OR `expires_at < now()`. | Session validation + revocation surface. | TTL expiry + explicit revoke. | C1 (user_id, session_id) + C2 (`device_label`, `device_fingerprint`). |
| `auth_sessions` (revoked rows) | **90 days after `revoked_at`** then hard-delete. | Revocation-history forensic window per ADR-0002 Operational Rules. | Scheduled sweep. | Same as above. |
| `webauthn_credentials` | **Until passkey revoked OR membership inactive + 24 months**, then hard-delete. | The passkey itself. Co-anchored to `committee_membership`. | Explicit `auth.passkey.revoked` event + 24mo membership-inactive grace. | C1 (cred_id, pubkey, aaguid, rp_id) + C0 (transports) + C2 (`device_label`). |
| `public.users` (auth side-table) | **Membership + 24 months** (per ADR-0002). | Identity attribution anchor; `active`/`role`/`totp_destroyed_at` lookup. | Tied to `committee_membership` retention. | See PI inventory. |

**Out of scope of this table:** `audit_log` (covered by ADR-0015); content tables `concerns` / `inspections` / `minutes` / `recommendations` / `reprisal_log` / `work_refusal` / `s51_evidence` / `training_records` (covered by plan §8 retention schedule).

### Operational rules (binding for the implementer + migration-handler)

1. **Every operational table touching PI MUST appear in this schedule before the table ships in any migration that lands in `main`.** A new table that does not appear in this schedule is a CI failure (drift assertion test-writer adds, mirroring ADR-0015 §3 drift check pattern).
2. **The retention sweep is a single nightly job (T16-owned) that walks the schedule.** It emits one `retention.deleted` summary row per pass per the ADR-0015 jsonb shape, with per-table counts added to the existing per-event-type counts in `meta.deleted_per_table`. T16 acceptance is extended (see Task-list amendments at end).
3. **`auth_totp_bootstraps` hard-delete on consume is atomic with the consume operation,** not a sweep responsibility. The sweep only collects orphaned/expired bootstraps.
4. **`webauthn_credentials.device_label` is user-provided** (per privacy-review-t05 §3.2). The implementer MUST NOT derive a default from User-Agent or any platform-derived signal. The migration's column comment carries this rule.

### Reversibility

**Easy** on schedule values (additive migration). **Medium** on the HMAC primitive choice (SHA-256 vs BLAKE2b is one column / one function rewrite + chain re-key — the security property is identical; only the names change). **Hard** on the *fact* of using a keyed HMAC at all (reverting to bare SHA is the privacy-reviewer's BLOCK finding; we won't).

## Consequences

### Positive

- Every persistent table touching PI has documented purpose, retention, and hard-delete trigger.
- The TOTP consumed-log is no longer undocumented; it is now a first-class entry under PIPEDA Principle 4.5 minimization.
- The pseudonymization primitive is keyed; brute-forcing the consumed-log requires the HMAC key (which lives only in the GUC + matching env var, both controlled by the deployer).
- Cross-surface pseudonym equality holds once TS-side + Postgres-side share the key.
- The semgrep rule is a structural backstop against future migrations regressing to bare `digest`.

### Negative / accepted tradeoffs

- One new GUC to manage in deployment (offset by avoiding a Vault dependency).
- `observability/audit-log.md` §2 wording is now slightly drifted (specifies BLAKE2b; we ship SHA-256). Resolved on observability-setup's next pass; architect-NOT-touch per hard rules.
- Key rotation is deferred (still amendment-pass #3 deferred item). A v1 key compromise requires a chain re-key + an audit pass; documented as a known operational risk on top of RA-2.

### Risks

- **Env-var ↔ GUC drift.** If the deployment sets `app.hmac_pseudonym_key` to value X and the app environment to value Y, pseudonyms generated on the two sides will not match — every cross-surface pseudonym join silently breaks. Mitigated by the boot smoke test (Decision §3 above).
- **Backup-restore + key rotation interaction.** If the key is rotated, a backup restored from before the rotation has pseudonyms in the old era. Re-derivation on restore is impractical (the underlying uid is in the row; the audit row's pseudonym would need to be re-stamped). Documented as a deferred concern for the key-rotation ADR amendment per amendment pass #3 cross-cutting #3.

## Compliance check

- [x] PIPEDA Principle 4.4 (Limiting Collection): every operational table has a documented purpose.
- [x] PIPEDA Principle 4.5 (Limiting Retention): every operational table has a documented retention.
- [x] PIPEDA Principle 4.7 (Safeguards): pseudonyms use a keyed HMAC; brute-forcing a 10^6 TOTP code space requires the key, not just the hash function.
- [x] PIPEDA Principle 4.9 (Individual Access): retention windows preserve a user's ability to query their own session / passkey history while membership is active.
- [x] `.context/constraints.md` data-residency: keys + tables remain in Supabase Cloud `ca-central-1`.
- [x] No new third-party processor.
- [x] No new cross-border flow.

## Cross-references

- **privacy-review-t05 §2.1 Findings 1 + 2** — the source of the HMAC-not-SHA decision and the documentation-of-`auth_totp_consumed_log` requirement.
- **privacy-review-t05 §2.2** — the 24h retention defensibility for the consumed log.
- **privacy-review-t05 §7** — the PI inventory amendment table; folded into §PI inventory in this pass.
- **privacy-review-t05 §9** — the architect-amendment pointer list; items 1, 3, 6 are closed by this ADR.
- **consolidated security-reviewer B1** — HMAC-vs-SHA + key-storage decisions.
- **consolidated security-reviewer B2** — operational-table documentation.
- **consolidated security-reviewer B4** — `auth_totp_bootstraps.totp_code` plaintext column (closed in ADR-0002 Amendment G; this ADR provides the broader frame).
- **threat-model F-38** — TOTP code reuse-detection; the consumed-log is the structural mitigation.
- **threat-model F-43** — TOTP bootstrap 15-min ceiling.
- **ADR-0002 Amendment G** (this pass) — folds the auth-side-table-specific decisions into the auth ADR; this ADR-0016 is the general standard.
- **ADR-0015** — the audit-log retention schedule; this ADR sits beside it for non-audit-log operational tables.
- **observability/audit-log.md §2** — `actor_pseudonym = HMAC-BLAKE2b-256(uid)[:16hex]`; observability-setup's next pass amends the wording to permit HMAC-SHA-256.

## Follow-ups

- [ ] **HG-15 user ratification (NEW)** — user signs off on (a) the operational-table retention schedule above and (b) the HMAC-SHA-256 + `app.hmac_pseudonym_key` GUC posture before T16 ships. The architect's recommendation is APPROVE both as proposed.
- [ ] **migration-handler respin (T05 migration):** replace every `digest(X, 'sha256')` used as a pseudonym with `hmac(X, current_setting('app.hmac_pseudonym_key'), 'sha256')`; add `ALTER DATABASE ... SET app.hmac_pseudonym_key` deployment step (or a `_setup_app_settings.sql` companion); drop `auth_totp_bootstraps.totp_code` column (B4); rewrite the unique constraint to `(user_id)`; rewrite `enroll_first_passkey`'s code comparison to `v_bootstrap.secret_hash = hmac(p_totp_code, current_setting('app.hmac_pseudonym_key'), 'sha256')`.
- [ ] **migration-handler respin (T05 migration) — cross-cutting #2 fold-in:** `audit_log.retention_class text NOT NULL` column added in T05 migration rather than backfilled in T18. Per privacy-review-t05 §8 observation #2 + architect recommendation in this pass.
- [ ] **migration-handler respin (T05 migration) — cross-cutting #4 fold-in:** `audit_emit(...)` function signature gains `p_request_id uuid` parameter and writes it to `audit_log.request_id`. Per privacy-review-t05 §8 observation #4 + `observability/audit-log.md:147-148`. Adding now is cheaper than rewriting every caller in T18.
- [ ] **migration-handler respin (T05 migration) — A5 fold-in:** SECURITY DEFINER functions get explicit `GRANT EXECUTE TO supabase_auth_admin` (or the chosen server role). Per security-reviewer A5.
- [ ] **implementer respin (T05 auth-core):** `apps/web/src/lib/log/safe-fields.ts` (and `apps/web/src/lib/auth/memory-store.ts` per A3) HMAC TOTP code the same way the SQL path does — uses `HMAC_PSEUDONYM_KEY` env var; mirrors prod. A boot-time smoke test compares SHA-of-key on TS side to SHA-of-key reported by Postgres; on mismatch, refuses to start (no key value logged).
- [ ] **implementer respin (T05 auth-core) — A4 fold-in:** TOTP-attempt enumeration differential collapsed to uniform 401 for the unauthenticated client; the differential reason (`410 GONE` vs `429 TOO MANY REQUESTS` vs `401 UNAUTHORIZED`) goes only to `audit_log.meta`. Per security-reviewer A4.
- [ ] **implementer respin (T05 auth-core) — A6 fold-in:** burst-alert emission deduplicated to one emission per crossing of the threshold (not one per evaluation). Per security-reviewer A6.
- [ ] **implementer respin (T05 auth-core) — A7 fold-in:** dead `revoked_at` arithmetic branch removed. Per security-reviewer A7.
- [ ] **Semgrep rule added** at `.semgrep/no-bare-sha256-in-migrations.yml` (architect ratifies; migration-handler or implementer writes the file). Pattern targets pseudonym-assignment use of `digest(..., 'sha256')` in `supabase/migrations/`; non-pseudonym uses of `digest()` (content checksums) are exempt.
- [ ] **observability-setup next pass** — amends `observability/audit-log.md §2` wording at lines 131-138 to permit HMAC-SHA-256 with `app.hmac_pseudonym_key` (the security property is the keyed HMAC, not the hash). Architect does NOT modify `observability/*` per hard rules.
- [ ] **test-writer** — adds drift-check tests (every persistent operational table touching PI appears in this schedule); HMAC-not-SHA semgrep coverage check; env-var-vs-GUC boot-smoke test; consumed-log 24h sweep test; per-table count fold-in to `retention.deleted` summary.

---

# ADR-0015: Per-event-type audit-log retention schedule (HG-14)

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** architect (amendment pass #3 per privacy-review Q2 APPROVED-WITH-CHANGES); **HG-14 — user ratification of the per-event-type schedule before T16 ships.**

**Source:** privacy-review §3.1 / §3.3 / §3.4 / §3.5 / §7 (test obligations 7–11); threat-model F-51 / F-52 / O-14 (cross-reference); supersedes the uniform 24-month posture previously documented in `observability/README.md` §1 (which is corrected by observability-setup on its next pass — architect does NOT edit `observability/*` per amendment pass #3 hard rules).

## Context

The audit log was specified at a uniform 24-month retention in `observability/README.md` §1, with the reasoning "PIPEDA s.10.1 breach-record floor." Privacy-review Q2 confirmed that 24 months is **defensible at the PIPEDA Principle 4.5 floor but not minimized** and is **incoherent with the underlying records' retention** (concerns at 7y post-closure, reprisal_log at active matter + 7y, etc.).

The privacy-reviewer's APPROVED-WITH-CHANGES verdict on Q2 blocks T16 (retention job) until:
1. A per-event-type retention schedule is ratified.
2. The "audit row cannot outlive linked record" ceiling rule is encoded.
3. User ratifies the schedule (HG-14, formerly HG-9 in the wider plan; HG-9 remains the high-level retention sign-off for plan §8 / §13.D, of which this is a part).
4. `observability/audit-log.md` §3 and `observability/README.md` §1 are updated to match (downstream task for observability-setup; architect records the pointer here).

This ADR ratifies the schedule.

## Decision drivers

- **PIPEDA Principle 4.5 (Limiting Use, Disclosure, Retention) — 4.5.2, 4.5.3:** retain "only as long as necessary for the fulfilment of those purposes." Per-event purposes diverge by 2+ orders of magnitude (an auth-event purpose decays in ~90 days; a key-rotation event's forensic purpose runs for the duration of any record encrypted under the rotated key).
- **PIPEDA Principle 4.9 (Individual Access):** a user has the right to know what was done with their data; the audit row covering an underlying record must remain queryable as long as the underlying record lives.
- **OHSA s.50 + Ontario Labour Relations Board:** reprisal complaints to the OLRB are governed by an effectively-7y limitation profile (active matter + 7y per plan §8); the audit-of-creation row for `reprisal.created` must not age out before the underlying entry.
- **PIPEDA s.10.1 breach-record floor (24 months):** retains as the floor for `alert.fired` (alert events feed breach response) — not the ceiling for the audit log in general.
- **`.context/constraints.md` audit-log floor:** "at least 1 year." Every value in the schedule below meets or exceeds this.
- **Crypto-shred-on-retention coherence with backups (ADR-0012 / HG-8):** old encrypted backups (35-day rolling, hard-deleted at 42d per ADR-0012 amendment) cannot leave "events we cannot explain" if the longest audit-log event retention is bounded — see ADR-0012 cross-reference below.

## Options considered

### Option A: Uniform 24-month retention (status quo — rejected)

The pre-amendment posture. Defensible at the floor but not minimized. Treats `auth.passkey.enrolled` (low-sensitivity, short-purpose) the same as `committee_data_key.member_revoked` (high-value forensic anchor). Creates the Principle 4.9 gap where a 7y underlying record's audit row ages out at 24mo.

### Option B: Per-event-type retention schedule, schedule-table-driven, with underlying-record-ceiling rule (chosen)

Each enum value in `audit_log.event_type` is mapped to a retention interval. The retention job reads the schedule from a `audit_log_retention_schedule` table (version-controlled migration; one row per enum value). The underlying-record-ceiling rule per §3.5 caps audit rows linked via `target_id` at the linked record's retention + 30 days.

### Option C: Match every audit row to its linked record's retention (rejected)

Simplest rule, but loses the per-event-type forensic floor — e.g., `committee_data_key.member_revoked` has no `target_id` link to a single record; it's a key-history anchor whose forensic value persists regardless of what record it relates to.

## Decision

**We choose Option B.**

### The schedule (verbatim from privacy-review §3.3; the authoritative table)

| Event type | Retention | PIPEDA 4.5 justification |
|---|---|---|
| `identity_keypair.created` | **7 years** (membership + 7y) | Co-anchored to forensic identity attribution. If a reprisal entry is challenged in OLRB years later, the question "did this user even hold an identity key at the time?" must be answerable for the lifetime of the C4 records they could have authored. |
| `identity_privkey.recovery_blob.written` | **Membership + 24 months** | F-08 brute-force anchor; supports access-by-user investigation. Aligns with the recovery blob's own retention. |
| `identity_privkey.recovery_blob.restored` | **Membership + 24 months** | Same as above; restoration is a candidate-coercion signal (T6, T11) but loses forensic value once membership ends. |
| `identity_privkey.recovery_blob.viewed` | **Membership + 24 months** | F-54 / M-54b — recovery-passphrase "show again" reveal event. Forensic value tracks the same window as `recovery_blob.written` since each reveal is an enrollment-session-bounded action; loses value when the user's membership ends. Added in this pass per ADR-0003 Amendment F. |
| `committee_data_key.wrapped_for_member` | **7 years from rotation** | Key-history forensic anchor. If a removed-member-decrypted-old-data incident surfaces (F-06 / O-2), the wrap-history must be reconstructable for at least the active-matter + civil-limitation period. |
| `committee_data_key.unwrap` | **24 months** | Read-of-own-wrap; high-volume, low-target-individuating. 24 months is enough to spot misuse patterns. |
| `committee_data_key.rotation.started` / `.completed` | **7 years** | The rotation lifecycle is the load-bearing forward-secrecy event (Invariant 6); must outlive every record encrypted under the old key. Anchors crypto-shred-on-retention claims (ADR-0012 cross-reference). |
| `committee_data_key.member_revoked` | **7 years** | Same as rotation; the revocation is a corner-stone forensic fact. |
| `auth.passkey.enrolled` / `.revoked` | **90 days** | Auth events are operationally useful for ~90 days for misuse investigation; longer retention does not serve the purpose. |
| `session.revoked` | **90 days** | Same as above. |
| `concern.created` | **Match underlying concern record (7y post-closure)** | The concern is C3; the audit row for its creation should not outlive the concern. The reverse (audit gone, concern still present) breaks Principle 4.9. |
| `concern.source_revealed` | **Match underlying concern record (7y post-closure)** | C4-adjacent (the reveal of source is the event that surfaces C4). |
| `inspection.synced` | **Match underlying inspection (7y)** | Inspections are 7y per plan §8. |
| `queue.integrity_fail` | **Match underlying inspection (7y)** | Same. (Canonical name per ADR-0010 F-B; alias `inspection.synced.hmac_fail` is forbidden.) |
| `recommendation.created` / `recommendation.employer_response_logged` | **Match underlying recommendation (7y)** | Recommendations are 7y per plan §8. |
| `reprisal.created` | **Match underlying record (Active matter + 7y)** | C4. The audit-of-creation must match the entry while the entry lives. Subject to Amendment D pseudonymization in the visible feed. |
| `reprisal.read` | **Match underlying record (Active matter + 7y)** | Server-emitted under ADR-0003 Amendment B / HG-6. |
| `reprisal.status_changed.4eyes_pending` / `.4eyes_completed` | **Match underlying record (Active matter + 7y)** | 4-eyes-on-soft-delete events per HG-7; Principle 4.9 traceability requires they outlive nothing the underlying record outlives. |
| `work_refusal.*` / `s51_evidence.*` (T14 enumerations) | **Match underlying record (Active matter + 7y)** | C4; same justification. Includes the `work_refusal.read` / `s51_evidence.read` enums added by ADR-0003 Amendment A extension. |
| `export.generated` | **7 years** | OHSA s.9(20) recommendations and s.9(21) minutes are 7y. The export is the only B3 egress; the audit of that must persist as long as the record being exported. |
| `export.contained_concern_derived_items` | **7 years** | RA-1 compensating control; same justification. |
| `retention.deleted` | **7 years** (independent; **carve-out — no `target_id` link**) | F-52 anchor. The retention summary must outlive the records it describes by enough margin to defend against "did the deletion actually happen?" challenges. **Exempt from the underlying-record-ceiling rule** in §3.5 because it has no `target_id`. |
| `member.added` / `.removed` | **Membership + 7 years** | Membership history is an OHSA accountability anchor; outlives membership for the same reasons as `identity_keypair.created`. |
| `committee.key_rotated` | **7 years** | Same as `committee_data_key.rotation.completed`. |
| `client.cache_policy_violation` | **90 days** | Operational-defense event; SW policy regression detector. Forensic value decays fast. |
| `client.identity_selftest_fail` | **90 days** | F-03 detection signal; investigation-window-bound. |
| `alert.fired` | **24 months** | Matches the PIPEDA s.10.1 breach-record floor since alerts often precede or accompany breach analysis. |
| `audit.forensic_reveal.4eyes_pending` / `.4eyes_completed` | **7 years** | Forensic-reveal audit events (Amendment E) gate post-incident attribution; same forensic profile as `committee_data_key.rotation.completed`. Added in this pass per ADR-0003 Amendment E. |

### The underlying-record-ceiling rule (verbatim from privacy-review §3.5)

**Audit-log rows linked via `target_id` to a record in another table MUST NOT outlive the linked record by more than 30 days.** The retention pass deletes orphaned audit rows within 30 days of the linked record's deletion. This is a Principle 4.5 **ceiling**, not a floor — the per-event-type schedule above gives the floor for each event type, and the ceiling caps any audit row whose linked record is gone.

**Carve-out:** `retention.deleted` summary rows are independently retained at 7 years (no `target_id`).

### Schema requirements

1. **`audit_log.retention_class text NOT NULL`** column, populated by the `audit_emit` `SECURITY DEFINER` function at write time. Value is keyed off `event_type` against the schedule table. **CHECK constraint** references the schedule table (or the closed enum; final form chosen by migration-handler in T16). Adding `retention_class` now is cheap; adding it after rows exist requires backfill. Per privacy-review §4 cross-cutting observation #1.
2. **`audit_log_retention_schedule` table** — one row per `event_type` enum value with `retention_interval` (e.g., interval, "membership + 7y" encoded as a small structured value, or "match_target" + the target table reference). Version-controlled migration.
3. **CI drift assertion** — every value in the `event_type` CHECK constraint has exactly one row in `audit_log_retention_schedule`; every row in the schedule table references a value in the enum. Drift fails CI. Per privacy-review §3.4.
4. **`retention.deleted` jsonb shape** — `meta.deleted_per_table.audit_log_per_event_type` is a jsonb of `{event_type: count}` per pass (replaces the prior single-count shape). Per privacy-review §3.4.

### Retention job behaviour (T16, amended in this pass)

The single `WHERE ts < now() - interval '24 months'` filter (`observability/audit-log.md` §3) is replaced by an `event_type`-keyed retention function reading the schedule. The function applies the per-event floor; then applies the underlying-record-ceiling rule (any audit row whose `target_id`'s linked record has been deleted for >30 days is queued for deletion on the next pass).

The retention pass continues to emit exactly one `retention.deleted` summary row per pass (F-52).

### Reversibility

**Easy** on schedule values (one row per enum value in a migrated table; changes are additive migrations). **Hard** to reverse the schema additions (`retention_class` column, schedule table); these are part of the chain-of-custody story and are non-negotiable once data is in the table.

## Consequences

### Positive

- Each event type's retention is minimized to its actual forensic purpose (Principle 4.5).
- Principle 4.9 traceability holds: audit rows live as long as the underlying record they describe.
- Crypto-shred-on-retention is coherent: ADR-0012's 42-day backup hard-delete cannot leave audit events "we cannot explain" because no audit-log event type outlives the longest backup-retained content (see ADR-0012 cross-reference).
- Schedule is data-driven (version-controlled migration), not code-driven (one constant in a function). Drift is structurally caught.

### Negative / accepted tradeoffs

- More complex retention job than a single timestamp filter.
- Backfill required on `retention_class` column if any audit rows already exist at the time of T16 migration (no rows at amendment time; mitigated by ordering — schedule lands before T18 first writes).

### Risks

- A new event type added to the enum without a corresponding schedule row would either fail CI (if drift check holds) or default to an unintended retention (if drift check is bypassed). Mitigated by the drift check and the test-writer's coverage assertion per privacy-review §7 test obligation 10.
- Backup-restore window vs schedule rules: a restore from a 35-day-old backup (ADR-0012) brings back audit rows that the live schedule may have already aged out. The retention job's next pass cleans them up; transient inconsistency is acceptable.

## Compliance check

- [x] PIPEDA Principle 4.5 (Limiting Retention): minimized per event type.
- [x] PIPEDA Principle 4.9 (Individual Access): audit rows live as long as underlying records.
- [x] PIPEDA s.10.1: 24-month breach-record floor preserved for `alert.fired`.
- [x] `.context/constraints.md` "at least 1 year" audit-log floor: every entry meets or exceeds.
- [x] OHSA s.50 / OLRB limitation profile: C4 audit retentions match record retention.
- [x] No new third-party processor.
- [x] No new cross-border flow.
- [x] Coherent with ADR-0012 crypto-shred-on-retention (cross-reference added to ADR-0012 in this pass).

## Cross-references

- **privacy-review §3.1 / §3.3 / §3.4 / §3.5 / §7** — the source review; the §3.3 table is reproduced here verbatim.
- **ADR-0003 Amendment A** — closed enum of `event_type` values; this ADR adds retention metadata to each.
- **ADR-0003 Amendment A extension** — `work_refusal.read` / `s51_evidence.read` enum values (T14 / HG-6 mirror).
- **ADR-0003 Amendment D** — `audit.forensic_reveal.4eyes_pending` / `.4eyes_completed` enum values (7y retention; added in this pass).
- **ADR-0003 Amendment F** — `identity_privkey.recovery_blob.viewed` enum value (membership + 24mo; added in this pass).
- **ADR-0012 amendment** — backup hard-delete at 42 days; crypto-shred-on-retention coherence note added in this pass.
- **`observability/README.md` §1** — currently records "24 months" with a reasoning text that **mis-attributes** the 24mo to PIPEDA s.10.1 audit-log floor (privacy-review §4 cross-cutting observation #4). The reasoning is wrong; PIPEDA s.10.1's 24-month floor is for **breach records** specifically, not audit logs in general. The architect does NOT edit `observability/*` per amendment pass #3 hard rules; **observability-setup on its next pass corrects the reasoning text** to "matched to the breach-record retention because audit log feeds the breach-response process, not because PIPEDA s.10.1 requires 24mo for audit logs."
- **`observability/audit-log.md` §3** — single 24mo filter; observability-setup next pass replaces with a pointer to the schedule table.

## Follow-ups (T16 acceptance amended — see Task-list amendments at end)

- [ ] **T16 acceptance amended** — per-event-type retention; `retention_class` column; schedule table; underlying-record-ceiling rule; `retention.deleted` jsonb shape per privacy-review §3.4 / §3.5.
- [x] **HG-14 — user ratification RATIFIED 2026-05-22 (orchestrator-recorded)** of the per-event schedule as-proposed. The user accepted the privacy-reviewer's per-event-type table verbatim (90d for auth events; 24mo for committee_data_key.unwrap / alert.fired; 7y for rotation/revocation/exports/retention.deleted; match-underlying-record for content events; underlying-record-ceiling rule with 30-day buffer). No per-row changes. T16 implementation is unblocked from HG-14 (other gates apply).
- [ ] **observability-setup next pass:** corrects `observability/README.md` §1 reasoning text (cross-cutting observation #4) and replaces `observability/audit-log.md` §3 single-filter spec with a pointer to the schedule table.
- [ ] **Test-writer (test obligations 7–11 from privacy-review §7):** per-event retention schedule honored; audit-row-cannot-outlive-target rule; `retention.deleted` summary row retention at 7y; schedule-table-vs-enum drift CI assertion; `retention.deleted` per-event-type counts in the summary row's jsonb.

---

# ADR-0014: Offline queue HMAC integrity for IndexedDB inspection queue

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** architect (amendment pass per HG-4), user (approved)

**Threat-model trigger:** F-44 (IndexedDB inspection queue tampered to inject false photos / notes) / O-11 / HG-4.

## Context

T10 (inspections offline + sync) queues inspection entries — checklist items, notes, and encrypted photos — into IndexedDB while signal is unavailable. The encryption pipeline (per ADR-0003) sealing entries to the committee public key protects confidentiality, but it does **not** establish authorship: an attacker with local device access (malicious extension, transient physical access, T2 employer-device residual) can write a forged inspection row into the queue. On sync, the row uploads as if authored by the authenticated session — because the only check on the wire is the JWT, and the JWT belongs to the legitimate user.

F-44 surfaces this as Medium residual. The fix is integrity-on-the-queue: tag every queued entry with a MAC keyed by a per-user device-bound secret, and verify on sync.

## Decision drivers

- Prevent a local attacker from injecting attacker-controlled plaintext that becomes "the inspector's note."
- HMAC key must NEVER leave the device — escrowing it server-side defeats the point.
- Use the libsodium primitives already in the stack (ADR-0003 Invariant 4); no new crypto library.
- Mismatch must fail closed: rejected entry, audit row, user notification — not silent drop.
- Verifiable deterministically in tests.

## Options considered

### Option A: Per-entry HMAC keyed by HKDF off the user's identity private key (chosen)

**Description:**
- At session start (after the identity-key self-test passes per F-03), derive a session-scoped HMAC key:
  `K_hmac = HKDF-BLAKE2b(salt = "jhsc.queue.hmac.v1", ikm = identity_privkey, info = user_id || device_id)`.
- For each queued entry, compute `tag = BLAKE2b-256-keyed(K_hmac, sequence_number || user_id || ciphertext)`.
- Store `{ciphertext, sequence_number, user_id, tag}` in IndexedDB; `K_hmac` lives only in memory.
- On sync, server reads `tag` and the wire payload, recomputes via a server-side verification path: the server cannot recompute `K_hmac` (it's derived from a private key the server never sees), so the server's role is **forwarder + recorder**, while the client posts the tag alongside the JWT and the server records the verification outcome.
- Actual MAC verification happens client-side BEFORE the entry is shipped: the queue-drain step recomputes the tag from the in-memory K_hmac and the stored ciphertext, asserts equality, and only then POSTs. A mismatch fails closed.
- Optional second verifier: the server stores the tag alongside the row; on subsequent client reads, the same client can re-verify the tag matches the ciphertext it now sees back from the server — detecting in-transit/at-rest tampering as well.
- Algorithm: **BLAKE2b-256 keyed** (`libsodium.crypto_generichash` with `key` parameter). Already in the stack via libsodium-wrappers (ADR-0003 Invariant 4).

**Pros:**
- Key never leaves the device; T1/T5 reach to plaintext still requires breaking E2EE *and* the HMAC chain.
- Uses libsodium primitives we already trust.
- Deterministic, testable in CI.
- Detects both injection (local attacker writes a forged row) and replay-from-another-device (copy queue from device B to device A — user_id mismatch fails).

**Cons:**
- If identity_privkey is unavailable at queue-drain time (lock screen, expired session), the queued entry cannot be verified and the user must re-auth to sync. Acceptable; matches the rest of the session model.
- Server cannot itself verify the MAC; it relies on the client's verification + records the tag for downstream re-verification. This is acceptable because the threat is local device tampering, which is fundamentally a client-side detection problem.

### Option B: Signed-by-identity-key per entry (Ed25519 signature)

**Description:** Sign each queued entry with the identity private key directly (Ed25519). Server holds identity public key; verifies signature on sync.

**Pros:**
- Server-side verification possible.
- Stronger non-repudiation.

**Cons:**
- Mixes signing key with sealing key — identity privkey already does too much (sealing C3, unwrapping committee key); adding signing widens the blast radius of a privkey compromise.
- Slower per-entry; signing in the offline hot path on a shop-floor Android is noticeable.
- Adds an Ed25519 keypair to the user model OR forces dual-use of X25519, which libsodium handles but is a footgun.

### Option C: No MAC; rely on JWT only

**Description:** Status quo. Trust the JWT for authorship.

**Cons:**
- Exactly the F-44 finding. Local attacker injects rows; JWT proves the user was logged in, not that the user authored the entry.

## Decision

**We choose Option A.**

### Rationale

The threat is local device tampering; client-side verification is the right place to catch it. Option B over-loads the identity privkey for marginal gain. Option C is the finding.

**Operational rules:**
- HMAC algorithm: `libsodium.crypto_generichash` (BLAKE2b-256) with the `key` parameter set to `K_hmac` (32 bytes).
- HKDF construction: `K_hmac = crypto_generichash(key = identity_privkey, msg = user_id_bytes || device_id_bytes, outlen = 32, personalisation = "jhsc.queue.hmac.v1")` — single-step KDF using BLAKE2b's keyed mode is acceptable (libsodium pattern; the same pattern libsodium uses internally for sub-keys).
- HMAC scope: `(sequence_number_u64_be || user_id_uuid_bytes || ciphertext)`. The sequence number prevents reordering; user_id prevents cross-device replay.
- Verification step: in-memory recomputation before drain; mismatch → entry quarantined to a `rejected_queue_entries` IndexedDB object store + audit-log POST `{action: 'queue.integrity_fail', sequence_number, user_id}` on next online + user notification banner.
- The server stores the tag alongside the row (column `client_integrity_tag BYTEA`); client can re-verify on read.

### Reversibility

**Medium.** Removing HMAC later is trivial (don't write the column). Migrating to a different MAC algorithm (Option B) is a queue-drain + re-derive job; not painful at our scale.

## Consequences

### Positive
- Local-tampering injection detected before it pollutes the inspection record.
- No new key material to manage (derived from existing identity key).
- Same crypto library; no new dependency.

### Negative / accepted tradeoffs
- Cannot verify server-side; the server is a recorder, not a judge. Acceptable; the threat is local.
- A user who restores from device backup AND has a wrong device_id will see queue entries fail integrity. Acceptable: prompt re-enter.

### Risks
- HKDF parameter accident (wrong personalisation string) makes verification non-deterministic across versions. Mitigated by versioning the salt (`jhsc.queue.hmac.v1`) and refusing to verify entries tagged with an unknown version.

## Compliance check

- [x] No new third-party processor.
- [x] No new cross-border flow.
- [x] Uses libsodium-only primitives per ADR-0003 Invariant 4.
- [x] Audit-log entries for integrity failures aligned with §6 Invariant 8.

## Follow-ups

- [ ] **T10 acceptance amended** — HMAC integrity tests added (see Task-list amendments below).
- [ ] Test-writer: deterministic-tamper test — corrupt a byte in `ciphertext`; assert verification fails before POST; assert `queue.integrity_fail` audit row queued for next online; assert user banner shown.
- [ ] Test-writer: cross-device-replay test — copy a queue entry from device B's IndexedDB to device A; on device A drain, assert user_id mismatch fails verification.
- [ ] Schema migration: add `client_integrity_tag BYTEA NOT NULL` to `inspections` queue-bound columns.

---

# ADR-0013: Service-worker plaintext-cache allowlist (PWA on-device cache policy)

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** architect (amendment pass per HG-3), user (approved)

**Threat-model trigger:** F-10 (Service worker caches plaintext responses for offline) / O-10 / HG-3.

## Context

SvelteKit's service worker can be configured to cache responses for offline use. Without an explicit policy, default routing rules may cache decrypted API responses, leaving plaintext sensitive content on disk in the browser's Cache Storage — readable on T2 (employer-owned device) or T6 (theft) without re-auth. The architect's prior note in the system design ("no plaintext caching server-side") is silent on **client-side service-worker caches**. F-10 raises this as a Medium gap.

This ADR specifies exactly what the PWA service worker is allowed to cache in plaintext on the device, what it must hold only as ciphertext, and what it must NEVER cache.

## Decision drivers

- T2 / T6 risk: anything in Cache Storage is at-rest on the device with no re-auth gate.
- Offline UX still needs to work — static assets and operational metadata must be cacheable.
- The architect's E2EE invariants (ADR-0003) constrain C3/C4 to never leave the browser RAM in plaintext between sessions.
- Detection by snapshot in CI is feasible (Cache Storage is enumerable from a test harness).

## Decision

**Service-worker cache policy is a strict allowlist, by data classification:**

| Asset class | Cache plaintext? | Strategy | Notes |
|---|---|---|---|
| **Static assets** (HTML shell, JS bundles, CSS, fonts, web manifest, icons) | **YES** | Cache-first; versioned by build hash | App shell PWA pattern. No PI. |
| **C0 public content** (document library: OHSA quick-ref text, i18n catalogs) | **YES** | Stale-while-revalidate | Public regulatory text; nothing to protect. |
| **C1 operational metadata** (feature flags, schema version, route map, locale list) | **YES, time-bound** | Cache with `max-age=86400` (24h max) then revalidate | Bounded; no PI. |
| **C2 worker-side PI** (display name, off-employer contact) | **NEVER plaintext** | Not cached by service worker. If retained at all on-device, only inside the encrypted IndexedDB layer keyed by the session/passkey wrap. | Worker-side identifying data must not survive in Cache Storage. |
| **C3 sensitive worker content** (concerns body, minutes, inspections, recommendations) | **NEVER plaintext** | Not cached by service worker. Ciphertext payloads MAY appear in IndexedDB queues (per T10) but never in Cache Storage. | E2EE confined to browser RAM and ciphertext-only IndexedDB. |
| **C4 highest sensitivity** (reprisal_log, work_refusal, s51_evidence, source_name) | **NEVER, period** | Not cached by service worker. Not in IndexedDB at all except as transient, session-scoped ciphertext for an open record; cleared on lock/logout/panic. | If anything looking like a C4 response slips into the SW fetch handler, the handler rejects (sanity check; defense in depth). |

**Service-worker fetch-handler rules (enforced in code):**

1. The service worker's cache routing is a **closed allowlist** of URL patterns: `/`, `/index.html`, `/_app/**` (build output), `/favicon.*`, `/manifest.webmanifest`, `/locales/*.json`, `/library/*` (C0), `/feature-flags` (with 24h max-age), `/schema-version`.
2. ANY response from `/api/**` is **not cached** by the service worker. Period.
3. **Sanity check on responses:** the fetch handler inspects response headers for `X-Data-Class: C3` or `X-Data-Class: C4`. If present, the response is forwarded to the page but NOT placed in any cache. If a future bug routes such a response through a cacheable handler, the sanity check rejects it (logged as `client.cache_policy_violation` for audit-on-next-online).
4. **On lock / logout / panic-wipe:** all caches whose names are not in the static-asset allowlist are deleted; IndexedDB session-scoped stores cleared.
5. **Service-worker version bump invalidates everything**: a build-hash mismatch forces a full cache rebuild (no stale C0/C1 carrying over silently).

## Options considered

### Option A: Strict allowlist as specified above (chosen)

**Pros:**
- Snapshot-testable: a CI fixture installs the SW in a clean Cache Storage, hits a known set of routes, then enumerates Cache Storage and compares to a frozen JSON snapshot.
- Defense in depth: the `X-Data-Class` header check catches accidental cacheable C3/C4 responses even if the URL allowlist is wrong.
- Aligns with ADR-0011 (PWA-only) and ADR-0008 (session hygiene).

**Cons:**
- Slightly more verbose service-worker code than a "cache everything" default.
- One more thing for the implementer to get right (mitigated by the snapshot test).

### Option B: Default cache + per-route opt-out

**Description:** Cache everything by default; mark specific routes as "no-store" via a `Cache-Control` header.

**Cons:**
- Inverts the safe default. A missing header = leaked plaintext. The whole point of the threat model is fail-closed.

### Option C: No service-worker caching at all

**Description:** Disable the cache; no offline UX beyond what IndexedDB provides.

**Cons:**
- Breaks offline-first inspection workflow (T10).
- The app shell can't load offline either; users on shop-floor signal-gaps see "no internet" pages.

## Decision

**We choose Option A.**

### Reversibility

**Easy.** Service-worker code is a single module; policy is a single allowlist constant. Changing the allowlist is a one-PR change with an updated snapshot test.

## Consequences

### Positive
- Plaintext C2/C3/C4 cannot persist in Cache Storage by construction.
- T2 / T6 attacker reading Cache Storage offline sees only static assets + C0/C1 (already public or non-sensitive).
- Snapshot test makes regression a CI failure, not a runtime surprise.

### Negative / accepted tradeoffs
- A new C0/C1 route added later that the dev forgets to allowlist won't be cached — slower first-load but not a leak. Safe direction.

### Risks
- A future PR adds a route to the allowlist that returns C2+ content. Mitigated by:
  - Reviewer (security-reviewer) checks every SW-allowlist diff.
  - The `X-Data-Class` header sanity check catches the response even if the URL was mis-allowlisted.
  - The snapshot test rejects unexpected cache entries unless the snapshot is also updated (forcing reviewer attention).

## Compliance check

- [x] No new third-party processor.
- [x] No PI in Cache Storage by construction.
- [x] Consistent with ADR-0003 (E2EE), ADR-0008 (session hygiene), ADR-0011 (PWA).

## Follow-ups

- [ ] **T10 acceptance amended** (or new T20 sub-task — see Task-list amendments below) — service-worker policy + snapshot test.
- [ ] Server emits `X-Data-Class: <class>` header on responses returning rows from `concerns`, `reprisal_log`, `work_refusal`, `s51_evidence`, `minutes.final`, `recommendations` so the SW sanity check has signal. C0/C1 routes can omit the header (no signal = no rejection).
- [ ] Implementer: SW snapshot fixture in `apps/web/test/sw-cache.snapshot.test.ts` — install SW in a cold cache, run a scripted login + visit, enumerate Cache Storage, assert exact match.

---

# ADR-0012: Backup strategy and recovery-testing cadence

**Status:** Accepted — **Amended 2026-05-22 (HG-8)**
**Date:** 2026-05-22 (original); amendment 2026-05-22
**Decider(s):** architect (ratifying), user (locked in plan §7); amendment per HG-8, user-approved

**Amendment note (2026-05-22, HG-8):** see "Amendment: Object Lock + versioning + lifecycle hard-delete" block at the end of this ADR. Threat-model trigger: F-49 / O-15. Original ADR text unchanged; the amendment adds operational rules.

## Context

C3/C4 data is E2EE — the server holds ciphertext. A "complete backup" of the
Supabase project is therefore also a ciphertext blob, useless without the
client-side keys. The hard problem isn't binary durability of the bytes; it's
**key durability** (committee data key + per-user identity keys) and the
ability to restore a working committee state after an outage, ransomware
event, or accidental schema migration.

PIPEDA Principle 7 (Safeguards) and constraints.md require encrypted backups
and a documented restore path. Plan §7 requires recovery to be tested per
`playbooks/backup-restore.md`.

## Decision drivers

- Backups must remain in Canada (PI residency).
- Ciphertext-only at rest, including in backups.
- Recovery must cover three distinct failure shapes: (1) Supabase project
  loss, (2) committee data key loss, (3) individual user identity-key loss.
- Restore must be tested, not just configured.
- Single-tenant, ~50 users — exotic DR (multi-region active-active) is
  unjustified.

## Options considered

### Option A: Supabase PITR (Pro tier) only

**Description:** Use Supabase's built-in Point-In-Time Recovery (7-day window
on Pro, configurable up to 28 days), no second copy.

**Pros:**
- Zero ops; covered by the platform.
- Inside `ca-central-1`.

**Cons:**
- Single-vendor durability story. If the Supabase project is destroyed
  (account compromise, billing lapse, vendor incident), PITR doesn't help.
- No protection against a malicious or buggy migration that gets PITR'd
  forward then ages out.

### Option B: Supabase PITR + nightly `pg_dump` to a separate Canadian S3-compatible bucket

**Description:** PITR for short-window recovery; `pg_dump` (custom format,
compressed, encrypted with a key the bucket provider doesn't hold) shipped
nightly to a second Canadian region (e.g., Backblaze B2 or AWS S3 ca-central),
35-day rolling retention. Restore drill quarterly.

**Pros:**
- Two independent durability domains.
- Encrypted-at-rest with our key, so the bucket provider is *not* a PI
  processor for plaintext — it's a ciphertext blob holder. The PI inside
  the dump is already C3/C4 ciphertext at the row level; the dump itself
  is wrapped again.
- Restore drill is forcing-function for proving the playbook.

**Cons:**
- One more vendor to evaluate (lightweight — they don't see plaintext).
- Slight ops overhead (a GitHub Actions cron job, monitoring).

### Option C: Self-managed warm standby in a second region

**Description:** Streaming replication to a self-managed Postgres in a
second Canadian region.

**Pros:**
- RPO near zero.

**Cons:**
- Way over-engineered for 50 users. Re-introduces ops burden we explicitly
  shed by choosing Supabase Cloud.
- Cost.

## Decision

**We choose Option B.**

### Rationale

PITR alone is single-vendor. Option C is over-engineered. Option B gives us
a second, independent durability domain at low cost and forces a real
restore drill.

**Operational rules:**
- **PITR window:** 7 days (Pro default).
- **`pg_dump` cadence:** nightly at 03:00 ET, encrypted with a libsodium
  secret box; the dump key is held in 1Password Business (user account)
  and printed on paper in the worker co-chair's possession (key escrow
  outside any cloud).
- **Off-site bucket:** Backblaze B2 in Canadian region OR AWS S3 ca-central
  — confirmed before T01 ships. The bucket provider is **not** a PI
  processor (encrypted blob only) but is listed in `SUBPROCESSORS.md`.
- **Retention:** 35 days rolling, then hard delete.
- **Restore drill:** quarterly. The drill restores into a scratch Supabase
  project, runs migrations, decrypts a known fixture record with a test
  committee key, and produces a signed restore report.
- **Key-loss recovery:**
  - **Committee data key loss** → at least one remaining member with a wrapped
    copy can re-wrap to the rest. If *all* members lose access, the data is
    cryptographically gone. This is by design (T1, T5).
  - **Individual identity-key loss** → user prints a recovery passphrase at
    enrollment that decrypts an identity-key backup blob stored on the
    server. Loss of both the device and the passphrase = re-enroll as a
    new user, lose history; document this on the recovery screen.

### Reversibility

**Easy.** Switch buckets or providers without touching app code; restore
playbook stays the same.

## Consequences

### Positive
- Two-vendor durability without two-vendor PI exposure.
- Restore drill becomes routine, not a surprise.

### Negative / accepted tradeoffs
- Total key loss = total data loss. Documented; this is the price of E2EE.
- One more thing to monitor (dump job freshness).

### Risks
- Dump job silently failing → mitigated by alert if last successful dump
  is >36 hours old.
- Key escrow procedure not followed → mitigated by quarterly drill that
  fails if the key isn't usable.

## Compliance check

- [x] Aligns with constraints.md (Canadian residency, encrypted at rest).
- [x] No new PI processor (bucket holds ciphertext blob).
- [x] DPA needed with bucket provider (standard SOC2 + region commitment).
- [x] Documented in plan §7.

## Follow-ups

- [ ] T17 — write `playbooks/backup-restore.md` and schedule first drill before launch.
- [ ] Add bucket provider to `SUBPROCESSORS.md` once chosen.

---

## Amendment: Object Lock + versioning + lifecycle hard-delete (2026-05-22, HG-8)

**Amends ADR-0012** above. Trigger: threat-model F-49 (backup bucket credential compromise enables ransomware-style delete) / O-15 / HG-8. Q1 has resolved the bucket provider as **Backblaze B2 (Canadian region)**; the amendment binds the bucket's operational settings.

**Added operational rules on top of the original:**

1. **Object Lock — governance mode, 35-day retention per object.** Every `pg_dump` object written to the bucket is created with an Object Lock retain-until of `now + 35 days`. Governance mode (not compliance mode) is chosen so an explicit override path exists for a legitimate operational need (e.g., a dump containing a known-bad PII leak that itself needs purging), gated by an additional credential held only by the user (root account, not the workflow's write credential). Retention matches the rolling backup window from plan §7 / §8.
2. **Versioning enabled.** Every overwrite creates a new version; prior versions are listable and restorable until lifecycle deletes them. A malicious or accidental overwrite is recoverable.
3. **Lifecycle policy — hard delete at 35 + 7 = 42 days.** Versions whose object-creation timestamp is older than 42 days are hard-deleted by the bucket lifecycle rule (35-day retention window + 7-day grace for a missed restore drill or in-flight investigation). The hard delete is **required** for crypto-shred-on-retention to hold: if old encrypted backups linger indefinitely, the crypto-shred protection (committee-key rotation destroying old wraps) erodes as long-tail backups still contain the old wraps. See F-06 / O-2 for the existing forward-secrecy gap which this caps.
4. **Credential separation.** The nightly-dump workflow's write credential is scoped: PutObject + GetObject + ListObjects only. It explicitly does **not** carry `DeleteObject`, `BypassGovernanceRetention`, or `PutObjectLockConfiguration` rights. Lifecycle deletes are executed by the bucket itself, not by the workflow credential.
5. **Bucket-config drift check (CI).** Weekly CI job reads bucket configuration via Backblaze admin API and asserts: (a) versioning enabled, (b) Object Lock enabled with default retention = 35 days governance, (c) lifecycle rule deletes versions older than 42 days, (d) the workflow credential's grants match the scoped list. Drift triggers an alert.

**Reversibility:** Easy on bucket settings (a configuration change). Hard to retroactively apply Object Lock to existing objects, so this is set at bucket creation (T17 acceptance pre-flight) before the first nightly dump.

**Compliance check additions:**
- [x] Crypto-shred-on-retention is preserved (old backups hard-deleted on schedule).
- [x] Ransomware-class delete defeated within the 35-day window.
- [x] No new subprocessor; B2 still holds ciphertext-of-ciphertext only.

**Follow-ups (amend T17 acceptance — see Task-list amendments at end):**
- [ ] **T17 amended:** bucket created with Object Lock (governance, 35d), versioning ON, lifecycle 42d hard delete; CI drift check operational; restore-drill playbook covers the case "Object Lock prevents drill-bucket cleanup."
- [ ] Recovery-drill procedure documents: how to restore a *specific version* of a dated dump under Object Lock (read path is unchanged; write/delete is the gated path).
- [ ] Test (F-49 mitigation): with the regular workflow write credential, attempt to overwrite an existing object — assert it creates a NEW version, prior version still listable. Attempt to DELETE a version under retention — assert denied with the expected error code.

---

## Amendment: Crypto-shred-on-retention coherence with audit-log per-event retention (2026-05-22, amendment pass #3)

**Amends ADR-0012** above. Trigger: privacy-review §5 fold-in item 4 — "extend the crypto-shred-on-retention story to cover the new per-event audit-log retention schedule." Cross-references **ADR-0015** (per-event-type audit-log retention schedule); privacy-review §3.3 / §3.5; threat-model F-06 / O-2.

**The coherence note.** The Object-Lock-protected backup bucket holds nightly `pg_dump` ciphertext blobs with a hard delete at 42 days (35d retention + 7d grace). For the crypto-shred-on-retention claim to hold end-to-end, **no audit-log event-type retention value may exceed the longest underlying-record retention that any backup can carry** — otherwise a hard-deleted backup at day 42 would leave audit events on the live system referencing records that no longer exist (in either the live DB or backup), but with no provenance trace.

The schedule in ADR-0015 satisfies this by construction:
- The longest-lived audit-log event types are 7 years (e.g., `committee_data_key.rotation.completed`, `member.added/.removed`, `audit.forensic_reveal.4eyes_*`, `retention.deleted`).
- Every backup older than 42 days is hard-deleted; backups older than 42d cannot exist.
- Every audit row whose `target_id` references a record in another table is bounded by the underlying-record-ceiling rule (privacy-review §3.5, encoded in ADR-0015): audit row outlives linked record by at most 30 days.

**Concrete invariant:** *"Backups older than the longest audit-log event retention can be hard-deleted without leaving 'events we cannot explain' on the live system; conversely, no live audit row references a deleted underlying record older than 30 days."* The two retention regimes (live audit-log schedule + backup lifecycle) are coherent.

**No new test obligation specific to ADR-0012**; the coherence is structurally enforced by ADR-0015's schedule and the existing T17 / T16 acceptance tests. Cross-reference recorded so a future amendment to either ADR-0015 (changing an event-type retention) or this ADR (changing the 42d hard-delete window) triggers a re-read of the coherence claim.

**Reversibility:** N/A — this is a documented architectural cross-reference, not a new operational rule. The reversibility is governed by ADR-0015 and the original ADR-0012 amendment.

**Compliance check additions:**
- [x] Audit-log per-event retention (ADR-0015) and backup hard-delete (this ADR) are coherent — no orphan audit events at any retention horizon.

---

# ADR-0011: No native iOS/Android apps in v1 — PWA only

**Status:** Accepted — **Amended 2026-05-22 (HG-5)**
**Date:** 2026-05-22 (original); amendment 2026-05-22
**Decider(s):** user (locked in plan §13 item 10), architect ratifying; amendment per HG-5, user-approved

**Amendment note (2026-05-22, HG-5):** see "Amendment: EXIF/IPTC/XMP/GPS strip on photos" block at the end of this ADR. Threat-model trigger: F-46 / O-9. Original PWA-only decision unchanged; the amendment binds the photo-capture pipeline that runs inside the PWA.

## Context

Threat T10 in plan §4: "Forced disclosure of who installed the app."
App-store presence creates a record at Apple/Google tying a real-name
account to JHSC-app installation. For a tool whose users are protected
under OHSA s.50 (anti-reprisal), that record is itself a reprisal vector
— an employer with a court order, or a state actor, can subpoena the
store to learn which workers installed it.

PWAs install from the browser. No store account, no install record at a
third party. The user already locked this decision; this ADR ratifies the
reasoning.

## Decision drivers

- T10 (store install record as reprisal vector).
- No third-party PI processors beyond Supabase (constraints.md hard rule).
- Single small team; one codebase is cheaper to secure than three.
- Offline + push are partially achievable in modern PWAs (iOS 16.4+, all
  modern Android).

## Options considered

### Option A: PWA only

**Description:** Single SvelteKit PWA, installable from the browser,
service worker for offline.

**Pros:**
- No app-store PI processor.
- One codebase, one CSP, one update path.
- Auto-update; no abandoned-old-version users.

**Cons:**
- iOS push is recent and quirky.
- Some platform APIs (background sync on iOS) are limited.
- Users have to know about "Add to Home Screen."

### Option B: Native iOS + Android (React Native or Capacitor)

**Description:** Native shells over a web view or RN.

**Pros:**
- Better push, background sync, biometric integration.
- Familiar install path.

**Cons:**
- **Apple and Google become PI subprocessors** (install records,
  device-bound IDs, crash reports if not disabled). Each requires a
  flagged-human-gate decision.
- US-based platforms; cross-border concern even for metadata.
- Three codepaths to harden, three review cycles per release.
- Store review can delay security fixes.

### Option C: PWA + native shells later for opt-in users

**Description:** Ship PWA in v1; revisit native later when complaints justify it.

**Pros:**
- Keep the v1 attack surface minimal.
- Decision can be re-opened with real data.

## Decision

**We choose Option A for v1. Option C is the migration path.**

### Rationale

T10 is the primary driver. Even one "PWA-only" launch user materially
reduces the reprisal-vector surface area. Native is a v2 conversation
gated on real complaint volume, with a fresh human-gate review of
Apple/Google as processors.

### Reversibility

**Medium.** Adding native shells later is a defined project — not a flag
flip, but not a rewrite. Domain stays the same; auth stays the same;
the crypto core stays the same.

## Consequences

### Positive
- No app-store install record.
- No Apple/Google as subprocessors.
- One CSP, one update path.

### Negative / accepted tradeoffs
- iOS push experience is weaker than native.
- "Add to home screen" requires education in onboarding copy.

### Risks
- iOS Safari changes that break PWA install. Mitigated by tracking
  webkit-dev signals and degrading to in-browser use (still functional).

## Compliance check

- [x] No new PI subprocessor.
- [x] Aligns with constraints.md.
- [x] Mitigates T10.

## Follow-ups

- [ ] Onboarding copy explains why no store install (links to this ADR
      in plain English).
- [ ] `KNOWN-GAPS.md` lists native as v2.

---

## Amendment: EXIF / IPTC / XMP / GPS strip on photos (2026-05-22, HG-5)

**Amends ADR-0011** above. Trigger: threat-model F-46 (GPS metadata leak through opt-in poorly defaulted) / O-9 / HG-5.

**Problem:** Photos taken for inspections (T10) and s.51 evidence (T14) can carry GPS coordinates, device identifiers, timestamps, and other metadata in EXIF / IPTC / XMP blocks that identify the photographer, the device, or the precise location of the workplace floor. Plan §8 turns the app-level GPS toggle off by default but does NOT strip embedded EXIF coming from the camera. A worker who shoots an inspection photo on a personal phone with system-level location enabled will produce a JPEG whose EXIF GPS tag pinpoints the shop floor — exfiltrating that to the employer (via subpoena over a backup, or via an export bug) is exactly the T1/T3 risk profile.

**Added operational rules:**

1. **Strip ALL metadata client-side, before encryption.** All EXIF, IPTC, and XMP blocks are removed from every image accepted into the inspection / s.51 / any photo pipeline. The strip happens in the same module that encrypts the photo (`src/lib/photo/sanitize.ts`), executed BEFORE the libsodium `crypto_secretbox` call. No path uploads or persists a raw-from-camera image.
2. **GPS coordinates explicitly removed.** Even if a worker WANTS the inspection record to capture a location, location is entered as a free-text field (e.g., "South dock, line 3, near the hydraulic press") OR selected from the `location_id` enum (C1 metadata). It is never derived from EXIF. The app-level GPS toggle (plan §8 opt-in per inspection) remains independent of EXIF and continues to be opt-in, off by default.
3. **Re-encode through canvas.** To defend against EXIF-strip libraries that miss exotic markers or app-specific segments, the sanitize step re-encodes the image through an HTMLCanvasElement (decode -> canvas -> JPEG/PNG encode) at a configured quality. This is destructive to ALL metadata as a side-effect; the canvas pipeline cannot carry EXIF/IPTC/XMP across.
4. **Round-trip verification test (mandatory).** Test-writer adds a fixture: feed a photo with known EXIF GPS, IPTC by-line, XMP creator-tool tags through the pipeline; capture the ciphertext blob; decrypt with the test committee key; pass the decrypted bytes through an EXIF / IPTC / XMP parser; assert ZERO tags present and ZERO GPS coordinates anywhere in the byte stream.
5. **Defensive byte-grep for coordinate-shaped strings.** As a sanity check, after decrypt-in-test, grep the decrypted bytes for patterns matching decimal-degrees (e.g., `/[0-9]{1,3}\.[0-9]{4,}/` near known city-scale bounding boxes for the workplace's province); assert none present. Catches "GPS leaked through a non-EXIF channel (e.g., embedded comment) that the parser missed."

**Reversibility:** Easy. The sanitize module is one file; changing the strip strategy is a one-PR change.

**Compliance check additions:**
- [x] Data minimization (PIPEDA Principle 4): location data not collected unless explicitly entered by the user.
- [x] Mitigates F-46.
- [x] Reduces the T3 export risk surface (an exported photo cannot smuggle GPS to the employer).

**Follow-ups (amend T10 acceptance — see Task-list amendments at end):**
- [ ] **T10 amended:** EXIF/IPTC/XMP strip + canvas re-encode + round-trip test; same pipeline applies to T14 (s.51 evidence photos).
- [ ] Designer: photo-capture UI labels include "GPS off; location is free-text or from the location list."

---

# ADR-0010: Error tracking — Sentry SaaS with strict PI scrubbing

**Status:** Accepted — **Amended 2026-05-22 (F-D + F-H, observability-setup pass #2)**
**Date:** 2026-05-22 (original); amendment 2026-05-22
**Decider(s):** architect; amendment per F-D + F-H from observability-setup pass #2

**Amendment note (2026-05-22):** see "Amendment: Edge Function logging contract + Phase-0 tracing deferral" block at the end of this ADR. Original Sentry SaaS decision unchanged; the amendment adds (a) architectural ratification of the Edge Function structured-logging contract that `observability/logging.md` §4 had been treating as "applies until contradicted", and (b) an explicit note that distributed tracing is deferred to Phase 4 (sre-specialist) — `request_id` is wired across all three observability pillars to make the future introduction mechanical.

## Context

We need error tracking so the implementer and incident-responder can debug
production issues. Plan §7 lists "self-hosted Sentry (or equivalent)" as
the preferred direction, but we should commit to one in an ADR and weigh
the operational cost of self-hosting against the PI-exposure cost of SaaS.

Constraints.md forbids any third-party that processes PI **without a flagged
human-gate decision and a DPA**. Whichever option we pick, the rule is the
same: **no PI may leave the app via error tracking**, regardless of provider.

## Decision drivers

- No PI in telemetry (constraints.md).
- Canadian / EU residency.
- Team-of-one ops capacity — running an extra service has real cost.
- Auditability of what gets sent.
- Speed of getting actionable errors in front of the implementer.

## Options considered

### Option A: Sentry SaaS, EU region, with SDK-layer scrubbing

**Description:** Sentry's EU-hosted instance (Frankfurt). PI scrubbing is
done at the SDK *before* the event leaves the browser/server:
- `beforeSend` strips all `request.cookies`, `request.headers.authorization`,
  query params, form body fields.
- Allowlist of breadcrumb categories; everything else dropped.
- No user identifier sent (no `Sentry.setUser`).
- Source maps uploaded privately; not exposed.
- Tags limited to: environment, release SHA, route name (no params).

Sentry GmbH has a DPA, signs SCCs, and is GDPR-aligned. PIPEDA-comparable
safeguards present.

**Pros:**
- Zero ops.
- Mature product; good UX for triage.
- EU residency is PIPEDA-comparable; documented in DPA.

**Cons:**
- A third party sees *something* (scrubbed payloads, IPs unless we strip).
  Even with aggressive scrubbing, residual risk of accidental PI leak via
  a new code path the scrubber doesn't know about.
- Sentry Inc. is US-incorporated even if the EU instance is in Frankfurt;
  CLOUD-Act-reachable in principle. (Same shape as Supabase, but for
  scrubbed metadata not committee data.)
- Cross-border data flow (Canada → EU); document but not PI in normal flow.

### Option B: Self-hosted GlitchTip in `ca-central-1`

**Description:** GlitchTip is an open-source, Sentry-protocol-compatible
error tracker. Run it on a small VM or in Supabase-adjacent infra in
Canada.

**Pros:**
- No third-party PI processor at all.
- Fully Canadian residency.
- Same SDK story as Sentry.

**Cons:**
- Real ops burden for a team-of-one: patching, monitoring, backups,
  capacity, the meta-question of "what monitors the monitor."
- If GlitchTip is down, errors are lost (not the worst — but means we
  miss bugs).

### Option C: No error tracker; rely on structured logs

**Description:** Just log to Supabase logs / a Canadian log sink.

**Pros:**
- Simplest.

**Cons:**
- No stack-trace aggregation, no de-dup, no release tagging. The
  implementer will be blind to client-side errors.
- Reactive: we hear about bugs from users, late.

## Decision

**We choose Option A: Sentry SaaS (EU region) with strict SDK-layer scrubbing.**

### Rationale

The decisive factor is that the scrubbing posture makes Sentry **not a PI
processor by design** — we don't send PI; we send scrubbed stack traces and
breadcrumb metadata. The DPA + EU region cover the residual exposure. A
team-of-one cannot reliably run a self-hosted error tracker; a flaky
error tracker is worse than a SaaS one because we'll silently miss bugs.

This is a flagged-human-gate processor under constraints.md rule #3 — the
flag is this ADR. The mitigation is the scrubbing contract verified in
CI (semgrep rule + scrubbing test fixture).

### Reversibility

**Easy.** Sentry SDK is protocol-compatible with GlitchTip; swap the DSN
to migrate.

## Consequences

### Positive
- Actionable error data in front of the implementer fast.
- No ops burden.

### Negative / accepted tradeoffs
- Sentry Inc. is a US-incorporated processor (scrubbed metadata only).
- Cross-border flow Canada → EU (metadata, not PI).

### Risks
- A new code path accidentally sends PI (e.g., a form-validation error
  containing the user's input). Mitigated by:
  - `beforeSend` deny-by-default for fields not on an allowlist.
  - CI test that submits known-PI input and asserts the captured Sentry
    payload contains none of it.
  - Semgrep rule banning `Sentry.captureException(err, { extra: { ... } })`
    with non-allowlisted keys.
- Sentry breach exposes scrubbed metadata. Residual risk: low; we treat
  Sentry payloads as if they were public.

## Compliance check

- [x] DPA in place (Sentry's standard DPA + SCCs).
- [x] EU region (PIPEDA-comparable; documented).
- [x] No PI sent (verified in CI).
- [x] Listed in `SUBPROCESSORS.md`.
- [x] Cross-border flow documented (no PI in flow).

## Follow-ups

- [ ] T02 — observability-setup writes the `beforeSend` scrubber + CI test.
- [ ] Add Sentry to `SUBPROCESSORS.md`.
- [ ] Semgrep rule prohibits non-allowlisted extras.

---

## Amendment: Edge Function logging contract + Phase-0 tracing deferral (2026-05-22, F-D + F-H)

**Amends ADR-0010** above. Triggers:
- **F-D** (observability-setup pass #2): `observability/logging.md` §4 specifies the Edge Function structured-logging contract as "applies until contradicted." The substance is in the spec; the architectural pointer is missing. Without ratification, a downstream agent could plausibly reach for a different logging library, a different scrubber, or `console.log(req.body)` patterns without tripping a clear ADR-level rule.
- **F-H** (observability-setup pass #2): distributed tracing is deferred to Phase 4 (sre-specialist) per `observability/README.md` §1; at 12-active-user scale this is acceptable. The deferral is a deliberate Phase-0 simplification, not an oversight; recording it here gives the future sre-specialist a clear handoff anchor.

### F-D — Edge Function logging contract ratified

The substance lives in `observability/logging.md` §4 (Edge Functions are the highest-risk logging surface; they handle ciphertext payloads, and a careless `console.log(req)` leaks payload shape + provenance even when no plaintext is present). This amendment ratifies the load-bearing rules so they have ADR-level weight:

**Rule 1 — No PI in Edge Function logs, ever.** The PI inventory (`.context/decisions.md` §System Design "PI inventory" table) is the closed denylist. Anything in the C2/C3/C4 columns or their adjacent field names is forbidden from any Edge Function log line. Auth material (cookies, JWTs, TOTP codes, passkey assertions, recovery passphrases) is in the same denylist.

**Rule 2 — Scrubbing happens BEFORE the log call, not in a pipeline downstream.** The structured logger (`apps/web/src/lib/log/` + `supabase/functions/_shared/log.ts`) enforces an `safeFields` allowlist at the emit point. The logger does NOT trust the caller; unknown keys are dropped at emit, AND a CI-visible WARN is raised in test environments. There is no downstream "scrubbing pipeline" that the logger relies on; if the call site emits PI, it is the call site that violates the contract, and CI catches it via semgrep rules `no-pi-in-log-attrs`, `no-console-log-req`, `no-debug-in-prod`, and the canary fixture test.

**Rule 3 — `request_id` propagates through every pillar for correlation.** Browser generates a UUIDv4 per logical request and sends it as the `X-Request-ID` header; Edge Functions read and propagate it (or generate one if absent); the server returns it in the response so the browser can log its tail of the request under the same id. Every audit-log row written during that request carries the same `request_id` in its `meta` jsonb. Every Sentry event carries `tags.request_id`. This makes a single error correlatable across (Sentry event → Edge Function log line → audit-log row) without introducing a tracing tool.

**Rule 4 — Edge Function log retention matches the audit-log retention floor, subject to F-F (privacy-reviewer pass).** `observability/README.md` §1 currently records: Sentry 30 days for errors / 7 days for breadcrumbs, Supabase Edge Function logs 7 days on Pro tier, audit-log 24 months. The retention values are NOT changed by this amendment. The pointer to **F-F (privacy-reviewer pass — open, see below)** is recorded explicitly so a future change to audit-log retention triggers a re-read of these values for consistency.

**Architectural enforcement (binding for the implementer and verifier):**
- Every Edge Function imports the shared logger module; direct `console.*` calls in `supabase/functions/` fail CI via semgrep.
- The shared logger's `safeFields` allowlist is the union allowlist (browser + server + Edge Functions); no per-surface relaxation.
- The canary-PII test fixture (T02 acceptance) traverses every Edge Function path and asserts the canary is absent from Supabase function logs. F-09 (`.context/threat-model.md` §3.1) is the test obligation; this amendment is the ADR-level commitment.
- The shared `observability/sentry-scrub.ts` `beforeSend` is re-used in Edge Functions when they capture an exception to Sentry; the same scrubbing contract applies.

**Reversibility:** Easy on tooling (the shared logger is a single module); hard on the architectural rule (rules 1–4 are non-negotiable while the E2EE posture of ADR-0001 + ADR-0003 holds).

### F-H — Phase-0 tracing deferral (acknowledged, not a new decision)

**No distributed tracing in Phase 0.** OpenTelemetry, custom span propagation, or vendor tracing tools (Datadog, Honeycomb, etc.) are NOT in scope until the sre-specialist (Phase 4) has 90 days of real production data and a defensible SLO target.

**Why this is acceptable at v1:**
- Scale is 12 active committee members; the audit log IS the trace for trust-changing events (every meaningful action is hash-chained, pseudonym-attributed, timestamped). At this concurrency, an incident-responder can walk a `request_id` across Sentry → Edge Function log → audit row by hand.
- Adding a tracing vendor would be a new PI-adjacent subprocessor (see ADR-0010 main body — Sentry is the only one approved, and adding another triggers a flagged human-gate decision per `.context/constraints.md` rule 3).
- The cost of introducing tracing later is **mechanical**: `request_id` is already wired through all three pillars (browser → Edge Function → audit log → Sentry) per F-D Rule 3. The sre-specialist's introduction of a tracing tool fills in the spans without re-architecting the correlation key.

**Re-open trigger:** any of the following indicates Phase 4 should consider tracing:
- Sustained traffic where the audit log's volume (today's enum vocabulary, including the Amendment A extensions) is insufficient to localize a slow request.
- An incident where a slow Edge Function → Postgres query path cannot be diagnosed from `request_id` correlation alone.
- A formal SLO target (per `observability/README.md` §7 placeholder) that requires latency-percentile observability the structured logger does not provide.

**Owner of the next pass:** **sre-specialist (Phase 4)**. The architect does not pre-select a tracing tool; the sre-specialist re-runs the cost/PI-subprocessor evaluation against then-current options.

### F-B (cross-pollination) — canonical event name for offline-queue HMAC failure

This is a mechanical cross-reference, not a substantive ADR change, but it lands in this amendment because the same observability pass surfaced it:

**Canonical event name: `queue.integrity_fail`** (matches ADR-0014 as the load-bearing source).

The alias `inspection.synced.hmac_fail` was used in `observability/audit-log.md` §1 as an alternative name for the same event; this amendment confirms `queue.integrity_fail` is the single canonical name, and `inspection.synced.hmac_fail` is a **forbidden alias**. The verifier (Phase 2) wires a semgrep rule that fails CI on any reference to the alias in code, tests, migrations, or documentation outside of:
- This file (this amendment block documenting the deprecation).
- ADR-0014 (the source of truth — already uses `queue.integrity_fail`).
- `observability/audit-log.md` §6 finding #2 (which already flagged this duplication; the verifier rule's allowlist for the alias string is exactly these three files until the audit-log spec drops the alias in a subsequent observability-setup pass — observability-setup files are not modified by the architect per this pass's hard rules).

**Follow-up:** observability-setup, on its next pass, removes the alias text from `observability/audit-log.md` §1 (inspections section) and §6 finding #2; the architect's enum in ADR-0003 Amendment A is unaffected (it already uses `queue.integrity_fail`).

### F-E / F-F (routed to privacy-reviewer — NOT decided here)

Two findings from the observability-setup pass surface privacy-substantive questions that the architect explicitly does NOT decide on this pass. They are recorded here so the privacy-reviewer (running in parallel after the threat-modeler's second pass) picks them up:

- **F-E — `reprisal.created` audit-log row visibility:** the audit-log RLS makes `reprisal.created` rows readable by all active members (the social-norm-backstop design, per Amendment B's HG-6 surface and RA-1's post-export rep notification pattern). A rep entering a reprisal may reasonably expect more discretion than "every active member sees that someone entered a reprisal." **The architect does NOT modify ADR-0003 Amendment B or the audit-log RLS in this pass.** The privacy-reviewer is asked to confirm or amend: (a) is "all active members see `reprisal.created`" the right default, (b) if not, what RLS / role-scoping change preserves the social-norm property while narrowing the visibility, (c) does the privacy notice need to name this explicitly. If the privacy-reviewer concludes the visibility should narrow, a future architect pass amends ADR-0003 Amendment B and the audit-log spec accordingly.
- **F-F — Audit-log retention at 24 months vs `.context/constraints.md` floor "at least 1 year":** `observability/README.md` §1 records 24 months for `audit_log`. `.context/constraints.md` requires a 1-year floor. Both values are consistent (24 ≥ 12); the question is whether 24 is the right value given the OHSA limitation profile of the audit-log content (which is C1, not the C3/C4 content on the 7y schedule). **The architect does NOT change the retention value in this pass.** The privacy-reviewer is asked to confirm 24 months is appropriate before launch; if the privacy-reviewer concludes a different value (e.g., 12 months floor, or 36 months for PIPEDA breach-record alignment), a future architect pass amends the retention spec accordingly.

Both items are privacy-review checkpoints, not architecture decisions. They are visible here so the privacy-reviewer's pass knows where to land its findings; nothing in this amendment depends on the resolution.

### Compliance check additions

- [x] No new third-party processor.
- [x] No new cross-border flow.
- [x] Ratifies the existing `observability/logging.md` §4 contract at ADR level.
- [x] Phase-0 tracing deferral is consistent with the "no premature distribution" hard rule.
- [x] F-E and F-F are flagged for privacy-reviewer; the architect is not pre-deciding privacy-substantive questions.

### Follow-ups

- [ ] **T02 acceptance (existing, no change needed here — observability/* files not modified per this pass's hard rules):** the canary-PII test in `observability/sentry-scrub.ts` and the Edge Function canary test in `observability/logging.md` §4 already test the substance of Rules 1–4. The ADR-level ratification adds no new task; it adds reviewer authority.
- [ ] **Privacy-reviewer pass (next, parallel with threat-modeler second pass):** F-E and F-F land in their output.
- [ ] **Verifier (Phase 2):** semgrep rule `no-inspection-synced-hmac-fail-alias` (the F-B forbidden-alias rule) added to `scripts/verify.sh`.
- [ ] **sre-specialist (Phase 4):** tracing re-evaluation per F-H re-open triggers.

---

# ADR-0009: i18n catalog from day 1; English at launch

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** user (locked in plan §13 item 7), architect ratifying

## Context

Plan §13 locks: English-only at launch, but the i18n catalog must be
scaffolded from day 1. The pack lesson is that retrofitting i18n into a
codebase with hard-coded strings is expensive and error-prone — every PR
becomes a localization PR.

French (`fr-CA`) is the planned second locale; it ships when needed (any
French-speaking committee member), via the localization-specialist agent
as a translation task, not a refactor.

## Decision drivers

- Don't pay the i18n retrofit tax later.
- Don't pay for fr-CA strings we don't have yet.
- Locale-aware date/number/currency formatting from day 1 (Ontario
  contexts: 2026-05-22, not 5/22/2026).
- Accessibility-statement language attribute correctness.

## Options considered

### Option A: i18n library scaffolded, en-CA only at launch

**Description:** Use `svelte-i18n` (if SvelteKit) or `next-intl` (if Next).
All UI strings go through `t()` from day 1. Catalog file
`src/i18n/en-CA.json` exists; `src/i18n/fr-CA.json` exists with the same
keys but empty values (so missing-key checks pass and the structure is
stable).

**Pros:**
- Adding fr-CA later is a translation pass, not a refactor.
- Locale-aware formatting from day 1.
- ESLint rule `no-literal-string` (or equivalent) prevents regression.

**Cons:**
- Slightly more verbose components.
- Translators need to be briefed; not a v1 burden.

### Option B: Hard-coded English now, retrofit later

**Description:** Just write English strings; add i18n when we need French.

**Pros:**
- Slightly less code.

**Cons:**
- This is the exact pack lesson we wrote down — don't do it.

### Option C: i18n + machine-translated fr-CA from day 1

**Description:** Generate fr-CA strings with MT, ship dual locale.

**Pros:**
- French users covered immediately.

**Cons:**
- MT quality on labour-law and OHSA terms is poor.
- Constraints.md forbids third-party AI processors without a flagged
  decision; this is one.
- Bad French is worse than no French in a legal-adjacent tool.

## Decision

**We choose Option A.**

### Rationale

Direct application of the pack lesson. Cheap insurance now; expensive
debt later. Option C trades the wrong kind of risk (translation quality
on legal terms).

### Reversibility

**Easy.** Adding fr-CA = a translation task. Adding more locales beyond
that = same task, repeated.

## Consequences

### Positive
- Future-proof; adding French is straightforward.
- Locale-aware formatting from day 1.

### Negative / accepted tradeoffs
- Slight upfront discipline cost.

### Risks
- Developer forgets to use `t()`. Mitigated by ESLint rule fail-on-CI.

## Compliance check

- [x] AODA: accessibility statement will use correct `lang` attribute.
- [x] No third-party MT processor (Option C rejected).

## Follow-ups

- [ ] T03 — localization-specialist scaffolds catalog and lint rules.
- [ ] Catalog includes a "review needed" marker for OHSA legal-term
      translations; user + labour lawyer review when fr-CA ships.

---

# ADR-0008: Personal-device-only posture — advisory, not enforced

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** user (locked in plan §13 item 6), architect ratifying

## Context

Plan §3.2 ("Worker-side-only ★") prohibits employer-network dependency.
Plan §13 locks the device stance as personal-device-only, advisory only.

A PWA cannot reliably detect:
- MDM enrollment.
- Whether the device is employer-owned.
- Whether DNS, certificates, or proxy infrastructure are employer-controlled.

Even best-effort detection (e.g., DoH probes, certificate-pin checks) is
unreliable and a wrong "your device is monitored" warning is worse than
none. Threat T2 (employer obtains content via employer-owned device) is
real and we can only mitigate it with UX nudges and session hygiene.

## Decision drivers

- T2 mitigation.
- Don't lie about technical enforcement we can't deliver.
- Don't false-positive a clean device as compromised.
- Workers may not have a personal smartphone — onboarding must address this.

## Options considered

### Option A: Hard block via heuristics

**Description:** Probe for MDM/proxy signals; refuse to load if any
positive signal.

**Pros:**
- Looks strong on a slide.

**Cons:**
- High false-positive rate on legitimate setups (corporate-pinned home
  WiFi, university captive portals).
- High false-negative rate on actual MDM (modern MDM is invisible to
  web apps).
- Lock-out is a worse failure mode than warning.

### Option B: Advisory + session hygiene + visible posture

**Description:**
- First-launch screen: "This app is intended for personal devices. If
  you are reading this on an employer-issued device, your employer may
  be able to read what you do here. Don't install. Use a personal phone."
- Settings shows current device fingerprint (UA + platform), last
  installed timestamp, "this device" with a "forget this device" action.
- Session hygiene: 15-min auto-lock; passkey re-auth on resume; no
  persistent refresh tokens; "panic wipe" wipes IndexedDB.
- No content cached on disk beyond what the active session needs;
  optional "cache for offline inspection" is opt-in per inspection.
- Onboarding copy includes "if you don't have a personal smartphone,
  speak to the worker co-chair" — they may have a committee-managed
  device that lives in a locker.

**Pros:**
- Honest about what the app can and can't enforce.
- Layered: warning → behavior → recovery.

**Cons:**
- Some users will install on employer devices anyway. Documented.

### Option C: Require attestation (WebAuthn attestation)

**Description:** Use platform attestation to verify the authenticator
isn't employer-controlled.

**Pros:**
- Strongest signal.

**Cons:**
- WebAuthn attestation doesn't tell us if the device is employer-owned;
  only that the authenticator is genuine.
- Privacy-hostile (attestation can be a tracking vector).

## Decision

**We choose Option B.**

### Rationale

The hard problem is honest framing. Option A gives the wrong impression
of enforcement. Option C answers the wrong question. Option B layers
advice + session hygiene + recovery so the residual T2 risk is reduced
without lying about it.

### Reversibility

**Easy** for advisory copy. **Medium** for session hygiene — these are
behavior choices, not data choices.

## Consequences

### Positive
- Honest UX.
- Real reduction in T2 risk via session hygiene.
- Recovery (panic wipe, session revocation) gives a coerced user a
  visible action.

### Negative / accepted tradeoffs
- We can't prevent a determined user from installing on the wrong
  device.

### Risks
- A worker without a personal smartphone is excluded. Mitigated by
  shared committee device option (locker), called out in onboarding.

## Compliance check

- [x] No covert telemetry (no MDM-detection ping).
- [x] No third-party attestation processor.

## Follow-ups

- [ ] Designer + tech-writer craft onboarding copy (T08, T18).
- [ ] T19 — panic-wipe + session revocation tested.

---

# ADR-0007: Concern intake — committee-members-only, no public endpoint

**Status:** Accepted — **Amended 2026-05-22 (amendment pass #3, scope extension to reprisal-log intake consent surface)**
**Date:** 2026-05-22 (original); amendment 2026-05-22
**Decider(s):** user (locked in plan §13 item 3), architect ratifying; amendment scope extension per privacy-review §5 fold-in item 2

**Amendment note (2026-05-22, amendment pass #3):** see "Amendment: Reprisal-log intake consent surface (HG-13)" block at the end of this ADR. Trigger: privacy-review Q1 APPROVED-WITH-CHANGES / §2.4 / §5 fold-in item 2 — the consent-surface copy for the reprisal-entry intake form is procedurally an extension of concern intake (the rep submits on behalf of the affected worker) and is folded into ADR-0007 rather than a new ADR-0016 per the privacy-reviewer's preferred shape. Original concern-intake decision unchanged; the amendment adds the reprisal-intake consent surface contract.

## Context

Plan §2.2 task 1 and §13 lock concern intake as committee-members-only.
A worker rep enters a concern on behalf of a worker; there is no public
form, no anonymous web submission, no email ingestion.

## Decision drivers

- Reduce attack surface — no unauthenticated write path means no spam,
  no enumeration, no abuse vector.
- Preserve labour-relations privilege — the rep mediates submission;
  the rep is the legitimate channel.
- Anonymity of the original complaining worker is achieved via the
  rep's "anonymous source" toggle, *not* by an anonymous public form.
- Eliminate the "worker fills it out at their desk on the employer
  network and it shows up in logs" failure mode.

## Options considered

### Option A: Committee-members-only intake (locked)

**Description:** Only authenticated committee members can write to the
concerns table. Source can be marked anonymous (default ON) or have a
worker name attached (name is E2EE under committee key).

**Pros:**
- Minimal attack surface.
- Privilege story is intact.
- RLS enforces it server-side; no public route.

**Cons:**
- Workers without rep access depend on the rep being responsive.
  Process risk, not a tech risk.

### Option B: Public unauthenticated form

**Pros:**
- Workers can submit without going through a rep.

**Cons:**
- Spam, enumeration of committee existence.
- Submission from employer network has all the IP/header risks.
- Requires CAPTCHA → third-party processor.
- Worse privilege posture.

### Option C: Email-to-app intake

**Pros:**
- Familiar.

**Cons:**
- Email is the worst possible privacy channel for this content;
  contents pass through SMTP relays, anti-spam, mailbox providers.

## Decision

**We choose Option A — locked.**

### Rationale

Locked by plan §13. The ADR records the rationale and the constraints:
- No public route exists in the app — confirmed by route inventory in CI.
- Concerns table RLS denies INSERT unless `committee_membership.active = true`.
- "Anonymous source" toggle in the rep's form defaults to ON.
- Name field, when present, is encrypted client-side before submission.

### Reversibility

**Hard.** Opening a public surface later would be a v2 design exercise
with a fresh threat model. Don't.

## Consequences

### Positive
- Tiny attack surface.
- Privilege intact.
- T8 (account enumeration) addressed structurally.

### Negative / accepted tradeoffs
- Workers must reach a rep to submit. Mitigated by "How to raise a
  concern" doc the committee distributes off-app.

## Compliance check

- [x] No public PI ingress.
- [x] Anonymous-by-default per PIPEDA proportionality.

## Follow-ups

- [ ] T08 — intake form built with anonymous toggle defaulted ON.
- [ ] Route inventory test in CI fails on any new public POST route.

---

## Amendment: Reprisal-log intake consent surface (2026-05-22, amendment pass #3, HG-13 cross-reference)

**Amends ADR-0007** above. Trigger: privacy-review §2.4 (draft consent-surface copy) / §5 fold-in item 2 / §7 test obligation 5 (consent surface presence). Cross-references **ADR-0003 Amendment D** (pseudonymized reprisal-feed projection — the consent surface names what other members will and will NOT see, which is the visible behaviour Amendment D ratifies) and **HG-13** (architect-owned gate covering Amendment D + this consent surface).

**Why ADR-0007 (and not a new ADR-0016).** Reprisal-log intake is procedurally an extension of concern intake: the rep mediates submission on behalf of the affected worker; same auth gate (committee-members-only); same anonymous-toggle pattern (the reprisal entry itself carries an author rather than an anonymous-source toggle, but the same "members-only intake, no public form" posture). Extending ADR-0007 keeps the architectural shape one decision instead of two and matches the privacy-reviewer's recommendation in §5.

**Scope of this amendment.** The reprisal-log intake form (Surface C in the design system) MUST render a consent surface to the submitting rep BEFORE the "Save entry" button becomes enabled. The consent surface names what is encrypted, what other active committee members will see in the recent-activity feed (per ADR-0003 Amendment D pseudonymized projection), what they will NOT see, why the feed exists at all (social-norm backstop against coerced authorship — Amendment D §rationale), and the OHSA s.50 reprisal-protection reminder.

**Draft consent-surface copy (verbatim from privacy-review §2.4; for the labour-lawyer review under HG-10 and accessibility-specialist sign-off):**

> **Before you log a reprisal**
>
> A reprisal entry is the most sensitive record this app holds. Here is exactly what happens when you save it.
>
> **What is encrypted and only readable by the committee:** the entry body, any names, dates, witnesses, and any details you write or attach. These are sealed to the committee key and never readable by the employer, the hosting provider, or anyone outside the committee.
>
> **What other active committee members will see in the recent-activity feed:** that a reprisal entry exists, when it was created (to the nearest hour), and the reprisal entry's ID. **They will NOT see who created it.** Forensic review can identify the author only after a two-member committee approval, the same way reprisal entries are deleted.
>
> **Why other members see the entry exists:** to deter anyone — including a co-opted committee member — from quietly logging or reading reprisal entries on someone else's behalf. The committee acts as a check on itself.
>
> **What other members will NOT see:** your name, your pseudonym, the content of the entry, or any worker named in the entry.
>
> **OHSA s.50 reminder:** reprisal against you for using this app is itself an OHSA offence. The committee can pursue a s.50 complaint to the Ontario Labour Relations Board.
>
> [ ] I understand what other committee members will see, and I want to save this entry.

The copy lives in `i18n/en-CA/reprisal-intake.json` (or the localization-specialist's chosen surface key per ADR-0009). The architect does not modify `i18n/*` per amendment pass #3 hard rules; the localization-specialist + designer fold this into the catalog on the next pass.

**Architectural contract (binding for the implementer and the test-writer):**

1. **The "Save entry" button is `aria-disabled=true` and the form's submit is gated** until the consent checkbox is checked. The gating is a structural form invariant (the submit handler short-circuits unless the consent flag is true), not a CSS-only disable.
2. **The four "what other members will / will NOT see" bullets MUST be rendered before the consent checkbox.** A snapshot test asserts the i18n key resolves and the four bullets are present in the DOM in their order. Per privacy-review §7 test obligation 5.
3. **The consent surface is rendered every time** the reprisal-entry intake form is opened. No "I've already seen this" suppression flag; the surface re-renders on every intake (the design system's Surface C state machine).
4. **The consent surface is reviewable by screen reader.** WCAG 2.0 AA per JHSC-APP-PLAN.md §9 / `.context/constraints.md` AODA section. The accessibility-specialist signs off on the surface before T13 ships (HG-10 + accessibility-specialist gate, NOT architect-owned).
5. **The labour lawyer (HG-10) reviews the copy** before T13 ships. The copy may evolve through labour-lawyer review; the architectural contract (bullets 1–4 above) does not.

**Out of scope for this amendment (deliberately not decided here):**
- The exact final wording is **not** an architect decision; the labour-lawyer's review (HG-10) and the accessibility-specialist's plain-language review own the final copy. This amendment ratifies the architectural shape (the gating, the four-bullets contract, the per-intake re-render).
- The visual treatment of the consent surface is the designer's, per the design system Surface C spec.

**Reversibility:** **Easy** on copy text (one i18n catalog key). **Medium** on the structural gating (the submit-handler short-circuit pattern + the snapshot test); **Hard** on the architectural posture that "reprisal intake requires informed consent at every intake" — reversing this would re-introduce the PIPEDA Principle 4.3.6 gap that privacy-review Q1 identified.

**Compliance check additions:**
- [x] PIPEDA Principle 4.3 (Consent), 4.3.6 (sensitivity-appropriate consent) — informed, meaningful, per-intake consent for C4 disclosure.
- [x] PIPEDA Principle 4.4 (Limiting Collection) — the consent surface names exactly what disclosure occurs.
- [x] PIPEDA Principle 4.5 (Limiting Use, Disclosure, Retention) — disclosure scope (pseudonymized feed projection per Amendment D) is the narrowest viable.
- [x] OHSA s.50 — reprisal-protection reminder named in the surface.
- [x] WCAG 2.0 AA / AODA — accessibility-specialist sign-off (HG-10 + AODA gate, NOT architect-owned).

**Cross-references:**
- **ADR-0003 Amendment D** — the architectural mechanism (pseudonymized projection view) the consent surface names as "they will NOT see who created it."
- **ADR-0003 Amendment E** — the forensic-reveal 4-eyes procedure the consent surface names as "Forensic review can identify the author only after a two-member committee approval."
- **HG-10** — labour-lawyer + privacy-lawyer review (already pre-launch per plan §13).
- **HG-13** — architect-owned gate covering Amendment D + this consent surface (see amendment pass #3 summary).
- **privacy-review §2.4 (copy draft) / §5 fold-in item 2 / §7 test obligation 5.**

**Follow-ups (T13 acceptance amended — see Task-list amendments at end):**
- [ ] **T13 acceptance amended** — the four-bullets snapshot test + the structural gating test on the submit button + the per-intake re-render test.
- [ ] **localization-specialist (next pass):** adds `reprisal-intake` i18n keys to `i18n/en-CA/` catalog with the §2.4 copy (subject to labour-lawyer review).
- [ ] **designer (next pass):** Surface C spec covers the consent surface placement, the four-bullets layout, the consent-checkbox + "Save entry" gating UX.
- [ ] **accessibility-specialist (HG-10-adjacent gate):** WCAG 2.0 AA review of the consent surface before T13 ships.
- [ ] **labour-lawyer (HG-10):** review and ratify the §2.4 copy.

---

# ADR-0006: Frontend framework — SvelteKit

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** architect

## Context

Plan §5.2 leaves the choice between SvelteKit and Next.js 15 App Router
to the architect. Both are credible TypeScript-first frameworks with
PWA stories, both work fine on top of Supabase. The choice has
medium reversibility (a sprint to swap, plus a re-test of every page) so
we should commit and justify.

The app is:
- Mobile-first, PWA-installable, offline-capable for inspections.
- ~10–20 distinct screens at launch.
- Built by a team of one + the agent pack.
- Performance-sensitive on shop-floor devices (older Android, weak signal).
- E2EE-heavy — client-side crypto runs on hot paths.

## Decision drivers

- PWA story (manifest, service worker, install prompt).
- Bundle size on first paint (shop-floor users on weak networks).
- Mental-model simplicity for a team of one.
- Compatibility with libsodium-wrappers (WASM) on the client.
- Server-side rendering for the small set of authenticated SSR pages
  (auth callback, share-link landings if any) — both options handle this.
- Long-term maintainability and ecosystem health.

## Options considered

### Option A: SvelteKit (v2+)

**Description:** Svelte components + SvelteKit's file-based routing,
adapter-static or adapter-node deployment, Vite under the hood. Service
worker via Workbox or hand-rolled. Stores for client state.

**Pros:**
- **Bundle size:** typically 40–60% smaller than equivalent Next routes
  for similar UX. On a shop floor with weak signal, this matters.
- **Mental model:** runes/stores are simpler than RSC + Server Actions
  + Client Components. One mental boundary (server vs. client) instead
  of three (server-component vs. client-component vs. server-action).
- **PWA story:** SvelteKit's service-worker integration is first-class;
  the `service-worker.ts` file is a documented hook.
- **libsodium-wrappers:** runs cleanly client-side; no RSC/streaming
  pitfalls.
- **Forms-first:** SvelteKit's form actions are the natural fit for the
  intake/inspection flows; progressive enhancement out of the box.

**Cons:**
- **Smaller ecosystem** than React. Some niche libraries (e.g., a
  fancy table) don't exist; we either roll our own or pick a less-
  loved alternative. For this app the component set is small and we'd
  build it ourselves anyway.
- **Smaller talent pool** if the team grows. Mitigated: not growing in
  v1; component model is easy enough to onboard.

### Option B: Next.js 15 App Router

**Description:** React 19 + RSC + Server Actions, Vercel-or-Node deploy,
service worker bolted on.

**Pros:**
- Largest ecosystem.
- Server Components reduce some client JS for read-only pages.
- React talent pool huge.

**Cons:**
- **RSC complexity** adds mental load — "is this a client component?
  why is this hook erroring? what's serializable across the boundary?"
  For a team of one, this is real cognitive tax.
- **Bundle size** is larger out of the box; RSC helps for static-ish
  pages but our pages are almost all interactive (forms, crypto).
- **libsodium + RSC:** WASM in client components is fine, but the
  client/server split makes it easy to accidentally pull crypto into a
  server bundle where it shouldn't be.
- **Vendor pull:** Next is increasingly Vercel-flavored; we're not on
  Vercel (we're on Supabase + Cloudflare Pages or Netlify-like). Works,
  but more friction than the framework's "default" path.
- **Service worker:** less first-class than SvelteKit's.

### Option C: Remix / React Router v7

**Description:** React framework focused on forms + progressive
enhancement.

**Pros:**
- Forms-first philosophy aligns with our intake/inspection flows.

**Cons:**
- The Remix → React Router merger is recent; ecosystem in flux.
- Same RSC-direction signals as Next; less stable.

## Decision

**We choose Option A: SvelteKit.**

### Rationale

Three decisive factors:
1. **Bundle size on weak networks** is a real shop-floor constraint.
2. **Mental simplicity for a team of one** — SvelteKit has one
   client/server boundary; Next has three.
3. **Crypto on the client without RSC footguns** — libsodium runs hot
   in this app; we don't want to fight the server/client split.

Ecosystem size doesn't matter for an app this size; we build our own
small component set anyway and the table of dependencies is short.

### Reversibility

**Medium.** Migrating to Next later would be a sprint or two — same
data layer, same Supabase, same crypto core. Components rewrite, but
the app surface is small. Don't migrate without a stated reason.

## Consequences

### Positive
- Smaller bundles → faster first paint on shop-floor devices.
- Simpler mental model → fewer bugs from team-of-one churn.
- First-class PWA + service worker story.
- libsodium client-only, no server-bundle leakage risk.

### Negative / accepted tradeoffs
- Smaller talent pool if we ever hire.
- Some libraries don't exist; build or find alternatives.

### Risks
- A future maintainer doesn't know Svelte. Mitigated: the agent pack
  knows it; Svelte's learning curve is gentle.
- SvelteKit major-version breaking changes. Mitigated: pin, upgrade
  deliberately, dependency-manager weekly.

## Compliance check

- [x] No new third-party PI processor implied by framework choice.
- [x] Service worker hosted on our origin (no CDN of someone else's JS).
- [x] CSP can be locked down (no inline-eval needed by SvelteKit prod build).

## Follow-ups

- [ ] T01 — scaffold SvelteKit with `adapter-static` (since auth is
      Supabase-side and most routes are client-rendered after login)
      OR `adapter-node` if SSR for auth callbacks is needed. Decide
      during scaffold based on final auth-callback shape.
- [ ] Designer's tokens emitted as CSS custom properties — framework-
      agnostic, easier to port if we ever reverse this.

---

# ADR-0005: Single-tenant v1 — no multi-committee paths in code

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** user (locked in plan §13 item 1), architect ratifying

## Context

Plan §13 locks the workplace context as one JHSC, one workplace (50+
workers, single site). Plan §5.1: "Multi-tenant code paths are
intentionally **not** built in v1; if a second committee adopts later,
that's a v2 project."

The temptation to build "tenant_id everywhere, just in case" is real
and exactly what the constraints warn against ("no premature
genericness").

## Decision drivers

- Smallest possible attack surface.
- Simplest RLS policies (no `current_setting('app.tenant_id')` ceremony).
- No "noisy neighbor" reasoning about multi-tenancy.
- Future second-committee adoption = v2 design exercise with fresh threat
  model, fresh ADR, fresh data-segregation work.

## Options considered

### Option A: Single-tenant (locked)

**Description:** One Supabase project, one committee. Tables don't have
`tenant_id`. RLS policies key off `committee_membership.user_id =
auth.uid()`.

**Pros:**
- Minimal RLS surface.
- No cross-tenant exposure possible by construction.
- Easier audit.

**Cons:**
- Adding a second committee later = new Supabase project + onboarding
  process, OR a real multi-tenancy refactor. Either is a v2 project.

### Option B: Multi-tenant with `tenant_id` everywhere

**Pros:**
- "Future-ready."

**Cons:**
- Every table grows a column we don't need.
- Every RLS policy gains a join.
- Risk of a missing `WHERE tenant_id = ...` somewhere is the highest-
  severity bug class in multi-tenant SaaS.
- We're not selling this. The "future" isn't a market — it's at most a
  second pilot in two years.

## Decision

**We choose Option A — locked.**

### Rationale

Per plan §13. The smallest attack surface in v1 is the right one. If a
second committee ever adopts, we re-design with the benefit of having
operated v1.

### Reversibility

**Hard** to add multi-tenancy retroactively, **easy** to spin up a second
Supabase project for a second committee (n=2 is fine; not many committees
will adopt).

## Consequences

### Positive
- RLS policies stay short and reviewable.
- Onboarding = one committee key, period.

### Negative / accepted tradeoffs
- Second-committee adoption is a project, not a config.

## Compliance check

- [x] Aligns with "no premature genericness" in constraints.

## Follow-ups

- [ ] `KNOWN-GAPS.md` notes multi-tenancy as v2.

---

# ADR-0004: Row-Level Security on every table — mandatory, policies version-controlled

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** architect

## Context

Plan §5.2 lists RLS as mandatory. Supabase's defining feature for our
use case is Postgres RLS enforced at the database level — even a bug in
app code can't bypass it. This ADR ratifies that RLS is the **authoritative**
authorization layer, that every table without exception has policies, and
that policies live in version-controlled migrations next to schema.

## Decision drivers

- Defense in depth: app bug = no data leak if RLS holds.
- Auditability: policies are SQL files in the repo, reviewable per PR.
- Migration discipline: policies move with schema, never out of sync.
- Test-writer can write policy tests against a real Postgres.

## Options considered

### Option A: RLS on every table, policies as SQL in `drizzle` migrations

**Description:** Every `CREATE TABLE` migration includes a
`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and one or more
`CREATE POLICY` statements. No table can ship without policies.
A CI check fails if any table is missing RLS.

**Pros:**
- Authoritative at the data layer.
- Reviewable in PRs.
- Survives any app-layer bug.

**Cons:**
- More SQL to read.
- Policies must be tested (we will — test-writer covers).

### Option B: RLS on PI tables only; app-layer authz elsewhere

**Pros:**
- Less SQL.

**Cons:**
- "Elsewhere" is exactly where a bug will land.
- Two authz models = bugs at the seam.

### Option C: App-layer authz only (RLS off)

**Pros:**
- Familiar.

**Cons:**
- Loses Supabase's central value-prop for this use case.
- App-layer bug → data leak.

## Decision

**We choose Option A.**

### Rationale

This is the defining safety property of Supabase + RLS, and the entire
threat model leans on it. App code is allowed to bug; RLS is not.

**Operational rules:**
- Every `CREATE TABLE` migration in the same file includes RLS + policies.
- `verify.sh` includes a check: `SELECT relname FROM pg_class WHERE
  relkind='r' AND relrowsecurity=false AND relnamespace = ...` returns
  zero rows in CI.
- Test-writer writes policy tests for every table: positive (the right
  user can read) and negative (the wrong user cannot).
- Policy changes go through the same review as schema changes —
  migration-handler + security-reviewer.

### Reversibility

**Hard** to remove RLS once data is there (we'd be removing the safety
property). Not a thing we'd reverse.

## Consequences

### Positive
- Bugs in app code don't become data leaks.
- Policies are reviewable artifacts.

### Negative / accepted tradeoffs
- More SQL per migration.
- Test-writer's load grows with each table.

### Risks
- Performance hit from policy joins. Mitigated by sensible indexes (every
  policy that uses `committee_membership` joins through an indexed FK).

## Compliance check

- [x] Aligns with constraints.md "least privilege."
- [x] Auditable.

## Follow-ups

- [ ] T04 — RLS-coverage check in `verify.sh`.
- [ ] Test-writer policy-test pattern documented in scaffold task.

---

# ADR-0003: E2EE key model — per-user identity + per-committee data key

**Status:** Accepted — **Amended 2026-05-22 (HG-2 + HG-6)**
**Date:** 2026-05-22 (original); amendment 2026-05-22
**Decider(s):** user (locked in plan §13 item 9), architect ratifying; amendments per HG-2 + HG-6, user-approved

**Amendment note (2026-05-22):** two amendments at the end of this ADR.
1. **HG-2 amendment** adds **Invariant 8** (key-material mutation audit-log enum) — trigger F-07 / O-12 / threat-model §6 "Additional invariant to add".
2. **HG-6 amendment** strengthens **Invariant 7** (C4 second-decrypt audit) to require server-side enforcement via a `SECURITY DEFINER` view, closing the client-cooperative-logging gap — trigger F-33 / O-14 / threat-model §6 Invariant 7 strengthened.

Original invariants 1–7 text is preserved verbatim; amendments add testable strengthenings.

## Context

Plan §5.3 specifies the key model in detail. This ADR ratifies the choice
and writes down the **invariants** that downstream agents must not violate.
This is the load-bearing mitigation for the Supabase hosting tradeoff
(ADR-0001); if E2EE leaks plaintext to the server, the hosting choice is
no longer defensible.

## Decision drivers

- Server never sees plaintext for C3/C4 data.
- Per-user identity so removing a user is meaningful.
- Per-committee data key so all members can read shared content.
- Rotation on member removal (forward secrecy from the removed member).
- Recovery from device loss without weakening the model.

## Options considered

### Option A: Per-user identity + per-committee data key, wrapped per member (locked)

**Description:**
- Each user generates an X25519 identity keypair client-side at first login.
- Private key encrypted with a passkey-derived secret + stored locally
  in IndexedDB. A backup blob is stored on the server, encrypted with a
  user-supplied recovery passphrase the user prints.
- Each committee has an X25519 data keypair. The data private key is
  wrapped once per active member to that member's identity public key
  (libsodium `crypto_box_seal`), stored on the server.
- C3 records are encrypted to the committee public key using
  `crypto_box_seal` (anonymous-sender sealed box).
- C4 records add a per-record symmetric key (libsodium `secretbox`)
  whose key is also wrapped to the committee key — so unsealing C4
  requires unsealing the per-record key first, giving a separate
  decryption step the audit log captures.
- Member removal: a remaining member re-generates the committee data
  keypair, re-encrypts all existing wrapped blobs to all remaining
  members' identity public keys, and revokes the removed member's
  passkey/session. New records use the new key. Old ciphertext keeps
  the old wrap chain but the removed member's wrapped copy is deleted.

**Invariants (the threat-modeler will turn these into tests):**

1. **Server never sees a private key in the clear.** Identity privates
   exist client-side or as ciphertext-on-server. Committee data privates
   exist only as wrapped blobs.
2. **No "admin recovery."** There is no server-side mechanism to recover
   a forgotten passphrase + lost device. (Documented in onboarding.)
3. **No plaintext caching server-side**, including in Edge Functions.
   Edge Functions handle ciphertext, metadata, and notifications only.
4. **All encryption is libsodium primitives** — no homegrown crypto, no
   AES-GCM hand-rolled. `libsodium-wrappers` is the only crypto library.
5. **Key material in URLs is forbidden** — semgrep rule.
6. **Rotation is atomic** — either the new wraps are present for all
   remaining members and old member's wrap is gone, or the operation
   fails and is retried. (Migration-handler enforces.)
7. **C4 records require a second decrypt step** logged in the audit log
   (which is C1, not encrypted, so the metadata is reviewable).

### Option B: Per-user keys only; no committee key (each record encrypted N times)

**Description:** Each shared record is encrypted to every committee
member's public key.

**Pros:**
- No "committee key" rotation problem.

**Cons:**
- Storage explodes (N copies of every blob).
- Adding a new member requires re-encrypting every record they should
  see, in their browser, at invite time. UX nightmare on 1000+
  records.
- Removing a member requires re-encrypting nothing — the record stays
  encrypted to their old key. **No forward secrecy from the removed
  member**. Worse than Option A.

### Option C: Server-side encryption only (no E2EE)

**Pros:**
- Standard, simple.

**Cons:**
- Defeats the entire point of the design. Plan §1 says explicitly that
  the server's compromise must not reveal worker-side content.

## Decision

**We choose Option A — locked.**

### Rationale

Locked by plan §13. Option B fails forward secrecy. Option C invalidates
the hosting tradeoff. Option A is the only viable path; the invariants
above are non-negotiable.

### Reversibility

**Hard.** Once data is encrypted under this model, switching models means
re-encrypting all data through every user's browser. Decide once, get
it right.

## Consequences

### Positive
- Server compromise yields ciphertext only for C3/C4.
- Removal rotation gives forward secrecy from removed members.
- Audit log can record decryption attempts (per-record key access).

### Negative / accepted tradeoffs
- No admin recovery; lost passphrase + lost device = lost user.
- Client crypto on hot paths (manageable; libsodium-wrappers WASM is fast).
- Rotation is a complex operation; needs careful testing.

### Risks
- Implementation bug leaks plaintext to server. Mitigated by:
  - second-opinion-reviewer on every PR touching crypto;
  - integration test asserting all writes to C3/C4 columns are well-
    formed ciphertext (entropy + nonce check);
  - semgrep rule banning `fetch(...)` of a known-plaintext type to a
    Supabase endpoint from outside the encryption module.
- Recovery passphrase loss → user data loss. Mitigated by enrollment
  flow that forces the user to print AND verify the passphrase before
  exiting setup.
- Rotation race conditions on member removal. Mitigated by serializing
  rotations through an Edge Function that takes a per-committee
  advisory lock.

## Compliance check

- [x] Aligns with PIPEDA Safeguards (Principle 7).
- [x] Aligns with constraints.md (AES-256+, E2EE on sensitive worker
      content per plan).
- [x] Reduces residual exposure of ADR-0001.

## Follow-ups

- [ ] T05 (auth) precedes T07 (crypto core).
- [ ] T07 second-opinion-reviewer is mandatory.
- [ ] Threat-modeler verifies invariants 1–7 as testable assertions.

---

## Amendment A (2026-05-22, HG-2): Invariant 8 — Key-material mutation audit-log enum

**Amends ADR-0003** above. Trigger: threat-model F-07 (re-wrap or rotation lacks attribution) / O-12 / §6 "Additional invariant to add". Without an explicit audit-log enum for key mutations, forensic questions ("who re-wrapped for member N? when? in which rotation?") cannot be answered, and a co-opted member (A3) can mutate key material with low traceability.

### Invariant 8 — Key-material mutations have a defined audit-log enum

**Testable invariant (canonical wording):** *"Every mutation of key material — identity-keypair generation, identity-private-key recovery-blob write or restore, committee-data-key wrap creation, committee-data-key unwrap (read of own wrap), committee-data-key rotation lifecycle, and member-revocation key teardown — emits exactly one audit-log row drawn from a closed enum, hash-chained to the previous audit row, with actor_id, target ids, and rotation_id where applicable."*

**Audit-log enum values (closed allowlist; appended to the existing audit-log `action` enum, not replacing):**

| Enum value | When emitted | Required fields |
|---|---|---|
| `identity_keypair.created` | New user generates their identity keypair at first-login enrollment (per §2.1 of threat model). | `actor_id`, `target_user_id` (= actor), `ident_pubkey_fingerprint` |
| `identity_privkey.recovery_blob.written` | User completes recovery-passphrase enrollment and posts the wrapped privkey backup (F-08 pipeline). | `actor_id`, `target_user_id`, `kdf_params_version` |
| `identity_privkey.recovery_blob.restored` | User triggers passphrase-based recovery to restore identity privkey on a new device. | `actor_id`, `target_user_id`, `device_fingerprint` |
| `committee_data_key.wrapped_for_member` | An existing member wraps the committee data privkey for a new (or re-added) member. | `actor_id`, `target_member_id`, `committee_key_id`, `rotation_id?` |
| `committee_data_key.unwrap` | A member opens their own wrap to recover the committee privkey for the session (the "read your own wrap" path). | `actor_id`, `committee_key_id` |
| `committee_data_key.rotation.started` | First step of rotation: advisory lock acquired, new keypair generated. | `actor_id`, `committee_key_id_prev`, `committee_key_id_next`, `rotation_id`, `trigger` ∈ {`member_removal`,`scheduled`,`incident`} |
| `committee_data_key.rotation.completed` | Final step of rotation: new wraps in place for all remaining members; previous wraps in `committee_key_history`. | `actor_id`, `committee_key_id_prev`, `committee_key_id_next`, `rotation_id`, `members_rewrapped_count` |
| `committee_data_key.member_revoked` | The removed member's wrap row is deleted (atomic with rotation per Invariant 6). | `actor_id`, `removed_member_id`, `committee_key_id`, `rotation_id` |

**Testable assertions (T07 + T18 acceptance amended — see Task-list amendments at end):**
- For each enum value above, fire the corresponding flow in an integration test and assert exactly one audit-log row appears with that action, the required fields populated, and a valid `prev_hash` linking to the previous row.
- Negative: corrupt the audit-log emission path for `committee_data_key.rotation.completed`; assert the rotation flow is aborted (audit emission is a precondition, not a side effect).
- Coverage: every code path that mutates `committee_key.*`, `users.identity_pubkey`, or `users.identity_privkey_recovery_blob` is grepped in CI; any path not paired with an emission of one of the enum values fails CI.
- Alerting: per F-50 / T18, the audit-log integrity check job alerts on (a) gaps in the enum sequence within a `rotation_id` (e.g., `started` without a matching `completed` within 5 minutes), (b) any `committee_data_key.member_revoked` without a paired `rotation.completed` in the same `rotation_id`, (c) any `committee_data_key.wrapped_for_member` for a `target_member_id` who is not `committee_membership.active = true` at the time of emission.

**Reversibility:** Easy on enum values (additive); medium on retroactive recoverage (would require migration of existing audit rows — none at time of amendment).

**Compliance check additions:**
- [x] PIPEDA Principle 9 (Individual Access) — key-material events are part of "what was done with your data" attribution.
- [x] Strengthens T4 (insider compromise) detection surface.

### Amendment A (extended 2026-05-22, F-C / observability-setup pass #2): chain-emission vs structured-log-event vocabulary split + C3 read enum additions

**Why amended again:** observability-setup pass #2 surfaced two enum gaps and one architectural question about what the audit-log chain is *for*. The strengthening below resolves both.

**The architectural rule (declared explicitly here, so downstream agents stop deriving it from context):**

> *"The tamper-evident hash-chained audit log captures **trust-changing** events: key-material mutations, C3/C4 reads, destructive ops on C4, exports, retention deletions, integrity-relevant cache and queue failures, and the alert-pipeline echo. High-frequency volumetric telemetry — including but not limited to per-request authentication assertions — does NOT participate in the hash chain and lives only in the structured-log surface (observability/logging.md). The chain is a forensic record, not an activity stream."*

This rule is the closed test: any new event proposed for audit-log emission MUST be classifiable as trust-changing under the criteria above OR be downgraded to structured-log-only. The verifier enforces this by reading the chain-emission enum as a closed allowlist (CHECK constraint per audit-log.md §1) and by treating any code path that calls `audit_emit(...)` with a value not on the allowlist as a CI failure.

**Enum additions (chain-participating; appended to the closed allowlist):**

| Enum value | Class | When emitted | Required fields |
|---|---|---|---|
| `work_refusal.read` | C3 read (T14) | Server-emitted from the `SECURITY DEFINER` view `work_refusal_read_audited`, atomic with the SELECT (same enforcement shape as Amendment B). | `work_refusal_id`, `read_via` ∈ {`security_definer_view`,`edge_fn_indirection`} |
| `s51_evidence.read` | C3 read (T14) | Server-emitted from the `SECURITY DEFINER` view `s51_evidence_read_audited`, atomic with the SELECT. | `s51_evidence_id`, `read_via` ∈ {`security_definer_view`,`edge_fn_indirection`} |

These two values bring T14's `work_refusal` and `s51_evidence` C3-read paths under the same server-enforced indirection as Amendment B's `reprisal.read` (HG-6). T14 acceptance is amended accordingly (see Task-list amendments at end). The audit-log spec (`observability/audit-log.md` §1) already anticipates this extension; this amendment ratifies it as part of the closed enum.

**Structured-log-only event vocabulary (NOT chain-participating; documented here so the boundary is unambiguous):**

The following events are emitted via the structured logger (`observability/logging.md` §2 / §3) only. They do NOT call `audit_emit(...)`. They do NOT appear in `audit_log`. Attempts to add them to the chain-emission allowlist fail CI.

| Structured-log event | Why structured-log-only | Where it lives |
|---|---|---|
| `auth.passkey.assert` | High-frequency per-request authentication assertion. Volumetric (every request that performs WebAuthn assertion emits one). The trust-changing auth events — `auth.passkey.enrolled`, `auth.passkey.revoked`, `session.revoked` — DO chain-participate (already in the audit-log §1 Auth + session enum); the per-request assertion does not. | `observability/logging.md` §3 "Auth (T05)" — `auth.method`, `auth.result`, `auth.session_id_pseudonym` attributes on a structured-log line at INFO level. |

Other high-frequency events that are NOT chain-participating include: rate-limit-hit events, retry-success events, cache-hit telemetry, feature-flag-evaluation events. These are NOT exhaustively enumerated here (the negative space would be infinite); the rule is the architectural rule stated above, and the verifier's CHECK constraint on `audit_log.event_type` is the structural enforcement.

**Testable assertions (added to T07/T14/T18 acceptance — see Task-list amendments at end):**

- *Closed-enum coverage:* an integration test enumerates every code path that calls `audit_emit(...)` and asserts each `event_type` argument is on the closed allowlist. Any new caller introducing a non-allowlisted value fails CI.
- *Volumetric-event exclusion:* an integration test executes 100 successful WebAuthn assertions and asserts zero new rows in `audit_log` with `event_type = 'auth.passkey.assert'` (this value never reaches the chain). Counter-test: assert 100 structured-log lines with `event = 'auth.passkey.assert'` were emitted at INFO level.
- *T14 server-enforced C3 read:* identical test shape to Amendment B's HG-6 tests, applied to `work_refusal_read_audited` and `s51_evidence_read_audited`. Direct SELECT bypass returns zero rows + no audit row; indirection success returns exactly one corresponding `work_refusal.read` / `s51_evidence.read` row with same-transaction timestamp; atomicity failure rolls back both.

**Reversibility:** Easy on enum values (additive). The chain-vs-structured-log architectural rule is *hard* to reverse — moving a high-frequency event into the chain would explode storage and erode the chain's forensic value; we won't.

**Compliance check additions:**
- [x] PIPEDA Principle 4 (Limiting Collection) — volumetric telemetry stays in the time-bounded log retention (7 days on Supabase Edge logs per `observability/README.md` §1), not in the 24-month audit-log retention. Less data, longer-lived, only where the data matters.
- [x] Strengthens T4 (insider compromise) detection surface on T14 paths (matches Amendment B's posture on T13).

---

## Amendment B (2026-05-22, HG-6): Invariant 7 strengthened — server-side enforced C4 read-audit

**Amends ADR-0003** above. Trigger: threat-model F-33 (Reprisal-log read not surfaced as a sensitive event because the audit-log write is bypassed by a malicious or buggy client) / O-14 / §6 Invariant 7 strengthened.

### Invariant 7 (strengthened) — C4 read-audit is server-side enforced, in-transaction

**Original Invariant 7 wording (preserved):** "C4 records require a second decrypt step logged in the audit log."

**Strengthened wording (replaces the operational reading of Invariant 7):**

*"Every read of a C4 row writes a `sensitive.read` audit-log row in the same database transaction as the SELECT, regardless of client cooperation. Direct SELECT on the underlying C4 table is revoked from every Postgres role except a single `c4_read_service` role used only by the indirection layer. Clients access C4 rows exclusively through a `SECURITY DEFINER` view (or equivalent Edge Function indirection) that performs the SELECT and the audit-log INSERT atomically; failure of either step rolls back both. Bypassing the indirection layer with any other role's JWT returns zero rows (RLS + GRANT-revoke)."*

**Operational implementation:**

1. **Underlying C4 tables (`reprisal_log`, `work_refusal`, `s51_evidence`):** `REVOKE SELECT ON ... FROM authenticated, anon, service_role` (i.e., every public-API-reachable role). The only role with SELECT is `c4_read_service`, a non-login role created by migration, owned by `migration_role`.
2. **Indirection layer:** a `SECURITY DEFINER` view per C4 table (e.g., `reprisal_log_read_audited`) owned by `c4_read_service`. The view's SQL is:
   ```sql
   -- pseudo-SQL; final form in T13 migration
   CREATE VIEW reprisal_log_read_audited
   WITH (security_invoker = false) -- definer
   AS
   SELECT r.*,
          jhsc_log_sensitive_read('reprisal_log', r.id, auth.uid()) AS _audit_token
   FROM   reprisal_log r
   WHERE  jhsc_caller_can_read_reprisal(r.id, auth.uid()); -- existing RLS predicate inlined
   ```
   `jhsc_log_sensitive_read(...)` is a `SECURITY DEFINER` function owned by `c4_read_service` that INSERTs a `sensitive.read` row into `audit_log` (action enum unchanged from original spec) with `{actor_id, target_table, target_id, ts}` and returns a non-null token (the function side-effect is the audit; the return value is discarded by the client). The function raises and rolls back if the INSERT fails, which rolls back the enclosing transaction — so a failed audit emission means the read does NOT return data.
3. **GRANT shape:** `GRANT SELECT ON reprisal_log_read_audited TO authenticated;` — clients SELECT from the view; the view's `SECURITY DEFINER` posture runs as `c4_read_service` which holds the underlying SELECT. No direct table SELECT path exists for clients.
4. **RLS on the view:** RLS predicates that previously gated `reprisal_log` (`author OR co-chair OR certified_member`) are inlined into the view's WHERE clause via `jhsc_caller_can_read_reprisal(...)`. A caller who is not authorized sees zero rows AND no audit row is emitted (the WHERE filters before the function call).
5. **Alternative: Edge Function indirection.** If a view-based path proves limiting (e.g., for paginated reads with row counts), an Edge Function `/api/sensitive/read` may be used instead, with identical semantics: it executes inside a single Postgres transaction, calls `jhsc_log_sensitive_read` and then SELECTs from the underlying table via the `c4_read_service` connection. The Edge Function never sees plaintext (per Invariant 3); it streams ciphertext through.
6. **No client-trusted audit.** The previous "client POSTs the audit row before rendering plaintext" pattern is **removed** as a primary control; if retained at all, it is only as a hint for "intent to read", not the canonical audit. The canonical audit row is the server-emitted one inside the SELECT transaction.

**Testable assertions (T13 acceptance amended — see Task-list amendments at end):**

- *Direct-SELECT bypass test:* with a valid member JWT, attempt `SELECT * FROM reprisal_log` directly (bypassing the view). Assert zero rows returned (GRANT-revoke holds) and no audit row written.
- *Indirection-path success:* SELECT from `reprisal_log_read_audited` with an authorized member's JWT. Assert (a) row returned, (b) exactly one `sensitive.read` audit-log row appears with the matching `target_id` and `actor_id` and the same transaction's timestamp.
- *Atomicity test:* simulate a `jhsc_log_sensitive_read` failure (e.g., revoke INSERT on audit_log to `c4_read_service` for the test); assert the SELECT rolls back and the client receives an error; no row returned, no partial audit.
- *Bypass via Edge Function:* if used, the Edge Function path is covered by the same three tests.
- *Coverage:* `pg_proc` enumeration in CI asserts every C4 table has a corresponding `*_read_audited` view (or documented Edge Function) and that the underlying table's SELECT GRANT is empty for `authenticated`, `anon`, `service_role`.
- *F-50 alerting:* if the daily audit-log integrity job detects a row in `reprisal_log` SELECT-able by the audit-log query but with no matching `sensitive.read` row for that read window, it alerts (defense-in-depth check; should be zero matches in practice).

**Reversibility:** Medium. The view + role layer is straightforward to refactor, but reverting to client-cooperative logging would be a security regression we wouldn't do.

**Compliance check additions:**
- [x] T11 (compelled access detection) materially strengthened: a coerced member cannot bypass the audit by tweaking the client.
- [x] T4 (insider compromise) detection surface strengthened: server-emitted audit is the source of truth.

---

## Amendment C (2026-05-22, F-G / a11y A-2): Protected-modal focus trap is synchronous with mount — coercion-resistance invariant

**Amends ADR-0003** above. Trigger: a11y review Advisory A-2 (`.context/a11y-review.md` §A-2) — the reduced-motion fallback for `modal_enter` collapses to a 100ms opacity transition; on the five **protected modals** (`export_interstitial`, `reauth_prompt`, `passphrase_prompt`, `destructive_confirm`, `four_eyes_pending`), even a 100ms gap between mount and focus-trap engagement is a window in which a scripted dismissal can race the user. This is cross-cutting: it is an accessibility correctness issue AND a coercion-resistance issue, and it affects how the threat-modeler's RA-1 compensating controls (export interstitial), HG-6 surfaces (sensitive-read prompts), and HG-7 surfaces (4-eyes "needs second member" UX) actually behave under attack.

The threat-modeler is running a parallel second pass to confirm the threat-model implications; the architectural invariant below is independently load-bearing and ratified here so downstream agents (designer, design-system spec, test-writer, implementer) have an authoritative pointer.

### Invariant 9 — Protected-modal accessibility and coercion-resistance behavior is synchronous with mount

**Testable invariant (canonical wording):** *"For every modal in the protected-modal list (`export_interstitial`, `reauth_prompt`, `passphrase_prompt`, `destructive_confirm`, `four_eyes_pending`), the focus trap engages, the `aria-labelledby` is announced, and Escape / backdrop-click handlers are bound **synchronously with mount** — i.e., during the same task tick that adds the modal DOM node. The opacity transition (and any other entrance animation) is decorative and runs independently; it does NOT gate the accessibility or coercion-resistance behavior. The animation may complete before, during, or after focus trap engagement; the user-perceived semantics of "the modal is open" are owned by mount, not by transition completion."*

**Operational rules (binding for the design-system spec, the implementer, and the test-writer):**

1. **Focus trap engages on `modal.show()` (mount), not on `transitionend`.** The implementer wires the focus trap inside the same microtask that inserts the modal node; the focus-trap library's first focusable-element search runs against the just-mounted subtree. The animation (opacity, scale, slide) starts on the next paint and runs without blocking the focus contract.
2. **`aria-labelledby` announcement is synchronous with mount.** Screen readers should announce the modal's title on mount; the announcement does not wait for the entrance animation.
3. **Escape and backdrop-click handlers are bound on mount.** A scripted dismissal of a protected modal during the entrance animation MUST be blocked the same way it would be after the animation completes — the protected-modal list per the design system already specifies that Escape and backdrop-click are *no-ops* on these five variants (they require an explicit dismissal action). That rule applies from mount, not from transition end.
4. **The animation MAY be skipped without changing behavior.** Under `prefers-reduced-motion`, or in a test harness that disables animations, the modal is fully functional with no visible transition. The focus trap is unaffected (it never depended on the transition firing).
5. **Tests assert mount-time behavior.** The test-writer adds, for each of the five protected modals, a test that: (a) mounts the modal; (b) within the same task tick, assertions that the focus trap is active (focus is inside the modal subtree), that `document.activeElement` is the modal's first focusable element, and that a programmatic Escape keydown does NOT close the modal; (c) optionally awaits `transitionend` and re-asserts the same; (d) the assertions in (b) must pass even when animations are disabled (CSS `animation: none !important` test mode).

### Coercion-resistance reading (why this is in ADR-0003 and not only in the design system)

The protected-modal list exists because each of these five modals gates an irreversible or trust-changing action:

- `export_interstitial` — the only egress to B3 (worker/employer boundary). Compensating-control surface for RA-1.
- `reauth_prompt` — the re-auth challenge that RA-1 binds to the act of export (passkey assertion at the moment of action, not stale session).
- `passphrase_prompt` — the per-record passphrase gate for C4 reveals (concern source reveal, reprisal access).
- `destructive_confirm` — the entry point for 4-eyes destructive ops (HG-7 soft-delete gating, T13 destructive ops on C4).
- `four_eyes_pending` — the "needs second member" UX surface for HG-7 status-flip gating and existing T13 4-eyes deletions.

A scripted dismissal that closes any of these modals between mount and transition-end would: (a) bypass the user's deliberate confirmation step, (b) escape the audit-emission path that the modal's confirm-action triggers, (c) for `export_interstitial` specifically, defeat the visible concern-derived-items flag (RA-1 compensating control #3) by closing before the user reads it. Amendment C makes the timing non-negotiable.

The invariant is a hard rule on `protected modals only` — the design system's other modals (informational, non-destructive, non-trust-changing) MAY treat focus on transition-end if a reviewer prefers; the protected list MUST mount synchronously.

### Testable assertions (added to design-system rules and to the test-writer's pre-T11/T13 obligations)

- *Per-modal mount-time test (5 variants):* for each of `export_interstitial`, `reauth_prompt`, `passphrase_prompt`, `destructive_confirm`, `four_eyes_pending`, assert focus inside the modal within the same task tick as mount; assert Escape and backdrop-click are bound and no-op; assert `aria-labelledby` announcement was queued.
- *Animation-disabled run:* same assertions hold when CSS animations are disabled at the test layer (no `transitionend` ever fires; the modal still works).
- *Scripted-dismissal race test (coercion case):* mount the modal, immediately dispatch `keydown: Escape` AND `click` on the backdrop in the same task tick; assert the modal remains open and `document.activeElement` remains inside the modal subtree. Repeat with the animation set to 1000ms to exaggerate the window; same assertion.
- *Synchronous mount of audit prerequisites:* for `export_interstitial`, assert that the audit-emission preflight (the "I confirm this export" handler binding, the `derived_from_concerns` flag rendering — per RA-1 compensating controls) is *also* synchronous with mount; an attacker who races a confirm-click against the entrance transition cannot trigger an export that pre-empts the visible flag.

### Cross-references

- `.context/a11y-review.md` §A-2 (the original finding; advisory in the a11y pass, ratified to invariant here).
- RA-1 in this file (the export interstitial's compensating controls).
- `.context/threat-model.md` parallel second pass (running concurrently; if its conclusions diverge from this invariant, they get reconciled in the next architect pass — but Invariant 9 is independently load-bearing and stands until then).
- The design-system spec at `.context/design-system.md` §3.1, §3.2 (protected-modal list) — the line A-2 recommended adding ("Focus trap engages and `aria-labelledby` is announced on `modal.show()`, not on transition end. The opacity transition is decorative; accessibility behavior is synchronous with mount.") is the user-facing surface of this invariant. The architect does NOT modify design-system.md (per the hard rules of this pass); the designer or design-system-owner folds the language into §3.1 / §3.2 in their next pass, with Amendment C as the pointer.

### Reversibility

**Hard** on the invariant itself (reverting would degrade both accessibility and coercion-resistance). **Easy** on the implementation (the focus-trap binding site is one module).

### Compliance check additions

- [x] WCAG 2.0 AA 2.4.3 Focus Order, 4.1.3 Status Messages (advisory in a11y pass; now structurally enforced).
- [x] T11 (compelled access detection) — the per-record passphrase prompt and the destructive_confirm modal cannot be raced by a scripted dismissal in their entrance window.
- [x] RA-1 compensating control #3 (visible concern-derived-items flag in the export interstitial) — the flag is present and rendered before any confirm action becomes interactable.

### Follow-ups

- [ ] Designer (next pass): fold the Amendment C language into `.context/design-system.md` §3.1 and §3.2; cross-reference this ADR amendment from the protected-modal list.
- [ ] Test-writer (pre-T11/T13): the five mount-time + scripted-dismissal-race tests above land before the corresponding feature implementer touches the protected modals.
- [ ] Implementer (T11, T13): focus-trap library wired at mount, not on `transitionend`; CI tests above are gating.

---

### Amendment C extension (2026-05-22, amendment pass #3, HG-11 / threat-model F-53 M-53a/b/c enumeration)

**Extends Amendment C above.** Trigger: threat-model F-53's three testable mitigations M-53a, M-53b, M-53c (`/home/user/agent-os/.context/threat-model.md` §3.3 lines ~477–484) and **HG-11** (already permanent in threat-model §9). The original Invariant 9 wording covered the "synchronous with mount" property (M-53a). The threat-modeler's second-pass M-53b and M-53c added two additional load-bearing properties — announce-on-open promise gating, and underlying-surface `inert` from t=0 — that the original Amendment C wording did NOT fully capture. This extension enumerates the three sub-invariants explicitly so the test-writer has unambiguous targets.

**The original Invariant 9 wording is preserved verbatim above and remains the high-level statement.** This extension makes the three sub-invariants explicit and binds them to the threat-modeler's testable assertion shapes.

#### Invariant 9.a — Trap engages on `modal.show()` (covered by the original Invariant 9 wording; explicitly named here)

*"For every modal in the protected-modal list (`export_interstitial`, `reauth_prompt`, `passphrase_prompt`, `destructive_confirm`, `four_eyes_pending`), the focus trap, the Escape-handler binding, the click-outside-no-op binding, and the `aria-modal=true` / `aria-labelledby` announcement MUST be installed synchronously with `modal.show()`, before the next animation frame, and BEFORE any opacity transition begins. The opacity transition is decorative-only."*

This is the threat-modeler's M-53a (`.context/threat-model.md` §3.3) restated as an ADR-level invariant; the original Amendment C already covered this property. Tests per `.context/threat-model.md` §8 T11 / F-53 M-53a entry.

#### Invariant 9.b — Announce-on-open `ready` promise gates input acceptance (NEW — adds explicit coverage for M-53b)

*"Protected modals MUST NOT accept any keyboard or pointer input that resolves to a primary or secondary action until the announce-on-open contract has resolved. The announce-on-open contract is: `aria-modal=true` is set, `aria-labelledby` is wired to the headline element, and the headline element is present in the accessibility tree. The implementer represents this as a `ready` promise; primary/secondary action handlers MUST await this promise before dispatching. For `export_interstitial` specifically: a confirm before `ready` resolves results in NO `export.minutes` / `export.recommendation` audit-log row AND no Blob URL creation."*

**Operational rule.** The `ready` promise resolves when the modal's title/label element is in the accessibility tree AND the screen-reader announcement has been queued (the implementer's choice between aria-live region or `aria-modal` + `aria-labelledby` reachability check; final form per design-system spec). Primary/secondary action handlers MUST `await` this promise. The button's `aria-disabled` SHOULD also flip to `false` only when `ready` resolves; the handler-await is the load-bearing control (a scripted click that bypasses the disabled state still hits an await).

This is the threat-modeler's M-53b restated as an ADR-level sub-invariant. Tests per `.context/threat-model.md` §8 T11 / F-53 M-53b entry.

#### Invariant 9.c — Underlying surface is `inert` from t=0; scrim captures keydown + pointer during transition (NEW — adds explicit coverage for M-53c)

*"When a protected modal mounts, the underlying surface MUST be marked `aria-hidden=true` AND `inert` (or polyfilled equivalent) AND its focusable descendants MUST have `tabindex=-1` applied synchronously with `modal.show()`. The scrim MUST have `pointer-events: auto` and a `keydown` capture-phase handler that swallows Tab/Enter/Space/Escape targeted at the underlying surface during the transition."*

**Operational rule.** The underlying surface is rendered `inert` (or a polyfill emulating its behaviour on browsers without native `inert` support) at the same task tick as the modal mount. The scrim DOM node is part of the modal mount and has `pointer-events: auto` AND a capture-phase `keydown` listener from t=0 that swallows Tab/Enter/Space/Escape; click events at scrim coordinates land on the scrim, not on the underlying surface beneath. Programmatic `.focus()` calls (e.g., from a malicious extension) on underlying-surface elements MUST NOT move `document.activeElement` to those elements; the focus-trap library's underlying-subtree filter rejects such moves.

This is the threat-modeler's M-53c restated as an ADR-level sub-invariant. Tests per `.context/threat-model.md` §8 T11 / F-53 M-53c entry.

### Cross-references for the extension

- **threat-model §3.3 F-53 M-53a / M-53b / M-53c** — the threat-modeler's testable assertion shapes (the test-writer's canonical reference).
- **threat-model §8 T11 F-53 M-53a/b/c** — the test-writer's checklist entries (one bullet per sub-invariant).
- **threat-model §9 HG-11** — the human gate "Protected-modal trap-engagement contract" (permanent in threat-model.md; threat-modeler-owned).
- **threat-model §10 / §11 second-pass summary** — context for why M-53b and M-53c added on the second pass.
- **`.context/design-system.md` §3.1, §3.2** — the user-facing surface of these invariants; the designer folds the M-53a/b/c language in on the next pass. The architect does NOT modify design-system.md per amendment pass #3 hard rules.
- **RA-1** (this file) — the export interstitial's compensating controls; F-53 materially narrows RA-1's margin per the threat-modeler's second pass. The extension's Invariant 9.b is the load-bearing control preventing a sub-200ms scripted-confirm bypass.

### Reversibility (for the extension)

**Hard** on the three sub-invariants (reverting either 9.b or 9.c would degrade both accessibility and coercion-resistance; they are non-negotiable while RA-1 holds as single-signer and while the protected-modal list exists). **Easy** on the implementation (each sub-invariant maps to one or two lines of the focus-trap / scrim modules).

---

# ADR-0003 Amendment D (2026-05-22, amendment pass #3, HG-13): Pseudonymized reprisal-feed projection

**Amends ADR-0003** above. Trigger: privacy-review Q1 APPROVED-WITH-CHANGES (§2.1–§2.4, §4 cross-cutting observations #1, #2, #5, §5 fold-in items 1 + 5, §7 test obligations 1–6). Cross-references threat-model F-30 / F-31 / F-32 / F-33 / F-36 / O-4 (reprisal-log STRIDE); ADR-0003 Amendment B (HG-6 server-side C4 read-audit — the architectural pattern this Amendment mirrors for write events); RA-1 (the social-norm-backstop logic for reads, now mirrored for writes); **HG-13** (architect-owned gate, formerly proposed by privacy-reviewer as HG-11, renumbered per amendment-pass #3 directive G to HG-13 since threat-modeler's writes landed first with HG-11/HG-12 in `.context/threat-model.md` §9).

### The problem

The pre-amendment audit-log RLS (`observability/audit-log.md` §3 / `observability/README.md` §1) made `reprisal.created` rows readable by all active members with the full payload — `{ts, actor_pseudonym, target_id, target_class}`. Privacy-review Q1 found that this **bundled** the social-norm-backstop benefit (other members see "reprisal activity is happening") with **disclosure of authorship** (every active member sees that *rep X* logged a reprisal at *time T*) — exposing the most-likely target of reprisal (the rep themselves) to the rest of the committee, including any co-opted member (threat-model A3 / O-4).

The fix mirrors Amendment B's HG-6 pattern: a `SECURITY DEFINER` view that projects the audit row with the load-bearing columns suppressed.

### The amendment — author-pseudonymized projection via SECURITY DEFINER view

**Testable invariant (canonical wording):** *"Reprisal write-event RLS projections (`reprisal.created`, `reprisal.read`, `reprisal.status_changed.4eyes_pending`, `reprisal.status_changed.4eyes_completed`, and the analogous `work_refusal.*` and `s51_evidence.*` write events once T14 enumerates them) MUST suppress `actor_pseudonym` and bucket `ts` to the hour in the feed visible to active committee members; the underlying `audit_log` row retains `actor_pseudonym` and the original microsecond `ts` for forensic use; un-projected access requires the 4-eyes forensic-reveal procedure (Amendment E)."*

### Operational implementation

1. **Underlying table.** `audit_log` schema unchanged — `actor_pseudonym` and microsecond `ts` continue to be stored on every row. The pseudonym is the HMAC pseudonym per `observability/README.md` §2.

2. **Pseudonymized projection view.** New `SECURITY DEFINER` view `reprisal_audit_feed_pseudonymized` owned by `c4_read_service` (the existing non-login role from Amendment B). The view's projection:

   ```sql
   -- pseudo-SQL; final form in T13 migration
   CREATE VIEW reprisal_audit_feed_pseudonymized
   WITH (security_invoker = false) -- definer
   AS
   SELECT
     id,
     event_type,
     date_trunc('hour', ts) AS ts_bucketed_to_hour,
     target_id,
     target_class,
     -- actor_pseudonym SUPPRESSED — not selected
     prev_hash,
     hash
   FROM   audit_log
   WHERE  event_type IN (
            'reprisal.created',
            'reprisal.read',
            'reprisal.status_changed.4eyes_pending',
            'reprisal.status_changed.4eyes_completed'
            -- extension for T14 enumerations:
            -- 'work_refusal.created', 'work_refusal.read', 'work_refusal.status_changed.4eyes_*',
            -- 's51_evidence.created', 's51_evidence.read', 's51_evidence.status_changed.4eyes_*'
          )
     AND  jhsc_caller_can_read_reprisal_feed(auth.uid()); -- RLS predicate inlined
   ```

3. **GRANT / REVOKE shape.** Direct SELECT of `actor_pseudonym` (and rows whose `event_type LIKE 'reprisal.%' OR LIKE 'work_refusal.%' OR LIKE 's51_evidence.%'`) is REVOKED from `authenticated`, `anon`, `service_role`. Concretely:
   - `REVOKE SELECT (actor_pseudonym) ON audit_log FROM authenticated, anon, service_role;` (column-level revoke on the pseudonym column for the targeted event types — implementation choice is migration-handler's; equivalent path is row-level RLS rejecting reads where these event types are present unless via the view).
   - `GRANT SELECT ON reprisal_audit_feed_pseudonymized TO authenticated;` — active members read through the view.
4. **Default list payload (privacy-review §4 cross-cutting observation #5; mirrors F-18 from threat-model).** The default `audit_log` list payload for `reprisal.*` events — including when the user is querying for their own activity — comes from `reprisal_audit_feed_pseudonymized`, NEVER the raw table. Even a rep viewing "my recent audit-log activity" sees the pseudonymized projection of their own reprisal write-events (the underlying row still ties to their `actor_pseudonym`, but the projection does not surface it; the rep knows what they did, the projection's columns are unchanged regardless of caller).
5. **Forensic access path.** Un-projected access (i.e., recovery of `actor_pseudonym` for a specific reprisal write-event) requires the 4-eyes forensic-reveal procedure documented in **Amendment E**. The `forensic_read_service` role (new; created in Amendment E) has SELECT on the underlying `audit_log` `actor_pseudonym` column scoped to rows surfaced by an approved forensic-reveal proposal. No other role has un-projected SELECT.
6. **Coverage of the C4 write-event family.** T13's reprisal-log write events are covered by Amendment D at amendment time. T14's `work_refusal.*` and `s51_evidence.*` write events are folded into the view's event-type list when T14 enumerates them (the view's `event_type IN (...)` predicate is amended in T14's migration; the architectural shape is identical). The test-writer's coverage of T14 mirrors T13.

### Why pseudonymized projection (Option (c) in privacy-review Q1)

- **Option (a) status quo + consent — rejected.** Even with explicit consent at intake, Principle 4.3.6 (sensitivity-appropriate consent) for C4 disclosure to ~12 people is a high bar. Reducing disclosure first (4.4 / 4.5 minimization) and layering consent on top (ADR-0007 amendment) is the PIPEDA-defensible order.
- **Option (b) visible to other worker reps of same caucus — rejected.** Worker-side-only by design (plan §3.2); "same caucus" = "every active member"; collapses to (a) and gains nothing.
- **Option (c) author-pseudonymized projection — chosen.** Preserves the social-norm-backstop (members see reprisal activity is happening) while suppressing the load-bearing inference vector (who logged what). Time bucketing prevents shift-pattern inference. Mirrors the Amendment B HG-6 pattern (server-emitted, view-projected, definer-owned).
- **Option (d) no visibility — rejected.** Loses the social-norm benefit; coerced-fabricated-reprisal (F-17 analogue) becomes harder to detect.

### Testable assertions (T13 acceptance amended — see Task-list amendments at end; mirrors privacy-review §7 test obligations 1–4 and 6)

- **Pseudonymized feed projection (privacy-review §7 obligation 1).** SELECT from `reprisal_audit_feed_pseudonymized` as an active member. Assert the returned columns contain `{id, event_type, ts_bucketed_to_hour, target_id, target_class, prev_hash, hash}` and do NOT contain `actor_pseudonym`.
- **Direct-audit-log bypass for reprisal events (privacy-review §7 obligation 2).** As an active member, attempt `SELECT actor_pseudonym FROM audit_log WHERE event_type LIKE 'reprisal.%'`. Assert either zero rows returned (RLS denial path) or the `actor_pseudonym` column is NULL/absent (GRANT-revoke path); the test-writer covers both architectural paths per privacy-review §7 closing note. Repeat for `work_refusal.%` and `s51_evidence.%` once T14 enumerates.
- **Time bucketing (privacy-review §7 obligation 3).** Emit a `reprisal.created` row at a specific microsecond (e.g., `'2026-05-22 14:37:42.123456+00'`). SELECT from the feed view; assert `ts_bucketed_to_hour = '2026-05-22 14:00:00+00'`. SELECT from underlying via forensic-reveal path (Amendment E); assert original microsecond `ts` retained.
- **Consent surface presence (privacy-review §7 obligation 5).** Cross-references ADR-0007 amendment (this pass) — covered there.
- **Default-list-payload exclusion (privacy-review §4 cross-cutting observation #5).** A GET that returns the user's "my activity" feed for reprisal events comes from `reprisal_audit_feed_pseudonymized`, not from the raw `audit_log`. Test: query the user's activity slice for a reprisal write-event; assert the response shape matches the projection (no `actor_pseudonym`, hour-bucketed `ts`).
- **Coverage of write-events for T14 (privacy-review §7 obligation 6).** Test obligations 1–3 above repeated for `work_refusal.*` and `s51_evidence.*` write events when T14 enumerates; T14 acceptance carries the same shape as T13.

### Cross-references

- **privacy-review §2.3** (Option (c) recommendation), **§2.4** (consent-surface copy, folded into ADR-0007 amendment in this pass), **§4 cross-cutting observations #1 / #2 / #5**, **§5 fold-in items 1 + 5**, **§7 test obligations 1–6**.
- **threat-model §3.4 F-30 / F-31 / F-32 / F-33 / F-36 / O-4** — the reprisal-log STRIDE family Amendment D defends.
- **ADR-0003 Amendment B (HG-6)** — the architectural pattern (SECURITY DEFINER view, `c4_read_service` role, atomic in-transaction audit) Amendment D mirrors for write events.
- **ADR-0003 Amendment E** — the 4-eyes forensic-reveal procedure that gates un-projected access to `actor_pseudonym`.
- **ADR-0007 amendment (this pass)** — the consent surface naming the projection's behaviour to the submitting rep.
- **ADR-0015 (this pass)** — `reprisal.*` events retention is "Match underlying record (Active matter + 7y)"; Amendment D's projection does not change retention, only visibility.
- **HG-13** — architect-owned gate covering Amendment D + Amendment E + ADR-0007 amendment as a bundled human gate. The privacy-reviewer originally proposed it as HG-11; renumbered to HG-13 because the threat-modeler's second pass wrote HG-11/HG-12 first per amendment-pass #3 directive G.

### Reversibility

**Medium.** The view + GRANT-revoke layer is one migration; reverting to a raw-row-visible posture would be a security regression we wouldn't do. The schedule of `event_type` values in the view's WHERE clause is additive (extends naturally for T14 enumerations).

### Compliance check additions

- [x] PIPEDA Principle 4.3 (Consent) — load-bearing for the consent-surface contract in ADR-0007 amendment.
- [x] PIPEDA Principle 4.4 / 4.5 (Limiting Collection / Use / Disclosure) — disclosure scope is minimized to the pseudonymized projection.
- [x] OHSA s.50 — the inference-disclosure vector (rep logging reprisal = rep is the target) is closed structurally, not policy-only.
- [x] Threat-model A3 / O-4 (co-opted rep / co-chair-and-author collusion) — closes the inference channel.
- [x] T11 (compelled access detection) and T4 (insider compromise) — strengthened.

### Follow-ups (T13 acceptance amended — see Task-list amendments at end)

- [ ] **T13 acceptance amended** — `reprisal_audit_feed_pseudonymized` view + GRANT-revoke + default-list-payload + four-tests-from-§7 in `privacy-review.md`.
- [ ] **T14 acceptance amended** — Amendment D's projection extended to `work_refusal.*` and `s51_evidence.*` write events; same test shape.
- [ ] **observability-setup (next pass):** updates `observability/audit-log.md` §3 to document the projection view alongside the raw table and updates §1 to reflect the projection-default for the visible feed (downstream of architect; observability-setup owns the file per amendment pass #3 hard rules).
- [ ] **Test-writer:** privacy-review §7 test obligations 1–4 and 6 are top-priority (per §7 closing note: tests 1–4 + 7–8 are highest-priority new obligations).

---

# ADR-0003 Amendment E (2026-05-22, amendment pass #3, HG-13): Forensic-reveal 4-eyes procedure

**Amends ADR-0003** above (sibling of Amendment D, ratified together as **HG-13**). Trigger: privacy-review §4 cross-cutting observation #2 — Amendment D's pseudonymized projection creates a new forensic-reveal surface ("I need to know who logged this reprisal"); without a documented gating procedure, the only paths to recover `actor_pseudonym` are (a) un-gated admin access (A5 surface; defeats the purpose) or (b) un-documented ad-hoc reveals that the audit-log integrity story cannot describe. Amendment E provides the gated procedure.

**Cross-references:** privacy-review §4 cross-cutting observation #2; ADR-0003 Amendment D (the projection that creates the need); existing `pending_destructive_ops` 4-eyes pattern (the architectural pattern Amendment E mirrors); ADR-0003 Amendment A (audit-log enum closed allowlist — Amendment E adds two new values); ADR-0015 (the new enum values' retention).

### The procedure — 4-eyes forensic-reveal, modelled on `pending_destructive_ops`

1. **`pending_forensic_reveals` table.** New table, schema mirrors `pending_destructive_ops`:
   - `id uuid primary key`
   - `target_audit_log_id uuid not null` (the specific `audit_log` row whose `actor_pseudonym` is to be revealed)
   - `proposer_id uuid not null` (the active member proposing the reveal)
   - `proposed_at timestamptz not null default now()`
   - `proposer_reason text not null` (free-text justification; visible in the audit chain)
   - `approver_id uuid` (NULL until a distinct second member approves)
   - `approved_at timestamptz`
   - `revealed_actor_pseudonym text` (populated atomically with approval; available to the proposer + approver for the duration of the open reveal session, then expired)
   - `expires_at timestamptz` (default `approved_at + interval '24 hours'`)
   - `expired_at timestamptz` (set when the reveal session expires; row retained for audit chain integrity)
2. **Two distinct approvers.** RLS denies approval where `approver_id = proposer_id` — same-member-cannot-approve-own-proposal, mirroring the existing 4-eyes pattern. For dual-co-chair committees the requirement is "co-chair + co-chair" (two distinct co-chairs); for single-co-chair committees the requirement is "co-chair + one certified_member" (privacy-review §4 cross-cutting observation #2 wording). The RLS predicate encodes both forms.
3. **`forensic_read_service` role.** New non-login Postgres role owned by `migration_role`. Has SELECT on the underlying `audit_log` `actor_pseudonym` column. The role is invoked exclusively via the `SECURITY DEFINER` function `jhsc_forensic_reveal_actor_pseudonym(target_audit_log_id uuid)` whose body verifies (a) a `pending_forensic_reveals` row exists for `target_audit_log_id` with `approver_id IS NOT NULL` AND `approver_id != proposer_id`, (b) the current `auth.uid()` is either `proposer_id` or `approver_id`, (c) `now() < expires_at`. Only then does the function return the un-projected `actor_pseudonym`.
4. **Two new audit-log enum values** (appended to the closed allowlist per ADR-0003 Amendment A's enum):
   - `audit.forensic_reveal.4eyes_pending` — emitted when a proposer creates a `pending_forensic_reveals` row.
   - `audit.forensic_reveal.4eyes_completed` — emitted when a distinct approver approves.
   Both events are hash-chained per ADR-0003 Amendment A; both carry `{actor_id, target_audit_log_id, proposer_id, approver_id?, proposer_reason}` in their meta. Both have **7-year retention** per ADR-0015 (added to the schedule in the same pass).
5. **No external KMS / external signer involvement.** Like Amendment B's `c4_read_service`, the `forensic_read_service` is a Postgres role; the 4-eyes gate is the RLS + check function. Consistent with ADR-0010's "Sentry is the only non-Supabase subprocessor" posture.
6. **Reveal-session expiry.** A successful reveal exposes `actor_pseudonym` to the proposer and approver for 24 hours via the `pending_forensic_reveals.revealed_actor_pseudonym` column (RLS-scoped to those two members). After 24 hours the row's `expired_at` is set by a scheduled job and the column is cleared; further reveals require a new 4-eyes proposal. The audit-chain rows remain at 7y retention.

### Testable assertions (T13 acceptance amended — see Task-list amendments at end; mirrors privacy-review §7 test obligation 4)

- **Proposer cannot self-approve.** Active member M proposes a forensic reveal for `audit_log_id = X`; same member M attempts to approve own proposal. Assert RLS denies; no `audit.forensic_reveal.4eyes_completed` row written.
- **Distinct-member approval succeeds.** Active member M proposes; distinct active member N approves (where the role-pairing is co-chair + co-chair or co-chair + certified_member per the committee's composition). Assert (a) `audit.forensic_reveal.4eyes_pending` row written on proposal AND (b) `audit.forensic_reveal.4eyes_completed` row written on approval AND (c) both rows hash-chain correctly AND (d) the `revealed_actor_pseudonym` column is populated AND (e) M and N can read it via the function for ≤24h.
- **Non-pair attempt denied.** Active member M proposes; active member N attempts to approve where N is a non-co-chair worker-member and the committee is single-co-chair (so the rule requires co-chair + certified_member). Assert RLS denies the approval.
- **Reveal-session expiry.** Approved reveal where `now() > expires_at`; assert the function returns NULL (or an error) and the column is cleared by the expiry job.

### Cross-references

- **privacy-review §4 cross-cutting observation #2** — the source recommendation.
- **threat-model F-32 / F-33 / O-4 / HG-6** — the reprisal-log adversary model context.
- **ADR-0003 Amendment A** — closed-enum allowlist (Amendment E adds two values).
- **ADR-0003 Amendment D** — the projection Amendment E forensic-gates.
- **ADR-0015** — retention of the two new enum values (7y); added to the schedule in this pass.
- **existing `pending_destructive_ops`** (System Design §RLS outline) — the architectural pattern Amendment E mirrors.
- **HG-13** — bundled gate covering Amendment D + Amendment E + ADR-0007 amendment.

### Reversibility

**Medium.** The table + role + function + two enum values are additive migrations; reverting would be a security regression (architecturally inferior to "no forensic recovery path at all," which loses incident-response capability).

### Compliance check additions

- [x] PIPEDA Principle 4.5 — forensic recovery is bounded (24h reveal session, two-member gate, audit-chained).
- [x] PIPEDA Principle 4.9 — the reveal is itself an audit event the user can see in their own audit feed (the proposer/approver pair is visible).
- [x] OHSA s.50 — un-projected `actor_pseudonym` exposure requires two distinct committee members; one co-opted member cannot unilaterally compromise an author's anonymity.

### Follow-ups (T13 acceptance amended — see Task-list amendments at end)

- [ ] **T13 acceptance amended** — `pending_forensic_reveals` table + `forensic_read_service` role + `jhsc_forensic_reveal_actor_pseudonym` function + 4 tests above + retention coverage for the two new enum values.
- [ ] **observability-setup (next pass):** wires alerts for `audit.forensic_reveal.4eyes_pending` rows that age beyond `expires_at` without an approval (signals coercion or abandoned proposals); same alert pipeline as F-50.
- [ ] **designer (next pass):** Surface for "I need to know who logged this entry" — the proposer flow + approver flow + reveal-session view. The architect does NOT decide the UX shape here; only the architectural contract (4-eyes, 24h session, two audit rows).

---

# ADR-0003 Amendment F (2026-05-22, amendment pass #3, HG-12): Recovery-passphrase show-again accommodation

**Amends ADR-0003** above. Trigger: threat-model F-54 (`/home/user/agent-os/.context/threat-model.md` §3.1 lines ~263–325) / O-18 / **HG-12** (permanent in threat-model §9). Amendment F is filed as a sibling of Amendment D / Amendment E rather than folded into Amendment D, per the amendment-pass #3 directive F option. Cross-references **a11y-review A-5** (the original accessibility finding); design-system §4.D (Surface D, recovery-passphrase enrollment, D.4–D.7); **F-08** (recovery-blob KDF + type-back); **F-41 / O-1** (printed-sheet coercion accepted as v2 duress mode); ADR-0008 (personal-device advisory posture carries forward).

### The problem

Design-system Surface D.6 hides the just-shown recovery passphrase (per D.5 print + D.6 type-back verify) and offers only a punitive "fail 3 wrong attempts → return to D.4 (re-display)" path back to re-display. Accessibility-review A-5 identifies this as discriminatory against low-vision, dyslexic, and cognitively-impaired workers who may not be able to read the printed sheet (D.5) and would otherwise have to deliberately enter incorrect input to gain access to an accommodation they need.

Threat-model F-54 STRIDE-walked the accommodation options and chose hold-to-reveal + per-enrollment-session cap + audit-log emission. The threat-modeler's reasoning (verbatim from §3.1 F-54): audio-narration mode rejected (widens threat space via ambient mics, MDM screen-with-audio, coerced read-aloud); second-device path rejected (BYOD-MDM-adjacent); skip-verification rejected (loses F-08 mitigation); chosen path is hold-to-reveal (≥1500ms) + per-enrollment-session cap of 3 + server-instrumented audit-log emission + no TTS / no clipboard on the reveal surface.

### The amendment — show-again accommodation with four invariants

**Architectural contract.** Surface D.6 gains a "show passphrase again" secondary link that returns to a constrained D.4-variant (the reveal surface). The reveal is gated by:

1. **Hold-to-reveal (≥1500ms).** Sustained pointer-down OR Space-keydown OR Enter-keydown for ≥1500ms continuously; release cancels the reveal immediately. Per threat-model M-54a.
2. **Per-enrollment-session cap of 3 reveals.** Restart-enrollment from D.1 emits its own audit event and resets the counter for the new session. Per threat-model M-54c.
3. **Audit-log emission gates the reveal.** Each reveal emits `identity_privkey.recovery_blob.viewed` to the audit log BEFORE the passphrase becomes visible in the DOM, with `{actor_id, enrollment_session_id, reveal_count_in_session, ts}`. Per threat-model M-54b. Failure of the audit-log endpoint blocks the reveal.
4. **No TTS, no clipboard on the reveal.** No `SpeechSynthesisUtterance`, no `window.speechSynthesis`, no clipboard-copy affordance on the reveal surface. The largest typography token and the highest-contrast pairing are the supported accommodations. Per threat-model M-54d.

### Adding the audit-log enum value

The closed allowlist of `event_type` values per ADR-0003 Amendment A gains one new value:

| Enum value | When emitted | Required fields |
|---|---|---|
| `identity_privkey.recovery_blob.viewed` | Every successful invocation of "show passphrase again" on Surface D.6. Emitted by the server-instrumented logging path BEFORE the DOM render. | `actor_id`, `enrollment_session_id`, `reveal_count_in_session`, `ts` |

**Pre-enrollment scoping.** Pre-enrollment users have a special enrollment-scoped logging path (the audit-log row is committed under the partially-enrolled user's id, which is bound to the TOTP-invite-consumed session per ADR-0002). The architecture treats this as an authenticated event under the partially-enrolled identity; the audit chain hash-chains normally.

**Retention.** Per ADR-0015, `identity_privkey.recovery_blob.viewed` retains for **membership + 24 months**, same window as `recovery_blob.written` and `recovery_blob.restored` — the forensic value tracks the same enrollment-session-bounded window.

### Operational rules (binding for the implementer, the test-writer, the designer of Surface D.6)

1. **Hold-to-reveal gating (M-54a).** The "show again" control reveals the passphrase only while pointer-down OR Space-keydown OR Enter-keydown is sustained for ≥1500ms continuously. Release hides within 50ms. Reveal control's label and helper text MUST name the consequence in plain language (en-CA i18n keys: `onboarding.recovery.show_again.label`, `onboarding.recovery.show_again.helper`).
2. **Audit-log emission precedes DOM render (M-54b).** The reveal control invokes a server-side log endpoint; the passphrase is rendered only after the endpoint returns 200. Endpoint failure (5xx) → no render + danger toast. Reveal-count increments per successful row.
3. **Cap (M-54c).** Three successful reveals per enrollment session. Fourth attempt: control is `aria-disabled=true`, no audit row, helper text directs to restart enrollment. Restart resets the counter.
4. **No TTS, no clipboard on reveal (M-54d).** The reveal surface MUST NOT offer a clipboard-copy button (clipboard remains a coercion / exfil channel; clipboard-copy was already available at D.4 once, per design-system D.4 secondary action — not re-exposed at the D.6 reveal). The reveal surface MUST NOT invoke `SpeechSynthesisUtterance` or any TTS API. Static lint: zero matches for `SpeechSynthesisUtterance`, `window.speechSynthesis`, `tts` in `src/lib/onboarding/recovery/*` outside test fixtures.
5. **Largest typography token + highest-contrast pairing.** The reveal surface uses the design system's largest typography token and the highest-contrast color pairing per the existing design tokens. The architect does NOT modify `design-tokens.json` or `.context/design-system.md` per amendment pass #3 hard rules; the designer folds the reveal-surface treatment into the design system on the next pass.
6. **Post-enrollment, the reveal surface is gone.** A user who completes D.7 cannot invoke "show again" from settings — there is no settings surface for it. Post-enrollment recovery still relies on the printed sheet (F-41 / O-1, accepted residual) or, in v2, the duress-mode work. This bounds the F-54 threat space to the enrollment session window.

### Testable assertions (T07 / T19 acceptance amended — see Task-list amendments at end; mirrors threat-model §8 T07 F-54 entries M-54a/b/c/d)

- **Hold-to-reveal (M-54a).** Click without hold (release within 100ms) → passphrase NEVER rendered (no `data-testid='recovery-passphrase-onscreen'` becomes visible). Hold 1500ms → passphrase rendered after 1500ms. Release → hidden within 50ms. Hold 5000ms → continued visibility. Keyboard: Space-keydown for 1500ms reveals; Space-keyup hides.
- **Audit-log emission (M-54b).** One successful reveal → exactly one `identity_privkey.recovery_blob.viewed` row for the current `enrollment_session_id` with `reveal_count_in_session = 1`. Endpoint returns 500 → passphrase NOT rendered AND danger toast shown. Three successful reveals → `reveal_count_in_session` = 1, 2, 3.
- **Cap (M-54c).** Three successful reveals → all succeed. Fourth attempt → control `aria-disabled=true` AND no audit row emitted AND helper text directs to restart enrollment. Restart enrollment → fresh `enrollment_session_id` AND "show again" invocable again up to 3 times in the new session.
- **No TTS, no clipboard (M-54d).** Surface D.6 reveal state → no element with `data-testid='copy-passphrase'`. Static lint: zero matches for `SpeechSynthesisUtterance`, `window.speechSynthesis`, `tts` in recovery-flow modules outside test fixtures.
- **T19 onboarding integration test** — full D.1 → D.7 flow including a "show again" invocation; audit row appears under the partially-enrolled user; flow completes; reveal-count counter resets after D.7.

### Cross-references

- **threat-model F-54** (`/home/user/agent-os/.context/threat-model.md` §3.1) — the STRIDE walkthrough and option-rejection rationale.
- **threat-model §8 T07 / T19 F-54 entries M-54a/b/c/d** — the test-writer's canonical assertion shapes.
- **threat-model §9 HG-12** — the human gate (permanent in threat-model.md, threat-modeler-owned).
- **threat-model §11 second-pass summary** — context for F-54's chosen mitigation.
- **a11y-review §A-5** — the original accessibility finding the threat-modeler's pass confirmed.
- **F-08 / F-41 / O-1** — adjacent recovery-passphrase findings (F-08 type-back KDF; F-41 printed-sheet coercion accepted as v2 duress).
- **ADR-0008** — personal-device advisory posture; carries forward to the reveal surface (the warning text about who can see the screen).
- **ADR-0003 Amendment A** — closed-enum allowlist; Amendment F adds one value.
- **ADR-0015** — `identity_privkey.recovery_blob.viewed` retention (membership + 24mo); added to the schedule in this pass.
- **`.context/design-system.md` §4.D** — Surface D spec; the designer folds the reveal-surface treatment in on the next pass. The architect does NOT modify design-system.md per amendment pass #3 hard rules.
- **`i18n/en-CA/`** — en-CA plain-language strings (`onboarding.recovery.show_again.label`, `.helper`) added by localization-specialist; architect does NOT modify `i18n/*` per amendment pass #3 hard rules.

### Reversibility

**Hard** on the architectural contract (M-54a/b/c/d are non-negotiable while the AODA + accessibility posture in `JHSC-APP-PLAN.md` §9 holds and while F-08 remains the load-bearing recovery model). **Easy** on the implementation site (one module: `src/lib/onboarding/recovery/`).

### Compliance check additions

- [x] WCAG 2.0 AA / AODA — the show-again accommodation closes A-5 without introducing a punitive "fail 3 times" path.
- [x] PIPEDA Principle 4.7 (Safeguards) — every reveal is server-audited; silent extraction is structurally impossible.
- [x] Threat-model A2 / A3 — bounded threat-space widening (enrollment-session-bounded; hold-to-reveal; 3-cap; audit-logged).
- [x] PIPEDA Principle 4.9 (Individual Access) — the user can see their own `recovery_blob.viewed` events in their audit feed.

### Follow-ups (T07 + T19 acceptance amended — see Task-list amendments at end)

- [ ] **T07 acceptance amended** — M-54a/b/c/d tests + the `identity_privkey.recovery_blob.viewed` enum addition + the en-CA i18n key contract for the reveal-control label and helper text. Surface D.6 ships before T19 (T19 owns the onboarding handoff per threat-model §8 T19 F-54 cross-reference).
- [ ] **T19 acceptance amended** — full D.1 → D.7 integration test including a "show again" invocation; audit row appears under the partially-enrolled user; reveal-count counter resets after D.7.
- [ ] **designer (next pass):** Surface D.6 reveal control with largest typography + highest-contrast pairing; "show again" secondary-link spec; D.6 state machine update.
- [ ] **localization-specialist (next pass):** en-CA strings for `onboarding.recovery.show_again.label`, `.helper`, and the cap-reached helper.
- [ ] **observability-setup (next pass):** `identity_privkey.recovery_blob.viewed` recognized by the integrity checker (F-50) and the retention job (F-51 / F-52) per its ADR-0015 retention.
- [ ] **accessibility-specialist (HG-10 + AODA gate):** WCAG 2.0 AA review of Surface D.6 reveal surface and the secondary-link UX. NOT architect-owned; flagged here for the handoff.

---

# ADR-0002: Authentication — passkeys (WebAuthn) only, via Supabase Auth

**Status:** Accepted
**Date:** 2026-05-22
**Decider(s):** user (locked in plan §13 item 8), architect ratifying

## Context

Plan §13 locks Supabase Auth, passkeys only, TOTP for first-device
enrollment, removed once a passkey is set, no SMS, no password fallback.

This ADR ratifies the choice and records the **operational constraints**
that downstream agents must follow.

## Decision drivers

- Phishing resistance (T7).
- No SIM-swap or carrier-visible auth (T6, T11).
- No password leaks possible because there are no passwords.
- Multi-device for committee members who use a phone + laptop.

## Options considered

### Option A: Passkeys only, TOTP enrollment bootstrap (locked)

**Description:**
- First device: user enrolls with a TOTP code emailed to them at
  invitation time (or shown by the inviting co-chair on a printed
  invite slip). TOTP is consumed once to bind the first passkey.
- Subsequent devices: bound by an existing passkey-authenticated
  session approving the new authenticator.
- TOTP secret destroyed after first passkey is set.
- No password ever set on the account.
- Session: 15-min access token, passkey re-auth on resume; no
  long-lived refresh tokens.

**Pros:**
- Phishing-resistant by design.
- No password attack surface.
- Supabase Auth supports WebAuthn natively.

**Cons:**
- Browser support gaps on older devices (Android 9-, Safari 15-).
  Mitigated by setting a minimum supported browser baseline.
- Lost-device recovery requires an alternate enrolled device OR a
  committee-administered re-invite. Documented.

### Option B: Passkeys + password fallback

**Pros:**
- Familiar.

**Cons:**
- Defeats T7 mitigation; password is the weakest link.
- Locked out by plan §13.

### Option C: SMS / email magic link

**Pros:**
- Familiar.

**Cons:**
- SIM-swap risk; email-account compromise.
- Locked out by plan §13.

## Decision

**We choose Option A — locked.**

### Rationale

Locked by plan §13. The threat model leans on passkeys for T6, T7, T11.

**Operational rules:**
- Minimum browser baseline documented and enforced (no service worker
  registration on unsupported browsers; visible "your browser is too
  old" page).
- Lost-device recovery flow:
  - **Has another enrolled device** → use it.
  - **Has no other device** → worker co-chair issues a fresh TOTP
    invite that consumes one slot in the audit log and rotates that
    user's identity keys; old data encrypted to the old identity key
    is recoverable only from the recovery passphrase backup (see
    ADR-0003).
- No "remember me." Each session is short.
- Session list and revoke-all is in user settings.

### Reversibility

**Medium.** Adding more methods later is a feature add; removing
passkeys would be a security regression we wouldn't do.

## Consequences

### Positive
- Phishing-resistant.
- No password DB to leak.
- Sessions are short and revocable.

### Negative / accepted tradeoffs
- Users on very old devices can't use the app. We accept that.
- Lost-device recovery is a process, not a click.

### Risks
- Supabase Auth bug in WebAuthn. Mitigated by tracking Supabase Auth
  CVEs in dependency-manager and gating with adversarial-reviewer.

## Compliance check

- [x] No SMS PI processor.
- [x] No password storage.
- [x] PIPEDA Safeguards adequate to sensitivity.

## Follow-ups

- [ ] T05 — auth + passkey enrollment with second-opinion-reviewer.
- [ ] T20 — session revocation tested.

---

## Amendment G (2026-05-23, amendment pass #4, HG-15): T05 auth-side-table schema reconciliation, TOTP consumed-log, plaintext-code drop, HMAC standard adopted

**Amends ADR-0002** above. Trigger: privacy-review-t05 §2.1 Findings 1 + 2 + §3.4 Finding 5 + §3.5 Finding 6 + §7 PI inventory rows + §9 architect-amendment items 1–3; consolidated security-reviewer blockers B1 (HMAC-not-SHA), B2 (TOTP consumed-log documentation), B3 (`public.users` field-set divergence), B4 (`auth_totp_bootstraps.totp_code` plaintext column). Cross-references **ADR-0016** (this pass; the general operational-table retention + HMAC-pseudonymization standard); **threat-model F-38** (TOTP code reuse-detection — the consumed log's *raison d'être*); **threat-model F-43** (TOTP bootstrap 15-minute ceiling); **HG-15** (the new architect-owned gate covering this Amendment and ADR-0016).

### The amendment

T05 (auth core + auth migration) introduced four auth-supporting tables whose schema or behaviour was not yet documented at the ADR level. The amendment closes the four privacy-review-t05 / security-reviewer blockers (B1, B2, B3, B4) and ratifies the resulting schema shape.

#### G.1 — `auth_totp_consumed_log` is a first-class table for F-38 reuse-detection

**Status:** ratified.

The migration creates `auth_totp_consumed_log (user_id uuid, totp_code_hash bytea, consumed_at timestamptz)`. The table's purpose is to **detect TOTP-code re-submission within the bootstrap's lifetime + a safety margin** — without this table, an attacker who obtains a consumed TOTP code and replays it before the issuing co-chair notices has a structural racing window. The detection requires retaining the keyed hash of consumed codes for the longest plausible attacker window.

**Operational rules:**
1. **Retention:** 24 hours after `consumed_at`. Per ADR-0016 schedule. Defensible: the bootstrap's own life ceiling is 15 minutes; 24 hours is a ~100x safety margin against clock-skew + delayed-replay + investigation-latency. Longer retention does not serve any documented purpose under PIPEDA Principle 4.5.
2. **`totp_code_hash`:** stores `hmac(p_totp_code, current_setting('app.hmac_pseudonym_key'), 'sha256')` per ADR-0016 §Decision 1. **NEVER** stores `digest(p_totp_code, 'sha256')`. A 10^6-element value space against a plain hash is brute-forceable in microseconds; against a keyed HMAC the brute-force requires the key, which is not on the row.
3. **Classification (per privacy-review-t05 §7):** `user_id` C1, `totp_code_hash` C1 (HMAC of a short-lived secret), `consumed_at` C1.
4. **Hard-delete:** scheduled retention sweep per ADR-0016. T16 acceptance is extended (see Task-list amendments at end).

#### G.2 — `auth_totp_bootstraps.totp_code` plaintext column is DROPPED

**Status:** ratified per blocker B4.

The T05 migration as-shipped creates BOTH `secret_hash bytea NOT NULL` AND `totp_code text NOT NULL` with `UNIQUE (user_id, totp_code)`. The plaintext column duplicates the same secret in two columns; a backup taken in the 15-minute window between issue and consume captures the code in plaintext (Principle 4.7 Safeguards gap; Principle 4.4 over-collection).

**Operational rules:**
1. **Drop the `totp_code` column.** Migration-handler respin.
2. **Rewrite the unique constraint** to `UNIQUE (user_id)` — one bootstrap per user at a time (the 15-min ceiling enforces this in time; the unique constraint enforces it in the table).
3. **Rewrite the consume comparison** in `enroll_first_passkey` from `v_bootstrap.totp_code = p_totp_code` to `v_bootstrap.secret_hash = hmac(p_totp_code, current_setting('app.hmac_pseudonym_key'), 'sha256')`. The plaintext code is in the function's argument bind only; never persists.
4. **Test-mode is not a justification for keeping the plaintext column.** The architect REJECTS the alternative (CHECK constraint allowing plaintext in test mode) — adds complexity without materially helping; the test harness can compute the HMAC itself.

#### G.3 — `public.users` field set: AMEND the PI inventory to match the migration

**Status:** ratified per blocker B3.

The T05 migration creates `public.users` as the **auth side-table**, containing only the fields needed for auth + role gating: `{id, active, role, totp_destroyed_at, created_at, updated_at}`. This is the cleaner design (auth side-table; `committee_membership` is a separate concept introduced in T06; identity-key material lands in T07). The PI inventory as written in the original ADR-0001 → §PI inventory section described a `users` table whose composition was the *future* end-state including T06 + T07 fields.

**The PI inventory is amended in this pass (see §PI inventory below) to reflect the T05 truth:**
- `users.id` (C1) — Supabase Auth UUID, retention "Membership + 24mo" per ADR-0016. Unchanged in essence.
- `users.active` (C1) — boolean; migrated from the originally-planned `committee_membership.active` to `users` per the T05 schema. Retention "Membership + 24mo."
- `users.role` (C1) — text/enum; same migration; same retention.
- `users.totp_destroyed_at` (C1) — timestamptz; **NEW field** from T05 for F-43 audit (records when the per-user TOTP enrollment closed). Retention "Membership + 24mo."
- `users.created_at` / `users.updated_at` (C0) — operational timestamps; not PI.

**Deferred to later tasks (recorded for traceability, not part of T05's schema):**
- `users.display_name` (C2) — T06 owns. The original `users.display_name` row in §PI inventory is **deferred from "exists today" to "added in T06"**; the row is preserved in §PI inventory with an explicit T06-introduction note.
- `users.off_employer_contact` (C2) — T06 owns. Same treatment.
- `users.identity_pubkey` (C1) — T07 owns. Same treatment.
- `users.identity_privkey_recovery_blob` (C2) — T07 owns. Same treatment.

**`committee_membership` as a separate table is preserved as a T06-owned concept.** The T05 migration does NOT create `committee_membership`. T06 acceptance is extended (see Task-list amendments at end): T06 creates `committee_membership` and may carry the `active` / `role` semantics there if T06's design supersedes — but T06 cannot retroactively drop the columns from `public.users` without an explicit architect amendment.

#### G.4 — Every pseudonym derivation in `supabase/migrations/` is HMAC-keyed

**Status:** ratified per blocker B1 + ADR-0016.

The migration's four pseudonym derivation sites — `auth_totp_consumed_log.totp_code_hash`, `audit_emit(...).meta.cred_id_pseudonym`, `audit_emit(...).meta.session_id_pseudonym`, and the `alert.fired`-shaped pseudonym at the fourth site — are all rewritten to use `hmac(X, current_setting('app.hmac_pseudonym_key'), 'sha256')` per ADR-0016 §Decision 1.

**The `alert.fired` site (privacy-review-t05 §8 cross-cutting observation #5) is renamed in `meta`** from `actor_pseudonym` to `subject_pseudonym`. The outer audit row's `actor_pseudonym` is the alert-dispatcher (`sys-alert-dispatcher`); the embedded one is the **subject** the alert is firing on — a distinct semantic. Renaming avoids the column-name collision and clarifies that the embedded value is "who the alert is *about*", not "who fired it." The observability spec wording for the `alert.fired` meta shape is amended on observability-setup's next pass to document `subject_pseudonym`; the architect does NOT modify `observability/*` per hard rules.

#### G.5 — `auth.passkey.assert` structured-log emission is per-attempt (canonical wording fix)

**Status:** ratified per privacy-review-t05 §3 Finding 3.

ADR-0003 **Amendment A extension** (structured-log-only event vocabulary table) was ambiguous on whether `auth.passkey.assert` emits **per attempt** or **per successful assertion**. The implementation emits per-attempt (success path AND failure paths, before the rate-limit gate). The architect adopts **per-attempt as canonical** — failure-path emissions provide load-bearing operational signal (rate-limit pressure, credential-not-found patterns, signature-verification-failure patterns) that a per-success-only posture would lose. This matches the current code; no implementer respin is needed for this point.

**Wording fix to ADR-0003 Amendment A extension structured-log table:**
- Existing wording at line ~1927 reads `auth.passkey.assert | High-frequency per-request authentication assertion. Volumetric (every request that performs WebAuthn assertion emits one).`
- The wording is **clarified, not replaced**, in this pass: emission is **per-attempt** (success and failure paths both emit; emission happens BEFORE the rate-limit gate so that rate-limit-induced rejections still produce signal). The line above is read as already covering this when "every request that performs WebAuthn assertion" is interpreted literally; this amendment makes that reading binding.

#### G.6 — `audit_emit` gains `retention_class` write at T05 (cross-cutting #2 fold-in)

**Status:** ratified per privacy-review-t05 §8 cross-cutting observation #2.

ADR-0015 §Schema Requirements #1 requires an `audit_log.retention_class text NOT NULL` column populated by `audit_emit` at write time. The T05 migration ships the `audit_log` stub. **Adding `retention_class` in the T05 migration is materially cheaper than adding it in T18 + backfilling.** The architect ratifies adding the column AND the `audit_emit` write of it **now**, in T05's migration-handler respin. The schedule-table population (per ADR-0015 §Schema Requirements #2) remains a T16 deliverable; T05 establishes the column shape only.

#### G.7 — `audit_emit` gains `p_request_id` parameter at T05 (cross-cutting #4 fold-in)

**Status:** ratified per privacy-review-t05 §8 cross-cutting observation #4.

`observability/audit-log.md:147-148` requires `audit_log.request_id` for correlation with the structured logger and Sentry. The T05 `audit_emit` signature omits `p_request_id`. **Adding it now (T05 migration-handler respin) is cheaper than rewriting every caller in T18** — every caller will need to pass it eventually, and the few T05 + pre-T18 callers can pass `null` as a fallback (the column allows null per `observability/audit-log.md:146`).

#### G.8 — `audit_log` RLS deny-default is a T13 prerequisite, not a T05 fix

**Status:** ratified per privacy-review-t05 §8 cross-cutting observation #3.

The T05 migration ships `audit_log` with default-deny RLS for SELECT. ADR-0003 **Amendment B** + **Amendment D** call for an active-member SELECT path **via the pseudonymized projection view** (`reprisal_audit_feed_pseudonymized`) — that view is a T13 deliverable. The architect ratifies that **deny-default at T05 is the correct posture** (no view-projected SELECT can be wired until the view exists, and the view is a T13 artefact). T13's migration-handler **replaces** the deny-default policy with the projection-view-SELECT policy when T13 ships. The replacement is documented as a T13 prerequisite, not a T05 fix.

#### G.9 — `audit_log` stub vs T18 hash-chain backfill: chain starts fresh at T18

**Status:** ratified per privacy-review-t05 §8 cross-cutting observation #1.

T05's `audit_log` stub does not yet implement hash-chaining (the `prev_hash` / `hash` columns exist on the schema per `observability/audit-log.md §2` but T05's `audit_emit` does not yet compute them). The architect ratifies that **T18 starts the chain fresh** — pre-T18 rows are pre-chain, and the T18 migration MAY rewrite their `prev_hash` / `hash` to seed the chain OR may treat the first T18-written row as the genesis row. The choice is a T18 migration-handler call; either is acceptable as long as it is documented in the T18 commit.

This is a **deliberately accepted gap** — pre-T18 audit rows are pre-launch operational telemetry; the chain's forensic value begins when forensic events begin (which is at the earliest T07, after T05's auth scaffolding is in place).

### Testable assertions (T05 + T06 acceptance amended — see Task-list amendments at end)

The four blocker resolutions are tested by:

1. **G.1 — `auth_totp_consumed_log` 24h retention:** unit-test the retention sweep; insert a row with `consumed_at = now() - interval '25 hours'`; run the sweep; assert the row is deleted; insert one with `consumed_at = now() - interval '23 hours'`; run the sweep; assert the row remains.
2. **G.1 — HMAC-of-code shape:** assert `auth_totp_consumed_log.totp_code_hash` is the truncated `hmac(p_totp_code, current_setting('app.hmac_pseudonym_key'), 'sha256')` value (compute the expected value in the test fixture using the test-mode key; assert equality).
3. **G.2 — no plaintext column:** `\d+ auth_totp_bootstraps` (or pg_attribute query) returns no `totp_code` column; the `UNIQUE` constraint is `(user_id)` only.
4. **G.2 — consume path uses HMAC comparison:** issue a bootstrap; consume with the correct code → success; consume with a wrong code → failure; consume with the correct code AGAIN → failure (single-use) AND a row appears in `auth_totp_consumed_log`.
5. **G.3 — `public.users` shape:** the migration creates exactly `{id, active, role, totp_destroyed_at, created_at, updated_at}`; absence of `display_name`, `off_employer_contact`, `identity_pubkey`, `identity_privkey_recovery_blob` at T05; T06 acceptance (cross-referenced) creates `committee_membership` and confirms the `active` / `role` semantics carry forward.
6. **G.4 — no bare `digest('sha256')`:** semgrep CI rule asserts zero matches in `supabase/migrations/` outside the documented checksum-context allowlist.
7. **G.4 — `alert.fired` meta uses `subject_pseudonym`:** snapshot test of a fired `alert.fired` audit row; assert `meta.subject_pseudonym` exists; assert `meta.actor_pseudonym` does NOT exist (the outer row's `actor_pseudonym` is `sys-alert-dispatcher`).
8. **G.6 — `audit_log.retention_class` populated at write:** every T05-shipped `audit_emit(...)` call writes a non-null `retention_class`.
9. **G.7 — `audit_emit` signature includes `p_request_id`:** function signature query asserts the parameter is present; integration test passes a known UUID and reads it back from `audit_log.request_id`.

### Reversibility

**Easy** on each operational rule (additive migration changes; the columns / constraints / function signatures land in the same T05 respin). **Hard** on the architectural posture (HMAC-keyed pseudonymization is non-negotiable post-amendment; reverting is the privacy-reviewer's BLOCK finding).

### Compliance check additions

- [x] PIPEDA Principle 4.4 (Limiting Collection): `auth_totp_bootstraps.totp_code` removed; `public.users` field set minimized to T05's auth needs.
- [x] PIPEDA Principle 4.5 (Limiting Retention): `auth_totp_consumed_log` 24h retention; every operational table covered by ADR-0016.
- [x] PIPEDA Principle 4.7 (Safeguards): every pseudonymization site uses keyed HMAC; the consumed-log is not brute-forceable without the GUC key.
- [x] PIPEDA Principle 4.9 (Individual Access): a user's session / passkey history is queryable through `auth_sessions` / `webauthn_credentials` per the existing ADR-0002 surface.
- [x] No new third-party processor.
- [x] No new cross-border flow.
- [x] threat-model F-38 / F-43 structurally addressed.

### Cross-references

- **privacy-review-t05 §2 / §3 / §7 / §9** — the source review and the architect-amendment pointer list.
- **consolidated security-reviewer B1 / B2 / B3 / B4** — the four blockers closed by G.1–G.4.
- **ADR-0016** — the general operational-table retention + HMAC-pseudonymization standard; this Amendment G is the auth-specific application.
- **ADR-0003 Amendment A extension** — `auth.passkey.assert` structured-log-only entry; G.5 clarifies the per-attempt vs per-success wording.
- **ADR-0015 §Schema Requirements #1 + #2** — `retention_class` column + schedule table; G.6 lands the column in T05.
- **observability/audit-log.md §2 line 130-138** — `actor_pseudonym` shape; observability-setup amends on next pass per ADR-0016.
- **observability/audit-log.md §1 alert.fired meta shape** — observability-setup amends on next pass to document `subject_pseudonym` (G.4).
- **observability/audit-log.md §2 line 147-148** — `request_id` requirement; G.7 lands the parameter at T05.
- **HG-15** — the new architect-owned gate covering Amendment G + ADR-0016; bundled.

### Follow-ups (T05 + T06 + T16 + T18 acceptance amended — see Task-list amendments at end)

- [ ] **T05 acceptance amended** — migration-handler respin per G.1 / G.2 / G.4 / G.6 / G.7; implementer respin for HMAC parity + boot smoke test + A3-A7 fold-ins; tests 1–9 above land before the implementer touches the respun migration.
- [ ] **T06 acceptance cross-referenced** — T06 creates `committee_membership`; T06 acceptance must NOT retroactively drop `users.active` / `users.role` without a successor architect amendment.
- [ ] **T16 acceptance extended** — the retention sweep now covers ADR-0016's operational-table schedule in addition to ADR-0015's audit-log schedule; per-table counts in `retention.deleted` summary jsonb.
- [ ] **T18 acceptance cross-referenced** — chain genesis-or-backfill choice documented in the T18 migration commit (G.9).
- [ ] **observability-setup next pass** — amends `observability/audit-log.md §2` lines 131-138 (HMAC-SHA-256 permitted with `app.hmac_pseudonym_key`); amends `observability/audit-log.md §1` `alert.fired` meta shape to document `subject_pseudonym`.
- [ ] **HG-15 user ratification** — bundled with ADR-0016's HG-15.

---

# ADR-0001: Hosting on Supabase Cloud (ca-central-1) with E2EE as load-bearing mitigation

**Status:** Accepted — **Note added 2026-05-22 (HG-1 linked risk acceptance)**
**Date:** 2026-05-22 (original); note added 2026-05-22
**Decider(s):** user (locked in plan §13 item 2), architect ratifying

**Linked risk acceptances:** This ADR is the load-bearing hosting decision. The defensibility of Option A rests on (a) ADR-0003 (E2EE) holding, and (b) the worker/employer trust boundary (B3, the export path) remaining narrow and auditable. The user has accepted a deliberate friction-vs-reprisal-resistance tradeoff at B3 — **see "Risk acceptances" section appended after the ADRs (RA-1, HG-1)**: single-signer co-chair passkey re-auth at export, instead of the threat-modeler's recommended full 4-eyes. The compensating controls (closed export allowlist F-19, audit log per F-32, visible concern-derived-items flag in the export interstitial, post-export rep notification) live downstream in T11/T12 acceptance criteria. If RA-1 is ever re-opened (per the triggers documented there), this ADR's defensibility posture should be re-reviewed alongside.

## Context

The user has explicitly chosen Supabase Cloud in `ca-central-1` over
self-hosting, accepting the **US-incorporated-provider tradeoff**:
Supabase Inc. and the underlying AWS region operator are US legal
persons, so US legal process (CLOUD Act, NSLs, FISA 702) can in
principle reach the platform. This ADR does **not** re-litigate the
decision — it captures the *how* of the mitigation so that downstream
agents understand exactly what makes this hosting choice defensible.

The threats this ADR mitigates are T1 (employer subpoena), T5 (provider
compromise), and a foreseeable CLOUD-Act class of risk.

## Decision drivers

- Canadian data residency (`ca-central-1`).
- Team-of-one ops capacity (self-hosting Supabase or vanilla Postgres
  is real ops work).
- Constraint: no third-party PI processor beyond Supabase.
- Constraint: provider must not be able to compel-decrypt content.
- Cost ceiling: ~$50/mo at v1 scale.

## Options considered

### Option A: Supabase Cloud `ca-central-1`, with E2EE doing the heavy lifting (locked)

**Description:** Use Supabase Cloud's managed Postgres + Auth + Storage
+ Edge Functions, all in `ca-central-1`. C3/C4 data is E2EE under the
committee key; the server holds ciphertext. RLS is the second layer
(against an attacker with a stolen session token). Telemetry is
scrubbed at the SDK layer (ADR-0010). No third-party PI processor
beyond Supabase itself.

**Pros:**
- Zero ops; managed Postgres + Auth + Storage + RLS in one stack.
- Canadian region.
- The E2EE design (ADR-0003) means Supabase sees ciphertext for the
  data that matters (T1, T5).
- Fits the budget envelope.

**Cons / accepted tradeoffs:**
- Supabase Inc. is US-incorporated; AWS ca-central is operated by a US
  entity. CLOUD-Act-reachable in principle for whatever Supabase *can*
  produce, which for C3/C4 is ciphertext.
- Edge Functions run inside Supabase — they handle ciphertext +
  metadata only; **plaintext must never appear in an Edge Function**
  (invariant from ADR-0003).
- A subpoena could compel Supabase to produce metadata: row counts,
  timestamps, user IDs, audit-log contents (C1). This is documented
  exposure; we minimize what metadata reveals (no employer names in
  table names; no PI in audit-log content).

### Option B: Self-hosted Supabase on a Canadian provider (e.g., OVHcloud Beauharnois)

**Description:** Run Supabase open-source stack on a non-US-incorporated
Canadian VPS.

**Pros:**
- Eliminates US-incorporated provider in the path.
- Same APIs, same code, in theory.

**Cons:**
- Real ops work for a team of one: patching Postgres, Postgrest,
  GoTrue, Storage, Realtime, etc. Each is a security-critical service.
- Patching delay = larger attack window than Supabase Cloud.
- Backup and HA are now our problem.
- The CLOUD-Act exposure is replaced by the operational risk of
  running production crypto+auth services solo. For this team size,
  the operational risk is higher than the legal risk that E2EE
  already mitigates.
- Realistic CA-incorporated providers (OVH Canada is a French
  subsidiary; CIRA is non-profit DNS only; truly Canadian cloud is
  thin on the ground) still have US/EU corporate parents in many
  cases — the "no US legal hook" promise is harder to keep than it
  looks.

### Option C: Vanilla Postgres on Canadian VPS, hand-rolled auth + storage

**Pros:**
- Smallest provider surface.

**Cons:**
- Hand-rolled auth is a hard no for a tool whose users are protected
  under OHSA s.50. We don't roll our own crypto/auth.
- More ops than Option B.

## Decision

**We choose Option A — locked by user.**

### Rationale

E2EE (ADR-0003) is the load-bearing mitigation. With C3/C4 data as
ciphertext-only on the server, the practical reach of a CLOUD-Act
order is reduced to:
- Metadata (timestamps, row counts, user IDs).
- Audit log (C1, contains no content).
- Auth session tokens (short-lived, passkey-bound).

This is a known, bounded exposure documented in the privacy policy.
The team's operational reality (one person + agent pack) makes
self-hosting a worse risk overall — patches delayed, backup drills
skipped, more bugs in services that don't get the platform team's
attention.

**Operational invariants:**
1. **Region pin:** all Supabase resources in `ca-central-1`. Verified
   on every deploy (CI check reads the project metadata).
2. **E2EE for C3/C4:** every C3/C4 column write goes through the
   encryption module. Integration test asserts ciphertext shape on
   every C3/C4 write.
3. **No new Supabase add-on without ADR.** Realtime, Vector, AI — each
   would be a fresh PI-processor evaluation.
4. **No PI in metadata.** Table names, column names, function names,
   error messages: generic.
5. **Edge Functions handle ciphertext + metadata only** — never
   plaintext. Linted.
6. **Subpoena playbook** exists before launch: who in Supabase Inc. we
   contact, what we can and cannot produce, who the user's privacy
   lawyer is. The deployer cannot ship without it.

### Reversibility

**Hard.** Migrating off Supabase is a project: replace Auth, Storage,
Edge Functions, RLS-as-authz. Estimated several sprints. The E2EE
mitigation means we don't need to migrate under most threat
scenarios; if we ever do, we do it deliberately, not under pressure.

## Consequences

### Positive
- Zero ops.
- Canadian region.
- Cost fits budget.
- E2EE means provider compromise → ciphertext only for the data that
  matters.

### Negative / accepted tradeoffs
- CLOUD-Act-reachable for ciphertext + metadata.
- Single-vendor concentration. Mitigated by ADR-0012 (backup to a
  second Canadian provider, ciphertext only).
- Edge Functions cannot use plaintext — limits some convenience patterns.

### Risks
- Supabase pricing change or feature removal. Mitigated: contract not
  long-term; egress is small; migration possible if needed.
- A future "AI feature" added by Supabase silently processes data. We
  monitor changelog; new add-ons require a fresh ADR.

## Compliance check

- [x] Canadian region.
- [x] Supabase DPA reviewed (standard; SCCs included).
- [x] Listed in `SUBPROCESSORS.md` as the sole PI processor.
- [x] PIPEDA Principle 1 (Accountability) — we identify Supabase and
      document the transfer.
- [x] Privacy policy will name Supabase + the tradeoff.
- [x] Subpoena playbook required before launch (human gate).

## Follow-ups

- [ ] Subpoena response playbook (deployer + privacy lawyer, human gate).
- [ ] `SUBPROCESSORS.md` to list Supabase, Sentry, backup bucket.
- [ ] Region-pin CI check in T01.
- [ ] Plain-language privacy-policy paragraph explaining the tradeoff.

---

# Risk acceptances

Deliberate, named risk acceptances. Each one is a place where the user chose a posture that the threat-modeler (or another reviewer) flagged as weaker than an available alternative. Recording them here makes the tradeoff visible, the compensating controls explicit, and the re-open triggers concrete — so the next reviewer (security, privacy, or a successor user) can revisit with full context rather than discovering the gap by surprise.

Newest on top.

---

## RA-2 (F-A, 2026-05-22): Audit-row signature deferred — v1 ships hash-only chain

**Linked ADRs:** ADR-0003 Amendment A (Invariant 8 — key-material mutation audit-log enum and the chain it lives on); ADR-0001 (the hosting tradeoff that places `audit_writer_role` credentials on a CLOUD-Act-reachable platform); ADR-0010 (Sentry is the only non-Supabase PI-adjacent subprocessor — re-opening that to introduce an external KMS / signer would itself be a flagged human-gate decision).
**Linked observability findings:** F-A (observability-setup pass #2); audit-log.md §6 finding #1; audit-log.md §2 "Signature (deferred — flagged finding)".
**Linked threat-model items:** A5 (platform admin / hosting-provider compromise — already in-scope per §1); T4 (insider compromise via co-opted rep).
**Linked tasks:** T18 (audit-log integrity check job — hash-chain only at v1); T07 (key-material enum emissions land on the same hash-only chain).

### The decision

The `audit_log` table reserves a `signature bytea` column for a server-side Ed25519 signature over `hash`. **At v1, that column ships unfilled.** The tamper-evidence story for v1 is the BLAKE2b-256 hash chain alone: each row's `hash` is computed over the canonical-JSON serialization of its content plus `prev_hash`, by the `SECURITY DEFINER` `audit_emit(...)` function whose owner is `audit_writer_role`. Clients cannot forge a hash; downstream verifiers (the T18 integrity job; the post-rotation and post-export triggered checks per F-50) detect any in-place mutation of an existing row.

**This is NOT:**
- A claim that the audit log is non-repudiable against a platform admin. It is not.
- A claim that no signer mechanism will ever exist. The column is reserved precisely so that v2 can fill it without a migration.

### The observability-setup agent's stance (recorded; not the decision)

The observability-setup agent surfaced this gap in their pass-#2 findings (F-A): "A platform admin (A5) with `audit_writer_role` could forge an internally-consistent chain. The signature would close that gap by requiring a key the platform admin doesn't have." The recommendation was either (a) ship Ed25519 row signing in v1 with key escrow in 1Password + a `pg_cron` signer function, or (b) external signer (KMS) — explicitly noting that (b) is effectively blocked by ADR-0010's "Sentry is the only non-Supabase subprocessor" posture without re-opening that decision.

### The architect's rationale (accepted)

Three reasons v1 ships hash-only:

1. **A5 is already in scope and load-bearing-mitigated elsewhere.** The threat model treats `A5 — Hosting provider compromise / rogue admin` as a credible adversary (threat-model §1). The primary control against A5 is **E2EE (ADR-0003)**: A5 with full platform access sees ciphertext for C3/C4 data and metadata + audit content for C1. The audit-log forgery vector under RA-2 is bounded by what A5 can already do — they can produce a *consistent record*, but they cannot fabricate plaintext content (none is present in the audit log; rows are PI-free by schema per audit-log.md §1) and they cannot fabricate the ciphertext rows the audit log references (those are RLS- and crypto-bound). RA-2's residual is therefore: A5 can rewrite the *narrative* of who did what, when. That is real harm, but it is a narrative-harm bounded by the absence of content.
2. **Option (b) crosses a hard rule.** Introducing an external KMS / signer is a new PI-adjacent subprocessor (the signer would see audit-row hashes — not PI, but it would be a service in the trust chain). ADR-0010 documents the "single non-Supabase subprocessor" posture and the conditions under which it can be revisited. Re-opening that posture for a v1 hardening of a residual that A5 already partly owns is the wrong tradeoff at v1 scale (12 active users). The constraint is recorded; if it changes, RA-2 is re-opened in the same PR that changes ADR-0010.
3. **Option (a) adds ops surface in the part of the system least-suited for it.** A `pg_cron`-driven signer reaching into a 1Password-held Ed25519 key requires either an in-database secret (defeats the point — the key is colocated with the role that needs to be defended against) OR an out-of-band signer process the team-of-one operates (cron job freshness, key rotation, recovery drill, alert wiring). The threat-modeler's "compelling" case for v1 (per §6 Invariants 7 + 8) is the chain itself; the signature is the v2 strengthening, not the v1 floor.

### Residual risk (what RA-2 leaves unmitigated)

A platform admin (A5) — or anyone who has compromised `audit_writer_role` credentials (the role's grants are documented in audit-log.md §3 and §4) — can:

- Forge a new row at the end of the chain (legitimate INSERT path; the `audit_emit` function will hash-chain it correctly because the function is what computes the hash).
- More dangerously: with raw Postgres `BYPASSRLS` superuser access (i.e., the platform admin role, not just the `audit_writer_role`), rewrite the chain end-to-end — compute new `hash`/`prev_hash` for every row from a chosen pivot forward, producing a chain that internally validates against itself.

In both cases, **the v1 detection surface is**:

- The T18 chain-integrity job (runs daily + post-rotation + post-export per F-50) detects any *in-place* mutation that breaks the chain. Crucially, this does NOT catch the second case above (where the attacker re-hashes the chain forward from the pivot) — that attack rewrites the chain consistently.
- **External witnesses**: any out-of-band copy of `(id, ts, hash)` triplets — printed daily summary, the deployer's incident log, a member's exported "my audit feed" snapshot — that diverges from the current chain at the same `id` is evidence of pivot-rewrite. The architect commits to documenting this as a manual control in the T18 deliverable (a daily "head pointer" — the highest `id` and its `hash` — emailed to the worker co-chair's off-app address, weekly review). This is not a formal control; it is a backstop that surfaces in the re-open triggers below.
- The pg_dump backup (ADR-0012, amended HG-8): the nightly dump captures the chain state at 03:00 ET. A pivot-rewrite that happens between 03:00 yesterday and 03:00 today is detectable by comparing yesterday's dump (Object-Locked, governance-mode-protected for 35 days) to today's live state for any row older than yesterday's dump. **This makes the backup the de-facto secondary witness for the audit-log integrity story until v2 signing ships.**

### Compensating controls (in plan, must remain — RA-2 is acceptable only while these hold)

1. **`audit_writer_role` is non-login** (audit-log.md §3). The role's grants are reachable only via `SECURITY DEFINER` functions; no JWT can present as `audit_writer_role`. Forging a row requires platform-side access, not a stolen session.
2. **UPDATE on `audit_log` is REVOKED from every role**, including `audit_writer_role`, `c4_read_service`, and `retention_service_role` (audit-log.md §4). The only legitimate state change is INSERT (new row) and DELETE (retention service role on aged-out rows). In-place mutation requires bypassing RLS at the Postgres level — i.e., the A5 capability.
3. **The T18 chain-integrity job runs at least daily** and on every key rotation and every export (F-50). Detection latency upper bound: 5 minutes for the post-trigger checks; 24 hours for scheduled checks.
4. **The pg_dump backup is the secondary witness.** ADR-0012's Object-Lock-protected nightly dumps mean a pivot-rewrite is detectable by cross-referencing the live chain against yesterday's locked dump for any row older than 24 hours. The T18 deliverable adds an "audit-log vs latest backup diff" check to the daily integrity job (additive; recorded in this RA's follow-ups).
5. **No `audit_writer_role` credential is held outside Supabase Cloud.** The role's grants are migration-defined; no CI service account, deployer's laptop, or escrow vault carries them. This narrows the credential-compromise surface to the Supabase platform itself.
6. **The `signature` column is reserved at v1, not added in v2.** The schema field exists; v2 fills it without a migration. This keeps the v2 upgrade path mechanical.

### Triggers that re-open RA-2 (any one requires architect + security-reviewer to re-evaluate, default response: implement Ed25519 row signing per observability-setup Option (a))

1. **Any indication of platform-admin compromise** — credentials, role grants, or Supabase platform incidents that indicate `audit_writer_role` or `BYPASSRLS` access was held by an unauthorized party. Re-evaluation considers (a) immediate signer rollout, (b) re-hash-and-re-issue of the chain from the last-known-good backup, (c) external witness publication.
2. **Any inspection, audit, or s.51 prosecution where audit-log authenticity is challenged.** If a counterparty (employer, MoL, court) disputes the chain's integrity, the v1 posture's defensibility is materially reduced. The default response is "ship the signer before next renewal of any matter relying on the audit log."
3. **Any divergence between the live chain and the most recent pg_dump backup for a row older than the dump.** This is the v1 detection mechanism firing. The first such firing re-opens RA-2 regardless of whether the divergence is attributed (operator error, platform bug, or attack) — the residual is no longer hypothetical.
4. **Any change that materially expands `audit_writer_role`'s reach** — new SECURITY DEFINER functions, new callers, new grants. Each such change is a compensating-control change, which by the structure of this RA re-opens it.
5. **A change to ADR-0010 that admits a new subprocessor capable of acting as an external signer.** If ADR-0010 is re-opened for an independent reason and a KMS becomes available, the cost balance of Option (b) shifts and RA-2 should be re-considered in the same pass.
6. **Annual review.** RA-2 is reconsidered at the annual threat-model review (next due 2027-05-22 per `.context/threat-model.md`), even if no trigger has fired.

### Re-opening procedure

If any trigger fires:
1. Architect + security-reviewer + (if available) the threat-modeler agent review the trigger and the post-incident evidence (which copy of the chain is authoritative).
2. **Default response: ship Ed25519 row signing per observability-setup Option (a)** — keypair in 1Password, signer invoked via `pg_cron`-loaded `SECURITY DEFINER` function whose owner is a new `audit_signer_role` (distinct from `audit_writer_role`; INSERT-without-sign is preserved as a fallback for the brief migration window). The schema is already ready (the `signature` column).
3. A new ADR amendment (or a successor RA) records the new posture and the trigger that prompted it.

### Follow-ups (additive to T18 acceptance — not a re-amendment of T18 itself; surfaced for test-writer)

- T18 daily integrity job adds an "audit-log vs latest backup head diff" check that compares the chain state at the latest available `pg_dump` (per ADR-0012) against the live chain for all rows whose `ts < (latest_dump_ts - 1 hour)`. Any mismatch on `hash` or `prev_hash` for a row older than the dump fires `A-AUDIT-001` (or a sibling alert id; observability-setup names it).
- T18 deliverable includes a weekly "head pointer" extraction surface: the latest `(id, ts, hash)` triplet emitted to the worker co-chair's off-app address (chosen by the co-chair, not stored in the app) as a manual external witness. Not a control under RA-2's compensating-controls list (so its absence does not re-open RA-2 by itself), but documented here as the backstop.
- No new task is added; both items are within T18's existing scope per `observability/README.md` §10 finding interpretation.

---

## RA-1 (HG-1, 2026-05-22): Single-signer co-chair passkey re-auth at export — not full 4-eyes

**Linked ADRs:** ADR-0001 (hosting tradeoff — B3 is the only path off the worker side), ADR-0003 (E2EE — export is the legitimate plaintext-leaving-the-system path).
**Linked threat-model items:** F-29 (4-eyes on export described as optional) / O-8 / HG-1; cross-references F-19 (export field allowlist — LAUNCH BLOCKER), F-32 (export audit logging), F-22 (co-chair role gating).
**Linked tasks:** T11 (meeting prep + draft minutes + finalize-and-export), T12 (recommendations to employer + 21-day timer).

### The decision

For the export function — the only path off the worker side at the B3 trust boundary — authentication of the act of exporting is **single-signer co-chair passkey re-auth at the moment of export**. Specifically:

- The acting principal MUST be `worker_co_chair` and MUST be currently active (RLS gates the read of finalized minutes / recommendations; F-22).
- The export interstitial requires a fresh WebAuthn passkey assertion (re-auth), not a stale session — i.e., the existing access-token JWT alone is NOT sufficient; the co-chair physically/biometrically asserts at the moment of export.
- The audit-log row records `approver_id = actor_id` (a single signer; explicit, not implicit).

**This is NOT:**
- A stale-session click-through. Re-auth is required at the moment of export; a long-running session cannot click "Export" without a fresh assertion.
- Full 4-eyes. A second active member's passkey assertion is NOT required for v1.

### The threat-modeler's recommendation

The threat-modeler explicitly recommended **full 4-eyes** for `recommendations.export` and `minutes.final` exports (threat-model §9 HG-1): the export is rare, low-friction relative to the threat profile (employer adversary, single co-opted co-chair = A3), and 4-eyes is exactly what mitigates that. The threat-modeler's reasoning is sound and is preserved here as the alternative.

### The user's rationale (accepted)

The user has accepted the lower-friction tradeoff for two operational reasons:
1. Reps are occasionally absent (illness, shift, leave). A 4-eyes requirement that cannot be satisfied stalls a legitimate export — a real workflow harm against an OHSA-bound timeline (e.g., 21-day recommendation response clock in T12 cannot be advanced if the export can't go out).
2. The act of export is a co-chair function (s.9 minute-signing role); pairing it with a second member's assertion feels procedurally backwards for the user's committee's working pattern.

This is recorded as a deliberate, named risk acceptance — not an oversight. The threat-modeler's recommendation remains visible in §9 of `.context/threat-model.md`.

### Residual risk (what RA-1 leaves unmitigated)

A single co-opted or coerced co-chair (A3 — "under-duress rep" archetype) can produce an export that crosses B3, carrying anything inside the export allowlist (F-19) to the employer. The threat-modeler's 4-eyes proposal would have required a second member's collusion to achieve this; under RA-1, one co-chair under coercion is sufficient.

### Compensating controls (in plan, must remain)

These are the load-bearing reasons RA-1 is acceptable. If any one of them weakens, RA-1 is re-opened.

1. **Closed-allowlist export fields (F-19, LAUNCH BLOCKER).** Source identities (`source_name_ct`) and all C4 fields are structurally absent from every export allowlist. A coerced co-chair can export what's in the allowlist (joint minutes, recommendations to employer) — they CANNOT silently exfiltrate reprisal entries, work-refusal notes, s.51 evidence, or source identities through the export path because those fields don't exist in any allowlist. Enforced by ESLint rule + snapshot test + PDF text-grep test (T11/T12 acceptance).
2. **Every export remains in the tamper-evident audit log (F-32 / Invariant 8).** Each export emits an audit row with actor, target_id, field_set_hash, ts, recipient_role; the row is hash-chained per ADR-0003 Amendment A and visible to all active members. Audit-log POST succeeds BEFORE the Blob URL is created (F-24); a failed audit emission aborts the export.
3. **Visible "concern-derived items" flag in the export interstitial (added by this RA).** If any item being exported was derived from a concern (e.g., a recommendation that references a concern_id chain), the interstitial flags this visibly — listing the originating concern IDs and their hazard_class metadata — so the co-chair must actively confirm what is leaving the worker side. The flag is informational (concern-derived items are still allowable in the export); the point is no quiet inclusion. **Implementation:** the export builder computes a `derived_from_concerns: concern_id[]` field; the interstitial renders it as a labelled section before the "I confirm this export" button; the audit-log row captures the array.
4. **Post-export rep notification (added by this RA).** Within 60 seconds of a successful export, every active member receives a "recent sensitive activity" notification (same surface as T11 / T18 sensitive-read notification): `{actor_id = co-chair, action = 'export.minutes' | 'export.recommendation', target_id, derived_from_concerns?, ts}`. This is the social-norm backstop: the committee sees the export happened, in near-real-time, even though no second signer was required at the moment of export.
5. **Re-auth at the moment of export, not stale session.** A passive-session attacker (T6 device theft within the 15-minute window before lock) cannot trigger an export without the passkey assertion. This raises the bar above "stolen JWT" but does not reach "second member's involvement."

### Triggers that re-open RA-1 (any one of these requires architect + privacy-reviewer to re-evaluate, possibly upgrading to full 4-eyes)

1. **Any reprisal incident traced through an export.** If an audit-log review (post-incident) shows an export carried information that became a reprisal vector — even within the allowlist — the export path's posture is re-examined. The default response is "upgrade to 4-eyes for `recommendations.export` and `minutes.final`."
2. **Any indication co-chair credentials were compromised** (passkey loss, suspected device-side compromise, suspected coercion event). Re-evaluation considers (a) immediate temporary disable of the export endpoint pending review, (b) upgrade to 4-eyes as a hard requirement.
3. **Any change in committee composition that includes a known-coerced rep** (e.g., a co-chair under documented duress, a co-chair who has reported being pressured by the employer). Same re-evaluation as #2.
4. **A change to the export allowlist that adds a field touching C4 or source identity.** F-19's allowlist closure is part of RA-1's compensating controls; any expansion of the allowlist requires re-opening RA-1 in the same PR.
5. **Loss of the post-export notification surface or the audit-log emission** (any change that makes the export less observable to the rest of the committee). The social-norm backstop is what makes RA-1 defensible without 4-eyes; removing it changes the calculus.
6. **Annual review.** RA-1 is reconsidered at the annual threat-model review (next due 2027-05-22 per `.context/threat-model.md`), even if no trigger has fired.

### Re-opening procedure

If any trigger fires:
1. Architect + privacy-reviewer + (if available) the threat-modeler agent review the trigger and the post-incident audit-log evidence.
2. Default response: upgrade to full 4-eyes for `minutes.final` and `recommendations.export`. The implementation cost is documented (F-29 Option B test): "Same actor cannot be approver; actor attempts to approve own export -> 403."
3. A new ADR amendment (or a successor RA) records the new posture and the trigger that prompted it.

---

# System Design

## Component diagram

```
                         +-----------------------------+
                         | User's browser (PWA)        |
                         |                             |
                         |  SvelteKit app              |
                         |  + libsodium-wrappers       |
                         |  + IndexedDB (encrypted     |
                         |    identity key + cache)    |
                         |  + Service worker (offline) |
                         |  + WebAuthn (passkey)       |
                         |                             |
                         |  PLAINTEXT lives only here  |
                         +--------------+--------------+
                                        |
                          TLS 1.3 / WSS |     -- TRUST BOUNDARY: auth (Supabase Auth)
                                        |     -- TRUST BOUNDARY: E2EE (ciphertext only past this line)
                                        v
                       +-----------------------------------+
                       | Supabase Cloud (ca-central-1)     |
                       |                                   |
                       |  +--------------+                 |
                       |  | Auth (GoTrue,|  passkeys only  |
                       |  | WebAuthn)    |                 |
                       |  +------+-------+                 |
                       |         |                         |
                       |         v                         |
                       |  +--------------+    RLS on every |
                       |  | Postgres     |    table        |
                       |  | (RLS-as-     |                 |
                       |  | authz)       |                 |
                       |  | + Drizzle    |                 |
                       |  |   schema     |                 |
                       |  +------+-------+                 |
                       |         |                         |
                       |  +------+-------+                 |
                       |  | Storage      |  ciphertext     |
                       |  | (blobs)      |  blobs only     |
                       |  +--------------+                 |
                       |                                   |
                       |  +--------------+                 |
                       |  | Edge Funcs   |  ciphertext +   |
                       |  | (export      |  metadata only; |
                       |  | rendering,   |  no plaintext   |
                       |  | retention)   |                 |
                       |  +--------------+                 |
                       +------+----------------+-----------+
                              |                |
              scrubbed events |                | nightly pg_dump
              (no PI)         |                | (encrypted)
                              v                v
                    +-------------------+   +--------------------+
                    | Sentry (EU)       |   | Canadian backup    |
                    | scrubbed at SDK   |   | bucket (B2 or S3   |
                    | NO PI, NO BODIES  |   | ca-central);       |
                    +-------------------+   | ciphertext blob    |
                                            +--------------------+

                    +-------------------+
                    | GitHub Actions CI |
                    | verify.sh, semgrep|
                    | gitleaks          |
                    +-------------------+

                    +-------------------------------+
                    | Worker co-chair export ----   |  -- TRUST BOUNDARY: worker/employer line
                    | rendered as PDF in browser,   |     (only path off the worker side)
                    | encrypted-at-rest snapshot,   |
                    | logged in audit; reviewed     |
                    | by privacy-reviewer per       |
                    | export                        |
                    +-------------------------------+
```

## Trust boundaries

The pack's threat model expects boundaries; here are ours.

**Boundary 1 — auth boundary.** Supabase Auth is the only authenticator.
Nothing in the app trusts a request without a valid Supabase JWT, and
RLS uses `auth.uid()` directly. There is no app-layer "user lookup" that
bypasses this. Outside the auth boundary = unauthenticated; inside = a
named principal.

**Boundary 2 — E2EE boundary.** All C3/C4 fields are ciphertext on the
server. Plaintext lives only in the user's browser, in libsodium's
working buffers and in the SvelteKit component state. Anything crossing
this boundary toward the server MUST be ciphertext; anything crossing
toward the browser MUST be decrypted by the client. Edge Functions sit
on the server side and do not see plaintext.

**Boundary 3 — worker/employer boundary (the export function).** There
is no employer side of this app. The only artifact that crosses the
worker/employer line is an **explicit export** triggered by the worker
co-chair: a finalized PDF (joint minutes, recommendations to employer).
The export:
- Runs in the browser (decrypts → renders PDF → user downloads).
- Is logged in the audit log (timestamp, document ID, who exported).
- Goes through a "this leaves the worker side" interstitial confirming
  the export and what it includes.
- privacy-reviewer reviews any change to export rendering with
  heightened scrutiny.

## Data flow with PI markings

### Concern intake

```
[Browser]
  1. Rep opens intake form. (auth: passkey session)
  2. Rep types concern title + body (C3) + optional source name (C4 if present).
  3. Anonymous toggle ON by default.
  4. Client generates per-concern nonce.
  5. Client encrypts {title, body, source_name?} with committee public key (sealed box).
  6. POST /api/concerns { ciphertext_blob, metadata: {hazard_class, severity, location_id} }
[Boundary 2 - E2EE crossed; only ciphertext leaves browser]
  7. Edge Function validates JWT, RLS allows INSERT given committee membership.
  8. Row inserted: ciphertext columns + plaintext metadata (severity, status='open', created_at).
  9. Audit log appended (C1): {actor_id, action='concern.create', concern_id, ts}.
[Database in ca-central-1, ciphertext at rest]

[Browser of another committee member]
  10. Lists concerns: SELECT ciphertext_blob, metadata FROM concerns (RLS pre-filtered).
  11. Client decrypts each blob with their wrapped copy of committee data key.
  12. Plaintext title shown in list view.
```

### Export (worker co-chair → employer co-chair)

```
[Browser, worker co-chair]
  1. Co-chair selects finalized minutes for export.
  2. Client fetches ciphertext blob from Supabase.
  3. Client decrypts in browser with committee key.
  4. Client renders PDF in browser (no plaintext via server).
  5. Audit log POST: {actor_id, action='export.minutes', minutes_id, recipient_role='employer_co_chair', ts}
[Boundary 3 - worker/employer line: PDF leaves the worker domain]
  6. User downloads PDF; delivery to employer co-chair happens off-app
     (email, paper, etc.). The app does not transmit to the employer.
```

### Inspection (offline + sync)

```
[Browser, on shop floor, no signal]
  1. Inspector opens inspection checklist; PWA service worker provides UI.
  2. Inspector ticks items, attaches photos (C3).
  3. Each photo encrypted client-side immediately with per-record symmetric key
     wrapped to committee public key.
  4. Records queued in IndexedDB as ciphertext.
[Boundary 2 - even local cache is ciphertext at rest in IndexedDB,
 modulo a session-key wrapping layer for quick read in current session]
  5. On reconnect, queue drains: ciphertext blobs uploaded to Supabase Storage;
     row inserted into inspections with metadata only.
```

## PI inventory

Every field, classification per plan §5.4, retention default, encryption posture.

| Entity / field | Class | Encryption | Retention | Notes |
|---|---|---|---|---|
| `users.id` (Supabase auth UUID) | C1 | TLS + AES-256 at rest | Membership + 24mo | Identifier only. T05-owned. |
| `users.active` | C1 | TLS + AES-256 at rest | Membership + 24mo | Boolean; T05-owned per ADR-0002 Amendment G.3 (this pass). Originally planned on `committee_membership.active`; relocated to `users` per T05 schema. |
| `users.role` | C1 | TLS + AES-256 at rest | Membership + 24mo | Enum {worker_member, worker_co_chair, certified_member}; T05-owned per ADR-0002 Amendment G.3 (this pass). Originally planned on `committee_membership.role`; relocated to `users` per T05 schema. |
| `users.totp_destroyed_at` | C1 | TLS + AES-256 at rest | Membership + 24mo | Timestamptz; NEW field per ADR-0002 Amendment G.3 (this pass). F-43 audit field: records when the per-user TOTP enrollment closed. |
| `users.created_at` / `users.updated_at` | C0 | TLS + AES-256 at rest | Membership + 24mo | Operational timestamps; not PI. |
| `users.display_name` | C2 | TLS + AES-256 at rest | Membership + 24mo | **DEFERRED to T06.** First name / chosen name. Per ADR-0002 Amendment G.3 (this pass), this field is NOT created in T05; T06 adds it. |
| `users.off_employer_contact` (email or phone) | C2 | TLS + AES-256 at rest | Membership + 24mo | **DEFERRED to T06.** NOT employer-domain; validated on entry. Per ADR-0002 Amendment G.3 (this pass), this field is NOT created in T05; T06 adds it. |
| `users.identity_pubkey` | C1 | TLS only | Membership + 24mo | **DEFERRED to T07.** Public key, no secrecy needed. Per ADR-0002 Amendment G.3 (this pass), this field is NOT created in T05; T07 adds it. |
| `users.identity_privkey_recovery_blob` | C2 (ciphertext of a secret) | TLS + AES-256 at rest; ciphertext wraps the actual secret | Membership + 24mo | **DEFERRED to T07.** Decrypts only with user passphrase. Per ADR-0002 Amendment G.3 (this pass), this field is NOT created in T05; T07 adds it. |
| `auth_totp_bootstraps.user_id` | C1 | TLS + AES-256 at rest | 15-min ceiling, hard-deleted on consume (F-43) per ADR-0016 | FK to `users.id`. T05-owned. |
| `auth_totp_bootstraps.secret_hash` | C2 | TLS + AES-256 at rest | 15-min ceiling, hard-deleted on consume per ADR-0016 | Single-use bootstrap secret. After ADR-0002 Amendment G.2 (this pass), the plaintext `totp_code` column is DROPPED; only `secret_hash` (HMAC-keyed per ADR-0016) remains. |
| `auth_totp_consumed_log.user_id` | C1 | TLS + AES-256 at rest | 24h after `consumed_at` per ADR-0016 | F-38 reuse detection. T05-owned per ADR-0002 Amendment G.1 (this pass). |
| `auth_totp_consumed_log.totp_code_hash` | C1 (HMAC of a short-lived secret) | TLS + AES-256 at rest | 24h after `consumed_at` per ADR-0016 | MUST be `hmac(p_totp_code, current_setting('app.hmac_pseudonym_key'), 'sha256')` per ADR-0016 §Decision 1; NEVER bare `digest()`. T05-owned per ADR-0002 Amendment G.1. |
| `auth_totp_consumed_log.consumed_at` | C1 | TLS + AES-256 at rest | 24h after `consumed_at` per ADR-0016 | Timestamptz. T05-owned per ADR-0002 Amendment G.1. |
| `webauthn_credentials.credential_id` | C1 | TLS + AES-256 at rest | Until passkey revoked OR membership inactive + 24mo per ADR-0016 | Pseudonymized in `audit_log` per ADR-0016 §Decision 1 / G.4. T05-owned. |
| `webauthn_credentials.public_key` | C1 | TLS + AES-256 at rest | Until passkey revoked OR membership inactive + 24mo per ADR-0016 | Public key — no secrecy required. T05-owned. |
| `webauthn_credentials.aaguid` | C1 | TLS + AES-256 at rest | Until passkey revoked OR membership inactive + 24mo per ADR-0016 | Authenticator model. T05-owned. |
| `webauthn_credentials.transports[]` | C0 | TLS + AES-256 at rest | Until passkey revoked OR membership inactive + 24mo per ADR-0016 | Enum. T05-owned. |
| `webauthn_credentials.device_label` | C2 | TLS + AES-256 at rest | Until passkey revoked OR membership inactive + 24mo per ADR-0016 | USER-PROVIDED only; the migration's column comment carries this rule (no platform-derived defaults). T05-owned. |
| `webauthn_credentials.rp_id` | C0 | TLS + AES-256 at rest | Until passkey revoked OR membership inactive + 24mo per ADR-0016 | Server-determined. T05-owned. |
| `auth_sessions.session_id` | C1 | TLS + AES-256 at rest | 15-min TTL + 90d revocation history per ADR-0016 | Pseudonymized in `audit_log` per ADR-0016 §Decision 1 / G.4. T05-owned. |
| `auth_sessions.device_label` | C2 | TLS + AES-256 at rest | 15-min TTL + 90d revocation history per ADR-0016 | USER-PROVIDED only. T05-owned. |
| `auth_sessions.device_fingerprint` | C2 | TLS + AES-256 at rest | 15-min TTL + 90d revocation history per ADR-0016 | HASHED by caller; NEVER raw UA. T05-owned. |
| `committee_membership.role[]` | C1 | TLS + AES-256 at rest | Membership + 24mo | **T06-owned.** {worker_member, worker_co_chair, certified_member}. Per ADR-0002 Amendment G.3 (this pass), `committee_membership` is created in T06; the `active` / `role` semantics for the auth path live on `users` (T05). T06 acceptance must not retroactively drop the columns from `users` without a successor architect amendment. |
| `committee_key.wrapped_privkey_blob` (per member) | C3 (wraps committee key) | E2EE at rest | Membership + 24mo | One row per (committee, member) |
| `concerns.title_ciphertext` | C3 | E2EE | 7y post-closure | Body field of concern |
| `concerns.body_ciphertext` | C3 | E2EE | 7y post-closure | Free text |
| `concerns.source_name_ciphertext` (nullable) | C4 | E2EE + per-record key | 7y post-closure | Identity of original worker complainant |
| `concerns.hazard_class` | C1 | TLS + AES-256 at rest | 7y post-closure | Enum, not PI |
| `concerns.severity` | C1 | TLS + AES-256 at rest | 7y post-closure | Enum |
| `concerns.location_id` | C1 | TLS + AES-256 at rest | 7y post-closure | Site location code |
| `concerns.status` | C1 | TLS + AES-256 at rest | 7y post-closure | Enum |
| `inspections.notes_ciphertext` | C3 | E2EE | 7y | Text |
| `inspections.photo_blob_keys[]` | C1 metadata | Storage blob is C3 ciphertext | 7y | FK to Storage |
| Storage: inspection photos | C3 | E2EE client-side before upload | 7y | Ciphertext blob |
| `minutes.draft_body_ciphertext` | C3 | E2EE | 90 days post-finalization | Working draft |
| `minutes.final_body_ciphertext` | C3 | E2EE | 7y | Finalized; export source |
| `recommendations.body_ciphertext` | C3 | E2EE | 7y | s.9(20) recommendations |
| `recommendations.employer_response_ciphertext` | C3 | E2EE | 7y | Captured employer reply |
| `reprisal_log.body_ciphertext` | C4 | E2EE + per-record key | Active matter + 7y; real-delete | Highest sensitivity |
| `work_refusal.notes_ciphertext` | C4 | E2EE + per-record key | Active matter + 7y | s.43 |
| `s51_evidence.*_ciphertext` | C4 | E2EE + per-record key | Active matter + 7y | s.51 |
| `training_records.evidence_ciphertext` | C2 | E2EE | Membership + 24mo | Certified-member proof |
| `audit_log.*` | C1 | TLS + AES-256 at rest; NOT E2EE | Per-event-type per ADR-0015 (supersedes uniform 24mo) | Tamper-evident hash chain. T18 implements chain hashing; T05 ships the stub with `retention_class` + `request_id` columns per ADR-0002 Amendment G.6 / G.7 (this pass). |
| `audit_log.actor_pseudonym` | C1 | TLS + AES-256 at rest | Per-event-type per ADR-0015 | varchar(16); `hmac(uid, current_setting('app.hmac_pseudonym_key'), 'sha256')` truncated to 16hex per ADR-0016 §Decision 1. Supersedes the prior `actor_id`-as-raw-UUID shape. |
| `audit_log.event_type` | C1 | TLS + AES-256 at rest | Per-event-type per ADR-0015 | Closed-enum text; ADR-0003 Amendment A + extensions. |
| `audit_log.target_id` | C1 | TLS + AES-256 at rest | Per-event-type per ADR-0015 | FK to affected row. Subject to underlying-record-ceiling rule per ADR-0015 §3.5. |
| `audit_log.retention_class` | C0 | TLS + AES-256 at rest | Per-event-type per ADR-0015 | NEW per ADR-0002 Amendment G.6 (this pass). Populated by `audit_emit` at write time; lands in T05 migration (not T18 backfill). |
| `audit_log.request_id` | C1 | TLS + AES-256 at rest | Per-event-type per ADR-0015 | NEW per ADR-0002 Amendment G.7 (this pass). Correlation key to structured logs + Sentry. Nullable; pre-T18 callers may pass null. |
| `audit_log.prev_hash` | C1 | TLS only | Per-event-type per ADR-0015 | Hash chain; T18 implements. T05 ships the column without backfilling pre-T18 rows per ADR-0002 Amendment G.9. |
| `feature_flags.*` | C0 | TLS only | n/a | Operational config |
| `document_library.*` | C0 | TLS only | n/a | OHSA quick-ref text, etc. |
| `i18n_strings.*` | C0 | TLS only | n/a | en-CA catalog |

**Fields that do NOT exist (data minimization):**
- No SIN, no DOB, no home address.
- No employer name attached to user (committee context implicit).
- No worker's *role at the workplace* beyond what's needed (no job title).
- No IP address logged in app logs (Supabase platform logs are out of
  app control; documented).
- No geolocation by default on inspections; opt-in per inspection.

## RLS policy outline per table (English; SQL comes later)

The pattern: every policy keys off `auth.uid()` and checks active
membership. `committee_membership_active(user_id)` is a SECURITY DEFINER
helper that returns true when the user has a row in `committee_membership`
with `active = true`. Single-tenant means there's only one committee.

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `users` | Self OR committee member | Self (first row only, via Auth trigger) | Self | None (use crypto-shred on role removal) |
| `committee_membership` | Active members only | Co-chair only | Co-chair only | None (mark inactive; 90-day grace then key destroy) |
| `committee_key` | Self's wrapped row only | Co-chair INSERT during invite + member-self-init | Co-chair only | Co-chair only (on member removal) |
| `concerns` | Active members | Active members | Active members | None (use `status='deleted'` + retention job) |
| `inspections` | Active members | Active members | Author OR co-chair (until status='finalized') | None |
| `minutes` (draft) | Active members | Active members | Active members | Co-chair only |
| `minutes` (final) | Active members | Co-chair only | Co-chair only (rare) | Co-chair only |
| `recommendations` | Active members | Active members | Active members until status='sent'; co-chair after | Co-chair only |
| `reprisal_log` | Author OR co-chair OR certified_member | Active members | Author OR co-chair | Co-chair only with 4-eyes |
| `work_refusal` | Certified member OR co-chair | Certified member | Certified member OR co-chair | Co-chair only with 4-eyes |
| `s51_evidence` | Certified member OR co-chair | Certified member | Certified member OR co-chair | Co-chair only with 4-eyes |
| `training_records` | Active members | Self OR co-chair | Self OR co-chair | Co-chair only |
| `audit_log` | Active members | App writes via Edge Function (security definer); no direct write from users | Never | Never (immutable; retention job deletes by age) |
| `feature_flags` | Active members | Co-chair only | Co-chair only | Co-chair only |
| `document_library` | Active members | Co-chair only | Co-chair only | Co-chair only |
| `i18n_strings` | Public | None (loaded via migration) | None | None |

**Helpers (all SECURITY DEFINER, owned by the migration role, called from policies):**
- `is_active_member()` → bool.
- `is_co_chair()` → bool.
- `is_certified_member()` → bool.
- `is_self(uid uuid)` → bool.
- `requires_four_eyes(target_table text, target_id uuid)` → uses a
  `pending_destructive_ops` table where the first member proposes and
  the second member approves; only after both, the row is allowed to
  flip status.

**"4-eyes" pattern:** for destructive ops on C4 (reprisal_log,
work_refusal, s51_evidence), DELETE is gated by a row existing in
`pending_destructive_ops` with two distinct approver IDs.

---

# Capacity and cost sketch

**Scale assumption:** 50 active workers as potential users; ~12 active
committee members (typical OHSA 50+ workplace); peak ~5 concurrent
sessions during a committee meeting.

## Sizing

- **Postgres:** Supabase Pro tier (Small compute — 2 vCPU / 4GB) is
  10x what we need. Day-1 working set is well under 100MB; with 7y
  retention and ~50 concerns/year + monthly inspections + monthly
  minutes, projected database size at year 5 is on the order of
  500MB–2GB. Connections: peak 10 simultaneous.
- **Storage:** photo attachments dominate. Estimate:
  - 12 inspections/year × 20 photos × 1MB (compressed JPEG, encrypted
    overhead +10%) ≈ 264MB/year.
  - 5 critical-injury events × 50 photos × 2MB × occasional ≈ 500MB
    occasional.
  - Year-5 storage: ~3–5GB total. Pro tier includes 100GB.
- **Egress:** Inspections + minutes downloads. ~50 sessions/week ×
  10MB average ≈ 500MB/week ≈ 2GB/month. Pro tier includes 250GB
  egress.
- **Edge Functions:** retention sweep nightly, audit-integrity check
  nightly, export rendering occasional. Well under the 500k-invocation
  Pro allowance.

## Cost (CAD-ish, monthly)

| Item | Cost | Notes |
|---|---|---|
| Supabase Cloud Pro | ~$25 USD / mo | Includes 8GB DB, 100GB Storage, 250GB egress, 100k MAU, PITR |
| Domain (`.ca`) | ~$2 / mo | Annual amortized |
| Sentry SaaS, EU, Team plan | ~$26 USD / mo | Cheapest tier with EU residency; 50k events/mo is plenty |
| Backup bucket (B2 / S3 ca-central) | <$1 / mo | ~5GB ciphertext + low egress |
| GitHub Actions | $0 | Free tier sufficient for this volume |
| **Total** | **~$54 USD / mo (~$74 CAD / mo)** | |

At 10× scale (500 workers, 10 committees — would mean re-opening single-tenancy):
- Multi-tenancy decision re-opens (this would be v2, not a config flip).
- Supabase Pro probably still fits; Storage grows but is well under
  the 100GB allowance.
- Sentry tier may upgrade ($80 USD / mo).
- Cost cliff at v2: roughly $150–200 / mo, still well within any
  reasonable budget.

**Top three cost drivers at v1:** Sentry tier ($26), Supabase Pro
($25), domain (~$2). Sentry is the lever to pull if cost is an issue
(switch to GlitchTip self-hosted; trade dollars for ops hours).

**Cliffs:**
- DB > ~50GB (years away at this profile) → review Supabase Compute
  tier.
- Concurrent sessions > 100 → review connection pooling (PgBouncer is
  Supabase-standard).
- Storage > 100GB → either trim retention or upgrade.

---

# Failure-mode analysis (T1–T12)

For each plan §4 threat: residual risk after this design, and the
specific test the test-writer should write.

### T1 — Employer obtains worker-side content via server subpoena

**Design mitigations:** E2EE for C3/C4 (ADR-0003); ciphertext-only at
rest; Supabase cannot produce plaintext; metadata + audit log can be
compelled (documented).

**Residual:** Metadata still compellable (timestamps, row counts, user
IDs, audit log content). Privacy policy names this exposure.

**Test:** Integration test that:
- Writes a known plaintext to every C3/C4 column path.
- Queries the row directly via the Postgres admin connection (no app
  layer).
- Asserts the column contents are well-formed libsodium ciphertext
  (correct magic bytes / nonce length / minimum size) and do **not**
  contain the plaintext substring.

### T2 — Employer obtains content via worker's employer-owned device

**Design mitigations:** ADR-0008 advisory posture; 15-min auto-lock;
passkey re-auth on resume; no long-lived refresh tokens; panic wipe;
no plaintext disk cache beyond session; opt-in offline cache per
inspection.

**Residual:** A user who deliberately installs on an employer device
and stays logged in during work hours. Documented; this is a policy
problem, not a tech problem.

**Test:** Browser test:
- Sets up logged-in session.
- Backgrounds the tab for 16 minutes.
- Asserts that any sensitive route reads from IndexedDB after passkey
  re-auth (i.e., session is locked until re-auth).
- Triggers "panic wipe" and asserts IndexedDB is empty afterward.

### T3 — Reprisal against an identified complainant (s.50)

**Design mitigations:** Anonymous source toggle defaults ON; `source_name_ciphertext`
is C4 (per-record passphrase); no auto-include in exports; visible
"reveal source" action is audit-logged; export interstitial lists every
field included.

**Residual:** A rep who deliberately reveals a source. Mitigated by audit
log and committee social norms.

**Test:** Integration test:
- Create a concern with anonymous=true.
- Attempt to render an export PDF and assert the output contains no
  `source_name` field whatsoever.
- Toggle reveal and assert the audit log gains an `action='source.reveal'`
  row with actor and target.

### T4 — Insider compromise (co-opted rep)

**Design mitigations:** Tamper-evident audit log (hash chain); 4-eyes
for destructive ops on C4; key rotation on role change; co-chair has
no superuser DB access (Supabase admin separation).

**Residual:** A rep who reads (read-only) without 4-eyes — possible by
design (members need to read). Audit log records reads of C4 records.

**Test:** Integration test:
- Member A proposes DELETE on a reprisal_log row.
- Assert row is NOT actually deleted yet; `pending_destructive_ops`
  has an entry.
- Member B approves; assert row now deleted AND audit log has two
  approve entries.
- Member A tries to approve their own proposal; assert rejected.
- Tamper-evident: corrupt one audit-log row's content; assert the
  daily integrity check job fails AND alerts.

### T5 — Hosting-provider compromise

**Design mitigations:** Same as T1 — E2EE for C3/C4; backups
encrypted with our key, not Supabase's; passkey-bound sessions
limit replay value.

**Residual:** Provider can DoS, can read metadata, can read C1/C2 at
rest (TLS + AES-256 protect from network/disk-snoop but not from
provider-admin access).

**Test:** Same as T1, plus a test that:
- Generates a backup `pg_dump`.
- Attempts to read a C3 ciphertext column from the dump and assert
  it does not yield plaintext without the dump key + committee key.

### T6 — Device theft / loss

**Design mitigations:** Passkey-bound sessions; 15-min auto-lock;
revocation from any active member's settings; biometric lock; panic
wipe.

**Residual:** Brief window before lock if device is grabbed unlocked.

**Test:** Browser test:
- Log in on device A.
- From device B, revoke device A's session.
- On device A, attempt a privileged action; assert it fails with
  401 and triggers re-auth prompt that cannot succeed without
  re-enrollment.

### T7 — Phishing of a worker rep

**Design mitigations:** Passkeys (domain-bound; can't be phished); no
password fallback; no SMS fallback; no email magic links.

**Residual:** A social-engineering attack tricking the user to enroll
a new passkey on an attacker domain. Mitigated by passkey's domain
binding — a passkey for `jhsc.example.ca` does not authenticate at
`jhsc-example.com`.

**Test:** End-to-end test:
- Attempt to register a passkey at `app.example.com`.
- Attempt to use that passkey at `app.evil.com` and assert WebAuthn
  rejects (origin mismatch).

### T8 — Account enumeration / membership disclosure

**Design mitigations:** No public sign-up; invite-only; auth endpoint
doesn't distinguish "unknown user" from "wrong credential."

**Residual:** Knowing the app exists at `app.example.ca` reveals that
some committee uses it. Mitigated by not advertising publicly.

**Test:** Integration test:
- POST auth endpoint with unknown user ID; capture response.
- POST auth endpoint with known user ID, wrong credential; capture
  response.
- Assert responses are byte-identical (status, body, headers, timing
  within tolerance).

### T9 — Telemetry / error-tracker leakage

**Design mitigations:** ADR-0010 Sentry SaaS EU + SDK-layer scrubbing;
allowlist on extras; CI fixture test.

**Residual:** A new code path sends data the scrubber didn't anticipate.

**Test:** Integration test:
- Submit a form containing a known canary string (e.g., `CANARY_PII_X`).
- Trigger an error.
- Capture the would-be Sentry payload (mock the transport).
- Assert payload does NOT contain `CANARY_PII_X` anywhere.

### T10 — Forced disclosure of who installed the app

**Design mitigations:** PWA only (ADR-0011); no app store account; no
install record at Apple/Google.

**Residual:** Browser-side install fingerprinting (e.g., browser cache
of the manifest). Not realistically subpoenable.

**Test:** Inventory test:
- CI fails if `package.json` or build output includes any iOS / Android
  bundler or React Native dependency.

### T11 — Compelled access from a worker rep under duress

**Design mitigations:** v1 = visible audit log + post-coercion
notification (plan §13 item 5: duress mode is v2). Audit log entries
for sensitive reads are visible to all active members.

**Residual:** Single act of coerced access is performed; mitigation
is detection + post-hoc notification, not prevention.

**Test:** Integration test:
- Member A reads a C4 row.
- Member B (any other active member) logs in.
- Assert member B sees a "recent sensitive read" notification or list
  item identifying the read (actor, target, ts).

### T12 — "AI feature" exfiltration

**Design mitigations:** No third-party AI in v1; no client telemetry
to AI services; CSP locks down outbound origins.

**Residual:** A future PR introduces an AI feature without a fresh
human-gate ADR.

**Test:** CSP and dependency tests:
- CI fails if a new outbound origin appears in CSP without an ADR
  reference in the PR description.
- CI fails if `package.json` adds a dependency whose name matches
  known AI SDKs (`openai`, `anthropic`, `cohere`, etc.) without an
  ADR reference.

---

# Ordered task list (refines plan §11.2)

19 tasks. Each lists default reviewers (security, privacy, adversarial)
plus any extra reviewers required. Phase-2 builder loop applies:
test-writer → implementer → verifier → reviewers → second-opinion (where
flagged) → PR → human-gate review.

### T00 — Scaffold project + verify gates

**Goal:** Create `apps/web/` SvelteKit app, wire `scripts/verify.sh`,
GitHub Actions, `.env.example`, `.gitignore`. No features.

**Acceptance:**
- `pnpm verify` passes on a fresh clone.
- CI runs verify on PR.
- gitleaks + semgrep + ts + lint in CI green.
- README explains repo layout in 1 page.
- RLS-coverage check in `verify.sh` (placeholder until tables exist).

**Default reviewers + extras:** standard set.

**Risk:** Low. **Estimate:** S (1 day).

### T01 — Supabase project setup + region pin + CI check

**Goal:** Create Supabase project in `ca-central-1`; wire env, secrets,
and a CI check that asserts the project's region.

**Acceptance:**
- Project exists in `ca-central-1`; verified via Supabase mgmt API.
- CI job fails if the configured project metadata returns a non-CA region.
- `SUBPROCESSORS.md` created with Supabase + (planned) Sentry + (planned) backup bucket.
- Backup PITR enabled (7 days).
- Connection string + service-role key never logged or committed.

**Extras:** **security-reviewer + privacy-reviewer** required (hosting
provider gate per ADR-0001).

**Risk:** Low. **Estimate:** S (1 day).

### T02 — Observability setup (Sentry + structured logs + PI scrubber)

**Goal:** Sentry SaaS EU + SDK-layer scrubber + canary-PII test; structured
logger with PI scrubbing for app logs.

**Acceptance:**
- `beforeSend` strips: cookies, auth headers, query params, all form bodies,
  user IDs; allowlist for category-only breadcrumbs.
- Canary-PII test in CI asserts no canary leaks through the scrubber.
- Logger has a `safeFields` allowlist; everything else dropped or hashed.
- Sentry added to `SUBPROCESSORS.md`.
- Documented in `playbooks/`.

**Extras:** **privacy-reviewer** with heightened scrutiny.

**Risk:** Low. **Estimate:** S (1 day).

### T03 — i18n catalog scaffold (en-CA only)

**Goal:** Wire `svelte-i18n` (or equivalent), seed `en-CA.json`, create
empty `fr-CA.json` skeleton, ESLint rule `no-literal-strings`.

**Acceptance:**
- All UI strings go through `t()`.
- Build fails on hard-coded user-facing strings.
- Locale-aware date/number/currency helpers exist.
- `<html lang>` set correctly.

**Extras:** **localization-specialist** owns; accessibility-specialist reviews
language attributes.

**Risk:** Low. **Estimate:** S (0.5 day).

### T04 — Schema baseline + RLS-on-everything + policy tests

**Goal:** Initial Drizzle migration: `users`, `committee_membership`,
`committee_key`, `audit_log`. RLS enabled with policies per the outline above.

**Acceptance:**
- Every table has RLS enabled.
- CI check finds zero tables without RLS.
- Positive + negative policy tests for each table.
- Audit log is append-only at the DB level (REVOKE UPDATE/DELETE except for
  retention-job role).
- Migration is reversible (down migration exists).

**Extras:** **migration-handler** owns; **security-reviewer + adversarial-reviewer**.

**Risk:** Medium. **Estimate:** M (2 days).

### T05 — Auth: passkeys + TOTP bootstrap + session model

**Goal:** Implement Supabase Auth with WebAuthn passkeys; first-device TOTP
enrollment that is consumed and destroyed on first passkey set; 15-min
sessions; session list + revoke-all.

**Acceptance:**
- Login flow: invite → TOTP from invite → passkey enroll → passkey-only
  thereafter.
- No password is ever set on the account.
- Session token TTL ≤ 15 min; no long-lived refresh token.
- Session list in settings; revoke-all works.
- T7 test passes (passkey origin binding).
- T8 test passes (account enumeration prevented).
- Minimum-browser-baseline gate in onboarding.

**Extras:** **second-opinion-reviewer** mandatory (auth). **security-reviewer + adversarial-reviewer** with heightened scrutiny.

**Risk:** High. **Estimate:** L (4 days).

### T06 — Committee + invite + role assignment

**Goal:** Co-chair can invite a worker member; role flags
(worker_member, worker_co_chair, certified_member); active/inactive flag;
removal flow that triggers key-rotation hook (implemented in T07).

**Acceptance:**
- Invite flow works end-to-end (T05 prerequisite).
- Role changes audit-logged.
- Removal marks inactive immediately; 90-day grace before key destroy.
- Co-chair cannot remove themselves without another co-chair (4-eyes).
- Single-tenancy assertion: no `committee_id` parameter exists anywhere
  in the API surface (CI test enforces).

**Extras:** **adversarial-reviewer** with heightened scrutiny.

**Risk:** Medium. **Estimate:** M (2 days).

### T07 — E2EE key core: identity keys, committee key, wrapping, rotation

**Goal:** libsodium-wrappers module; identity key generation; recovery
passphrase enrollment; committee key generation; per-member wrap;
rotation on member removal.

**Acceptance:**
- All seven invariants from ADR-0003 are encoded as tests.
- T1 ciphertext-shape test passes.
- T5 backup-ciphertext test passes.
- Recovery passphrase: user must type-back to confirm before exit.
- Rotation: integration test removes a member and asserts (a) their
  wrapped row is deleted, (b) remaining members have a new wrap, (c)
  new C3 writes use the new public key, (d) old C3 ciphertext stays
  readable to remaining members via the rotated wrap chain.
- No private key material in any URL, query string, log line, or
  Sentry event (canary test).
- **(Amended 2026-05-22, HG-2 / ADR-0003 Amendment A) Invariant 8 — key-material mutation audit-log enum:**
  - Every code path that mutates `committee_key.*`, `users.identity_pubkey`, or `users.identity_privkey_recovery_blob` emits exactly one audit-log row drawn from the closed enum {`identity_keypair.created`, `identity_privkey.recovery_blob.written`, `identity_privkey.recovery_blob.restored`, `committee_data_key.wrapped_for_member`, `committee_data_key.unwrap`, `committee_data_key.rotation.started`, `committee_data_key.rotation.completed`, `committee_data_key.member_revoked`}, hash-chained to the previous row, with the required fields per ADR-0003 Amendment A.
  - Integration tests fire each of the 8 flows and assert the corresponding audit row appears with valid `prev_hash`, `actor_id`, target ids, and `rotation_id` where applicable.
  - CI grep test: any code path mutating key-material columns that is NOT paired with one of the 8 enum emissions fails CI.
  - Negative test: corrupt the audit-emission path for `committee_data_key.rotation.completed`; assert the rotation is aborted (audit is precondition, not side-effect).
  - **F-50 alert wiring**: the audit-log integrity check job (T18) alerts on (a) `committee_data_key.rotation.started` without a matching `.completed` within 5 minutes, (b) any `committee_data_key.member_revoked` without a paired `.rotation.completed` in the same `rotation_id`, (c) any `committee_data_key.wrapped_for_member` for a `target_member_id` whose `committee_membership.active` is false at emission time. T07 emits the enum; T18 wires the alerts; both tests required.
- **(Amended 2026-05-22, amendment pass #3, HG-12 / ADR-0003 Amendment F) Recovery-passphrase show-again accommodation:**
  - Surface D.6 gains a "show passphrase again" secondary link returning to a constrained D.4-variant (the reveal surface), gated by four invariants per ADR-0003 Amendment F.
  - **Audit-log enum addition:** `identity_privkey.recovery_blob.viewed` added to the closed allowlist per ADR-0003 Amendment A; retention per ADR-0015 is **membership + 24 months**.
  - **Test (M-54a hold-to-reveal):** Surface D.6 "show again" control — normal click (release <100ms) does NOT reveal the passphrase in the DOM (no `data-testid='recovery-passphrase-onscreen'` becomes visible); sustained pointer-down OR Space-keydown OR Enter-keydown for ≥1500ms reveals; release hides within 50ms.
  - **Test (M-54b audit-log emission gates render):** every successful reveal emits exactly one `identity_privkey.recovery_blob.viewed` audit-log row BEFORE the passphrase becomes visible in the DOM with `{actor_id, enrollment_session_id, reveal_count_in_session, ts}`. Mock the audit-log endpoint to return 500; trigger "show again"; assert the passphrase is NOT rendered AND a danger toast appears. Trigger three successful reveals; assert three rows with `reveal_count_in_session` = 1, 2, 3.
  - **Test (M-54c per-enrollment-session cap of 3):** three successful reveals succeed; fourth attempt: control is `aria-disabled=true`, no audit row, helper text directs to restart enrollment. Restart enrollment → fresh `enrollment_session_id`; "show again" invocable again up to 3 times in the new session.
  - **Test (M-54d no TTS, no clipboard on reveal):** Surface D.6 reveal state contains no element with `data-testid='copy-passphrase'`. Static lint: zero matches for `SpeechSynthesisUtterance`, `window.speechSynthesis`, `tts` in `src/lib/onboarding/recovery/*` outside test fixtures.
  - **i18n contract:** en-CA keys `onboarding.recovery.show_again.label` and `.helper` exist with plain-language consequence-naming text (localization-specialist owns the catalog; architect ratifies the contract).

**Extras:** **second-opinion-reviewer** mandatory (crypto). **security-reviewer + adversarial-reviewer** with heightened scrutiny. **privacy-reviewer** signs off. **accessibility-specialist** sign-off on Surface D.6 reveal surface (WCAG 2.0 AA per HG-10 + AODA gate, NOT architect-owned).

**Risk:** High. **Estimate:** L (6 days; +0.5 day for Invariant 8 enum + alert wiring; +0.5 day for Amendment F M-54a/b/c/d show-again invariants + audit-log enum extension).

### T08 — Member concern intake (anonymous-by-default) + hazard register read

**Goal:** Committee-members-only intake form; anonymous toggle defaults
ON; encrypts client-side; concerns list view with decrypt-and-render.

**Acceptance:**
- T3 test passes (anonymous concerns never expose source field).
- Title + body + optional source_name encrypted with committee key.
- source_name is C4 (additional per-record key).
- "Reveal source" action gated by passphrase + audit-logged.
- RLS denies inserts unless `is_active_member()`.
- Route inventory test asserts no public-write route exists.
- Form is WCAG 2.0 AA; designer + accessibility-specialist sign off.

**Extras:** **privacy-reviewer** with heightened scrutiny.

**Risk:** Medium. **Estimate:** M (3 days).

### T09 — Hazard register: status workflow + filtering + edit

**Goal:** Triage concerns into hazard register with status, severity,
location, owner, dates.

**Acceptance:**
- Status enum: open, triaged, controls-in-progress, monitoring, closed.
- Closed entries start retention clock.
- Severity, location, owner are C1 metadata (not encrypted) — confirmed
  with privacy-reviewer.
- Filtering by status/severity/location.
- All edits audit-logged.

**Extras:** standard.

**Risk:** Low. **Estimate:** M (2 days).

### T10 — Inspections: offline + photo + sync

**Goal:** Monthly inspection checklists; offline-first via service worker;
photo capture; client-side encryption before upload; sync queue.

**Acceptance:**
- Inspector can complete an inspection fully offline.
- Photos encrypted client-side before any network call.
- Queue persists across PWA close/reopen.
- Sync on reconnect; conflicts surfaced for user review.
- GPS off by default; opt-in per inspection.
- Photos in Supabase Storage are ciphertext.
- **(Amended 2026-05-22, HG-4 / ADR-0014) Offline-queue HMAC integrity:**
  - Every queued entry in IndexedDB is tagged with a BLAKE2b-256 keyed MAC under a per-user device-bound key derived via HKDF from the identity private key (HMAC key never leaves the device). Algorithm: `libsodium.crypto_generichash` with `key` parameter; HKDF construction per ADR-0014.
  - Tag scope: `(sequence_number_u64_be || user_id_uuid_bytes || ciphertext)`.
  - On queue drain (before POST): client recomputes the tag from in-memory K_hmac; mismatch quarantines the entry to `rejected_queue_entries` IndexedDB store + posts `queue.integrity_fail` audit row + surfaces a user banner. No POST.
  - Server stores `client_integrity_tag BYTEA NOT NULL` alongside the row for downstream re-verification.
  - **Test (deterministic tamper):** offline-queue entry is written; one byte of `ciphertext` is corrupted in IndexedDB between queue-and-sync; verification fails on drain; assert no POST occurs, the `queue.integrity_fail` audit row queues for next online, and the user-visible banner appears.
  - **Test (cross-device replay):** copy a queue entry from device B's IndexedDB into device A's IndexedDB; on device A drain, the `user_id` field in the MAC scope does not match A's K_hmac derivation; verification fails; entry rejected.
  - **Test (positive):** un-tampered entry drains, server stores `client_integrity_tag`, subsequent client read re-verifies tag matches the ciphertext read back.
- **(Amended 2026-05-22, HG-5 / ADR-0011 amendment) EXIF / IPTC / XMP / GPS strip on photos:**
  - All photo input (camera capture, file upload) is passed through `src/lib/photo/sanitize.ts` which (a) strips EXIF, IPTC, XMP via known-good library, (b) re-encodes through HTMLCanvasElement (decode → canvas → JPEG/PNG re-encode at configured quality) for defense-in-depth metadata removal.
  - Sanitize step runs BEFORE the libsodium `crypto_secretbox` call; no path uploads or persists raw-from-camera bytes.
  - GPS coordinates are explicitly removed; if a worker wants to record a location, they enter free text or select from the `location_id` enum (C1 metadata). The app-level GPS toggle remains opt-in, off by default, and is independent of EXIF.
  - **Test (round-trip):** feed a photo with known EXIF GPS tags (lat/lon at workplace coords), IPTC by-line, XMP creator-tool tags through the pipeline; capture ciphertext blob; decrypt with the test committee key; pass decrypted bytes through an EXIF/IPTC/XMP parser; assert ZERO tags present and ZERO GPS coords.
  - **Test (defensive byte-grep):** decrypted bytes grepped for decimal-degree-shaped strings within the workplace's province bounding box; assert none present.
- **(Amended 2026-05-22, HG-3 / ADR-0013) Service-worker plaintext-cache allowlist:**
  - Service-worker fetch handler implements a closed URL-pattern allowlist per ADR-0013: `/`, `/index.html`, `/_app/**`, `/favicon.*`, `/manifest.webmanifest`, `/locales/*.json`, `/library/*`, `/feature-flags`, `/schema-version` are cacheable; everything else (especially `/api/**`) is not cached by the service worker.
  - Fetch handler inspects response headers for `X-Data-Class: C3` or `X-Data-Class: C4`; if present, the response is forwarded to the page but NOT cached. Server emits `X-Data-Class` on every response returning rows from C3/C4 tables.
  - On lock / logout / panic-wipe: all caches outside the static-asset allowlist deleted; session-scoped IndexedDB stores cleared.
  - Build-hash bump invalidates everything (no stale carryover).
  - **Test (snapshot — required):** SW snapshot fixture in `apps/web/test/sw-cache.snapshot.test.ts`. Install the service worker in a cold Cache Storage; execute a scripted login + visit-each-route flow; enumerate Cache Storage contents post-flow; assert exact match against a frozen JSON snapshot of allowed entries. Any unexpected cache entry fails CI; any missing expected entry fails CI. Updating the snapshot requires reviewer approval in the PR.
  - **Test (sanity check):** craft a fake response with `X-Data-Class: C3`; route it through the fetch handler; assert the response is not placed in any cache and a `client.cache_policy_violation` audit row queues.

**Extras:** **security-reviewer + accessibility-specialist** (mobile UX); **second-opinion-reviewer** on the HMAC integrity module (crypto-adjacent).

**Risk:** Medium-High (raised from Medium given HMAC + SW policy). **Estimate:** L (5 days; +1 day for HG-3/HG-4/HG-5 amendments).

**Note:** The service-worker policy work originally proposed as a new T20 sub-task is folded into T10 above. There is no separate T20; the snapshot test and policy module live in the T10 deliverable. The service-worker file itself is created during T00/T09 scaffolding work but the policy / allowlist / snapshot test is binding from T10 onward and must pass before T10 ships.

### T11 — Meeting prep + draft minutes + finalize-and-export

**Goal:** Pull unresolved items; draft minutes; finalize by co-chair;
export to PDF in browser.

**Acceptance:**
- Drafts are C3; retention 90 days post-finalization.
- Finalized minutes are C3; retention 7y.
- Export rendering is in-browser (no plaintext to server).
- Export interstitial lists every field included before download.
- Export audit-logged with target ID + recipient role.
- T3 source-name exclusion test passes for exports.

**Extras:** **privacy-reviewer** with heightened scrutiny (export = T3 surface).

**Risk:** Medium. **Estimate:** L (4 days).

### T12 — Recommendations to employer + 21-day timer

**Goal:** Draft recommendations; co-chair signs and exports; 21-day
response timer; employer-response capture.

**Acceptance:**
- 21-day clock starts on "sent" action.
- Reminder at day 14, 18, 21.
- Employer-response capture is a separate manual entry by the rep (no
  inbound channel).
- Export rendering identical posture to T11.

**Extras:** **privacy-reviewer** on exports.

**Risk:** Medium. **Estimate:** M (3 days).

### T13 — Reprisal log (C4, 4-eyes destructive ops)

**Goal:** Highest-confidentiality entry type. Per-record passphrase;
4-eyes deletion; visible "recent sensitive read" notification (T11
mitigation).

**Acceptance:**
- All writes are C4 (per-record key wrapping).
- DELETE requires `pending_destructive_ops` two-member approval.
- Reads are audit-logged with high salience; T11 test passes.
- Author can read; co-chair can read; certified_member can read.
- No automatic inclusion in any export.
- **(Amended 2026-05-22, HG-6 / ADR-0003 Amendment B) Server-side enforced C4 read-audit:**
  - Direct SELECT on `reprisal_log` (and other C4 tables) is **revoked** from `authenticated`, `anon`, `service_role`. Only `c4_read_service` (a non-login role owned by `migration_role`) has SELECT on the underlying table.
  - Clients read C4 rows exclusively through a `SECURITY DEFINER` view `reprisal_log_read_audited` (or equivalent Edge Function indirection) that performs SELECT + `sensitive.read` audit INSERT atomically in a single transaction. Audit-emission failure rolls back the SELECT.
  - **Test (direct bypass):** with a valid authorized member's JWT, attempt `SELECT * FROM reprisal_log` directly (not through the view); assert zero rows AND no audit row.
  - **Test (indirection success):** SELECT from `reprisal_log_read_audited` as an authorized member; assert (a) row returned, (b) exactly one `sensitive.read` audit-log row appears with matching `target_id`, `actor_id`, and same-transaction timestamp.
  - **Test (atomicity):** induce a `jhsc_log_sensitive_read` failure (e.g., temporarily revoke INSERT on `audit_log` for `c4_read_service`); assert the SELECT rolls back; no row returned; no partial audit row.
  - **Test (coverage):** `pg_proc` + `information_schema` enumeration in CI asserts every C4 table (`reprisal_log`, `work_refusal`, `s51_evidence`) has a corresponding `*_read_audited` view (or documented Edge Function path) AND the underlying table's SELECT GRANT for `authenticated`/`anon`/`service_role` is empty.
  - The previous client-cooperative pattern (client POSTs the audit row before rendering plaintext) is downgraded to a UX hint only; canonical audit is the server-emitted row.
- **(Amended 2026-05-22, HG-7) Soft-delete gating — status-flip equivalent to DELETE:**
  - Any UPDATE on `reprisal_log` that flips `status` to any "removed-like" value (`deleted`, `archived`, `redacted`, `tombstoned`) requires the same 4-eyes flow as a hard DELETE: a row in `pending_destructive_ops` with two distinct `approver_id`s.
  - RLS / CHECK constraint reads `pending_destructive_ops` and rejects the UPDATE if quorum is not present.
  - True hard-DELETE on `reprisal_log` rows is fired only by the retention job (T16) when the entry has aged out; never by user action.
  - **Test (single-rep status flip):** as a single co-chair, attempt UPDATE `status = 'deleted'`; assert RLS denies with a clear "needs second member" error path (the implementer's choice between RLS-deny + structured error vs. RPC indirection — either way, the user-facing message names that a second member is required).
  - **Test (4-eyes status flip):** propose status-flip via `pending_destructive_ops`; second distinct active member approves; UPDATE succeeds; audit log captures two rows (`proposal`, `approval`) with both members named, hash-chained.
  - **Test (self-approve denied):** proposing member attempts to approve their own proposal; RLS denies.
  - **Test (retention-only hard-delete):** a user attempting `DELETE FROM reprisal_log` directly is denied regardless of role (per the existing "Co-chair only with 4-eyes" RLS, now tightened so even the 4-eyes flow does NOT permit hard DELETE — only the retention job's service role does); the retention job at T16, on aged-out entries, performs the hard DELETE.
- **(Amended 2026-05-22, amendment pass #3, HG-13 / ADR-0003 Amendment D) Pseudonymized reprisal-feed projection:**
  - New `SECURITY DEFINER` view `reprisal_audit_feed_pseudonymized` owned by `c4_read_service` projects `{id, event_type, ts_bucketed_to_hour, target_id, target_class, prev_hash, hash}` for `event_type IN ('reprisal.created', 'reprisal.read', 'reprisal.status_changed.4eyes_pending', 'reprisal.status_changed.4eyes_completed')`; `actor_pseudonym` is **suppressed in the projection**.
  - Direct SELECT of `actor_pseudonym` for reprisal-event rows is **revoked** from `authenticated`, `anon`, `service_role` (column-level revoke OR row-level RLS; migration-handler chooses the path, but both paths must be covered by tests per privacy-review §7 closing note).
  - GRANT SELECT on the view to `authenticated`; active members read the visible feed through the view.
  - **Default list payload for `reprisal.*` events comes from the pseudonymized view, NEVER the raw table**, even when querying for one's own activity (privacy-review §4 cross-cutting observation #5; mirrors F-18).
  - **Test (pseudonymized feed projection — privacy-review §7 obligation 1):** SELECT from `reprisal_audit_feed_pseudonymized` as an active member; assert the returned columns are `{id, event_type, ts_bucketed_to_hour, target_id, target_class, prev_hash, hash}` and do NOT contain `actor_pseudonym`.
  - **Test (direct bypass — privacy-review §7 obligation 2):** as an active member, attempt `SELECT actor_pseudonym FROM audit_log WHERE event_type LIKE 'reprisal.%'`; assert RLS or GRANT-revoke returns zero rows for the `actor_pseudonym` column. Test both architectural paths.
  - **Test (time bucketing — privacy-review §7 obligation 3):** emit a `reprisal.created` row at a known microsecond timestamp; SELECT from the feed view; assert `ts_bucketed_to_hour` is rounded to the hour AND the underlying `audit_log.ts` retains the original microsecond.
  - **Test (default-list-payload exclusion — privacy-review §4 cross-cutting observation #5):** the "my activity" feed for reprisal events returns the projection shape, not the raw row.
- **(Amended 2026-05-22, amendment pass #3, HG-13 / ADR-0003 Amendment E) Forensic-reveal 4-eyes procedure:**
  - New `pending_forensic_reveals` table (mirrors `pending_destructive_ops`) — `{id, target_audit_log_id, proposer_id, proposed_at, proposer_reason, approver_id?, approved_at?, revealed_actor_pseudonym?, expires_at, expired_at?}`.
  - New `forensic_read_service` non-login Postgres role owned by `migration_role` with SELECT on the underlying `audit_log.actor_pseudonym` column; invoked exclusively via the `SECURITY DEFINER` function `jhsc_forensic_reveal_actor_pseudonym(target_audit_log_id uuid)`.
  - Two new audit-log enum values: `audit.forensic_reveal.4eyes_pending` (proposal) and `audit.forensic_reveal.4eyes_completed` (approval). Both hash-chained per ADR-0003 Amendment A; both retain at 7 years per ADR-0015.
  - Approver pair: co-chair + co-chair (for dual-co-chair committees) OR co-chair + certified_member (for single-co-chair committees). RLS denies `approver_id = proposer_id`.
  - Reveal session is bounded to 24 hours from approval; expiry job clears `revealed_actor_pseudonym` and sets `expired_at`.
  - **Test (proposer-cannot-self-approve — privacy-review §7 obligation 4):** propose a forensic reveal for `audit_log_id = X`; same proposer attempts to approve; assert RLS denies; no `audit.forensic_reveal.4eyes_completed` row written.
  - **Test (distinct-member approval succeeds):** member M proposes; distinct member N (per the committee's role-pair rule) approves; assert (a) `audit.forensic_reveal.4eyes_pending` row written on proposal AND (b) `audit.forensic_reveal.4eyes_completed` row written on approval AND (c) both hash-chain correctly AND (d) `revealed_actor_pseudonym` populated AND (e) M and N read it via the function for ≤24h.
  - **Test (non-pair attempt denied):** N attempts to approve where N is a non-co-chair worker-member and the committee is single-co-chair; assert RLS denies.
  - **Test (reveal-session expiry):** approved reveal where `now() > expires_at`; assert function returns NULL/error and the column is cleared.
- **(Amended 2026-05-22, amendment pass #3, HG-13 / ADR-0007 amendment) Reprisal-log intake consent surface:**
  - Surface C (reprisal-entry intake form) renders the four-bullet consent surface (verbatim text from privacy-review §2.4, folded into `i18n/en-CA/reprisal-intake.json` by the localization-specialist).
  - The "Save entry" button is structurally gated (submit handler short-circuits) until the consent checkbox is checked.
  - The consent surface re-renders on every intake (no "I've already seen this" suppression flag).
  - **Test (consent surface presence — privacy-review §7 obligation 5):** snapshot test that the reprisal-intake form renders the four "what other members will / will NOT see" bullets and the consent checkbox AND the "Save entry" button is `aria-disabled=true` (or its submit short-circuits) until the checkbox is checked.
  - **Test (per-intake re-render):** open Surface C, close without saving, reopen; assert the consent surface re-renders fresh (no suppression cookie / flag).
- **(Amended 2026-05-22, amendment pass #3, HG-13 bundling) Coverage extension for T14:**
  - The Amendment D pseudonymized projection is extended to `work_refusal.*` and `s51_evidence.*` write events when T14 enumerates them (the view's `event_type IN (...)` predicate is amended in T14's migration). T13 ships the projection covering reprisal-events only; T14 ships the extension. Test obligations 1–3 above repeat for T14 events (privacy-review §7 obligation 6).

**Extras:** **second-opinion-reviewer** + **privacy-reviewer** + **adversarial-reviewer** all with heightened scrutiny. **labour-lawyer review (HG-10)** of the consent-surface copy in §2.4 of privacy-review. **accessibility-specialist sign-off** on the consent surface (WCAG 2.0 AA).

**Risk:** High. **Estimate:** L (6 days; +1 day for HG-6 server-side indirection + HG-7 status-flip gating; +1 day for HG-13 pseudonymized projection + forensic-reveal 4-eyes + consent surface).

### T14 — Work refusal (s.43) + critical injury (s.51) checklists

**Goal:** Certified-member-only checklists for s.43 and s.51 workflows;
protected notes (C4); Ministry-of-Labour notification timing for s.51.

**Acceptance:**
- Access restricted to certified_member + co-chair.
- Notes are C4.
- s.51 evidence photo capture goes through inspection's encrypted-upload
  path.
- Ministry notification deadline countdown surfaced; user actions are
  off-app (the app does not call the Ministry).
- **(Amended 2026-05-22, F-C / ADR-0003 Amendment A extension) Server-side enforced C3 read-audit on T14 tables — identical posture to T13's HG-6:**
  - Direct SELECT on `work_refusal` and `s51_evidence` is **revoked** from `authenticated`, `anon`, `service_role`. Only `c4_read_service` (the existing non-login role from HG-6) has SELECT on the underlying tables.
  - Clients read through `SECURITY DEFINER` views `work_refusal_read_audited` and `s51_evidence_read_audited` that perform SELECT + audit INSERT atomically in a single transaction; audit-emission failure rolls back the SELECT.
  - The audit INSERT uses the chain-emission enum values `work_refusal.read` and `s51_evidence.read` per ADR-0003 Amendment A extension (added to the closed allowlist this amendment pass).
  - **Test (direct bypass):** with a valid authorized certified_member's JWT, attempt `SELECT * FROM work_refusal` directly (bypassing the view); assert zero rows AND no audit row. Same test on `s51_evidence`.
  - **Test (indirection success):** SELECT from `work_refusal_read_audited` as an authorized member; assert (a) row returned, (b) exactly one `work_refusal.read` audit-log row with matching `target_id`, `actor_pseudonym`, same-transaction timestamp. Same on `s51_evidence_read_audited`.
  - **Test (atomicity):** induce a `jhsc_log_sensitive_read` failure for the `work_refusal_read_audited` path; assert SELECT rolls back; no row returned; no partial audit row. Same on `s51_evidence_read_audited`.
  - **Test (coverage):** `pg_proc` + `information_schema` enumeration in CI asserts both T14 C3 tables have corresponding `*_read_audited` views AND underlying-table SELECT GRANT for `authenticated`/`anon`/`service_role` is empty.
- **(Amended 2026-05-22, HG-5 / ADR-0011 amendment, cross-reference) EXIF / IPTC / XMP / GPS strip on s.51 evidence photos:**
  - s.51 evidence photo capture uses the same `src/lib/photo/sanitize.ts` pipeline as T10 inspections — strip + canvas re-encode before encryption. Already implied by "s.51 evidence photo capture goes through inspection's encrypted-upload path" above; this bullet makes the dependency explicit so the test-writer carries the round-trip and byte-grep tests from T10 over to T14 fixtures.

**Extras:** **second-opinion-reviewer** + **privacy-reviewer**.

**Risk:** High. **Estimate:** L (4 days; +0.5 day for T14 C3-read indirection mirroring T13 HG-6 posture).

### T15 — Training records + document library + reminders

**Goal:** Certified-member status, refresher dates, training evidence;
OHSA/Reg quick-ref doc library; reminders engine.

**Acceptance:**
- Training records C2; evidence blobs E2EE.
- Document library is C0 — read-only seed content via migrations.
- Reminders: certified-member refresh, monthly inspection, annual review.
- Reminder content does not include PI (just a link into the app).

**Extras:** standard.

**Risk:** Low. **Estimate:** M (2 days).

### T16 — Right of access / correction / deletion + retention job

**Goal:** PIPEDA Principle 9 endpoints; daily retention job hard-deletes
per the schedule in plan §8.

**Acceptance:**
- "Export my data" produces a JSON bundle (decrypted in browser, downloaded).
- Correction endpoints for user-owned fields.
- Deletion = real delete (or crypto-shred for E2EE'd records).
- Retention job runs daily; logged; alerts on failure.
- Retention deletions are audit-logged.
- Test fixtures simulate aged data; assert deletion.
- **(Amended 2026-05-22, amendment pass #3, HG-14 / ADR-0015) Per-event-type audit-log retention schedule:**
  - The retention job replaces the single `WHERE ts < now() - interval '24 months'` filter with an `event_type`-keyed retention function reading from the `audit_log_retention_schedule` table (one row per enum value with a `retention_interval` per ADR-0015's authoritative table).
  - **Schema requirements (per ADR-0015):**
    - `audit_log.retention_class text NOT NULL` column, populated by the `audit_emit` SECURITY DEFINER function at write time; CHECK constraint references the schedule.
    - `audit_log_retention_schedule` table (version-controlled migration; one row per `event_type` enum value).
    - **CI drift assertion:** every value in the `event_type` CHECK constraint has exactly one row in `audit_log_retention_schedule`; every row in the schedule table references a value in the enum. Drift fails CI.
  - **Underlying-record-ceiling rule (privacy-review §3.5):** audit-log rows linked via `target_id` to a record in another table MUST NOT outlive the linked record by more than 30 days. The retention pass deletes orphaned audit rows within 30 days of the linked record's deletion. **Carve-out:** `retention.deleted` summary rows are independently retained at 7 years (no `target_id`).
  - **`retention.deleted` jsonb shape:** `meta.deleted_per_table.audit_log_per_event_type` is a jsonb of `{event_type: count}` per pass (replaces the prior single-count shape).
  - **Test (per-event retention schedule honored — privacy-review §7 obligation 7):** fixture inserts audit rows of every enum value with `ts` at 89 days, 91 days, 23 months, 25 months, 6 years 11 months, 7 years 1 month. Run retention pass in dry-run; assert the deletion set matches the ADR-0015 schedule exactly. Run live; assert the same.
  - **Test (audit-row-cannot-outlive-target rule — privacy-review §7 obligation 8):** fixture inserts a `concern.created` audit row with `target_id = X`; the underlying concern row X is hard-deleted by an earlier retention pass. Run the next retention pass; assert the orphaned audit row is queued for deletion within 30 days of the concern's deletion.
  - **Test (retention-pass summary row retention — privacy-review §7 obligation 9):** fixture inserts a `retention.deleted` row from 6 years ago. Run retention pass; assert the summary row is NOT deleted (7-year retention; carve-out from the ceiling rule because no `target_id`).
  - **Test (schedule-table vs enum drift — privacy-review §7 obligation 10):** CI assertion: every value in the `event_type` CHECK constraint has exactly one row in `audit_log_retention_schedule`; every row in the schedule table references a value in the enum. Drift fails CI. (Tested by adding a phantom enum value or schedule row in a side branch; CI rejects.)
  - **Test (`retention.deleted` per-event-type counts — privacy-review §7 obligation 11):** run a retention pass that deletes rows of three different event types; assert the emitted `retention.deleted` row's `meta.deleted_per_table.audit_log_per_event_type` jsonb correctly enumerates the counts per event type.
  - **HG-14 — user explicitly ratifies the per-event-type retention schedule before T16 ships.** The schedule table is the authoritative artifact; ADR-0015's table is the proposed final state for ratification.

**Extras:** **privacy-reviewer** owns approval. **HG-14 (user ratification of ADR-0015's per-event schedule) before T16 ships.**

**Risk:** Medium. **Estimate:** M (4 days; +1 day for HG-14 / ADR-0015 per-event schedule, schema additions, drift check, and the five new test obligations).

### T17 — Backup + restore drill playbook

**Goal:** Nightly `pg_dump` to Canadian bucket, encrypted with escrowed key;
quarterly restore drill into a scratch project; alert if backup is stale.

**Acceptance:**
- Backup runs nightly; alerts on >36h freshness.
- Restore playbook produces a signed report.
- First end-to-end drill executed and signed before launch (human gate per plan §13.F).
- `SUBPROCESSORS.md` updated with backup bucket.
- **(Amended 2026-05-22, HG-8 / ADR-0012 amendment) Object Lock + versioning + lifecycle hard-delete:**
  - Bucket provisioned in Backblaze B2 Canadian region with:
    - **Object Lock enabled, governance mode, default retention 35 days** per object. Every nightly dump is written with retain-until = now + 35 days.
    - **Versioning enabled.**
    - **Lifecycle rule:** hard-delete versions whose object-creation timestamp is older than 35 + 7 = 42 days. The hard delete preserves crypto-shred-on-retention (old encrypted backups cannot linger past the rotation window).
    - **Workflow credential scoped to PutObject + GetObject + ListObjects only**; no DeleteObject, no BypassGovernanceRetention, no PutObjectLockConfiguration.
  - **Test (overwrite creates new version):** with the workflow write credential, overwrite an existing object; assert a NEW version is created and the prior version remains listable.
  - **Test (delete denied under retention):** with the workflow write credential, attempt to DeleteObject (or DeleteObjectVersion) on a version still within the 35-day retention; assert the call is denied with the expected error code (Object-Lock retention violation).
  - **Test (lifecycle hard-delete):** integration fixture or scheduled CI check verifies that an object aged > 42 days is no longer present in the bucket (a hold-out test object created during initial setup is verified to be gone after the lifecycle window in a delayed-assertion test, OR the lifecycle config itself is verified via Backblaze admin API in CI to delete > 42 days).
  - **Test (drift check, weekly CI):** read bucket config via Backblaze admin API; assert (a) versioning enabled, (b) Object Lock enabled with default retention = 35d governance, (c) lifecycle rule deletes versions > 42d, (d) the workflow credential's grants match the scoped list. Drift triggers an alert.
  - **Recovery-drill procedure update:** the drill playbook explicitly documents (a) how to restore a specific version of a dated dump under Object Lock — the read path is unchanged, only the write/delete is gated; (b) the operational override path for governance-mode (using the user's root credential held outside the workflow) for the rare case of a legitimate need to purge a specific dump containing a known-bad PII leak, with privacy-reviewer + user sign-off required.

**Extras:** **security-reviewer**.

**Risk:** Medium. **Estimate:** M (2.5 days; +0.5 day for HG-8 bucket config + drift check + drill amendments).

### T18 — Audit log integrity check job + sensitive-read notification

**Goal:** Daily hash-chain integrity check; alerts on mismatch; T11
"recent sensitive read" notification surface.

**Acceptance:**
- Audit log uses prev-hash chain; CI test covers tampering detection.
- Integrity job runs daily; alerts on mismatch.
- T11 test passes.
- **(Amended 2026-05-22, F-A / RA-2) Audit-log secondary witness via backup diff:**
  - The daily integrity job, in addition to the in-place hash-chain check, computes a diff against the most recent available `pg_dump` backup (ADR-0012, Object-Lock-protected per the HG-8 amendment): for all rows whose `ts < (latest_dump_ts - 1 hour)`, compare `(id, hash, prev_hash)` between live and backup. Any mismatch fires `A-AUDIT-001` (or sibling alert id named by observability-setup) — this is the v1 detection mechanism for the pivot-rewrite case RA-2 leaves unmitigated by the chain-alone check.
  - **Test (live-vs-backup-diff alert):** in a scratch project, take a `pg_dump` snapshot; mutate a row in the live `audit_log` for an `id` older than the snapshot (savepoint-bypass of UPDATE revocation, same shape as the in-place mutation test); run the diff check; assert the alert fires within the F-50 5-minute window.
  - **Test (no false-positive on rows newer than dump):** insert new rows after the snapshot; run the diff check; assert no alert (the diff only covers rows older than the dump by ≥1 hour).
  - **Manual control (documented in the runbook, not a code deliverable):** weekly extraction of the latest `(id, ts, hash)` head pointer emitted to the worker co-chair's off-app address as a manual external witness. Not a control under RA-2's compensating-controls list (so its absence does not re-open RA-2 by itself); the runbook documents the procedure.
- **(Amended 2026-05-22, F-C / ADR-0003 Amendment A extension) Volumetric-event exclusion from the chain:**
  - **Test:** execute 100 successful WebAuthn `auth.passkey.assert` events; assert zero new rows in `audit_log` with `event_type = 'auth.passkey.assert'` (per the chain-vs-structured-log architectural rule). Counter-test: assert 100 structured-log lines with `event = 'auth.passkey.assert'` were emitted at INFO level by the structured logger.
  - **Test (closed-enum coverage):** enumerate every code path that calls `audit_emit(...)` and assert each `event_type` argument is on the closed allowlist (the union of the existing enum + Amendment A's 8 key-material values + Amendment A extension's `work_refusal.read` and `s51_evidence.read`). Any new caller introducing a non-allowlisted value fails CI.

**Extras:** **adversarial-reviewer**.

**Risk:** Medium. **Estimate:** S (1.5 days; +0.5 day for RA-2 backup-diff check + F-C closed-enum coverage tests).

### T19 — Session revocation, panic wipe, onboarding copy

**Goal:** "Forget this device" + "Wipe local data" + "Revoke all sessions"
actions; first-launch advisory copy (ADR-0008); plain-language privacy
notice referencing ADR-0001 tradeoff.

**Acceptance:**
- T6 test passes (revocation).
- T2 test passes (panic wipe).
- Onboarding copy reviewed by tech-writer + privacy-reviewer.
- WCAG 2.0 AA on every onboarding screen.
- **(Amended 2026-05-22, amendment pass #3, HG-12 / ADR-0003 Amendment F) Surface D.6 integration with onboarding:**
  - Full D.1 → D.7 enrollment flow integration test that includes at least one "show passphrase again" invocation (per ADR-0003 Amendment F M-54a/b/c/d invariants tested in T07 acceptance) AND verifies the audit row `identity_privkey.recovery_blob.viewed` appears under the partially-enrolled user.
  - **Test:** initiate enrollment from D.1; reach D.6 (type-back verify); invoke "show again" once (hold ≥1500ms); assert audit row written with `reveal_count_in_session = 1`; complete D.6 successfully and proceed to D.7; assert the reveal-count counter resets after D.7 completion (a subsequent enrollment session gets a fresh `enrollment_session_id` and a fresh counter).
  - The architect does NOT define the UX shape of the Surface D.6 reveal control or its placement; the designer owns Surface D.6's spec (per ADR-0003 Amendment F follow-up on the designer).

**Extras:** **privacy-reviewer + accessibility-specialist + tech-writer**.

**Risk:** Low. **Estimate:** S (2 days; +0.5 day for F-54 / Amendment F D.1 → D.7 integration test).

---

**Ordering rationale:**
- T00–T03 are scaffolding; required by everything.
- T04 (RLS) precedes any data-bearing table.
- T05 (auth) precedes T07 (crypto) because passkey-derived secrets
  protect the identity-key local store.
- T07 (crypto core) precedes T08 (first feature using E2EE) — it's the
  riskiest task; fail fast.
- T08–T15 are feature builds in roughly increasing sensitivity (T13–T14
  are C4-heavy and benefit from earlier crypto + RLS hardening).
- T16 (rights endpoints) needs all data shapes in place to test.
- T17–T19 close out the cross-cutting obligations.

**Human-gate items in this task list:**
- T01: hosting region confirmation.
- T05: auth — second-opinion-reviewer + human PR review.
- T07: crypto — second-opinion-reviewer + human PR review.
- T11/T12: export rendering — privacy-reviewer heightened.
- T13: reprisal log — second-opinion + privacy + adversarial.
- T16: retention schedule sign-off (plan §13.D, before launch).
- T17: first restore drill (plan §13.F, before launch).

---

# Open question for the user

**All resolved 2026-05-22 — user confirmed architect's defaults across Q1, Q2, and explicitly confirmed Sentry SaaS (ADR-0010) over self-hosted GlitchTip. These are no longer open.**

**Q1: Backup bucket provider — Backblaze B2 (Canadian region) or AWS S3 ca-central-1?** → **RESOLVED: Backblaze B2, Canadian region.**

Both work. B2 has lower egress costs and is a smaller, simpler vendor.
AWS S3 is the boring choice. Since the bucket holds ciphertext blobs only
(not a PI processor for plaintext), the choice is operational, not
privacy-substantive. Decision needs to be made before T17 ships.
~~Default if you don't reply:~~ Backblaze B2 in Canadian region (lower
cost, smaller subprocessor footprint). This is reversible easily.

**Q2: Minimum-supported-browser baseline.** → **RESOLVED: architect's default.**

Passkeys / WebAuthn need a fairly modern browser. Proposed baseline:
- Safari 16.4+ (iOS 16.4+ for PWA push).
- Chrome / Edge 109+.
- Firefox 122+ (passkey UX matured here).
- Android: 12+.

Older browsers are blocked at first launch with a "your browser is too
old, here's why" screen. ~~Default if you don't reply:~~ the above. This
is reversible by changing one constant. Surface if any committee member
is known to be on older hardware.

These are the only ambiguities that would materially change the design.

---

# Handoff

**Next agent: threat-modeler.**

Inputs to read:
- `/home/user/agent-os/.context/decisions.md` (this file — all 12 ADRs +
  system design + RLS outline + PI inventory + failure-mode analysis).
- `/home/user/agent-os/JHSC-APP-PLAN.md` (plan §4 threat table, §5.3
  crypto model, §5.4 data classification).
- `/home/user/agent-os/.context/constraints.md` (PIPEDA / Ontario baseline).

**STRIDE-first targets — highest-risk components, in this order:**

1. **E2EE key handling (ADR-0003 + T07).** Verify the seven invariants
   as testable assertions. STRIDE the key wrap, the rotation flow on
   member removal, the recovery-passphrase enrollment, and the IndexedDB
   storage of the identity private key. The whole hosting tradeoff rests
   on this layer.

2. **Concern intake (ADR-0007 + T08).** Anonymous-by-default toggle is
   the strongest s.50 mitigation; verify it is *structurally* enforced
   (RLS + form default + export exclusion) not just defaulted-on. Look
   especially at the source-reveal path.

3. **Export to employer co-chair (T11 + T12).** The only path off the
   worker side. STRIDE the export rendering, the field selection, the
   audit-log capture, and the in-browser PDF generation. Any way to leak
   `source_name` here is a launch blocker.

4. **Reprisal log (T13).** Highest-sensitivity entry type. STRIDE the
   4-eyes destructive op, the per-record passphrase, the visible
   sensitive-read notification, and the access-by-role rules.

5. **Auth + session model (T05).** Passkey enrollment, TOTP bootstrap
   destruction, session TTL, revocation. Verify T7 (origin binding) and
   T8 (enumeration) are structurally enforced.

Lower priority but still required for full STRIDE coverage:
- Inspection sync + offline cache (T10).
- Backup encryption chain (T17).
- Audit log integrity + retention job (T18 + T16).

Output goes to `.context/threat-model.md` per plan §11.

After the threat-modeler completes, the orchestrator routes to:
- **designer** (audience, primary task, content shape — plan §11.3 task 5).
- **observability-setup** (T02 scope — Sentry scrubber + structured logs).

---

# Amendment pass summary (2026-05-22)

Threat-modeler completed STRIDE on the Phase-1 architecture and surfaced 10 human-gate items in `.context/threat-model.md` §9. HG-1 was answered by the user (RA-1 captured below). HG-2 through HG-8 are processed in this amendment pass. HG-9 and HG-10 remain as pre-launch human gates already in plan §13 and are unchanged.

| HG | Threat-model finding(s) | Amendment artifact | Downstream task(s) |
|---|---|---|---|
| HG-1 | F-29 / O-8 (4-eyes on export) | **RA-1** (new "Risk acceptances" section between ADR-0001 and System Design) — single-signer co-chair passkey re-auth at export; compensating controls + re-open triggers documented. **ADR-0001 amended** with a "Linked risk acceptances" pointer. | T11, T12 — compensating controls (closed allowlist F-19, audit log F-32, visible concern-derived-items flag in interstitial, post-export rep notification) must be present in T11/T12 acceptance and tests. |
| HG-2 | F-07 / O-12 (key-material mutation audit-log enum) | **ADR-0003 Amendment A** — Invariant 8 added with closed enum: `identity_keypair.created`, `identity_privkey.recovery_blob.written`, `identity_privkey.recovery_blob.restored`, `committee_data_key.wrapped_for_member`, `committee_data_key.unwrap`, `committee_data_key.rotation.started`, `committee_data_key.rotation.completed`, `committee_data_key.member_revoked`. | **T07 acceptance amended** — each enum value emits an audit row on the corresponding flow; CI grep coverage; F-50 alert wiring (T18 wires the alerts). |
| HG-3 | F-10 / O-10 (service-worker plaintext cache policy) | **New ADR-0013** — Service-worker plaintext-cache allowlist (closed URL-pattern allowlist; `X-Data-Class: C3/C4` sanity check; clear on lock/logout/panic; snapshot test mandatory). | **T10 acceptance amended** (T20 folded into T10 per the user's "create T20 or fold into T09 PWA scaffold" instruction — folded into T10; the service worker file may be scaffolded earlier but the policy + snapshot test bind at T10). |
| HG-4 | F-44 / O-11 (offline-queue HMAC integrity) | **New ADR-0014** — HMAC-tag every queued IndexedDB entry with BLAKE2b-256 keyed (libsodium `crypto_generichash`), key HKDF-derived from identity privkey, scoped over (seq, user_id, ciphertext); client verifies before drain; server stores tag. | **T10 acceptance amended** — deterministic-tamper test + cross-device-replay test + positive round-trip. |
| HG-5 | F-46 / O-9 (EXIF/IPTC/XMP/GPS strip on photos) | **ADR-0011 amended** — EXIF/IPTC/XMP strip + canvas re-encode before encryption; GPS coords explicitly removed; round-trip and byte-grep tests. | **T10 acceptance amended** (also implicitly applies to T14 s.51 photos which go through the same upload pipeline). |
| HG-6 | F-33 / O-14 (C4 server-side read-audit enforcement, Invariant 7 strengthen) | **ADR-0003 Amendment B** — Invariant 7 strengthened: all C4 reads go through a `SECURITY DEFINER` view (`reprisal_log_read_audited` and equivalents) that writes the `sensitive.read` audit row atomically with the SELECT, in the same transaction; direct table SELECT revoked from `authenticated`, `anon`, `service_role`. | **T13 acceptance amended** — direct-bypass test, indirection-success test, atomicity test, coverage-via-`pg_proc` test. Same pattern applied to `work_refusal` and `s51_evidence` in T14. |
| HG-7 | F-36 / O-16 (soft-delete-as-delete gating) | **T13 amendment** — UPDATE on `reprisal_log` that flips `status` to any removed-like value requires the same 4-eyes flow as DELETE; user-triggered hard DELETE blocked entirely; only the retention job (T16) hard-deletes aged-out entries. | **T13 acceptance amended** — single-rep status-flip denied with clear "needs second member" error; 4-eyes status-flip succeeds with both members named in audit log; self-approve denied; retention-only hard-delete. |
| HG-8 | F-49 / O-15 (Object Lock + versioning on backup bucket) | **ADR-0012 amended** — Object Lock governance mode 35d retention; versioning enabled; lifecycle hard-deletes versions > 42d (preserves crypto-shred on retention); workflow credential scoped (no Delete, no Bypass); weekly CI drift check. | **T17 acceptance amended** — bucket-config tests, overwrite-creates-new-version test, delete-denied-under-retention test, drift check, restore-drill procedure updated. |
| HG-9 | (pre-existing per plan §13.D) | Unchanged. | Retention schedule final approval before launch. |
| HG-10 | (pre-existing per plan §13.B/C) | Unchanged. | Privacy lawyer + labour lawyer review before Phase 3 ship. |

**New artifacts in this file:**
- ADR-0014 (offline queue HMAC integrity) — top of file.
- ADR-0013 (service-worker plaintext-cache allowlist).
- ADR-0012 amendment block (Object Lock + versioning + lifecycle).
- ADR-0011 amendment block (EXIF strip).
- ADR-0003 Amendment A (Invariant 8) and Amendment B (Invariant 7 strengthened).
- ADR-0001 "Linked risk acceptances" note pointing to RA-1.
- "Risk acceptances" section (RA-1, HG-1) between ADR-0001 and System Design.
- T07, T10, T13, T17 acceptance criteria amended (in-place, with explicit "Amended 2026-05-22, HG-X" labels on each new bullet).

**Reversibility note:** all amendments use the "amends" / "supersedes" pointer pattern. Original ADR text is preserved verbatim; amendments are additive blocks at the end of each ADR. RA-1 has explicit re-open triggers; the threat-modeler's alternative (full 4-eyes) is preserved in the section as the documented alternative posture.

**Locked decisions from plan §13 were not re-opened.** No new locked decisions introduced. No new cross-border transfers. No new PI subprocessors.

---

# Handoff (re-stated for amendment pass)

The amendment pass closes HG-2 through HG-8 and records HG-1 as RA-1. Phase-1 architecture is now ready for the parallel handoff originally planned by the threat-modeler (`.context/threat-model.md` §10).

**Run in parallel:**

**Agent: designer.** Inputs:
- `/home/user/agent-os/.context/decisions.md` (this file) — particularly:
  - **RA-1** (the export interstitial UX is materially affected: the interstitial must list every included field by label per F-19, AND visibly flag "this export contains concern-derived items" with the originating concern_ids, AND record post-export rep notification — these are compensating controls for the single-signer posture).
  - ADR-0007 (concern intake, anonymous-toggle-default-ON form treatment).
  - ADR-0008 (device posture, onboarding copy).
  - ADR-0011 (PWA-only onboarding copy) and its EXIF amendment (photo-capture UI labels include "GPS off; location is free-text or from the list").
  - **ADR-0013** (service-worker cache policy informs offline-state UX — what's available offline, what isn't, what to surface when the SW rejects a response).
  - ADR-0003 Amendment B (C4 read-audit) — the sensitive-read notification surface design must reflect that the canonical audit is server-emitted (no spinner waiting for client-POST; the row is already there when the SELECT returns).
  - T13 (reprisal log) HG-6 + HG-7 amendments — the "needs second member" error surface for soft-delete status flips needs a designed UX (clear, non-blame-y, with a way to nominate the second member).
- `/home/user/agent-os/.context/threat-model.md` — §3.3 (export STRIDE), §3.2 (concern intake STRIDE), §3.4 (reprisal log STRIDE), §10 (handoff).
- `/home/user/agent-os/JHSC-APP-PLAN.md` §9 (accessibility) and §3.2 (worker-side-only).

Designer must capture: (a) the export interstitial UX with explicit field-list display **and the concern-derived-items flag from RA-1** (F-19 + RA-1), (b) the sensitive-read notification surface that reflects the server-emitted audit (F-33 / Amendment B), (c) anonymous-toggle-defaults-ON form treatment (T3), (d) onboarding copy that names the ADR-0001 tradeoff and the ADR-0008 device posture, (e) the recovery-passphrase print-and-type-back flow (F-08), (f) per-record passphrase prompts (F-34) WITHOUT implying they are the crypto gate, (g) the photo-capture UI's GPS / location messaging (HG-5 amendment to ADR-0011), (h) the "needs second member" UX for both DELETE proposals and soft-delete status flips on `reprisal_log` (HG-7), (i) the offline-state messaging consistent with the service-worker cache allowlist (HG-3 / ADR-0013).

**Agent: observability-setup.** Inputs:
- `/home/user/agent-os/.context/decisions.md` (this file) — particularly:
  - ADR-0010 (Sentry scrubbing) and T02 acceptance (existing).
  - **ADR-0003 Amendment A** (Invariant 8 enum) — the audit-log-integrity check job in T18 alerts on the F-50 patterns documented in T07's amended acceptance (rotation-started-without-completed, member-revoked-without-rotation-completed, wrap-for-inactive-member).
  - **ADR-0003 Amendment B** (Invariant 7 strengthened) — the audit-log pipeline now has server-emitted `sensitive.read` rows from inside the `SECURITY DEFINER` view. The observability surface (T18 "recent sensitive activity" feed) reads these.
  - **ADR-0013** — the SW must emit `client.cache_policy_violation` audit rows when the sanity-check rejects a response; observability surface ingests these.
  - **ADR-0014** — `queue.integrity_fail` audit rows from HMAC mismatch on offline-queue drain; observability ingests + alerts.
  - **ADR-0012 amendment** — backup bucket weekly drift check is an alert-emitting check; the alert pipeline carries it.
- `/home/user/agent-os/.context/threat-model.md` — §3.1 F-09 (Edge Function log scrubbing), §6 Invariant 1 strengthened (private-key-shape canary), §3.6 F-50 (audit-log integrity alert wiring).
- `/home/user/agent-os/JHSC-APP-PLAN.md` §6 (no PI in logs).

Observability-setup must build: the `beforeSend` scrubber with allowlist + canary-PII test (T02 existing); the structured logger with `safeFields`; the audit-log integrity-alert wire (F-50 alerts within 5 minutes of triggers); **the alerting wire for the new audit-log enum values from Invariant 8 (HG-2)**; **the alerting wire for `queue.integrity_fail` from ADR-0014 (HG-4)**; **the alerting wire for `client.cache_policy_violation` from ADR-0013 (HG-3)**; **the alerting wire for the bucket-config drift check from ADR-0012 amendment (HG-8)**; **the "recent sensitive activity" feed that reads the server-emitted `sensitive.read` rows from ADR-0003 Amendment B (HG-6) AND surfaces the post-export rep notification per RA-1 (HG-1)**.

These two agents run in parallel; their outputs do not block each other.

---

# Amendment pass #2 summary (2026-05-22)

Observability-setup completed Phase-0 wiring and surfaced 8 findings in `observability/README.md` §10 and `observability/audit-log.md` §6. The a11y review pass surfaced Advisory A-2 in parallel, which cross-cuts coercion-resistance and is handled here. This amendment pass processes F-A through F-H and folds in A-2 as ADR-0003 Amendment C. F-E and F-F are routed to the privacy-reviewer (running in parallel after the threat-modeler second pass) and are NOT decided here.

| Finding | Source | Amendment artifact | Downstream task(s) |
|---|---|---|---|
| **F-A** (audit-row signature posture) | `observability/audit-log.md` §6 finding #1; `observability/README.md` §10 finding #1 | **RA-2** (new entry in "Risk acceptances", placed above RA-1) — v1 ships hash-only chain; signature deferred to v2; A5 detection backstop = `pg_dump` diff + manual head-pointer extraction; six re-open triggers documented. Threat-modeler's stance (A5 in scope, signing is the proper v2 strengthening) and the rationale for not crossing ADR-0010's no-new-PI-subprocessor posture are captured. | **T18 acceptance amended** — daily audit-log-vs-backup diff check added; runbook captures the weekly head-pointer extraction as a manual external witness. |
| **F-B** (event-name dedupe: `queue.integrity_fail` vs `inspection.synced.hmac_fail`) | `observability/audit-log.md` §6 finding #2; `observability/README.md` §10 finding #1 | **ADR-0010 amendment** (F-B cross-pollination block) — `queue.integrity_fail` is canonical (matches ADR-0014 source of truth); `inspection.synced.hmac_fail` is a forbidden alias caught by semgrep. | **Verifier (Phase 2):** new semgrep rule `no-inspection-synced-hmac-fail-alias` in `scripts/verify.sh`. **observability-setup (next pass):** removes the alias text from `observability/audit-log.md` §1 and §6 finding #2. |
| **F-C** (missing audit enum values + chain-vs-structured-log boundary) | `observability/audit-log.md` §6 finding #3; `observability/README.md` §10 (auth.passkey.assert recommendation) | **ADR-0003 Amendment A extended** (in-place under Amendment A) — closed allowlist gains `work_refusal.read` and `s51_evidence.read`; the chain-vs-structured-log architectural rule is declared explicitly ("the chain captures trust-changing events; volumetric auth telemetry is structured-log only"); `auth.passkey.assert` is listed in the structured-log-only event vocabulary table. | **T14 acceptance amended** — `work_refusal_read_audited` and `s51_evidence_read_audited` `SECURITY DEFINER` views and same-transaction audit emission, identical posture to T13 HG-6. **T18 acceptance amended** — volumetric-event exclusion test (100 WebAuthn assertions, zero `audit_log` rows of that type) + closed-enum coverage test for every `audit_emit(...)` caller. |
| **F-D** (Edge Function logging contract not in any ADR) | `observability/README.md` §10 finding #1; `observability/logging.md` §4 "applies until contradicted" | **ADR-0010 amendment** — Edge Function structured-logging contract ratified: Rule 1 no PI ever, Rule 2 scrubbing at emit-point (not downstream), Rule 3 `request_id` propagation, Rule 4 retention pointer (subject to F-F). The substance was already in `observability/logging.md` §4; this gives it ADR-level authority. | **T02 acceptance (existing, unchanged):** the canary-PII tests in `observability/sentry-scrub.ts` and the Edge Function canary test in `observability/logging.md` §4 already cover the substance. No new task; reviewer authority added. |
| **F-E** (`reprisal.created` visibility) | `observability/audit-log.md` §6 finding #4 | **NOT DECIDED — routed to privacy-reviewer.** Recorded in ADR-0010 amendment "F-E / F-F" block. ADR-0003 Amendment B and the audit-log RLS unchanged. | **Privacy-reviewer pass (next, parallel with threat-modeler second pass):** confirm or amend the "all active members see `reprisal.created`" default; if narrowing, a future architect pass amends ADR-0003 Amendment B. |
| **F-F** (audit-log retention 24mo vs `.context/constraints.md` "at least 1 year" floor) | `observability/README.md` §10 finding #2 | **NOT DECIDED — routed to privacy-reviewer.** Recorded in ADR-0010 amendment "F-E / F-F" block. Retention value unchanged. | **Privacy-reviewer pass:** confirm 24mo or recommend an alternative value before launch. |
| **F-G** (modal focus-trap timing — a11y A-2; cross-cutting to coercion-resistance) | `.context/a11y-review.md` §A-2; cross-references RA-1 export interstitial + HG-6/HG-7 protected modals | **ADR-0003 Amendment C** — Invariant 9: "Protected-modal focus trap and announce-on-open behavior MUST be synchronous with mount; the opacity transition is decorative and does not gate accessibility or coercion-resistance behavior." Per-modal mount-time tests + animation-disabled tests + scripted-dismissal-race test specified. Threat-modeler is running a parallel second pass; Amendment C stands independently. | **Designer (next pass):** fold the Amendment C language into `.context/design-system.md` §3.1 / §3.2 (architect does NOT modify design-system.md per this pass's hard rules). **Test-writer (pre-T11/T13):** five mount-time tests + scripted-dismissal-race test land before the feature implementer touches the protected modals. **Implementer (T11, T13):** focus trap wired at mount, not on `transitionend`. |
| **F-H** (no tracing in Phase 0 — acknowledge only) | `observability/README.md` §10 finding #3 | **ADR-0010 amendment** — Phase-0 tracing deferral acknowledged explicitly. `request_id` is wired across all three pillars per F-D Rule 3, making the future sre-specialist introduction mechanical. Three re-open triggers documented. | **No new task.** **sre-specialist (Phase 4):** owner of the tracing re-evaluation per the documented triggers. |

**New artifacts in this file (pass #2):**
- **RA-2** in the "Risk acceptances" section, placed above RA-1 (newest on top per file convention).
- **ADR-0003 Amendment A extension** (in-place under Amendment A; the original 8-value enum is preserved verbatim; the extension adds two C3-read enum values, the chain-vs-structured-log architectural rule, the structured-log-only event vocabulary table, and three new test obligations).
- **ADR-0003 Amendment C** (Invariant 9 — protected-modal focus trap synchronous with mount).
- **ADR-0010 amendment block** (Edge Function logging contract + Phase-0 tracing deferral + F-B canonical-name cross-pollination + F-E/F-F routing-to-privacy-reviewer pointer).
- **T14 acceptance amended** (C3 read-audit indirection mirroring T13 HG-6, using the new `work_refusal.read` / `s51_evidence.read` enum values; cross-reference to HG-5 EXIF strip).
- **T18 acceptance amended** (RA-2 backup-diff check; F-C volumetric-event exclusion test + closed-enum coverage test).

**No ADR-0015 added.** Per the user's instruction, F-D was folded into ADR-0010 (which already owns Sentry SaaS for application errors; Edge Function logging is a sibling pillar) rather than creating a new top-of-file ADR. Reversibility: if F-D ever needs to grow beyond a sibling-pillar treatment (e.g., a different log-shipping vendor), ADR-0015 can be added at the top in a future pass.

**Reversibility note (pass #2):** all amendments use the additive "amends" / "extends" pattern; original ADR text is preserved. RA-2 has six explicit re-open triggers; the observability-setup agent's recommended Option (a) (Ed25519 row signing per `pg_cron` + 1Password key) is the documented default upgrade path. Amendment C's invariant is hard to reverse (it would degrade both accessibility and coercion-resistance), but the implementation site is one module. ADR-0010's amendment is easy to reverse on tooling (the logger is one module) and hard to reverse on the architectural rules (1–4 are non-negotiable while ADR-0001 + ADR-0003 hold).

**Locked decisions from plan §13 were not re-opened.** No new locked decisions introduced. No new cross-border transfers. No new PI subprocessors. ADR-0010's "Sentry is the only non-Supabase PI-adjacent subprocessor" posture is preserved and explicitly cited in RA-2's rationale for declining Option (b) (external KMS / signer).

**Files NOT modified by this pass (per hard rules):** `JHSC-APP-PLAN.md`, `.context/threat-model.md`, `.context/constraints.md`, `.context/preferences.md`, `.context/a11y-review.md`, `observability/*`, `i18n/*`, `design-tokens.json`, `.context/design-system.md`. All cross-references in this amendment pass point to the existing content in those files; the next-pass owners (designer for design-system; observability-setup for the audit-log doc; privacy-reviewer for any privacy-substantive changes) fold the pointers in.

---

# Handoff (re-stated for amendment pass #2)

The amendment pass #2 closes F-A (RA-2), F-B (canonical name + verifier rule), F-C (Amendment A extension + T14 + T18 acceptance), F-D (ADR-0010 amendment), F-G (ADR-0003 Amendment C), and F-H (ADR-0010 amendment acknowledgment). F-E and F-F are routed to the privacy-reviewer — not decided here.

**Sequence (NOT parallel for this round):**

1. **First: privacy-reviewer pass.** Inputs:
   - `/home/user/agent-os/.context/decisions.md` (this file) — particularly:
     - **F-E** routed in ADR-0010 amendment "F-E / F-F" block — confirm or amend the "all active members see `reprisal.created`" default RLS posture.
     - **F-F** routed in ADR-0010 amendment "F-E / F-F" block — confirm 24-month audit-log retention or recommend an alternative value.
     - **RA-1** — confirm the post-export rep notification + visible concern-derived-items flag UX is privacy-adequate.
     - **RA-2** — confirm the v1 hash-only audit-log posture is acceptable for the privacy notice; the residual ("A5 can rewrite the narrative but not the content") is what users are told.
     - The PI inventory and retention table — confirm no field is mis-classified.
   - `/home/user/agent-os/.context/threat-model.md` — for cross-reference.
   - `/home/user/agent-os/.context/constraints.md` — PIPEDA / Ontario baseline.
   - `/home/user/agent-os/JHSC-APP-PLAN.md` §8 (retention) and §13 (locked decisions).

2. **In parallel with the privacy-reviewer: threat-modeler second pass.** Inputs:
   - `/home/user/agent-os/.context/decisions.md` (this file) — particularly:
     - **RA-2** — confirm the threat-modeler's stance recorded in the RA-2 rationale ("A5 in scope; signing is the proper v2 strengthening") matches the threat-modeler's actual position; if not, file a finding.
     - **ADR-0003 Amendment C** (F-G) — confirm the coercion-resistance reading of Invariant 9; if the second pass surfaces additional coercion-resistance implications for the five protected modals, file findings on top of Amendment C (do NOT modify Amendment C; the next architect pass folds the findings).
     - **ADR-0003 Amendment A extension** (F-C) — confirm `work_refusal.read` and `s51_evidence.read` are correctly classified as C3 read enums under the same posture as `reprisal.read` (HG-6).
   - `/home/user/agent-os/.context/a11y-review.md` §A-2 — the original A-2 finding the threat-modeler's parallel pass is examining.

3. **After both: test-writer.** Test-writer is **next after the privacy-reviewer and threat-modeler second-pass complete.** Inputs:
   - `/home/user/agent-os/.context/decisions.md` (this file, final state including any privacy-reviewer + threat-modeler amendments to come).
   - `/home/user/agent-os/.context/threat-model.md` §8 (test obligations per task ID — already pre-loaded by the threat-modeler first pass; the second pass may add).
   - `/home/user/agent-os/observability/audit-log.md` §5 (test obligations for T07, T13, T18).
   - `/home/user/agent-os/observability/sentry-scrub.ts` (the scrub fixture spec).
   - `/home/user/agent-os/observability/logging.md` (the structured-logger contract; F-D-ratified rules).
   - `/home/user/agent-os/observability/README.md` §9 "For the test-writer (next in line)" — the pre-task test-artifact obligations enumerated per T0x.

   Specifically, the test-writer adds, before any implementer touches the corresponding code:
   - **RA-2 tests (T18):** live-vs-backup-diff alert test; no-false-positive-on-newer-rows test; closed-enum coverage test enumerating every `audit_emit(...)` caller; volumetric-event exclusion test for `auth.passkey.assert`.
   - **F-C tests (T14):** direct-bypass test, indirection-success test, atomicity test, coverage-via-`pg_proc` test on `work_refusal_read_audited` and `s51_evidence_read_audited` — same shape as the existing T13 HG-6 tests.
   - **F-G / Amendment C tests (T11, T13, and any feature touching a protected modal):** for each of `export_interstitial`, `reauth_prompt`, `passphrase_prompt`, `destructive_confirm`, `four_eyes_pending` — mount-time focus-trap test, animation-disabled test, scripted-dismissal-race test, synchronous-mount-of-audit-prerequisites test.
   - **F-B verifier rule:** semgrep rule `no-inspection-synced-hmac-fail-alias` in `scripts/verify.sh` with the documented allowlist for the three files where the alias string is permitted (this ADR, ADR-0014, `observability/audit-log.md` §6 finding #2).

**Not routed here (already covered by the original handoff, pass #1):** designer is queued behind the threat-modeler's first-pass output and is unaffected by this pass except for the Amendment C language fold into `.context/design-system.md` §3.1 / §3.2; observability-setup completed Phase 0 (this pass processes their findings) — their next pass (if needed) is post-test-writer, alongside the implementer of T02.

---

# Amendment pass #3 summary (2026-05-22)

Privacy-reviewer returned two APPROVED-WITH-CHANGES verdicts (Q1 blocking T13; Q2 blocking T16) plus five cross-cutting observations plus a forensic-reveal proposal. Threat-modeler completed a second pass adding F-53 (modal trap-timing race during opacity transition) + F-54 (recovery-passphrase low-vision escape hatch) plus observations O-17 / O-18 and human gates HG-11 / HG-12 (written directly into `.context/threat-model.md` §9). Amendment pass #3 processes both sets together. Per directive G, since threat-modeler's HG-11/HG-12 writes landed first, privacy-reviewer's two proposed gates become **HG-13** (Amendment D pseudonymized projection + Amendment E forensic-reveal + ADR-0007 amendment consent surface — bundled) and **HG-14** (ADR-0015 per-event audit-log retention schedule).

| Change | Source | Amendment artifact | Downstream task(s) |
|---|---|---|---|
| **Q1 / HG-13 — Pseudonymized reprisal-feed projection** | privacy-review Q1 / §2.1–§2.3 / §4 cross-cutting #5 / §7 obligations 1–3, 6 | **ADR-0003 Amendment D** — new `SECURITY DEFINER` view `reprisal_audit_feed_pseudonymized` projecting `{id, event_type, ts_bucketed_to_hour, target_id, target_class, prev_hash, hash}` with `actor_pseudonym` suppressed; GRANT-revoke on raw `audit_log` for the relevant event types; default-list-payload defaults to the view (mirrors F-18). | **T13 acceptance amended** — projection view, GRANT-revoke, default-list-payload, four tests from privacy-review §7. **T14 acceptance amended** (cross-reference) — extension to `work_refusal.*` and `s51_evidence.*` write events when T14 enumerates. |
| **Q1 / HG-13 — Forensic-reveal 4-eyes procedure** | privacy-review §4 cross-cutting #2 | **ADR-0003 Amendment E** — new `pending_forensic_reveals` table, `forensic_read_service` non-login role, `jhsc_forensic_reveal_actor_pseudonym(...)` SECURITY DEFINER function; two new audit-log enum values `audit.forensic_reveal.4eyes_pending` / `.4eyes_completed`; co-chair + co-chair OR co-chair + certified_member approver pair; 24h reveal session. | **T13 acceptance amended** — `pending_forensic_reveals` table + role + function + 4 tests (proposer-cannot-self-approve, distinct-member approval succeeds, non-pair attempt denied, reveal-session expiry). |
| **Q1 / HG-13 — Reprisal-log intake consent surface** | privacy-review §2.4 (copy draft) / §5 fold-in item 2 / §7 obligation 5 | **ADR-0007 amendment** — scope extension to cover reprisal-log intake consent surface; four-bullet contract + per-intake re-render + structural gating of "Save entry" button; §2.4 copy verbatim; labour-lawyer (HG-10) + accessibility-specialist sign-off before T13 ships. | **T13 acceptance amended** — consent-surface presence test + per-intake re-render test. **localization-specialist (next pass):** `i18n/en-CA/reprisal-intake.json` keys. **designer (next pass):** Surface C consent-surface placement + UX. |
| **Q2 / HG-14 — Per-event-type audit-log retention** | privacy-review Q2 / §3.1 / §3.3 / §3.4 / §3.5 / §7 obligations 7–11 | **New ADR-0015** (top of file) — per-event-type schedule (privacy-review §3.3 table verbatim); `audit_log.retention_class` column; `audit_log_retention_schedule` table; underlying-record-ceiling rule (§3.5); `retention.deleted` jsonb shape (§3.4); CI drift assertion. **HG-14 — user explicitly ratifies the schedule before T16 ships.** | **T16 acceptance amended** — per-event schedule, schema additions, ceiling rule, drift check, five tests from privacy-review §7 obligations 7–11. |
| **Cross-cutting #1 — `retention_class` column on `audit_log`** | privacy-review §4 cross-cutting #1 | Captured in **ADR-0015** schema requirements. | T16 acceptance bullet (covered in HG-14 row above). |
| **Cross-cutting #4 — `observability/README.md` §1 reasoning correction** | privacy-review §4 cross-cutting #4 | Captured in **ADR-0015** cross-references — observability-setup's next pass corrects the reasoning text to "matched to the breach-record retention because audit log feeds the breach-response process, not because PIPEDA s.10.1 requires 24mo for audit logs." Architect does NOT edit `observability/*` per amendment pass #3 hard rules. | Follow-on for observability-setup, **not** a new task. |
| **§5 fold-in item 4 — Crypto-shred-on-retention coherence** | privacy-review §5 fold-in item 4 | **ADR-0012 amendment** (new "Crypto-shred-on-retention coherence with audit-log per-event retention" block at the end of ADR-0012) — note that "Backups older than the longest audit-log event retention can be hard-deleted without leaving 'events we cannot explain.'" Structurally satisfied by ADR-0015 + ADR-0012 amendment HG-8. | No new test obligation; coherence is structural. |
| **`HMAC_PSEUDONYM_KEY` escrow + rotation** | privacy-review §4 cross-cutting #3 | **NOT folded into this pass.** The recommendation (rotate quarterly with overlap window; old-era pseudonyms stay queryable in old-era space) is a substantive operational policy decision that touches ADR-0012's key escrow story; the architect surfaces this as an explicit **deferred-to-next-pass** item rather than land it half-spec'd. Rationale: the operational rotation procedure interacts with the backup window (35d) AND the live forensic procedure (Amendment E's reveal-session) AND the audit-log chain integrity (RA-2 head-pointer extraction). Half-specifying it now risks an inconsistency the test-writer would inherit. **Follow-on:** architect or security-reviewer's next pass amends ADR-0012 with the rotation cadence + overlap window + era encoding. | Tracked as a deferred follow-on; the privacy-reviewer's recommendation is preserved in their review file for the next pass to consume. |
| **F-53 / HG-11 — M-53a/b/c enumeration in Invariant 9** | threat-model F-53 (§3.3) / O-17 / HG-11 (already in threat-model §9) | **ADR-0003 Amendment C extension** (in-place under Amendment C) — original Invariant 9 preserved verbatim; three sub-invariants added: 9.a (trap-on-mount; M-53a; was already covered), 9.b (announce-on-open `ready` promise gates input acceptance; M-53b; NEW), 9.c (underlying surface `inert` from t=0; scrim captures keydown + pointer during transition; M-53c; NEW). Cross-references threat-model M-53a/b/c assertion shapes. | **T11 + T13 acceptance amended** (cross-reference) — the three sub-invariants are already mapped in threat-model §8 T11 F-53 entries; the test-writer's checklist is unchanged in shape, but Invariant 9 now points to all three rather than just the timing property. |
| **F-54 / HG-12 — Recovery-passphrase show-again accommodation** | threat-model F-54 (§3.1) / O-18 / HG-12 (already in threat-model §9) / a11y A-5 | **ADR-0003 Amendment F** — Surface D.6 gains "show passphrase again" hold-to-reveal (≥1500ms) + per-enrollment-session cap of 3 + audit-log emission gates render + no TTS / no clipboard on reveal + largest typography + highest-contrast pairing; new audit-log enum value `identity_privkey.recovery_blob.viewed` (added to ADR-0003 Amendment A closed allowlist; retention "membership + 24 months" per ADR-0015). | **T07 acceptance amended** — M-54a/b/c/d tests + audit-log enum addition + en-CA i18n contract for reveal-control label + helper text. **T19 acceptance amended** — full D.1 → D.7 onboarding integration test including a "show again" invocation. |

**New artifacts in this file (pass #3):**
- **ADR-0015** — Per-event-type audit-log retention schedule (HG-14). Top of file.
- **ADR-0012 amendment** — Crypto-shred-on-retention coherence note appended at the end of ADR-0012.
- **ADR-0007 amendment** — Reprisal-log intake consent surface (HG-13 cross-reference). Appended at the end of ADR-0007.
- **ADR-0003 Amendment C extension** — three sub-invariants 9.a / 9.b / 9.c enumerated explicitly. Appended in-place under Amendment C.
- **ADR-0003 Amendment D** — Pseudonymized reprisal-feed projection (HG-13). New sibling block after Amendment C.
- **ADR-0003 Amendment E** — Forensic-reveal 4-eyes procedure (HG-13). New sibling block after Amendment D.
- **ADR-0003 Amendment F** — Recovery-passphrase show-again accommodation (HG-12). New sibling block after Amendment E.
- **T07 acceptance amended** — Amendment F M-54a/b/c/d tests + i18n contract.
- **T13 acceptance amended** — Amendment D projection + Amendment E forensic-reveal + ADR-0007 amendment consent surface + extension cross-reference for T14.
- **T16 acceptance amended** — ADR-0015 per-event schedule + schema + ceiling rule + drift check + privacy-review §7 obligations 7–11.
- **T19 acceptance amended** — Amendment F D.1 → D.7 integration test.

**Reversibility note (pass #3):** All amendments use the additive "amends" / "extends" pattern. Original ADR text is preserved verbatim. ADR-0015 is a new top-of-file ADR (no prior version to preserve). Amendment D / E / F are siblings under ADR-0003. The ADR-0007 amendment is an additive scope extension; original concern-intake decision is unchanged. The ADR-0012 amendment is a cross-reference, not a new operational rule.

**Hard rules observed:**
- Newest ADR on top — ADR-0015 placed above ADR-0014.
- Amendments are additive blocks at the end of the original ADR (or in-place under existing amendments for the C extension); original text preserved verbatim; amended ADRs carry status lines naming the amendment date and trigger.
- Cross-references: every amendment cites the source review file (privacy-review §X) or threat-model finding (F-xx) and the human gate (HG-xx).
- All new dates are `2026-05-22`.

**Files NOT modified by this pass (per hard rules):** `JHSC-APP-PLAN.md`, `.context/threat-model.md`, `.context/constraints.md`, `.context/preferences.md`, `.context/a11y-review.md`, `.context/privacy-review.md`, `observability/*`, `i18n/*`, `design-tokens.json`, `.context/design-system.md`. All cross-references in this amendment pass point to existing content in those files; the next-pass owners (designer for design-system + Surface C consent surface + Surface D.6 reveal control; observability-setup for `observability/audit-log.md` projection-view documentation + `observability/README.md` §1 reasoning correction; localization-specialist for `i18n/en-CA/reprisal-intake.json` + `onboarding.recovery.show_again.*`; labour-lawyer + accessibility-specialist under HG-10 for the consent-surface and Surface D.6 reveal-surface sign-off) fold the pointers in.

**Locked decisions from plan §13 were not re-opened.** No new locked decisions introduced. No new cross-border transfers. No new PI subprocessors. ADR-0010's "Sentry is the only non-Supabase PI-adjacent subprocessor" posture is preserved.

**Renumbering note (per directive G).** HG-11 (modal trap-engagement contract) and HG-12 (recovery-passphrase show-again) are **permanent in `.context/threat-model.md` §9** (threat-modeler-owned, written first). Privacy-reviewer's two proposed gates therefore become:
- **HG-13** — pseudonymized reprisal-feed projection (ADR-0003 Amendment D) + forensic-reveal 4-eyes (Amendment E) + reprisal-log intake consent surface (ADR-0007 amendment) — **bundled as a single architect-owned gate**.
- **HG-14** — per-event-type audit-log retention schedule (ADR-0015).

HG-13 and HG-14 are recorded in this summary table and cross-referenced from each amendment block. They are **NOT** added to `.context/threat-model.md` §9 (the threat-modeler owns that file per amendment pass #3 hard rules); they live as architect-owned gates that point into the privacy-review. The threat-modeler's next pass, if needed, picks them up; otherwise they are picked up at HG-9 / HG-10 (the pre-launch labour-lawyer + privacy-lawyer review per plan §13.B/C) as architect-owned items in the same gate stack.

**Cross-table mapping (source → amendment → task):**

| Source | Amendment | Task |
|---|---|---|
| privacy-review §2.3 (Option c) | ADR-0003 Amendment D | T13, T14 (extension) |
| privacy-review §2.4 (consent copy) | ADR-0007 amendment | T13 |
| privacy-review §3.3 (per-event schedule table) | ADR-0015 | T16 |
| privacy-review §3.5 (underlying-record-ceiling rule) | ADR-0015 | T16 |
| privacy-review §4 cross-cutting #1 (`retention_class` column) | ADR-0015 schema | T16 |
| privacy-review §4 cross-cutting #2 (4-eyes forensic reveal) | ADR-0003 Amendment E | T13 |
| privacy-review §4 cross-cutting #3 (HMAC_PSEUDONYM_KEY escrow + rotation) | **DEFERRED** to next pass | n/a (deferred) |
| privacy-review §4 cross-cutting #4 (README.md §1 reasoning correction) | ADR-0015 cross-reference; observability-setup next pass | n/a (observability follow-on) |
| privacy-review §4 cross-cutting #5 (default list payload) | ADR-0003 Amendment D | T13 |
| privacy-review §5 fold-in 1 (Amendment B pattern extension) | ADR-0003 Amendment D | T13 |
| privacy-review §5 fold-in 2 (ADR-0007 extension OR ADR-0016) | ADR-0007 amendment (preferred per privacy-reviewer recommendation) | T13 |
| privacy-review §5 fold-in 3 (plan §8 retention pointer) | ADR-0015 supersedes uniform 24mo | T16 |
| privacy-review §5 fold-in 4 (ADR-0012 crypto-shred coherence) | ADR-0012 amendment | T16 / T17 (structural, no new test) |
| privacy-review §5 fold-in 5 (observability/audit-log.md §3 update) | ADR-0015 cross-reference; observability-setup next pass | n/a (observability follow-on) |
| privacy-review §5 fold-in 6 (observability/README.md §10 finding #2) | ADR-0015 cross-reference; observability-setup next pass | n/a (observability follow-on) |
| privacy-review §5 fold-in 7 (HG-9 ratification) | ADR-0015 HG-14 (subset of HG-9 scope) | T16 |
| privacy-review §7 test obligations 1–6 | ADR-0003 Amendment D + Amendment E + ADR-0007 amendment | T13, T14 |
| privacy-review §7 test obligations 7–11 | ADR-0015 + T16 acceptance | T16 |
| threat-model F-53 M-53a/b/c | ADR-0003 Amendment C extension (9.a/9.b/9.c) | T11, T13 (already in §8 test obligations) |
| threat-model F-54 M-54a/b/c/d | ADR-0003 Amendment F | T07, T19 |

---

# Handoff (re-stated for amendment pass #3)

The amendment pass #3 closes privacy-review Q1 (HG-13 bundling ADR-0003 Amendment D + Amendment E + ADR-0007 amendment), privacy-review Q2 (HG-14, ADR-0015), the five cross-cutting observations (with #3 deferred and #4 + #5 routed to observability-setup), and threat-model F-53 / F-54 (HG-11 / HG-12, via ADR-0003 Amendment C extension and Amendment F).

**Test-writer is next.** This is the canonical handoff: privacy-reviewer and threat-modeler second-pass are both complete (this file's amendments operationalize their outputs); no further reviewer pass is required before the test-writer lands the full obligation set.

**Test-writer inputs (read in this order):**
1. `/home/user/agent-os/.context/decisions.md` (this file, final state) — particularly **ADR-0015** (per-event retention schedule + schema + ceiling rule), **ADR-0003 Amendment C extension** (Invariants 9.a/9.b/9.c), **ADR-0003 Amendment D** (pseudonymized projection), **ADR-0003 Amendment E** (forensic-reveal 4-eyes), **ADR-0003 Amendment F** (recovery-passphrase show-again), **ADR-0007 amendment** (reprisal-log intake consent surface), **ADR-0012 amendment** (crypto-shred coherence note), and the T07 / T13 / T16 / T19 amended acceptance blocks.
2. `/home/user/agent-os/.context/threat-model.md` §8 (test obligations per task ID — pre-loaded by threat-modeler first + second passes), §3.3 (F-53 / M-53a/b/c assertion shapes), §3.1 (F-54 / M-54a/b/c/d assertion shapes), §9 (HG-11 / HG-12 permanent gates), §11 (second-pass summary).
3. `/home/user/agent-os/.context/privacy-review.md` §7 (test obligations 1–11 — the canonical privacy test obligation list for T13 and T16).
4. `/home/user/agent-os/observability/README.md` §11 (test obligations enumerated per task — superseded in part by the amendments in this pass; the test-writer prioritizes the amended acceptance criteria in this file over any prior observability §11 wording where they diverge, and observability-setup's next pass reconciles its §11 with the amendments).
5. `/home/user/agent-os/observability/audit-log.md` §5 (test obligations for T07, T13, T18) — for context; the same prioritization applies (amended acceptance in this file takes precedence; observability-setup reconciles).
6. `/home/user/agent-os/observability/sentry-scrub.ts` and `/home/user/agent-os/observability/logging.md` — scrubber + structured logger contracts (unchanged in this pass; still load-bearing).

**Test-writer obligation set (full T02 / T05 / T07 / T08 / T10 / T11 / T12 / T13 / T14 / T16 / T17 / T18 / T19 — pre-implementer):**

For brevity the test-writer's full obligation list is the union of:
- threat-model §8 — every bullet, grouped by task ID.
- privacy-review §7 — eleven obligations (1–6 to T13 + T14; 7–11 to T16).
- observability/README.md §11 — pre-task test artifacts per task (subject to the amendment-pass #3 prioritization note above).
- amendment-pass #3 invariants in this file — every "Test: …" bullet in the T07 / T13 / T16 / T19 amended acceptance, plus the Amendment C extension's 9.a/9.b/9.c assertion shapes, plus the Amendment D pseudonymized-projection tests, plus the Amendment E forensic-reveal 4-eyes tests, plus the Amendment F M-54a/b/c/d tests, plus the ADR-0007 amendment consent-surface tests.

**Specifically (the new obligations the test-writer must add on top of what amendment pass #2 already enumerated):**

- **T07 (recovery-passphrase show-again, Amendment F / HG-12):**
  - M-54a hold-to-reveal: normal click does NOT reveal; ≥1500ms hold reveals; release hides within 50ms; keyboard Space/Enter behaviour.
  - M-54b audit-log-gates-render: one row per reveal with `reveal_count_in_session`; endpoint 500 → no render + danger toast.
  - M-54c cap: 3 reveals OK, 4th `aria-disabled` + no row + helper text; restart resets.
  - M-54d no TTS / no clipboard: no `data-testid='copy-passphrase'` on reveal; static lint zero matches for `SpeechSynthesisUtterance` / `window.speechSynthesis` / `tts` outside fixtures.
  - i18n contract: en-CA keys `onboarding.recovery.show_again.label` / `.helper` exist with consequence-naming text.
- **T13 (Amendment D pseudonymized projection — privacy-review §7 obligations 1, 2, 3, 5):**
  - Pseudonymized feed columns; no `actor_pseudonym` returned.
  - Direct-`audit_log` SELECT for `actor_pseudonym` on reprisal events: both architectural paths (RLS denial / GRANT-revoke).
  - Time bucketing to the hour in the view; raw row retains microsecond.
  - Default-list-payload defaults to the view (mirrors F-18).
- **T13 (Amendment E forensic-reveal 4-eyes — privacy-review §7 obligation 4):**
  - Proposer-cannot-self-approve.
  - Distinct-member approval succeeds; two audit rows hash-chained; reveal session readable ≤24h.
  - Non-pair attempt denied (worker-member + co-chair on a single-co-chair committee → denied; the rule is co-chair + co-chair OR co-chair + certified_member).
  - Reveal-session expiry → function returns NULL/error; column cleared.
- **T13 (ADR-0007 amendment consent surface — privacy-review §7 obligation 5):**
  - Snapshot test of four-bullets consent surface + checkbox + Save-entry gating.
  - Per-intake re-render (no suppression flag).
- **T13 (cross-reference into T14):**
  - Test obligations 1–3 from privacy-review §7 repeat for `work_refusal.*` and `s51_evidence.*` write events when T14 enumerates (privacy-review §7 obligation 6).
- **T16 (ADR-0015 per-event retention — privacy-review §7 obligations 7–11):**
  - Per-event schedule honored: every enum value's deletion threshold matches the ADR-0015 table.
  - Audit-row-cannot-outlive-target rule: orphaned row queued within 30 days of linked-record deletion.
  - `retention.deleted` summary row retention at 7y (carve-out from ceiling rule).
  - Schedule-table vs enum drift CI assertion.
  - `retention.deleted` per-event-type counts in the summary jsonb.
- **T19 (Amendment F D.1 → D.7 integration):**
  - Full enrollment flow with at least one "show again" invocation; audit row written under partially-enrolled user; counter resets after D.7.
- **T11 / T13 (Amendment C extension — already in threat-model §8 T11 F-53 M-53a/b/c entries, here re-emphasized):**
  - Invariant 9.a tests covered (existing).
  - Invariant 9.b NEW: `ready` promise gates handler dispatch; for `export_interstitial`, no `export.minutes` / `export.recommendation` audit row + no Blob URL before `ready` resolves.
  - Invariant 9.c NEW: underlying surface `inert` + `tabindex=-1` from t=0; scrim capture-phase `keydown` swallows Tab/Enter/Space/Escape during transition; pointer click at underlying coordinates lands on scrim, not underlying button.

**Carry-over from amendment pass #2 (still binding, restated for completeness):**
- **RA-2 tests (T18):** live-vs-backup-diff alert; no-false-positive-on-newer-rows; closed-enum coverage enumerating every `audit_emit(...)` caller; volumetric-event exclusion for `auth.passkey.assert`.
- **F-C tests (T14):** direct-bypass; indirection-success; atomicity; coverage-via-`pg_proc` on `work_refusal_read_audited` + `s51_evidence_read_audited`.
- **F-B verifier rule:** semgrep `no-inspection-synced-hmac-fail-alias` with allowlist for the three permitted files.
- **HG-1 / RA-1 tests (T11/T12):** F-19 closed-allowlist tests; F-24 audit-row-precondition; F-27 allowlist-hash mismatch; visible concern-derived-items flag; post-export rep notification within 60s.
- **HG-2 / Invariant 8 tests (T07/T18):** 8 enum values fire on the 8 key-material flows; F-50 alerts on (a) rotation-started-without-completed, (b) member-revoked-without-rotation-completed, (c) wrap-for-inactive-member.
- **HG-3 / ADR-0013 tests (T10):** service-worker snapshot test; `X-Data-Class: C3/C4` sanity check.
- **HG-4 / ADR-0014 tests (T10):** deterministic-tamper; cross-device-replay; positive round-trip.
- **HG-5 / ADR-0011 amendment tests (T10/T14):** round-trip EXIF/IPTC/XMP strip; defensive byte-grep.
- **HG-6 / Amendment B tests (T13):** direct-bypass; indirection-success; atomicity; coverage-via-`pg_proc` on `reprisal_log_read_audited`.
- **HG-7 tests (T13):** single-rep status-flip denied; 4-eyes status-flip succeeds; self-approve denied; retention-only hard-delete.
- **HG-8 / ADR-0012 amendment tests (T17):** overwrite-creates-new-version; delete-denied-under-retention; lifecycle-hard-delete; weekly drift check.

**Re-stated handoff to test-writer.** The test-writer's deliverable is the failing-test suite landed BEFORE any implementer touches T07, T08, T10, T11, T12, T13, T14, T16, T17, T18, or T19 code. The amendment pass #3 invariants are the latest layer; they sit on top of the pass #1 and pass #2 obligations rather than replacing them. The test-writer reads this file (final state), the threat-model file (final state including the second pass), the privacy-review file (final state), and the observability files (latest state, subject to the amendment-pass #3 prioritization note); the union of test obligations is the deliverable.

**No new cross-border transfers introduced.** **No new PI subprocessors introduced.** **No locked decisions re-opened.** ADR-0010's "Sentry is the only non-Supabase PI-adjacent subprocessor" posture preserved. ADR-0001's hosting tradeoff defensibility preserved (E2EE + B3 narrow + ADR-0015 retention coherence + crypto-shred via ADR-0012 amendment).

---

# Amendment pass #4 summary (2026-05-23)

T05 (auth core + auth migration) verifier + security-reviewer + privacy-reviewer all returned with consolidated blocker set B1–B4 plus eight cross-cutting observations + seven advisories. Amendment pass #4 closes the four blockers, folds the cross-cutting observations into the T05 respin where they are cheaper to land now than later, and ratifies the semgrep rule. New artifacts: **ADR-0016** (top-of-file; operational-table retention + HMAC-pseudonymization standard); **ADR-0002 Amendment G** (T05 auth-side-table reconciliation, TOTP consumed-log, plaintext-code drop, HMAC standard adopted, retention_class + request_id fold-ins, alert.fired meta rename); **§PI inventory amendments** (per privacy-review-t05 §7 + Amendment G.3); **HG-15 (NEW)** — bundled user-ratification gate covering ADR-0016 + Amendment G.

| Change | Source | Amendment artifact | Downstream task(s) |
|---|---|---|---|
| **B1 — HMAC-not-SHA for all pseudonym derivations + TOTP code hashing** | privacy-review-t05 §2.1 Finding 2; consolidated security-reviewer B1 | **ADR-0016** (general HMAC-SHA-256 + `app.hmac_pseudonym_key` GUC standard); **ADR-0002 Amendment G.4** (auth-specific application at four migration sites). Algorithm: HMAC-SHA-256. Key storage: Postgres GUC `app.hmac_pseudonym_key`. TS-side parity via `HMAC_PSEUDONYM_KEY` env var + boot smoke test. | **T05 migration-handler respin** (replace `digest('sha256')` with `hmac(..., current_setting('app.hmac_pseudonym_key'), 'sha256')` at all 4 sites; add `ALTER DATABASE ... SET app.hmac_pseudonym_key` deploy step). **T05 implementer respin** (`safe-fields.ts` + `memory-store.ts` HMAC parity; boot smoke test). |
| **B2 — Document `auth_totp_consumed_log` table** | privacy-review-t05 §2.1 Finding 1 + §2.2; consolidated security-reviewer B2 | **ADR-0002 Amendment G.1** (purpose, classification, HMAC pseudonymization); **ADR-0016** retention schedule row (24h after `consumed_at`); **§PI inventory** new rows for `user_id`, `totp_code_hash`, `consumed_at`. | **T16 acceptance extended** (the retention sweep covers ADR-0016 operational-table schedule in addition to ADR-0015 audit-log schedule). **HG-15 user ratification** (NEW) before T16 ships. |
| **B3 — `public.users` field-set divergence** | privacy-review-t05 §3.3 Finding 5; consolidated security-reviewer B3 | **ADR-0002 Amendment G.3** — PI inventory amended to match the T05 migration. `active` / `role` / `totp_destroyed_at` are T05-owned in `users`; `display_name` / `off_employer_contact` deferred to T06; `identity_pubkey` / `identity_privkey_recovery_blob` deferred to T07; `committee_membership` is a T06 concept. | **T06 acceptance cross-referenced** (T06 creates `committee_membership`; cannot retroactively drop `users.active` / `users.role` without a successor amendment). **T07 acceptance cross-referenced** (T07 adds identity-key columns to `users`). |
| **B4 — `auth_totp_bootstraps.totp_code` plaintext column** | privacy-review-t05 §3.5 Finding 6; consolidated security-reviewer B4 | **ADR-0002 Amendment G.2** — column dropped; UNIQUE constraint becomes `(user_id)` only; `enroll_first_passkey` rewrites comparison to `v_bootstrap.secret_hash = hmac(p_totp_code, current_setting('app.hmac_pseudonym_key'), 'sha256')`. | **T05 migration-handler respin** (drop column, rewrite constraint, rewrite function body). |
| **Privacy-review-t05 §8 obs #1 — `audit_log` stub vs T18 hash-chain backfill** | privacy-review-t05 §8 cross-cutting #1 | **ADR-0002 Amendment G.9** — T18 starts the chain fresh (or seeds from the last pre-T18 row; T18 migration-handler's call). Deliberately accepted gap. | **T18 acceptance cross-referenced** — chain genesis-or-backfill choice documented in T18 commit. |
| **Privacy-review-t05 §8 obs #2 — `audit_emit` missing `retention_class`** | privacy-review-t05 §8 cross-cutting #2 | **ADR-0002 Amendment G.6** — column AND `audit_emit` write added in T05 migration (not T18 backfill); cheaper now. | **T05 migration-handler respin** (`audit_log.retention_class text NOT NULL` + `audit_emit` writes it). |
| **Privacy-review-t05 §8 obs #3 — `audit_log` RLS deny-default vs Amendment B/D projection** | privacy-review-t05 §8 cross-cutting #3 | **ADR-0002 Amendment G.8** — deny-default at T05 is correct (no view exists yet); T13 replaces the policy with the Amendment D projection-view SELECT path when T13 ships. Documented as T13 prerequisite. | **T13 acceptance cross-referenced** — the T13 migration REPLACES the deny-default audit_log SELECT policy. |
| **Privacy-review-t05 §8 obs #4 — `audit_emit` missing `p_request_id`** | privacy-review-t05 §8 cross-cutting #4 | **ADR-0002 Amendment G.7** — `p_request_id uuid` parameter added in T05; pre-T18 callers may pass null. Cheaper than rewriting every caller in T18. | **T05 migration-handler respin** (`audit_emit(..., p_request_id uuid)` signature). |
| **Privacy-review-t05 §8 obs #5 — `alert.fired` meta `actor_pseudonym` collision** | privacy-review-t05 §8 cross-cutting #5 | **ADR-0002 Amendment G.4** — rename `meta.actor_pseudonym` to `meta.subject_pseudonym` in the `alert.fired` row shape. The outer row's `actor_pseudonym` is the dispatcher; the embedded one is the subject. Different semantics, different names. | **T05 implementer respin** (rename in the alert-emitter code). **observability-setup next pass** — documents `subject_pseudonym` in `observability/audit-log.md §1` `alert.fired` meta shape. |
| **Privacy-review-t05 §3.3 Finding 3 / G.5 — `auth.passkey.assert` per-attempt vs per-success canonical wording** | privacy-review-t05 §3 Finding 3 | **ADR-0002 Amendment G.5** — adopt **per-attempt** as canonical; matches current code; failure-path emissions provide operational signal. Wording in ADR-0003 Amendment A extension line ~1927 clarified, not replaced. | **No code change; documentation only.** |
| **Security-reviewer A3 — memory-store should HMAC the TOTP code** | consolidated security-reviewer A3 | Folded into **ADR-0016 §Decision 3** (TS-side parity) and **ADR-0002 Amendment G.4**. | **T05 implementer respin** (memory-store mirrors prod HMAC). |
| **Security-reviewer A4 — TOTP-attempt enumeration differential (401 vs 410 vs 429)** | consolidated security-reviewer A4 | Captured in **ADR-0016 follow-up** (T05 implementer respin item). Collapse to uniform 401 to client; differential reason → `audit_log.meta` only. | **T05 implementer respin** (collapse client response code; preserve audit-side differential). |
| **Security-reviewer A5 — SECURITY DEFINER GRANT EXECUTE** | consolidated security-reviewer A5 | Captured in **ADR-0016 follow-up** (T05 migration-handler respin item). `GRANT EXECUTE ... TO supabase_auth_admin` (or chosen server role). | **T05 migration-handler respin** (explicit GRANT). |
| **Security-reviewer A6 — burst-alert duplicates emission** | consolidated security-reviewer A6 | Captured in **ADR-0016 follow-up** (T05 implementer respin item). Emit once per threshold crossing. | **T05 implementer respin** (deduplicate). |
| **Security-reviewer A7 — dead `revoked_at` arithmetic branch** | consolidated security-reviewer A7 | Captured in **ADR-0016 follow-up** (T05 implementer respin item). Remove the dead branch. | **T05 implementer respin** (remove dead code). |
| **Privacy-review-t05 §3 Finding 4 — `actor_pseudonym` omitted from structured-log INFO** | privacy-review-t05 §3 Finding 4 | **Deferred.** T05-prod-deployment obligation; test-writer adds. Not architect-amendable shape; structurally a code-side fix in the production wiring. | **T05 test-writer adds** the obligation; **T05 implementer** addresses in production wiring (browser-side intentionally omits per spec; server-side includes). |
| **Semgrep rule ratification** | privacy-review-t05 §9 item 6; consolidated security-reviewer ratification ask | **ADR-0016 §Operational rules 2** ratifies the rule's existence + scope. File path: `.semgrep/no-bare-sha256-in-migrations.yml`. Architect does NOT write the file; migration-handler or implementer adds it. | **T05 migration-handler or implementer respin** (write the semgrep file). **CI**: rule enforced on every PR touching `supabase/migrations/`. |

## New artifacts in this file (pass #4)

- **ADR-0016** — Operational-table retention schedule + HMAC pseudonymization standard for Postgres (HG-15). **Top of file** per hard rule "newest ADR on top."
- **ADR-0002 Amendment G** — Auth-side-table reconciliation, TOTP consumed-log, plaintext-code drop, HMAC standard adopted, T05 cross-cutting fold-ins. New sibling block under ADR-0002 (after Follow-ups).
- **§PI inventory amendments** — `users.*` rows reshaped per G.3; new rows for `auth_totp_bootstraps.*` / `auth_totp_consumed_log.*` / `webauthn_credentials.*` / `auth_sessions.*`; `audit_log.*` rows updated to reflect ADR-0015 retention + new `retention_class` / `request_id` columns; `committee_membership` row deferred-to-T06 annotation.
- **HG-15 (NEW)** — bundled gate covering ADR-0016 + ADR-0002 Amendment G; user ratifies before T16 ships.
- **T05, T06, T07, T13, T16, T18 acceptance cross-references** updated to reflect the new schema-shape and respin obligations.

## Reversibility note (pass #4)

All amendments use the additive "amends" / "extends" pattern. Original ADR-0002 text is preserved verbatim; Amendment G is a new sibling block. ADR-0016 is a new top-of-file ADR (no prior version to preserve). The §PI inventory amendments preserve the original rows where they still apply and annotate deferred rows with the deferral target task. No prior decision is silently overridden — every change cites privacy-review-t05 / consolidated security-reviewer source and the relevant downstream task.

## Hard rules observed

- Newest ADR on top — ADR-0016 placed above ADR-0015.
- Amendments are additive blocks under the original ADR; original text preserved verbatim.
- Cross-references: every amendment cites the source review file (privacy-review-t05 §X) or security-reviewer blocker (B1–B4 / A3–A7) and the relevant downstream task.
- All new dates are `2026-05-23`.
- Files NOT modified by this pass (per hard rules): `.context/threat-model.md`, `.context/constraints.md`, `.context/preferences.md`, `.context/a11y-review.md`, `.context/privacy-review.md`, `.context/privacy-review-t05.md`, `.context/test-plan.md`, `observability/*`, `i18n/*`, `design-tokens.json`, `.context/design-system.md`, `apps/web/*`, `supabase/*`. All cross-references in this amendment pass point to existing content in those files; the next-pass owners (observability-setup for `observability/audit-log.md §1` `subject_pseudonym` + §2 HMAC-SHA-256 permission; migration-handler for the T05 migration; implementer for the T05 auth-core + memory-store + safe-fields) fold the pointers in.

## Locked decisions not re-opened

- ADR-0001 hosting tradeoff preserved.
- ADR-0002 passkeys + TOTP-enrollment-bootstrap posture preserved (Amendment G is operational, not architectural — passkeys-only stays; TOTP-bootstrap-then-destroy stays).
- ADR-0010 "Sentry is the only non-Supabase PI-adjacent subprocessor" preserved.
- ADR-0015 per-event-type retention preserved (ADR-0016 sits *beside*, not on top of, ADR-0015).
- No new cross-border transfers. No new PI subprocessors.

## Cross-table mapping (source → amendment → task)

| Source | Amendment | Task |
|---|---|---|
| privacy-review-t05 §2.1 Finding 1 + §2.2 (consumed-log) | ADR-0002 Amendment G.1 + ADR-0016 schedule row | T05 respin, T16 |
| privacy-review-t05 §2.1 Finding 2 (HMAC-not-SHA) | ADR-0016 §Decision 1 + ADR-0002 Amendment G.4 | T05 respin (migration + auth-core) |
| privacy-review-t05 §3.3 Finding 5 (`users` field set) | ADR-0002 Amendment G.3 + §PI inventory amendments | T05 (no code change), T06 (cross-ref), T07 (cross-ref) |
| privacy-review-t05 §3.5 Finding 6 (plaintext `totp_code`) | ADR-0002 Amendment G.2 | T05 migration respin |
| privacy-review-t05 §8 obs #1 (audit_log chain backfill) | ADR-0002 Amendment G.9 | T18 (cross-ref) |
| privacy-review-t05 §8 obs #2 (`retention_class`) | ADR-0002 Amendment G.6 | T05 migration respin |
| privacy-review-t05 §8 obs #3 (RLS deny-default) | ADR-0002 Amendment G.8 | T13 (cross-ref) |
| privacy-review-t05 §8 obs #4 (`p_request_id`) | ADR-0002 Amendment G.7 | T05 migration respin |
| privacy-review-t05 §8 obs #5 (`subject_pseudonym`) | ADR-0002 Amendment G.4 | T05 implementer respin + observability-setup next pass |
| privacy-review-t05 §3 Finding 3 (per-attempt wording) | ADR-0002 Amendment G.5 | (documentation only) |
| privacy-review-t05 §3 Finding 4 (`actor_pseudonym` in INFO) | Deferred to T05 production wiring + test-writer | T05 implementer + test-writer |
| privacy-review-t05 §9 item 1 (Amendment G — TOTP consumed-log) | ADR-0002 Amendment G.1 | T05, T16 |
| privacy-review-t05 §9 item 2 (PI inventory) | §PI inventory amendments | T05 |
| privacy-review-t05 §9 item 3 (operational-table retention schedule) | ADR-0016 | T05, T16 |
| privacy-review-t05 §9 item 4 (Amendment A wording) | ADR-0002 Amendment G.5 | (documentation only) |
| privacy-review-t05 §9 item 5 (observability/audit-log.md `alert.fired`) | Deferred to observability-setup next pass | (observability follow-on) |
| privacy-review-t05 §9 item 6 (semgrep rule) | ADR-0016 §Operational rules 2 (ratification) | T05 (file written by migration-handler or implementer) |
| privacy-review-t05 §9 item 7 (HG-9 / HG-14 ratification) | HG-15 (new; bundled with ADR-0016 + Amendment G) | T16 |
| consolidated security-reviewer A3 (memory-store HMAC parity) | ADR-0016 §Decision 3 + ADR-0002 Amendment G.4 follow-up | T05 implementer respin |
| consolidated security-reviewer A4 (TOTP-attempt enumeration differential) | ADR-0016 follow-up | T05 implementer respin |
| consolidated security-reviewer A5 (SECURITY DEFINER GRANT) | ADR-0016 follow-up | T05 migration-handler respin |
| consolidated security-reviewer A6 (burst-alert deduplication) | ADR-0016 follow-up | T05 implementer respin |
| consolidated security-reviewer A7 (dead `revoked_at` branch) | ADR-0016 follow-up | T05 implementer respin |

---

# Handoff (re-stated for amendment pass #4)

Amendment pass #4 closes the T05 verifier + security-reviewer + privacy-reviewer blocker set (B1–B4 + cross-cuttings + advisories) and ratifies the semgrep rule. No new architectural posture introduced — every change is operational application of existing posture (ADR-0015 + ADR-0016 retention discipline; ADR-0003 invariants; ADR-0002 auth model) to the T05 schema and code.

**HUMAN GATE TRIGGERED (HG-15, NEW):** Before T16 ships, the user explicitly ratifies (a) the ADR-0016 operational-table retention schedule (24h `auth_totp_consumed_log`, 90d `auth_sessions` revoked rows, until-revoked-or-membership-inactive+24mo `webauthn_credentials`), AND (b) the HMAC-SHA-256 + `app.hmac_pseudonym_key` GUC posture. Architect's recommendation is APPROVE both as proposed. No other human gate triggered by this pass (no new subprocessor, no cross-border transfer, no locked-decision re-open).

**The canonical pipeline is:**

**1. migration-handler respins the T05 migration `supabase/migrations/00000000000001_auth.sql`** — per Amendment G + ADR-0016 follow-ups:
- B1: replace `digest(..., 'sha256')` at lines 294-295, 317, 357, 437 with `hmac(..., current_setting('app.hmac_pseudonym_key'), 'sha256')`; add deploy-time `ALTER DATABASE ... SET app.hmac_pseudonym_key = '...'` (or `_setup_app_settings.sql` companion).
- B2: no migration change beyond G.1 documentation; the existing `auth_totp_consumed_log` table shape is correct once the hash column is HMAC.
- B3: no migration change; the `public.users` field set as-shipped is ratified.
- B4: DROP the `auth_totp_bootstraps.totp_code` column; rewrite `UNIQUE (user_id, totp_code)` to `UNIQUE (user_id)`; rewrite `enroll_first_passkey`'s `v_bootstrap.totp_code = p_totp_code` to `v_bootstrap.secret_hash = hmac(p_totp_code, current_setting('app.hmac_pseudonym_key'), 'sha256')`.
- G.4: rename `alert.fired` meta key from `actor_pseudonym` to `subject_pseudonym` (any place the migration emits one).
- G.6: ADD `audit_log.retention_class text NOT NULL`; `audit_emit(...)` writes it from a static map of `event_type → retention_class` (or the ADR-0015 schedule table; T16 may supersede).
- G.7: extend `audit_emit(...)` signature with `p_request_id uuid`; write it to `audit_log.request_id`.
- A5: explicit `GRANT EXECUTE ON FUNCTION ... TO supabase_auth_admin` (or chosen server role) for every SECURITY DEFINER function.
- semgrep rule: write `.semgrep/no-bare-sha256-in-migrations.yml` per ADR-0016 §Operational rules 2.

**2. implementer respins the auth-core `apps/web/src/lib/auth/auth-core.ts` + `memory-store.ts` + `safe-fields.ts`** — per Amendment G + ADR-0016 follow-ups:
- A3: memory-store stores HMAC-of-code (not plaintext); mirrors prod.
- A4: collapse the TOTP-attempt enumeration differential (401 / 410 / 429) to uniform `401 UNAUTHORIZED` for the unauthenticated client; preserve the differential reason in the audit-log meta only.
- A6: burst-alert emission deduplicated to one emission per threshold crossing.
- A7: remove the dead `revoked_at` arithmetic branch.
- ADR-0016 §Decision 3: TS-side reads `HMAC_PSEUDONYM_KEY` env var; boot smoke test compares SHA-of-key to a Postgres-reported SHA-of-key (does NOT log the key value); refuses to start on mismatch.
- G.4: rename any `meta.actor_pseudonym` write inside the `alert.fired` emitter to `meta.subject_pseudonym`.

**3. verifier + security-reviewer + privacy-reviewer re-review** the respun migration + auth-core. Verifier asserts:
- The four blockers (B1–B4) are addressed in the diff.
- The cross-cutting #1–#5 fold-ins are present.
- The seven advisories (A3–A7 + the two non-blocking findings 3 + 4) are addressed.
- The semgrep rule fails any reintroduction of bare `digest(..., 'sha256')` in `supabase/migrations/`.
- Tests 1–9 from Amendment G "Testable assertions" pass.

Security-reviewer asserts the HMAC-keyed pseudonyms hold equality across SQL ↔ TS ↔ Sentry surfaces. Privacy-reviewer asserts the §PI inventory amendments are coherent with the resulting diff and re-asserts the Q1–Q5 verdicts now read APPROVED (no -WITH-CHANGES).

**4. test-writer adds the deferred obligation** from privacy-review-t05 §3 Finding 4 (`actor_pseudonym` in server-side structured-log INFO lines).

**5. After re-review APPROVAL:** T05 merges. T06, T07, T13, T16, T18 acceptance cross-references stand as documented above and are honoured by their respective implementer + migration-handler turns.

**6. HG-15 user ratification** is collected before T16 ships (not before T05 merges; T16 is the retention-sweep task that operationalizes the schedule).

**No new cross-border transfers introduced.** **No new PI subprocessors introduced.** **No locked decisions re-opened.** ADR-0010's "Sentry is the only non-Supabase PI-adjacent subprocessor" posture preserved. ADR-0001's hosting tradeoff preserved.
