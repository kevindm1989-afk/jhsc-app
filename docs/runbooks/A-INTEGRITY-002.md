# `A-INTEGRITY-002` — unattributable reconciliation count

**Audience:** the on-call operator. The integrity-check pass produced at least one mismatch the runner could NOT attribute to a known retention sweep.

**Authority:** ADR-0019 §3 (T18 attribution semantics); `apps/web/src/lib/audit-integrity/integrity-core.ts` (where `would_fire_alert: 'A-INTEGRITY-002'` is appended); `apps/web/src/lib/alerts/result-adapters.ts` (dispatch).

**Severity:** **warn**, not page. Unattributable divergence is a real signal but it doesn't always mean tamper — it can mean the attribution code didn't find the explaining sweep. A `warn` gives the operator a work-day window to investigate without waking anyone up.

**Pager source:** structured-log line `event: 'alert.fired'` with `alert.symbol: 'A-INTEGRITY-002'`.

---

## §1. What this means

The pass's reconcile join (live audit head ↔ latest committed backup manifest) found a divergence. The runner tried to attribute the divergence to a `retention_sweep_runs` row that completed in the window between the manifest's snapshot and now. **It failed to find a sweep.**

This is structurally different from `A-AUDIT-001`:

- `A-AUDIT-001` fires on ANY mismatch (chain-walk OR backup-diff), regardless of attribution.
- `A-INTEGRITY-002` fires ONLY when at least one mismatch was unattributable.

**Both can fire on the same run.** If both fired, work `A-AUDIT-001` first — it's the tamper-signal anchor. `A-INTEGRITY-002` becomes a secondary diagnostic input.

---

## §2. Diagnose

1. **Grab `alert.run_id`** from the alert meta.
2. **Read the run row:**
   ```sql
   SELECT run_id, mismatches_count, attributable_count, unattributable_count, backup_diff_performed
     FROM public.integrity_check_runs
    WHERE run_id = '<run_id>';
   ```
   `unattributable_count > 0` is what fired this alert.
3. **Read the unattributable mismatches:**
   ```sql
   SELECT meta FROM public.audit_log
    WHERE event_type = 'audit.integrity_check.mismatch'
      AND meta->>'run_id' = '<run_id>'
      AND (meta->>'attributable')::boolean = false;
   ```
4. **For each unattributable mismatch, sanity-check whether attribution SHOULD have worked.** The current runner does a coarse "any sweep run in the window" attribution (single-row probe). If multiple sweeps happened OR a sweep deleted rows the runner didn't expect, the coarse probe will mis-attribute.
5. **Compare the manifest's snapshot timestamp against the run's `started_at_ms`:**
   ```sql
   SELECT m.run_id, m.committed_at_ms,
          m.retention_sweep_runs_snapshot_ts_ms
     FROM public.backup_manifests m
    WHERE m.run_id = (
      SELECT (meta->>'manifest_run_id')::uuid  -- if the meta carries it
        FROM public.audit_log
       WHERE event_type = 'audit.integrity_check.ran'
         AND meta->>'run_id' = '<run_id>'
    );
   ```

---

## §3. Respond

- **Single unattributable, low count:** likely a real retention sweep the coarse probe didn't match. List all sweeps between the manifest's snapshot and now:
  ```sql
  SELECT run_id, started_at_ms, completed_at_ms, per_event_counts
    FROM public.retention_sweep_runs
   WHERE started_at_ms > (
     SELECT retention_sweep_runs_snapshot_ts_ms FROM public.backup_manifests
      WHERE run_id = '<manifest_run_id>'
   )
   ORDER BY started_at_ms;
  ```
  If one of these explains the gap (matching event_type + sufficient delete count), record the attribution by hand in the on-call log; the alert can be acknowledged.
- **High unattributable count OR no plausible sweep in the window:** escalate — the divergence is real and unexplained. Treat as `A-AUDIT-001`-class for response purposes (snapshot first, then page SRE + privacy-reviewer).
- **Recurring unattributable count for the same `audit_log_id` across multiple passes:** the runner's attribution logic may have a bug. File against the audit-integrity library; do NOT silence the alert.

---

## §4. Escalate

- High unattributable count / no plausible sweep → SRE on-call + privacy-reviewer (same response as `A-AUDIT-001`).
- Recurring same-row unattributable → architect (the attribution algorithm may need a re-pass).

---

## §5. Post-mortem trigger

ANY case escalated to §4. Not required for routine attribution-by-hand cases unless they recur > weekly.

---

## §6. Known false positives

- **Coarse attribution probe.** The current runner's `integrity_check_list_sweep_runs_through(now, 1)` only checks for ANY sweep in the window; a sweep that didn't delete the specific row in question will still be reported as the attribution. The prev_hash chain landing (future work) replaces this with a per-row attribution.
- **Backup snapshot ms-skew.** If a retention sweep ran in the exact ms-window between manifest write and commit, the snapshot_ts_ms field can disagree by 1ms. Not actionable; tolerate.
