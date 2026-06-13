# `A-AUDIT-001` — audit-log integrity mismatch detected

**Audience:** the on-call operator. The integrity-check pass found at least one mismatch (chain-walk OR backup-diff). This is the **load-bearing forensic invariant** for the whole app — treat it as a possible tamper signal until proven otherwise.

**Authority:** ADR-0019 §3 (T18 integrity-check library + alert symbol); threat-model §3.13 F-93/F-94 (audit chain + manifest reconcile); `apps/web/src/lib/audit-integrity/integrity-core.ts` (where `would_fire_alert: 'A-AUDIT-001'` is appended); `apps/web/src/lib/alerts/result-adapters.ts` (dispatch).

**Severity:** **page**. Audit-log integrity is the bottom-layer trust anchor — if it drifts, every downstream control (4-eyes, forensic reveal, retention proof) loses its audit-trail backing.

**Pager source:** structured-log line `event: 'alert.fired'` with `alert.symbol: 'A-AUDIT-001'`.

---

## §1. What this means

The integrity pass found a divergence in one of:

- **Chain walk** (when the prev_hash chain lands): the running hash for a row did not match the stored hash.
- **Backup diff (RA-2 reconcile)**: the live audit-chain head and the latest committed backup manifest's head pointer disagree in a way the library could NOT attribute to a retention sweep.

The library emitted `audit.integrity_check.ran` + one `audit.integrity_check.mismatch` row per mismatch BEFORE firing this alert. The audit row IS the durable record — it survives even if the runner crashes.

**A real mismatch is rare and serious. Assume tamper until §2 says otherwise.**

---

## §2. Diagnose

1. **Grab `alert.run_id`** from the alert meta.
2. **Read the run row:**
   ```sql
   SELECT * FROM public.integrity_check_runs WHERE run_id = '<run_id>';
   ```
   Note: `mismatches_count`, `attributable_count`, `unattributable_count`, `backup_diff_performed`.
3. **Read the per-mismatch detail rows:**
   ```sql
   SELECT meta FROM public.audit_log
    WHERE event_type = 'audit.integrity_check.mismatch'
      AND meta->>'run_id' = '<run_id>'
    ORDER BY id;
   ```
4. **Classify each by `mismatch_kind`:**

   | Kind | What it means | First action |
   |---|---|---|
   | `hash_mismatch` | Stored hash disagrees with computed hash for that row. | **Probable tamper.** Capture the `audit_log_id` for forensics. |
   | `row_missing` | Live head_id > manifest head_id but no retention_sweep_run explains the gap. | Could be a delayed sweep OR row-level delete outside the sweep. |
   | `row_unexpected` | Manifest head_id > live head_id (manifest points past live chain). | Live chain was truncated. Almost always tamper. |
   | `head_pointer_drift` | head_ids match, hashes diverge. | Manifest snapshot diverged from live — possible replay or restore-then-mutate. |

5. **For `row_missing` only**: check if `attributable: true` is present. The runner attempts attribution; an attributable row_missing usually IS a normal retention sweep that the runner caught after-the-fact.

---

## §3. Respond

- **`hash_mismatch` OR `row_unexpected`:** treat as tamper. Do NOT delete the affected rows. Do NOT re-run the integrity pass to "see if it clears". Snapshot `audit_log` + `integrity_check_runs` + `backup_manifests` (immutable copy to a forensic bucket). Page the SRE on-call AND the privacy-reviewer simultaneously.
- **`row_missing` with `attributable: true`:** the runner found a retention sweep that explains the gap. Log the attribution; the alert can be acknowledged. Confirm the sweep run row exists:
  ```sql
  SELECT * FROM public.retention_sweep_runs WHERE run_id = '<attribution_run_id>';
  ```
- **`row_missing` with `attributable: false`:** treat as tamper-suspicious. Same response as `hash_mismatch`.
- **`head_pointer_drift`:** snapshot first, then compare the live head's hash against the most recent backup. If the backup matches but live diverges, the live chain was tampered post-backup. If both backup and live diverge from older backups, the tamper happened before the most recent backup.

---

## §4. Escalate

- Any tamper-class mismatch (§3 first / third / fourth bullets) → SRE on-call + privacy-reviewer + architect. This is the trigger for the PIPEDA s.10.1 breach-notification timer.
- Repeat `hash_mismatch` across two passes on the same `audit_log_id` → freeze the table (`REVOKE INSERT, UPDATE, DELETE ON public.audit_log FROM ALL ROLES EXCEPT audit_writer_role`) until forensics complete.

---

## §5. Post-mortem trigger

ANY tamper-class mismatch (§3 first/third/fourth). Mandatory. Capture: the `run_id`, every mismatch row meta, the affected `audit_log_id`s, the matched `backup_manifests` row, and a forensic timeline. Privacy-reviewer drives the post-mortem because §10.1 breach reporting may be in play.

---

## §6. Known false positives

None known. The runner is conservative — it only emits mismatch when the comparison is unambiguous (see `integrity_check_runner` source comments). A false positive would itself be a finding.
