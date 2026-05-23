# Privacy Review T13 — Reprisal Log Library

**Status: PASS (APPROVED-WITH-ADVISORIES)** — library-only per ADR-0002 Amendment H. All production-PI gates structurally deferred to T13.1 via G-T13-1..14.

> Returned inline per the precedent at `.context/privacy-review.md:5`, `.../privacy-review-t05.md:5`, `.../privacy-review-t07.md:5`, `.../privacy-review-t08.md:5`, `.../privacy-review-t10.md:5`. Orchestrator captured to this path.

---

## HUMAN GATES

- **HG-15** does NOT fire this pass. No new physical table ships in T13; HG-15 re-ratifies at T13.1 PR (per G-T13-4).
- **HG-6 (Amendment B)** — library mirror verified at `reprisal-core.ts:204-217` (audit-emit-then-decrypt with `await` discipline + audit-failure short-circuit returning before plaintext). Production atomicity is T13.1 SECURITY DEFINER view's job.
- **HG-7 (4-eyes destructive ops)** — library mirror verified at `memory-reprisal-store.ts:259-274` (self-approve denied + role-pair predicate).
- **HG-13** — library mirror verified per Amendment D + Amendment E + ADR-0007 amendment.
- **HG-10 (labour-lawyer + privacy-lawyer)** fires on G-T13-13 (consent wording substitution). Privacy assessment: substantively equivalent under PIPEDA 4.3.4; HG-10 sign-off still required.
- No cross-border transfer; no new subprocessor.

---

## Q1 — `reprisal_log` row shape

**APPROVED unconditionally for the library shape.** T13.1 §PI inventory expansion bundled with the migration via G-T13-5.

**T13-A1 (ADVISORY):** `per_record_passphrase_hash` is a new C2-shaped column not yet in §PI inventory. Retention floor SHOULD equal `body_ct`'s ("Active matter + 7y"). T13.1 architect pass.

**T13-A2 (ADVISORY):** `per_record_passphrase_hash` placeholder is HMAC-SHA-256 with the committee key as HMAC key. Confidentiality-only placeholder; replaced at T13.1 with argon2id per G-T13-6.

---

## Q2 — `reprisal.created` visible to all members (Amendment D Option (c))

**APPROVED unconditionally.** `ReprisalFeedItem` at `types.ts:86-95` structurally excludes `actor_pseudonym` — the TS interface IS the closed-column contract. `listReprisalFeed` at `memory-reprisal-store.ts:302-318` correctly filters + buckets ts to hour.

**T13-A3 (ADVISORY — defense-in-depth):** `MemoryReprisalStore.__debugAuditRows()` returns raw `actor_pseudonym` to any caller. Library-internal; must not survive into `SupabaseReprisalStore`. Carry-forward G-T13-15.

---

## Q3 — `reprisal.read` server-side audit (HG-6 / Amendment B)

**APPROVED at the library layer.** Audit-emit-then-decrypt enforced at `reprisal-core.ts:187-231` with `try/catch` short-circuit. Adversary check passes: co-opted rep cannot bypass `await` discipline without modifying library code; production `c4_read_service` role is the only role with SELECT on `reprisal_log`.

---

## Q4 — Forensic-reveal flow (Amendment E)

**APPROVED.** All 6 Amendment E §1-§6 points verified:
- `PendingFourEyesOp` schema mirror.
- Two distinct approvers (self-approve denied).
- 24h expiry with `revealed_actor_pseudonym` cleared on sweep.
- Reveal-session visibility scoped to proposer + approver pair.
- Audit-chain rows on both proposal + approval.
- After-expiry re-requesting requires fresh 4-eyes (no library-level reopen path).

**T13-A4 (ADVISORY — PIPEDA 4.4):** `pending.reveal_reason` is free-text and propagates into `audit.forensic_reveal.*` meta at 7y retention. Free-text fields are a leakage vector. T13.1 SHOULD constrain via: (a) ≤256 char cap, (b) UI placeholder "do NOT include names", (c) HG-10 review. Carry-forward G-T13-16.

---

## Q5 — Consent surface (G-T13-13)

**APPROVED-WITH-HG-10-GATE.** The substituted wording ("sealed/locked/submit" vs "encrypted/saved/save") is **substantively equivalent under PIPEDA Principle 4.3.4**:
- "Sealed/locked to the committee key" is technically more accurate than "encrypted/saved" (libsodium vocabulary).
- "Submit" disambiguates from local "save".
- All four bullets + OHSA reminder + per-intake re-render unchanged.

HG-10 ratification still required per ADR-0007 amendment §"Architectural contract" item 5 — final-copy authority belongs to the labour lawyer.

**This does NOT independently re-trigger HG-13** (architect-owned bundled gate). HG-13 was ratified on the architectural shape (unchanged).

---

## Q6 — `prev_field_hashes` on update

**APPROVED unconditionally.** SHA-256 over libsodium ciphertext (nonce-prefixed). Plaintext leak surface = zero. Identical pattern to T08's F-16; ADR-0016 ban on bare `digest('sha256')` targets pseudonym derivation, not tamper-detection over ciphertext.

---

## Q7 — Feed visibility + author-private content

**APPROVED unconditionally.** Architect's Amendment D Option (c) is correctly enforced:
- Entry's existence visible to all members (via projection).
- Entry's content remains author-private (body_ct/title_ct never in feed shape).
- Forensic-reveal flow is the ONLY library path to un-projected author identity.

Threat-model F-17 analogue closed.

---

## Cross-cutting

### A — Consent wording deviation (G-T13-13)

Covered in Q5. Substantively equivalent. HG-10 ratification required.

### B — `pending_destructive_ops` column-name parity (G-T13-11)

Library shape verified. Operational tables use raw user_ids with FK + strict RLS (canonical pattern per System Design §RLS outline). Audit_log carries HMAC pseudonyms. **G-T13-17 (NEW):** T13.1 migration MUST encode strict RLS for `pending_destructive_ops` and `pending_forensic_reveals`.

### C — `vi` global hygiene (G-T13-12)

Verified clean. Production reprisal code has zero `vitest` references. `globalThis.vi` exposure confined to `test/setup.ts`.

---

## PI inventory amendments for T13.1

Required §PI inventory rows (operational tables):
1. `reprisal_log.id` — C0
2. `reprisal_log.actor_id` — C1, FK to `users.id`, NEVER NULL (F-17)
3. `reprisal_log.title_ct` — C4
4. `reprisal_log.body_ct` — C4
5. `reprisal_log.per_record_passphrase_hash` — C2 (T13-A1)
6. `reprisal_log.status` — C1 closed enum
7. `reprisal_log.{created_at, updated_at}` — C0
8. `pending_destructive_ops.*` — C1+C0
9. `pending_forensic_reveals.*` — C1
10. `pending_forensic_reveals.revealed_actor_pseudonym` — C1, 24h scope
11. `pending_forensic_reveals.reveal_reason` — C2-prone (T13-A4)

ADR-0016 schedule rows:
- `reprisal_log` — Active matter + 7y; real-delete by retention service
- `pending_destructive_ops` — 30d after terminal state
- `pending_forensic_reveals` — 7y to match audit retention; revealed_actor_pseudonym cleared at expires_at + 24h

HG-15 re-ratifies at T13.1 PR.

---

## New carry-forwards proposed

- **G-T13-15 (defense-in-depth):** `MemoryReprisalStore` `__debug*` methods must NOT survive into `SupabaseReprisalStore`. Interface split (mirrors G-T07-10).
- **G-T13-16 (PIPEDA 4.4):** `reveal_reason` free-text constraints — ≤256 chars + UI guard + HG-10 review.
- **G-T13-17 (PIPEDA 4.7):** Strict RLS on `pending_destructive_ops` + `pending_forensic_reveals` (SELECT scoped to proposer+approver+co-chairs; INSERT to active members; UPDATE of approver_id to distinct member).

---

## Overall T13 privacy verdict

**PASS (APPROVED-WITH-ADVISORIES).** Library-only per ADR-0002 Amendment H. Every PIPEDA Principle 4.x check enforceable at the library layer is structurally encoded.

Three new carry-forwards (G-T13-15/16/17) + four advisories (T13-A1/A2/A3/A4). None blocking the library-only deliverable.

---

## Handoff

- **Architect (T13.1 pass)** folds PI inventory amendments + ADR-0016 schedule rows + ADR-0003 Amendment B/E schema-column parity (G-T13-11) + G-T13-15/16/17.
- **Labour-lawyer (HG-10)** ratifies the substituted consent wording per G-T13-13. Privacy assessment: substantively equivalent; recommend APPROVE.
- **Accessibility-specialist** reviews the consent surface (out of privacy scope).
- **Test-writer** has no new obligations (privacy-review §7 test obligations 1-6 are covered by G-T13-3 pgTAP suite + existing T13 library tests).

No HG fires in this pass.
