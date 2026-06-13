# `A-INTEGRITY-001` — no successful integrity-check pass in the watchdog window

**Audience:** the on-call operator. The watchdog probe ran and could NOT find a successful integrity-check pass (`status = 'ok'`) within the configured window.

**Authority:** ADR-0019 §3 (T18 integrity-check schedule pin: scheduled daily 04:30 ET); `apps/web/src/lib/audit-integrity/watchdog.ts` (where the symbol is dispatched); `apps/web/src/lib/alerts/result-adapters.ts` references the closed AlertSymbol union.

**Severity:** **page**. The watchdog is the only signal that the integrity-check pipeline is RUNNING. Silence here means we have no proof of audit-log integrity for an extended period — the absence of evidence becomes a finding in itself for PIPEDA Safeguards.

**Pager source:** structured-log line `event: 'alert.fired'` with `alert.symbol: 'A-INTEGRITY-001'`.

---

## §1. What this means

The watchdog (Edge Function or pg_cron probe — see `apps/web/src/lib/audit-integrity/watchdog.ts`) ran and queried `integrity_check_runs` for the most recent row where `status = 'ok'`. The most-recent-ok was older than the configured watchdog window (default **2× the integrity-check cadence**; 9h for the 4:30 ET daily schedule).

Three causes account for ~all real cases:

| Cause | Signal | Action |
|---|---|---|
| pg_cron didn't fire | No row in `integrity_check_runs` with `started_at_ms` in the expected window. | Check pg_cron schedule + job_run_details. |
| Pass started but didn't complete | Latest row has `status = 'running'` for >> the lease window. | Look at the runner's exit reason; check for crashed Edge Function. |
| Pass completed but with non-`ok` status | Latest row is `mismatch_found` / `aborted` / `timed_out`. | A-AUDIT-001 should also have fired — diagnose that first. |

---

## §2. Diagnose

1. **Find the most recent run:**
   ```sql
   SELECT run_id, trigger, started_at_ms, completed_at_ms, status,
          (extract(epoch from now()) * 1000)::bigint - started_at_ms AS age_ms
     FROM public.integrity_check_runs
    ORDER BY started_at_ms DESC
    LIMIT 5;
   ```
2. **Check pg_cron** (requires the cron extension; production only):
   ```sql
   SELECT * FROM cron.job WHERE jobname LIKE '%integrity%';
   SELECT * FROM cron.job_run_details
    WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname LIKE '%integrity%')
    ORDER BY start_time DESC LIMIT 5;
   ```
3. **Cross-check the watchdog itself.** The watchdog's own most-recent run is logged at `event: 'integrity.watchdog.ran'`. If the watchdog isn't running, A-INTEGRITY-001 can't fire — but its silence is a different signal (a separate probe should watch the watchdog).

---

## §3. Respond

- **pg_cron didn't fire (§1 row 1):** check the production Postgres logs for cron extension errors. If pg_cron was recently disabled/restarted, re-enable it. Manually kick the integrity pass once:
  ```sql
  SELECT public.integrity_check_runner('scheduled',
    (extract(epoch from now()) * 1000)::bigint, 60000, 'manual-kick', 'manual');
  ```
  Then confirm an `audit.integrity_check.ran` row appears.
- **Pass stuck in `running` (§1 row 2):** likely the runner crashed mid-pass. The xact-advisory lock auto-released when the txn aborted, so the next pass CAN run. Manually kick (as above). If the manual kick also gets stuck, escalate.
- **Pass with non-`ok` status (§1 row 3):** A-AUDIT-001 should have fired alongside. Go work that runbook first; A-INTEGRITY-001 here is a secondary signal.

---

## §4. Escalate

- Pg_cron is down for > 1 hour → SRE on-call + Supabase support.
- Manual kick also hangs → architect (the runner's advisory-lock or timeout settings may be wrong for production traffic shape).
- The watchdog itself is silent → the watchdog watchdog (one level up) should have caught it. Page SRE if both are silent.

---

## §5. Post-mortem trigger

Any case where pg_cron was offline for > 24h OR a manual kick was required > twice in one week. Captures: integrity_check_runs timeline, pg_cron job_run_details, the watchdog's own log, and the operator action timeline.

---

## §6. Known false positives

- **Deploy windows.** A long deploy that disables pg_cron temporarily can produce a transient watchdog warning. The deploy runbook should suppress this alert for the deploy window's duration; if it doesn't, file a deploy-runbook bug.
