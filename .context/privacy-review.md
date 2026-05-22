# Privacy Review — Reprisal-Log Audit Visibility & Audit-Log Retention

Status: APPROVED-WITH-CHANGES on Q1; APPROVED-WITH-CHANGES on Q2.

> Note on file authorship. The privacy-reviewer agent returned its findings inline rather than writing to disk, citing an internal rule conflict ("Do NOT Write report/summary/findings/analysis .md files. Return findings directly as your final assistant message"). The orchestrator captured the inline output to this path verbatim so the workflow has a single source of truth. Nothing in the review depends on the agent itself having written the file.

---

## 1. Scope

**Covered.** Two targeted PIPEDA + Ontario + ADR-consistency questions surfaced by the observability-setup agent:
- Q1: Is broadcasting `reprisal.created` audit-event existence (not body) to all active committee members defensible under PIPEDA Principles 4.3 (consent), 4.4 (limiting collection), 4.5 (limiting use)?
- Q2: Is the 24-month uniform audit-log retention defensible under PIPEDA Principle 4.5, given the constraints "at least 1 year" floor and the underlying records ranging from 90 days (drafts) to "Active matter + 7y" (C4)?

**Not covered.** This is not a full diff-time privacy review — no application code exists yet. PIPEDA Principles 1, 6, 7, 8, 9, 10 are touched only where the two questions intersect them. Cross-border transfers, third-party processor onboarding, and the export pipeline (RA-1 / HG-1) are out of scope for this review. AODA accessibility review of the consent surface is flagged for the accessibility-specialist; not performed here.

**Sources read.**
- `/home/user/agent-os/.context/constraints.md`
- `/home/user/agent-os/.context/decisions.md` ADR-0001, ADR-0003 (+ Amendments A & B), ADR-0007, ADR-0012, RA-1, System Design §PI inventory
- `/home/user/agent-os/.context/threat-model.md` §3.4 (reprisal STRIDE F-30 to F-36), §4 (PI inventory), §5 (breach map), §6 (Invariant 7), §9 (HG-1, HG-6)
- `/home/user/agent-os/observability/audit-log.md` (full)
- `/home/user/agent-os/observability/README.md` §1, §4, §10
- `/home/user/agent-os/JHSC-APP-PLAN.md` §6, §8, §3

**PI touchpoints in scope.**
- `audit_log.event_type = 'reprisal.created'` row visible to all active members via the RLS policy at `observability/audit-log.md:243-249`. Reveals: `{ts, actor_pseudonym, target_id = reprisal_id, target_class = 'C4', meta.reprisal_id}` — i.e., "rep X created a reprisal entry at time T."
- `audit_log` 24-month uniform retention via the DELETE GRANT to `retention_service_role` filtered by `ts < now() - interval '24 months'` (`observability/audit-log.md:228-230`).

---

## 2. Q1 — Visibility of `reprisal.created` to all active members

### 2.1 Finding

**The current posture (status quo = Option (a) in the question) is NOT defensible as-shipped without an explicit consent surface AND a reduction in disclosed metadata. Block T13 until the architect amends.**

**Regime + principles cited:**
- **PIPEDA Principle 4.3 (Consent), 4.3.4, 4.3.5, 4.3.6** — consent must be informed and meaningful and "appropriate to the sensitivity of the information." `reprisal_log` is the highest sensitivity class in the system (C4 per `decisions.md` §C4, threat-model §4) and is the load-bearing OHSA s.50 evidence channel. Bundled or implicit consent at general onboarding does not meet 4.3.6 for C4.
- **PIPEDA Principle 4.4 (Limiting Collection) — 4.4.1** — collect "only … that is necessary." Disclosure scope is the disclosure analogue: 4.5.3 limits *use and disclosure* to what is necessary for the identified purpose. The current scheme discloses `actor_pseudonym + target_id + ts` to ~12 people. Most of that disclosure exceeds what the social-norm rationale actually requires.
- **PIPEDA Principle 4.5 (Limiting Use, Disclosure, Retention)** — disclosure to other reps is a *use* that needs a documented purpose. ADR-0003 Amendment B (HG-6) documents server-side enforcement of read-audits; it does NOT document the purpose of disclosing *write* events to other reps. The "social norm backstop" rationale is documented for *reads* (Amendment B, RA-1 compensating control #4 for exports), not for writes.
- **OHSA s.50 (anti-reprisal)** — the OHSA reprisal protection runs in both directions: a reprisal entry, including the *fact of authorship*, can itself become a reprisal trigger if the author is identifiable from `actor_pseudonym` and the act of logging is inferred to reflect personal experience. Threat-model F-31 + F-33 + O-4 already acknowledge a co-chair-and-author collusion vector; F-30 acknowledges a 15-min cached-session leakage window. The "inference disclosure" raised in the question is the missing F-finding: **a co-opted rep (A3) seeing `reprisal.created` by actor X at time T can infer X is the target of reprisal, without ever reading the entry body.**

### 2.2 Why the social-norm rationale is necessary but insufficient as drawn

The social-norm-backstop logic is sound for **reads** of C4 (Amendment B, F-33). Read-events are inherently rare and signal active interest. **Write-events do not carry the same signal weight** — a worker rep documenting their own reprisal is the primary lawful use of `reprisal_log`, and broadcasting that they did so creates a disincentive to log. The control inverts the threat: it is supposed to deter coerced *access*, but as currently scoped it also deters legitimate *authorship*.

ADR-0003 Amendment B explicitly chose server-emitted read-audit; the corollary architect choice for `reprisal.created` visibility has **never been ratified in an ADR**. The closest thing is `observability/audit-log.md` §6 finding #4 ("Surface to privacy-reviewer before T13 ships; the privacy notice may need to name this explicitly") — i.e., the observability author already flagged this as unsigned-off-by-privacy.

### 2.3 Recommendation: Option (c) — pseudonymized in the visible feed, with a delayed-projection variant

Of the four options posed, **Option (c) — author-pseudonymized in the visible feed** is the recommended posture, with two strengthenings:

1. **Author-hidden projection.** The default `audit_log` row stores `actor_pseudonym` (same HMAC pseudonym as elsewhere — `observability/README.md` §2). The visible feed for `reprisal.created` (and `reprisal.read`, `reprisal.status_changed.*`) renders **only** `{target_id (reprisal_id), event_type, ts, target_class}` — `actor_pseudonym` is suppressed in the projection. The underlying row keeps `actor_pseudonym` for forensic use (post-incident investigation, audit-log integrity job F-50).
2. **Time-bucketed timestamps in the projection.** Round `ts` to the nearest hour in the rendered feed. The exact timestamp is in the underlying row for forensic queries; the displayed timestamp prevents shift-pattern inference (e.g., "the only rep on night shift just logged a reprisal").
3. **Projection is via a `SECURITY DEFINER` view** mirroring the Amendment B pattern (`reprisal_audit_feed_pseudonymized`). Direct `SELECT` on `audit_log` by `authenticated` for rows where `event_type LIKE 'reprisal.%'` is REVOKED; the view inlines the projection. Forensic access to the un-projected row is via a separate role (e.g., `forensic_read_service`) accessible only post-incident with a 4-eyes pattern matching the existing `pending_destructive_ops` flow.

**Why not (b) — visible only to other worker reps of the same caucus.** This is worker-side-only by design (`JHSC-APP-PLAN.md` §3.2), so "the same caucus" is "every active member" — (b) collapses to (a) and gains nothing.

**Why not (d) — no visibility at all.** Loses the social-norm benefit entirely. Coerced authorship is still the threat — a rep coerced to *fabricate* a reprisal entry against another worker (F-17 analogue for reprisal_log: a co-opted rep submits a fake reprisal claiming a fictitious source to surface internal data) becomes harder to detect. The feed-with-author-hidden gives the committee a signal that "reprisal activity is happening" without revealing who is reporting what.

**Why (c) and not (a) + consent.** Even with explicit consent at intake, consent under Principle 4.3.6 (sensitivity-appropriate) for C4 disclosure to ~12 people is a high bar. Reducing the disclosure first (Principle 4.4 / 4.5 minimization) and then layering consent is the PIPEDA-defensible order.

### 2.4 Draft consent-surface copy (Surface C — the reprisal-entry intake form)

This goes in `i18n/en-CA/reprisal-intake.json` (or the architect's chosen surface key) and is reviewed by the labour lawyer per plan §13 item C. **Do not ship without the labour lawyer's sign-off.**

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

**AODA flag (not reviewed here):** the consent surface is a public-facing accessibility-statement-adjacent piece and must be reviewed by the accessibility-specialist before T13 ships. WCAG 2.0 AA at minimum; the "before you log" copy must be reachable by screen reader and operable one-handed (plan §9).

---

## 3. Q2 — Audit-log retention at 24 months

### 3.1 Finding

**24 months as a uniform retention is defensible at the PIPEDA Principle 4.5 floor, but is suboptimal — and incoherent with the underlying records' retention.** Recommend a per-event-type retention schedule.

**Regime + principles cited:**
- **PIPEDA Principle 4.5 (Limiting Use, Disclosure, Retention) — 4.5.2, 4.5.3** — retain "only as long as necessary for the fulfilment of those purposes." A uniform 24-month posture treats `auth.passkey.enrolled` (low-sensitivity, short-purpose) the same as `committee_data_key.member_revoked` (high-value forensic anchor, longer-purpose). Both are technically defensible but neither is *minimized*.
- **PIPEDA s.10.1** — "Keep breach records for 24 months regardless of severity." This is the *floor* for breach-related records, not a ceiling for audit logs in general, and it does not require all audit content to live 24 months.
- **OHSA s.50 + Ontario Labour Relations Board** — reprisal complaints to the OLRB are governed by a limitation that for practical purposes runs roughly to the duration of the employment relationship plus the limitation period for related civil claims. The plan §8 schedule already lands the underlying `reprisal_log.body_ciphertext` at "Active matter + 7 years"; the audit-log row for `reprisal.created` should not age out *before* the underlying record.
- **PIPEDA Principle 4.9 (Individual Access)** — a user has the right to know what was done with their data. If the underlying record is still in the system and the user requests access, the audit-of-access trail for that record should still be queryable. A 24-month audit-log aging out under a 7-year record creates a window where "what was done with this data?" can no longer be answered.

### 3.2 Does the audit-log row need to outlive the underlying record?

Generally **no** — once the underlying record is hard-deleted (real delete per `constraints.md` "Data lifecycle"), the audit-log row's `target_id` points to nothing and the row's evidentiary value collapses to "an event of class X happened at time T to a now-deleted target." Forensic value is low.

However, retention-pass auditing per F-52 (one summary `retention.deleted` row per pass) is independently load-bearing — the architect already correctly captures that. The retention-pass summary should outlive the underlying records by a margin so a post-deletion audit can confirm the deletion happened on schedule.

### 3.3 Recommendation: per-event-type retention

The justification is per-row Principle 4.5: each event type has a distinct purpose; the retention floor for each is the longest legitimate purpose for *that* event type.

Below is a proposed schedule covering every event type in `observability/audit-log.md` §1. The architect should fold this into an ADR-0003 Amendment C (or a new ADR-0015 "Audit-log per-event retention schedule") and ratify with the user under HG-9 (retention schedule final approval).

| Event type | Recommended retention | PIPEDA 4.5 justification |
|---|---|---|
| `identity_keypair.created` | **7 years** (membership + 7y) | Co-anchored to forensic identity attribution. If a reprisal entry is challenged in OLRB years later, the question "did this user even hold an identity key at the time?" must be answerable for the lifetime of the C4 records they could have authored. |
| `identity_privkey.recovery_blob.written` | **Membership + 24 months** | F-08 brute-force anchor; supports access-by-user investigation. Aligns with the recovery blob's own retention. |
| `identity_privkey.recovery_blob.restored` | **Membership + 24 months** | Same as above; restoration is a candidate-coercion signal (T6, T11) but loses forensic value once membership ends. |
| `committee_data_key.wrapped_for_member` | **7 years from rotation** | Key-history forensic anchor. If a removed-member-decrypted-old-data incident surfaces (F-06 / O-2), the wrap-history must be reconstructable for at least the active-matter + civil-limitation period. |
| `committee_data_key.unwrap` | **24 months** | Read-of-own-wrap; high-volume, low-target-individuating. 24 months is enough to spot misuse patterns. |
| `committee_data_key.rotation.started` / `.completed` | **7 years** | The rotation lifecycle is the load-bearing forward-secrecy event (Invariant 6); must outlive every record encrypted under the old key. Anchors crypto-shred-on-retention claims (ADR-0012 Amendment). |
| `committee_data_key.member_revoked` | **7 years** | Same as rotation; the revocation is a corner-stone forensic fact. |
| `auth.passkey.enrolled` / `.revoked` | **90 days** | Auth events are operationally useful for ~90 days for misuse investigation; longer retention does not serve the purpose. Lifting from 90d is a Principle 4.5 violation absent justification. |
| `session.revoked` | **90 days** | Same as above. |
| `concern.created` | **Match underlying concern record (7y post-closure)** | The concern is C3; the audit row for its creation should not outlive the concern. The reverse (audit gone, concern still present) breaks Principle 4.9. |
| `concern.source_revealed` | **Match underlying concern record (7y post-closure)** | C4-adjacent (the reveal of source is the event that surfaces C4). Same justification as `reprisal.read`. |
| `inspection.synced` / `inspection.synced.hmac_fail` | **Match underlying inspection (7y)** | Inspections are 7y per plan §8. |
| `queue.integrity_fail` | **Match underlying inspection (7y)** | Same. (Alias-cleanup per audit-log.md §6 finding #2 separate.) |
| `recommendation.created` / `recommendation.employer_response_logged` | **Match underlying recommendation (7y)** | Recommendations are 7y per plan §8. |
| `reprisal.created` | **Match underlying record (Active matter + 7y)** | C4. The audit-of-creation must outlive nothing if the entry is deleted; it must match the entry while it lives. Subject to Q1's pseudonymization. |
| `reprisal.read` | **Match underlying record (Active matter + 7y)** | Server-emitted under Amendment B; load-bearing for HG-6. Same as above. |
| `reprisal.status_changed.4eyes_pending` / `.4eyes_completed` | **Match underlying record (Active matter + 7y)** | These are the 4-eyes-on-soft-delete events; deleting them before the underlying record loses Principle 4.9 traceability. |
| `work_refusal.*` / `s51_evidence.*` (when T14 enumerates) | **Match underlying record (Active matter + 7y)** | C4; same justification. |
| `export.generated` | **7 years** | OHSA s.9(20) recommendations and s.9(21) minutes are 7y. The export is the only B3 egress; the audit of *that* must persist as long as the record being exported. |
| `export.contained_concern_derived_items` | **7 years** | RA-1 compensating control; same justification. |
| `retention.deleted` | **7 years** | Independently load-bearing — F-52 anchor. The retention summary must outlive the records it describes by enough margin to defend against "did the deletion actually happen?" challenges. 7y exceeds the longest underlying record retention. |
| `member.added` / `.removed` | **Membership + 7 years** | Membership history is an OHSA accountability anchor; outlives membership for the same reasons as `identity_keypair.created`. |
| `committee.key_rotated` | **7 years** | Same as `committee_data_key.rotation.completed`. |
| `client.cache_policy_violation` | **90 days** | Operational-defense event; SW policy regression detector. Forensic value decays fast. |
| `client.identity_selftest_fail` | **90 days** | F-03 detection signal; investigation-window-bound. |
| `alert.fired` | **24 months** | Matches the PIPEDA s.10.1 breach-record floor since alerts often precede or accompany breach analysis. |

### 3.4 What changes for the retention job (T16)

The single `WHERE ts < now() - interval '24 months'` filter in the DELETE GRANT (`observability/audit-log.md:230`) is replaced by an `event_type`-keyed retention function. The CHECK constraint on `event_type` already gates the closed enum; the retention function reads the schedule from a `audit_log_retention_schedule` table (version-controlled migration; one row per enum value with `retention_interval`). Drift between the schedule table and the enum is a CI assertion.

The retention pass continues to emit exactly one `retention.deleted` summary row per pass (F-52), with `meta.deleted_per_table.audit_log_per_event_type` becoming a jsonb of `{event_type: count}`.

### 3.5 Underlying record vs audit row — concrete rule

**Audit-log rows linked via `target_id` to a record in another table MUST NOT outlive the linked record by more than 30 days** (a small buffer for retention-job timing skew). When the retention job deletes the linked record, it queues the linked audit rows for next-pass deletion. This is a Principle 4.5 ceiling, not floor — and it is the architectural rule that resolves the question "does the audit row need to match the underlying record's retention?". The answer is yes, *as a ceiling*, with per-event-type floors as in the table above.

The retention-pass summary row (`retention.deleted`) is the exception: it has no `target_id` and is independently retained at 7y.

---

## 4. Cross-cutting observations (noted while reading; not blocking this review)

These are flagged for the architect's awareness; none requires action inside the scope of this review.

1. **The audit-log row schema (`observability/audit-log.md` §2) does not include a `retention_class` column** that the per-event retention job can index on. Adding it now is cheap; adding it after rows exist requires backfill. Recommend the architect add `retention_class text not null` with a CHECK referencing the schedule table, populated by the `audit_emit` SECURITY DEFINER function at write time.

2. **Forensic-read-of-pseudonymized-audit row procedure is not documented anywhere.** Q1's recommendation creates a new "I need to know who logged this reprisal" forensic surface. The architect should add a `pending_forensic_reveals` table mirroring `pending_destructive_ops` (two distinct approvers; co-chair + one certified or co-chair + co-chair if dual co-chair). This becomes a new audit event `audit.forensic_reveal.4eyes_*` with 7-year retention.

3. **`actor_pseudonym` reversibility relies on `HMAC_PSEUDONYM_KEY` (`observability/README.md` §2).** Loss of the key destroys forensic reversibility for all rows ever. Recommend the architect amend ADR-0012 to escrow `HMAC_PSEUDONYM_KEY` alongside the backup-encryption key (paper + 1Password), and document key-rotation policy: rotating the HMAC key creates a new pseudonym era and the old era's rows become un-correlatable to the new era's. This may be desirable (privacy enhancement) or undesirable (forensic continuity loss); architect must decide.

4. **`observability/README.md` §1 table claims "24 months (per `.context/constraints.md` 'Audit logs retained at least 1 year'; we lift to 24 to match PIPEDA breach-record minimum)".** The conflation of two unrelated minima is a small logic error. PIPEDA s.10.1's 24-month floor is for **breach records**, not audit logs in general. Constraints.md "at least 1 year" is the audit-log floor. The architect's choice of 24 months happens to be defensible per §3 above for `alert.fired` and similar events, but the *reasoning* in README.md should be corrected to "matched to the breach-record retention because audit log feeds the breach-response process, not because PIPEDA s.10.1 requires 24mo for audit logs."

5. **Default list payload for `audit_log` SELECT to active members (RLS at `observability/audit-log.md:244-249`) is not specified.** This is the same shape as F-18 (default list payload for `/api/concerns`). Recommend the architect mirror F-18: the default `audit_log` list payload for `reprisal.*` events comes from the pseudonymized view, never the raw table — even when querying for one's own activity.

---

## 5. What the architect should fold in

Pointer-by-pointer for an architect amendment pass:

1. **ADR-0003 Amendment B (HG-6)** — extend the SECURITY DEFINER view pattern to write-event projection. New named amendment, e.g., **Amendment C: Pseudonymized reprisal-feed projection (HG-11)**.
   - Add `reprisal_audit_feed_pseudonymized` view alongside `reprisal_log_read_audited`.
   - GRANT SELECT to `authenticated`; REVOKE from raw `audit_log` SELECT for rows where `event_type LIKE 'reprisal.%' OR event_type LIKE 'work_refusal.%' OR event_type LIKE 's51_evidence.%'`.
   - Add `forensic_read_service` role and the 4-eyes-reveal procedure.

2. **ADR-0007 (Concern intake)** — extend the consent surface for `reprisal_log` intake to match the draft copy in §2.4. ADR-0007 currently covers `concerns` only; the architect should either extend ADR-0007's scope (preferred, since reprisal_log is procedurally an extension of concern intake) or add a new ADR-0016 "Reprisal-log intake consent surface."

3. **Plan §8 retention table** — supersede the "Audit log | 24 months" row with a pointer to the per-event-type schedule. The retention table in plan §8 becomes the high-level summary; the per-event table from §3.3 becomes the authoritative schedule under a new ADR (recommend ADR-0015).

4. **ADR-0012 (Backups)** — add a note that the per-event-type audit-log retention schedule is part of the crypto-shred-on-retention story: backups older than the longest audit-log event retention can be hard-deleted without leaving "events we cannot explain."

5. **`observability/audit-log.md` §3 (Where it writes)** — replace the single 24-month DELETE filter with a per-event-type retention function reference; update §6 Findings to mark finding #4 as resolved by this review.

6. **`observability/README.md` §10 finding #2** — mark as resolved by this review and update §1 table per cross-cutting observation #4.

7. **HG-9 (retention schedule final approval)** — user explicitly ratifies the per-event-type schedule before T16 ships.

---

## 6. Verdict per question

- **Q1 (reprisal.created visibility):** **APPROVED-WITH-CHANGES.** Block T13 until: (a) the architect adopts Option (c) author-pseudonymized projection with time-bucketed timestamps via a new SECURITY DEFINER view; (b) the consent-surface copy in §2.4 is finalized and reviewed by the labour lawyer (HG-10) AND the accessibility-specialist (AODA); (c) ADR-0003 Amendment C (or equivalent) is ratified.
- **Q2 (24-month audit-log retention):** **APPROVED-WITH-CHANGES.** Block T16 retention-job implementation until: (a) the architect adopts the per-event-type retention schedule in §3.3; (b) the underlying-record-ceiling rule in §3.5 is encoded in the retention function; (c) HG-9 user ratification of the per-event table; (d) `observability/audit-log.md` §3 and `observability/README.md` §1 are updated to match.

Neither verdict is BLOCKED-PENDING-ARCHITECT-DECISION in the strong sense — both have clear forward paths — but Phase 2 implementation of T13 and T16 must not begin until the amendments land.

---

## 7. Handoff

**Next agent: test-writer.**

Test obligations the test-writer must add based on this review (these belong in the T13 and T16 test obligation lists in `threat-model.md` §8 — flag to the architect that the threat model needs the entries):

For T13 (reprisal log) — Q1 obligations:
1. **Pseudonymized feed projection.** SELECT from `reprisal_audit_feed_pseudonymized` as an active member. Assert the returned columns contain `{target_id, event_type, ts_bucketed, target_class}` and do NOT contain `actor_pseudonym`.
2. **Direct-audit-log bypass for reprisal events.** As an active member, attempt `SELECT actor_pseudonym FROM audit_log WHERE event_type LIKE 'reprisal.%'`. Assert RLS or GRANT-revoke returns zero rows for the `actor_pseudonym` column (the architect's choice between column-level GRANT-revoke vs view-only access determines the exact assertion shape; test both paths).
3. **Time bucketing.** Emit a `reprisal.created` row at a specific microsecond. SELECT from the feed view; assert the returned `ts` is rounded to the hour and that the underlying `audit_log.ts` retains the original microsecond.
4. **Forensic-reveal 4-eyes.** Propose a `audit.forensic_reveal` for a specific `reprisal.created` row; same proposer attempts to approve; assert RLS denies. Different active member approves; assert the reveal succeeds and TWO new audit rows (`audit.forensic_reveal.4eyes_pending` and `audit.forensic_reveal.4eyes_completed`) are hash-chained.
5. **Consent surface presence.** Snapshot test that the reprisal-intake form renders the §2.4 copy (i18n key resolves and contains the four "what other members will / will NOT see" bullets) before the "Save entry" button is enabled.
6. **Coverage of write-events.** Repeat tests 1–3 for `work_refusal.*` and `s51_evidence.*` write events once T14 enumerates them.

For T16 (retention job) — Q2 obligations:
7. **Per-event retention schedule honored.** Fixture: insert audit rows of every enum value with `ts` at 89 days, 91 days, 23 months, 25 months, 6 years 11 months, 7 years 1 month. Run retention pass in dry-run; assert the deletion set matches the §3.3 schedule exactly. Run live; assert the same.
8. **Audit-row-cannot-outlive-target rule.** Fixture: a `concern.created` audit row with `target_id = X`; the underlying concern row X is hard-deleted by an earlier retention pass. Run the next retention pass; assert the orphaned audit row is queued for deletion within 30 days of the concern's deletion.
9. **Retention-pass summary row retention.** Fixture: a `retention.deleted` row from 6 years ago. Run retention pass; assert the summary row is NOT deleted (7-year retention).
10. **Schedule table / enum drift.** CI assertion: every value in the `event_type` CHECK constraint has exactly one row in `audit_log_retention_schedule`, and every row in the schedule table references a value in the enum. Drift fails CI.
11. **`retention.deleted` per-event-type counts.** Run a retention pass that deletes rows of three different event types; assert the emitted `retention.deleted` row's `meta.deleted_per_table.audit_log_per_event_type` jsonb correctly enumerates the counts per event type.

Test-writer should treat tests 1–4 and 7–8 as the highest-priority new obligations; they directly back the §6 verdicts. Tests 5, 9–11 are second-tier (CI hygiene + schema drift).

The test-writer should also flag back to the architect any ambiguity in the projection's column shape (test 1) — if the architect's amendment chooses column-level GRANT-revoke instead of a view, the test assertions invert.

---

**Relevant absolute file paths reviewed for this review:**
- `/home/user/agent-os/.context/constraints.md`
- `/home/user/agent-os/.context/decisions.md`
- `/home/user/agent-os/.context/threat-model.md`
- `/home/user/agent-os/observability/audit-log.md`
- `/home/user/agent-os/observability/README.md`
- `/home/user/agent-os/JHSC-APP-PLAN.md`

Handoff: test-writer (with new test obligations 1–11 above; flag to the architect that `.context/threat-model.md` §8 T13 and T16 lists need the corresponding bullets, and HG-11 + HG-12 should be added to §9 covering Q1 (pseudonymized projection + consent) and Q2 (per-event retention schedule) respectively).
