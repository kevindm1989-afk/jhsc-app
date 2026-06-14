# Lessons

Things we learned the hard way. Read this before starting anything risky.

Append newest on top. Be specific — vague lessons don't prevent anything.

---

## Format

```
## YYYY-MM-DD — One-line summary

**Symptom:** what we noticed.
**Root cause:** what was actually wrong (not just the surface bug).
**Fix:** what we did.
**Prevention:** the rule we'll follow next time to avoid this class of issue.
```

---

## Entries

## 2026-06-14 — Skip HG-10 / external-blocker items in cleanup batches

**Symptom:** during fast cleanup sweeps, the natural temptation is to mark every "still open" gap as closeable. Items blocked on external review (labour-lawyer HG-10 ratification of consent copy, privacy-lawyer DPA review, external pen-test findings) get attempted and either stall or get reverted.

**Root cause:** HG-10-class gaps are blocked on out-of-band human review, not on code. No structural closure is possible until the external review happens.

**Fix:** in PRs #239 and #246 these were explicitly skipped with a one-line "external blocker: HG-10" note in the PR body (G-T13-13, G-T08-11). The remaining cleanup batch proceeded cleanly.

**Prevention:** in any cleanup sweep, first filter the gap list for items whose `**Blocker for:**` line names HG-10 (or any other external gate); skip those and note them explicitly in the PR body rather than attempting structural closure.

## 2026-06-14 — Batched A→E tidying cadence for max throughput

**Symptom:** large doc/code cleanup backlog stalls when bundled into one PR (the user has to review a single sprawling diff). Trying to do everything in one shot wastes the orchestrator's context and produces ungrokable diffs.

**Root cause:** PR reviewability is a hard constraint; one big PR is harder to triage than five small focused ones.

**Fix:** during the M3 / M9 cleanup arc (PRs #229–#246), the orchestrator ran the user-requested "1 and 2", "all three", "all four", "1 and 4", and "A→B→C→D→E" patterns. Each lettered batch was an independent small PR that stayed green on `scripts/verify.sh` and merged on its own.

**Prevention:** when the user asks for max throughput on small cleanups, ship as a lettered sequence of small PRs, not one bundle. Each PR should be individually reviewable + revertable. The orchestrator schedules N PRs and the user merges them as they come in.

## 2026-06-14 — Verify the gap before scaffolding "missing" code

**Symptom:** I planned to scaffold the G-T13-1 SQL migration from scratch, treating the gap text as authoritative ("SQL migration deferred to T13.1"). The migration already existed at `supabase/migrations/00000000000005_reprisal.sql` (407 lines); writing it again would have wasted hours and created merge chaos.

**Root cause:** known-gaps entries describe the gap AT THE TIME OF FILING. They don't auto-close when the resolution lands. Treating the gap text as the current state, without verifying the file actually doesn't exist, leads to redundant work.

**Fix:** PR #246 pivoted from "write the migration" to "sweep the stale T13 status blocks" after a 3-second `ls supabase/migrations/00000000000005_*.sql` check. Eight gaps closed in one docs PR instead of one redundant migration.

**Prevention:** before scaffolding ANY artifact a gap entry says is missing, run a quick verify pass: `ls`/`find`/`grep` for the named file or symbol. If it exists, the work is a status-block sweep, not new code. The 30-second verify pays for itself many times over.
