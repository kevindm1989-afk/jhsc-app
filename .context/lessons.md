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

## 2026-06-18 — Vitest 4 does NOT retroactively capture setTimeouts scheduled before `vi.useFakeTimers()`

**Symptom:** `d6-panic-wipe.test.ts` flaked under every major-bump matrix this morning (I-batch + J1 attempts). The H3 investigation chased inter-file pollution exhaustively (per-file forks, isolate modes, bisection by directory) and found no single-file culprit. The flake persisted.

**Root cause:** the modal harness at `apps/web/test/_helpers/protected-modal-harness.ts` scheduled the ready-delay `setTimeout` against the real clock, THEN called `vi.useFakeTimers()`. Vitest 3 silently captured pre-existing timers retroactively; Vitest 4 does not — the timer stays on the real clock and fires by wall-time, making the spec race-y against any test setup that takes longer than `ready_delay_ms` (200ms baseline).

**Fix:** swap the order — `vi.useFakeTimers()` FIRST, then schedule the `setTimeout` (PR #292 J1, `protected-modal-harness.ts`).

**Prevention:** in any test helper that mixes fake timers with scheduled callbacks, install fake timers BEFORE scheduling. Treat the pre-Vitest-4 retroactive-capture behaviour as a historical accident, not the contract. When a flake survives an inter-file pollution audit (per-file forks, isolate-true all-pass-equivalent), check intra-file timer-install ordering NEXT — it's the next-most-common cause and the cheapest to verify.

## 2026-06-18 — Rolldown (Vite 8) bundles unused JSON keys; Rollup (Vite 5/7) tree-shook them

**Symptom:** PR #292 J1 (vite 7→8) tripped the G-T19-5 strip gate on the production bundle. Three banned literals (`__test_step`, `__test_user_agent`, `__test_*` family) leaked into `apps/web/build/_app/immutable/nodes/0.<hash>.js`. The runtime never reads those keys; they're documentation entries in `design-tokens.json`.

**Root cause:** Rolldown's JSON handling bundles the entire object including key names; Rollup's JSON plugin tree-shook unreferenced keys. The `_comment` field in `design-tokens.json:1074` already noted "Source references via split-form: '__test_' + 'step'" — the author had anticipated grep evasion but left the LITERAL key names in the JSON. Rollup masked it; Rolldown exposed it.

**Fix:** rename the doc keys so the leaked names aren't test-prop strings — the parent path `test_only_props.*` already carries semantics; inner keys don't need to mirror prop names verbatim. Renamed `__test_step` → `step`, `__test_user_agent` → `user_agent` (PR #292 fixup).

**Prevention:** under Rolldown, treat JSON key names as part of the shipped bundle. Don't encode test-only or sensitive vocabulary into JSON keys assuming tree-shaking will strip them. Lean on G-T19-5 / similar strip gates as a safety net, but design source so the gate never has to catch it.

## 2026-06-18 — Test-runtime cleanup must be EXPLICIT; auto-cleanup detection breaks at every major matrix bump

**Symptom:** `d6-panic-wipe.test.ts` failed intermittently with "multiple dialog in DOM" across THREE separate major-bump combos in one week — F2 (vitest 2→3 + svelte 5.56, PR #282), G1 (sveltekit 2.65 attempt, deferred), G2 (jsdom 25→29, PR #284). Each time the surface symptom was identical; each time the proximate fix was a different testing-library version pin.

**Root cause:** `@testing-library/svelte` auto-detects the test runner to decide whether to install an `afterEach(cleanup)` hook. The detection probes runner-internal globals that move on every vitest / jsdom / svelte major bump. When detection fails silently, no cleanup runs, DOM accumulates across specs, and a spec that asserts on dialog uniqueness panics.

**Fix:** stop depending on auto-detection. In `apps/web/test/setup.ts` install `afterEach(cleanup)` explicitly, paired with `vi.clearAllTimers()` + `vi.useRealTimers()` to also drop any fake-timer state the spec installed (PR #284, G2).

**Prevention:** for any matrix dependency that ships a "we'll auto-detect your runner" cleanup helper, opt out of the auto-detection on day one and call the cleanup primitive explicitly in a global setup file. The cost is one line; the saving is not debugging the same DOM-pollution symptom every time a peer dep bumps a major.

## 2026-06-17 — Bias-toward-skip after a long orchestration session; independent audit before declaring an arc done

**Symptom:** after PR #272 the orchestrator declared "nothing actionable remains" in the open-gap registry. An independent librarian audit then surfaced ~10 real closures wrongly bucketed into HG-10 / HG-15 / T_n.1 skip categories. Bundle E (PRs #273–#276) shipped all of them.

**Root cause:** the HG-10 / external-blocker skip rule (lesson 2026-06-14) is correct in isolation, but applied at the end of a long batching session the orchestrator's threshold for "skip-eligible" drifts upward — borderline items get rolled into skip buckets to close the session. The skip filter compounds across iterations.

**Fix:** spawn the librarian as an independent pass with the explicit prompt "find what the orchestrator missed," not "confirm the orchestrator's bucketing." Re-audit using the registry as the source of truth, not the orchestrator's running notes.

**Prevention:** before declaring any multi-PR arc done, run an independent librarian pass against the gap registry with a bias-toward-finding mandate. If the audit returns zero, the arc is done; if it returns N>0, ship them as the next bundle before closing. Do NOT trust the orchestrator's own "nothing remains" claim after a long session.

## 2026-06-17 — `@ts-expect-error` is silent under a type-broadening intersection

**Symptom:** the F-85 type-test pinned that backup-store internals `__<hook>` are NOT publicly accessible via `@ts-expect-error` on each access. `tsc` passed even though the suppressions were doing nothing — the regression the test exists to catch (a hook leaking into the public type) would not have failed CI.

**Root cause:** the test cast the store as `BackupStore & Record<string, unknown>`. The `Record<string, unknown>` arm makes EVERY string-key access type-check, so each `@ts-expect-error` was an unused-but-silent suppression. `tsc` does not flag unused `@ts-expect-error` under a permissive intersection because the directive's "expected error" never had a chance to fire.

**Fix:** drop the intersection; reference the store as bare `BackupStore`. Each `narrowed.__<hook>` access now genuinely fails type-check, the suppression catches it, and `tsc`'s unused-directive rule fails the build if the suppression ever becomes redundant (PR #274, G-T17-12).

**Prevention:** when adding `@ts-expect-error` to assert "this MUST not type-check," verify by REMOVING the suppression and confirming `tsc` complains. If it doesn't complain, the surrounding type assertion is too broad and the test is a no-op. Mirrors the synthetic-probe rule for ESLint flat-config from 2026-06-16.

## 2026-06-16 — ESLint flat-config rule traps: last-match clobber, too-broad selector, intra-block flow analysis vs cross-invocation reads

**Symptom:** (1) a newly-added `no-restricted-syntax` block scoped to two files did NOTHING — the rule never fired. (2) A first-cut selector `ObjectExpression > SpreadElement` (all object-literal spread) false-positived on a legitimate `...(cond ? { x } : {})` idiom. (3, added 2026-06-18 via PR #289) `eslint:recommended` in ESLint v10 enabled `no-useless-assignment` — 9 errors surfaced; 7 were genuine init-shadowed-before-read, 2 were FALSE POSITIVES on Svelte `$:` reactive blocks where the assigned value IS read on a LATER reactive invocation.

**Root cause:** (1) ESLint flat config is last-match-wins PER RULE — when multiple config objects set the same rule for an overlapping `files` glob, the LAST one fully REPLACES the value (no array merge). An earlier broad block (`src/**/*.ts`, G-T17-8) clobbered the new narrower block back to its own selectors. (2) The selector matched a structural shape rather than the actual anti-pattern (spreading a bound source-object variable `{ ...row }`, the F-19 leak risk). (3) `no-useless-assignment`'s flow analysis is intra-block; it cannot see cross-invocation reads. Svelte `$: if (foo !== last) { last = foo; … }` reads `last` on the NEXT reactive pass; the rule sees only the current block and reports the assignment as dead.

**Fix:** (1) move the narrower block AFTER the broad one and carry BOTH selectors so nothing is lost on the override. (2) narrow on the AST node's discriminating property — `ObjectExpression > SpreadElement[argument.type='Identifier']` bans `{ ...row }` while allowing inline-conditional + array spreads (PR #271, G-T11-9, `apps/web/eslint.config.js`). (3) suppress the two false positives with `eslint-disable-next-line no-useless-assignment` AND a doc comment naming the cross-invocation reader; drop the genuine init for the other seven (PR #289 I2).

**Prevention:** after adding/editing any array-valued flat-config rule, never trust that adding the block is sufficient — verify it fires with a synthetic probe (inject the banned syntax, run eslint, confirm the error, revert), and run the candidate selector against the WHOLE tree first to catch false-positives. Narrow on AST properties; do NOT carve per-file exceptions (they let real violations slip through new files). For any rule whose flow analysis is intra-block (`no-useless-assignment`, dead-code variants), audit Svelte `$:` and component-lifecycle reads before assuming a flagged site is dead. Suppress with a named-reader comment, never bare.

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

## 2026-06-18 — Parallel small-PR shipping cadence (supersedes 2026-06-14 batched A→E entry)

**Symptom:** large cleanup or dep-bump backlogs stall when bundled into one PR; reviewability is the bottleneck. Conversely, parallel small PRs collide on `package.json` / `pnpm-lock.yaml` once any one lands.

**Root cause:** PR reviewability and parallel-merge serialization are the two opposing pressures. Bundling helps the orchestrator's context but hurts the user; over-parallelizing helps throughput but creates lockfile churn.

**Fix:** ship lettered/numbered small PRs in parallel (M3/M9 cleanup arc PRs #229–#246; Bundle F PRs #278–#282; Bundle G PRs #283–#285). When a predecessor lands, rebase the open siblings: `git rebase main` → resolve `package.json` by KEEPING THE UNION OF DEP BUMPS (never drop a sibling's bump) → `rm pnpm-lock.yaml && pnpm install` → `pnpm test` → `git push --force-with-lease`. F2 and G2 both needed this exact sequence after their predecessors merged.

**Prevention:** open the small PRs in parallel from the start; document the rebase recipe (union-of-bumps + regenerated lockfile + force-with-lease) in the PR description template so contributors don't reinvent it. Never resolve a lockfile conflict by hand-editing — always delete and regenerate.

## 2026-06-14 — Verify the gap before scaffolding "missing" code

**Symptom:** I planned to scaffold the G-T13-1 SQL migration from scratch, treating the gap text as authoritative ("SQL migration deferred to T13.1"). The migration already existed at `supabase/migrations/00000000000005_reprisal.sql` (407 lines); writing it again would have wasted hours and created merge chaos.

**Root cause:** known-gaps entries describe the gap AT THE TIME OF FILING. They don't auto-close when the resolution lands. Treating the gap text as the current state, without verifying the file actually doesn't exist, leads to redundant work.

**Fix:** PR #246 pivoted from "write the migration" to "sweep the stale T13 status blocks" after a 3-second `ls supabase/migrations/00000000000005_*.sql` check. Eight gaps closed in one docs PR instead of one redundant migration.

**Prevention:** before scaffolding ANY artifact a gap entry says is missing, run a quick verify pass: `ls`/`find`/`grep` for the named file or symbol. If it exists, the work is a status-block sweep, not new code. The 30-second verify pays for itself many times over.
