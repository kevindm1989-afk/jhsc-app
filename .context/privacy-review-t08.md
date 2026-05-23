# Privacy Review T08 — Concern Intake Library (Library-Only per ADR-0002 Amendment H)

**Status: APPROVED-WITH-ADVISORIES** — no blocking findings on T08-as-library; all PIPEDA gaps structurally deferred to T08.1 via G-T08-1..8. Three new advisories (T08-A1..A3) for the library layer; six prior carry-forwards re-confirmed.

> Returned inline per the precedent at `/home/user/agent-os/.context/privacy-review.md:5`, `/privacy-review-t05.md:5`, `/privacy-review-t07.md:5`. Orchestrator captured to this path.

---

## HUMAN GATES — re-check

- **HG-15 does NOT fire in this T08 pass.** Verified: `apps/web/src/lib/concerns/` contains only TypeScript + one Svelte form; `supabase/migrations/` is unchanged. No new operational PI table ships. Next HG-15 fire is at T08.1 PR submission (per G-T08-4).
- **No cross-border transfer** — region pin (`ca-central-1`) unchanged.
- **No new subprocessor.**
- **HG-10 (labour-lawyer + privacy-lawyer review)** remains the prerequisite for production deploy of any consent-bearing surface; carry-forward.

---

## 1. Scope

T08 is library-only per ADR-0002 Amendment H. Diff `7bd7d4a..930d098` covers `apps/web/src/lib/concerns/*` + harness extensions in `apps/web/test/_helpers/supabase-test.ts`.

---

## 2. Q1 — Concern row shape

**Verdict: APPROVED.** Library matches §PI inventory classifications (C3 body/title, C4 source_name, C1 enums).

- `actor_pseudonym` is HMAC-SHA-256 keyed via shared AuthStore key (ADR-0016 §Decision 1) — cross-surface equality preserved.
- `anonymous` is NOT a column — derivable from `source_name_ct IS NULL` (minimization).

**T08-A1 (ADVISORY):** `ConcernRow.actor_id` / `created_at` / `updated_at` missing from §PI inventory. Already captured in G-T08-5 for T08.1.

---

## 3. Q2 — `concern.updated` `prev_field_hashes` payload

**Verdict: APPROVED.** SHA-256 over ciphertext is PIPEDA Principle 4.7-defensible for tamper-detection.

- The hash is over libsodium secretbox ciphertext (nonce-prefixed, 16-byte MAC). Plaintext leak surface = zero.
- F-16's purpose: "detect that a body was changed without revealing plaintext." The hash is a forensic anchor, not a pseudonym.
- The ADR-0016 ban on bare `digest('sha256')` targets **pseudonym derivation**, not tamper-detection over already-encrypted content. The existing semgrep rule scope is correct.

**No change needed.** Keep SHA-256.

---

## 4. Q3 — Anonymous default-lock + consent advisory ordering

**Verdict: APPROVED-WITH-ADVISORIES.**

- 4.1 Default-ON: `ConcernIntakeForm.svelte:48` — `let anonymous = true;` on every fresh mount. PIPEDA 4.4 satisfied.
- 4.2 Advisory before source_name input: `{#if !anonymous}` block renders `role="status"` advisory FIRST, then field. PIPEDA 4.3 satisfied.
- 4.3 Keyboard-only reachability: Space/Enter/Code=Space all handled with `preventDefault()`. WCAG 2.1.1 + PIPEDA 4.3.4 satisfied.

**T08-A2 (ADVISORY — PIPEDA 4.3.4):** consent-copy missing purpose statement. The current "About to save a worker's name" + storage-posture copy describes the storage but NOT the purpose (why the name is being collected). PIPEDA Principle 4.3.4 requires informed-of-purpose consent. Fix at T08.1 (i18n + HG-10 labour-lawyer review).

**T08-A3 (ADVISORY — UX-correctness):** no form-side validation gate for empty `sourceName` when named-source selected. Library catches at `concern-core.ts:143-146` with 403, but form should surface before submit. Non-blocking polish.

Note: ADR-0007 amendment's four-bullet consent contract is **scoped to reprisal-log intake (Surface C)**, NOT non-reprisal concern intake (Surface B). The current two-sentence advisory is the correct shape for Surface B.

---

## 5. Q4 — `actor_pseudonym` on anonymous concerns

**Verdict: APPROVED unconditionally.** F-17 invariant structurally enforced.

- `concern.created` carries `actor_pseudonym` regardless of `intake.anonymous`.
- Anonymous-vs-named distinction lives in `meta.anonymous_default_kept`, NOT in audit-row existence.
- Original ADR-0007 intent matches: the toggle applies to source-name, not author.

---

## 6. Q5 — `revealSource` flow

**Verdict: APPROVED with G-T08-6 carry-forward.**

- 6.1 Audit row commits BEFORE plaintext returns (verified via `await` ordering at `concern-core.ts:271-294`).
- 6.2 Decrypted source delivered to caller only; not logged or cached.
- 6.3 Audit meta carries no PI beyond pseudonym + concern_id + timestamps.
- 6.4 Per-record passphrase is library-accepted but not library-enforced — closes at T08.1 per G-T08-6.

---

## 7. Q6 — Rate limit (F-20)

**Verdict: APPROVED.** 20/hour/user is the F-20 ratified ceiling; PIPEDA 4.4-defensible.

The 20/24h second ceiling lands at T08.1 via SECURITY DEFINER `consume_concern_rate_budget` per G-T08-3. **NEW G-T08-11** (proposed below) pins this enforcement.

---

## 8. Cross-cuttings

### A — Carry-forwards G-T08-1..8 verified

All 8 entries at `known-gaps.md:180-230` correctly capture T08.1 obligations. Three new carry-forwards proposed:

- **G-T08-9 (NEW):** Consent-copy purpose statement (PIPEDA 4.3.4) — non-reprisal concern intake advisory must name the purpose of source-name collection. Closure: i18n catalog update + HG-10 labour-lawyer ratification before T08.1 production deploy.
- **G-T08-10 (NEW):** Form-side validation gate for empty `sourceName` when named-source selected. Closure: implementer adds inline-error pattern in T08.1 or follow-up T08 polish.
- **G-T08-11 (NEW):** 200/24h second-ceiling enforcement. Currently only 20/hour is in `MemoryConcernStore`. T08.1's `consume_concern_rate_budget` SQL function adds the second window.

### B — No new PI surface in T08

Verified: in-memory only. No file I/O, no network, no IndexedDB, no localStorage. No outbound calls. No PI in URLs, logs, or error messages.

---

## 9. Threat-model cross-check

| Flow | Verified |
|---|---|
| F-15 RLS active-member gate | `concern-store.ts:63`; `memory-concern-store.ts:60-68` |
| F-16 prev_field_hashes on UPDATE | `concern-core.ts:201-217` (SHA-256 over ciphertext) |
| F-17 actor_pseudonym always present | `concern-core.ts:167-177`; `concern-store.ts:34` |
| F-18 default projection omits source_name_ct | `types.ts:86-99`; structural at type level |
| F-20 rate limit 20/hr, no PI body | `memory-concern-store.ts:179-191` |
| F-30 session-invalidation propagation | Harness synchronous; production carry-forward G-T08-8 |

No flow upgraded. No border crossed. No retention extended. No purpose expanded.

---

## 10. PI inventory amendments for T08.1

Architect-coordinator pass at T08.1 must add:
- `concerns.id` (UUID): C1.
- `concerns.actor_id`: C1, F-17 attribution anchor, NEVER NULL.
- `concerns.created_at` / `concerns.updated_at`: C0 operational timestamps.
- ADR-0016 schedule row for `concerns`: 7y post-closure.

---

## 11. Findings summary

### Blocking on T08 merge
**NONE.**

### Advisory (non-blocking on T08-library merge)
- **T08-A1.** `actor_id` / `created_at` / `updated_at` not in §PI inventory. Closure: G-T08-5 at T08.1.
- **T08-A2.** Consent-copy purpose statement missing per PIPEDA 4.3.4. Closure: G-T08-9.
- **T08-A3.** Form-side validation gate for empty `sourceName`. Closure: G-T08-10.

---

## 12. Overall T08 privacy verdict

**APPROVED-WITH-ADVISORIES.** T08 ships as library-only per ADR-0002 Amendment H. The library layer satisfies PIPEDA Principles 4.1, 4.3, 4.4, 4.5, 4.7, 4.9 for its scope.

Eleven T08.1 carry-forwards tracked (G-T08-1..8 existing + G-T08-9..11 from this review).

T08.1 privacy-reviewer (future) must re-verify on the T08.1 diff: ADR-0016 schedule row + HG-15 re-ratification; §PI inventory amendments; both rate-limit ceilings; per-record passphrase verification; audit-emit-before-plaintext in single SQL transaction; structural `source_name_ct` omission in default view; route handler + 60s session-invalidation budget; consent-copy purpose statement.

---

## 13. Handoff

**Next agent: orchestrator.**

Orchestrator obligations:
1. Append G-T08-9, G-T08-10, G-T08-11 to `.context/known-gaps.md` under the T08 section.
2. Confirm T08 PR description references the eleven T08.1 carry-forwards as production-deploy gates.

No HG fires in this T08 pass. HG-15 + HG-10 queued for T08.1.
