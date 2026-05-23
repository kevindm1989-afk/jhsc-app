# Privacy Review T14 — Work Refusal (s.43) + s.51 Evidence Libraries

**Status: PASS (APPROVED-WITH-ADVISORIES)** — library-only per ADR-0002 Amendment H. All production-PI gates structurally deferred to T14.1 via G-T14-1..9 (+ 5 new G-T14-10..18 from this pass).

> Returned inline per the precedent at `.context/privacy-review-t13.md:5`. Orchestrator captured to this path.

---

## HUMAN GATES

- HG-15 does NOT fire (no new physical table); re-fires at T14.1 PR.
- HG-6 (Amendment B mirror) library-verified at work-refusal-core.ts:188-200 and s51-evidence-core.ts:224-236.
- HG-5 (ADR-0011 amendment) sanitize-BEFORE-encrypt verified at s51-evidence-core.ts:161-168.
- HG-13 (Amendment D extension) library projection verified for both surfaces.
- HG-10 does NOT fire (no new statute-facing copy).
- HG-7 does NOT fire (soft-delete not in T14 scope).

No new HG newly tripped.

---

## Q1-Q7 verdicts

**Q1 — work_refusal row shape:** APPROVED-WITH-CLARIFICATION. T14-A1 advisory on C3/C4 vocabulary overload in Amendment A extension table (library correctly uses C4; ADR text needs disambiguation — G-T14-15).

**Q2 — s51_evidence row shape:** APPROVED-WITH-CLARIFICATION. T14-A4 advisory: §PI inventory's wildcard `s51_evidence.*_ciphertext` should be expanded to itemize `title_ct`, `notes_ct`, `photos_ct[]`. T14-A5 advisory on `photo_count` weak forensic inference (negligible; keep for forensic-reveal value).

**Q3 — HG-6 server-side read audit:** APPROVED at library layer. T14-A6 advisory: library `canRead*` short-circuit precedes audit emit (denied callers leave no audit row). Behaviorally equivalent to production SECURITY DEFINER view (zero-row from RLS WHERE clause). Document the production view inlines `jhsc_caller_can_read_*` in WHERE — G-T14-16.

**Q4 — Amendment D extension:** APPROVED unconditionally. Both list shapes structurally exclude `actor_pseudonym` at TypeScript level. T14-A7 advisory: `__debug*` methods must not survive into Supabase stores — G-T14-17.

**Q5 — Rate-limit posture:** ADVISORY INCONSISTENCY. `rate_limited` declared but never enforced. Privacy does NOT block (s.43/s.51 are statutory filings; under-rate-limiting could itself be a labour-rights problem). Architect resolves at T14.1 — implement (10/hr recommended) OR drop from denial union. G-T14-18.

**Q6 — Photo sanitization:** APPROVED unconditionally. sanitize-BEFORE-encrypt ordering verified. T10 G-T10-1 fail-closed posture propagates through `submitS51Evidence`.

**Q7 — Per-record passphrase:** APPROVED. F-34 pattern carried at store level; read flow does NOT verify passphrase (role-gated via F-21 is load-bearing). T14-A8 advisory: no `attemptReadWithPassphrase*` analog. Architect decision at T14.1 — library-layer attempt vs view-layer absorb — G-T14-10.

---

## Cross-cutting

**A — notes_ct column-name parity (G-T14-8):** library uses `notes_ct`; §PI inventory uses `notes_ciphertext`. Test hardcodes `notes_ct`. Recommend §PI inventory rename to `notes_ct` for verbatim parity.

**B — reader_role in read-audit meta (G-T14-9):** absent. Not a PIPEDA blocker; weakens forensic-reveal scoping. Recommend T14.1 architect adds `reader_role ∈ {certified_member, worker_co_chair, employer_co_chair}` to audit meta.

---

## PI inventory amendments for T14.1

15 new §PI inventory rows + 2 ADR-0016 schedule rows. HG-15 re-fires at T14.1 PR.

---

## New carry-forwards (G-T14-10..18 consolidated with second-opinion-reviewer)

- **G-T14-10** (privacy + second-opinion overlap): F-34 friction-layer `attemptReadWith*Passphrase` + `sensitive.access_attempt` for s.43/s.51 reveal flows.
- **G-T14-11** (second-opinion): `transaction_ts_ms` library shim (mirrors G-T13-9).
- **G-T14-12** (second-opinion): `s51_evidence.create.rejected` enum + audit + structured return for `PhotoUnsupportedFormatError`.
- **G-T14-13** (second-opinion): `submit*` insert+audit atomicity (inherited gap from T13 `submitReprisal`).
- **G-T14-14** (second-opinion): Test verifying `c4_read_service` shared-role atomicity (revoke once → aborts all three).
- **G-T14-15** (privacy): Class-vocabulary disambiguation in Amendment A extension table.
- **G-T14-16** (privacy): RLS-WHERE-filters-before-audit invariant for SECURITY DEFINER view bodies.
- **G-T14-17** (privacy): `__debug*` methods interface split (extends G-T13-15 to T14).
- **G-T14-18** (privacy): Rate-limit decision — implement (10/hr) or drop `'rate_limited'` from denial union.

---

## Overall T14 privacy verdict

**PASS (APPROVED-WITH-ADVISORIES).** Library-only per ADR-0002 Amendment H. Every PIPEDA Principle 4.x check enforceable at the library layer is structurally encoded. HG-6 + HG-5 + HG-13 mirrors all verified. No cross-border transfer, no new subprocessor, no human gate newly tripped.

**5 new carry-forwards** + **8 advisories** (T14-A1..A8). None blocking the library-only deliverable.

---

## Handoff

- Architect (T14.1): folds §PI inventory amendments + ADR-0016 schedule + class-vocab disambiguation + RLS-WHERE invariant + rate-limit decision + passphrase-verify-layer decision.
- Test-writer: pgTAP suite scoped under G-T14-3; if G-T14-18 resolves to implement-rate-limit, add per-actor budget tests.
- Threat-modeler: F-21/F-17/F-32-33/F-46 unchanged; new F-* entry if rate-limit lands.
- Orchestrator: capture this review to `.context/privacy-review-t14.md`.

No HG fires in this pass. T14 library-only deliverable approved.
