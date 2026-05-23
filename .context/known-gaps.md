# Known Gaps

Carry-forward items that don't block the current task's merge but require attention before specific future milestones (production deploy, downstream task launch, etc.).

Each entry: source review → finding → resolution scope → blocker for.

---

## T05 carry-forwards (2026-05-23)

### G-T05-1 — No SupabaseAuthStore implementation (second-opinion C4)
**Source:** second-opinion-reviewer on T05.
**Finding:** Only `MemoryAuthStore implements AuthStore`. `makeAuthClient` is wired only in the test harness. There is no Edge Function call, no RPC binding to `enroll_first_passkey`, no JWT-validating session middleware that reads `auth_sessions.revoked_at`.
**Scope decision (orchestrator + user):** T05 is the **auth-contract scaffold + library**. SupabaseAuthStore is a separate production-wire-up task — call it **T05.1** — that runs before any deploy carrying real PI. T07 and downstream library tasks launch on top of T05's AuthStore interface using `MemoryAuthStore` for tests, following the same pattern T05 established.
**Resolution scope (T05.1 — production wire-up):**
- Edge Functions `webauthn-options` + `webauthn-verify` calling `@simplewebauthn/server`.
- RPC client wrapping `enroll_first_passkey`, `revoke_session`, `revoke_all_sessions`, `revoke_passkey`.
- Session middleware validating JWTs against `auth_sessions.revoked_at` (≤5s propagation per F-39).
- Wire-up of real `HMAC_PSEUDONYM_KEY` env var ↔ Postgres GUC parity (replaces the `KEY_PARITY_SERVER_SHA_HEX` staging shim — see G-T05-2).
**Blocker for:** production deploy with real PI. NOT a blocker for T07 / T08 / library tasks.

### G-T05-2 — `KEY_PARITY_SERVER_SHA_HEX` is the production code path (second-opinion C3)
**Source:** second-opinion-reviewer on T05.
**Finding:** `hooks.server.ts:94-104` uses a deploy-time env var `KEY_PARITY_SERVER_SHA_HEX` instead of a live Postgres `SELECT encode(digest(current_setting('app.hmac_pseudonym_key')::bytea, 'sha256'), 'hex')` round-trip. An operator who fat-fingers the GUC but correctly mirrors the SHA in the env var will pass the smoke test and produce mismatched pseudonyms.
**Resolution scope (T05.1):** replace the shim with a live Postgres query against `current_setting('app.hmac_pseudonym_key')`. The fetcher is server-only; the response is the SHA-of-key only (never the key value).
**Blocker for:** production deploy. T07 / T08 unaffected.

### G-T05-3 — `revoke_*` fns lack `auth.uid()` defense-in-depth (second-opinion C7)
**Source:** second-opinion-reviewer on T05.
**Finding:** `supabase/migrations/00000000000001_auth.sql:458-540` — `revoke_session`, `revoke_all_sessions`, `revoke_passkey` enforce the privilege boundary via `GRANT EXECUTE TO supabase_auth_admin` only. They do not constrain by `auth.uid()`. If the Edge Function wrapper is forgotten or buggy, a logged-in attacker who can call the RPC could revoke arbitrary sessions or delete arbitrary credentials by guessing UUIDs (UUID unguessability is the practical mitigation).
**Resolution scope (T05.1):** add `IF v_session.user_id != auth.uid() THEN RAISE EXCEPTION ...` (or equivalent) inside each function. Defense in depth.
**Blocker for:** production deploy. T07 / T08 unaffected.

### G-T05-4 — INFO logs go to `/dev/null` in production (second-opinion C8)
**Source:** second-opinion-reviewer on T05.
**Finding:** `apps/web/src/lib/log/index.ts:147-155` — structured logger's production transport is "scaffolding": only ERROR / FATAL / WARN to console; INFO is dropped unless a sink is installed. Every `log.info({ event: 'auth.passkey.assert', ... })` from auth-core silently disappears in prod until T02's POST `/api/log/ingest` lands. Per ADR-0003 Amendment A G.5, this is the only observability for passkey-assert volumetrics.
**Resolution scope:** T02's log-ingest path must land before T05.1 production wire-up. Alternatively, reclassify the assert lines as WARN.
**Blocker for:** production deploy. The `alert.fired` row IS emitted to `audit_log`, so the burst-alert path remains observable; only the per-attempt assert line is dark.

### G-T05-5 — Bundle-scan source-fallback false-positive risk (privacy R1)
**Source:** privacy-reviewer T05 re-review.
**Finding:** `scripts/verify-no-third-party-js.sh:36-44` falls back to `SRC_DIR` scan when `BUILD_DIR` is absent; three comment-only occurrences of `HMAC_PSEUDONYM_KEY` in source files would false-positive. CI runs `pnpm build` first so production CI is unaffected.
**Resolution scope:** exclude comment lines from source-fallback scan, OR downgrade source-fallback to a warning. Defense in depth.
**Blocker for:** none. Cleanup.

### G-T05-6 — `retention_class_for()` vs ADR-0015 drift check (privacy R2)
**Source:** privacy-reviewer T05 re-review.
**Finding:** `00000000000001_auth.sql:117-150` `retention_class_for()` is a hand-typed mirror of ADR-0015 + ADR-0016 retention values. Currently aligned (22 rows match), but no test asserts the mirror. Future ADR amendment that adds an event_type without updating the function silently falls through to `'24mo'` default.
**Resolution scope (test-writer carry-forward to T16):** drift-check test enumerating `event_type` values across (a) `audit_log_retention_schedule` table (per ADR-0015 §Schema Requirements #2) and (b) `retention_class_for()` output, asserting equality.
**Blocker for:** T16 retention job ship.

### G-T05-7 — T16 retention sweep is the enforcer for `auth_totp_consumed_log` (privacy R3)
**Source:** privacy-reviewer T05 re-review.
**Finding:** ADR-0016 documents 24h retention for `auth_totp_consumed_log` but T05 ships no sweep job; T16 owns it. PIPEDA Principle 4.5 is satisfied only by an enforced retention.
**Resolution scope:** T16 implementer adds the sweep.
**Blocker for:** first production deploy with real PI. T05.1 should not promote without T16.

### G-T05-8 — Boot smoke test gate could miss misconfigured staging (privacy R4)
**Source:** privacy-reviewer T05 re-review.
**Finding:** `hooks.server.ts:82-88` boot smoke test runs only when `_isProduction === true` (derived from `import.meta.env.MODE`). A staging deploy with `MODE !== 'production'` but real PI in flight would skip the parity check.
**Resolution scope:** either (a) tighten the activation rule (any presence of `HMAC_PSEUDONYM_KEY` env var triggers the check regardless of MODE — defense in depth), or (b) document explicitly that `MODE=production` is a deploy-time requirement for any deploy touching real PI. Architect-level decision.
**Blocker for:** none directly. Deploy-runbook item.

### G-T05-9 — Semgrep pattern coverage for `digest()` (security A3)
**Source:** security-reviewer T05 re-review.
**Finding:** `.semgrep/no-bare-sha256-in-migrations.yml` uses `digest($X, 'sha256')` in generic mode. Won't catch uppercase `DIGEST(...)`, double-quoted `"sha256"`, or `pgcrypto.digest(...)`. Not idiomatic in Postgres SQL, but defense-in-depth.
**Resolution scope:** add sibling pattern OR move to `language: sql` if available.
**Blocker for:** none. Cleanup.

### G-T05-10 — `HMAC_PSEUDONYM_KEY` literal in TS source comments (security A1)
**Source:** security-reviewer T05 re-review.
**Finding:** Source comments at `apps/web/src/lib/auth/memory-store.ts:15`, `apps/web/src/lib/auth/auth-core.ts:19`, `apps/web/src/lib/observability/sentry-scrub.ts:23` contain the literal `HMAC_PSEUDONYM_KEY`. Current build pipeline strips comments; bundle stays clean. Risk: future bundler config regression (sourcemaps, comment-preserving minifier) would leak the env-var name.
**Resolution scope:** convert to the split form used in `key-parity.ts:45` (`'HMAC_' + 'PSEUDONYM_KEY'`) or use a non-identical descriptor.
**Blocker for:** none. Defense in depth.

### G-T05-11 — `enrollFirstDevice` returns 410/401 differential not collapsed (security A2)
**Source:** security-reviewer T05 re-review.
**Finding:** `enrollFirstDevice` still returns 410 for `reason='expired'` and `reason='consumed'`, bound by the F-38 test at line 137. An attacker with an intercepted TOTP code can probe `enrollFirstDevice` with synthetic user_ids and observe the 410/401 differential. Architect amendment pass #4 §A4 intended LOGIN probe surface collapse, not enrollment ceremony.
**Resolution scope:** architect pass #5 disposition — either accept the residual (track here) or extend the collapse to `enrollFirstDevice`. Tests would need amendment.
**Blocker for:** none directly. Architect adjudication when convenient.

---

## T07 carry-forwards (2026-05-23)

All twelve are ratified under ADR-0002 Amendment H + ADR-0003 Amendment G + Amendment pass #5 (architect pass on `.context/decisions.md`). T07 ships as TS library only; T07.1 ships the SQL + production wire-up. Source: T07 four-reviewer pass (security, second-opinion, privacy, verifier) summarized in commit `31f80d3`.

### G-T07-1 — SQL migration deferred to T07.1
**Source:** second-opinion 2, security findings 1+3, privacy T07-1/2/3.
**Finding:** `supabase/migrations/00000000000002_identity.sql` was shipped without integration tests (the test harness was a parallel in-memory implementation; SQL functions had zero test call-sites). The migration is dropped from T07.
**Resolution scope (T07.1):** ship the migration with pgTAP / real-Supabase integration tests covering every SECURITY DEFINER function.
**Blocker for:** first production deploy carrying real PI.

### G-T07-2 — SupabaseKeyStore production wire-up
**Source:** ADR-0002 Amendment H (canonical sibling-task pattern; mirrors G-T05-1).
**Finding:** Only `MemoryKeyStore implements KeyStore`. No Edge Function call, no RPC binding to T07's SQL functions, no JWT-validating committee membership checks.
**Resolution scope (T07.1):** wire SupabaseKeyStore + Edge Functions for the wrap/unwrap/rotate paths.
**Blocker for:** production deploy with real PI.

### G-T07-3 — Real Supabase integration tests for T07 SQL functions
**Source:** second-opinion 2.
**Finding:** every adminQuery in the T07 test file resolves through `apps/web/test/_helpers/supabase-test.ts`'s in-memory mini-parser. The 11 SQL SECURITY DEFINER functions in the deferred migration have zero automated test coverage.
**Resolution scope (T07.1):** pgTAP suite covering `enroll_identity_keypair`, `store_recovery_blob`, `record_recovery_blob_restored`, `record_recovery_blob_viewed`, `issue_recovery_blob_reset`, `init_committee_data_key`, `wrap_committee_data_key_for_member`, `record_committee_data_key_unwrap`, `rotate_committee_data_key`, `finalize_committee_data_key_rotation`, `revoke_committee_member`.
**Blocker for:** T07.1 PR submission.

### G-T07-4 — ADR-0016 schedule rows for 6 tables
**Source:** privacy T07-1.
**Finding:** `identity_keys`, `recovery_blobs`, `recovery_blob_resets`, `committee_data_keys`, `committee_key_wraps`, `committee_key_wraps_history` need ADR-0016 operational-table schedule rows before the migration lands in `main`.
**Resolution scope (T07.1):** architect amendment adds 6 schedule rows; HG-15 user re-ratification.
**Blocker for:** T07.1 PR submission.

### G-T07-5 — §PI inventory amendments for 6 tables
**Source:** privacy T07-1.
**Finding:** ~20 new PI inventory rows + 2 row annotations (lines 3257 + 3258 — `users.identity_pubkey` and `users.identity_privkey_recovery_blob` relocation notes per ADR-0002 Amendment G.3 pattern).
**Resolution scope (T07.1):** folded into the T07.1 architect amendment that adds the ADR-0016 rows.
**Blocker for:** T07.1 PR submission.

### G-T07-6 — `view_count` decision (preferred removal at design time)
**Source:** privacy T07-2.
**Finding:** `recovery_blobs.view_count` is over-collected per PIPEDA Principle 4.4 — duplicates audit-log data derivable from `SELECT count(*) FROM audit_log WHERE event_type='identity_privkey.recovery_blob.viewed' AND target_id=$1`. Privacy reviewer's preferred fix: remove the column; derive at read-time.
**Resolution scope (T07.1):** when the migration lands, do NOT include the `view_count` column. The per-session reveal counter is in the controller; the cross-session counter is derived from audit log.
**Blocker for:** T07.1 PR submission.

### G-T07-7 — Server-side cap-of-3 enforcement
**Source:** second-opinion 5.
**Finding:** `record_recovery_blob_viewed` (in the deferred migration at lines 386-391) explicitly trusted client-supplied `reveal_count_in_session`. M-54c exists because the client is not trusted in F-54 threat model. The SQL must enforce the cap server-side.
**Resolution scope (T07.1):** server-side counter (column on `recovery_blobs` keyed on `enrollment_session_id` OR derived count from `audit_log`); reject INSERT if cap reached.
**Blocker for:** T07.1 PR submission.

### G-T07-8 — `issue_recovery_blob_reset` authz + audit emission
**Source:** security F3, second-opinion 3, privacy T07-A2.
**Finding:** the deferred SQL function had no co-chair role check on `p_issued_by` and emitted no audit_log row. F-12's mitigation requires "co-chair-issued, audit-logged."
**Resolution scope (T07.1):** add `SELECT 1 FROM users WHERE id = p_issued_by AND role = 'worker_co_chair' AND active = true` precondition; emit interim audit row via closest existing enum until T06's `recovery_reset.issued` enum lands.
**Blocker for:** T07.1 PR submission.

### G-T07-9 — Server-issued nonce for F-02 self-test
**Source:** security F6.
**Finding:** F-02's mitigation says "server returns a nonce sealed to the just-posted ident_pub; client must unseal and return; if unseal fails, enrollment is rolled back." The current `selfTestKeypair` runs entirely on the client. A hostile client cannot be caught.
**Resolution scope (T07.1):** Edge Function emits a sealed-to-pubkey nonce on enroll; client unseals; server verifies before committing the row.
**Blocker for:** T07.1 PR submission.

### G-T07-10 — KeyStore interface split (read API must not surface private_key)
**Source:** security F5.
**Finding:** `apps/web/src/lib/crypto/key-store.ts:98-104` accepts `{public_key, private_key}` on `storeIdentityKeys`. Documentary contract only; a future implementer could persist the private half. Type system does not enforce Invariant 1.
**Resolution scope (T07.1):** split into `persistIdentityPublicKey(user_id, public_key)` server-bound + `LocalIdentityStore` device-local interface. SupabaseKeyStore implements only the server-bound side.
**Blocker for:** T07.1 PR submission.

### G-T07-11 — `identity_pubkey` relocation documentation
**Source:** privacy Cross-cutting A.
**Finding:** the migration places identity public key on `public.identity_keys` (1:1 row), not as a `users.identity_pubkey` column as the §PI inventory anticipated. ADR-0002 Amendment G.3 pattern (for `committee_membership` → `users` relocation) should be mirrored for this relocation in reverse.
**Resolution scope (T07.1):** ADR-0002 Amendment G.3 addendum (or new amendment letter) documenting the `users.identity_pubkey` → `identity_keys.public_key` relocation; update ADR-0003 Amendment A CI grep target.
**Blocker for:** T07.1 PR submission.

### G-T07-12 — `libsodium-wrappers-sumo` dep swap + boot-time assertion + lockfile-lint
**Source:** security F1, privacy T07-A4.
**Finding:** standard `libsodium-wrappers` lacks `crypto_pwhash`. Production deploy needs the `-sumo` build for Argon2id. ADR-0003 Amendment G makes `encryptRecoveryBlob` fail-closed when `crypto_pwhash` absent, so the data-integrity bomb is prevented in code — but production usability requires the dep swap.
**Resolution scope (T07.1):** swap `libsodium-wrappers` → `libsodium-wrappers-sumo` in `apps/web/package.json`; boot-time assertion in `apps/web/src/lib/crypto/recovery-blob.ts` that throws if `crypto_pwhash` is missing and `NODE_ENV !== 'test'`; pnpm `lockfile-lint` rule asserting `libsodium-wrappers-sumo` is the resolved dep in production builds.
**Blocker for:** production deploy with real PI.

### G-T07-13 — Svelte 5 + TS `@ts-expect-error` suppressions on event handlers
**Source:** second-opinion-reviewer T07 final pass.
**Finding:** `apps/web/src/lib/onboarding/recovery/RecoveryPassphraseScreen.svelte:107, :117` use `@ts-expect-error` on event-handler parameter type annotations because the Svelte AST printer (esrap) cannot emit them. Runtime guards (`e.key === ' ' || e.code === 'Space'`) are in place. Cosmetic / type-system friction; not a correctness defect.
**Resolution scope:** revisit when esrap or svelte-check upgrades remove the friction. Replace suppressions with proper typed event handlers.
**Blocker for:** none. Cleanup.

### G-T07-14 — `rotate_committee_data_key` precondition: at-least-one-active-member
**Source:** second-opinion-reviewer T07 final pass (advisory 8).
**Finding:** The rotation path does not enforce "at least one active member exists" before `finalize_committee_data_key_rotation`. If `rotateCommitteeDataKey` is called when `revoke_committee_member` has emptied the active set, the new epoch has no wraps and the data key under that epoch is unrecoverable — data-loss risk on a corner case the in-memory tests don't exercise.
**Resolution scope (T07.1):** add a `SELECT count(*) FROM users WHERE active = true >= 1` precondition inside `rotate_committee_data_key` SQL function; raise on zero. Fold into G-T07-3's pgTAP integration test plan.
**Blocker for:** T07.1 PR submission.

### G-T07-15 — `client.identity_selftest_fail` audit-emission interface unification
**Source:** second-opinion-reviewer T07 final pass (advisory 10).
**Finding:** `apps/web/src/lib/crypto/index.ts:382` emits `client.identity_selftest_fail` via the `recordKeyEvent` path with an `as unknown as never` cast because the closed enum forbids the value at the type level. The CI gate `check-audit-enum-coverage.sh` enforces the closed enum at build time, so the cast is structurally safe — but the cast itself is type-uglyness that should disappear in T07.1.
**Resolution scope (T07.1):** either widen the audit-emission interface to admit a structured-log-shaped emission path that doesn't go through the closed enum, OR route this event through a separate AuthStore-style emission method. Folds with G-T07-10 (KeyStore interface split).
**Blocker for:** none. Cleanup.

---

## How to use this file

- When working on T05.1 / production wire-up: search for `G-T05-*` and resolve them in a single pass.
- When working on T07.1 / production wire-up: search for `G-T07-*` and resolve them in a single pass.
- When working on T16: search for `G-T05-6`, `G-T05-7`, and the retention-sweep entries under any task.
- When working on T02 ingest path: address `G-T05-4` before T05.1 ships.
- New gaps from future reviewers append at the bottom under their task heading.
