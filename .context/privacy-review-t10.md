# Privacy Review T10 — Offline Inspection Queue + EXIF Strip + SW Cache Allowlist

**Status: PASS (APPROVED-WITH-ADVISORIES)** — library-only per ADR-0002 Amendment H. All three blocking HG-3/HG-4/HG-5 surfaces correctly bound to the in-memory T10 library; two advisories (T10-A1, T10-A2) carry forward to T10.1; one design-debt note (T10-D1) on the canvas no-op in jsdom; six prior carry-forwards re-confirmed; no new HG fires this pass.

> Returned inline per the precedent at `.context/privacy-review.md:5`, `privacy-review-t05.md:5`, `privacy-review-t07.md:5`, `privacy-review-t08.md:5`. Orchestrator captured to this path.

---

## HUMAN GATES — re-check

- **HG-3 (SW cache allowlist), HG-4 (offline-queue HMAC), HG-5 (EXIF strip)** — all three already ratified per ADR-0011/0013/0014. T10 ships the library binding; **no new HG fires this pass**. HG-15 (operational-table retention) fires at T10.1 PR submission.
- **No cross-border transfer** introduced.
- **No new subprocessor.**

---

## 1. Scope

Commit `a1d2b2d` on `claude/jhsc-app-plan-nUriS`, library-only per ADR-0002 Amendment H.

---

## 2. Q1 — Photo metadata strip (HG-5 / ADR-0011 amendment)

**Verdict: APPROVED-WITH-ONE-DESIGN-DEBT (T10-D1).**

APPn (0xFFE0..0xFFEF) + COM (0xFFFE) strip at `sanitize.ts:131-137` covers EXIF/IPTC/XMP/ICC/JFIF/MakerNote (lives inside APP1) by construction. PIPEDA 4.4 + 4.7 satisfied for JPEG.

**T10-D1 (DESIGN-DEBT):** `canvasReencode()` at `sanitize.ts:181-186` is a pass-through stub. ADR-0011 amendment rule 3 mandates real canvas re-encode as defense-in-depth. Marker-strip is sufficient for the known JPEG threat model; canvas re-encode is the belt-and-suspenders. Closure: T10.1 wires real `OffscreenCanvas.convertToBlob` behind feature-detect.

**Non-JPEG inputs** silently produce empty `[SOI, EOI]` envelope (`sanitize.ts:71-76`). Privacy-safe (zero leak) but UX gap — see **T10-A2**.

**"Use my current location" structurally absent.** Verified by grep: zero `navigator.geolocation` references; only negative assertions documenting the deliberate omission.

---

## 3. Q2 — Offline queue HMAC + ciphertext (HG-4 / ADR-0014)

**Verdict: APPROVED.**

- Plaintext never persists — `encryptPayload` precedes `entries.push`.
- K_hmac in-memory only — derived from identity privkey via single-step BLAKE2b-keyed KDF; nulled by `session.end()`.
- Cross-device replay rejected — HMAC scope includes user_id; mismatch → quarantine.
- Sequence-gap detection — defense-in-depth beyond ADR-0014.
- Server-side `client_integrity_tag` recorded — T10.1 migration adds column.

**T10-A1 (ADVISORY — PIPEDA 4.4 minimization):**

`queue.ts:212` — `entry.id = entry-${seq}-${user_id}` composes raw user_id UUID into IDB primary key and flows into `inspection.synced.meta.inspection_id` at `supabase-test.ts:1521`. Not a fresh disclosure (user_id is already C1 in §PI inventory), but breaks ADR-0016 §Decision 1 HMAC-pseudonymization parity for audit-log meta.

Closure (G-T10-2): T10.1 server-side `inspections` PK is server-generated UUID; audit emits server-generated handle; client `entry.id` becomes IDB-local only.

---

## 4. Q3 — Service-worker cache allowlist (HG-3 / ADR-0013)

**Verdict: APPROVED.**

- Closed allowlist at `sw/index.ts:79-96` — exactly 7 ADR-0013-mandated patterns.
- `/api/**` early-reject at `sw/index.ts:104` — covers every C3/C4 endpoint by construction.
- `X-Data-Class: C3|C4` sanity check at `sw/index.ts:192-205` — emits `client.cache_policy_violation` to pendingViolations queue.
- Clear on lock/logout/panic — `clearDynamicCachesOnLock` deletes every non-`static-assets-*` cache.
- Version-bump invalidation — `clearStaleVersionCaches` deletes stale-version caches.
- Pending-audits queue carries no actor identifier — pseudonym attached at flush time via `pseudonymOf(user.user_id)`.

Defense-in-depth correctly layered.

---

## 5. Q4 — Audit events from T10 surfaces

**Verdict: APPROVED.**

| Event | Retention | PI check |
|---|---|---|
| `queue.integrity_fail` | Match underlying (7y) | actor_pseudonym HMAC-keyed; no raw user_id |
| `client.cache_policy_violation` | 90 days | No actor identifier in SW-side row; pseudonym at flush time |
| `inspection.synced` | Match underlying (7y) | meta.inspection_id carries raw user_id — see T10-A1 |

Canonical event `queue.integrity_fail` used; forbidden alias `inspection.synced.hmac_fail` absent (semgrep rule intact).

---

## 6. Q5 — IndexedDB persistence shape (T10.1 contract)

**Verdict: APPROVED for the library-level contract.**

T10 in-memory `entries: QueuedEntry[]` shape: `{id, sequence_number, user_id_bytes, salt_version, ciphertext, tag, enqueued_at}`. **No plaintext payload field. No plaintext notes. No plaintext source-name analogue.**

**T10.1 contract (G-T10-3):** IDB object-store schema must be byte-for-byte this shape. Privacy will block T10.1 if any plaintext PI field is added.

---

## 7. Q6 — F-47 queue cap (500)

**Verdict: APPROVED.**

`QUEUE_CAP = 500` at `queue.ts:36` enforced at `queue.ts:194-197`. PIPEDA 4.4 structural minimization. Reject-with-banner is correct fail-closed UX.

---

## 8. Cross-cutting

### A — PhotoCaptureSurface.svelte minimal scaffold

49-line scaffold. No PI surfaces in current minimal version. Free-text `locationText` (not geolocation). No image preview. Static advisory copy is structural minimization disclosure.

G-T10-4 carry-forward: T10.1 wires full UX (capture → preview → sanitize → encrypt → enqueue) and re-confirms structural invariants.

### B — flushOfflineAudit() route contract

`/api/audit/queue` MUST be in SW non-cacheable list — already enforced by `/api/**` early-reject. Body carries HMAC-pseudonymized actor refs only. Established `audit_emit(...)` SECURITY DEFINER pattern.

G-T10-5 carry-forward: T10.1 route contract — server-side pseudonym set from JWT (not client-supplied) to prevent forgery; rate-limited; never in SW allowlist.

---

## 9. PI inventory amendments needed for T10.1

| Field | Class | Retention |
|---|---|---|
| `inspections.client_integrity_tag` (NEW) | C1 | Match underlying (7y) |
| `inspections.sequence_number` (NEW) | C1 | 7y |
| `inspections.actor_id` (already implied; absent from §PI inventory) | C1 | 7y |
| IDB `inspection_queue` store (NEW; client-side) | C3 ciphertext + C1 metadata | Until drain OR overflow OR clear |
| IDB `rejected_queue_entries` store (NEW; client-side) | C3 + C1 + reason | Lock/logout/panic clears |

HG-15 fires at T10.1 PR submission.

---

## 10. Findings summary

### Blocking on T10 merge
**NONE.**

### Advisory (non-blocking; some block T10.1 / production deploy)
- **T10-A1.** Raw user_id in `entry.id` → `inspection.synced.meta.inspection_id`. Closure: G-T10-2 at T10.1.
- **T10-A2.** Non-JPEG silent-destroy is privacy-safe but UX gap. Add fixtures + explicit reject at T10.1.
- **T10-D1.** `canvasReencode()` is a pass-through stub. Wire real path at T10.1.

---

## 11. Overall T10 privacy verdict

**PASS — APPROVED-WITH-ADVISORIES.** Library-only per ADR-0002 Amendment H. No blocking findings.

HG-3/HG-4/HG-5 all structurally correct. Six new carry-forwards (G-T10-1..6) tracked for T10.1.

---

## 12. Handoff

Next: test-writer (T10.1 closure-coverage) and architect (T10.1 §PI inventory + ADR-0016 schedule + ADR-0014 follow-up).

Test obligations for T10.1: inspection_id pseudonymization; non-JPEG contract; canvas re-encode in real browser; IDB schema parity; `/api/audit/queue` rate-limit; not-in-SW-allowlist; lock/logout/panic clears IDB stores.
