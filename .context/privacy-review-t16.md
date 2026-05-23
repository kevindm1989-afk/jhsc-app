# Privacy Review T16 — Retention Sweep Library + MemoryRetentionStore

**Status: PASS-WITH-ADVISORIES** (library-only per ADR-0002 Amendment H). PIPEDA Principle 4.5 (Limiting Retention) is now **structurally enforced** for the first time in the codebase. Closes library halves of G-T05-6, G-T05-7. Three new T16-specific BLOCKING-IN-T16.1 items and seven new advisories (G-T16-PRIV-1..7). Zero BLOCKING-NOW items.

> Returned inline per the precedent at `.context/privacy-review-t11-t12.md`. Captured to this path by the orchestrator.

---

## HUMAN GATES

- **HG-15 does NOT fire** in T16 (no new physical table; ADR-0017 ships TS only). **HG-15 re-fires at T16.1** for `retention_sweep_runs` and `audit_log_retention_schedule` (G-T16-6).
- **HG-14 does NOT re-fire** (RATIFIED 2026-05-22 for ADR-0015 schedule; T16 mirrors that schedule verbatim into `RETENTION_SCHEDULE`).
- **HG-10 does NOT fire** (no user-facing pre-deletion notification surface). Defensible from privacy-officer angle as long as F-61 underlying-record-ceiling holds — PIPEDA 4.9 individual access is preserved through the 30d ceiling window.
- **No cross-border transfer.** No new subprocessor.

---

## PI touchpoints in diff

- `apps/web/src/lib/retention/types.ts:21-66` — `RetentionEventType` closed enum (46 entries). No per-event PI fields.
- `apps/web/src/lib/retention/schedule.ts:34-85` — `RETENTION_SCHEDULE` frozen const, mirrors ADR-0015 verbatim.
- `apps/web/src/lib/retention/schedule.ts:92-94` — `OPERATIONAL_TABLE_SCHEDULE` 24h sweep for `auth_totp_consumed_log`.
- `apps/web/src/lib/retention/memory-retention-store.ts:39` — `SYSTEM_ACTOR_ID = 'system:retention-sweep'` (opaque ID; HMAC-pseudonym derived before any store-external surface).
- `apps/web/src/lib/retention/memory-retention-store.ts:151-153` — `systemActorPseudonym()` HMAC-SHA-256 32-hex pseudonym. ADR-0016 §Decision 1 key sharing.
- `apps/web/src/lib/retention/retention-core.ts:277-290` — `summaryMeta` jsonb: counts, schedule_hash, status, alarm_fired, run_id. **No per-row IDs. No actor identities beyond the SYSTEM_ACTOR_ID HMAC pseudonym.**
- `apps/web/src/lib/retention/retention-core.ts:293-312` — `retention.deleted` audit row with `target_id: null` (F-62 structural carve-out).
- `apps/web/src/lib/retention/retention-core.ts:64-74` — `generateRunId()` rejection-samples UUIDs to avoid phone-shape and pseudonym-shape collisions (F-67 hygiene).

No log statements. No URL parameters. No error messages returned to clients carry PI. The library **deletes** PI from `audit_log` and operational tables; it writes only counts and HMAC pseudonyms.

---

## Q1-Q9 Verdicts

**Q1 — F-19/F-55 closed allowlist:** APPROVED unconditionally. Three layers verified (compile-time `never` exhaustiveness; runtime `Object.freeze`; CI drift assertion `runScheduleDriftCheck()`). Set-equality holds across the 46-entry enum / schedule / runtime list.

**Q2 — F-61 underlying-record-ceiling 30d:** APPROVED. F-62 carve-out (null target_id) handled correctly; counter-test verified at 29d preservation.

**Q3 — F-58 retention.deleted summary shape:** APPROVED-WITH-ADVISORY. Summary meta carries counts only — no per-row IDs, no actor identities beyond HMAC pseudonym. **G-T16-PRIV-1 BLOCKING-IN-T16.1:** memory store inlines pseudonym into `meta` at memory-retention-store.ts:272 — acceptable for library testing but `SupabaseRetentionStore` MUST NOT duplicate the pseudonym into `meta` jsonb (G-T11-14 / T13 hygiene pattern). **G-T16-PRIV-2** (documentation): ADR-0017 §7 should note the intentional `meta.run_id` redundancy with the run-row column.

**Q4 — F-67 no PII in error paths:** APPROVED-WITH-ADVISORY. All 8 error paths inspected; structured `error_code` strings only. `generateRunId()` rejection sampling is sound. **G-T16-PRIV-3 BLOCKING-IN-T16.1:** `runRetentionPass` swallows thrown Error completely (retention-core.ts:252, :313). Correct for client-facing payloads (constraints.md:111) but degrades operator observability. T16.1 should route swallowed Error to server-side structured-log sink with PI scrubbing (PIPEDA 4.10).

**Q5 — F-68 RA-1 control #5 preservation:** APPROVED unconditionally. `'export.generated': { years: 7 }` pinned at schedule.ts:54; `RetentionPassConfig` has zero per-event override fields; @ts-expect-error test confirms the type system actually rejects override attempts. RA-1 trigger #5 does NOT fire.

**Q6 — F-62 retention.deleted carve-out:** APPROVED. Carve-out logic at memory-retention-store.ts:187-190 (null target_id ⇒ exempt from ceiling); 7y per-event floor still binds.

**Q7 — PIPEDA 4.5 enforcement vs declaration:** APPROVED. T16 is the first structural enforcer in the codebase. Real deletion (no tombstones); snapshot/restore lives only within a pass invocation. **G-T16-PRIV-4 BLOCKING-IN-T16.1:** `RetentionPassConfig.dry_run` is declared at types.ts:101 with documentation but the library does NOT consume `dry_run` (destructured but unused at retention-core.ts:136-140). PIPEDA 4.7 clarity issue — operators reading the config interface expect `dry_run: true` to make the pass safe. Architect resolves: either delete the field OR wire it through as a true "do not delete, just count" path.

**Q8 — HG-10 trigger check:** CONCUR with threat-modeler. PIPEDA 4.5 mandates enforcement (T16 is the first); 4.9 individual access preserved through F-61 30d ceiling window; 4.8 openness supported by the `audit_log_per_event_type` summary jsonb. F-62 carve-out is necessary (adding target_id would re-attach PI to the summary and make the audit-trail-of-deletes itself a target of the next pass). HG-10 NOT firing is defensible from privacy-officer angle.

**Q9 — No caller-supplied WHERE:** APPROVED. Verified at three levels (production interface arity, method-name allowlist scan, frozen const + spread defense). Privacy implication: a caller-supplied WHERE could selectively skip-delete a user's data — structurally prevented at the library layer.

---

## Cross-cutting findings

**A — Library halves of G-T05-6 and G-T05-7 close.** SQL halves remain on G-T16-4 (cross-mirror drift, T16.1).

**B — PIPEDA 4.5 first structural enforcement.** All seven prior privacy reviews (T05/T07/T08/T10/T11-T12/T13/T14) close their "retention enforcement deferred to T16" sub-items.

**C — HMAC pseudonym key sharing (ADR-0016 §Decision 1).** `systemActorPseudonym()` is per-store-instance in memory; T16.1's `SupabaseRetentionStore` shares the AuthStore's HMAC key so pseudonym values are cross-correlatable across audit-log readers. Library is correctly agnostic to the specific key.

---

## PIPEDA Principles compliance summary

| Principle | Status |
|---|---|
| 4.1 Accountability | ✓ (systemActorPseudonym named actor) |
| 4.2 Identifying Purposes | ✓ (RETENTION_SCHEDULE mirrors ADR-0015 verbatim) |
| 4.3 Consent | N/A (sweep system-initiated; user consented via HG-14) |
| 4.4 Limiting Collection | N/A |
| 4.5 Limiting Retention | ✓ **(load-bearing — first structural enforcer)** |
| 4.6 Accuracy | N/A |
| 4.7 Safeguards | ~ (G-T16-PRIV-1 actor_pseudonym duplication BLOCKING-IN-T16.1; G-T16-PRIV-4 dry_run BLOCKING-IN-T16.1) |
| 4.8 Openness | ✓ (audit_log_per_event_type summary jsonb) |
| 4.9 Individual Access | ✓ (F-62 carve-out + F-61 30d window preserve reachability) |
| 4.10 Challenging Compliance | ~ (G-T16-PRIV-3 operator-side structured Error logging BLOCKING-IN-T16.1) |

---

## BLOCKING-NOW vs BLOCKING-IN-T16.1

**BLOCKING-NOW:** none. Library cleanly closes the privacy-relevant gates expressible at the TS layer.

**BLOCKING-IN-T16.1:**
1. **G-T16-PRIV-1** — `SupabaseRetentionStore` must NOT duplicate `actor_pseudonym` into the audit_log row's `meta` jsonb (G-T11-14 / T13 lineage). Top-level column only.
2. **G-T16-PRIV-3** — server-side structured Error logging (with PI scrubbing) for the swallowed catch blocks at retention-core.ts:252, :313.
3. **G-T16-PRIV-4** — architect decision: consume or remove `dry_run` config field. PIPEDA 4.7 clarity.
4. **G-T16-6** (carry-forward, threat-model.md:821) — HG-15 re-ratification at T16.1 PR for two new physical tables.
5. **G-T16-7** (carry-forward, threat-model.md:822) — §PI inventory amendments at T16.1.

**Advisories (non-blocking):**
- **G-T16-PRIV-2** — document `meta.run_id` redundancy in ADR-0017 §7.
- **G-T16-PRIV-5** — operational confirmation: 32-char HMAC pseudonym truncation matches T07/T08/T11/T12/T13/T14 shape.
- **G-T16-PRIV-6** — privacy-reviewer revisits Q9 at T16.1 SQL function signature review.
- **G-T16-PRIV-7** — T18 next pass: confirm integrity-job join reads only structural fields.

---

## RA-1 / RA-2 verdict

- **RA-1 compensating control #5** (`export.generated` 7y): HOLDS. F-68 verified at schedule.ts:54 + structural impossibility of override.
- **RA-2 trigger #3** (live-chain vs pg_dump divergence): HOLDS with new reconciliation anchor `retention_sweep_runs.per_event_counts` (F-69 verified at retention-core.ts:301-311). T18 integrity-job join inherits as G-T16-8.

Neither re-opens.

---

## Carry-forwards (7 new G-T16-PRIV-* entries)

- **G-T16-PRIV-1** — BLOCKING-IN-T16.1 — actor_pseudonym must not duplicate into meta jsonb in `SupabaseRetentionStore`.
- **G-T16-PRIV-2** — DOCUMENTATION — ADR-0017 §7 note `meta.run_id` redundancy.
- **G-T16-PRIV-3** — BLOCKING-IN-T16.1 — operator-side structured Error logging for swallowed catches.
- **G-T16-PRIV-4** — BLOCKING-IN-T16.1 — architect resolves `dry_run` config field (consume or remove).
- **G-T16-PRIV-5** — ADVISORY — HMAC pseudonym shape cross-mirror.
- **G-T16-PRIV-6** — ADVISORY — T16.1 SQL function signature revisit.
- **G-T16-PRIV-7** — ADVISORY — T18 integrity-job join structural-fields-only.

---

## Overall T16 privacy verdict

**PASS-WITH-ADVISORIES.** Library-only per ADR-0002 Amendment H. PIPEDA Principle 4.5 is now structurally enforced for the first time. Three BLOCKING-IN-T16.1 items + existing G-T16-1..10 carry-forwards + four advisories + library halves of G-T05-6 / G-T05-7 closed. Zero BLOCKING-NOW. RA-1 holds. RA-2 holds. HG-10 NOT firing defensible.

---

## Handoff

- **Architect (T16.1):** resolve G-T16-PRIV-4 (`dry_run` field); fold G-T16-PRIV-1 + G-T16-PRIV-3 into the `SupabaseRetentionStore` design.
- **T16.1 implementer:** carry G-T16-1..10 (advisory lock, statement/lock timeouts, pg_cron 03:30 ET, cross-mirror drift test, A-RETENTION-001 alert, HG-15, §PI inventory, T18 reconciliation, `xact_start()`, SECURITY DEFINER signatures).
- **Privacy-reviewer (T16.1 PR):** re-run on `SupabaseRetentionStore`, two new physical tables, §PI inventory amendments, HG-15 ratification.
- **Threat-modeler (T16.1 PR):** confirm none of the seven re-open triggers fired during T16.1 build.
- **Observability-setup (next pass after T16.1):** A-RETENTION-001 alert sink (G-T16-5).
- **T18 implementer (next pass):** integrity-job reconciliation join (G-T16-8).
