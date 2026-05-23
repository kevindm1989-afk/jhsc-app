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

## T08 carry-forwards (T08.1 sibling production-wire-up)

All eight are ratified under ADR-0002 Amendment H + ADR-0007 + the T08 four-reviewer pass. T08 ships as TS library only (concern intake form + library code + MemoryConcernStore); T08.1 ships the SQL migration + SupabaseConcernStore + integration tests.

### G-T08-1 — SQL migration deferred to T08.1
**Source:** ADR-0002 Amendment H (sibling-task pattern, mirrors G-T07-1).
**Finding:** the `concerns` table + `is_active_member()` RLS gate + `concern_rate_limit_consume()` SECURITY DEFINER function + `concerns_list_default_projection()` view (F-18 default-list payload) ship in T08.1, not T08. T08's library tests run against `MemoryConcernStore` exclusively.
**Resolution scope (T08.1):** ship `supabase/migrations/00000000000003_concerns.sql` with the `concerns` table, RLS policies for INSERT/UPDATE/SELECT, `concerns_default_view` (omitting `source_name_ct` per F-18), rate-limit table + `consume_concern_rate_budget` function, and pgTAP integration tests covering F-15/F-16/F-17/F-18/F-20.
**Blocker for:** first production deploy carrying real PI.

### G-T08-2 — SupabaseConcernStore production wire-up
**Source:** ADR-0002 Amendment H.
**Finding:** Only `MemoryConcernStore implements ConcernStore`. No Edge Function call, no RPC binding to T08's SQL functions, no JWT-validating active-membership check.
**Resolution scope (T08.1):** wire `SupabaseConcernStore` against the live Postgres schema; route handler at `/api/concerns` validates JWT, calls `is_active_member()`, enforces rate limit via SECURITY DEFINER function, emits audit row in same transaction as INSERT.
**Blocker for:** production deploy with real PI.

### G-T08-3 — Real Supabase integration tests for T08 SQL functions
**Source:** ADR-0002 Amendment H + privacy-review-t07 pattern.
**Finding:** every adminQuery in the T08 test file resolves through the in-memory MemoryConcernStore via the test harness's mini-parser. The SECURITY DEFINER functions + RLS policies in the deferred migration have zero automated test coverage.
**Resolution scope (T08.1):** pgTAP suite covering `is_active_member()` for INSERT/UPDATE/SELECT; `consume_concern_rate_budget` (20/hr, 200/24h); `concerns_default_view` projection (no source_name_ct); per-record reveal flow with audit-emit-before-return ordering.
**Blocker for:** T08.1 PR submission.

### G-T08-4 — ADR-0016 schedule row for `concerns` table
**Source:** ADR-0016 hard rule "every operational table touching PI MUST appear in this schedule before the table ships in any migration that lands in `main`".
**Finding:** `concerns` (C3 body + C4 source_name + C1 hazard/severity/location + actor anchor) needs an ADR-0016 operational-table schedule row before the T08.1 migration lands.
**Resolution scope (T08.1):** architect amendment adds the schedule row; HG-15 user re-ratification covers the new table.
**Blocker for:** T08.1 PR submission.

### G-T08-5 — §PI inventory amendment for `concerns` columns
**Source:** privacy-review pattern (mirror of G-T07-5).
**Finding:** new PI inventory rows for `concerns.id`, `concerns.actor_id`, `concerns.title_ct`, `concerns.body_ct`, `concerns.source_name_ct`, `concerns.hazard_class`, `concerns.severity`, `concerns.location_id`, `concerns.created_at`, `concerns.updated_at`.
**Resolution scope (T08.1):** architect amendment to `.context/decisions.md` §PI inventory.
**Blocker for:** T08.1 PR submission.

### G-T08-6 — Per-record passphrase storage / verification for reveal flow
**Source:** F-18 mitigation refers to "server tracks an ephemeral unlock token bound to the audit-log row" but T08 library-layer concern-core accepts the passphrase as an opaque string and does not enforce a verification policy (the in-memory store does not store per-record passphrases at all).
**Finding:** the F-18 reveal-flow contract requires that the per-record passphrase be (a) set at submit time when `anonymous === false`, (b) stored in a form the server can verify without seeing the plaintext source_name. T08 library does not yet implement this — only the audit-emit-before-return ordering.
**Resolution scope (T08.1):** add per-record passphrase column + bcrypt/argon2 hash + verify step in `reveal_concern_source` SECURITY DEFINER function; surface the per-record passphrase field in the intake form's named-source branch.
**Blocker for:** T08.1 PR submission.

### G-T08-7 — Route inventory binding to actual SvelteKit `+server.ts` files
**Source:** ADR-0007 route inventory contract.
**Finding:** the ADR-0007 route-inventory test passes in T08 because the harness's `getRouteInventory()` returns a hand-curated list. There is no SvelteKit `+server.ts` for `/api/concerns` yet; the harness's "no public-write surface" guarantee is structural-by-absence (no file exists) but the test's assertion is harness-driven.
**Resolution scope (T08.1):** land the SvelteKit `/api/concerns/+server.ts` with `requireAuthenticated` middleware; update `getRouteInventory()` to read from the real route tree.
**Blocker for:** first production deploy.

### G-T08-8 — F-30 session-invalidation timing in production
**Source:** F-30 — "removed member with a still-valid JWT: INSERT denied within 60 seconds of `committee_membership.active = false`".
**Finding:** T08's MemoryConcernStore + harness `callProtected` enforce the active-member gate synchronously (immediate denial after `coChairUpdateMembership({active: false})`). Production needs the same gate at the Edge Function layer with documented ≤60s propagation (the 5s SLO already established in F-39 / T05 is stricter than F-30's 60s but the test uses 60s).
**Resolution scope (T08.1):** document the gate in the route handler; integration test asserts the ≤60s budget against the live Supabase stack.
**Blocker for:** T08.1 PR submission.

### G-T08-9 — `concern.updated` audit-event enum amendment
**Source:** security-reviewer T08 Finding 1.
**Finding:** `CONCERN_AUDIT_EVENTS` in `apps/web/src/lib/concerns/types.ts:132` adds `'concern.updated'`, but the canonical closed enum in `observability/audit-log.md` §1 "Concern intake (T08)" lists only `concern.created` and `concern.source_revealed`. Threat-model §3.2 F-16 spells the event `concern.update` (singular). The `scripts/check-audit-enum-coverage.sh` gate has no enforcement of this enum value yet; T08.1's SQL CHECK constraint will reject it.
**Resolution scope (T08.1 architect amendment):** add `concern.updated` to `observability/audit-log.md` §1 with required meta `{prev_field_hashes}`; add to `scripts/check-audit-enum-coverage.sh:42-43` EXPECTED_ENUM; add an ADR-0003 Amendment A amendment authorizing the new value. Reconcile threat-model §3.2 F-16 spelling.
**Blocker for:** T08.1 PR submission.

### G-T08-10 — `node:crypto.createHash` → libsodium helper
**Source:** security-reviewer T08 Finding 2.
**Finding:** `apps/web/src/lib/concerns/concern-core.ts:18, :92` imports `node:crypto` and uses `createHash('sha256')` for `prev_field_hashes`. `concern-core.ts` sees plaintext and per ADR-0003 Invariant 2 must execute browser-side. `node:crypto` is Node-only; Vite/SvelteKit production build will fail or polyfill. Today dormant because no Svelte route imports concern-core; will break T08.1 wiring.
**Resolution scope (T08.1):** add `sha256Hex(bytes: Uint8Array): string` helper in `apps/web/src/lib/crypto/sodium.ts` or `apps/web/src/lib/crypto/hash.ts` using libsodium primitives (`crypto_generichash` BLAKE2b OR `crypto.subtle.digest('SHA-256')` under the `lib/crypto/` semgrep allowlist). Replace concern-core imports.
**Blocker for:** T08.1 PR submission (and any production deploy that wires concern-core into a Svelte route).

### G-T08-11 — Consent-copy purpose statement (PIPEDA 4.3.4)
**Source:** privacy-reviewer T08 T08-A2.
**Finding:** Current `i18n/en-CA.json:184-185` `concern.intake.named.advisory_body` describes the storage posture (encrypted, visible to members, irreversible) but NOT the purpose of source-name collection. PIPEDA Principle 4.3.4 requires informed-of-purpose consent.
**Resolution scope:** expand advisory copy to include a one-sentence purpose statement (e.g., "Recording the worker's name lets the committee follow up with them about this concern."). Labour-lawyer (HG-10) ratification before T08.1 production deploy.
**Blocker for:** first production deploy with real concern data.

### G-T08-12 — Form-side validation gate for empty `sourceName` when named-source selected
**Source:** privacy-reviewer T08 T08-A3.
**Finding:** Library catches empty `source_name_plaintext` with `anonymous: false` at `concern-core.ts:143-146` (403 with `{error: 'forbidden'}`) but form has no user-visible error before submit. PIPEDA 4.3.4 / UX-correctness gap.
**Resolution scope:** add `sourceName` to validation gate at `ConcernIntakeForm.svelte:139-144`; surface inline-error pattern (`role="alert"`) like the title/body fields. Library 403 stays as defense-in-depth.
**Blocker for:** none. Polish for T08.1 or follow-up T08 pass.

### G-T08-13 — 200/24h second-ceiling rate-limit enforcement
**Source:** privacy-reviewer T08; cross-cuts second-opinion T08 (200/24h carry-forward).
**Finding:** `MemoryConcernStore` only encodes the 20/hour ceiling per F-20. Threat-model F-20 specifies BOTH 20/hour AND 200/24h. T08.1's `consume_concern_rate_budget` SQL function must enforce both windows.
**Resolution scope (T08.1):** SQL function `consume_concern_rate_budget(actor_id)` evaluates two windows; rejects on either.
**Blocker for:** T08.1 PR submission.

### G-T08-14 — `received_at_ts: now() + 1` test-artifact shim in library code
**Source:** second-opinion-reviewer T08 Concern 1.
**Finding:** `apps/web/src/lib/concerns/concern-core.ts:293` returns `received_at_ts: now() + 1` so the test's strict-inequality assertion (`auditTs < responseTs`) holds when both audit emit and decrypt resolve in the same JS tick. In production this value is wrong — it's an invented future moment, not the actual return-to-caller moment.
**Resolution scope (T08.1):** SupabaseConcernStore reveal flow replaces this whole pattern with a transaction where audit-commit-ts precedes function-return-ts naturally. The library shim can then return the actual return-moment timestamp; the test relaxes to `<=` with separate ordering-of-operations assertion.
**Blocker for:** T08.1 PR submission (the library shim must NOT persist into production).

### G-T08-15 — Route-layer consent-attestation field (or documented asymmetry)
**Source:** second-opinion-reviewer T08 Concern 2.
**Finding:** A direct API call with `{anonymous: false, source_name_plaintext: "..."}` is accepted by the library with no consent-surface attestation. The Svelte form is structurally locked but the library admits programmatic skip. ADR-0007 base scope does NOT mandate API-level consent enforcement (only ADR-0007 amendment for reprisal-log Surface C does). Asymmetry between T08 and T13 is by-design but undocumented.
**Resolution scope (T08.1):** route handler at `/api/concerns/+server.ts` documents the posture. Either (a) require a `consent_attested: true` field in `ConcernIntake` validated at the route layer, OR (b) document explicitly that programmatic-bypass is acceptable under F-17 audit-of-author posture.
**Blocker for:** T08.1 PR submission.

### G-T08-16 — F-30 timing-budget pgTAP test
**Source:** second-opinion-reviewer T08 Concern 3 (cross-cuts G-T08-8).
**Finding:** Harness `callProtected` consults `isActiveMember` synchronously; `advanceBy(60_000)` in the F-30 test is decorative. Test asserts direction-of-behavior but not the 60s budget.
**Resolution scope (T08.1 pgTAP):** at least one case at >0s and one ≤60s; pin G-T08-8.
**Blocker for:** T08.1 PR submission.

### G-T08-17 — `border.width.thin` design token
**Source:** second-opinion-reviewer T08 Concern 8 (cross-cuts security-reviewer informational note).
**Finding:** `ConcernIntakeForm.svelte:370, :409` use raw `1px` border widths (and `:446` uses raw `4px` for C4 left border). Implementer documented as the "1px exception" but no `border.width` token exists in `design-tokens.json`.
**Resolution scope (next designer pass):** add `border.width.hairline` (1px) and `border.width.c4_stripe` (4px) tokens to `design-tokens.json`. Then sweep components to consume.
**Blocker for:** none. Cleanup.

### G-T08-18 — Harness T07/T08 dual-write coupling unification
**Source:** second-opinion-reviewer T08 Concern 4.
**Finding:** `apps/web/test/_helpers/supabase-test.ts:807-862` writes each concern to BOTH the inline T07 `concernRowsById` map AND the T08 concern-store. The returned ID is `inlineId ?? result.id` — T07-shaped tests get an id the concern-store can't find. Risk is low (test-only) but downstream tests that mix shapes will fail confusingly.
**Resolution scope:** when T11 starts touching concerns, unify the two paths into one canonical concern-store-backed flow.
**Blocker for:** T11 implementer pass.

---

## T10 carry-forwards (2026-05-23)

T10 ships library-only per ADR-0002 Amendment H. Concerns 1 (non-JPEG silent-destroy → fail-closed throw) and 3 (`goOnline()` recursive failure → drain-then-shift) from second-opinion-reviewer were fixed in code BEFORE merge (see commit message). Concern 2 (real canvas re-encode) stays as the carve-out G-T10-1 below per the second-opinion-offered MERGE-WITH-ADVISORIES path.

### G-T10-1 — Real canvas re-encode for photo sanitize (ADR-0011 amendment rule 3)
**Source:** second-opinion-reviewer T10 Concern 2; privacy T10-D1; security advisory.
**Finding:** `apps/web/src/lib/photo/sanitize.ts:181-186` `canvasReencode()` is a pass-through stub. ADR-0011 amendment rule 3 mandates real `OffscreenCanvas.convertToBlob` decode-and-re-encode as defense-in-depth against EXIF-strip-library blind spots. Marker-strip is sufficient for the JPEG threat model today, but the canvas path closes coverage on exotic markers (e.g., MPF/MPO multi-picture, trailing JFXX thumbnails after EOI). jsdom cannot faithfully simulate the API; needs a real browser environment.
**Resolution scope (T10.1):** wire `createImageBitmap → OffscreenCanvas.getContext('2d').drawImage → canvas.convertToBlob('image/jpeg', q)` behind a feature-detect; smoke-test in T19 PWA install / real-browser Playwright test; differential validation against an independent library (e.g., `exifr`).
**Blocker for:** T10.1 PR submission AND first production deploy with real photo data.

### G-T10-2 — Raw user_id leaked into `inspection.synced.meta.inspection_id`
**Source:** privacy T10-A1; touches second-opinion review.
**Finding:** `queue.ts:212` composes `entry.id = entry-<seq>-<user_id>` with the raw UUID. The harness flows this into `inspection.synced.meta.inspection_id` at `supabase-test.ts:1521`. Breaks ADR-0016 §Decision 1 HMAC-pseudonymization parity for audit-log meta. Already C1 in §PI inventory but not a clean disclosure surface.
**Resolution scope (T10.1):** server-side `inspections` PK is server-generated UUID; audit emits the server-side handle. Client `entry.id` becomes IDB-local only.
**Blocker for:** T10.1 PR submission.

### G-T10-3 — HEIC/PNG/WebP support: real canvas decode or explicit user-facing rejection
**Source:** second-opinion-reviewer T10 Concerns 1+9; privacy T10-A2; security A4.
**Finding:** T10 now fail-closes (throws `PhotoUnsupportedFormatError`) on non-JPEG input — better than silent destroy, but still rejects iOS-default HEIC + Android-default PNG screenshots at the library layer. The capture-surface UX must surface this to the user with a clear banner + audit row (`photo.sanitize.unsupported_format`). The full fix is the real canvas decode-and-re-encode (G-T10-1) that handles non-JPEG → re-encode-to-JPEG transparently. Until then, the capture surface MUST catch the throw and surface a clear "please convert to JPEG and re-attach" message.
**Resolution scope (T10.1):** (a) capture-surface error boundary that catches `PhotoUnsupportedFormatError` and shows the user a clear instruction; (b) audit row `photo.sanitize.unsupported_format` on the catch path; (c) real canvas decode for HEIC/PNG/WebP per G-T10-1.
**Blocker for:** T10.1 PR submission.

### G-T10-4 — SQL migration deferred to T10.1
**Source:** implementer handoff + ADR-0002 Amendment H pattern.
**Finding:** `inspections.client_integrity_tag BYTEA NOT NULL` column + `rejected_queue_entries` audit indexes per ADR-0014 are deferred to T10.1.
**Resolution scope (T10.1):** ship the migration with pgTAP integration tests.
**Blocker for:** T10.1 PR submission.

### G-T10-5 — Production wire-up of IndexedDBInspectionStore
**Source:** implementer handoff + ADR-0002 Amendment H pattern.
**Finding:** T10 uses in-memory `entries: []` in `InspectionSession`. Production needs an IndexedDB-backed store with the byte-for-byte same shape (no plaintext debug columns).
**Resolution scope (T10.1):** wire the real IDB store + integration tests.
**Blocker for:** T10.1 PR submission.

### G-T10-6 — Real Supabase integration tests for inspection POST + audit-row paths
**Source:** implementer handoff + privacy review obligations.
**Finding:** T10 tests use in-memory harness only. T10.1 must ship pgTAP / real-Supabase tests for the inspection-sync Edge Function and the audit-emit paths.
**Resolution scope (T10.1):** Edge Function verifies `client_integrity_tag` non-null at write time; audit-emit-before-INSERT ordering.
**Blocker for:** T10.1 PR submission.

### G-T10-7 — ADR-0016 schedule rows for T10 operational tables
**Source:** privacy T10 cross-cutting; HG-15.
**Finding:** Six new fields/tables need ADR-0016 schedule rows + §PI inventory amendments: `inspections.client_integrity_tag`, `inspections.sequence_number`, `inspections.actor_id`, IDB `inspection_queue` store, IDB `rejected_queue_entries` store. Plus a companion ADR-0013 note on IDB lifecycle (X-Data-Class rules apply to persistent IDB).
**Resolution scope (T10.1):** architect amendment; HG-15 user re-ratification.
**Blocker for:** T10.1 PR submission.

### G-T10-8 — flushOfflineAudit() route contract
**Source:** privacy T10 cross-cutting B; second-opinion concern about recursive audit failure (now half-fixed in code; full route lands in T10.1).
**Finding:** Today's harness writes audit rows directly via `store.emitAudit`. Production POSTs to `/api/audit/queue`. The route MUST: (a) be in the SW non-cacheable list (already enforced by `/api/**` early-reject); (b) set `actor_pseudonym` server-side from JWT (not client-supplied — prevent forgery); (c) be rate-limited (since SW-side cache violations can be high-volume).
**Resolution scope (T10.1):** ship `/api/audit/queue/+server.ts` with the contract above.
**Blocker for:** T10.1 PR submission.

### G-T10-9 — Real ServiceWorker module
**Source:** implementer handoff; second-opinion concern 8.
**Finding:** `apps/web/src/lib/sw/index.ts` is library-only. Production needs a real `service-worker.js` SvelteKit/Vite entry consuming the lib; install/activate/fetch handlers wired to `caches` + `clients.matchAll`. Snapshot test runs against real Cache Storage in a Playwright environment.
**Resolution scope (T10.1):** real SW entry + Playwright integration test.
**Blocker for:** T10.1 PR submission.

### G-T10-10 — PhotoCaptureSurface.svelte full UI
**Source:** implementer handoff; privacy T10 cross-cutting A.
**Finding:** Current scaffold is 49 lines. Full UX (capture → preview → sanitize → encrypt → enqueue) lands in T10.1 with design tokens, interactive states, reduced-motion, dark-mode. Must re-confirm: no EXIF preview, no `navigator.geolocation`, always route through `sanitizePhoto()` before `encryptPayload()`.
**Resolution scope (T10.1):** designer/implementer collab; closes T10-A1/T10-D1/G-T10-3 user-facing pieces.
**Blocker for:** T10.1 PR submission.

### G-T10-11 — Pinned hex KAT for queue HMAC
**Source:** second-opinion-reviewer T10 Concern 6.
**Finding:** `apps/web/test/T10/offline-queue-hmac.test.ts:151-164` asserts `tag === tag2` (idempotency), not a pinned hex KAT. A libsodium-wrappers regression or subtle byte-order bug would produce two consistent-but-wrong tags; test still passes.
**Resolution scope:** add `expect(Buffer.from(tag).toString('hex')).toBe('<pinned-hex>')` with fixed inputs (e.g., idPriv = 32×0x42, user_id = SYNTHETIC_USER_A bytes, seq=1, ciphertext = "deadbeefcafe").
**Blocker for:** none directly; defense-in-depth.

### G-T10-12 — HKDF device_id missing from queue-hmac KDF info
**Source:** security-reviewer T10 Advisory 1.
**Finding:** ADR-0014 specifies `K_hmac = crypto_generichash(key=identity_privkey, msg=user_id || device_id, personalisation='jhsc.queue.hmac.v1')`. Implementation omits `device_id_bytes` (`queue-hmac.ts:48-62`). In-MAC `user_id` binding provides cross-device replay defense, but ADR-0014 verbatim has device_id.
**Resolution scope:** either (a) include `device_id_bytes` in the KDF info to match ADR-0014, OR (b) update ADR-0014 to record that `device_id` was dropped intentionally with rationale (the in-MAC `user_id` is load-bearing).
**Blocker for:** architect adjudication; T10.1 closure.

### G-T10-13 — Test-mutator SessionIdbControl exposed unconditionally
**Source:** security-reviewer T10 Advisory 2.
**Finding:** `apps/web/src/lib/inspections/queue.ts:420` (`session.idb = makeIdbControl(session)`) attaches mutators on every session object regardless of build/env. Benign in library context; in production a UI/extension/devtools surface could call them.
**Resolution scope:** gate behind `import.meta.env.MODE === 'test'` OR split into `queue.testing.ts` that production never imports.
**Blocker for:** T10.1 production deploy.

### G-T10-14 — Sequence-gap contiguity false-positive on re-enqueue-after-empty
**Source:** security-reviewer T10 Advisory 3.
**Finding:** After a successful drain `session.entries = []` but `next_seq` advances. Subsequent enqueue/drain has only seq=N; the gap-check loop walks 1..N-1 and rejects missing predecessors (now-empty queue). Tests don't exercise enqueue-after-drain. Fail-closed (over-rejects), but functionally broken post-drain.
**Resolution scope:** track `drained_seq` watermark; start gap-check at `drained_seq+1` (the implementer comment at `:249-254` already anticipates this).
**Blocker for:** T10.1 production deploy.

### G-T10-15 — Server-side `auth.uid() === shipment.user_id` cross-check
**Source:** security-reviewer T10 Advisory 5.
**Finding:** Server-side `inspection.synced` audit row carries `actor_pseudonym`. The implementer should verify the JWT-bound user_id equals the shipment's `user_id` field before emit. Today the harness writes blindly.
**Resolution scope (T10.1):** server-side handler MUST cross-check `auth.uid() === shipment.user_id`; reject mismatch with 403 + audit row `inspection.user_id_mismatch`.
**Blocker for:** T10.1 PR submission.

### G-T10-16 — Module-level `pendingViolations` singleton
**Source:** second-opinion-reviewer T10 Concern 7.
**Finding:** `apps/web/src/lib/sw/index.ts:158` is a module-level array shared across process. Real SW is per-origin singleton, so non-issue in production, but the harness lacks isolation (relies on `tearDown` ordering).
**Resolution scope:** bind to `CachesLike` instance OR document the intentional module-scoped behaviour.
**Blocker for:** none. Cleanup.

### G-T10-17 — `enqueueInspection` return-code conflation
**Source:** second-opinion-reviewer T10 Concern 4.
**Finding:** When `k_hmac === null` AND queue is not full, enqueue returns `{ status: 'rejected_queue_full' }` — semantically wrong. Caller cannot distinguish "queue full" from "no session key."
**Resolution scope:** add `rejected_no_session_key` status; update tests.
**Blocker for:** none. Polish.

### G-T10-18 — Aggregation policy for A-QUEUE-001 alert
**Source:** implementer handoff.
**Finding:** A-QUEUE-001 fires per-row in the harness. Production wire should aggregate (e.g., >5 in 10min) to avoid alert storms.
**Resolution scope:** observability-setup amendment; alerts.md update.
**Blocker for:** none. Operational polish.

### G-T10-19 — `inspect_quarantine()` user-visible UI
**Source:** implementer handoff.
**Finding:** Today returns `[]`. T10.1 wires an IDB quarantine store with a "View failed entries" link in the offline.partial banner.
**Resolution scope (T10.1):** IDB quarantine store + UI surface.
**Blocker for:** T10.1 PR submission.

---

## How to use this file

- When working on T05.1 / production wire-up: search for `G-T05-*` and resolve them in a single pass.
- When working on T07.1 / production wire-up: search for `G-T07-*` and resolve them in a single pass.
- When working on T08.1 / production wire-up: search for `G-T08-*` and resolve them in a single pass.
- When working on T16: search for `G-T05-6`, `G-T05-7`, and the retention-sweep entries under any task.
- When working on T02 ingest path: address `G-T05-4` before T05.1 ships.
- New gaps from future reviewers append at the bottom under their task heading.
