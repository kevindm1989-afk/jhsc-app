# Patterns

Code and design patterns we use consistently in this project.

Append newest on top. Keep entries tight — three sentences plus a short example
beats an essay.

---

## Format

```
## Pattern name

**When to use:** trigger conditions.
**How:** the actual pattern.
**Example:**
\`\`\`
short code example
\`\`\`
**When not to use:** explicit anti-cases.
```

---

## Entries

## library-as-pin (closing architect-silent column/shape gaps)

**When to use:** an ADR is silent on a column name or payload shape, but the TS library (types / exported const) already commits to one. Multiple known-gaps were waiting on a formal architect ratification that never materialized.

**How:** in the relevant `known-gaps.md` entry, add a `**Status (partial close — library-as-pin pending architect ratification):**` block that (a) names the library file + line where the shape is committed, (b) enumerates the canonical names verbatim, (c) notes that the formal ADR ratification rides along with the next migration / wire-up PR.

**Example:** PRs #239 (G-T13-11 `pending_destructive_ops` columns pinned in `reprisal-store.ts:109–121`), #240 (G-T14-8 `notes_ct` pinned in `work-refusal-store.ts:74` + `s51-evidence-store.ts:72`), #246 (G-T13-6 pgcrypto bf shipped despite gap targeting argon2id).

**When not to use:** anything that requires an architect adjudication between mutually-exclusive options (forks). Use this only for "the library has already shipped one concrete answer, the architect can ratify when convenient."

## status-block tidying sweep (closing known-gaps that landed structurally)

**When to use:** a known-gap was resolved structurally (the code landed) but the gap entry was never updated. Sweep for entries without `**Status (...)**` blocks.

**How:** for each gap without a status block, verify the resolution landed (grep / file inspection), then append a `**Status (closed via X):** ...` block citing the file:line that resolves it. Batch the sweep into one PR per related cluster (T13, T14, T17, etc.).

**Example:** PRs #239 (G-T13-11/12/14), #240 (G-T14-7/8/15), #245 (G-T16-10 + G-T19-9 + audit-log §6 findings #3/#4), #246 (eight T13 gaps in one mass sweep).

**When not to use:** when the gap is genuinely open. Always verify the resolution against the file:line claimed before writing the closure.

## adapter-static + ssr=false reframe for "route handler" gaps

**When to use:** a known-gap targets a SvelteKit `+server.ts` route handler that doesn't exist (and won't — the project uses adapter-static + ssr=false).

**How:** add a `**Status (closed via reframe):**` block noting that the "route handler" is the Edge Function at `supabase/functions/<op>/index.ts`; JWT validation + active-member gating happen inside the SECURITY DEFINER fns. The TS adapter is `apps/web/src/lib/<surface>/supabase-<surface>-client.ts`.

**Example:** PR #246 (G-T13-2 + G-T13-7), prior closures of G-T08-2 / G-T08-7 / G-T07-2.

**When not to use:** when the gap actually IS about a missing production wire-up. The reframe is for gaps that mis-described the architecture; it's not a blanket-closure template.

## six-mirror dance (ADR-0003 Amendment A enum extension)

**When to use:** adding a new event_type to the audit-log closed enum.

**How:** the extension touches exactly six mirrors. Add to ALL in one PR (or split across two with the second rebased on the first); a missing mirror fails the `scripts/check-audit-enum-coverage.sh` gate in CI. (1) TS `RetentionEventType` union; (2) TS `RETENTION_SCHEDULE` + `RETENTION_EVENT_TYPES_RUNTIME`; (3) SQL `retention_class_for(...)` arm; (4) `observability/audit-log.md` §1 table row; (5) `scripts/check-audit-enum-coverage.sh` `EXPECTED_ENUM`; (6) pgTAP retention-class arm test.

**Example:** PRs #224 (M8.B.2 three integrity events), #226 (M8.A.3b `backup.manifest_written`), #228 (M8.A.3d `backup.hard_deleted`).

**When not to use:** for structured-log events (the `event:` name in `log.info({event:...})`). The six-mirror dance is for audit-log chain-participating events only.
