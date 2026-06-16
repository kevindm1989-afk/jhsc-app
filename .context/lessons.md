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

## 2026-06-16 — ESLint flat-config `no-restricted-syntax`: two traps (last-match clobber + too-broad selector)

**Symptom:** (1) a newly-added `no-restricted-syntax` block scoped to two files did NOTHING — the rule never fired. (2) A first-cut selector `ObjectExpression > SpreadElement` (all object-literal spread) false-positived on a legitimate `...(cond ? { x } : {})` idiom.

**Root cause:** (1) ESLint flat config is last-match-wins PER RULE — when multiple config objects set the same rule for an overlapping `files` glob, the LAST one fully REPLACES the value (no array merge). An earlier broad block (`src/**/*.ts`, G-T17-8) clobbered the new narrower block back to its own selectors. (2) The selector matched a structural shape rather than the actual anti-pattern (spreading a bound source-object variable `{ ...row }`, the F-19 leak risk).

**Fix:** (1) move the narrower block AFTER the broad one and carry BOTH selectors so nothing is lost on the override. (2) narrow on the AST node's discriminating property — `ObjectExpression > SpreadElement[argument.type='Identifier']` bans `{ ...row }` while allowing inline-conditional + array spreads (PR #271, G-T11-9, `apps/web/eslint.config.js`).

**Prevention:** after adding/editing any array-valued flat-config rule, never trust that adding the block is sufficient — verify it fires with a synthetic probe (inject the banned syntax, run eslint, confirm the error, revert), and run the candidate selector against the WHOLE tree first to catch false-positives. Narrow on AST properties; do NOT carve per-file exceptions (they let real violations slip through new files).

## 2026-06-16 — A Postgres CHECK cannot contain a subquery; wrap the predicate in an IMMUTABLE function

**Symptom:** a CHECK using `(SELECT count(*) FROM jsonb_object_keys(...))` for an exactly-N-keys assertion failed at migration time with "cannot use subquery in check constraint".

**Root cause:** Postgres forbids subqueries inside CHECK constraints. Separately, adding a column CHECK retroactively invalidates every existing fixture that used a now-illegal stub value — and those stubs were spread across ~7 pgTAP files in more than one spelling (`'pin'` AND `'node@v20'`).

**Fix:** move the predicate into an `IMMUTABLE` SQL function and have the CHECK invoke it scalar-wise; sweep all fixtures to valid shapes (PR #255, G-T18-11). The first sweep missed the second stub spelling, costing two CI round-trips.

**Prevention:** for any non-trivial CHECK (counts, key-shape assertions) write it as an `IMMUTABLE` function call from the start. When adding a column CHECK to an existing table, grep ALL pgTAP/fixture files for EVERY spelling of the stub values the new constraint will reject, and fix them in one pass before pushing.

## 2026-06-16 — A failed third-party CI action (network fetch / install) on an unrelated PR is infra flake — re-run, don't "fix"

**Symptom:** CI failed on a docs-only PR because `supabase/setup-cli@v1` returned a Gateway Timeout fetching the latest CLI release. All other gates were green.

**Root cause:** a transient upstream infra failure in an action's release-fetch step, unrelated to the diff — a docs-only PR cannot break the Supabase CLI download.

**Fix:** recognized it as non-code (other gates green; error is in an action's network fetch) and re-ran the job rather than attempting a code change (PR #260).

**Prevention:** before "fixing" a CI failure, read WHICH gate failed and WHERE. If it's a third-party action's network fetch / install (timeout, 5xx, rate-limit) and the change can't plausibly cause it — especially docs-only PRs — re-run first; only treat it as real if it reproduces. (Single occurrence; kept as a generalizable autonomous-CI-watching rule.)

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
