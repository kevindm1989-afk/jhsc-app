# Privacy Review T11 / T12 — Export Pipeline + RA-1 Compensating Controls

**Status: PASS-WITH-ADVISORIES** (library-only per ADR-0002 Amendment H). RA-1 holds as-implemented with **two BLOCKING-IN-T11.1 gaps**, **16 advisories**, **1 HG-10 trigger** on consent + recipient-identification copy.

> Returned inline per the precedent. Orchestrator captured to this path.

---

## HUMAN GATES

- HG-15 does NOT fire (no new physical table).
- HG-1 / RA-1 does NOT re-open (none of the six re-open triggers in `decisions.md:3299-3306` fires from this diff).
- **HG-10 fires** on recipient-identification + four-bullet consent copy (G-T11-NEW-1, G-T11-NEW-4, G-T11-NEW-16).
- No cross-border transfer. No new subprocessor.

---

## Q1-Q7 Verdicts

**Q1 — F-19 closed allowlist:** APPROVED unconditionally. Three-layer enforcement (frozen const + compile-time exhaustiveness + audit-row hash binding). Two ADVISORIES: hash determinism pin, ESLint rule verification.

**Q2 — RA-1 #3 visible concern-derived flag:** APPROVED-WITH-ADVISORIES. UI surface + audit row both wired correctly. Two ADVISORIES: T13-style four-bullet parity (HG-10 fires); **BLOCKING-IN-T11.1: hazard_class hardcoded to `'physical'`** — PIPEDA Principle 4.6 (Accuracy) violation in the re-consent surface.

**Q3 — RA-1 #4 post-export notification:** APPROVED-WITH-ADVISORIES. Wiring correct. Three ADVISORIES: user-visible notification-deferred i18n missing; RA-1 trigger #5 monitoring alert needed; fan-out latency not contractually bounded.

**Q4 — `export.generated` audit shape:**
- `actor_pseudonym` HMAC — VERIFIED.
- `allowlist_hash` — VERIFIED.
- `derived_from_concerns_count` (separate row carries IDs) — CORRECT.
- **BLOCKING FINDING #1**: `recipient_role` is a role label, not identity. PIPEDA 4.5 + 4.9 forensic gap. Must add `recipient_user_pseudonym` for T11.1.
- **BLOCKING-IN-T11.1 hygiene**: `approver_pseudonym` + `actor_pseudonym` duplicated in meta (PIPEDA 4.7 audit-shape clarity).

**Q5 — F-24 audit-before-Blob:** APPROVED for primary row. ADVISORY on second-class row ordering atomicity (BLOCKING-IN-T11.1 for SQL transaction); ADVISORY on `'audit_failed'` reason missing from type union.

**Q6 — Hand-rolled PDF emitter:** APPROVED. Zero third-party telemetry. NO `/Info` dictionary (the critical privacy property — absence of `Author`/`Producer`/`Creator` metadata). ADVISORY: regression test should assert byte-grep absence of those strings.

**Q7 — `ExportInterstitial.svelte`:** APPROVED-WITH-ADVISORIES. ADVISORIES on PIPEDA 4.3.4 four-bullet parity copy (HG-10), `mode` prop type tightening, AODA-spec scope routed.

---

## Cross-cutting

**A — Recipient identification:** BLOCKING-IN-T11.1. Only role label surfaced today; must add display name + `recipient_user_pseudonym`. PIPEDA 4.3.4 requires "to whom" to be answerable. Multi-employer-co-chair edge needs architect decision.

**B — Concern-derived granularity:** APPROVED-WITH-ADVISORY. Current per-concern list adequate. Recommend surfacing `concernDerivedAnnotatedFields(kind)` subtext for full PIPEDA 4.3.4 informedness.

---

## RA-1 verdict

**HOLDS as-implemented at the library layer.** Two BLOCKING-IN-T11.1 findings narrow RA-1's margin but no re-open trigger fires:
- Trigger #4 (allowlist change touching C4 / source identity) — does NOT fire (allowlist has zero C4 fields; F-19 negative test verifies).
- Trigger #5 (loss of post-export notification surface) — does NOT fire (both surfaces present and library-tested).

T11-A4 (hazard_class) materially impairs informed re-consent until T11.1 closes; this is the highest-priority advisory.

---

## PIPEDA Principles compliance summary

| Principle | Status |
|---|---|
| 4.1 Accountability | ✓ |
| 4.2 Identifying Purposes | ✓ |
| 4.3 Consent | ~ (HG-10 four-bullet parity recommended) |
| 4.4 Limiting Collection | ✓ (F-19 structural) |
| 4.5 Limiting Disclosure | ✓ (with BLOCKING #1 recipient-identity narrowing) |
| 4.6 Accuracy | ✗ (hazard_class hardcoded; BLOCKING-IN-T11.1) |
| 4.7 Safeguards | ✓ (with BLOCKING #2 hygiene) |
| 4.8 Openness | ✓ (HG-10 verifies privacy policy alignment) |
| 4.9 Individual Access | ✓ (with BLOCKING #1 narrowing) |
| 4.10 Challenging Compliance | ✓ (runbook documents escalation) |

---

## PI inventory amendments for T11.1/T12.1

21 new §PI inventory rows (`minutes_final.*`, `recommendations.*`, `export_rate_buckets.*`). 3 ADR-0016 schedule rows. HG-15 re-ratifies at T11.1/T12.1 PRs.

---

## Carry-forwards (21 new entries — see known-gaps.md)

G-T11-NEW-1 through G-T11-NEW-21 cover: HG-10 copy reviews (4 entries), BLOCKING-IN-T11.1 (5 entries — hazard_class, recipient pseudonym, dup pseudonym, SQL atomicity, PDF byte-grep), PIPEDA hygiene (multiple), `__debug*` interface split (mirror of G-T13-15 / G-T14-17).

---

## Overall T11/T12 privacy verdict

**PASS-WITH-ADVISORIES.** Library-only per ADR-0002 Amendment H. RA-1 holds. Two BLOCKING-IN-T11.1 findings + 16 advisories + 21 carry-forwards. None block the library PR.

---

## Handoff

- Architect (T11.1 + T12.1): folds 21 §PI inventory rows + 3 ADR-0016 schedule rows + 5 BLOCKING-IN-T11.1 fixes + HG-15.
- Labour-lawyer + privacy-lawyer (HG-10): recipient-identification copy, four-bullet interstitial copy, annotated-fields subtext, notification-deferred error string.
- Accessibility-specialist: interstitial markup review (out-of-scope here).
- Test-writer: assertions for `recipient_user_pseudonym`, PDF byte-grep regression, SQL atomicity, hazard_class accuracy, interface-split.
- Threat-modeler (next pass): residual reassessment after BLOCKING #1/#2 close in T11.1.
