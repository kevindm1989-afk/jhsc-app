# Privacy Review T18 — Audit-Log Integrity Library + MemoryIntegrityStore

**Status: PASS-WITH-ADVISORIES** (library-only per ADR-0002 Amendment H). PIPEDA Principle 4.7 (Safeguards) is **STRENGTHENED** — T18 closes the operational test of RA-2 compensating control #3 (the only operational verification that the v1 prev_hash-linear chain has not been tampered with). PIPEDA 4.5 (Limiting Retention) is preserved — three new audit-event types reserve T18.1 retention classes (`ran` = 24mo, `mismatch` = 7y, `weekly` = 7y) per ADR-0019 §Decision drivers + threat-model §3.11 classification line. F-91 backup-diff is the LOAD-BEARING pivot-rewrite detector and is wired correctly (1h buffer; reconciliation in BOTH directions). Closes library halves of G-T16-8, G-T17-PRIV-7, G-T17-9, G-T17-RA2-ANCHOR-CONSUMER. **Zero BLOCKING-NOW.** Six BLOCKING-IN-T18.1 + five advisories.

> Returned inline per the precedent at `.context/privacy-review-t17.md`. Captured by the orchestrator.

---

## HUMAN GATES

- **HG-15 does NOT fire** in T18 (library-only). **HG-15 re-fires at T18.1** for new `integrity_check_runs` physical table + optional `audit_chain_anchors` table + `integrity_check_role` non-login role (B6.2 boundary).
- **HG-10 does NOT fire** (operator-facing alerts only; zero user-facing copy). **CONCUR with threat-modeler.**
- **HG-9 does NOT re-fire.** Three new audit-log enum values ride standard ADR-0003 Amendment A six-mirror extension dance — TS const half lands in T18; SQL CHECK + retention-schedule rows defer to T18.1.
- **No cross-border transfer.** Library is region-agnostic; T18.1 wires in `ca-central-1`.
- **No new subprocessor.** ADR-0010 single-subprocessor preserved — only `node:crypto`. BLAKE2b in T18.1 is Node-native.

---

## Q1-Q12 Verdicts

**Q1 — F-94 no PII in mismatch/ran/anchor rows:** APPROVED. `actor_pseudonym` AT TOP LEVEL ONLY across all three row types. Mismatch row meta is closed 8-key composition (`run_id, detected_via, row_id, expected_hash, actual_hash, prev_hash_match, attribution_attempted, backup_manifest_run_id?`) — no `target_id`/`actor_pseudonym`/`event_type`/`meta` of mismatching row. Ran row: closed structural meta. Anchor row: exactly `{anchor_at_ms, head: {id, ts_ms, hash}}`. G-T17-PRIV-7 + G-T16-PRIV-1 mirror VERIFIED.

**Q2 — F-91 LOAD-BEARING backup-diff vs PIPEDA 4.7:** APPROVED. 1h buffer (INTEGRITY_BACKUP_DIFF_BUFFER_MS = 1 hour) at integrity-core.ts:250+264. Pivot-rewrite detection at 300-312. A-AUDIT-001 fires via `would_fire_alert`. Without F-91, PIPEDA 4.7 reduces to chain-walk-only which CANNOT catch pivot-rewrite by construction.

**Q3 — F-92 reconciliation correctness:** APPROVED. Both directions verified. Over-attribution prevented by greedy budget DECREMENT, per-event-type key lookup, `__ceiling__` skipped. Under-attribution prevented by sweep window check, missing-key-treated-as-0. Distinct-cause alert routing ensures A-INTEGRITY-002 fires ONLY on `unattributable_count > 0`.

**Q4 — F-93 runtime-pin operational routing:** APPROVED. Closed literal `runtime_pin_mismatch` — NOT A-AUDIT-001. NO mismatch rows emitted; NO `would_fire_alert`. Null manifest correctly SKIPS pin check. Toolchain upgrade false-positive prevention structurally enforced.

**Q5 — F-100 no PII in errors:** APPROVED. All 6+2 error literals reachable. `run_id` uses `ic_` prefix + dual rejection-sample. No template-string interpolation. Internal `throw new Error(literal)` translated to structured error_code without surfacing Error.message.

**Q6 — F-97 no caller-supplied predicate/pivot/WHERE:** APPROVED. Type-level closure via eleven `?: never` fields + `exactOptionalPropertyTypes: true`. Trigger union closed; `assertValidTrigger` exhaustive-switches with `never`. Store-side closure prevents WHERE/predicate/pivot/table_name surface.

**Q7 — Cross-border egress:** APPROVED. Library region-agnostic; T18.1 wires in ca-central-1. Off-app weekly anchor email is operator-mediated to co-chair email-of-record (not stored in app).

**Q8 — ADR-0010 single-subprocessor:** APPROVED. Only `node:crypto` imports. Zero non-`node:*` deps. BLAKE2b in T18.1 is Node-native. Sentry remains only non-Supabase subprocessor.

**Q9 — HG-10 trigger check:** CONCUR with threat-modeler. Zero user-facing components. `actor_pseudonym = HMAC('system:integrity-check')` — user doesn't appear in rows. PIPEDA 4.8 preserved via policy disclosure + audit-log visibility.

**Q10 — T16/T17 dependency check:** APPROVED. Zero imports from `../retention/` or `../backup/`. Zero reverse imports of `audit-integrity` from T16/T17. Data-layer composition via injected `IntegrityStore` interface only.

**Q11 — F-94 anchor test-bug:** NOTED AS CARRY-FORWARD. Implementation IS correct per F-96 contract (head's hash passes through verbatim). Test-fixture seedChain produces digit-only hex hashes that trip PHONE_SHAPE regex. Carry-forward: G-T18-PRIV-11.

**Q12 — New `G-T18-PRIV-*` entries:** see BLOCKING-IN-T18.1 + Advisories.

---

## PIPEDA Principles compliance summary

| Principle | Status |
|---|---|
| 4.1 Accountability | ✓ (`systemActorPseudonym` names integrity-check actor) |
| 4.2 Identifying Purposes | ✓ (RA-2 control #3 operational test) |
| 4.3 Consent | N/A (system-initiated) |
| 4.4 Limiting Collection | ✓ (structural fields only; F-94 deep-grep pin) |
| 4.5 Limiting Retention | ✓ (3 retention classes: 24mo/7y/7y) |
| 4.6 Accuracy | N/A |
| 4.7 Safeguards | ✓ **STRENGTHENED** (F-91 pivot-rewrite detection) |
| 4.8 Openness | ✓ (with T18.1 copy update) |
| 4.9 Individual Access | ✓ (per-event aggregate summary) |
| 4.10 Challenging Compliance | ~ (G-T18-PRIV-3 BLOCKING-IN-T18.1: 8 swallowed-catch structured-logging sites) |

---

## BLOCKING-NOW vs BLOCKING-IN-T18.1

**BLOCKING-NOW:** none.

**BLOCKING-IN-T18.1:**
1. **G-T18-PRIV-1** — §PI inventory amendments (`integrity_check_runs` + optional `audit_chain_anchors`).
2. **G-T18-PRIV-2** — A-AUDIT-001 / A-INTEGRITY-001 / A-INTEGRITY-002 sink wiring with F-95 distinct-cause routing + F-93 operational routing for `runtime_pin_mismatch`.
3. **G-T18-PRIV-3** — Server-side structured Error logging with PI scrubbing for 8 swallowed-catch sites in integrity-core.ts. Mirrors G-T16-PRIV-3 + G-T17-PRIV-3.
4. **G-T18-PRIV-4** — CI no-import test pinning G-T18-NO-T16-T17-COUPLING.
5. **G-T18-PRIV-5** — HG-15 re-ratification for integrity_check_runs + integrity_check_role + audit_chain_anchors.
6. **G-T18-PRIV-6** — Confirm worker co-chair email-of-record is NOT an in-app stored field; privacy-policy disclosure of weekly anchor delivery.

**Advisories (non-blocking):**
- **G-T18-PRIV-9** — Pin divergent chain-walk vs backup-diff attribution semantics in T18.1 pgTAP with rationale.
- **G-T18-PRIV-10** — Column-level pgTAP assertion that `node_runtime_pin.{node_version, openssl_version}` are semver-shape only.
- **G-T18-PRIV-11** — F-94 anchor test seed should use cryptographic-entropy hashes to avoid spurious phone-shape collisions.
- **G-T18-PRIV-12** — Move `compareIds` (currently unused) to `_internal.ts` or remove.
- **G-T18-PRIV-13** — `xact_start()` shim for production SupabaseIntegrityStore.nowMs() (G-T16-9 / G-T17-2 lineage).

---

## Carry-forwards closed by T18 (library halves)

- G-T16-8 — integrity-job join over (audit_log, retention_sweep_runs, backup_manifest) library-modelled.
- G-T17-PRIV-7 — join reads only structural fields.
- G-T17-9 — zero-event-count convention: missing key treated as 0.
- G-T17-RA2-ANCHOR-CONSUMER — three field names snapshot-pinned at BackupManifestSnapshot.
- G-T16-RECONCILE-CEILING — `__ceiling__` explicitly skipped.
- G-T11-23 — hash-determinism pin via runtime_pin coherence.
- F-19 / F-58 / F-72 / F-66 / G-T16-PRIV-1 / G-T16-PRIV-3 patterns.

---

## RA-1 / RA-2 verdict

- **RA-1 control #5:** HOLDS unchanged.
- **RA-2 compensating control #3:** **OPERATIONAL FOR THE FIRST TIME** at T18 library boundary. T18.1 wall-clock wiring makes it production-operational.
- **RA-2 trigger #3:** F-91 backup-diff is the operational test. NOT re-opened; STRENGTHENED. First-firing tag enforced via A-AUDIT-001 zero-threshold + A-INTEGRITY-002 distinct-cause routing.

Neither RA-1 nor RA-2 re-opens.

---

## Overall T18 privacy verdict

**PASS-WITH-ADVISORIES.** Library-only per ADR-0002 Amendment H. PIPEDA Principle 4.7 (Safeguards) STRENGTHENED. Zero BLOCKING-NOW. Six BLOCKING-IN-T18.1 + five advisories. HG-10 NOT firing defensible. No cross-border surface; no new subprocessor.
