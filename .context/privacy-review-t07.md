# Privacy Review T07 — E2EE Key Core + Recovery Blob + Committee Key Wrap + Amendment F

**Status: FAIL** — APPROVED-WITH-CHANGES with three BLOCKING findings (T07-1, T07-2, T07-3) and four advisory findings (T07-A1..A4).

> Returned inline per the precedent at `/home/user/agent-os/.context/privacy-review.md:5` and `/home/user/agent-os/.context/privacy-review-t05.md:5`. The orchestrator captured this to `/home/user/agent-os/.context/privacy-review-t07.md`.

---

## HUMAN GATES TRIGGERED

- **HG-15 (Operational-table retention schedule)** — ADR-0016 §"Operational rules 2" hard rule: *"Every operational table touching PI MUST appear in this schedule before the table ships in any migration that lands in `main`."* T07 introduces **six new persistent tables** (`identity_keys`, `recovery_blobs`, `recovery_blob_resets`, `committee_data_keys`, `committee_key_wraps`, `committee_key_wraps_history`) and **one new column** (`recovery_blobs.view_count`). **None** of these are listed in ADR-0016's operational-table schedule or in `decisions.md` §PI inventory. **Block T07 merge until an ADR-0016 amendment / new ADR ratifies the rows AND user re-ratifies under HG-15** (the existing HG-15 covered the T05-side tables; T07's six new tables expand the schedule).
- **No cross-border-transfer gate** in this diff — all new tables live in Supabase Postgres (`ca-central-1`); no new third-party processor.
- **No new subprocessor.**

---

## 1. Scope

Six T07 PIPEDA questions from the implementer (Q1..Q6) and two cross-cutting questions (A — `identity_pubkey` placement; B — Argon2id fallback). PI-inventory amendments needed are surfaced in §11.

---

## 2. Q1 — `identity_keys` table

### Verdict
**APPROVED-WITH-CHANGES.** T07-1 BLOCKING.

### T07-1 (BLOCK — PIPEDA 4.5)
6 new tables ship without ADR-0016 schedule rows.

**Fix:** add ADR-0016 schedule row for `identity_keys`: **Until passkey revoked OR membership inactive + 24 months**. Add §PI inventory row; amend existing `users.identity_pubkey` row at line 3257 to annotate relocation per ADR-0002 Amendment G.3 pattern.

---

## 3. Q2 — `recovery_blobs` table

### Verdict
**APPROVED-WITH-CHANGES.** T07-2 + T07-3 BLOCKING.

### T07-2 (BLOCK — PIPEDA 4.4 + 4.5.3)
`recovery_blobs.view_count` is undocumented persistent cross-session counter. Duplicates audit-log data (derivable from `audit_log` rows where `event_type='identity_privkey.recovery_blob.viewed'`).

**Fix (preferred):** remove `view_count` column; derive at read-time from audit log. **Alternative:** keep AND document purpose in ADR-0003 Amendment F addendum AND wrap UPDATE + audit_emit in single transaction AND add to §PI inventory.

### T07-3 (BLOCK — PIPEDA 4.5 + ADR-0016)
`recovery_blobs` and `recovery_blob_resets` have no retention schedule.

**Fix:** ADR-0016 rows:
- `recovery_blobs`: Membership + 24 months. C2.
- `recovery_blob_resets`: 15 minutes after `issued_at` if unconsumed, hard-delete on consume. C1.

---

## 4. Q3 — committee_data_keys + committee_key_wraps + committee_key_wraps_history

### Verdict
**APPROVED.** Per-table retention rows folded into T07-1.

### History purge on member-revoke

Privacy verdict: **right call.** Minimization (Principle 4.4) wins on its own merits. Forensic continuity preserved by the audit row, not the wrap history. The `committee_data_key.member_revoked` audit row carries the necessary attribution.

**Caveat (T07-A1 advisory):** test-writer assert ordering — audit row emission BEFORE history purge in the same transaction.

---

## 5. Q4 — `recovery_blob_resets` table

### Verdict
**APPROVED** with retention fix folded into T07-3 and advisory T07-A2.

### T07-A2 (ADVISORY — PIPEDA 4.9)
`issue_recovery_blob_reset` emits no audit row. Acceptable Phase-0 gap; blocking first production deploy.

---

## 6. Q5 — `identity_privkey.recovery_blob.viewed` audit event

### Verdict
**APPROVED.**

Retention `membership+24mo` confirmed per ADR-0015. Meta is minimal (actor_id, enrollment_session_id, reveal_count_in_session). No raw UA, no IP, no clipboard, no passphrase. PIPEDA 4.4 satisfied.

---

## 7. Q6 — Amendment F controller (`show-again.ts`)

### Verdict
**APPROVED.** No PI surfaces. T07-A3 advisory.

### T07-A3 (ADVISORY)
Static-lint glob references `src/lib/onboarding/recovery/` but the controller is at `src/lib/recovery/`. Architect widens lint scope.

---

## 8. Cross-cutting A — `identity_pubkey` placement

§PI inventory anticipated a column on `users`; migration creates separate `identity_keys` table. Drift needs three closures:

1. ADR-0002 Amendment G.3 addendum documenting relocation
2. Test harness query update (`identity_keys.public_key` vs current `users.identity_pubkey`)
3. ADR-0003 Amendment A CI grep target update

**Verdict:** denormalization fine from privacy posture (Principle 4.7 unaffected). Document drift. Advisory.

---

## 9. Cross-cutting B — Argon2id fallback

### Verdict
**T07-A4 advisory.** T07 merge acceptable; **blocking first production deploy** until production guards land.

### T07-A4 (ADVISORY — PIPEDA 4.7)
BLAKE2b fallback when `crypto_pwhash` absent. The kdf_params claim Argon2id while actual derivation may be BLAKE2b. PIPEDA Principle 4.7 — sensitivity-appropriate safeguard fails if production path activates this fallback.

**Fix (must land before production deploy):**
- Boot-time assertion refusing to start if `crypto_pwhash` absent and `NODE_ENV !== 'test'`.
- pnpm `lockfile-lint` for `libsodium-wrappers-sumo` in production builds.
- Fail-closed restore: `decryptRecoveryBlob` compares `kdf_params.alg === 'argon2id13'` against runtime capability; fail loudly if mismatch.
- Document the test-only fallback in ADR-0003 or new ADR.

---

## 10. Threat-model cross-check

No classification creep. No residency drift. No purpose-creep (subject to T07-2 closing). Retention drifts per T07-1 + T07-3.

---

## 11. PI inventory amendments needed

Architect folds these into `.context/decisions.md` §PI inventory AND adds rows to ADR-0016's operational-table schedule. Six new schedule rows + ~20 new PI inventory rows + two amendments to existing rows (lines 3257, 3258 — relocation annotations).

---

## 12. Findings summary

### Blocking (must close before T07 merge)
- **T07-1.** ADR-0016 schedule + §PI inventory rows for 6 new tables.
- **T07-2.** `recovery_blobs.view_count` over-collection — remove or document.
- **T07-3.** `recovery_blobs` + `recovery_blob_resets` retention schedule.

### Advisory (non-blocking on T07 merge; some block production deploy)
- **T07-A1.** Test-writer obligation: audit row ordering on member-revoke.
- **T07-A2.** `issue_recovery_blob_reset` audit emission (blocking first production deploy).
- **T07-A3.** Static-lint glob widening.
- **T07-A4.** Argon2id fallback production guards (blocking first production deploy).
- **Cross-cutting A.** ADR documentation of identity_pubkey relocation.
- **Carry-forward T05:** T16 retention sweep now must enforce six new T07 tables in addition to T05 tables.

---

## 13. Overall T07 privacy verdict

**FAIL — APPROVED-WITH-CHANGES.** T07-1 + T07-2 + T07-3 are BLOCKING. The cryptographic posture is sound; Amendment F controller is clean. Blockers are documentation gaps plus one over-collection (`view_count`).

HG-15 user re-ratification required.

---

## 14. Handoff

Architect-coordinator must:
1. Add 6 ADR-0016 schedule rows; HG-15 re-ratification.
2. Decide on `view_count` — preferred removal.
3. Document `identity_pubkey` / `recovery_blob` relocation in ADR-0002 Amendment G.3 addendum.
4. Update ADR-0003 Amendment A grep target.
5. Decide on T07-A2 — interim audit emission OR T06 deferral.
6. Ratify T07-A4 production guards.

Then migration-handler, test-writer, implementer, and privacy-reviewer re-runs.

---

## Final pass after architect amendment #5 (2026-05-23)

**Status: APPROVED** — all three prior BLOCKING findings closed; all four advisories either fixed at the library layer or carried forward to T07.1 with explicit known-gap entries.

### HUMAN GATES — re-check

- **HG-15 does NOT fire in this T07 pass.** Verified: `supabase/migrations/` contains only `00000000000000_init.sql` and `00000000000001_auth.sql`; no new operational PI table ships in this PR. Next HG-15 fire is at T07.1 PR submission.
- No cross-border transfer introduced. No new subprocessor.

### Re-verification

| Finding | Verdict | Closure mechanism |
|---|---|---|
| T07-1 (6 tables without ADR-0016 rows) | CLOSED-IN-T07 | Migration dropped; G-T07-4 + G-T07-5 capture T07.1 obligations |
| T07-2 (view_count over-collection) | CLOSED-IN-T07 | No view_count column ships; G-T07-6 captures "preferred removal" for T07.1 |
| T07-3 (recovery_blobs/recovery_blob_resets retention) | CLOSED-IN-T07 | Tables don't ship; G-T07-4 covers |
| T07-A1 (audit-row ordering test) | DEFERRED-TO-T07.1 | ADR-0002 Amendment H T07.1 deliverable list captures |
| T07-A2 (issue_recovery_blob_reset authz+audit) | DEFERRED-TO-T07.1 | G-T07-8 captures |
| T07-A3 (lint glob widening) | CLOSED-IN-T07 | scripts/check-recovery-surface-lint.sh wired into verify.sh:147; covers both recovery surfaces; passes |
| T07-A4 library half (Argon2id safeguard) | CLOSED-IN-T07 | ADR-0003 Amendment G fail-closed contract at recovery-blob.ts:144-146 + :184-190; data-integrity bomb structurally prevented |
| T07-A4 production half (sumo dep + boot guard + lockfile-lint) | DEFERRED-TO-T07.1 | G-T07-12 captures |
| Cross-cutting A (identity_pubkey relocation) | DEFERRED-TO-T07.1 | G-T07-11 captures |
| Cross-cutting B (Argon2id) | CLOSED-IN-T07-LIBRARY | Same as T07-A4 |

### Threat-model cross-check

- F-08: strengthened (fail-closed makes silent KDF substitution structurally impossible).
- F-12: SQL-side authz + audit deferred to T07.1 via G-T07-8.
- M-54a/b/c/d: unchanged; T07-A3 widened lint hardens M-54d defense surface.
- No flow upgraded; no border crossed; no retention extended; no purpose expanded.

### Overall T07 privacy final verdict

**APPROVED.** T07 ships as library-only per ADR-0002 Amendment H. T07.1 is the production-deploy gate per ADR-0002 Amendment H. All twelve G-T07-* obligations are tracked in `.context/known-gaps.md`.

### Handoff

1. **Orchestrator:** T07 merge unblocked from privacy perspective. The pending PIPEDA-Principle-4.7 production guards (G-T07-12) MUST land before the first deploy that creates real recovery_blobs rows.
2. **T07.1 privacy-reviewer (future):** re-verify (a) view_count is NOT a column in T07.1's migration, (b) audit-before-purge ordering test lands with revoke_committee_member, (c) issue_recovery_blob_reset carries authz + audit, (d) sumo dep swap + boot-time assertion + lockfile-lint land, (e) identity_pubkey relocation ADR addendum lands.
