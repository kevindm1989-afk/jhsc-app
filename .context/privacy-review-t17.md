# Privacy Review T17 — Backup Object-Lock Library + MemoryBackupStore

**Status: PASS-WITH-ADVISORIES** (library-only per ADR-0002 Amendment H). PIPEDA Principle 4.5 (Limiting Retention) is **structurally enforced for the backup posture** for the first time — two-layer hard-delete (explicit `runBackupRetentionPass` + T17.1 lifecycle backstop). PIPEDA Principle 4.7 (Safeguards) holds via the `committee_data_key` wrap chain (ADR-0007) + object-lock cooperative-caller defense (F-71). Closes library halves of G-T16-8 (T18 data source), G-T16-PRIV-7 (manifest pseudonym-free), G-T16-RECONCILE-CEILING (per-event attribution survives). Three BLOCKING-IN-T17.1 items + four advisories. **Zero BLOCKING-NOW.**

> Returned inline per the precedent at `.context/privacy-review-t16.md` / `.context/privacy-review-t11-t12.md`. Captured to this path by the orchestrator.

---

## HUMAN GATES

- **HG-15 does NOT fire** in T17 (library-only). **HG-15 re-fires at T17.1** for the new `backup_manifests` table + new `backups-ca-central-1` Supabase Storage bucket.
- **HG-10 does NOT fire** in T17 (zero user-facing copy). **CONCUR** from privacy-officer angle — PIPEDA 4.8 preserved through privacy-policy disclosure + `backup.manifest_written` audit-log row visibility.
- **HG-9 / retention-schedule** RATIFIED 2026-05-22; does NOT re-fire.
- **No cross-border transfer.** Library region-agnostic; `cross_region_destination_refused` structured rejection in the closed literal union (types.ts:127; backup-store.ts:26). T17.1 ratifies the `ca-central-1` bucket pin per ADR-0001 Hard Rule #4.
- **No new subprocessor.** ADR-0010 single-subprocessor posture preserved — no external KMS, no S3 vendor outside Supabase Storage, no third-party signer. `committee_data_key` (ADR-0007) inside Supabase Postgres trust boundary; `crypto.createHash('sha256')` + `randomUUID` are Node-native.

---

## PI touchpoints in diff

- `apps/web/src/lib/backup/types.ts:18-37` — `BackupTable` closed enum (19 entries).
- `apps/web/src/lib/backup/types.ts:43-47` — `BackupAuditLogHead` triple (id, ts_ms, hash) — structural anchor; `hash` is 64-char SHA-256 (chain hash, NOT pseudonym shape).
- `apps/web/src/lib/backup/types.ts:73-90` — `BackupManifest` schema. **NO field name matches `/pseudonym/i`** (F-80 structural seal).
- `apps/web/src/lib/backup/backup-core.ts:62-78` — `generateRunId()` rejection-samples for phone/pseudonym shape.
- `apps/web/src/lib/backup/backup-core.ts:86-92` — `deriveObjectRef`: structural `<prefix>/<YYYYMMDD>/<run_id>.dump`. **No pseudonym, no user_id, no concern_id in the path.**
- `apps/web/src/lib/backup/backup-core.ts:242-260` — `backup.manifest_written` audit row construction. `actor_pseudonym` AT TOP LEVEL ONLY; `meta` carries structural fields only — **no pseudonym duplication into meta** (F-79).
- `apps/web/src/lib/backup/memory-backup-store.ts:48` — `SYSTEM_ACTOR_ID = 'system:backup-pass'` (opaque id; HMAC-pseudonym derived in `systemActorPseudonym()` before any store-external surface).
- `apps/web/src/lib/backup/memory-backup-store.ts:199-201` — `systemActorPseudonym()` HMAC-SHA-256 first-32-hex (ADR-0016 lineage).

No log statements. No URL parameters. No PI in error messages. No telemetry.

---

## Q1-Q12 Verdicts

**Q1 — F-70 closed allowlist on BACKUP_TABLES:** APPROVED. 19 tables enumerated; all PI-bearing operational tables present (concerns, inspections, inspection_photos, minutes_final, recommendations, reprisal_log, work_refusal, s51_evidence, training_records); all 3 audit-integrity tables present (audit_log, retention_sweep_runs, audit_log_retention_schedule); identity/key family rows present. `runBackupTablesDriftCheck` is the structural seal. T17.1 deferred: cross-mirror SQL drift test.

**Q2 — F-79 / F-80 pseudonym hygiene:** APPROVED. Verified at backup-core.ts:242-260 — actor_pseudonym top-level only; `meta` does NOT contain `actor_pseudonym`. T17 implements correctly from day one — does NOT inherit T16's memory-store-only deviation. `BackupManifest` interface contains zero `/pseudonym/i` field names at any nesting level. `object_ref` derivation pseudonym-free.

**Q3 — F-83 RA-2 control #4 preservation (LOAD-BEARING):** APPROVED. Verified EXACT field names per ADR-0018 §7: `audit_log_head: BackupAuditLogHead | null`, `per_event_row_counts: Readonly<Record<string, number>>`, `retention_sweep_runs_snapshot_ts_ms: number`. Algorithm extracts head BEFORE dump; snapshot fields pinned to pending manifest verbatim. Without F-83, RA-2 trigger #3 fires unattributed → privacy-officer cannot distinguish legitimate sweep deletes from tamper deletes.

**Q4 — F-74 / F-75 hard-delete-at-age-out:** APPROVED. `deleteObjectIfUnlocked` does `this.objects.delete(object_ref)` — removes underlying ciphertext from Map. Not soft-delete; not tombstone. `hardDeleteManifestRow` flips status to `'hard_deleted'` but retains the metadata row — per ADR-0018 §7 the manifest is the audit anchor and carries no PI; PI (dump bytes) IS hard-deleted. **G-T17-PRIV-1 ADVISORY** for transparency. F-75: `still_locked` past 42d flips `would_fire_alert: 'A-BACKUP-001'` — operator signal for PIPEDA s.10.1 breach-window assessment. **G-T17-PRIV-2 BLOCKING-IN-T17.1**: alert sink wiring required.

**Q5 — F-73 encryption-key kid recording:** APPROVED. kid captured at step 2 BEFORE dump; locked at pass-start (mid-pass rotation does NOT change manifest kid). kid persisted on both manifest and audit row meta. Rotation between passes produces different kids on different manifests. **Crypto-shred argument structural** — library introduces no re-encrypt-on-rotation path; when `committee_key_wraps_history[kid]` ages out, backup becomes undecryptable. No re-wrap, no kid-substitution, no re-upload code path.

**Q6 — F-71 object-lock cooperative-caller defense:** APPROVED. `BACKUP_OBJECT_LOCK_DAYS = 42` library-controlled. `BackupPassConfig` omits `lock_duration_ms` (F-84 enforces via tsc). Store-side enforcement at memory-backup-store.ts:341. Refusal structural; cannot be bypassed via test mutators on production interface (F-85 verified). PIPEDA 4.7 — caller-controlled lock duration would allow compromised caller to create 1-day-locked backups enabling adversarial delete inside 42d retention window.

**Q7 — F-81 / F-82 no PII in errors + structured rejection:** APPROVED-WITH-ADVISORY. 6 closed literals; no template-string interpolation; `run_id` is the only variable, structurally non-PII. `putWithObjectLock` returning `{committed: false, reason}` ALWAYS results in `{status: 'errored'}`; never silent completion. **G-T17-PRIV-3 BLOCKING-IN-T17.1**: swallowed catches at backup-core.ts:169, 179, 217, 230-232, 284 degrade operator observability — mirrors G-T16-PRIV-3 disposition. PIPEDA 4.10.

**Q8 — F-84 no caller-supplied object_ref / table_list / lock_duration_ms:** APPROVED. Type-level enforcement via poisoned-config.ts:40-86 (3 `@ts-expect-error` + composite). Runtime arity check (`runBackupPass.length === 1`). Method-name forbidden-substring scan. Privacy-relevance: caller-supplied table_list could selectively skip PI tables; caller-supplied object_ref could leak PI into storage path; caller-supplied lock_duration_ms would weaken 42d immutability. All three structurally prevented.

**Q9 — Cross-border egress:** APPROVED. `cross_region_destination_refused` literal in upload-rejection union + manifest aborted status + error_code; mapped from rejection to error_code at backup-core.ts:107. Library region-agnostic; T17.1 ratifies bucket region pin. Constraints.md Hard Rule #4 invariant preserved.

**Q10 — ADR-0010 single-subprocessor posture:** APPROVED. Dependencies inspected — only `node:crypto` + internal lib. No `aws-sdk`, no `@google-cloud/*`, no third-party KMS/S3-compatible/signer/telemetry SDK. Encryption-at-rest anchored at `committee_data_key` (ADR-0007) inside Supabase Postgres trust boundary. Sentry remains the only non-Supabase subprocessor.

**Q11 — HG-10 trigger check:** CONCUR with threat-modeler. Zero user-facing components; zero notification surface; zero modal/consent/dialog copy. `actor_pseudonym = HMAC('system:backup-pass')` — user does not appear in row; their audit-trail visibility filter naturally excludes backup-pass rows. PIPEDA 4.8 preserved via policy layer (T17.1 ratifies copy) + operational layer (`audit_log` visibility). Per-pass user-facing notification not legally required.

**Q12 — T16 sweep dependency:** APPROVED. Imports inspected at backup-core.ts:34-55 — only `node:crypto` + internal lib. **No import from `../retention/`**. ADR-0018 §13 invariant preserved structurally. Only interaction surface is `retention_sweep_runs_snapshot_ts_ms` — backup pass OBSERVES sweep checkpoint without depending on completion. **G-T17-PRIV-4 ADVISORY**: T17 diff lacks a CI test pinning the no-coupling invariant; T17.1 must add.

---

## PIPEDA Principles compliance summary

| Principle | Status |
|---|---|
| 4.1 Accountability | ✓ (systemActorPseudonym named actor in audit chain) |
| 4.2 Identifying Purposes | ✓ (RA-2 compensating control #4 documented) |
| 4.3 Consent | N/A (system-initiated; user consented via privacy policy + HG-9) |
| 4.4 Limiting Collection | N/A |
| 4.5 Limiting Retention | ✓ **(first structural enforcer of backup retention surface)** |
| 4.6 Accuracy | N/A |
| 4.7 Safeguards | ~ (G-T17-PRIV-3 swallowed catches BLOCKING-IN-T17.1; otherwise PASS) |
| 4.8 Openness | ✓ (privacy-policy disclosure + audit-log row visibility) |
| 4.9 Individual Access | ✓ (absence + summary; user does not appear in backup-pass rows) |
| 4.10 Challenging Compliance | ~ (G-T17-PRIV-3 operator-side structured Error logging BLOCKING-IN-T17.1) |

---

## BLOCKING-NOW vs BLOCKING-IN-T17.1

**BLOCKING-NOW:** none.

**BLOCKING-IN-T17.1:**
1. **G-T17-PRIV-2** — `A-BACKUP-001` alert sink wiring (observability-setup) for PIPEDA s.10.1 breach-window.
2. **G-T17-PRIV-3** — server-side structured Error logging with PI scrubbing for the swallowed catches. Mirrors G-T16-PRIV-3.
3. **G-T17-PRIV-5** — HG-15 re-ratification for new physical table + bucket + role.
4. **G-T17-PRIV-6** — §PI inventory amendments + `training_records` PI class verification.

**Advisories (non-blocking):**
- **G-T17-PRIV-1** — `backup_manifests` row 7y vs blob 42d retention asymmetry documented (manifest is audit anchor; carries no PI).
- **G-T17-PRIV-4** — CI test `no-retention-on-backup-coupling.test.ts` to pin PIPEDA 4.5 enforcement independence.
- **G-T17-PRIV-7** — `xact_start()` over `Date.now()` for production SupabaseBackupStore lock arithmetic (G-T08-14 / G-T13-9 / G-T16-9 lineage).
- **G-T17-PRIV-8** — pgTAP column-name pin at T17.1 mirroring library F-83 snapshot pin.

---

## Carry-forwards (closed and new)

**Closed by T17 (library halves):**
- **G-T16-8** — T18 data source. ✓
- **G-T16-PRIV-7** — manifest no pseudonyms. ✓
- **G-T16-RECONCILE-CEILING** — per-event attribution preserved. ✓

**New G-T17-PRIV-* entries:** see BLOCKING-IN-T17.1 + Advisories above.

---

## RA-1 / RA-2 verdict

- **RA-1 control #5** (export.generated 7y): HOLDS unchanged (T17 does not touch export pipeline).
- **RA-2 compensating control #4** ("pg_dump backup is the secondary witness"): **STRENGTHENED.** Pre-T17 the witness was an opaque blob; T17 makes it a structured-manifest witness with the join surface T18 can read without loading the blob in the normal-case path.
- **RA-2 trigger #3** (live-chain vs pg_dump divergence): NOT re-opened.

Neither re-opens. Both strengthened or preserved.

---

## Handoff

- **Architect (T17.1):** fold G-T17-PRIV-3 into SupabaseBackupStore design; resolve G-T17-PRIV-7; ratify HG-15; complete §PI inventory amendments (G-T17-PRIV-6).
- **T17.1 implementer:** wire A-BACKUP-001 sink (G-T17-PRIV-2); pgTAP column-name pin (G-T17-PRIV-8); cross-mirror SQL drift test; restore runbook.
- **Privacy-reviewer (T17.1 PR):** re-run on SupabaseBackupStore + `backup_manifests` migration + bucket policy + §PI inventory amendments + HG-15 ratification.
- **Threat-modeler (T17.1 PR):** confirm none of the four §3.10 re-open triggers fired during T17.1 build.
- **Observability-setup (next pass after T17.1):** A-BACKUP-001/002/003 alert sinks.
- **T18 implementer (next pass):** integrity-job reconciliation join inheriting F-83 anchor fields.

---

## Overall T17 privacy verdict

**PASS-WITH-ADVISORIES.** Library-only per ADR-0002 Amendment H. PIPEDA Principle 4.5 structurally enforced for backup posture for the first time. RA-2 compensating control #4 STRENGTHENED. Zero BLOCKING-NOW. Four BLOCKING-IN-T17.1 + four advisories. HG-10 NOT firing defensible.
