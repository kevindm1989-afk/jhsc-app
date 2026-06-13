# `A-RETENTION-001` — retention sweep over-delete alarm

**Audience:** the on-call operator. The retention sweep aborted (or completed with operator confirmation) because the over-delete threshold (F-57) fired.

**Authority:** ADR-0017 §"F-57 over-delete alarm"; threat-model §3.9 F-57; `apps/web/src/lib/retention/retention-core.ts` (where `alarm_fired: true` originates); `apps/web/src/lib/alerts/result-adapters.ts` (where the symbol is dispatched).

**Severity:** **page**. The sweep is the load-bearing PIPEDA Principle 4.5 enforcement; an over-delete that landed undetected would silently destroy retained PI.

**Pager source:** structured-log line `event: 'alert.fired'` with `alert.symbol: 'A-RETENTION-001'`.

---

## §1. What this means

The library counted `> alarm_threshold` candidate rows on at least one arm of the sweep. Default threshold is `20` (F-57). Two shapes fire this alert:

| Result | Meaning | Side effect |
|---|---|---|
| `status: 'aborted_over_delete_threshold'` | Library refused to delete; sweep is a no-op. | Zero rows deleted; checkpoint NOT written. |
| `status: 'completed' \| 'capped'` with `alarm_fired: true` | Operator pre-confirmed via `confirmOverDeleteThreshold: true`; sweep ran. | Rows deleted; checkpoint written. |

Either shape ends up here.

---

## §2. Diagnose

1. **Grab the run_id** from the alert's `alert.run_id` attribute.
2. **Read the checkpoint** (only present for the `completed`/`capped` case):
   ```sql
   SELECT * FROM public.retention_sweep_runs WHERE run_id = '<run_id>';
   ```
3. **Read the `retention.deleted` audit row** for that run:
   ```sql
   SELECT meta FROM public.audit_log
    WHERE event_type = 'retention.deleted'
      AND meta->>'run_id' = '<run_id>';
   ```
4. **Inspect `per_event_counts` and `per_table_counts`.** A spike on a single arm usually means the schedule mutated between passes (new event type aged out a backlog) or a backfill landed.
5. **Compare `schedule_hash` against the previous pass's:** drift here means the schedule changed between passes — log the drift.

---

## §3. Respond

- **Schedule drift is the expected cause.** If §2.5 confirms the schedule changed, this is a one-shot over-delete; once the backlog clears, the next pass returns to normal counts. Confirm the schedule change in the relevant ADR amendment, record acceptance in the on-call log, and **do nothing else** — the sweep already either aborted (safe) or ran with operator confirmation (intended).
- **Unexpected backfill.** If §2.4 shows a spike on an arm with no schedule change, find the producer (which library wrote the unusual volume of rows under that `retention_class`). Likely T-* migration backfill. Confirm intentional; if not, page the producing team.
- **Truly unexplained.** Treat as a possible data-corruption incident. Do NOT re-run the sweep. Page the on-call SRE + the data-platform lead. Snapshot `retention_sweep_runs` + the last 24h of `retention.deleted` rows before any further investigation.

---

## §4. Escalate

- PIPEDA Principle 4.5 ambiguity → privacy-reviewer.
- Suspected corruption (§3 last bullet) → SRE on-call + data-platform lead.
- If the abort recurs three nights in a row without a schedule-change explanation, **stop the cron job** (`SELECT cron.unschedule(...)`) and page the architect.

---

## §5. Post-mortem trigger

Any case that reaches §4 last bullet OR involved a real over-delete. Capture `run_id`, the two adjacent `retention_sweep_runs` rows, the `retention.deleted` audit row, and a one-paragraph timeline.

---

## §6. Known false positives

None known at time of writing (M9). Threshold is set conservatively (20). If false positives recur, the architect adjusts the threshold via ADR amendment — operators **do not** raise it ad-hoc.
