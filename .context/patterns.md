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

## library-level lease test pins the WEAKER guarantee; production race defense lives at the SQL layer

**When to use:** a TS library implements a cooperative checkpoint (in-memory lease window, last-run timestamp, soft-debounce) that callers honour, but the real race defense is a DB-side `pg_advisory_xact_lock` / unique constraint / serializable txn at the migration layer.

**How:** in the library-level test, assert the HONEST weaker guarantee — e.g. for two concurrent `Promise.all` calls, assert BOTH complete (the in-memory window is checked before either writes the 'running' row, so the lease cannot serialise them). Add a header comment naming the production race defense (file:line of the advisory-lock / constraint) so a reader knows where to look. A future regression that ADDED in-process serialisation would flip the assertion and surface as a test failure — which is the point: the library's contract changed.

**Example:** PR #274 (G-T18-16, `integrity-core.runIntegrityCheck` — library test asserts both concurrent runs complete; production serialisation is `pg_advisory_xact_lock` invoked from the T18.1 migration's `integrity_check_runner` fn at `supabase/migrations/00000000000030_t18_integrity_check_runner.sql`).

**When not to use:** when the library IS the race defense (no DB-side backup). There the test must assert serialisation, and the implementation must actually serialise (mutex / queue / single-flight).

## operator-side structured-error logging on swallowed catches (add observability, freeze the client contract)

**When to use:** a security-core file swallows failures with `catch {}` then returns a client-facing closed-literal `error_code`, and operators have no signal about what actually failed. You want to ADD operator observability WITHOUT changing the byte-for-byte client contract.

**How:** turn each `catch {}` into `catch (err)` and, immediately before the existing `store.restore()` + `return { status:'errored', error_code }`, emit `log.error({ event: '<domain>.<step>_failed', outcome: '<closed-literal error_code>', error_class: errorClassOf(err) })`. Log the JS constructor name ONLY — `errorClassOf(e) = e instanceof Error ? e.constructor.name : 'Error'` — never `err.message` (it may carry PI). Use top-level `LogCall` fields only (event/outcome/error_class), never `attributes`. Prove the no-PI property with a NEW test (existing tests are read-only per test-plan.md §6) that installs the log sink (`__setTestSink` / `__getCapturedLines`) and asserts: exactly one ERROR line per forced failure carrying `error_class` + `outcome`, no email/uuid/over-64-hex/raw-message shape; zero ERROR lines on a clean pass.

**Example:** PRs #268/#269/#270 (G-T16-PRIV-3 / G-T17-PRIV-3 / G-T18-3) — same shape across `retention-core.ts`, `backup-core.ts`, `integrity-core.ts` (~22 catch sites); precedent at `lib/auth/server/key-parity.ts:180`.

**When not to use:** for events that participate in the audit-log chain (use the six-mirror dance). Never log `err.message`, stack frames, or any input value — only the constructor name + the already-public closed-literal code.

## pinned-hex KAT for any digest a SQL/wire contract binds to

**When to use:** a hash/HMAC output is bound by a SQL projection-view, a CHECK, or a wire contract (e.g. `computeAllowlistHash`, queue HMAC). An idempotency-only assertion (`tag === tag2`) passes even when a toolchain regression makes the digest consistently-but-wrongly different.

**How:** pin the exact hex digest of a FIXED input in a test, with a header comment classifying the two failure modes — (a) intentional input/algorithm change → regenerate the hex AND coordinate the SQL/wire binding; (b) Node/OpenSSL/libsodium toolchain upgrade → coordinate the runtime upgrade with the binding. For multi-step derivations (KDF→MAC) pin BOTH the intermediate and final digests so a regression isolates to the right step.

**Example:** PR #264 (G-T11-23 `computeAllowlistHash` — minutes + recommendation digests), PR #265 (G-T10-11 queue HMAC — pins both `K_hmac` and the final `tag`).

**When not to use:** for non-deterministic outputs (anything with a random nonce/salt not fixed by the fixture), or where no downstream contract binds the digest — there an idempotency or round-trip assertion is enough.

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
