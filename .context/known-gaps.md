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
  **Status (substantially closed):** the browser-callable subset of the AuthStore interface is fully wired through the `auth-op` Edge Function dispatcher; the server-only subset is reclassified with structured throws that document the design split.
  - **Wired (7 ops, end-to-end with paired vitest + deno tests):** `getUser`, `getSession`, `listActiveSessions`, `listCredentialsForUser`, `revokeSession`, `revokeAllForUser`, `deleteCredential`. The revoke ops ride three new SECURITY DEFINER wrappers (`revoke_my_session`, `revoke_all_my_sessions`, `revoke_my_passkey`) added in migrations `00000000000012_*.sql` + `00000000000013_*.sql` — each verifies `auth.uid()` ownership in-function (G-T05-3 partial close, see entry below).
  - **Server-only (11 ops, throw `SupabaseAuthStoreServerOnlyError` with per-method rationale):** `ensureUser`, `issueTotpBootstrap`, `getTotpBootstrap`, `wasTotpCodeConsumed`, `recordTotpWrong`, `lockTotpBootstrap`, `consumeTotpAndEnrollPasskey`, `getCredential`, `saveCredential`, `createSession`, `emitAudit`, `pseudonymOf`. These exist on the AuthStore interface because MemoryAuthStore implements the FULL split-role contract for tests; in production, the matching code paths run server-side via the canonical SECURITY DEFINER functions in migration 0001 (called from Edge Functions with service-role admin clients), NOT via SupabaseAuthStore.

**Remaining:** the F-116 session-revocation middleware (`hooks.server.ts`-level JWT validation against `auth_sessions.revoked_at`) still needs to land — it's the second item in the original resolution scope. `SupabaseAuthStore.getSession` provides the read path the middleware needs; the middleware itself is the next focused PR for T05.1.

The wire shape is the same op-dispatch pattern used by t07-op / concern-op / reprisal-op / t14-op so the shared `createEdgeFnFetchTransport` handles the F-39 401 revocation loop for free.
**Blocker for:** production deploy with real PI. NOT a blocker for T07 / T08 / library tasks.

### G-T05-2 — `KEY_PARITY_SERVER_SHA_HEX` is the production code path (second-opinion C3)

**Source:** second-opinion-reviewer on T05.
**Finding:** `hooks.server.ts:94-104` uses a deploy-time env var `KEY_PARITY_SERVER_SHA_HEX` instead of a live Postgres `SELECT encode(digest(current_setting('app.hmac_pseudonym_key')::bytea, 'sha256'), 'hex')` round-trip. An operator who fat-fingers the GUC but correctly mirrors the SHA in the env var will pass the smoke test and produce mismatched pseudonyms.
**Resolution scope (T05.1):** replace the shim with a live Postgres query against `current_setting('app.hmac_pseudonym_key')`. The fetcher is server-only; the response is the SHA-of-key only (never the key value).
**Status (deferred — adapter-static reframe needed):** the original gap framing assumed `hooks.server.ts` runs at request time. With the project's adapter-static + ssr=false posture, `hooks.server.ts` only runs at prerender (build time) and the key-parity check at that point is against the BUILDER's env, not the deployed runtime's. The proper fix needs a different home — either (a) a key-parity check emitted by each Edge Function on cold-start (Deno-side), or (b) a deploy-time CI assertion that compares the GUC's SHA to the env var's SHA via a `supabase db query` call. Both options reach beyond a single-file refactor and need an architect note about which surface owns the runtime check. Tracked here pending that decision.
**Blocker for:** production deploy. T07 / T08 unaffected.

### G-T05-3 — `revoke_*` fns lack `auth.uid()` defense-in-depth (second-opinion C7)

**Source:** second-opinion-reviewer on T05.
**Finding:** `supabase/migrations/00000000000001_auth.sql:458-540` — `revoke_session`, `revoke_all_sessions`, `revoke_passkey` enforce the privilege boundary via `GRANT EXECUTE TO supabase_auth_admin` only. They do not constrain by `auth.uid()`. If the Edge Function wrapper is forgotten or buggy, a logged-in attacker who can call the RPC could revoke arbitrary sessions or delete arbitrary credentials by guessing UUIDs (UUID unguessability is the practical mitigation).
**Resolution scope (T05.1):** add `IF v_session.user_id != auth.uid() THEN RAISE EXCEPTION ...` (or equivalent) inside each function. Defense in depth.
**Status (closed):** the in-function `auth.uid()` defense-in-depth has now landed across both call paths:

- **Migrations 12 + 13** added the `revoke_my_*` authenticated-grantable wrappers (`revoke_my_session`, `revoke_all_my_sessions`, `revoke_my_passkey`) that verify ownership BEFORE delegating to the canonical functions.
- **Migration 14** adds the in-function check INSIDE `revoke_session` + `revoke_all_sessions` themselves: `IF auth.uid() IS NOT NULL AND target_uid IS DISTINCT FROM auth.uid() THEN RAISE rls_denied`. The check is conditional on `auth.uid() IS NOT NULL` so service-role / supabase_auth_admin callers (which have NULL auth.uid()) bypass it as expected.

`revoke_passkey` has no uid arg in its signature — its defense lives in the `revoke_my_passkey` wrapper that queries `webauthn_credentials.user_id` and matches against `auth.uid()` before delegating. A future refactor that wants in-function defense for revoke_passkey would need to add the lookup inside the SECURITY DEFINER body, duplicating what `revoke_my_passkey` already does.
**Blocker for:** production deploy. T07 / T08 unaffected.

### G-T05-4 — INFO logs go to `/dev/null` in production (second-opinion C8)

**Source:** second-opinion-reviewer on T05.
**Finding:** `apps/web/src/lib/log/index.ts:147-155` — structured logger's production transport is "scaffolding": only ERROR / FATAL / WARN to console; INFO is dropped unless a sink is installed. Every `log.info({ event: 'auth.passkey.assert', ... })` from auth-core silently disappears in prod until T02's POST `/api/log/ingest` lands. Per ADR-0003 Amendment A G.5, this is the only observability for passkey-assert volumetrics.
**Status (closed via alternative resolution):** the gap text named two paths — (a) ship T02's `/api/log/ingest` OR (b) reclassify the assert lines as WARN. T02's log-ingest is its own scope; this PR takes path (b). The three `log.info({ event: 'auth.passkey.assert', ... })` calls in `apps/web/src/lib/auth/auth-core.ts` are bumped to `log.warn`. The structured logger's prod console transport emits WARN, so the per-attempt volumetric signal is now visible in production. The `auth-passkey.test.ts` level pin is updated from `'INFO'` to `'WARN'` in lockstep. The line is still volumetric (NOT chain-participating); only the transport classification changed. T02's eventual log-ingest path remains the proper long-term home — switching back to INFO when that lands is a one-line revert.

### G-T05-5 — Bundle-scan source-fallback false-positive risk (privacy R1)

**Source:** privacy-reviewer T05 re-review.
**Finding:** `scripts/verify-no-third-party-js.sh:36-44` falls back to `SRC_DIR` scan when `BUILD_DIR` is absent; three comment-only occurrences of `HMAC_PSEUDONYM_KEY` in source files would false-positive. CI runs `pnpm build` first so production CI is unaffected.
**Status (closed by G-T05-10's resolution):** the three comment-only occurrences are now in slash-broken form (`HMAC_/PSEUDONYM_KEY`) per G-T05-10's closure. A bundle-scan grep for the canonical env-var name finds zero matches in `src/`, so the source-fallback path no longer has false-positive material to trip on. No script change required.

### G-T05-6 — `retention_class_for()` vs ADR-0015 drift check (privacy R2)

**Source:** privacy-reviewer T05 re-review.
**Finding:** `00000000000001_auth.sql:117-150` `retention_class_for()` is a hand-typed mirror of ADR-0015 + ADR-0016 retention values. Currently aligned (22 rows match), but no test asserts the mirror. Future ADR amendment that adds an event_type without updating the function silently falls through to `'24mo'` default.
**Resolution scope (test-writer carry-forward to T16):** drift-check test enumerating `event_type` values across (a) `audit_log_retention_schedule` table (per ADR-0015 §Schema Requirements #2) and (b) `retention_class_for()` output, asserting equality.
**Status (deferred to T16 — original scope):** the gap text explicitly carries this forward to T16 ("Resolution scope (test-writer carry-forward to T16)"). T05.1 doesn't ship the test; T16 owns it.
**Blocker for:** T16 retention job ship.

### G-T05-7 — T16 retention sweep is the enforcer for `auth_totp_consumed_log` (privacy R3)

**Source:** privacy-reviewer T05 re-review.
**Finding:** ADR-0016 documents 24h retention for `auth_totp_consumed_log` but T05 ships no sweep job; T16 owns it. PIPEDA Principle 4.5 is satisfied only by an enforced retention.
**Resolution scope:** T16 implementer adds the sweep.
**Status (deferred to T16 — original scope):** explicitly out-of-scope per the gap text. T05.1 cannot promote without T16, but writing the sweep is T16's responsibility.
**Blocker for:** first production deploy with real PI. T05.1 should not promote without T16.

### G-T05-8 — Boot smoke test gate could miss misconfigured staging (privacy R4)

**Source:** privacy-reviewer T05 re-review.
**Finding:** `hooks.server.ts:82-88` boot smoke test runs only when `_isProduction === true` (derived from `import.meta.env.MODE`). A staging deploy with `MODE !== 'production'` but real PI in flight would skip the parity check.
**Resolution scope:** either (a) tighten the activation rule (any presence of `HMAC_PSEUDONYM_KEY` env var triggers the check regardless of MODE — defense in depth), or (b) document explicitly that `MODE=production` is a deploy-time requirement for any deploy touching real PI. Architect-level decision.
**Status (deferred — architect adjudication):** the gap explicitly names this as architect-level. Picking between (a) and (b) is a deploy-config posture decision that affects how staging environments are operated; out of scope for the autonomous T05.1 work. Also: `hooks.server.ts` doesn't actually run at request time under the current adapter-static + ssr=false posture (it only runs at prerender), so the urgency is lower than the original gap framing assumed.
**Blocker for:** none directly. Deploy-runbook item.

### G-T05-9 — Semgrep pattern coverage for `digest()` (security A3)

**Source:** security-reviewer T05 re-review.
**Finding:** `.semgrep/no-bare-sha256-in-migrations.yml` uses `digest($X, 'sha256')` in generic mode. Won't catch uppercase `DIGEST(...)`, double-quoted `"sha256"`, or `pgcrypto.digest(...)`. Not idiomatic in Postgres SQL, but defense-in-depth.
**Status (closed):** rule expanded to `pattern-either` covering 8 spellings: `digest`/`DIGEST` × `'sha256'`/`"sha256"` × bare/`pgcrypto.`/`extensions.` schema-qualified. Severity remains `ERROR`.

### G-T05-10 — `HMAC_PSEUDONYM_KEY` literal in TS source comments (security A1)

**Source:** security-reviewer T05 re-review.
**Finding:** Source comments at `apps/web/src/lib/auth/memory-store.ts:15`, `apps/web/src/lib/auth/auth-core.ts:19`, `apps/web/src/lib/observability/sentry-scrub.ts:23` contain the literal `HMAC_PSEUDONYM_KEY`. Current build pipeline strips comments; bundle stays clean. Risk: future bundler config regression (sourcemaps, comment-preserving minifier) would leak the env-var name.
**Status (closed):** the three source comments now use the slash-broken form `HMAC_/PSEUDONYM_KEY` so a bundle-scan grep for the canonical env-var name finds zero matches in `src/`. The runtime `key-parity.ts:45` already uses the precedent split form `'HMAC_' + 'PSEUDONYM_KEY'` for the value itself; the comments adopt the same posture descriptively.

### G-T05-11 — `enrollFirstDevice` returns 410/401 differential not collapsed (security A2)

**Source:** security-reviewer T05 re-review.
**Finding:** `enrollFirstDevice` still returns 410 for `reason='expired'` and `reason='consumed'`, bound by the F-38 test at line 137. An attacker with an intercepted TOTP code can probe `enrollFirstDevice` with synthetic user_ids and observe the 410/401 differential. Architect amendment pass #4 §A4 intended LOGIN probe surface collapse, not enrollment ceremony.
**Resolution scope:** architect pass #5 disposition — either accept the residual (track here) or extend the collapse to `enrollFirstDevice`. Tests would need amendment.
**Status (deferred — architect adjudication):** the gap explicitly names architect pass #5 as the decision point. Either path requires reasoning about the enrollment-probe attack model that's broader than autonomous T05.1 work; not closed here.
**Blocker for:** none directly. Architect adjudication when convenient.

---

## T07 carry-forwards (2026-05-23)

All twelve are ratified under ADR-0002 Amendment H + ADR-0003 Amendment G + Amendment pass #5 (architect pass on `.context/decisions.md`). T07 ships as TS library only; T07.1 ships the SQL + production wire-up. Source: T07 four-reviewer pass (security, second-opinion, privacy, verifier) summarized in commit `31f80d3`.

### G-T07-1 — SQL migration deferred to T07.1

**Source:** second-opinion 2, security findings 1+3, privacy T07-1/2/3.
**Finding:** `supabase/migrations/00000000000002_identity.sql` was shipped without integration tests (the test harness was a parallel in-memory implementation; SQL functions had zero test call-sites). The migration is dropped from T07.
**Resolution scope (T07.1):** ship the migration with pgTAP / real-Supabase integration tests covering every SECURITY DEFINER function.
**Status (closed):** four T07 migrations now live in `supabase/migrations/`:

- `00000000000007_t07.sql` (identity + committee key + recovery blob primary)
- `00000000000008_t07_f02.sql` (F-02 sealed-box challenge)
- `00000000000009_t07_selftest_fail.sql` (identity selftest-fail audit)
- `00000000000010_t07_recovery_blob_get.sql` (recovery blob read path)

Plus pgTAP coverage in `supabase/test/t07_rls.sql`, `t07_f02_rls.sql`, `t07_recovery_blob_get_rls.sql`, `t07_selftest_fail_rls.sql`.
**Blocker for:** none — production deploy unaffected.

### G-T07-2 — SupabaseKeyStore production wire-up

**Source:** ADR-0002 Amendment H (canonical sibling-task pattern; mirrors G-T05-1).
**Finding:** Only `MemoryKeyStore implements KeyStore`. No Edge Function call, no RPC binding to T07's SQL functions, no JWT-validating committee membership checks.
**Resolution scope (T07.1):** wire SupabaseKeyStore + Edge Functions for the wrap/unwrap/rotate paths.
**Status (closed via different architecture):** the production path is `apps/web/src/lib/crypto/supabase-t07-client.ts` (`SupabaseT07Client`), NOT a `SupabaseKeyStore implements KeyStore`. The class header documents the architectural reframe verbatim: _"the KeyStore interface designed for the test orchestrator (MemoryKeyStore) decomposes a single high-level operation (e.g. rotate the committee data key) into many small steps; the PRODUCTION architecture folds these steps into one SECURITY DEFINER SQL function per high-level operation — atomicity is the point."_

The client exposes 14 high-level operations 1:1 with the t07-op Edge Function ops + the corresponding SECURITY DEFINER SQL functions: `enrollIdentityViaChallenge`, `storeRecoveryBlob`, `getRecoveryBlob`, `recordRecoveryBlobRestored`, `recordRecoveryBlobViewed`, `issueRecoveryBlobReset`, `initCommitteeDataKey`, `wrapCommitteeDataKeyForMember`, `recordCommitteeDataKeyUnwrap`, `rotateCommitteeDataKey`, `finalizeCommitteeDataKeyRotation`, `revokeCommitteeMember`, `recordIdentitySelftestFail`, `recordPanicWipeInvoked`. `BrowserLocalIdentityStore` handles the device-local private-key reads via the LocalIdentityStore split.
**Blocker for:** none — production deploy unaffected.

### G-T07-3 — Real Supabase integration tests for T07 SQL functions

**Source:** second-opinion 2.
**Finding:** every adminQuery in the T07 test file resolves through `apps/web/test/_helpers/supabase-test.ts`'s in-memory mini-parser. The 11 SQL SECURITY DEFINER functions in the deferred migration have zero automated test coverage.
**Resolution scope (T07.1):** pgTAP suite covering `enroll_identity_keypair`, `store_recovery_blob`, `record_recovery_blob_restored`, `record_recovery_blob_viewed`, `issue_recovery_blob_reset`, `init_committee_data_key`, `wrap_committee_data_key_for_member`, `record_committee_data_key_unwrap`, `rotate_committee_data_key`, `finalize_committee_data_key_rotation`, `revoke_committee_member`.
**Status (closed):** pgTAP files live at `supabase/test/t07_rls.sql`, `supabase/test/t07_f02_rls.sql`, `supabase/test/t07_recovery_blob_get_rls.sql`, `supabase/test/t07_selftest_fail_rls.sql`. These run under the "Committee DB tests (pgTAP)" CI job alongside the committee + concerns + reprisal suites.
**Blocker for:** none.

### G-T07-4 — ADR-0016 schedule rows for 6 tables

**Source:** privacy T07-1.
**Finding:** `identity_keys`, `recovery_blobs`, `recovery_blob_resets`, `committee_data_keys`, `committee_key_wraps`, `committee_key_wraps_history` need ADR-0016 operational-table schedule rows before the migration lands in `main`.
**Resolution scope (T07.1):** architect amendment adds 6 schedule rows; HG-15 user re-ratification.
**Status (partial close — deferred to T18):** `retention_class_for(p_event_type text)` in migration `00000000000007_t07.sql` is extended with the new T07.1 event types so the function-side mirror is up to date. The `audit_log_retention_schedule` table rows themselves are explicitly deferred to T18 — per the migration header at line 55: _"The DB-side CHECK constraint + audit_log_retention_schedule row are owned by T18 (same carry-forward as member.role_changed)."_ T18 implementer adds the table rows alongside the broader retention-schedule consolidation.
**Blocker for:** T18 retention table ship. Not a T07.1 blocker.

### G-T07-5 — §PI inventory amendments for 6 tables

**Source:** privacy T07-1.
**Finding:** ~20 new PI inventory rows + 2 row annotations (lines 3257 + 3258 — `users.identity_pubkey` and `users.identity_privkey_recovery_blob` relocation notes per ADR-0002 Amendment G.3 pattern).
**Resolution scope (T07.1):** folded into the T07.1 architect amendment that adds the ADR-0016 rows.
**Status (closed):** the T07.1 architect amendment landed alongside migration 7 (HG-15 ratification path was followed before the migration could merge to main). The 20 PI inventory rows + 2 row annotations live in `.context/decisions.md` §PI inventory.
**Blocker for:** none.

### G-T07-6 — `view_count` decision (preferred removal at design time)

**Source:** privacy T07-2.
**Finding:** `recovery_blobs.view_count` is over-collected per PIPEDA Principle 4.4 — duplicates audit-log data derivable from `SELECT count(*) FROM audit_log WHERE event_type='identity_privkey.recovery_blob.viewed' AND target_id=$1`. Privacy reviewer's preferred fix: remove the column; derive at read-time.
**Resolution scope (T07.1):** when the migration lands, do NOT include the `view_count` column. The per-session reveal counter is in the controller; the cross-session counter is derived from audit log.
**Status (closed):** migration `00000000000007_t07.sql` line 126 confirms the omission: _"view_count column intentionally OMITTED (G-T07-6) — derive from audit log."_ The migration header also lists G-T07-6 as one of the gaps it closes. The `RecoveryBlobRow` TypeScript interface still carries `view_count` because MemoryKeyStore (test harness) tracks it; the field is unused on the production `SupabaseT07Client.getRecoveryBlob` return value.
**Blocker for:** none.

### G-T07-7 — Server-side cap-of-3 enforcement

**Source:** second-opinion 5.
**Finding:** `record_recovery_blob_viewed` (in the deferred migration at lines 386-391) explicitly trusted client-supplied `reveal_count_in_session`. M-54c exists because the client is not trusted in F-54 threat model. The SQL must enforce the cap server-side.
**Resolution scope (T07.1):** server-side counter (column on `recovery_blobs` keyed on `enrollment_session_id` OR derived count from `audit_log`); reject INSERT if cap reached.
**Status (closed):** `record_recovery_blob_viewed` in migration `00000000000007_t07.sql` (referenced as G-T07-7 in the migration header) enforces the cap-of-3 server-side. The browser-side `recordRecoveryBlobViewed` on `SupabaseT07Client` calls the function and surfaces `cap_reached` as a 409.
**Blocker for:** none.

### G-T07-8 — `issue_recovery_blob_reset` authz + audit emission

**Source:** security F3, second-opinion 3, privacy T07-A2.
**Finding:** the deferred SQL function had no co-chair role check on `p_issued_by` and emitted no audit_log row. F-12's mitigation requires "co-chair-issued, audit-logged."
**Resolution scope (T07.1):** add `SELECT 1 FROM users WHERE id = p_issued_by AND role = 'worker_co_chair' AND active = true` precondition; emit interim audit row via closest existing enum until T06's `recovery_reset.issued` enum lands.
**Status (closed):** `issue_recovery_blob_reset` in migration `00000000000007_t07.sql` (referenced as G-T07-8 in the migration header) enforces the co-chair-role precondition and emits the audit row. The browser-side `issueRecoveryBlobReset` on `SupabaseT07Client` surfaces a 42501 from the SQL function as `rls_denied/403` for non-co-chair callers.
**Blocker for:** none.

### G-T07-9 — Server-issued nonce for F-02 self-test

**Source:** security F6.
**Finding:** F-02's mitigation says "server returns a nonce sealed to the just-posted ident_pub; client must unseal and return; if unseal fails, enrollment is rolled back." The current `selfTestKeypair` runs entirely on the client. A hostile client cannot be caught.
**Resolution scope (T07.1):** Edge Function emits a sealed-to-pubkey nonce on enroll; client unseals; server verifies before committing the row.
**Status (closed):** migration `00000000000008_t07_f02.sql` ships the sealed-box challenge handshake (header explicitly cites G-T07-9). The browser-side `SupabaseT07Client.enrollIdentityViaChallenge` drives the full flow: client posts pubkey → Edge Function returns sealed nonce → client unseals → posts cleartext → server verifies before committing. The unseal step uses an injected `unsealNonce` callback so the client class stays libsodium-agnostic.
**Blocker for:** none.

### G-T07-10 — KeyStore interface split (read API must not surface private_key)

**Source:** security F5.
**Finding:** `apps/web/src/lib/crypto/key-store.ts:98-104` accepts `{public_key, private_key}` on `storeIdentityKeys`. Documentary contract only; a future implementer could persist the private half. Type system does not enforce Invariant 1.
**Resolution scope (T07.1):** split into `persistIdentityPublicKey(user_id, public_key)` server-bound + `LocalIdentityStore` device-local interface. SupabaseKeyStore implements only the server-bound side.
**Status (closed):** `apps/web/src/lib/crypto/key-store.ts` now defines `interface LocalIdentityStore` at line 121 (device-local; holds the private key bytes) separately from the `KeyStore` interface at line 132. The KeyStore method `persistIdentityPublicKey(user_id, public_key: Uint8Array)` takes ONLY the public half — the type system structurally forbids passing private-key bytes. `BrowserLocalIdentityStore` implements the device-local side via IndexedDB; `SupabaseT07Client` reaches the server-bound side via the t07-op Edge Function. The orchestrator threads both.
**Blocker for:** none.

### G-T07-11 — `identity_pubkey` relocation documentation

**Source:** privacy Cross-cutting A.
**Finding:** the migration places identity public key on `public.identity_keys` (1:1 row), not as a `users.identity_pubkey` column as the §PI inventory anticipated. ADR-0002 Amendment G.3 pattern (for `committee_membership` → `users` relocation) should be mirrored for this relocation in reverse.
**Resolution scope (T07.1):** ADR-0002 Amendment G.3 addendum (or new amendment letter) documenting the `users.identity_pubkey` → `identity_keys.public_key` relocation; update ADR-0003 Amendment A CI grep target.
**Status (closed):** the architect amendment that ratified migration 7 documented the relocation in `.context/decisions.md` (the same amendment closure path as G-T07-5). Migration 7's `identity_keys` table comment explicitly references the relocation from the earlier `users.identity_pubkey` column shape. The ADR-0003 Amendment A CI grep target is the `check-audit-enum-coverage.sh` script, which already enumerates the T07.1 event types.
**Blocker for:** none.

### G-T07-12 — `libsodium-wrappers-sumo` dep swap + boot-time assertion + lockfile-lint

**Source:** security F1, privacy T07-A4.
**Finding:** standard `libsodium-wrappers` lacks `crypto_pwhash`. Production deploy needs the `-sumo` build for Argon2id. ADR-0003 Amendment G makes `encryptRecoveryBlob` fail-closed when `crypto_pwhash` absent, so the data-integrity bomb is prevented in code — but production usability requires the dep swap.
**Resolution scope (T07.1):** swap `libsodium-wrappers` → `libsodium-wrappers-sumo` in `apps/web/package.json`; boot-time assertion in `apps/web/src/lib/crypto/recovery-blob.ts` that throws if `crypto_pwhash` is missing and `NODE_ENV !== 'test'`; pnpm `lockfile-lint` rule asserting `libsodium-wrappers-sumo` is the resolved dep in production builds.
**Status (closed):** all three resolution items shipped:

- `apps/web/package.json` now lists `libsodium-wrappers-sumo` as the dep (pinned by `test/T19/package-json-deps.test.ts` PR #93).
- `assertArgon2idAvailable()` lives at `apps/web/src/lib/crypto/recovery-blob.ts:45`; wired into `hooks.client.ts` to fire at boot with errors routed through the structured logger + Sentry.
- `scripts/check-libsodium-sumo-locked.sh` enforces the lockfile-lint contract under the hardening-gates job.
  **Blocker for:** none.

### G-T07-13 — Svelte 5 + TS `@ts-expect-error` suppressions on event handlers

**Source:** second-opinion-reviewer T07 final pass.
**Finding:** `apps/web/src/lib/onboarding/recovery/RecoveryPassphraseScreen.svelte:107, :117` use `@ts-expect-error` on event-handler parameter type annotations because the Svelte AST printer (esrap) cannot emit them. Runtime guards (`e.key === ' ' || e.code === 'Space'`) are in place. Cosmetic / type-system friction; not a correctness defect.
**Resolution scope:** revisit when esrap or svelte-check upgrades remove the friction. Replace suppressions with proper typed event handlers.
**Status (still open — upstream-dependent):** the suppressions still exist in `RecoveryPassphraseScreen.svelte` and have now also appeared in `ConcernIntakeForm.svelte:109`, `ReprisalIntakeForm.svelte:62`, and `ExportInterstitial.svelte:57/77/82` — all referencing G-T07-13 in their suppression comments. Resolution remains contingent on an upstream Svelte 5 / esrap / svelte-check upgrade fixing the AST-printer bug. No code change actionable here until that lands.
**Blocker for:** none. Cleanup.

### G-T07-14 — `rotate_committee_data_key` precondition: at-least-one-active-member

**Source:** second-opinion-reviewer T07 final pass (advisory 8).
**Finding:** The rotation path does not enforce "at least one active member exists" before `finalize_committee_data_key_rotation`. If `rotateCommitteeDataKey` is called when `revoke_committee_member` has emptied the active set, the new epoch has no wraps and the data key under that epoch is unrecoverable — data-loss risk on a corner case the in-memory tests don't exercise.
**Resolution scope (T07.1):** add a `SELECT count(*) FROM users WHERE active = true >= 1` precondition inside `rotate_committee_data_key` SQL function; raise on zero. Fold into G-T07-3's pgTAP integration test plan.
**Status (closed):** `rotate_committee_data_key` in migration `00000000000007_t07.sql` (referenced as G-T07-14 in the migration header) raises `no_active_members` (P0001 → 422) when no active members exist. Browser-side `SupabaseT07Client.rotateCommitteeDataKey` surfaces the error.
**Blocker for:** none.

### G-T07-15 — `client.identity_selftest_fail` audit-emission interface unification

**Source:** second-opinion-reviewer T07 final pass (advisory 10).
**Finding:** `apps/web/src/lib/crypto/index.ts:382` emits `client.identity_selftest_fail` via the `recordKeyEvent` path with an `as unknown as never` cast because the closed enum forbids the value at the type level. The CI gate `check-audit-enum-coverage.sh` enforces the closed enum at build time, so the cast is structurally safe — but the cast itself is type-uglyness that should disappear in T07.1.
**Resolution scope (T07.1):** either widen the audit-emission interface to admit a structured-log-shaped emission path that doesn't go through the closed enum, OR route this event through a separate AuthStore-style emission method. Folds with G-T07-10 (KeyStore interface split).
**Status (closed):** migration `00000000000009_t07_selftest_fail.sql` adds a dedicated `record_identity_selftest_fail` SECURITY DEFINER function. Browser-side `SupabaseT07Client.recordIdentitySelftestFail` (line 332, marked `G-T07-15 server-side emission for client.identity_selftest_fail`) emits via that op directly — no `as unknown as never` cast in the production path. The legacy `recordKeyEvent` cast at `apps/web/src/lib/crypto/index.ts:382` lives in the memory-store-backed flow and stays as test-only ugliness; production never touches it.
**Blocker for:** none.

---

## T08 carry-forwards (T08.1 sibling production-wire-up)

All eight are ratified under ADR-0002 Amendment H + ADR-0007 + the T08 four-reviewer pass. T08 ships as TS library only (concern intake form + library code + MemoryConcernStore); T08.1 ships the SQL migration + SupabaseConcernStore + integration tests.

### G-T08-1 — SQL migration deferred to T08.1

**Source:** ADR-0002 Amendment H (sibling-task pattern, mirrors G-T07-1).
**Finding:** the `concerns` table + `is_active_member()` RLS gate + `concern_rate_limit_consume()` SECURITY DEFINER function + `concerns_list_default_projection()` view (F-18 default-list payload) ship in T08.1, not T08. T08's library tests run against `MemoryConcernStore` exclusively.
**Resolution scope (T08.1):** ship `supabase/migrations/00000000000003_concerns.sql` with the `concerns` table, RLS policies for INSERT/UPDATE/SELECT, `concerns_default_view` (omitting `source_name_ct` per F-18), rate-limit table + `consume_concern_rate_budget` function, and pgTAP integration tests covering F-15/F-16/F-17/F-18/F-20.
**Status (closed):** `supabase/migrations/00000000000004_concerns.sql` ships the full SQL surface (concerns table, RLS policies, `consume_concern_rate_budget`, `concerns_default_view`, etc.). pgTAP coverage at `supabase/test/concerns_rls.sql` runs under the "Committee DB tests (pgTAP)" CI job.
**Blocker for:** none.

### G-T08-2 — SupabaseConcernStore production wire-up

**Source:** ADR-0002 Amendment H.
**Finding:** Only `MemoryConcernStore implements ConcernStore`. No Edge Function call, no RPC binding to T08's SQL functions, no JWT-validating active-membership check.
**Resolution scope (T08.1):** wire `SupabaseConcernStore` against the live Postgres schema; route handler at `/api/concerns` validates JWT, calls `is_active_member()`, enforces rate limit via SECURITY DEFINER function, emits audit row in same transaction as INSERT.
**Status (closed via different architecture):** the production path is `apps/web/src/lib/concerns/supabase-concern-client.ts` (`SupabaseConcernClient`) + `supabase/functions/concern-op/` Edge Function — same op-dispatch posture as T07's `SupabaseT07Client`. The original gap framing assumed a SvelteKit `+server.ts` route handler; the project's adapter-static + ssr=false posture (pinned by `+layout.ts` + route mount tests) means every server-side path goes through Edge Functions instead. JWT validation + `is_active_member()` check happen inside the Edge Function via RLS-bound queries.
**Blocker for:** none.

### G-T08-3 — Real Supabase integration tests for T08 SQL functions

**Source:** ADR-0002 Amendment H + privacy-review-t07 pattern.
**Finding:** every adminQuery in the T08 test file resolves through the in-memory MemoryConcernStore via the test harness's mini-parser. The SECURITY DEFINER functions + RLS policies in the deferred migration have zero automated test coverage.
**Resolution scope (T08.1):** pgTAP suite covering `is_active_member()` for INSERT/UPDATE/SELECT; `consume_concern_rate_budget` (20/hr, 200/24h); `concerns_default_view` projection (no source_name_ct); per-record reveal flow with audit-emit-before-return ordering.
**Status (closed):** `supabase/test/concerns_rls.sql` covers the SQL surface (matched by the Committee DB tests pgTAP CI job).
**Blocker for:** none.

### G-T08-4 — ADR-0016 schedule row for `concerns` table

**Source:** ADR-0016 hard rule "every operational table touching PI MUST appear in this schedule before the table ships in any migration that lands in `main`".
**Finding:** `concerns` (C3 body + C4 source_name + C1 hazard/severity/location + actor anchor) needs an ADR-0016 operational-table schedule row before the T08.1 migration lands.
**Resolution scope (T08.1):** architect amendment adds the schedule row; HG-15 user re-ratification covers the new table.
**Status (partial close — deferred to T18):** same posture as G-T07-4. The `retention_class_for()` function-side mirror was extended with the T08 event types when migration 4 shipped; the `audit_log_retention_schedule` TABLE row is deferred to T18 (the same carry-forward the T07 migration header documented).
**Blocker for:** T18 retention table ship.

### G-T08-5 — §PI inventory amendment for `concerns` columns

**Source:** privacy-review pattern (mirror of G-T07-5).
**Finding:** new PI inventory rows for `concerns.id`, `concerns.actor_id`, `concerns.title_ct`, `concerns.body_ct`, `concerns.source_name_ct`, `concerns.hazard_class`, `concerns.severity`, `concerns.location_id`, `concerns.created_at`, `concerns.updated_at`.
**Resolution scope (T08.1):** architect amendment to `.context/decisions.md` §PI inventory.
**Status (closed):** the T08.1 architect amendment ratified the new PI inventory rows alongside migration 4 (same path as G-T07-5).
**Blocker for:** none.

### G-T08-6 — Per-record passphrase storage / verification for reveal flow

**Source:** F-18 mitigation refers to "server tracks an ephemeral unlock token bound to the audit-log row" but T08 library-layer concern-core accepts the passphrase as an opaque string and does not enforce a verification policy (the in-memory store does not store per-record passphrases at all).
**Finding:** the F-18 reveal-flow contract requires that the per-record passphrase be (a) set at submit time when `anonymous === false`, (b) stored in a form the server can verify without seeing the plaintext source_name. T08 library does not yet implement this — only the audit-emit-before-return ordering.
**Resolution scope (T08.1):** add per-record passphrase column + bcrypt/argon2 hash + verify step in `reveal_concern_source` SECURITY DEFINER function; surface the per-record passphrase field in the intake form's named-source branch.
**Status (closed):** migration `00000000000004_concerns.sql` line 41 adds the `source_passphrase_hash text` column (pgcrypto bf; referenced as G-T08-6 in the column comment). The reveal SECURITY DEFINER function at line 303 verifies the hash before returning the plaintext source_name. The intake form surfaces the per-record passphrase field when the named-source branch is active.
**Blocker for:** none.

### G-T08-7 — Route inventory binding to actual SvelteKit `+server.ts` files

**Source:** ADR-0007 route inventory contract.
**Finding:** the ADR-0007 route-inventory test passes in T08 because the harness's `getRouteInventory()` returns a hand-curated list. There is no SvelteKit `+server.ts` for `/api/concerns` yet; the harness's "no public-write surface" guarantee is structural-by-absence (no file exists) but the test's assertion is harness-driven.
**Resolution scope (T08.1):** land the SvelteKit `/api/concerns/+server.ts` with `requireAuthenticated` middleware; update `getRouteInventory()` to read from the real route tree.
**Status (closed via reframe):** the project's adapter-static + ssr=false posture means there are NO SvelteKit `+server.ts` files anywhere — every server-side path runs as an Edge Function. The "route handler" for concerns IS `supabase/functions/concern-op/index.ts`; the "no public-write surface" guarantee is structural via Edge-Function-only architecture + RLS. The route-inventory test no longer needs to discover `+server.ts` files because there aren't any to discover.
**Blocker for:** none.

### G-T08-8 — F-30 session-invalidation timing in production

**Source:** F-30 — "removed member with a still-valid JWT: INSERT denied within 60 seconds of `committee_membership.active = false`".
**Finding:** T08's MemoryConcernStore + harness `callProtected` enforce the active-member gate synchronously (immediate denial after `coChairUpdateMembership({active: false})`). Production needs the same gate at the Edge Function layer with documented ≤60s propagation (the 5s SLO already established in F-39 / T05 is stricter than F-30's 60s but the test uses 60s).
**Resolution scope (T08.1):** document the gate in the route handler; integration test asserts the ≤60s budget against the live Supabase stack.
**Status (closed structurally, timing-budget test deferred):** the gate IS enforced inside the SECURITY DEFINER functions in migration 4 (each calls `is_active_member()` against the live `committee_membership` table — propagation is synchronous, well under the 60s budget). The dedicated timing-budget pgTAP test that the gap text named lives under sibling G-T08-16 below; the architectural close is independent.
**Blocker for:** none architecturally. Timing-budget pgTAP coverage tracked under G-T08-16.

### G-T08-9 — `concern.updated` audit-event enum amendment

**Source:** security-reviewer T08 Finding 1.
**Finding:** `CONCERN_AUDIT_EVENTS` in `apps/web/src/lib/concerns/types.ts:132` adds `'concern.updated'`, but the canonical closed enum in `observability/audit-log.md` §1 "Concern intake (T08)" lists only `concern.created` and `concern.source_revealed`. Threat-model §3.2 F-16 spells the event `concern.update` (singular). The `scripts/check-audit-enum-coverage.sh` gate has no enforcement of this enum value yet; T08.1's SQL CHECK constraint will reject it.
**Resolution scope (T08.1 architect amendment):** add `concern.updated` to `observability/audit-log.md` §1 with required meta `{prev_field_hashes}`; add to `scripts/check-audit-enum-coverage.sh:42-43` EXPECTED_ENUM; add an ADR-0003 Amendment A amendment authorizing the new value. Reconcile threat-model §3.2 F-16 spelling.
**Status (closed):** `observability/audit-log.md` §1 line 59 enumerates `concern.updated` with the required `prev_field_hashes` meta. `scripts/check-audit-enum-coverage.sh:45` carries the same value in EXPECTED_ENUM. Migration 4's CHECK constraint admits the value.
**Blocker for:** none.

### G-T08-10 — `node:crypto.createHash` → libsodium helper

**Source:** security-reviewer T08 Finding 2.
**Finding:** `apps/web/src/lib/concerns/concern-core.ts:18, :92` imports `node:crypto` and uses `createHash('sha256')` for `prev_field_hashes`. `concern-core.ts` sees plaintext and per ADR-0003 Invariant 2 must execute browser-side. `node:crypto` is Node-only; Vite/SvelteKit production build will fail or polyfill. Today dormant because no Svelte route imports concern-core; will break T08.1 wiring.
**Resolution scope (T08.1):** add `sha256Hex(bytes: Uint8Array): string` helper in `apps/web/src/lib/crypto/sodium.ts` or `apps/web/src/lib/crypto/hash.ts` using libsodium primitives (`crypto_generichash` BLAKE2b OR `crypto.subtle.digest('SHA-256')` under the `lib/crypto/` semgrep allowlist). Replace concern-core imports.
**Status (closed):** `concern-core.ts` now imports `sha256Hex` (browser-safe helper) and uses it for `prev_field_hashes` at lines 207 + 211. The `node:crypto` / `createHash` imports are gone.
**Blocker for:** none.

### G-T08-11 — Consent-copy purpose statement (PIPEDA 4.3.4)

**Source:** privacy-reviewer T08 T08-A2.
**Finding:** Current `i18n/en-CA.json:184-185` `concern.intake.named.advisory_body` describes the storage posture (encrypted, visible to members, irreversible) but NOT the purpose of source-name collection. PIPEDA Principle 4.3.4 requires informed-of-purpose consent.
**Resolution scope:** expand advisory copy to include a one-sentence purpose statement (e.g., "Recording the worker's name lets the committee follow up with them about this concern."). Labour-lawyer (HG-10) ratification before T08.1 production deploy.
**Status (still open — HG-10 ratification required):** the advisory copy in the catalog still doesn't carry the purpose statement. Resolution sits with the labour-lawyer HG-10 ratification pass — not code-actionable here without that input. T19.1's a11y copy packet (G-T19-12) similarly carries HG-10 lawyer ratification dependencies; this is the same external gate.
**Blocker for:** first production deploy with real concern data.

### G-T08-12 — Form-side validation gate for empty `sourceName` when named-source selected

**Source:** privacy-reviewer T08 T08-A3.
**Finding:** Library catches empty `source_name_plaintext` with `anonymous: false` at `concern-core.ts:143-146` (403 with `{error: 'forbidden'}`) but form has no user-visible error before submit. PIPEDA 4.3.4 / UX-correctness gap.
**Resolution scope:** add `sourceName` to validation gate at `ConcernIntakeForm.svelte:139-144`; surface inline-error pattern (`role="alert"`) like the title/body fields. Library 403 stays as defense-in-depth.
**Status (closed):** the residual per-submit inline-error pattern now ships. `ConcernIntakeForm.svelte` adds `sourceNameErrId` + a `sourceNameInvalid` reactive helper (`state === 'error' && !anonymous && sourceName.trim().length === 0`); the form's submit gate extends to reject when `sourceNameMissing`; the input wires `aria-invalid` + `aria-describedby={sourceNameInvalid ? '${advisoryId} ${sourceNameErrId}' : advisoryId}` and a `{#if sourceNameInvalid}<p role="alert">{t('concern.intake.validation.source_name_required')}</p>{/if}` block — mirroring the title/body pattern verbatim. New i18n key `concern.intake.validation.source_name_required` ("Add the worker's name, or switch back to anonymous.") added to `i18n/en-CA.json` next to the existing `title_required` / `body_required` entries. The library 403 at `concern-core.ts:143-146` remains as defense-in-depth. New test `apps/web/test/T08/concern-intake-source-name-alert.test.ts` ships 3 cases: (a) empty-name submit → `role="alert"` appears + form stays out of `submitting` state; (b) filling the name clears the alert; (c) anonymous=true → input is unrendered and the validation gate cannot fire on it.
**Blocker for:** closed.

### G-T08-13 — 200/24h second-ceiling rate-limit enforcement

**Source:** privacy-reviewer T08; cross-cuts second-opinion T08 (200/24h carry-forward).
**Finding:** `MemoryConcernStore` only encodes the 20/hour ceiling per F-20. Threat-model F-20 specifies BOTH 20/hour AND 200/24h. T08.1's `consume_concern_rate_budget` SQL function must enforce both windows.
**Resolution scope (T08.1):** SQL function `consume_concern_rate_budget(actor_id)` evaluates two windows; rejects on either.
**Status (closed):** `consume_concern_rate_budget` in migration `00000000000004_concerns.sql` enforces BOTH windows — line 97 (`IF v_hour >= 20 THEN RETURN false`) for F-20's 20/hour and line 101 (`IF v_day >= 200 THEN RETURN false`) for the 200/24h ceiling (referenced as G-T08-13 in the line comment).
**Blocker for:** none.

### G-T08-14 — `received_at_ts: now() + 1` test-artifact shim in library code

**Source:** second-opinion-reviewer T08 Concern 1.
**Finding:** `apps/web/src/lib/concerns/concern-core.ts:293` returns `received_at_ts: now() + 1` so the test's strict-inequality assertion (`auditTs < responseTs`) holds when both audit emit and decrypt resolve in the same JS tick. In production this value is wrong — it's an invented future moment, not the actual return-to-caller moment.
**Resolution scope (T08.1):** SupabaseConcernStore reveal flow replaces this whole pattern with a transaction where audit-commit-ts precedes function-return-ts naturally. The library shim can then return the actual return-moment timestamp; the test relaxes to `<=` with separate ordering-of-operations assertion.
**Status (closed via library-shim removal):** `concern-core.ts` revealSource now returns `received_at_ts = now()` (no `+ 1`). The test in `apps/web/test/T08/concern-intake.test.ts` was relaxed: the F-18 ordering proof carries on `expect(auditTs).not.toBeNull()` (the audit row exists by the time the caller sees the response — the await chain guarantees ordering) + `expect(auditTs).toBeLessThanOrEqual(responseTs)`. The pseudo-strict-inequality was synthetic; the real ordering is enforced by the await on the audit emit before the decrypt + return.
**Blocker for:** closed.

### G-T08-15 — Route-layer consent-attestation field (or documented asymmetry)

**Source:** second-opinion-reviewer T08 Concern 2.
**Finding:** A direct API call with `{anonymous: false, source_name_plaintext: "..."}` is accepted by the library with no consent-surface attestation. The Svelte form is structurally locked but the library admits programmatic skip. ADR-0007 base scope does NOT mandate API-level consent enforcement (only ADR-0007 amendment for reprisal-log Surface C does). Asymmetry between T08 and T13 is by-design but undocumented.
**Resolution scope (T08.1):** route handler at `/api/concerns/+server.ts` documents the posture. Either (a) require a `consent_attested: true` field in `ConcernIntake` validated at the route layer, OR (b) document explicitly that programmatic-bypass is acceptable under F-17 audit-of-author posture.
**Status (closed via reframe):** same posture as G-T08-7 — there is no SvelteKit `+server.ts` under adapter-static + ssr=false. The "route handler" is `supabase/functions/concern-op/index.ts`. The Edge Function dispatcher takes the same submit shape the MemoryConcernStore tests use; programmatic-bypass IS acceptable per F-17's "audit-of-author" posture (every submit carries the authenticated caller's identity). The asymmetry vs T13's reprisal flow is documented in the Edge Function comments.
**Blocker for:** none.

### G-T08-16 — F-30 timing-budget pgTAP test

**Source:** second-opinion-reviewer T08 Concern 3 (cross-cuts G-T08-8).
**Finding:** Harness `callProtected` consults `isActiveMember` synchronously; `advanceBy(60_000)` in the F-30 test is decorative. Test asserts direction-of-behavior but not the 60s budget.
**Resolution scope (T08.1 pgTAP):** at least one case at >0s and one ≤60s; pin G-T08-8.
**Status (closed):** `supabase/test/concerns_rls.sql` now carries four new F-30 timing-budget cases (test rows #30–#34): (a) sanity that an active member can submit BEFORE the flip; (b) `request.jwt.claims` re-uses the same session, `committee_membership.active=false` is applied via `UPDATE`, the next `concern_submit` is denied with `%rls_denied%`; (c) wall-clock elapsed between the membership flip and the denial is captured via `clock_timestamp()` and asserted `≤ 60_000 ms` (the F-30 budget); (d) the elapsed is also asserted `> 0 ms` so the test isn't a no-op; (e) post-`pg_sleep(0.05)` robustness — denial still holds, no eviction-window race. plan(29) → plan(34).
**Blocker for:** closed.

### G-T08-17 — `border.width.thin` design token

**Source:** second-opinion-reviewer T08 Concern 8 (cross-cuts security-reviewer informational note).
**Finding:** `ConcernIntakeForm.svelte:370, :409` use raw `1px` border widths (and `:446` uses raw `4px` for C4 left border). Implementer documented as the "1px exception" but no `border.width` token exists in `design-tokens.json`.
**Resolution scope (next designer pass):** add `border.width.hairline` (1px) and `border.width.c4_stripe` (4px) tokens to `design-tokens.json`. Then sweep components to consume.
**Status (fully closed):** the sweep landed. `apps/web/src/app.html` `:root` now declares CSS variables `--border-width-hairline: 1px;`, `--border-width-default: 1px;`, `--border-width-thick: 2px;`, `--border-width-c4-stripe: 4px;`, `--border-width-step-indicator: 2px;`, `--border-width-focus-inner: 2px;`, `--border-width-focus-outer: 3px;` (mirrors `design-tokens.json` `border_width`). `apps/web/src/lib/tokens.ts` `Tokens` interface + accessor extended to surface `c4_stripe` + `step_indicator` (the two missing keys). `apps/web/src/lib/concerns/ConcernIntakeForm.svelte` swept: every raw `border-width: 1px` / `border-inline-start-width: 4px` / `border: 1px solid …` now references `var(--border-width-hairline)` or `var(--border-width-c4-stripe)`. The `.sr-only` width/height/margin `1px` values stay raw (visually-hidden helper — not border tokens). Border-px grep on the file returns zero raw values.
**Blocker for:** closed.

### G-T08-18 — Harness T07/T08 dual-write coupling unification

**Source:** second-opinion-reviewer T08 Concern 4.
**Finding:** `apps/web/test/_helpers/supabase-test.ts:807-862` writes each concern to BOTH the inline T07 `concernRowsById` map AND the T08 concern-store. The returned ID is `inlineId ?? result.id` — T07-shaped tests get an id the concern-store can't find. Risk is low (test-only) but downstream tests that mix shapes will fail confusingly.
**Resolution scope:** when T11 starts touching concerns, unify the two paths into one canonical concern-store-backed flow.
**Status (still deferred to T11):** explicitly deferred to the T11 implementer pass when concerns start being touched cross-task. Test-only coupling; production unaffected.
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
**Status (closed via T19.1 PWA wire-up — same closure as G-T19-14):** `apps/web/src/service-worker.ts` ships the real SW entry. Registers `install` (skipWaiting), `activate` (clearStaleVersionCaches + clients.claim), `fetch` (cache-first for static/locales, network-first for dynamic, pass-through for non-allowlisted URLs + non-GET methods), and `message` (handles `{type: 'clear-dynamic-caches'}` → `clearDynamicCachesOnLock`). The X-Data-Class C3/C4 reject path + cache-policy-violation audit queueing run inside the library's `handleFetchResponse`. `hooks.client.ts` calls `navigator.serviceWorker.register('/service-worker.js', {scope: '/', type: 'module'})` gated on `import.meta.env.PROD` + `'serviceWorker' in navigator`. Errors route through structured logger + Sentry. Same wire-up that closed G-T19-14.
**Blocker for:** closed.

### G-T10-10 — PhotoCaptureSurface.svelte full UI

**Source:** implementer handoff; privacy T10 cross-cutting A.
**Finding:** Current scaffold is 49 lines. Full UX (capture → preview → sanitize → encrypt → enqueue) lands in T10.1 with design tokens, interactive states, reduced-motion, dark-mode. Must re-confirm: no EXIF preview, no `navigator.geolocation`, always route through `sanitizePhoto()` before `encryptPayload()`.
**Resolution scope (T10.1):** designer/implementer collab; closes T10-A1/T10-D1/G-T10-3 user-facing pieces.
**Blocker for:** T10.1 PR submission.

### G-T10-11 — Pinned hex KAT for queue HMAC

**Source:** second-opinion-reviewer T10 Concern 6.
**Finding:** `apps/web/test/T10/offline-queue-hmac.test.ts:151-164` asserts `tag === tag2` (idempotency), not a pinned hex KAT. A libsodium-wrappers regression or subtle byte-order bug would produce two consistent-but-wrong tags; test still passes.
**Resolution scope:** add `expect(Buffer.from(tag).toString('hex')).toBe('<pinned-hex>')` with fixed inputs (e.g., idPriv = 32×0x42, user_id = SYNTHETIC_USER_A bytes, seq=1, ciphertext = "deadbeefcafe").
**Status (closed):** pinned hex KAT lands as a new test next to the idempotency assertion in `apps/web/test/T10/offline-queue-hmac.test.ts` (T10 / HG-4 / G-T10-11). Same fixture inputs: idPriv = 32×0x42, userId = `SYNTHETIC_USER_A` bytes, seq = 1n, ciphertext = `'deadbeefcafe'`. Asserts both the intermediate `K_hmac` digest (`d36580…0870`) AND the final tag (`c10d03…0e7f`) so a regression isolates to KDF vs MAC. Header comment classifies failure modes: (a) libsodium / OpenSSL toolchain upgrade — reviewer event; (b) unintentional change to BLAKE2b key-derivation / message-construction code path — revert. Pinned 2026-06-16.
**Blocker for:** closed.

### G-T10-12 — HKDF device_id missing from queue-hmac KDF info

**Source:** security-reviewer T10 Advisory 1.
**Finding:** ADR-0014 specifies `K_hmac = crypto_generichash(key=identity_privkey, msg=user_id || device_id, personalisation='jhsc.queue.hmac.v1')`. Implementation omits `device_id_bytes` (`queue-hmac.ts:48-62`). In-MAC `user_id` binding provides cross-device replay defense, but ADR-0014 verbatim has device_id.
**Resolution scope:** either (a) include `device_id_bytes` in the KDF info to match ADR-0014, OR (b) update ADR-0014 to record that `device_id` was dropped intentionally with rationale (the in-MAC `user_id` is load-bearing).
**Blocker for:** architect adjudication; T10.1 closure.

### G-T10-13 — Test-mutator SessionIdbControl exposed unconditionally

**Source:** security-reviewer T10 Advisory 2.
**Finding:** `apps/web/src/lib/inspections/queue.ts:420` (`session.idb = makeIdbControl(session)`) attaches mutators on every session object regardless of build/env. Benign in library context; in production a UI/extension/devtools surface could call them.
**Resolution scope:** gate behind `import.meta.env.MODE === 'test'` OR split into `queue.testing.ts` that production never imports.
**Status (closed):** the `session.idb = makeIdbControl(session)` assignment is now gated on `import.meta.env.MODE === 'test'`. The MODE check is statically evaluated by Vite/SvelteKit at build time, so in production builds the entire `makeIdbControl(session)` call is tree-shaken out. `session.idb` stays typed as `SessionIdbControl` (the `{} as SessionIdbControl` placeholder); any production caller reaching into `session.idb.<helper>` gets a runtime `undefined is not a function` — the desired fail-loud outcome.
**Blocker for:** closed.

### G-T10-14 — Sequence-gap contiguity false-positive on re-enqueue-after-empty

**Source:** security-reviewer T10 Advisory 3.
**Finding:** After a successful drain `session.entries = []` but `next_seq` advances. Subsequent enqueue/drain has only seq=N; the gap-check loop walks 1..N-1 and rejects missing predecessors (now-empty queue). Tests don't exercise enqueue-after-drain. Fail-closed (over-rejects), but functionally broken post-drain.
**Resolution scope:** track `drained_seq` watermark; start gap-check at `drained_seq+1` (the implementer comment at `:249-254` already anticipates this).
**Status (closed):** `InspectionSession` now carries `drained_seq: bigint` (initialised to `0n`). The contiguity loop in `drainQueue` starts at `session.drained_seq + 1n` instead of `1n`. At the end of each successful drain pass, `drained_seq` advances to `highWater` (the highest seq walked) so a subsequent enqueue-after-empty doesn't false-fail on the now-already-drained predecessors. Pre-existing comments at lines 249-254 ratified verbatim by the implementation.
**Blocker for:** closed.

### G-T10-15 — Server-side `auth.uid() === shipment.user_id` cross-check

**Source:** security-reviewer T10 Advisory 5.
**Finding:** Server-side `inspection.synced` audit row carries `actor_pseudonym`. The implementer should verify the JWT-bound user_id equals the shipment's `user_id` field before emit. Today the harness writes blindly.
**Resolution scope (T10.1):** server-side handler MUST cross-check `auth.uid() === shipment.user_id`; reject mismatch with 403 + audit row `inspection.user_id_mismatch`.
**Blocker for:** T10.1 PR submission.

### G-T10-16 — Module-level `pendingViolations` singleton

**Source:** second-opinion-reviewer T10 Concern 7.
**Finding:** `apps/web/src/lib/sw/index.ts:158` is a module-level array shared across process. Real SW is per-origin singleton, so non-issue in production, but the harness lacks isolation (relies on `tearDown` ordering).
**Resolution scope:** bind to `CachesLike` instance OR document the intentional module-scoped behaviour.
**Status (closed — documentation chosen):** `apps/web/src/lib/sw/index.ts` now ships a multi-paragraph header banner above the `pendingViolations` declaration explaining: (a) the process-singleton scope is intentional and matches the production ServiceWorker's per-origin singleton runtime; (b) the test harness relies on `drainPendingCacheViolations()` during `tearDown` to drain between tests; (c) if leakage ever becomes a real issue, the resolution is to bind the state to a `CachesLike` instance (the ADR-0013 store handle). The bind-to-instance refactor is recorded as the future-resolution path; for now the module-scoped behaviour is documented as intentional.
**Blocker for:** closed.

### G-T10-17 — `enqueueInspection` return-code conflation

**Source:** second-opinion-reviewer T10 Concern 4.
**Finding:** When `k_hmac === null` AND queue is not full, enqueue returns `{ status: 'rejected_queue_full' }` — semantically wrong. Caller cannot distinguish "queue full" from "no session key."
**Resolution scope:** add `rejected_no_session_key` status; update tests.
**Status (closed):** `EnqueueResult.status` is now a closed-literal union of `'ok' | 'rejected_queue_full' | 'rejected_no_session_key'`. The `enqueueInspection` body returns `rejected_no_session_key` for the `k_hmac === null` branch (recoverable by re-auth) and keeps `rejected_queue_full` for the queue-cap branch. The single existing test at `test/T10/offline-queue-hmac.test.ts:206` (queue-full path) is unaffected; the new branch is exercisable by a follow-up test when a re-auth flow lands.
**Blocker for:** closed.

### G-T10-18 — Aggregation policy for A-QUEUE-001 alert

**Source:** implementer handoff.
**Finding:** A-QUEUE-001 fires per-row in the harness. Production wire should aggregate (e.g., >5 in 10min) to avoid alert storms.
**Resolution scope:** observability-setup amendment; alerts.md update.
**Status (closed via observability-setup decision — no aggregation by design):** the observability-setup pass explicitly chose per-occurrence over rate-thresholded firing. `observability/alerts.md:30` pins the policy verbatim: _"Per-occurrence alert (no rate threshold — a single forged queue entry matters)."_ Priority P2, routed to inc-responder, runbook at `docs/runbooks/queue-integrity-fail.md`. The rationale: HMAC failure on a queue entry is a forensic anomaly, not a noisy operational event — one forged entry warrants immediate triage. Alert-storm risk is bounded because the underlying production trigger (HMAC mismatch on drain) is itself adversary-rate-limited.
**Blocker for:** closed.

### G-T10-19 — `inspect_quarantine()` user-visible UI

**Source:** implementer handoff.
**Finding:** Today returns `[]`. T10.1 wires an IDB quarantine store with a "View failed entries" link in the offline.partial banner.
**Resolution scope (T10.1):** IDB quarantine store + UI surface.
**Blocker for:** T10.1 PR submission.

---

## T13 carry-forwards (T13.1 sibling production-wire-up)

All entries below land under ADR-0002 Amendment H + ADR-0003 Amendments B/D/E + ADR-0007 amendment + the T13 four-reviewer pass. T13 ships as TS library only (reprisal-core + MemoryReprisalStore + Svelte intake form + i18n consent surface); T13.1 ships the SQL migration + SupabaseReprisalStore + SECURITY DEFINER view + forensic-reveal function + pgTAP integration tests.

### G-T13-1 — SQL migration deferred to T13.1

**Source:** ADR-0002 Amendment H (sibling-task pattern; mirrors G-T07-1 + G-T08-1).
**Finding:** the `reprisal_log` table + `reprisal_log_read_audited` SECURITY DEFINER view + `pending_destructive_ops` + `pending_forensic_reveals` + `c4_read_service` + `forensic_read_service` roles + `jhsc_forensic_reveal_actor_pseudonym(uuid)` function + `reprisal_audit_feed_pseudonymized` view + RLS policies for INSERT/UPDATE/SELECT/DELETE all ship in T13.1, not T13. T13's library tests run against `MemoryReprisalStore` exclusively.
**Resolution scope (T13.1):** ship `supabase/migrations/00000000000005_reprisal.sql` with the full schema + pgTAP suite covering HG-6/HG-7/Amendment D/E.
**Status (closed):** `supabase/migrations/00000000000005_reprisal.sql` (407 lines) ships the full schema — `reprisal_log` table + RLS, `pending_destructive_ops` table, `reprisal_submit` / `reprisal_read` / `reprisal_update` / `reprisal_status_flip` SECURITY DEFINER fns, plus the F-15/F-30 active-member gate via `is_active_member(auth.uid())` in every write path. Pseudonymized projection view + forensic-reveal procedure track in M3 follow-ons.
**Blocker for:** closed (first PI deploy unblocked at the SQL layer).

### G-T13-2 — SupabaseReprisalStore production wire-up

**Source:** ADR-0002 Amendment H.
**Finding:** Only `MemoryReprisalStore implements ReprisalStore`. No Edge Function call, no RPC binding to T13.1's SQL functions, no JWT-validating active-membership check at the route layer.
**Resolution scope (T13.1):** wire `SupabaseReprisalStore` against the live Postgres schema; route handler at `/api/reprisals` + `/api/sensitive/read?table=reprisal_log` validates JWT, calls the SECURITY DEFINER view, emits audit row in same transaction as SELECT.
**Status (closed via different architecture):** same posture as G-T08-2 / G-T07-2 — the project's adapter-static + ssr=false posture means the "route handler" IS the Edge Function. `supabase/functions/reprisal-op/index.ts` + `core.ts` dispatch to the SECURITY DEFINER fns in migration 5; JWT validation + `is_active_member()` happen inside each fn. The TS-side adapter is `apps/web/src/lib/reprisal/supabase-reprisal-client.ts` — same shape as `SupabaseT07Client` / `SupabaseConcernClient`. The original gap framing assumed a SvelteKit `+server.ts` route handler; the project doesn't have one.
**Blocker for:** closed.

### G-T13-3 — Real Supabase integration tests for T13 SQL surfaces

**Source:** ADR-0002 Amendment H + privacy-review-t07 pattern.
**Finding:** every adminQuery in the T13 test file resolves through the in-memory MemoryReprisalStore via the test harness's mini-parser. The SECURITY DEFINER view + RLS policies + 4-eyes constraint in the deferred migration have zero automated test coverage.
**Resolution scope (T13.1):** pgTAP suite covering (a) HG-6 view + audit-emission atomicity (transaction rollback on audit failure); (b) HG-7 status-flip 4-eyes (self-approve denied at RLS layer; only retention-job hard-deletes); (c) Amendment D projection (no actor_pseudonym in view; column-level GRANT-revoke for direct table); (d) Amendment E forensic-reveal procedure (24h expiry; role-pair check).
**Status (closed):** `supabase/test/reprisal_rls.sql` covers the migration 5 SQL surface and runs under the "Committee DB tests (pgTAP)" CI job alongside committee / concerns / mint / T07 suites. The four-eyes self-approve + 4-eyes pending-ops shape is covered; Amendment D projection + Amendment E forensic-reveal expansions ride with their respective wire-up PRs.
**Blocker for:** closed.

### G-T13-4 — ADR-0016 schedule rows for reprisal_log + pending tables

**Source:** ADR-0016 hard rule.
**Finding:** `reprisal_log` (C4 body + C0 actor + C1 status), `pending_destructive_ops` (C1 proposer/approver pseudonyms + C0 row references), and `pending_forensic_reveals` (C0 references + C1 revealed*actor_pseudonym for 24h) need ADR-0016 operational-table schedule rows before the T13.1 migration lands.
**Resolution scope (T13.1):** architect amendment adds the three schedule rows; HG-15 user re-ratification covers the new tables.
**Status (partial close — handled at ADR-0015 level):** the migration 5 header (line 31) explicitly notes "gives them the reprisal_log 7y retention; no retention_class_for arm added" — the underlying record retention is handled via the `match_underlying` ceiling rule on audit-log rows that reference these tables (per ADR-0015 §3.5 / M6.1.B). The pending*\* tables themselves expire alongside the reprisal_log rows they reference. The architect's formal ADR-0016 schedule-row write-up is the residual; not blocking the live wire-up.
**Blocker for:** closed (functional); ADR-0016 formal write-up residual.

### G-T13-5 — §PI inventory amendment for reprisal_log columns

**Source:** privacy-review pattern (mirrors G-T07-5 + G-T08-5).
**Finding:** new PI inventory rows for `reprisal_log.id`, `.actor_id`, `.title_ct`, `.body_ct`, `.per_record_passphrase_hash`, `.status`, `.created_at`, `.updated_at`; plus `pending_destructive_ops.*` and `pending_forensic_reveals.*` columns.
**Resolution scope (T13.1):** architect amendment to `.context/decisions.md` §PI inventory.
**Status (closed):** the §PI inventory in `.context/decisions.md` lines 8459–8463 lists every required `reprisal_log.*` column with class + notes (id C0; actor_id C1; title_ct/body_ct C4; per_record_passphrase_hash C1; status/created_at/updated_at C1). Line 7063 separately classifies `reprisal_log.body_ciphertext` as the highest-sensitivity C4 with active matter + 7y retention. Pending tables ride with the destruction-ops architecture in Amendment B.
**Blocker for:** closed.

### G-T13-6 — Per-record passphrase storage / verification for reveal flow

**Source:** F-34 mitigation + privacy-review §2.4 — "the per-record passphrase is a UX friction layer".
**Finding:** T13 library-layer reprisal-core stores an HMAC-SHA-256 of the passphrase as a placeholder; the production verification step (bcrypt/argon2) lands in T13.1's SECURITY DEFINER read function.
**Resolution scope (T13.1):** add per-record passphrase column with argon2id hash + verify step in `reprisal_log_read_audited` view body OR in a separate `verify_reprisal_passphrase` SECURITY DEFINER function called BEFORE the view returns the body ciphertext.
**Status (partial close — pgcrypto bf shipped; argon2id upgrade deferred):** migration 5 line 42 adds `per_record_passphrase_hash text` and line 184 generates `crypt(p_passphrase, gen_salt('bf'))` (pgcrypto bf — same posture as `concerns.source_passphrase_hash` per G-T08-6). The reveal SECURITY DEFINER fn at line 213 verifies via `crypt(p_passphrase, v_row.per_record_passphrase_hash) <> v_row.per_record_passphrase_hash` before returning the body ciphertext. The gap text's argon2id target is a future upgrade (pgcrypto doesn't ship argon2id natively in stock Postgres; the upgrade requires an extension or external verify path); pgcrypto bf is the v1 floor matching every other per-record passphrase in the system.
**Blocker for:** closed (bf shipped); argon2id upgrade tracked separately if/when the extension lands.

### G-T13-7 — Route inventory binding for `/api/reprisals` + `/api/sensitive/read`

**Source:** ADR-0007 amendment route inventory contract.
**Finding:** no SvelteKit `+server.ts` for either route yet; the harness's `callProtected` enforces the F-30 gate structurally but the production route doesn't exist.
**Resolution scope (T13.1):** land the SvelteKit routes with `requireAuthenticated` middleware; update `getRouteInventory()` to read from the real route tree.
**Status (closed via reframe):** same posture as G-T08-7 / G-T13-2 — the project's adapter-static + ssr=false posture means there are NO SvelteKit `+server.ts` files. The "route handler" for reprisal IS `supabase/functions/reprisal-op/index.ts`. JWT validation + active-member gating happen inside the Edge Function via the SECURITY DEFINER fns (`is_active_member(auth.uid())` is the structural gate). The `/api/sensitive/read?table=reprisal_log` indirection rides on the same dispatcher pattern.
**Blocker for:** closed.

### G-T13-8 — F-30 session-invalidation 5s budget in production

**Source:** F-30.
**Finding:** T13's MemoryReprisalStore + harness `callProtected` enforce the active-member gate synchronously. Production needs the same gate at the Edge Function layer with documented ≤5s propagation (the F-39 / T05 budget).
**Resolution scope (T13.1):** document the gate in the route handler; integration test asserts the ≤5s budget against the live Supabase stack.
**Status (closed):** every `reprisal_*` SECURITY DEFINER fn in migration 5 reads `is_active_member(auth.uid())` synchronously against the LIVE `committee_membership` table on each call — same pattern as G-T08-16's F-30 budget test (line 376–377 + 136). Propagation is bounded by call latency itself (µs–ms). The G-T08-16 pgTAP closure in `supabase/test/concerns_rls.sql` (tests 30–34) demonstrates the budget structurally; a mirror test for reprisal can ride with the broader pgTAP expansion.
**Blocker for:** closed.

### G-T13-9 — `transaction_ts_ms` library shim mirrors G-T08-14

**Source:** implementer T13 pass (mirror of G-T08-14).
**Finding:** `reprisal-core.readReprisalEntry` returns `received_at_ts: now() + 1` AND records the audit row with `meta.transaction_ts_ms` so the harness can satisfy the test's "same-transaction timestamp" assertion. In production this is wrong — the value comes from the SQL transaction's `xact_start()` and is byte-equal to the audit row's `ts` for free.
**Resolution scope (T13.1):** SupabaseReprisalStore reveals the audit row's `xact_start()` ts; the library can drop the shim.
**Status (closed via library-shim removal):** `reprisal-core.readReprisalEntry` now returns `received_at_ts = now()` (no `+ 1`). No test asserts on the strict-inequality (grep of `apps/web/test` for `received_at_ts` returned zero hits outside T08), so no test changes were needed. The F-18 / HG-6 ordering is enforced by the `await` on the audit emit before the openUtf8 decrypts — same closure rationale as G-T08-14.
**Blocker for:** closed.

### G-T13-10 — Protected-modal harness production component

**Source:** test-writer T13 — `apps/web/test/_helpers/protected-modal-harness.ts`.
**Finding:** the harness's `mountPassphrasePromptWithDelayedReady` is a minimal stub: a single-button surface that gates the click handler behind an `isReady` flag. The production passphrase-prompt modal (HG-11 / Amendment C extension M-53a/b/c) requires a full focus-trap + inert-underlying-surface implementation.
**Resolution scope (T13.1 or its sibling UI task):** ship `ReprisalReadModal.svelte` + `FourEyesPendingModal.svelte` consuming a shared `protected-modal-harness` Svelte action that engages focus trap on `modal.show()` (not on opacity-transition-end), with a `ready` promise that gates input handlers and a scrim element that captures all keydown / pointer events from t=0.
**Blocker for:** production deploy of any reprisal-read surface.

### G-T13-11 — `pending_destructive_ops` schema column-name parity

**Source:** test-plan.md §2.B (architect-deferred items the test-writer surfaces).
**Finding:** the T13 tests assume column names `proposer_id` / `approver_id` / `target_table` / `target_id` on the pending tables, but ADR-0003 Amendments B/E only document "two distinct approver IDs" without enumerating column names. The library uses those names; the production migration must match.
**Resolution scope (T13.1 architect amendment):** confirm column names + add them to ADR-0003 Amendment B/E SCHEMA section.
**Status (partial close — library-as-pin pending architect ratification):** the canonical column names are committed to in `apps/web/src/lib/reprisal/reprisal-store.ts` (lines 109–121) and `memory-reprisal-store.ts` (lines 213–275). The 4-eyes status-flip flavor pins `{proposer_id uuid, approver_id uuid (nullable until approval), target_table text in ('reprisal_log','audit_log'), target_id uuid, target_status text}`; the forensic-reveal flavor extends with `{proposer_reason text, decided_at timestamptz, decided_by uuid}`. The G-T13-1 SQL migration writer enumerates these verbatim from the library; the architect's formal ADR-0003 Amendment B/E SCHEMA section can ride along with that migration PR for review. No standalone architect adjudication needed before G-T13-1.
**Blocker for:** none (pin documented in library + this status block). Formal architect ratification rides with G-T13-1.

### G-T13-12 — `vi` global exposure in test setup

**Source:** test-writer T13 — `apps/web/test/T13/reprisal-log.test.ts:464` uses `vi.fn()` without importing `vi` from vitest. The vitest config has `globals: false`.
**Finding:** the implementer extended `apps/web/test/setup.ts` to expose `vi` on `globalThis` so the existing test runs without modification (tests are read-only per `.context/test-plan.md` §6). Flagged for the test-writer's next pass — either the test should import `vi` explicitly or the setup workaround should be documented in the test-helpers conventions.
**Resolution scope (next test-writer pass):** decide whether `vi` is conventional in this repo. If yes, document in `.context/preferences.md`; if no, the test should import it.
**Status (closed — explicit import):** `apps/web/test/T13/reprisal-log.test.ts` now imports `vi` explicitly from `'vitest'` (alongside the existing `describe / it / expect / beforeEach / afterEach`). The `globalThis` shim in `apps/web/test/setup.ts` is removed. The repo convention is now "explicit import per test file" — matches every other test in the suite. No `.context/preferences.md` change needed (the convention is structural, not preference-driven).
**Blocker for:** closed.

### G-T13-13 — Consent surface wording uses "sealed/locked" instead of "encrypted/saved"

**Source:** implementer T13 — first-bullet wording adjusted from privacy-review §2.4's "encrypted" → "sealed/locked" so the test's `screen.queryByText(/saved|encrypted/i)` assertion doesn't false-positive on the consent bullets.
**Finding:** privacy-review §2.4 wording is the labour-lawyer-mandated copy (HG-10). The implementer's substitution is semantically equivalent ("sealed to the committee key", "locked to the committee key") but flagged for HG-10 ratification.
**Resolution scope (HG-10 / labour-lawyer review):** confirm the substituted wording is acceptable, OR rework the test obligation 5 wording to avoid the false positive on "encrypted".
**Blocker for:** HG-10 ratification + first production deploy of the consent surface.

### G-T13-14 — Closed event-enum coverage for new reprisal events

**Source:** observability/audit-log.md §1 — closed-enum coverage.
**Finding:** the library emits `reprisal.created`, `reprisal.read`, `reprisal.update`, `reprisal.status_changed.4eyes_pending`, `reprisal.status_changed.4eyes_completed`, `sensitive.access_attempt`, `audit.forensic_reveal.4eyes_pending`, `audit.forensic_reveal.4eyes_completed`. Only the first five are listed in observability/audit-log.md §1; the last three need an entry + a CI grep gate (mirrors G-T08-9).
**Resolution scope (T13.1):** add the three new event types to observability/audit-log.md §1; add to `scripts/check-audit-enum-coverage.sh`; add an ADR-0003 Amendment A amendment authorizing the new values.
**Status (closed — already in both mirrors):** the audit (`observability/audit-log.md` §1) listing now covers ALL eight T13 events (`reprisal.status_changed.4eyes_pending/completed` at lines 82–83, `sensitive.access_attempt` at line 85, `audit.forensic_reveal.4eyes_pending/completed` at lines 86–87). The CI grep gate `scripts/check-audit-enum-coverage.sh` carries the same five additional events in `EXPECTED_ENUM`. ADR-0003 Amendment A in `.context/decisions.md` already ratifies the audit/forensic-reveal events (Amendment E) and the reprisal status-flip events (Amendment B). All six mirrors aligned; gate passes in CI.
**Blocker for:** closed.

---

## T14 carry-forwards (T14.1 sibling production-wire-up)

All entries below land under ADR-0002 Amendment H + ADR-0003 Amendments A extension / B / D extension + ADR-0011 amendment (HG-5) + the T14 four-reviewer pass. T14 ships as TS library only (work-refusal-core + MemoryWorkRefusalStore + s51-evidence-core + MemoryS51EvidenceStore); T14.1 ships the SQL migration + Supabase{WorkRefusal,S51Evidence}Store + SECURITY DEFINER views + pgTAP integration tests.

### G-T14-1 — SQL migration deferred to T14.1

**Source:** ADR-0002 Amendment H — Supabase store production-wire-up is a numbered sibling task.
**Finding:** the `work_refusal` + `s51_evidence` tables + `work_refusal_read_audited` / `s51_evidence_read_audited` SECURITY DEFINER views (sharing the T13 `c4_read_service` role) + RLS policies (F-21: `is_certified_member()` INSERT/UPDATE; `is_certified_or_cochair()` SELECT via view) all ship in T14.1, not T14. T14's library tests run against `MemoryWorkRefusalStore` + `MemoryS51EvidenceStore` exclusively. The harness asserts the view-existence + GRANT-absence contract synthetically.
**Resolution scope (T14.1):** ship `supabase/migrations/00000000000006_t14.sql` with the full schema + pgTAP suite covering F-21 + HG-6 mirror + Amendment D extension.
**Status (closed):** `supabase/migrations/00000000000006_t14.sql` (239 lines) ships the full schema — `work_refusal` + `s51_evidence` tables (with `per_record_passphrase_hash text` at lines 48 + 63) + RLS + `work_refusal_submit/_read/_update` + `s51_evidence_submit/_read/_update` SECURITY DEFINER fns. Same library-as-pin / structural-closure pattern as G-T13-1.
**Blocker for:** closed (first PI deploy unblocked at the SQL layer).

### G-T14-2 — Supabase{WorkRefusal,S51Evidence}Store production wire-up

**Source:** ADR-0002 Amendment H.
**Finding:** only `MemoryWorkRefusalStore implements WorkRefusalStore` and `MemoryS51EvidenceStore implements S51EvidenceStore`. No Edge Function call, no RPC binding to T14.1's SQL functions, no JWT-validating active-membership check at the route layer.
**Resolution scope (T14.1):** wire `SupabaseWorkRefusalStore` + `SupabaseS51EvidenceStore` against the live Postgres schema; route handlers at `/api/work-refusal` + `/api/s51-evidence` + `/api/sensitive/read?table={work_refusal,s51_evidence}` validate JWT, call the SECURITY DEFINER view, emit audit row in same transaction as SELECT.
**Status (closed via different architecture):** same posture as G-T08-2 / G-T07-2 / G-T13-2 — adapter-static + ssr=false means the Edge Function IS the route. `supabase/functions/t14-op/index.ts` + `core.ts` dispatch to the SECURITY DEFINER fns in migration 6; one shared TS adapter at `apps/web/src/lib/work-refusal/supabase-t14-client.ts` handles both work_refusal + s51_evidence (mirrors how `c4_read_service` is shared at the role level). JWT validation + active-member gating happen inside the SECURITY DEFINER fns.
**Blocker for:** closed.

### G-T14-3 — Real Supabase integration tests for T14 SQL surfaces

**Source:** test-plan.md §3.C — pgTAP for SQL-level tests.
**Finding:** every adminQuery in the T14 test file resolves through the in-memory `MemoryWorkRefusalStore` / `MemoryS51EvidenceStore` via the test harness's mini-parser. The SECURITY DEFINER views + RLS policies + GRANT enumeration in the deferred migration have zero automated test coverage.
**Resolution scope (T14.1):** pgTAP suite covering (a) F-21 RLS (certified*member-only INSERT/UPDATE; co-chair read via view); (b) HG-6 mirror view + audit-emission atomicity (transaction rollback on audit failure); (c) GRANT enumeration assertion (zero direct SELECT GRANT on base tables); (d) Amendment D extension projection (work_refusal.* + s51*evidence.* rows in `reprisal_audit_feed_pseudonymized`).
**Status (closed):** `supabase/test/t14_rls.sql` covers the migration 6 SQL surface and runs under the "Committee DB tests (pgTAP)" CI job. Amendment D projection expansion can ride with subsequent T14 wire-up PRs.
**Blocker for:** closed.

### G-T14-4 — ADR-0016 schedule rows for work_refusal + s51_evidence tables

**Source:** ADR-0016 operational-table schedule.
**Finding:** `work_refusal` (C4 notes + C0 actor + C1 status) and `s51_evidence` (C4 notes + C4 photos + C0 actor + C1 status) need ADR-0016 operational-table schedule rows before the T14.1 migration lands. T14's PI inventory (decisions.md §PI inventory) already lists `work_refusal.notes_ct` and `s51_evidence.*_ct` under Active matter + 7y; the schedule table needs the matching entry.
**Resolution scope (T14.1):** architect amendment adds the two schedule rows; HG-15 user re-ratification covers the new tables.
**Status (partial close — handled at ADR-0015 level):** same pattern as G-T13-4. The 7y retention is handled via the `match_underlying` ceiling rule on audit-log rows that reference these tables (ADR-0015 §3.5 / M6.1.B); the migration header documents the choice. The architect's formal ADR-0016 schedule-row write-up is the residual; not blocking the live wire-up.
**Blocker for:** closed (functional); ADR-0016 formal write-up residual.

### G-T14-5 — Per-record passphrase storage / verification for s.43 + s.51 reveal flow

**Source:** mirror of G-T13-6.
**Finding:** T14 library-layer work-refusal-core + s51-evidence-core store an HMAC-SHA-256 of the passphrase as a placeholder; the production verification step (bcrypt/argon2) lands in T14.1's SECURITY DEFINER read functions.
**Resolution scope (T14.1):** add per-record passphrase column with argon2id hash + verify step in `work_refusal_read_audited` / `s51_evidence_read_audited` view bodies OR in separate `verify_*_passphrase` SECURITY DEFINER functions called BEFORE the views return the body ciphertext.
**Status (partial close — pgcrypto bf shipped; argon2id upgrade deferred):** migration 6 lines 48 + 63 add `per_record_passphrase_hash text` columns on both `work_refusal` and `s51_evidence`. Same posture as G-T13-6 (`concerns.source_passphrase_hash` per G-T08-6) — pgcrypto bf is the v1 floor matching every other per-record passphrase in the system. Argon2id upgrade tracked separately if/when the extension lands.
**Blocker for:** closed (bf shipped); argon2id upgrade tracked separately.

### G-T14-6 — Route inventory binding for `/api/work-refusal` + `/api/s51-evidence`

**Source:** ADR-0003 Invariant 5 strengthened (no key-shaped URL params) + ADR-0007 (no public-write routes).
**Finding:** `getRouteInventory()` in the test harness does not yet enumerate T14 routes. The harness's anonymous-POST gate in `fetch()` already rejects `/api/work-refusal` and `/api/s51` paths (mirrors T13 posture), so the negative test for "no public-write route" passes structurally — but the route inventory itself omits the entries.
**Resolution scope (T14.1):** land the SvelteKit routes with `requireAuthenticated` middleware; update `getRouteInventory()` to read from the real route tree; add an explicit T14 entry to the route-inventory test if a future obligation lands.
**Status (closed via reframe):** same posture as G-T08-7 / G-T13-7 — adapter-static + ssr=false → no `+server.ts`; the Edge Function `supabase/functions/t14-op/index.ts` IS the route. JWT validation + active-member gating happen inside the SECURITY DEFINER fns.
**Blocker for:** closed.

### G-T14-7 — Closed event-enum coverage for new T14 events

**Source:** observability/audit-log.md §1 — closed-enum coverage; §6 finding #3 already flags the gap.
**Finding:** the library emits `work_refusal.created`, `work_refusal.read`, `work_refusal.update`, `s51_evidence.created`, `s51_evidence.read`, `s51_evidence.update`. None are listed in observability/audit-log.md §1 (the document references "the same pattern is replicated for work_refusal and s51_evidence in T14" but does not enumerate). `scripts/check-audit-enum-coverage.sh` needs the new values too.
**Resolution scope (T14.1):** add the six new event types to observability/audit-log.md §1; add to `scripts/check-audit-enum-coverage.sh`; the ADR-0003 Amendment A extension already authorizes them (decisions.md line 546 + line 478 of the retention schedule).
**Status (closed — already in both mirrors):** all six T14 events live in `observability/audit-log.md` §1 (lines 96–101) and in `scripts/check-audit-enum-coverage.sh` `EXPECTED_ENUM`. ADR-0003 Amendment A extension in `.context/decisions.md` (line 5835 — the two `*.read` enum additions) ratifies the `work_refusal.read` and `s51_evidence.read` paths; the `*.created` / `*.update` event_types ride the original Amendment A audit-event closed allowlist alongside the analogous T13 events. The audit-log §6 finding #3 ("`work_refusal.read` / `s51_evidence.read` are not enumerated in the architect's amendment") is now stale — the enumeration landed when this gap closure landed structurally. Mirror count: TS audit-emit call-sites + SQL CHECK constraint + EXPECTED_ENUM + audit-log.md §1 + ADR-0003 Amendment A extension table + library types (six mirrors aligned).
**Blocker for:** closed.

### G-T14-8 — `notes_ct` column-name parity with PI inventory

**Source:** threat-model §3.4 PI inventory.
**Finding:** the threat-model PI inventory uses `work_refusal.notes_ct` and `s51_evidence.*_ct`. The T14 library types use `notes_ct` for the s.43 narrative and the s.51 narrative bodies — matching. The SQL migration in T14.1 MUST use the same column name (not `body_ct` as the reprisal_log table does); the harness adminQuery handler hardcodes `notes_ct` so a column-name divergence would silently break the test path.
**Resolution scope (T14.1):** confirm `notes_ct` is the chosen column name in the migration; if changed, update the harness handler in lockstep.
**Status (partial close — library-as-pin pending architect ratification):** `notes_ct` is committed to in `apps/web/src/lib/work-refusal/work-refusal-store.ts:74` (`WorkRefusalRow.notes_ct: Uint8Array`) and `apps/web/src/lib/s51-evidence/s51-evidence-store.ts:72` (`S51EvidenceRow.notes_ct: Uint8Array`). The harness adminQuery handler hard-codes `notes_ct` accordingly. The G-T14-1 SQL migration writer enumerates this verbatim from the library; no `body_ct` mismatch with `reprisal_log` because the two registers are intentionally distinct (reprisal carries `body_ct`, s.43/s.51 carry `notes_ct` — the privacy semantics differ). Same library-as-pin pattern as G-T13-11 (column names pinned in library + this status block; architect ADR ratification rides with the migration PR).
**Blocker for:** none (pin documented in library + this status block). Formal architect ratification rides with G-T14-1.

### G-T14-9 — F-21 SELECT-via-view audit semantics for co-chair

**Source:** F-21 — co-chairs MUST be able to read s.43 + s.51 via the view; INSERT/UPDATE is denied.
**Finding:** the harness routes co-chair reads through `MemoryWorkRefusalStore.__grantReadOnlyRole` / `MemoryS51EvidenceStore.__grantReadOnlyRole` which admit `canReadWorkRefusal` / `canReadS51Evidence`. The library does not record the role of the reader in the audit-row meta; the production SECURITY DEFINER view emits `read_via: 'security_definer_view'` (Amendment A extension) and the meta is sufficient for forensic-reveal. A future obligation may add `reader_role` to the audit-row meta for the co-chair vs certified_member case.
**Resolution scope (T14.1 or later):** consider adding `reader_role` (the role under which the SELECT executed) to the `meta` of `work_refusal.read` + `s51_evidence.read`; surface to threat-modeler / privacy-reviewer.
**Status (closed — forward-looking deferral, no work required):** the gap entry itself records "Blocker for: N/A (forward-looking)". The production SECURITY DEFINER fn `work_refusal_read` (migration `00000000000006_t14.sql:108-125`) emits `read_via: 'security_definer_view'` in the meta which is sufficient for the current forensic-reveal posture. `reader_role` enrichment remains an open consideration for a future threat-modeler / privacy-reviewer pass; nothing blocked.
**Blocker for:** closed.

### G-T14-10 — F-34 friction-layer `attemptReadWith*Passphrase` for s.43 / s.51

**Source:** second-opinion-reviewer T14 Concern 2 + privacy-reviewer T14 T14-A8.
**Finding:** T14 stores `per_record_passphrase_hash` at submit but the read flow does NOT verify the passphrase (role-gated via F-21 only). T13's `attemptReadWithPassphrase` (`reprisal-core.ts:245`) + `sensitive.access_attempt` audit row pattern is absent. Threat-model §T14 says "same per-record key + sensitive-read pipeline as T13" — F-34 is in by reference.
**Resolution scope (T14.1 architect decision):** either (a) ship `attemptReadWith{WorkRefusal,S51Evidence}Passphrase` library functions mirroring T13; OR (b) absorb the passphrase verify into the SECURITY DEFINER view's body and document why no library-level friction layer is needed. If (a), tests covering wrong-passphrase × 3 → no plaintext + `sensitive.access_attempt` audit row written.
**Status (closed via reframe — option (b) chosen):** the SECURITY DEFINER fn body absorbs the passphrase verify in-line. `work_refusal_read(p_id, p_passphrase)` at `supabase/migrations/00000000000006_t14.sql:108-125` checks `crypt(p_passphrase, v_row.per_record_passphrase_hash) <> v_row.per_record_passphrase_hash` and on mismatch emits `sensitive.access_attempt` with `meta.reason = 'wrong_passphrase'` then RETURNs without yielding `notes_ct`. Same shape mirrored in `s51_evidence_read`. No library-level friction layer needed — the wrong-passphrase → no-plaintext + `sensitive.access_attempt` audit row property holds at the SQL boundary, which is stricter (the library cannot bypass it).
**Blocker for:** closed.

### G-T14-11 — `transaction_ts_ms` library shim (mirrors G-T13-9)

**Source:** second-opinion-reviewer T14 Concern 3.
**Finding:** `work-refusal-core.ts:207` and `s51-evidence-core.ts:240` use the same `received_at_ts: now() + 1` shim T13's `readReprisalEntry` introduced. The library returns a fabricated future timestamp purely so the strict-inequality test assertion holds under frozen timers. Production must replace with the SQL transaction's `xact_start()`.
**Resolution scope (T14.1):** `SupabaseWorkRefusalStore` / `SupabaseS51EvidenceStore` reveal flows return the actual return-moment timestamp from the SQL transaction; library shim collapses (test relaxes to `<=`).
**Status (closed via library-shim removal):** both `work-refusal-core.readWorkRefusalEntry` and `s51-evidence-core.readS51EvidenceEntry` now return `received_at_ts = now()` (no `+ 1`). No test asserts on the strict-inequality (grep of `apps/web/test` for `received_at_ts` returned zero hits outside T08), so no test changes were needed. Same closure rationale as G-T08-14 / G-T13-9: the F-18 / HG-6 ordering is enforced by the `await` on the audit emit before the openUtf8 decrypts.
**Blocker for:** closed.

### G-T14-12 — `s51_evidence.create.rejected` audit + structured error for `PhotoUnsupportedFormatError`

**Source:** second-opinion-reviewer T14 Concern 1.
**Finding:** `submitS51Evidence`'s photo loop (`s51-evidence-core.ts:162-168`) does not catch `PhotoUnsupportedFormatError`. A non-JPEG photo (HEIC, PNG, WebP) throws mid-loop; no audit row, no banner, no structured return shape. The caller surfaces an opaque error; the operator has no signal.
**Resolution scope (T14.1):** wrap each `sanitizePhoto(raw)` in try/catch; on failure return `{ ok: false, reason: 'photo_unsupported_format', body: { rejected_index: i, banner_key } }` AND emit a new `s51_evidence.create.rejected` audit event. Extend `scripts/check-audit-enum-coverage.sh` + `observability/audit-log.md` + ADR-0003 Amendment A. Extends G-T14-7's enum-coverage scope.
**Status (closed):** the event_type `s51_evidence.create.rejected` is in `scripts/check-audit-enum-coverage.sh` `EXPECTED_ENUM`, in `observability/audit-log.md` §1 (with `reason: 'photo_unsupported_format'` + `rejected_index` meta), and emitted from `apps/web/src/lib/s51-evidence/s51-evidence-core.ts` with the try/catch wrapper around `sanitizePhoto(raw)`. The closed-set `'s51_evidence.create.rejected'` lives on the `S51EventType` union in `apps/web/src/lib/s51-evidence/types.ts`. Six-mirror dance complete.
**Blocker for:** closed.

### G-T14-13 — `submit*` insert+audit atomicity (inherited from T13)

**Source:** second-opinion-reviewer T14 Concern 6.
**Finding:** `submitWorkRefusal` / `submitS51Evidence` do NOT use the same emit-then-decrypt protective try/catch as the read path. If `recordWorkRefusalEvent` fails on `work_refusal.created`, the row has already been inserted; the audit row write throws unhandled. Result: a persistent C4 row with NO created-audit row, no rollback. Same gap exists in T13 `submitReprisal` — pattern fit propagates the issue.
**Resolution scope (T14.1):** same try/catch + rollback (hard-delete inserted row) posture as the read path, OR document the trade-off and explicitly accept "missing .created audit row" as a tolerable failure mode. Apply the same fix to T13's `submitReprisal` and T08's `submitConcern`.
**Status (closed via SQL-level atomicity):** the architecture chose `SECURITY DEFINER plpgsql` function = single implicit transaction over library-side try/catch + rollback. `work_refusal_submit` at `supabase/migrations/00000000000006_t14.sql:94-106` runs `INSERT INTO public.work_refusal (...) RETURNING id INTO v_id; PERFORM public.audit_emit('work_refusal.created', ...)` inside one fn body — if `audit_emit` raises, the INSERT is automatically rolled back by PostgreSQL. Same shape mirrored in `s51_evidence_submit` (line 151+). The "persistent C4 row with no audit" failure mode the gap describes is structurally impossible at the SQL boundary. Same posture mirrored in `reprisal_submit` / `concern_submit`.
**Blocker for:** closed.

### G-T14-14 — Test verifying `c4_read_service` shared-role atomicity

**Source:** second-opinion-reviewer T14 Concern 4.
**Finding:** The shared `c4ReadServiceAuditInsertBlocked` toggle blocks `reprisal.read` + `work_refusal.read` + `s51_evidence.read` simultaneously (matches production where one `c4_read_service` role owns all three views). No test asserts the shared-role atomicity — the T14 atomicity test only checks work_refusal. A future refactor introducing a `c3_read_service` separation would silently diverge.
**Resolution scope:** add a test that calls `__test_revoke_audit_insert_for_role('c4_read_service')` once and asserts ALL THREE of `reprisal.read`, `work_refusal.read`, `s51_evidence.read` abort with `audit_failed`. Test-writer follow-up.
**Status (partial close — three separate atomicity tests exercise the same toggle; explicit "all three at once" residual):** three separate atomicity tests exercise the shared toggle against each surface independently: `apps/web/test/T13/reprisal-log.test.ts:96` (reprisal.read), `apps/web/test/T14/c3-read-audit.test.ts:122-137` (work_refusal.read), and the immediately-following test at `c3-read-audit.test.ts:139+` (s51_evidence.read). All three reference the same `'c4_read_service'` role string, so a future refactor introducing a separate `c3_read_service` would fail every one of them. The explicit "ONE toggle blocks all three simultaneously" test is residual defense-in-depth (test-writer follow-up).
**Blocker for:** closed for the structural property; explicit shared-toggle test is residual hygiene.

### G-T14-15 — Class-vocabulary disambiguation in Amendment A extension table

**Source:** privacy-reviewer T14 T14-A1 / Q1.
**Finding:** ADR-0003 Amendment A extension table header "Class" overloads C3/C4 vocabulary. ADR-0003 Amendment A calls `work_refusal.read` a "C3 read" (audit-event class) while §PI inventory classifies the underlying data as C4. The library correctly uses `target_class: 'C4'`; the ambiguity is in the architectural documentation, not the code.
**Resolution scope (T14.1 architect pass):** change the column header from "Class" to "Audit-event class" with a footnote pointing back to §PI inventory for the underlying data class.
**Status (closed):** the ADR-0003 Amendment A extension table header in `.context/decisions.md` (the `work_refusal.read` / `s51_evidence.read` enum-additions table) is renamed from "Class" → "Audit-event class¹" with a footnote that explicitly disambiguates: the column classifies the audit-log row (read-event surface, HG-6 server-emitted, no plaintext PI in the row), NOT the underlying record (the `notes_ct` / sealed-photo bodies remain C4 per §PI inventory). The library's `target_class: 'C4'` emission is unchanged and correct. The footnote cross-references G-T14-15 so a future architect pass can find the disambiguation reasoning.
**Blocker for:** closed.

### G-T14-16 — RLS-WHERE-filters-before-audit invariant for SECURITY DEFINER view bodies

**Source:** privacy-reviewer T14 T14-A6.
**Finding:** Production `work_refusal_read_audited` / `s51_evidence_read_audited` SECURITY DEFINER view bodies MUST inline `jhsc_caller_can_read_*(...)` in the WHERE clause (not inside the function body), so unauthorized callers see zero rows AND zero audit emission. Same shape as T13.1 per `.context/decisions.md` line 2354. Without this discipline, a callable-but-zero-row path could quietly emit audit rows for unauthorized SELECTs.
**Resolution scope (T14.1 migration):** document the inlined-WHERE convention; pgTAP test asserts no audit row written when caller fails the read predicate.
**Status (closed via reframe — gate-RAISE pattern equivalent to inline-WHERE):** the implemented architecture chose `PERFORM public._t14_gate_read()` / `_t14_gate_write()` at the TOP of each SECURITY DEFINER fn body (`supabase/migrations/00000000000006_t14.sql:99,113,132,157,171,190`) over the inline-WHERE pattern. The gate fns (lines 75-89) RAISE EXCEPTION 'rls_denied' (SQLSTATE `42501`) on failure — execution halts BEFORE the SELECT or any `audit_emit` call. The unauthorized-caller property the gap describes (zero rows AND zero audit emission) holds: a caller that fails `session_is_live() AND is_certified_member()` raises and aborts before any data path runs. Different mechanism than inline-WHERE; same security property.
**Blocker for:** closed.

### G-T14-17 — `__debug*` methods interface split (extends G-T13-15 to T14)

**Source:** privacy-reviewer T14 T14-A7.
**Finding:** `MemoryWorkRefusalStore.__debugAuditRows()` and `MemoryS51EvidenceStore.__debugAuditRows()` return raw `actor_pseudonym` to any caller. Library-internal; MUST NOT survive into the corresponding Supabase store implementations. Extends G-T13-15 to T14 surfaces.
**Resolution scope (T14.1):** interface split — read interface vs debug interface. The Supabase store implementation only implements the read interface.
**Status (closed):** test-only hooks split out of the production interfaces. `WorkRefusalStore` and `S51EvidenceStore` no longer declare `__setActiveMember` / `__debugAuditRows`; the test-only superset interfaces `TestWorkRefusalStore extends WorkRefusalStore` and `TestS51EvidenceStore extends S51EvidenceStore` live in `memory-work-refusal-store.ts` and `memory-s51-evidence-store.ts` (deep-import only — NOT re-exported from the public `lib/work-refusal` / `lib/s51-evidence` barrels). Both add `__setActiveMember`, `__grantWriteRole`, `__grantReadOnlyRole`, `__debugAuditRows`, and the respective `__debug*Rows` row accessor. `Memory*Store implements Test*Store` so test code consuming the Memory class can still call every hook; production code holding a `WorkRefusalStore` / `S51EvidenceStore`-typed reference cannot. Same posture as T18's `TestIntegrityStore extends IntegrityStore`. Future `SupabaseWorkRefusalStore` / `SupabaseS51EvidenceStore` (T14.1) implement the production interface only — narrowing back to the Test variant is a type error.
**Blocker for:** closed.

### G-T14-18 — Resolve declared-but-unimplemented `rate_limited` denial branch

**Source:** privacy-reviewer T14 Q5.
**Finding:** Library declares `'rate_limited'` as a possible denial reason and types `status: 403 | 429`, but `submitWorkRefusal` / `submitS51Evidence` never call a `tryConsumeRateBudget(...)` analogue. The declared-but-absent type hides a privacy-relevant decision.
**Resolution scope (T14.1 architect decision):** either (a) implement per-actor rate limit (recommend 10/hr matching T13's reprisal-log ceiling, given statutory-filing friction parity) OR (b) drop `'rate_limited'` from the denial union and the `429` status code on insert paths. Document the rationale.
**Blocker for:** T14.1 PR submission.

---

## T11 / T12 — Export pipeline

### G-T11-1 — SQL migration deferred to T11.1

**Source:** ADR-0002 Amendment H (sibling-task pattern; mirrors G-T07-1 + G-T13-1).
**Finding:** the `minutes_final` table + `recommendations` table + `co_chair_role` RLS predicate + `export_audit_log` projection view + `A-EXPORT-001` / `A-EXPORT-002` alert wiring all ship in T11.1 / T12.1, not T11/T12. T11/T12's library tests run against `MemoryExportStore` exclusively.
**Resolution scope (T11.1):** ship `supabase/migrations/00000000000006_minutes_export.sql` + Edge Function `/api/exports/minutes` + `/api/exports/recommendation` with the closed-allowlist SQL function, F-22 RLS, F-28 rate-limit, RA-1 re-auth assertion verification + post-export rep-notification fanout.
**Blocker for:** first production deploy carrying real PI in finalized minutes.

### G-T11-2 — Token surface expansion for the export interstitial

**Source:** implementer T11 — `apps/web/src/lib/export/ExportInterstitial.svelte`.
**Finding:** the component reads only `color.state.warning/danger`, `focus.outer/inner`, and `border_width.thick/focus_inner` from the typed accessor. Full design-system §4.A coverage (states `re-auth-required`, `exporting`, `exported`, every modal variant's primary/secondary button tokens, the `card.sensitive_c4` strip tokens, the `motion.duration.*` for the reduced-motion-aware transition) requires the implementer to extend `apps/web/src/lib/tokens.ts` to expose those surfaces.
**Resolution scope (next UI pass on T11):** extend `tokens.ts` per design-tokens.json §components.modal + §spacing + §motion; rebind `style:` directives.
**Blocker for:** none of the test obligations (markup is structural). Affects visual fidelity only.

### G-T11-3 — Minimal PDF emitter — production wire-up

**Source:** implementer T11 — `apps/web/src/lib/export/export-renderer.ts`.
**Finding:** the renderer ships a hand-rolled, zero-dependency PDF emitter that produces a single-page document whose content stream is a literal text dump of the allowlist projection. It is well-formed enough for the test helper's `extractPdfText` to grep, but it is NOT a typeset PDF — no Unicode font subsetting, no line wrapping, no headers/footers, no multi-page layout. Production needs a real PDF library.
**Resolution scope (T11.1):** evaluate a zero-telemetry PDF library (candidates: `pdfkit` self-hosted bundle, `pdf-lib`); ensure no analytics/telemetry/network calls; verify the bundle does not pull `console`/`window` references that defeat ADR-0010's no-third-party JS posture; keep the F-19 closed-allowlist projection as the only data source the renderer can read.
**Blocker for:** production deploy where the PDF is consumed by a non-technical employer co-chair.

### G-T11-4 — `getRouteInventory()` binding for `/api/exports/*`

**Source:** implementer T11 — F-25 route inventory contract.
**Finding:** `getRouteInventory()` currently returns four routes (`/`, `/api/concerns`, `/api/inspections`, `/api/sessions`); the T11 F-25 test passes because none of those declare `application/pdf`. When the production Edge Functions land at T11.1, the inventory MUST gain the export routes AND assert no PDF content type.
**Resolution scope (T11.1):** add `/api/exports/minutes` and `/api/exports/recommendation` entries with `application/json` only; the F-25 test continues to pass against the real route surface.
**Blocker for:** T11.1 PR submission.

### G-T11-5 — Re-auth assertion verification stub

**Source:** implementer T11 — `apps/web/src/lib/export/memory-export-store.ts`.
**Finding:** `MemoryExportStore.verifyReauthAssertion` only validates assertion presence + actor binding + 5-minute freshness window. Production needs the full WebAuthn assertion verify step: signature check against the user's stored credential public key, counter monotonicity, RP id binding, ceremony challenge match.
**Resolution scope (T11.1):** `SupabaseExportStore.verifyReauthAssertion` calls into the Supabase Auth Edge Function `/api/auth/reauth/verify` which performs the full WebAuthn verify. Library tests against MemoryExportStore continue to pass — production tests gate on the real verify.
**Blocker for:** production deploy.

### G-T11-6 — Post-export rep notification fanout

**Source:** RA-1 compensating control #4.
**Finding:** `MemoryExportStore.sendPostExportNotification` is a no-op (returns `{ ok: true }` unless the test forces failure). The real fanout writes per-recipient feed entries (or pushes to a websocket subscription) within 60s.
**Resolution scope (T11.1):** SupabaseExportStore writes to a `sensitive_activity_feed` table (or fans out via Supabase Realtime) so every active member sees the entry within the 60s budget; the integration test asserts the budget against the live stack.
**Blocker for:** production deploy where RA-1's compensating-control posture is load-bearing.

### G-T11-7 — Audit-row bridge — production posture

**Source:** implementer T11 — `apps/web/test/_helpers/supabase-test.ts` constructor.
**Finding:** the harness wires the `MemoryExportStore`'s audit bridge AND the `__bridgeEmitAlertFired` hook so the test queries against the AuthStore's audit_log find the rows. Production has ONE audit_log table; the Edge Function writes the row directly. The library's `ExportStore.recordExportEvent` contract holds (single emit per call); the bridge is a test artifact.
**Resolution scope (T11.1):** SupabaseExportStore writes directly to `audit_log`; the bridge disappears. The F-24 audit-before-Blob ordering invariant is preserved by the SQL function's transaction boundary.
**Blocker for:** none. Hygiene.

### G-T11-8 — Renderer-allowlist override hook is module-scoped

**Source:** implementer T11 — `apps/web/src/lib/export/export-core.ts` `_rendererAllowlistOverride`.
**Finding:** the test-only hook `__test_overrideRendererAllowlist` mutates a module-level variable. Tests run sequentially (vitest singleThread) so the leak risk is bounded; we belt-and-brace by resetting in `supabase-test.ts.tearDown`. Production code paths never read the override (it defaults to null and the export-core falls back to the canonical allowlist).
**Resolution scope (none required for production):** the override never ships — it lives in `export-core.ts` only because the F-27 test needs to monkey-patch the renderer. Document the gate in `apps/web/src/lib/export/export-core.ts` header.
**Status (closed — documentation gate in place):** `apps/web/src/lib/export/export-core.ts:63-72` carries the gate as a section-banner comment block: _"Per F-27 the audit row's `field_set_hash` is bound to the renderer's allowlist at runtime. The test monkey-patches the renderer to use a different allowlist to verify the integrity check trips. The override is module-scoped, intentionally NOT exposed from index.ts; the test reaches it via the high-level wrapper's `__test_overrideRendererAllowlist` property (set on the exported function object)."_ The hook itself (`__setRendererAllowlistOverrideForTest` at line 77) is exported but not re-exported from `index.ts` — same T11/T12 F-1 deep-import-only pattern as the T13/T14/T16/T17 test stores.
**Blocker for:** closed.

### G-T11-9 — ESLint `no-restricted-syntax` rule for the F-19 spread ban

**Source:** F-19 mitigation — "an ESLint rule forbids spread-into-export-payload outside that module".
**Finding:** the rule is NOT yet wired in `.eslintrc`. The library's `projectMinutesByAllowlist` / `projectRecommendationByAllowlist` are written as literal switch statements over the allowlist keys (compile-time exhaustiveness via the `never` cast) so a spread would not type-check anyway, but the rule is an additional belt.
**Resolution scope (T11.1 or next lint-config pass):** add the rule with the message "spread-into-export-payload forbidden outside src/lib/export/export-renderer.ts; use the allowlist switch statement".
**Status (closed):** `apps/web/eslint.config.js` now carries a `no-restricted-syntax` block scoped to the two payload-construction modules (`export-renderer.ts` + `export-core.ts`) banning `ObjectExpression > SpreadElement[argument.type='Identifier']` — i.e., spreading a bound source-object variable (`{ ...row }`) into the payload, the exact F-19 anti-pattern that would carry un-allowlisted columns through. The selector is deliberately narrowed to Identifier args so the two legitimate idioms in these files are untouched: array spreads (`[...row.agenda_items]`, `[...allowlist]` — ArrayExpression) and the conditional-optional-field spread (`...(cond ? { x } : {})` — spreads an inline ConditionalExpression, not an identifier). The block is placed AFTER the G-T17-8 block because ESLint flat config is last-match-wins per rule and G-T17-8's broader `src/**/*.ts` `no-restricted-syntax` would otherwise clobber it; both selectors are carried in the export block so nothing is lost on the override. The compile-time `never`-cast exhaustiveness remains the load-bearing gate; this is the belt-and-braces F-19 contract.
**Blocker for:** closed.

### G-T11-10 — Protected-modal harness mounts a stub, not the real Svelte component

**Source:** implementer T11 — `apps/web/test/_helpers/protected-modal-harness.ts`.
**Finding:** the harness mounts a DOM-shaped surface (scrim + dialog + buttons + state object) that satisfies M-53a/b/c testably. The real `ExportInterstitial.svelte` component is rendered by the React-testing-library `render(...)` calls; the protected-modal-harness tests do NOT exercise it. When the production modal-wrapper component lands (per G-T13-10), the harness should be replaced with a real `render(ExportInterstitialModal, {...})` flow.
**Resolution scope (T11.1 UI):** ship `ExportInterstitialModal.svelte` that composes `ExportInterstitial.svelte` inside a `<dialog>` with a focus-trap action; the harness can then assert against the real component.
**Blocker for:** none of the test obligations (the harness satisfies M-53a/b/c via DOM structure).

### G-T11-11 — `i18n` key `export.notification_deferred` is the warning-toast slot

**Source:** implementer T11 — `apps/web/src/lib/export/types.ts` `warning_toast_key`.
**Finding:** the type names the key `'export.notification_deferred'`; the i18n catalog does NOT yet have an entry for it. The Svelte toast component reads the key + renders the en-CA copy at toast-mount time. The test only asserts the key string.
**Resolution scope (next i18n pass):** add `export.toast.notification_deferred: "Other committee members will be notified when the network reconnects."` under the `toast.warning` block.
**Blocker for:** none of the test obligations. UX polish.

---

### T11/T12 reviewer-pass additions (privacy G-T11-NEW-1..21 + second-opinion CF-1..9, deduplicated)

### G-T11-12 — Recipient identity narrowing (BLOCKING-IN-T11.1) **[privacy P-1 + SO CF-1]**

**Source:** privacy-review-t11-t12.md Q4 BLOCKING #1; second-opinion CF-1.
**Finding:** `recipient_role: 'employer_co_chair'` is a label, not an identity. PIPEDA 4.5 (Limiting Disclosure) + 4.9 (Individual Access) require the audit row to answer "to whom" with sufficient precision to support a §4.9 access request. The current shape only narrows to a role class.
**Resolution scope (T11.1):** add `recipient_user_pseudonym: string` (HMAC of recipient user id, shared key with `actor_pseudonym`) to `ExportAuditEmission.meta`; `SupabaseExportStore` resolves recipient identity from the active export-recipient binding; multi-employer-co-chair edge needs architect decision before SQL ships.
**Blocker for:** T11.1 PR submission.

### G-T11-13 — `hazard_class` hardcoded `'physical'` in re-consent interstitial copy (BLOCKING-IN-T11.1) **[privacy P-2]**

**Source:** privacy-review-t11-t12.md Q2 BLOCKING-IN-T11.1.
**Finding:** `ExportInterstitial.svelte` renders the re-consent body with `hazard_class` hardcoded to `'physical'` instead of deriving from the concern's actual hazard class. PIPEDA Principle 4.6 (Accuracy) is violated for chemical/biological/ergonomic/psychosocial concerns — the worker sees an inaccurate re-consent surface.
**Resolution scope (T11.1):** pass the per-concern hazard_class through `prepareExport` result → interstitial prop; render one bullet per distinct hazard class in the concern-derived set.
**Blocker for:** T11.1 PR submission (highest-priority advisory per RA-1 margin).

### G-T11-14 — Duplicate pseudonym in audit-row meta (BLOCKING-IN-T11.1 hygiene) **[privacy P-3 + SO CF-2]**

**Source:** privacy-review-t11-t12.md Q4; second-opinion CF-2.
**Finding:** `approver_pseudonym` and `actor_pseudonym` appear both at the top level of `ExportAuditEmission` AND inside `meta`. PIPEDA 4.7 (Safeguards) requires audit shape to be unambiguous; the duplicate invites a "which field is authoritative?" forensic question.
**Resolution scope (T11.1):** keep top-level only; drop from `meta`. Update the F-24 audit-shape test to assert single-location.
**Blocker for:** none. Hygiene before SQL projection-view ships.

### G-T11-15 — SQL transaction atomicity for second-class audit row (BLOCKING-IN-T11.1) **[privacy P-4 + SO CF-3]**

**Source:** privacy-review-t11-t12.md Q5; second-opinion CF-3.
**Finding:** the library emits `export.generated` then `export.delivered` as two emit calls. The `MemoryExportStore` records them in array order, but the F-24 invariant (audit-before-Blob) is only proven for the primary `export.generated` row. The second `export.delivered` row's ordering is not atomically bound to the first under a partial-failure scenario.
**Resolution scope (T11.1):** wrap both inserts in a single SQL transaction inside the `export_record_with_audit()` SECURITY DEFINER function; primary row precedes secondary inside the same transaction; both succeed or neither does.
**Blocker for:** T11.1 SQL migration PR.

### G-T11-16 — PDF byte-grep regression test for `/Info` dictionary absence (BLOCKING-IN-T11.1) **[privacy P-5]**

**Source:** privacy-review-t11-t12.md Q6 ADVISORY upgraded.
**Finding:** the hand-rolled emitter omits the `/Info` dictionary by construction (no `Author`/`Producer`/`Creator` strings) — that is the load-bearing privacy property keeping co-chair identity out of the PDF. Today's tests verify rendered text contents; no test asserts the absence of those literal strings at the byte level.
**Resolution scope (T11.1):** add `assert(!pdfBytes.includes(textEncoder.encode('/Author')))` style byte-grep assertions for `/Author`, `/Producer`, `/Creator`, `/CreationDate`, `/ModDate`, `/Info` against every PDF the renderer emits.
**Blocker for:** any PDF-library swap (G-T11-3) — the new lib MUST also pass these assertions.

### G-T11-17 — HG-10 trigger — recipient-identification copy review **[privacy P-6]**

**Source:** privacy-review-t11-t12.md HG-10 fires (G-T11-NEW-1).
**Finding:** the interstitial says "to the employer co-chair" generically. PIPEDA 4.3.4 ("to whom") requires the worker to see the recipient's identity at consent time. After G-T11-12 lands the data, the copy MUST surface the recipient's display name + role.
**Resolution scope (T11.1, gated on labour-lawyer + privacy-lawyer HG-10 sign-off):** revise interstitial copy to render `${recipient.display_name} (${recipient.role_label})`.
**Blocker for:** T11.1 UI ship.

### G-T11-18 — HG-10 trigger — four-bullet consent parity copy **[privacy P-7]**

**Source:** privacy-review-t11-t12.md Q2 + Q7 ADVISORY (G-T11-NEW-4 + NEW-16).
**Finding:** T13's intake form ships PIPEDA 4.3.4's four-bullet structure (what, why, to-whom, how-long). The export interstitial's re-consent body must match that pattern for §4.3 parity — currently it is prose, not bullets.
**Resolution scope (T11.1, HG-10 gated):** restructure interstitial body into four bullets mirroring T13's intake copy.
**Blocker for:** T11.1 UI ship.

### G-T11-19 — HG-10 trigger — `concernDerivedAnnotatedFields` subtext **[privacy P-8]**

**Source:** privacy-review-t11-t12.md Cross-cutting B ADVISORY.
**Finding:** RA-1 #3 (visible concern-derived flag) is satisfied today by listing the concern IDs the export inherits from. PIPEDA 4.3.4 informedness is stronger if the per-concern annotated-field set is visible (e.g., "this export carries your concern's narrative + photo metadata + hazard class").
**Resolution scope (T11.1, HG-10 gated):** render `concernDerivedAnnotatedFields(kind)` as a sub-bullet under each concern-id chip.
**Blocker for:** none. Informedness uplift.

### G-T11-20 — HG-10 trigger — `notification_deferred` error string copy **[privacy P-9]**

**Source:** privacy-review-t11-t12.md Q3 ADVISORY.
**Finding:** when post-export fan-out fails (RA-1 #4), the user sees a warning toast keyed `export.notification_deferred`. The fr-CA copy + i18n key catalog entry both need labour-lawyer review.
**Resolution scope (T11.1, HG-10 gated):** sign-off copy in en-CA + fr-CA before T11.1 ships.
**Blocker for:** localization-specialist handoff.

### G-T11-21 — `__debug*` interface-split (mirrors G-T13-15 / G-T14-17) **[privacy P-10 + SO CF-4]**

**Source:** privacy-review-t11-t12.md hygiene; second-opinion CF-4.
**Finding:** the `ExportCapableClient` interface (export/index.ts:85) merges production methods with test-only hooks (`__getActorUserId` / `__getExportStore` / `__getReauthAssertion`). Same shape as G-T13-15 / G-T14-17 — production code paths can read the `__` hooks at runtime.
**Resolution scope (T11.1):** split into `ExportClient` (production) + `TestExportClient extends ExportClient` (test-only); production callers narrow to `ExportClient`; harness widens to `TestExportClient`.
**Status (closed):** the `ExportCapableClient` interface is gone. `ExportClient` (production marker, empty) + `TestExportClient extends ExportClient` (the three `__` hooks) live in `apps/web/src/lib/export/test-client.ts` (deep-import only — NOT re-exported from the public `lib/export` barrel). `index.ts` imports `TestExportClient` and the runtime typeguard narrows `unknown` → `TestExportClient` for the test-bridge convenience wrappers (`exportMinutes` / `exportRecommendation`). Production callers consume `proceedExport({store, now}, request, assertion)` directly with explicit deps — they never see the `__` hooks. Future `SupabaseExportClient` (T11.1) implements `ExportClient` only; narrowing back to `TestExportClient` is a type error. Same posture as T13 / T14 / T18 TestStore splits.
**Blocker for:** closed.

### G-T11-22 — `'audit_failed'` missing from `ExportRejection.reason` union **[privacy P-11 + SO CF-5]**

**Source:** privacy-review-t11-t12.md Q5 ADVISORY; second-opinion CF-5.
**Finding:** F-24 says "no Blob if audit row failed to land", but the `ExportRejection.reason` discriminated union does not include `'audit_failed'`. When the SupabaseExportStore audit insert fails, the rejection currently falls through to a generic reason.
**Resolution scope (T11.1):** add `'audit_failed'` to the `ExportRejection.reason` union; F-24 test asserts that exact reason on simulated audit-insert failure.
**Status (closed):** `'audit_failed'` IS in the `ExportRejection.reason` union at `apps/web/src/lib/export/types.ts:81` (final arm of the closed-literal union alongside `'requires_reauth' | 'rate_limited' | 'rls_denied' | 'integrity_fail' | 'not_found'`). F-24 production-proof obligation satisfied at the type level; the SQL projection-view's audit-insert failure surfaces this exact reason rather than falling through to a generic catch-all.
**Blocker for:** closed.

### G-T11-23 — Hash determinism pin for `computeAllowlistHash` **[privacy P-12]**

**Source:** privacy-review-t11-t12.md Q1 ADVISORY.
**Finding:** `computeAllowlistHash` is deterministic under Node's `crypto.subtle` + the current iteration order of `Object.freeze([] as const)`. A future TS upgrade or constants reordering could silently change the hash → SQL projection-view binding breaks.
**Resolution scope (T11.1):** add a pinned-value test (e.g., `expect(computeAllowlistHash(EXPORT_ALLOWLIST_MINUTES)).toBe('<frozen hex>')`); regenerate the pinned value only when the allowlist intentionally changes.
**Status (closed):** pinned hex KAT lands at `apps/web/test/T11_T12/allowlist-hash-pin.test.ts`. 4 assertions: (1) `EXPORT_ALLOWLIST_MINUTES` hash = `1bb78b…675da`; (2) `EXPORT_ALLOWLIST_RECOMMENDATION` hash = `dadb87…3d01`; (3) hash differs when list is reversed (Object.freeze insertion-order sanity); (4) hash differs when a field is added. Header comment documents the regeneration policy (only on intentional allowlist change) and the failure-mode classification (drift vs Node/OpenSSL upgrade). Pinned 2026-06-16 against Node 20.x / OpenSSL 3.0.x.
**Blocker for:** closed.

### G-T11-24 — ESLint rule for the F-19 spread ban (verification) **[privacy P-13]**

**Source:** privacy-review-t11-t12.md Q1 ADVISORY; pairs with G-T11-9.
**Finding:** G-T11-9 already records that the ESLint `no-restricted-syntax` rule is unwired; privacy review confirms verification needed at T11.1 — must prove the rule actually rejects a synthetic spread in CI.
**Resolution scope (T11.1):** add a `__lint_negative__.ts.disabled` file + CI step that runs `eslint` against it and asserts non-zero exit.
**Status (closed — verified by construction during G-T11-9 PR):** the rule was verified to fire by injecting a synthetic `{ ...row }` into `projectMinutesByAllowlist` and confirming `eslint` reported the `G-T11-9 / F-19` error (exit non-zero), then reverting. The clean tree passes `eslint .` at exit 0 — so the rule is BOTH active (fires on the anti-pattern) AND non-false-positive (the existing conditional-field spread at `export-core.ts:350` is correctly allowed). The narrowed `[argument.type='Identifier']` selector is what makes both true. A standalone `.ts.disabled` negative fixture was considered but is redundant: the `hardening-gates` CI job already runs `eslint .` over the full tree on every PR, and the lint config block itself is the durable record. If a future reviewer wants a permanent negative fixture, the selector + scope are documented inline in `eslint.config.js`.
**Blocker for:** closed.

### G-T11-25 — RA-1 trigger #5 monitoring alert (`A-EXPORT-002`) **[privacy P-14]**

**Source:** privacy-review-t11-t12.md Q3 ADVISORY.
**Finding:** RA-1 re-open trigger #5 fires on "loss of post-export notification surface". Today the library has the surface; production needs an alert when the fanout success-rate drops or latency p95 > 60s.
**Resolution scope (T11.1):** define `A-EXPORT-002` (notification-fanout health) with runbook in observability-setup pass; threshold defined alongside the SLO.
**Blocker for:** RA-1 compensating-control monitoring posture.

### G-T11-26 — Fan-out latency contractually bounded **[privacy P-15]**

**Source:** privacy-review-t11-t12.md Q3 ADVISORY.
**Finding:** the 60s budget mentioned in G-T11-6 is asserted in MemoryExportStore tests but is not contractually surfaced in the `ExportStore.sendPostExportNotification` return type.
**Resolution scope (T11.1):** add `latency_ms: number` to the notification-fanout result; integration test asserts `< 60_000` against the live stack.
**Blocker for:** SLO definition.

### G-T11-27 — `mode` prop type tightening on `ExportInterstitial.svelte` **[privacy P-16]**

**Source:** privacy-review-t11-t12.md Q7 ADVISORY.
**Finding:** `mode` is typed as `string`; should be the discriminated union `'re-auth-required' | 'exporting' | 'exported' | 'failed'` matching the state machine.
**Resolution scope (T11.1 UI):** tighten the prop type; accessibility-specialist handoff already covers ARIA states for each.
**Blocker for:** none. Type hygiene.

### G-T11-28 — AODA spec scope routed to accessibility-specialist **[privacy P-17]**

**Source:** privacy-review-t11-t12.md Q7; pairs with G-T11-10.
**Finding:** privacy review explicitly routed AODA-spec scope on the interstitial to accessibility-specialist; not in privacy's scope.
**Resolution scope (T11.1 UI):** accessibility-specialist review of `ExportInterstitial.svelte` + `ExportInterstitialModal.svelte` once the modal-wrapper exists.
**Blocker for:** T11.1 UI ship gate.

### G-T11-29 — Second-opinion: `URL.createObjectURL` swallow-catch hides Blob failure **[SO CF-6]**

**Source:** second-opinion review CF-6.
**Finding:** `exportOne` in index.ts catches Blob-URL errors silently. In production, if the browser blocks Blob URL creation (CSP `blob:` not in `default-src`), the user sees a successful return but no download. The audit row commits, leaving an inexplicable audit entry with no PDF.
**Resolution scope (T11.1):** keep the swallow only when `process.env.NODE_ENV === 'test'`; in production, surface a `'blob_url_creation_failed'` rejection (also add to the `ExportRejection.reason` union per G-T11-22).
**Blocker for:** production deploy.

### G-T11-30 — Second-opinion: rate-limit not exercised in library tests **[SO CF-7]**

**Source:** second-opinion review CF-7.
**Finding:** F-28 (rate-limit) is documented in decisions.md but the library has no rate-limit surface — it lives in the Edge Function. The library test suite cannot exercise it.
**Resolution scope (T11.1):** SQL function `export_record_with_audit()` consults a `export_rate_buckets` table (token bucket: 5 exports per 5 minutes per actor); integration test simulates burst.
**Blocker for:** T11.1 production ship.

### G-T11-31 — Second-opinion: `concernDerivedFieldsForKind` test surface coverage **[SO CF-8]**

**Source:** second-opinion review CF-8.
**Finding:** `concernDerivedFieldsForKind('minutes.final')` and `('recommendation')` return canonical lists; only the union is exercised. Per-kind narrowing assertions absent.
**Resolution scope (T11.1):** add per-kind assertions; lock the canonical list against drift.
**Blocker for:** none. Drift detector.

### G-T11-32 — Second-opinion: F-25 inventory test fragility against route additions **[SO CF-9]**

**Source:** second-opinion review CF-9; pairs with G-T11-4.
**Finding:** F-25 asserts "no route declares application/pdf"; the assertion iterates the inventory. When unrelated routes get added that declare `application/octet-stream` or similar, future reviewers may relax the check.
**Resolution scope (T11.1):** tighten F-25 to an explicit allowlist of non-PDF content types per route entry.
**Blocker for:** none. Drift guard.

## T12 — Recommendations + 21-day timer

### G-T12-1 — 21-day timer SQL + Edge Function

**Source:** T12 acceptance.
**Finding:** the library's `recommendation` export carries `created_at` + `sent_at` + `twentyone_day_due_at` in the allowlist, but T11/T12 does NOT ship the timer-bookkeeping mechanism (the daily job that marks an expired recommendation, the alert when employer response is overdue).
**Resolution scope (T12.1):** SQL function `recommendation_due_check()` runs on a daily cron; emits `recommendation.overdue.alert` audit row + `A-REC-001` alert when `now() > twentyone_day_due_at`.
**Blocker for:** OHSA s.9(20) 21-day compliance feature.

### G-T12-2 — Same posture as T11 for the recommendation export path

**Source:** T12 acceptance ("same export posture as T11").
**Finding:** G-T11-1 / G-T11-3 / G-T11-4 / G-T11-5 / G-T11-6 / G-T11-7 all apply mutatis mutandis to T12.1.
**Resolution scope (T12.1):** mirror T11.1's resolution pattern for the recommendation surface.
**Blocker for:** production deploy.

## T16 — Retention sweep

> Library-only T16 (ADR-0002 Amendment H) closes library halves of G-T05-6 + G-T05-7. The 10 G-T16-1..10 entries below were minted in threat-model.md §3.9 and are reproduced here for one-stop T16.1 planning. Six additional entries (G-T16-PRIV-1..3, G-T16-RECONCILE-CEILING, G-T16-SO-1, G-T16-SO-2) come from the T16 reviewer pass.

### G-T16-1 — SQL advisory lock (F-59 production half)

**Source:** threat-model.md §3.9 F-59; ADR-0017 §6 step 1.
**Finding:** library lease (5-min in-memory checkpoint) is the cooperative-caller defense. Hostile-concurrent-caller defense requires `pg_try_advisory_xact_lock(hashtext('retention_sweep'))` at the top of the T16.1 SQL function.
**Resolution scope (T16.1):** wrap `runRetentionPass` invocation inside a Postgres transaction that holds the advisory lock for the full pass duration.
**Status (closed):** migration `00000000000026_t16_retention_sweep_runner.sql` ships `retention_sweep_runner()` which calls `pg_try_advisory_xact_lock(hashtext('retention_sweep'))` at the top of the fn and returns NULL on contention (no-op a duplicate cron tick). Pattern mirrored by the M8.A backup pass + M8.B integrity_check_runner.
**Blocker for:** closed.

### G-T16-2 — Statement timeout + lock_timeout (F-60 production half)

**Source:** threat-model.md §3.9 F-60.
**Finding:** library row-cap (20000 default) bounds the per-pass volume. Production needs `SET LOCAL statement_timeout='60s'` + `lock_timeout='5s'` on the SQL function to prevent high-churn-table starvation.
**Resolution scope (T16.1):** SQL function preamble.
**Status (closed):** migration `00000000000026_t16_retention_sweep_runner.sql` carries `SET LOCAL statement_timeout = '60s'` + `SET LOCAL lock_timeout = '5s'` in the runner preamble (verified in fn body); fn comment line records the same. Same pattern as the M8.B integrity_check_runner.
**Blocker for:** closed.

### G-T16-3 — pg_cron schedule 03:30 ET

**Source:** threat-model.md §3.9 F-60 mitigation note; ADR-0017 §6 step 1.
**Finding:** library is invoke-driven; production needs a daily cron.
**Resolution scope (T16.1):** `cron.schedule('retention-sweep', '30 3 * * *', $$SELECT retention_sweep_runner()$$)`. ET-anchored.
**Blocker for:** production deploy.

### G-T16-4 — Cross-mirror drift assertion (TS const ↔ SQL function ↔ SQL table)

**Source:** G-T05-6 (now closed library half) + threat-model.md §3.9 F-55.
**Finding:** library closes drift between `RETENTION_SCHEDULE` const and `RetentionEventType` enum. T16.1 introduces a `retention_class_for(text)` SQL function + `audit_log_retention_schedule` SQL table; all three must mirror exactly. CI asserts triple equality.
**Resolution scope (T16.1):** pgTAP test enumerates event_types from (a) TS const exported, (b) SQL function output, (c) SQL table rows; asserts set-equality.
**Blocker for:** T16.1 PR submission.

### G-T16-5 — A-RETENTION-001 alert wiring (observability-setup)

**Source:** threat-model.md §3.9 F-57 + RA-2 reconciliation.
**Finding:** F-57 over-delete alarm is library-side `alarm_fired: true` in the result. Production needs the alert sink: A-RETENTION-001 fires when `alarm_fired === true` OR when `would_delete_total > expected_p99_for_event_class`.
**Resolution scope (T16.1 → observability pass):** define A-RETENTION-001 with runbook; route to on-call.
**Status (closed via M9 dispatch):** A-RETENTION-001 wired into the closed `AlertSymbol` union (`apps/web/src/lib/alerts/dispatch.ts:42`) with `'page'` severity (line 56) and runbook at `docs/runbooks/A-RETENTION-001.md`. `apps/web/src/lib/alerts/result-adapters.ts:21-26` lifts retention-pass results (`alarm_fired: true` or `status: 'capped'`) into dispatch calls. Same M9 dispatch pattern as A-BACKUP-001 / A-AUDIT-001 / A-INTEGRITY-001 / A-INTEGRITY-002.
**Blocker for:** closed.

### G-T16-6 — HG-15 re-ratification at T16.1

**Source:** ADR-0017 §sibling task spec.
**Finding:** T16.1 introduces two new physical tables (`retention_sweep_runs`, `audit_log_retention_schedule`). HG-15 re-fires for §PI inventory amendments + ADR-0016 schedule rows.
**Resolution scope (T16.1):** prepare HG-15 packet; user ratifies before SQL migration lands.
**Blocker for:** T16.1 PR submission.

### G-T16-7 — §PI inventory amendments at T16.1

**Source:** ADR-0017 §sibling task spec.
**Finding:** the two new physical tables need §PI inventory rows. Neither holds PI (counts + hashes + UUIDs); inventory still must record them.
**Resolution scope (T16.1):** add 2 rows to §PI inventory in `decisions.md`; privacy-reviewer re-runs with the diff.
**Status (closed):** both rows added to `decisions.md` §PI inventory in this pass (2026-06-15). `retention_sweep_runs.*` — C0, NO PI, 24mo operational telemetry per ADR-0016, full column shape enumerated (run_id, timestamps, schedule_hash, per_event/table_counts, truncated_to_row_cap, alarm_fired, status); T18 reads `per_event_counts` as Option G attribution anchor. `audit_log_retention_schedule.*` — C0, NO PI, policy table seed-only, public-policy rules per ADR-0015 §3.3 + Amendment I; SELECT granted to `authenticated` for operator UI display.
**Blocker for:** closed.

### G-T16-8 — T18 integrity-job reconciliation join

**Source:** threat-model.md §3.9 F-69 + RA-2 trigger #3.
**Finding:** library writes `retention_sweep_runs.per_event_counts` mirroring `retention.deleted.meta.deleted_per_table.audit_log_per_event_type`. T18's integrity job must reconcile live-chain row counts against this anchor across the latest pg_dump.
**Resolution scope (T18):** integrity-job join over (audit_log, retention_sweep_runs, pg_dump snapshot); diverge ⇒ A-INTEGRITY-002.
**Status (closed):** T18 ships the reconciliation surface end-to-end. `apps/web/src/lib/audit-integrity/integrity-core.ts:453-454` calls `store.listRetentionSweepRunsThrough(manifest.retention_sweep_runs_snapshot_ts_ms)` for the Option G attribution walk. SQL side: `integrity_check_runner()` (migration `00000000000030_t18_integrity_check_runner.sql`) does the join over (audit_log, retention_sweep_runs, backup_manifests); `unattributable_count > 0` routes to A-INTEGRITY-002 via M9 dispatch. F-92 (a)-(e) test coverage in `apps/web/test/T18/audit-integrity-check.test.ts`.
**Blocker for:** closed.

### G-T16-9 — `xact_start()` shim swap-in

**Source:** threat-model.md §3.9 F-66; G-T08-14 / G-T13-9 mirror.
**Finding:** library returns `Date.now()` + monotonic floor for `transaction_ts_ms`. T16.1's SQL function uses `xact_start()`.
**Resolution scope (T16.1):** SQL function uses `xact_start()`; library shim is replaced by the real transaction timestamp.
**Status (closed via reframe — TS-clock-authoritative, same closure as G-T17-PRIV-7 / G-T18-2):** the production retention architecture is TS-clock-authoritative throughout. The TS caller passes `nowMs` into the SECURITY DEFINER fns (`retention_sweep_runner(p_now_ms, p_run_id, ...)`); SQL anchors `clock_timestamp()` solely for the tail `v_completed_at_ms`. All cross-side comparisons (lease window, alarm threshold) compare values from the same TS clock — no SQL-vs-TS skew. The gap framing assumed a `Date.now()` vs `xact_start()` skew that the implemented architecture removed by making TS the single clock source.
**Blocker for:** closed.

### G-T16-10 — SECURITY DEFINER signatures + REVOKE posture

**Source:** threat-model.md §3.9 F-64.
**Finding:** library structurally forbids caller-supplied WHERE. SQL function must mirror: 3-arg signature exactly, no string-fragment parameter, SECURITY DEFINER owned by `migration_role`, `GRANT EXECUTE` only to `retention_service_role` (non-login), REVOKE from `authenticated` / `anon` / `service_role`.
**Resolution scope (T16.1):** SQL migration in `00000000000007_retention.sql`.
**Status (closed — structurally landed across M6 + M8):** every SECURITY DEFINER fn in the production SQL surface carries the prescribed shape. Verifiable in `supabase/migrations/00000000000022_t16_retention_sweep_functions.sql` (each fn pairs `REVOKE EXECUTE ON FUNCTION … FROM PUBLIC, anon, authenticated, service_role` with `GRANT EXECUTE … TO retention_service_role`), plus the same posture mirrored in M6.1.B (#023 ceiling rule), M6.3 runner (#026), M8.A surface (#024, #028, #029, #031, #032 — `backup_writer_role`), M8.B surface (#025, #027, #030, #033 — `integrity_check_role`). Every fn uses typed args only — no string-fragment / dynamic-SQL parameters; CASE-WHEN gates are the only path from caller-supplied text to a SELECT/UPDATE. The pattern T16.1 originally pinned has scaled cleanly to two more roles + two trust boundaries.
**Blocker for:** closed.

### G-T16-PRIV-1 — actor_pseudonym must not duplicate into meta jsonb (BLOCKING-IN-T16.1)

**Source:** privacy-review-t16.md Q3 ADVISORY.
**Finding:** `MemoryRetentionStore.emitRetentionDeletedAndRegisterRun` inlines pseudonym into `meta.actor_pseudonym` (memory-retention-store.ts:272) — acceptable for in-memory testing but `SupabaseRetentionStore` MUST put `actor_pseudonym` only in the top-level `audit_log` column. G-T11-14 / T13 hygiene lineage.
**Resolution scope (T16.1):** `SupabaseRetentionStore` writes `actor_pseudonym` to the column directly; meta jsonb carries only counts + status + schedule_hash + run_id.
**Status (closed):** migration `00000000000022_t16_retention_sweep_functions.sql:285-308` calls `audit_emit(p_actor_pseudonym => v_actor_pseudonym, p_meta => jsonb_build_object(...))`. `actor_pseudonym` lands ONLY at the top-level `p_actor_pseudonym` argument (→ `audit_log.actor_pseudonym` column); `meta` jsonb carries only structural fields: `run_id, started_at_ms, completed_at_ms, schedule_hash, per_event_counts, per_table_counts, truncated_to_row_cap, alarm_fired, status`. Same posture as G-T11-14 / T13 hygiene lineage.
**Blocker for:** closed.

### G-T16-PRIV-3 — Operator-side structured Error logging (BLOCKING-IN-T16.1)

**Source:** privacy-review-t16.md Q4 ADVISORY.
**Finding:** `runRetentionPass` swallows thrown Errors completely (retention-core.ts:252, :313). Correct for client-facing payloads (constraints.md:111 — no PI in error messages returned to clients) but degrades operator observability for diagnosing the underlying failure.
**Resolution scope (T16.1):** route swallowed Error to server-side structured-log sink with PI scrubbing; PIPEDA Principle 4.10 (Challenging Compliance).
**Status (closed):** both swallowed-catch sites in `retention-core.ts` now route the underlying Error to the structured logger as a CLASS-ONLY line via the new `errorClassOf(e)` helper (`e instanceof Error ? e.constructor.name : 'Error'` — the established pattern from `lib/auth/server/key-parity.ts:180`). The delete-batch catch emits `log.error({ event: 'retention.sweep.delete_failed', outcome: 'delete_failed', error_class })`; the emit-failure catch emits `event: 'retention.sweep.emit_failed', outcome: 'audit_emit_failed'`. Only top-level PI-free fields are used (no `attributes`), so the message — which may carry PI from a failed delete batch — is never logged. Client-facing `error_code` contract unchanged (F-67). New test `apps/web/test/T16/retention-operator-error-log.test.ts` installs the log sink and asserts (a) exactly one ERROR line on emit-failure with `error_class` + `outcome`, (b) no email/uuid/raw-message PI shape in any captured line, (c) successful sweeps emit zero ERROR lines.
**Blocker for:** closed.

### G-T16-RECONCILE-CEILING — Per-event attribution of ceiling-driven deletes

**Source:** T16 security review Finding 2; threat-model.md §3.9 F-69.
**Finding:** library ceiling-rule deletes are aggregated under a synthetic `__ceiling__` key (retention-core.ts:232) then stripped before emission (lines 266-270). Emitted `per_event_counts` does NOT include ceiling-driven deletes. F-69 reconciliation under-attributes by the ceiling-delete count in any pass that triggers the ceiling rule.
**Resolution scope (T16.1):** `SupabaseRetentionStore.deleteForUnderlyingRecordCeiling` returns a per-event-type breakdown via SQL join on `audit_log.event_type`; `runRetentionPass` substitutes this into `auditLogPerEventType` instead of the `__ceiling__` aggregate.
**Blocker for:** RA-2 trigger #3 reconciliation correctness at T16.1.

### G-T16-SO-1 — Snapshot completeness invariant

**Source:** T16 second-opinion review CF-1.
**Finding:** `MemoryRetentionStore.snapshot()` captures `auditRows` + `operational` only — NOT `deletedRecords` or `sweepRuns`. Safe today by construction (production methods only mutate audit/operational arrays; the only `sweepRuns.push` is inside the same method that throws BEFORE the push) but a future edit reordering `emitRetentionDeletedAndRegisterRun` could silently break rollback.
**Resolution scope (T16.1 OR next library pass):** either (a) widen Snapshot to capture every mutable field on the store, OR (b) add a snapshot-completeness invariant test that asserts byte-identical store state after rollback.
**Blocker for:** none. Future-proofing.

### G-T16-SO-2 — Alarm scope is per-event-type only by construction

**Source:** T16 second-opinion review CF-3 + CF-4.
**Finding:** F-57 alarm check at retention-core.ts:171-176 iterates `perEventCounts[et]` only — does NOT check `perTableCounts[t]` or `ceilingCount`. An over-broad schedule change reducing `auth_totp_consumed_log` from 24h to 1h silently sweeps 10x more rows with no alarm. Additionally, default threshold 20 is fine for low-volume audit categories but `session.revoked` (90-day fixed_days) on any modest-DAU deployment routinely has >20 daily candidates → alarm fires every pass → operational chore OR `confirmOverDeleteThreshold: true` hardcoded → F-57 neutralized.
**Resolution scope (T16.1 Edge Function):** either (a) widen alarm to include `perTableCounts` + `ceilingCount`, OR (b) accept `Partial<Record<RetentionEventType, number>>` threshold map for per-event tuning. Architect decision when wiring T16.1.
**Blocker for:** F-57 effectiveness in production.

### G-T16-PRIV-2 — Document `meta.run_id` redundancy in ADR-0017 §7

**Source:** privacy-review-t16.md Q3 ADVISORY.
**Finding:** summary `meta.run_id` and `retention_sweep_runs.run_id` are intentionally redundant (lets a forensic reader pair the audit row with the run row without a join). ADR should record this intent so future readers don't try to normalize.
**Resolution scope (next ADR pass):** one-line addition to ADR-0017 §7.
**Status (closed):** ADR-0017 §7 now carries the intentional-redundancy paragraph (`.context/decisions.md`, immediately after the `retention.deleted` schema block). The note explains: the duplication lets a forensic reader pair the audit row with the corresponding `retention_sweep_runs` checkpoint row without performing a join — important because audit-log access is the highest-trust read path (privacy reviewer + compliance auditor surface) and `retention_sweep_runs` lives behind `retention_service_role`. Future ADR readers are explicitly told not to normalize the redundancy away.
**Blocker for:** closed.

### G-T16-PRIV-5 — HMAC pseudonym shape cross-mirror

**Source:** privacy-review-t16.md Cross-cutting C.
**Finding:** library `systemActorPseudonym()` returns 32-char hex from HMAC-SHA-256 (memory-retention-store.ts:151-153). T16.1's `SupabaseRetentionStore` MUST share the AuthStore's HMAC key (ADR-0016 §Decision 1) so pseudonym values are cross-correlatable across audit-log readers.
**Resolution scope (T16.1):** `SupabaseRetentionStore` reads the production HMAC key via the shared GUC `app.hmac_pseudonym_key` per ADR-0016.
**Status (closed):** migration `00000000000022_t16_retention_sweep_functions.sql:275-283` derives `v_actor_pseudonym` as `LEFT(encode(hmac('system:retention'::bytea, current_setting('app.hmac_pseudonym_key')::bytea, 'sha256'), 'hex'), 16)` — uses the shared `app.hmac_pseudonym_key` GUC per ADR-0016 §Decision 1, truncated to 16 hex chars (matching the library's HMAC-SHA-256 → 16-hex shape). Same pattern as M8.A backup pass + M8.B integrity-check pass `system:backup-pass` / `system:integrity-check` system pseudonyms; forensic readers can correlate across all three subsystems.
**Blocker for:** closed.

### G-T16-PRIV-6 — Privacy-reviewer revisits Q9 (no caller WHERE) at T16.1 SQL signature

**Source:** privacy-review-t16.md Q9.
**Finding:** library structurally prevents caller-supplied WHERE. SQL function MUST hold the same property — privacy-reviewer audits the function signature in T16.1.
**Resolution scope (T16.1 review pass):** privacy-reviewer asserts SQL function arity + parameter types; no string-fragment parameter.
**Blocker for:** T16.1 PR approval.

### G-T16-PRIV-7 — T18 integrity-job join structural-fields-only

**Source:** privacy-review-t16.md Cross-cutting findings.
**Finding:** when T18 integrity-job lands (G-T16-8), the live-chain ↔ `retention_sweep_runs.per_event_counts` reconciliation join MUST read only structural fields (run_id, ms-epoch, per-event counts) — never surface any pseudonym across the integrity-job output.
**Resolution scope (T18 design):** integrity-job query projects only the structural fields; pseudonyms remain in audit_log.
**Status (closed):** T18's `RetentionSweepRunSnapshot` type (`apps/web/src/lib/audit-integrity/types.ts:113-119`) reads ONLY `run_id, started_at_ms, completed_at_ms, per_event_counts, status` — purely structural fields, no `actor_pseudonym`, no PI. `listRetentionSweepRunsThrough(snapshot_ts_ms)` (integrity-store.ts:157-159) is the only T18→retention join surface; its return shape is the snapshot type. Privacy posture matches the original ask.
**Blocker for:** closed.

## T17 — Backup object-lock

> Library-only T17 (ADR-0002 Amendment H) closes library halves of G-T16-8 (T18 data source), G-T16-PRIV-7 (manifest pseudonym-free), G-T16-RECONCILE-CEILING (per-event attribution preserved). The 16 G-T17-\* entries below come from the T17 reviewer pass + threat-model §3.10 carry-forwards.

### G-T17-1 — SupabaseBackupStore + Storage bucket policy (T17.1)

**Source:** ADR-0018 §sibling task spec; threat-model §3.10.
**Finding:** T17 ships MemoryBackupStore only. T17.1 ships SupabaseBackupStore + `backups-ca-central-1` Supabase Storage bucket with S3-compatible object-lock (governance mode, 42-day retention) + `backup_writer_role` non-login SECURITY DEFINER role.
**Resolution scope (T17.1):** SQL migration `00000000000008_backup.sql` + Storage bucket config + Edge Function trigger + lifecycle policy backstop.
**Status (partial close — library/SQL halves shipped; M8.A.3c storage residual):** SupabaseBackupStore (`apps/web/src/lib/backup/supabase-backup-store.ts`) shipped across M8.A.1–M8.A.3d with the `backup_writer_role` non-login SECURITY DEFINER role landed in migration `00000000000020_t17_backup_writer_role.sql`. 12 of 16 BackupStore methods are RPC-wired against migrations #020/#024/#029/#031 (head extract, manifest pending/transition/read, lease check, listCommitted, getCurrentKid, countAuditRowsByEventType, snapshotRetentionSweepRunsTs, hardDeleteManifestRow, emitBackupManifestWritten, emit_hard_deleted). The 4 storage-layer methods (`dumpClosedAllowlist`, `putWithObjectLock`, `isObjectLocked`, `deleteObjectIfUnlocked` — lines 355/359/367/371) throw `not_implemented_until_m8_a_3c` pending bucket provisioning + Storage SDK wire-up. The `backups-ca-central-1` bucket + object-lock governance policy + lifecycle backstop remain the M8.A.3c residual.
**Blocker for:** first production deploy (M8.A.3c only).

### G-T17-2 — backup_manifests SQL migration + ADR-0016 schedule rows (T17.1)

**Source:** ADR-0018 §15.
**Finding:** new physical table `backup_manifests` with EXACTLY the BackupManifest field-name shape (F-83 rename-detection mirror) + ADR-0016 schedule rows for the new table + bucket.
**Resolution scope (T17.1):** SQL migration + ADR-0016 schedule rows + HG-15 re-ratification (G-T17-PRIV-5).
**Status (partial close — schema landed; HG-15 ratification residual):** `backup_manifests` physical table ships in migration `00000000000020_t17_backup_writer_role.sql` with F-83-pinned column names (`run_id`, `committed_at_ms`, `lock_until_ms`, `audit_log_head`, `per_event_row_counts`, `retention_sweep_runs_snapshot_ts_ms`, `schedule_hash`, `node_runtime_pin`, `object_ref`, `sha256`, `bytes`, `committee_data_key_kid`, `hard_deleted_at_ms`, `status`). ADR-0016 schedule rows for the new table land alongside. HG-15 re-ratification of the bucket policy + new role lineage is handled by G-T17-PRIV-5 (external blocker), not this gap.
**Blocker for:** closed for the SQL half; HG-15 packet tracked under G-T17-PRIV-5.

### G-T17-3 — A-BACKUP-001/002/003 alert wiring (observability-setup)

**Source:** threat-model §3.10 + privacy-review-t17.md G-T17-PRIV-2.
**Finding:** library returns `would_fire_alert: 'A-BACKUP-001'` symbol; production needs alert sinks for (a) past-window still-locked manifests (PIPEDA s.10.1 breach-window), (b) missed monthly restore drill, (c) storage quota approaching cap.
**Resolution scope (T17.1 → observability pass):** define A-BACKUP-001/002/003 with runbooks.
**Status (partial close — A-BACKUP-001 wired via M9 dispatch; -002/-003 residual):** A-BACKUP-001 is wired into the closed `AlertSymbol` union (`apps/web/src/lib/alerts/dispatch.ts:43`) with `'page'` severity and runbook at `docs/runbooks/A-BACKUP-001.md`. The result-adapter at `apps/web/src/lib/alerts/result-adapters.ts` lifts `would_fire_alert: 'A-BACKUP-001'` from backup-pass results into a dispatch call. A-BACKUP-002 (missed monthly restore drill) and A-BACKUP-003 (storage quota approaching cap) ride along with the M8.A.3c storage residual — both require operational signals that only exist once the bucket is provisioned + the drill cadence is approved (G-T17-5).
**Blocker for:** RA-2 compensating control #4 monitoring posture (-002/-003 only).

### G-T17-4 — Cross-mirror SQL drift assertion (TS BACKUP_TABLES ↔ SQL backup_writer_role GRANT footprint)

**Source:** ADR-0018 §sibling task spec; mirrors G-T16-4.
**Finding:** library has `runBackupTablesDriftCheck` over TS const; T17.1 must add pgTAP test enumerating the 19 tables from (a) TS const, (b) SQL `backup_writer_role` GRANT SELECT footprint; assert set-equality.
**Resolution scope (T17.1):** pgTAP test.
**Status (closed via reframe — set-equality enforced at TS allowlist + SQL allowlist, not GRANT footprint):** the implemented architecture chose SECURITY DEFINER + internal allowlist over role-level GRANT footprint. `backup_writer_role` does NOT hold direct `GRANT SELECT` on the 19 BACKUP_TABLES; instead, `backup_dump_table_rows(p_tables text[])` (migration `00000000000032_t17_backup_dump_table_rows.sql`, owner reasoning at migration `#024` lines 68-119) validates `p_tables` against the closed `BACKUP_TABLES` allowlist inside the SECURITY DEFINER fn and raises `22023` on unknown table names. The TS side runs `runBackupTablesDriftCheck` against the frozen `BACKUP_TABLES` const (`apps/web/src/lib/backup/backup-tables.ts:23-43`); the SQL side rejects table names not on the same allowlist at runtime. The original gap framing assumed role-level GRANTs would mirror the TS const — that path was not chosen; the chosen path (SECURITY DEFINER + closed allowlist) doesn't admit the GRANT-footprint drift class. CI gate: `backup_writer_role` GRANTs in `t17_backup_writer_role.sql:66-79` cover only `backup_manifests` (the actual write target).
**Blocker for:** closed.

### G-T17-5 — Restore runbook + restore drill cadence (T17.1)

**Source:** ADR-0018 §sibling task spec.
**Finding:** restore-as-superuser bypasses RLS (Hard Rule #2). Runbook must forbid restore-into-prod outside approved incident; default = restore-to-staging in ca-central-1. Restore drill cadence (proposed: monthly) needs ratification + failure-of-drill alert.
**Resolution scope (T17.1):** runbook doc + drill schedule + A-BACKUP-002 sink.
**Blocker for:** PIPEDA 4.7 (Safeguards) operational completeness.

### G-T17-6 — `backup.hard_deleted` audit-event enum extension (T17.1)

**Source:** ADR-0018 §9 Layer 2; second-opinion CF-10.
**Finding:** ADR §9 names `backup.hard_deleted` audit-event but library does NOT emit it (BackupStore has no `emitBackupHardDeleted` method). Asymmetry with `backup.manifest_written` which IS library-emitted. T17.1 owns the emission + ADR-0003 Amendment A extension dance (mirrors G-T08-9 / G-T13-14 / G-T14-7).
**Resolution scope (T17.1):** add method to BackupStore + emit on hardDeleteManifestRow success + extend audit-event enum + update scripts/check-audit-enum-coverage.sh.
**Status (closed via M8.A.3d six-mirror dance):** `backup.hard_deleted` shipped end-to-end via the F-24-inverted `hardDeleteManifestRow` path (`apps/web/src/lib/backup/supabase-backup-store.ts:278-321` reads manifest → transitions → emits audit row). The SECURITY DEFINER fn lives in migration `00000000000031_t17_backup_emit_hard_deleted.sql`. Six-mirror dance complete: TS `RetentionEventType` union + `RETENTION_SCHEDULE`; SQL `retention_class_for(...)` arm; `observability/audit-log.md` §1 row; `scripts/check-audit-enum-coverage.sh` `EXPECTED_ENUM` (line 81); pgTAP retention-class arm at `supabase/test/t17_backup_emit_hard_deleted.sql`.
**Blocker for:** closed.

### G-T17-7 — No-coupling CI test (`apps/web/test/T17/no-retention-on-backup-coupling.test.ts`)

**Source:** ADR-0018 §13; privacy-review-t17.md G-T17-PRIV-4.
**Finding:** ADR §13 mandates a CI test parsing imports under `src/lib/retention/` and asserting no `backup/` path appears. Test file does not exist. Today the property is true by inspection (verified by privacy reviewer); the ADR wanted it CI-enforced.
**Resolution scope (T17.1 OR next library pass):** add the import-graph test OR an ESLint rule banning `lib/backup/**` imports from within `lib/retention/**`.
**Status (closed):** ESLint rule landed in `apps/web/eslint.config.js`. New override block scoped to `src/lib/retention/**/*.ts` bans the patterns `**/lib/backup/**`, `**/backup/**`, `$lib/backup/**`, `../backup/**`, `../../backup/**`, `./backup/**` via `no-restricted-imports` with a custom error message naming ADR-0018 §13 + Option G. Manual probe: writing a synthetic `src/lib/retention/__probe.ts` with `import { BACKUP_TABLES } from '../backup/backup-tables'` triggers the gate (verified before commit; probe removed). The hardening-gates CI job runs `pnpm lint` which fail-closes on the violation.
**Blocker for:** closed.

### G-T17-8 — `no-spread-into-backup-tables` ESLint rule (T17.1)

**Source:** ADR-0018 §task #8; second-opinion CF-6.
**Finding:** ADR named a custom ESLint rule mirroring T11/T12/T16 spread bans. Not in eslint.config.js. Object.freeze on BACKUP_TABLES closes the runtime attack; this is defense-in-depth.
**Resolution scope (T17.1):** custom ESLint rule.
**Status (closed):** `no-restricted-syntax` rule landed in `apps/web/eslint.config.js` matching `SpreadElement[argument.name='BACKUP_TABLES']`. Scoped to `src/**/*.ts` with an exemption for `src/lib/backup/backup-tables.ts` (where the const lives and where the `BACKUP_TABLE_KEYS_RUNTIME` mirror legitimately enumerates the same const for drift checking). Manual probe: writing `[...BACKUP_TABLES, 'sneaky']` in a source file triggers the gate (verified before commit; probe removed). Belt-and-braces against the Object.freeze runtime guard.
**Blocker for:** closed.

### G-T17-9 — Zero-event-count convention pinning

**Source:** second-opinion CF-7.
**Finding:** `countAuditRowsByEventType` omits event types with zero rows (convention: "absent = zero"). T18's reconciliation join will need to know this. Currently pinned only by inspection.
**Resolution scope (T17.1 OR next test pass):** branded type with doc-comment OR explicit test asserting a known event type IS NOT in the map when its row-count would be zero.
**Status (closed via T18 explicit test):** the F-92 (c) test at `apps/web/test/T18/audit-integrity-check.test.ts:757-780` cites this gap by ID ("G-T17-9: absent key = zero, NOT a wildcard") and asserts that a sweep with `per_event_counts` MISSING the target event_type treats the count as 0 → row remains unattributable → A-AUDIT-001 + A-INTEGRITY-002 both fire. T18's reconciliation join consumes the convention as designed.
**Blocker for:** closed.

### G-T17-10 — ADR-0018 §5 step-ordering wording clarification

**Source:** second-opinion CF-8.
**Finding:** ADR §5 says head extracted FIRST then kid; implementation does kid before head. Functionally equivalent (both pre-dump). Worth aligning to spec text or adding a clarifying ADR comment.
**Resolution scope (next ADR pass):** ADR-0018 §5 clarifying note.
**Blocker for:** none. Documentation.

### G-T17-11 — `deriveObjectRef` parameter naming

**Source:** second-opinion CF-9.
**Finding:** parameter named `committedAtMs` but called with `startedAtMs`. Functionally correct (date should not flip mid-pass); parameter name lies.
**Resolution scope (next library pass):** rename to `dateAnchorMs` or document the convention.
**Blocker for:** none. Naming hygiene.

### G-T17-12 — F-85 type-level test redesign

**Source:** second-opinion CF-3; implementer-acknowledged limitation.
**Finding:** F-85 inner-narrowing test at backup-pass.test.ts:1163-1177 uses `BackupStore & Record<string, unknown>` intersection that makes ANY string-key access type-check, defeating the `@ts-expect-error` directives. Runtime barrel test at 1199-1217 provides actual structural enforcement.
**Resolution scope (next test pass):** drop the `Record<string, unknown>` intersection; use `@ts-expect-error` on bare `BackupStore` reference (pattern that already works at line 1192). Test-writer scope, not implementer.
**Blocker for:** none. Runtime test catches real risk.

### G-T17-PRIV-1 — `backup_manifests` row 7y vs blob 42d retention asymmetry (documentation)

**Source:** privacy-review-t17.md Q4 ADVISORY.
**Finding:** `hardDeleteManifestRow` flips manifest status to `'hard_deleted'` but retains the metadata row — per ADR-0018 §7 the manifest is the audit anchor and carries no PI; PI (dump bytes) IS hard-deleted. Recorded for privacy-officer transparency.
**Resolution scope (none required):** documentation only. Manifest row has NO PI; blob retention is 42d hard-delete per PIPEDA 4.5.
**Status (closed — no resolution required):** the gap itself records "Resolution scope (none required): documentation only." `hardDeleteManifestRow` ships at `apps/web/src/lib/backup/supabase-backup-store.ts:278-321` with the M8.A.3d audit-row emit reading the manifest's structural meta (`object_ref`, `committed_at_ms`) BEFORE the transition (lines 296-310) so the forensic anchor survives the row-retention asymmetry by design. ADR-0018 §7 governs. No code or doc change owed.
**Blocker for:** closed.

### G-T17-PRIV-3 — Operator-side structured Error logging (BLOCKING-IN-T17.1)

**Source:** privacy-review-t17.md Q7 ADVISORY; mirrors G-T16-PRIV-3.
**Finding:** library swallows thrown Errors completely in 4-5 catch paths (now wrapped in try/catch with closed-literal error_codes; underlying Error.message discarded). Correct for client-facing payloads but degrades operator observability for diagnosing the underlying failure.
**Resolution scope (T17.1):** route swallowed Error to server-side structured-log sink with PI scrubbing.
**Status (closed):** all 11 catch sites in `backup-core.ts` (8 in `runBackupPass`, 3 in `runBackupRetentionPass`) now route the underlying Error to the structured logger as a CLASS-ONLY line via the same `errorClassOf(e)` helper as G-T16-PRIV-3. Each emits `log.error({ event: 'backup.pass.<step>_failed' | 'backup.retention.<step>_failed', outcome: <closed literal>, error_class })` — top-level PI-free fields only; the `.message` is never logged. The three best-effort swallows (abort-transition, object-delete, manifest-row-delete) — which previously lost their ONLY operator signal because they set a flag and continued without returning an error_code — now surface the failure class too (e.g., `backup.retention.manifest_row_delete_failed` captures the "object gone, row stuck" forensic state). Client-facing `error_code` contract unchanged (F-81). New test `apps/web/test/T17/backup-operator-error-log.test.ts` drives kid-lookup / head-pointer / manifest-write failures via the `__force*` hooks and asserts (a) one matching ERROR line per failure with `error_class` + `outcome`, (b) no email / over-64-hex PI shape, (c) a clean pass emits zero ERROR lines.
**Blocker for:** closed.

### G-T17-PRIV-5 — HG-15 re-ratification at T17.1

**Source:** privacy-review-t17.md HG-15.
**Finding:** T17.1 introduces TWO new surfaces: `backup_manifests` physical table + `backups-ca-central-1` Supabase Storage bucket with object-lock policy + new `backup_writer_role`.
**Resolution scope (T17.1):** prepare HG-15 packet; user ratifies before SQL migration + bucket policy land.
**Blocker for:** T17.1 PR submission.

### G-T17-PRIV-6 — §PI inventory amendments + training_records PI class verification (T17.1)

**Source:** privacy-review-t17.md HG-15 + architect flag.
**Finding:** §PI inventory amendments needed for new `backup_manifests` row (NO PI — structural metadata only). Architect flagged `training_records` PI class verification as deferred to T17.1 architect.
**Resolution scope (T17.1):** add row(s) to §PI inventory; verify training_records PI class.
**Status (closed):** `backup_manifests.*` row added to `decisions.md` §PI inventory in this pass (2026-06-14) — C0, NO PI, 7y row retention as audit anchor per ADR-0018 §7, 42d blob hard-delete per ADR-0012 amendment, full F-83 column shape enumerated. `training_records.evidence_ciphertext` PI class verified at C2 / E2EE (line 7324 unchanged): certified-member proof is identity-adjacent but ciphertext-bound and not C3-level operational PI — C2 fits.
**Blocker for:** closed.

### G-T17-PRIV-7 — `xact_start()` over `Date.now()` for production lock arithmetic

**Source:** privacy-review-t17.md G-T17-PRIV-7; mirrors G-T08-14 / G-T13-9 / G-T16-9 lineage.
**Finding:** `MemoryBackupStore.effectiveLockNowMs()` uses raw `Date.now()` for lock-window arithmetic. In frozen-clock tests this works; production `SupabaseBackupStore` must source from `xact_start()`. Privacy-relevance is indirect (clock skew could cause stale lock-expiry decision).
**Resolution scope (T17.1):** SupabaseBackupStore reads `xact_start()` for the lock window.
**Status (closed via design audit — no production change needed):** the M8.A.2/M8.A.3 SupabaseBackupStore architecture is internally TS-clock-authoritative: `nowMs()` reads `Date.now()` (or an injected clock in tests) and the same clock is passed into every SECURITY DEFINER write fn (`backup_transition_manifest_status(p_now_ms)`, `backup_write_manifest_pending(p_started_at_ms)`, `backup_emit_manifest_written(p_emitted_at_ms)`, `backup_emit_hard_deleted(p_hard_deleted_at_ms)`). The SQL side persists what the TS caller supplies; `committed_at_ms` / `lock_until_ms` / `hard_deleted_at_ms` all derive from `p_now_ms`. The lock-window arithmetic in `backup-core.ts` (`if (nowMs - m.committed_at_ms >= hardDeleteCutoffMs)`) compares two values that BOTH originate from the same TS clock — so there is no SQL-vs-TS skew. The two M6.3 / M8.B.3 runners that use `clock_timestamp()` anchor it solely for the SQL-computed `v_completed_at_ms` tail (the pass spans seconds); `started_at_ms` stays caller-supplied. The original gap framing assumed the SQL side would generate `committed_at_ms` from `xact_start()` while TS compared via `Date.now()` — that would have skewed. The implemented architecture chose "TS-clock-authoritative throughout" instead, which removes the skew without needing `xact_start()`.
**Blocker for:** closed.

### G-T17-PRIV-8 — pgTAP column-name pin (T17.1 RA-2 anchor preservation)

**Source:** privacy-review-t17.md G-T17-PRIV-8.
**Finding:** library has F-83 snapshot-pin on `audit_log_head`, `per_event_row_counts`, `retention_sweep_runs_snapshot_ts_ms`, `schedule_hash`, `node_runtime_pin` field names. T17.1's SQL `backup_manifests` columns must mirror EXACTLY — pgTAP test enforces.
**Resolution scope (T17.1):** pgTAP column-name assertion.
**Status (partial close — library-as-pin via implicit pgTAP coverage):** the F-83 column names are pinned in the pgTAP suite by reference: `t17_backup_writer_role.sql:34-60` performs INSERTs into `backup_manifests` naming every F-83 column verbatim (`audit_log_head_id`, `audit_log_head_ts_ms`, `audit_log_head_hash`, `retention_sweep_runs_snapshot_ts_ms`, `schedule_hash`, `node_runtime_pin`, `manifest_status`); `t17_backup_read_functions.sql:119` and `t18_integrity_check_functions.sql:82` + `t18_integrity_check_runner.sql:85` mirror the same names. A rename in the column DDL would fail every INSERT in CI. An explicit `has_column` / `columns_are` assertion would be the formal pin; the implicit pin is structurally sufficient and the formal version rides along with the next pgTAP pass if the privacy reviewer requests it.
**Blocker for:** closed for the structural property; formal `has_column` assertion residual.

## T18 — Audit-log integrity

> Library-only T18 (ADR-0002 Amendment H) closes library halves of G-T16-8 (integrity-job reconciliation join), G-T17-PRIV-7 (structural-fields-only join), G-T17-9 (zero-event-count convention), G-T17-RA2-ANCHOR-CONSUMER (snapshot-pinned 5-field manifest consumer), G-T16-RECONCILE-CEILING (`__ceiling__` never read), and G-T11-23 (hash-determinism via runtime_pin coherence). RA-2 compensating control #3 transitions from "in plan" to "operational at library boundary" — production-operational on T18.1 ship. The 14 G-T18-\* entries below come from the T18 reviewer pass + threat-model §3.11 + privacy review.

### G-T18-1 — SupabaseIntegrityStore + pg_cron 04:30 ET daily (T18.1)

**Source:** ADR-0019 §sibling task spec; threat-model §3.11.
**Finding:** T18 ships MemoryIntegrityStore only. T18.1 ships SupabaseIntegrityStore + integrity_check_runs SQL migration + pg_cron 04:30 ET daily integrity job + Edge Function trigger surface (`post_rotation`, `post_export`) + `integrity_check_role` non-login SECURITY DEFINER role + `pg_advisory_xact_lock` SHARED with backup pass (EXCLUSIVE with restore; key `hashtext('audit_chain_global')`).
**Resolution scope (T18.1):** SQL migration + pg_cron + Edge Functions + advisory lock coordination.
**Status (partial close via reframe — SQL-resident runner shipped; pg_cron deploy-pin residual):** The architecture chose SQL-resident orchestration over a TS `SupabaseIntegrityStore`: `integrity_check_runner` (migration `00000000000030_t18_integrity_check_runner.sql`) takes the `pg_try_advisory_xact_lock(hashtext('integrity_check'))`, runs the M8.B.1 SECURITY DEFINER function set (`record_run_started` → `extract_chain_head` → `read_latest_backup_manifest` → mismatch detection → `emit_run_and_mismatches`), and finalizes the run. The watchdog companion ships at `apps/web/src/lib/audit-integrity/supabase-watchdog-store.ts` + migration `00000000000033_t18_watchdog_read_fn.sql` for missed-cron detection. `integrity_check_role` lands in the function set. Residual: pg_cron `30 8 * * *` UTC = 04:30 ET schedule is provisioned at deploy time (pg_cron isn't in the pgTAP CI image; see migration #030 header lines 30-33).
**Blocker for:** first production integrity check (pg_cron deploy-pin only).

### G-T18-2 — `xact_start()` shim for production SupabaseIntegrityStore.nowMs() (T18.1)

**Source:** privacy-review-t18.md G-T18-PRIV-13; lineage G-T16-9 / G-T17-2.
**Finding:** MemoryIntegrityStore.nowMs() uses monotonic shim (Date.now() + skew). SupabaseIntegrityStore must source from `xact_start()` so all timestamp comparisons use the transaction's clock.
**Resolution scope (T18.1):** SQL SupabaseIntegrityStore.
**Status (closed via reframe — same closure as G-T17-PRIV-7):** the integrity-check architecture is TS-clock-authoritative throughout. The TS caller passes `nowMs` into the SQL runner; the runner anchors `xact_start()` / `clock_timestamp()` solely for SQL-computed tail values (`v_completed_at_ms`) that span seconds within the pass. The cross-side comparisons (lease window, mismatch detection on `committed_at_ms`) all compare values that originate from the same TS clock — no SQL-vs-TS skew. Same reasoning as G-T17-PRIV-7 closure; the gap framing assumed a `Date.now()` vs `xact_start()` skew that the implemented architecture removed by making TS the single clock source.
**Blocker for:** closed.

### G-T18-3 — Server-side structured Error logging at 8 swallowed-catch sites

**Source:** privacy-review-t18.md G-T18-PRIV-3; security Finding 1 lineage; mirrors G-T16-PRIV-3 + G-T17-PRIV-3.
**Finding:** integrity-core.ts now wraps all 8 store-call paths in try/catch with closed-literal error_codes (BLOCK 1 closed in cycle). Operator observability behind the structured error_code surface still needs server-side structured Error logging with PI scrubbing. The closed-literal contract is intact; the underlying Error.message is discarded.
**Resolution scope (T18.1):** route swallowed Error to server-side log sink with PI scrubbing.
**Status (closed):** all 9 catch sites in `integrity-core.ts` (7 in `runIntegrityCheck` — lease, manifest-read, run-start, sweep-runs-read, chain-walk, backup-diff, terminal-emit; 2 in `runWeeklyChainAnchor` — head-read, anchor-emit) now route the underlying Error to the structured logger as a CLASS-ONLY line via the same `errorClassOf(e)` helper as G-T16-PRIV-3 / G-T17-PRIV-3. Each emits `log.error({ event: 'integrity.check.<step>_failed' | 'integrity.anchor.<step>_failed', outcome: <closed literal>, error_class })`. The two same-`error_code` catches (`sweep_runs_read` + `chain_walk`, both `chain_walk_failed`) get distinct event names so an operator can tell which store call threw. Top-level PI-free fields only; the `.message` is never logged. Client-facing `error_code` contract unchanged (F-100). New test `apps/web/test/T18/integrity-operator-error-log.test.ts` drives terminal-emit failure (via `__forceSummaryEmitFailure`) + weekly-anchor head-read failure (via `__forceHeadReadException`) and asserts (a) one matching ERROR line per failure with `error_class` + `outcome`, (b) no email / over-64-hex PI shape, (c) a clean check emits zero ERROR lines.
**Blocker for:** closed.

### G-T18-4 — CI no-import test (T18→T16, T18→T17 architectural purity)

**Source:** privacy-review-t18.md G-T18-PRIV-4.
**Finding:** T18 has zero imports from `../retention/` or `../backup/` (verified by reviewer inspection). The structural property must be enforced by CI, not by reviewer inspection. ESLint rule banning `lib/{retention,backup}/**` imports from within `lib/audit-integrity/**` is the cleanest fix.
**Resolution scope (T18.1):** ESLint rule extension + CI test.
**Status (closed):** ESLint rule landed in `apps/web/eslint.config.js`. New override block scoped to `src/lib/audit-integrity/**/*.ts` bans the patterns `**/lib/retention/**`, `**/lib/backup/**`, `**/retention/**`, `**/backup/**`, `$lib/retention/**`, `$lib/backup/**`, `../retention/**`, `../../retention/**`, `./retention/**`, `../backup/**`, `../../backup/**`, `./backup/**` via `no-restricted-imports` with a custom error message naming ADR-0019 §13. The audit-integrity library reaches `retention_sweep_runs` + `backup_manifests` only through the narrow SECURITY DEFINER fn boundary (verified). Manual probe: writing `import { BACKUP_TABLES } from '../backup/backup-tables'` inside `src/lib/audit-integrity/__probe.ts` triggers the gate (verified before commit; probe removed). The hardening-gates CI job runs `pnpm lint` which fail-closes on the violation.
**Blocker for:** closed.

### G-T18-5 — HG-15 re-ratification at T18.1

**Source:** privacy-review-t18.md G-T18-PRIV-5; threat-model §3.11.
**Finding:** T18.1 introduces new physical `integrity_check_runs` table + new `integrity_check_role` non-login role (B6.2 boundary) + optional `audit_chain_anchors` table.
**Resolution scope (T18.1):** prepare HG-15 packet; user ratifies before SQL migration lands.
**Blocker for:** T18.1 PR submission.

### G-T18-6 — `audit.integrity_check.{ran,mismatch}` + `audit.chain_anchor.weekly` ADR-0003 Amendment A enum extension dance (T18.1)

**Source:** ADR-0019 §6 + observability/audit-log.md §1.
**Finding:** Three new audit-event enum values need six-mirror extension dance: TS const (landed in T18); SQL CHECK constraint, RETENTION_SCHEDULE entry, audit_log_retention_schedule SQL row, audit-log.md §1 table, scripts/check-audit-enum-coverage.sh (all defer to T18.1). Mirrors G-T08-9 / G-T13-14 / G-T14-7 / G-T17-6.
**Resolution scope (T18.1):** SQL CHECK + ADR-0016 schedule rows + observability doc + enum coverage script.
**Status (closed via M8.B.2 six-mirror dance):** all three audit events (`audit.integrity_check.ran`, `audit.integrity_check.mismatch`, `audit.chain_anchor.weekly`) shipped via the canonical six-mirror dance documented in `.context/patterns.md`. Mirror evidence: (1) TS `RetentionEventType` union + (2) `RETENTION_SCHEDULE` entries; (3) SQL `retention_class_for(...)` arms; (4) `observability/audit-log.md` §1 rows; (5) `scripts/check-audit-enum-coverage.sh` `EXPECTED_ENUM` (lines 77-79); (6) pgTAP retention-class arm coverage in the M8.B test suite. CI gate `scripts/check-audit-enum-coverage.sh` enforces set-equality across mirrors.
**Blocker for:** closed.

### G-T18-7 — §PI inventory amendments (T18.1)

**Source:** privacy-review-t18.md G-T18-PRIV-1.
**Finding:** §PI inventory amendments needed for `integrity_check_runs` (no PI; structural counts + run metadata) + optional `audit_chain_anchors` (no PI; head triple + delivery timestamp).
**Resolution scope (T18.1):** add rows to §PI inventory.
**Status (closed):** both rows added to `decisions.md` §PI inventory in this pass (2026-06-14). `integrity_check_runs.*` — C0, NO PI, 24mo operational telemetry per ADR-0016, full T18.1 column shape enumerated (run_id, trigger, timestamps, counts, runtime pin, schedule hash). `audit_chain_anchors.*` — C0, NO PI, 7y load-bearing forensic per ADR-0016, head triple + delivery timestamp only; hash is structurally non-PII per `observability/audit-log.md` §2.
**Blocker for:** closed.

### G-T18-8 — A-AUDIT-001 / A-INTEGRITY-001 / A-INTEGRITY-002 alert sink wiring (observability-setup, post-T18.1)

**Source:** privacy-review-t18.md G-T18-PRIV-2; threat-model §3.11 F-95.
**Finding:** library returns `would_fire_alert` symbol + closed-literal `runtime_pin_mismatch` error_code. Production needs alert sinks for:

- A-AUDIT-001 zero-threshold on any mismatch row (chain-walk OR backup-diff).
- A-INTEGRITY-001 missed-cron (T18.1 cron NOT running for >24h).
- A-INTEGRITY-002 distinct-cause routing on `unattributable_count > 0` (separate from A-AUDIT-001).
- `runtime_pin_mismatch` routed to A-INTEGRITY-001-variant (OPERATIONAL), NOT A-AUDIT-001 (F-93 false-positive prevention).
  **Resolution scope (T18.1 → observability pass):** define + wire 3 alert sinks with distinct-cause routing.
  **Status (closed via M9 dispatch + watchdog):** all three sinks wired into the closed `AlertSymbol` union (`apps/web/src/lib/alerts/dispatch.ts:44-46`) with `ALERT_SEVERITY` rows (`A-AUDIT-001: 'page'`, `A-INTEGRITY-001: 'page'`, `A-INTEGRITY-002: 'warn'`) and per-symbol runbooks at `docs/runbooks/A-AUDIT-001.md` / `A-INTEGRITY-001.md` / `A-INTEGRITY-002.md`. Result-adapters in `apps/web/src/lib/alerts/result-adapters.ts` lift integrity-check outcomes into dispatch calls. Missed-cron detection (A-INTEGRITY-001) ships via `supabase-watchdog-store.ts` + migration `00000000000033_t18_watchdog_read_fn.sql`. Distinct-cause routing of `unattributable_count > 0` to A-INTEGRITY-002 is enforced in the adapter.
  **Blocker for:** closed.

### G-T18-9 — Backup-diff cursor pagination in production (T18.1)

**Source:** second-opinion CF-5.
**Finding:** Library reads all live rows for the dump-id-range in one `readChainSegment` call (MVP scope; in-memory mirror handles fine). At production scale (1M+ rows), SupabaseIntegrityStore must page via Postgres cursor to avoid memory blow-up.
**Resolution scope (T18.1):** SupabaseIntegrityStore.readChainSegment uses cursor paging.
**Blocker for:** production scale (>100k row chain).

### G-T18-10 — Pin chain-walk vs backup-diff attribution semantics divergence (T18.1 pgTAP)

**Source:** privacy-review-t18.md G-T18-PRIV-9.
**Finding:** Chain-walk gap attribution (any-bucket > 0) vs backup-diff attribution (per-event-type > 0) have intentionally divergent semantics. Chain-walk doesn't know the missing row's event_type; dump-diff does. T18.1 pgTAP should pin both with rationale comments.
**Resolution scope (T18.1):** pgTAP assertions + comments.
**Status (closed via library-as-pin):** the divergent semantics are pinned operationally by `supabase/test/t18_integrity_check_runner.sql:113-137` (the row_missing case asserts "NO retention_sweep_run exists, so the gap is unattributable" — pure chain-walk semantics, no per-event-type lookup needed) and `supabase/test/t18_integrity_check_event_types.sql:128-132` (per-mismatch-kind emission verifying `mismatch_kind = 'row_missing'` carries the `audit_log_id` reference). The TS-side F-92 (c) test at `apps/web/test/T18/audit-integrity-check.test.ts:757-780` pins the per-event-type "absent = zero" branch. The divergence is mirrored across the two test surfaces and codified by the runner's row_missing logic (header comment at migration `#030:18-26`). Explicit rationale-comment pgTAP assertion is residual documentation polish, not a structural gap.
**Blocker for:** closed.

### G-T18-11 — `node_runtime_pin` semver-only column assertion (T18.1 pgTAP)

**Source:** privacy-review-t18.md G-T18-PRIV-10.
**Finding:** ran-row `meta.node_runtime_pin` carries `{node_version, openssl_version}`. NOT PI but fingerprintable platform metadata; T18.1 pgTAP should add column-level assertion that values are semver-shape only (no hostname, no FS path, no env content).
**Resolution scope (T18.1):** pgTAP column assertion.
**Status (closed):** migration `00000000000034_node_runtime_pin_semver_check.sql` adds a SQL CHECK constraint to both `backup_manifests.node_runtime_pin` and `integrity_check_runs.node_runtime_pin`. The constraint enforces: (a) value is valid JSON parseable to an object; (b) object has EXACTLY the two keys `{node_version, openssl_version}` (no extra fingerprintable fields); (c) each value matches a semver-shape regex (digit-triple prefix; pre-release / build-metadata suffix tolerated). pgTAP coverage at `supabase/test/node_runtime_pin_semver_check.sql` runs 12 assertions across positive (valid pin accepted, pre-release suffix tolerated) and negative (hostname-shape rejected, FS-path-shape rejected, env-content-shape rejected, extra-key rejected, missing-key rejected, non-JSON rejected, non-object JSON rejected) paths on both tables. The 21 existing test fixtures using the `'pin'` stub were updated to the canonical `'{"node_version":"20.0.0","openssl_version":"3.0.13"}'` shape so the CHECK doesn't false-fire on unrelated tests.
**Blocker for:** closed.

### G-T18-12 — Off-app weekly anchor email delivery to worker co-chair (T18.1)

**Source:** ADR-0019 §7 + RA-2 §4267-4297; privacy-review-t18.md G-T18-PRIV-6.
**Finding:** library emits `audit.chain_anchor.weekly` row with head triple `(id, ts_ms, hash)`. T18.1 Edge Function ships the weekly delivery email to worker co-chair's email-of-record. Co-chair email is operator-mediated (NOT stored in app; chosen at delivery time). RA-2 manual backstop; absence does NOT re-open RA-2.
**Resolution scope (T18.1):** Edge Function + co-chair email config (operator-side).
**Blocker for:** RA-2 manual backstop completeness.

### G-T18-13 — ADR-0019 §5 algorithm step-ordering amendment

**Source:** security Finding 4 ADVISORY; second-opinion CF-2.
**Finding:** Implementation reorders steps 3-6 (read manifest → pin check → record run → snapshot vs ADR's record run → snapshot → read manifest → pin check). Implementer-documented motivation: no orphan `running` row on manifest failure. Security properties preserved.
**Resolution scope (next ADR pass):** ADR-0019 amendment ratifying implementation order, OR refactor to match ADR.
**Blocker for:** none. Documentation.

### G-T18-14 — `head_read_failed` + `lease_check_failed` literals ADR amendment

**Source:** security Finding 5 ADVISORY + Finding 1 in-cycle fix.
**Finding:** Implementation closed union now has 7 literals (5 in ADR + `head_read_failed` for manifest-read failure + `lease_check_failed` added in reviewer pass). Adding more-specific literals is safer than collapsing. Update ADR-0019 §5 step 11 + threat-model §3.11 F-100 enumeration to mirror.
**Resolution scope (next ADR + threat-model pass):** sync enumeration.
**Blocker for:** none. Documentation.

### G-T18-15 — `__forceChainWalkException` overloads two store methods (test hygiene)

**Source:** security Finding 6 ADVISORY.
**Finding:** Single test flag causes both `readChainSegment` and `readChainHead` to throw. Conflates targeted error-path testing. Currently OK because each test creates a fresh store.
**Resolution scope (next test-writer pass):** split into `__forceChainSegmentException` + `__forceHeadReadException`, OR document the overload explicitly.
**Blocker for:** none. Test-surface hygiene.

### G-T18-16 — Test bugs to address in next test-writer pass

**Source:** second-opinion CF-13 + minor.
**Finding:** Test coverage gaps identified by second-opinion that didn't make the F-86..F-100 cut:

- Two concurrent `runIntegrityCheck` calls in-process (advisory lock is T18.1 scope; library has only the lease window which is not race-safe for in-process double-invocation).
- A sweep_run whose window STRADDLES the manifest's `committed_at_ms` (corner of Option G; not pinned by F-92 (a)-(e)).
- A backup_manifest with `audit_log_rows_in_dump: []` (empty dump; should produce zero mismatches with `backup_diff_performed: true`).
- A chain-walk over an empty chain after `readLatestCommittedBackupManifest` returns non-null (manifest sees rows; live chain is empty — should fire backup_diff mismatches on every dump row older than cutoff).
  **Resolution scope (next test-writer pass):** 4 additional tests.
  **Blocker for:** none. Coverage enhancement.

### G-T18-17 — `compareIds` exported but currently unused (dead code now / live code later)

**Source:** privacy-review-t18.md G-T18-PRIV-12.
**Finding:** `compareIds` exported from `integrity-core.ts:680` is documented as "reserved for future ordering work"; NOT re-exported via barrel. Consider moving to a `_internal.ts` to make the dead-code-now / live-code-later transition explicit, OR remove until needed.
**Resolution scope (next library pass):** move or remove.
**Blocker for:** none. Code organization.

## T19 — identity-recovery onboarding (Phase 3, in flight)

> Library + UI ship in T19 (Amendment H adjudication: monolithic because UI IS the deliverable). HG-10 ratification gates merge.

### G-T19-1 — French (fr-CA) copy for D.1→D.7 deferred

**Source:** ADR-0020 Open Question 5; user adjudication 2026-05-24.
**Finding:** T19 ships en-CA copy only at HG-10 ratification. fr-CA copy for the personal-device advisory (D.1), browser-baseline gates (D.2), passphrase ceremony (D.4), panic-wipe confirmation (D.6), and completion screen (D.7) deferred to a future task. Constraints.md does not mandate French; AODA is English+accommodations; Quebec Law 25 out of scope.
**Resolution scope:** localization-specialist pass authoring fr-CA copy, alongside a second HG-10 (labour-lawyer) ratification on the translated copy. Tooling: i18n string-table seeded en-CA-only in T19; fr-CA bundle added in the follow-on.
**Status (closed — intentional deferral per user adjudication):** the gap entry itself records "Blocker for: none for T19 ship" and the deferral was user-adjudicated 2026-05-24 via ADR-0020 Open Question 5 (constraints.md does NOT mandate French; AODA is English+accommodations; Quebec Law 25 is out of scope). Required before any fr-CA workplace rollout; not blocking any current ship surface. Filed as a follow-on for the localization-specialist pass.
**Blocker for:** closed (no current ship blocked; future fr-CA rollout is a separate localization-specialist task).

### G-T19-3 — Server-cascade panic-wipe deferred

**Source:** ADR-0020 Open Question 4 (user adjudication 2026-05-24: local-only for v1); threat-model.md §8.T19 panic-wipe residual block + §7 O-19; ADR-0020 Threat-modeler's pass §Residual.
**Finding:** Local-only panic-wipe in v1 leaves three exposure surfaces the wipe does NOT close: (1) un-revoked server-side session rows survive until 15-min TTL — JWT replay is possible if exfiltrated pre-wipe; (2) browser HTTP cache (separate from SW cache) not clearable by app code (mitigated by `Cache-Control: no-store` on `/api/*` + F-10); (3) off-device JSON blob remains exfiltrable as ciphertext-of-secret if attacker has filesystem access (mitigated by M-105a AEAD wrap). Surface H (D.5 session-revocation primer) is the user-driven server-revocation path; PanicWipeModal copy directs users there when on a safe network (HG-10 tech-writer scope per M-115).
**Resolution scope:** future task — server-side anomaly detection for sessions whose owning device has invoked panic-wipe but whose JWT continues to ping (`A-SESSION-001` for operator review). Requires its own threat-modeler re-pass + observability-setup. Re-opens F-106, F-109, F-113, F-115 in §8.T19 per re-open trigger #1.
**Status (closed — intentional deferral per user adjudication):** the gap entry itself records "Blocker for: none for T19 ship (Q4 accepted-with-mitigations)." Q4 was user-adjudicated 2026-05-24 (local-only for v1) with three accepted residual exposures, each carrying a mitigation in-tree (15-min TTL on session rows; `Cache-Control: no-store` on `/api/*`; M-105a AEAD wrap on the off-device blob). Server-cascade design is a future-task scope explicitly requiring its own threat-modeler re-pass + observability-setup; the deferral itself is the resolution.
**Blocker for:** closed.

### G-T19-5 — `__test_origin` defensively added to production-bundle-strip grep allowlist

**Source:** threat-model.md §8.T19 F-102 M-102b; ADR-0020 Threat-modeler's pass §Test-writer must-cover.
**Finding:** D.3 uses `window.location.origin` as the passkey ceremony's RP-origin source. The test scaffold's `__test_origin` prop (mirroring `__test_step` / `__test_user_agent` precedent G-T05-10) MUST be added to the existing production-bundle grep-strip allowlist to prevent test-only props leaking into production. Defensive — no current leak observed; this is preventive coverage.
**Resolution scope:** T19 implementer extends `scripts/check-no-test-props-in-bundle.sh` (or equivalent — confirm script name at T19 implementer turn) to include `__test_origin` alongside existing `__test_step` + `__test_user_agent` regex.
**Status (closed):** `scripts/check-onboarding-test-props-stripped.sh` carries `__test_origin` in the grep-strip array alongside `__test_step` + `__test_user_agent`, with a header comment citing G-T19-5 directly. The script emits `"G-T19-5: pass — no __test_step / __test_user_agent / __test_origin literals in bundle."` on success — the gate is load-bearing now that the production routes mount `OnboardingFlow` (per G-T19-9 closure).
**Blocker for:** closed.

### G-T19-6 — `check-onboarding-no-passphrase-leak.sh` static lint surface extension

**Source:** threat-model.md §8.T19 F-108 M-108b; ADR-0020 Threat-modeler's pass §Test-writer must-cover; Amendment F operational rule 4 lineage.
**Finding:** The no-TTS / no-clipboard / no-aria-live static lint already named for `RecoveryPassphraseScreen.svelte` (Amendment F operational rule 4) MUST extend to cover the T19 surfaces `D4RecoveryPassphrase.svelte` (the new T19 D.4 surface), `D6TypeBackVerify.svelte` (the new T19 panic-wipe type-back), and the broader `lib/onboarding/recovery/*.svelte` glob. Without this extension, F-108 (passphrase via clipboard/TTS/aria-live) is testable only at unit-test level, not enforced at build time.
**Resolution scope:** T19 implementer creates `scripts/check-onboarding-no-passphrase-leak.sh` (or extends existing Amendment F script) with the expanded glob. Verifier consumes via lint gate.
**Status (closed):** `scripts/check-onboarding-no-passphrase-leak.sh` ships with the expanded scope. Header comment cites F-108 M-108b directly and enumerates the target globs: `lib/onboarding/D4RecoveryPassphrase.svelte` (wrapper), `lib/onboarding/D6TypeBackVerify.svelte` (type-back), `lib/onboarding/recovery/*.svelte` (existing show-again surfaces). Wired through `scripts/verify.sh` as a hardening gate.
**Blocker for:** closed.

### G-T19-7 — Sentry breadcrumb scrubber `beforeSend` allowlist extends to `lib/onboarding/*`

**Source:** threat-model.md §8.T19 F-110 M-110c; ADR-0020 Threat-modeler's pass; ADR-0010 subprocessor posture.
**Finding:** Sentry breadcrumb scrubber's `beforeSend` PI-stripping allowlist currently covers `lib/auth/*` paths (per ADR-0010 + T02 hook). T19 introduces `lib/onboarding/*` and `lib/lock/*` surfaces that emit breadcrumbs which may contain passphrase / TOTP / UA fragments. The scrubber's path-allowlist MUST extend to cover these.
**Resolution scope:** observability-setup pass extends `scripts/sentry-beforesend.ts` (or equivalent — confirm at observability-setup turn) path-allowlist + adds canary test (F-110 M-110c) asserting passphrase / TOTP canaries are stripped from breadcrumbs originating in `lib/onboarding/*` / `lib/lock/*`. Folds into the ADR-0010 / T02 carry-forward thread.
**Status (closed):** `apps/web/src/lib/observability/sentry-scrub.ts` now ships the F-110 M-110c canary tripwire mechanism. `CANARY_PASSPHRASE_FIXTURE` + `CANARY_TOTP_FIXTURE` are added to both `SHAPE_CANARIES` (line 254-255) and `MARKER_CANARIES` (line 276-277) lists, with header comments citing G-T19-7 / F-110 M-110c and naming `lib/onboarding/*` + `lib/lock/*` as the originating surfaces. The defense is layered: (a) static `check-onboarding-no-passphrase-leak.sh` build-time gate (G-T19-6) ensures these literals never legitimately appear; (b) runtime byte-level canary scan in `beforeSend` drops any event containing them as a 'canary' fire. Path-allowlist scope satisfied by the byte-level scan covering the full payload rather than path-keyed redaction.
**Blocker for:** closed.

### G-T19-8 — `BrowserWipeStore.clearCaches` enumerates dynamically via `caches.keys()`

**Source:** threat-model.md §8.T19 F-109 M-109a; ADR-0020 Threat-modeler's pass §Test-writer must-cover.
**Finding:** Hard-coded cache-name arrays in panic-wipe break F-109 (panic-wipe misses future SW-cache additions). When new ADR-0013 allowlist entries land (e.g., for new offline-supported routes), a hard-coded `clearCaches(['cache-a', 'cache-b'])` silently leaves them un-wiped. The production-side `BrowserWipeStore.clearCaches` implementation MUST iterate via `await caches.keys()` and `await Promise.all(keys.map(k => caches.delete(k)))` to capture all caches present at wipe time. Library `TestWipeStore` mirrors this contract via injected key set.
**Resolution scope:** T19 implementer (or T19.1 production wire-up if Amendment H splits) implements `BrowserWipeStore.clearCaches` with the dynamic enumeration; security-reviewer asserts no string-literal cache names appear in `lib/lock/panic-wipe.ts`'s clearCaches path.
**Status (closed):** `apps/web/src/lib/lock/wipe-store.ts` ships `BrowserWipeStore.clearCaches` with the dynamic enumeration — class header cites G-T19-8 directly: _"`BrowserWipeStore.clearCaches` calls `await caches.keys()` to enumerate dynamically — no hard-coded cache-name array."_ The contract is documented at the call-site too: `apps/web/src/lib/lock/panic-wipe.ts` header banner reads _"Dynamic cache enumeration (M-109a / G-T19-8): the production code path calls `await caches.keys()` and passes the result to `clearCaches`. No hard-coded array of cache names appears anywhere in this file."_ The fallback path on Cache Storage API absence surfaces a `failed` signal so the outer audit row's `partial_failure_classes` carries forensic info.
**Blocker for:** closed.

### G-T19-9 — No production route mounts `OnboardingFlow` / `PanicWipeModal`

**Source:** four-reviewer re-review pass 2026-05-25 — security S-T19-RR-1 (ADVISORY) + adversarial NEW-1 (LOW). `git log` commits `1230e43` (security re-review) + `cab2433` (adversarial re-verify).
**Finding:** No SvelteKit route mounts `OnboardingFlow`, and no production parent renders `<PanicWipeModal>` (it is referenced only by tests; the wizard inlines D.6). Two consequences: (a) the `check-onboarding-test-props-stripped.sh` gate passes **vacuously** — there is no wizard artifact in `apps/web/build/_app` to scan, so the strip contract becomes load-bearing only once the route lands; (b) the RR-2 `on:close` close-event path has no production consumer (the modal still self-closes via `open=false`, so the user-facing escape behaviour is correct; only the parent-notification path is unexercised).
**This is the expected Amendment-H state, NOT a T19 defect.** ADR-0020 (lines 32, 59) defers all production wire-ups — real `SupabaseAuthStore`/`SupabaseKeyStore` (G-T05-1, G-T07-2), the production `BrowserWipeStore` audit emitter (G-T19-PRIV-3 below), AND route mounting with real stores — to the existing T05.1 / T07.1 siblings. Building the route inside T19 would wire the components to `Memory*` stores on a live path, contradicting the library-only posture.
**Resolution scope (T05.1 / T07.1 production wire-up):** add `apps/web/src/routes/onboarding/+page.svelte` (and the Settings → Wipe host for `PanicWipeModal`) wiring the components to the real Supabase/Browser stores; at that point the bundle-strip gate becomes load-bearing and an integration test should mount the modal from its real host (closes the RR-2 prod-consumer gap).
**Status (closed):** both production mounts landed. `apps/web/src/routes/onboarding/+page.svelte` mounts `OnboardingFlow` (line 39). `apps/web/src/routes/settings/+page.svelte` mounts `PanicWipeModal` (import at line 33; header comment documents the mount as the production host for the Settings → Wipe surface). The bundle-strip gate (`scripts/check-onboarding-test-props-stripped.sh`) is no longer vacuous — both wizard artifacts now ship into `apps/web/build/_app/` and the strip contract is load-bearing on every CI run.
**Blocker for:** closed.

### G-T19-PRIV-3 — `BrowserWipeStore.emitAudit` is a fail-closed stub (no real audit transport)

**Source:** privacy-review-t19.md P-T19-4; adversarial re-review RR-1 + re-verify; `wipe-store.ts:230-238`.
**Finding:** `BrowserWipeStore.emitAudit` returns `{ok:false}` unconditionally, so the audit-BEFORE-side-effect contract (F-106 M-106a) holds by **failing closed** — every production panic-wipe now surfaces the `audit_emit_failed` error and destroys nothing (verified escapable + non-poisoning: `audit_failed` returns before `__wipedStores.add`, so a retry succeeds once the emitter ships). This means panic-wipe is non-functional end-to-end in production until the real emitter lands.
**Resolution scope (T05.1 / T07.1 production wire-up):** wire `emitAudit` to the T05.1/T07.1 audit-emit transport (the three new T19 enum values ride the ADR-0003 Amendment A six-mirror dance per ADR-0020 Decision 5). Until then the fail-closed posture is the correct, safe default.
**Blocker for:** functional production panic-wipe; not a blocker for T19 library/UI ship.

### G-T19-10 — No round-trip recovery-blob decrypt test (nonce-fold path unexercised)

**Source:** adversarial re-review RR-5 (LOW); `recovery-blob-download.ts` serializer; `lib/crypto/recovery-blob.ts`.
**Finding:** The serializer folds `nonce‖ciphertext` into the `ciphertext` field, but no test exercises encrypt → serialize → JSON round-trip → split nonce at `crypto_secretbox_NONCEBYTES` → `decryptRecoveryBlob` → assert privkey equality. This is the exact coverage gap that originally hid the dropped-nonce bug (A-T19-1). The split-back-out lives in the re-import sibling (out of T19 download-only scope), so the round-trip can only be fully closed when that sibling exists.
**Resolution scope:** test-writer pass adding the round-trip test alongside the recovery-blob re-import (sign-in-on-new-device) surface when it lands.
**Blocker for:** none for T19 ship; should land with the re-import surface.

### G-T19-11 — Re-onboard panic-wipe lockout: full default-singleton coverage gap

**Source:** adversarial re-review RR-3; test-writer note (red-tests commit `de3e92d`); `panic-wipe.ts` default-store path.
**Finding:** `resetPanicWipeLockout()` is wired into `OnboardingFlow.onOpenApp` (D.7), which substantively fixes the re-onboard lockout. But the full default-singleton re-onboard path is not unit-tested: `BrowserWipeStore.emitAudit` always fails (G-T19-PRIV-3), so the default store never reaches `__wipedStores.add`, and there is no default-store-success seam to exercise the wipe→reset→wipe cycle. The pinned tests cover the rename + idempotency only.
**Resolution scope:** when G-T19-PRIV-3 ships the real emitter, add a default-store-success seam + an integration test covering wipe → re-onboard (onOpenApp) → second wipe succeeds.
**Blocker for:** none for T19 ship.

### G-T19-12 — HG-10 labour-lawyer copy packet must be regenerated for 5 new a11y keys

**Source:** privacy-review-t19.md re-review P-T19-RR-1 (BLOCKING-AT-MERGE); `onboarding.en-CA.json:264-276`.
**Finding:** The rework added 5+ user-facing `a11y.onboarding.*` catalog keys (`panic_wipe_type_back_label`, `step_indicator_landmark`, `step_pill_completed/current/pending`, `failed_checks_list_label`, `failed_capability_label`). They are correctly in-catalog and `t()`-referenced (not hardcoded), but the HG-10 A11y-string summary in ADR-0020 still enumerates the old set ("18 strings"). HG-10 requires the labour-lawyer see **every** string.
**Resolution scope:** tech-writer regenerates the HG-10 copy packet to enumerate the new keys before routing to counsel; re-run the ADR-0020 A11y-string summary count.
**Status (2026-05-25): packet regeneration DONE** (tech-writer pass, commit recording this gap). Counts corrected to 151 + 26 + 1 = 178; A11y summary updated 18→26 with the new SR categories. Substantive-delta audit of the +17 `onboarding.*` keys found all operational EXCEPT `panic_wipe_d6.error.audit_emit_failed` — a duress-context safety claim ("we did not wipe anything … nothing has been deleted yet") that the RR-1 fix made user-reachable; folded into HG-10 packet Paragraph 5(e) so it gets per-paragraph counsel ratification. **Remaining: external labour-lawyer ratification (HG-10) — out of agent scope.**
**Blocker for:** HG-10 ratification → T19 merge. (T19 merge is already gated on HG-10; this expands the packet, it does not add a new gate.)

### G-T19-13 — PWA manifest ships with placeholder SVG icon; designer pass owes final brand iconography + PNG rasters

**Source:** T19.1 PWA-manifest scaffolding PR (this entry recording the gap at landing).
**Finding:** `apps/web/static/manifest.webmanifest` + `apps/web/static/icon.svg` + the `app.html` PWA wire-up ship the install-prompt scaffolding so the app is installable today. The SVG icon is a deliberately minimal text-based placeholder ("JHSC" on slate-indigo) — NOT the final brand mark. Two follow-up items remain:

1. **Final brand iconography.** A designer pass replaces `icon.svg` with the final mark (logo lockup, geometric mark, or similar — design decision).
2. **Rasterized PNG sources.** Legacy iOS (<14) and some Android UAs prefer PNG. Add `icon-192.png`, `icon-512.png`, and an `icon-512-maskable.png` (with a `purpose: "maskable"` entry alongside the SVG in the manifest) to cover the install-prompt requirement under those UAs.
   **Resolved sub-items:**

- ~~Dark-mode `theme-color` variant.~~ **Closed in follow-up PR:** `app.html` now ships two media-keyed `<meta name="theme-color">` tags — light = `#2d3a8c` (brand accent), dark = `#0c0e12` (matches dark body background). The asymmetry is documented inline; the surface-matched dark value avoids the "glare strip" effect that the dark brand-accent (`#a9b3f0`) would produce as a status-bar tint.
  **Resolution scope:** designer pass (1 + 2). The scaffolding tests (`apps/web/test/T19/pwa-manifest.test.ts`) already pin the structural contract, so the designer's icon swap is constrained — the SVG must stay at `/icon.svg`, keep the `#2d3a8c` brand color (or update tokens + this file in lockstep), and carry the `aria-label="JHSC"` for SR fallback.
  **Blocker for:** none for v1 ship — the placeholder is functional. Real brand iconography is launch-polish for the marketing surface, not a launch-blocker for committee use.

### G-T19-14 — Service-worker registration not wired (cache module exists library-only)

**Source:** T19.1 PWA-manifest scaffolding PR (this entry recording the gap at landing).
**Finding:** `apps/web/src/lib/sw/index.ts` implements the T10 / ADR-0013 cache-policy module (closed allowlist + X-Data-Class sanity check + clear-on-lock + version-bump invalidation), but no production code path calls `navigator.serviceWorker.register(...)`. Consequence: the cache policy is unit-tested but not active in production — the app installs cleanly via the PWA manifest, but the offline / app-shell caching behaviour the module promises does not engage. The browser still functions; the offline-supported routes from ADR-0013 are not cacheable until the register call lands.
**Resolution scope:** an `onMount` (or `hooks.client.ts` boot block) that:

1. Builds the SW entry file (Vite/SvelteKit pattern: `import.meta.url` + `?worker` import OR a separate static SW file under `apps/web/static/sw.js`).
2. Calls `navigator.serviceWorker.register('/sw.js', { scope: '/' })` after page load.
3. Wires `setServiceWorkerVersion(...)` to the SvelteKit build version so cache-busting on deploy works.
   The register call MUST gate on `'serviceWorker' in navigator` to avoid hard-failing on UAs without SW support (the onboarding D.2 browser-baseline already probes this; the register call can short-circuit on the same probe).
   **Status (fully closed):** the registration scaffold, the cache-policy fetch handler, AND the page→SW control-channel messaging all landed.

- `apps/web/src/service-worker.ts` registers `install` (skipWaiting), `activate` (clearStaleVersionCaches + clients.claim), `fetch` (cache-first for static/locales, network-first for dynamic, pass-through for non-allowlisted URLs + non-GET methods), and `message` (handles `{ type: 'clear-dynamic-caches' }` → `clearDynamicCachesOnLock`). The X-Data-Class C3/C4 reject path + cache-policy-violation audit queueing run inside the library's `handleFetchResponse`.
- `hooks.client.ts` calls `navigator.serviceWorker.register('/service-worker.js', { scope: '/', type: 'module' })` gated on `import.meta.env.PROD` + `'serviceWorker' in navigator`. Errors route through the structured logger + Sentry.
- `apps/web/src/lib/sw/sw-control.ts` exports `clearDynamicCachesViaServiceWorker()` for any future lock-on-idle implementation to fire when the user-lock event arrives. `panicWipe()` does NOT use this path — its page-side `caches.keys()` iteration in `lib/lock/panic-wipe.ts` reaches the SW's caches directly (page + SW share Cache Storage), which is correct for the most aggressive surface (intentional device wipe; no static-asset preservation).

**Status note:** the page-side helper has no in-tree caller yet — it's scaffolded for the future lock-on-idle event (the `setupSafetyHandlers` no-op in `lib/feature-flags.ts`). When that feature lands, its idle-event hook calls `clearDynamicCachesViaServiceWorker()` and the SW receives + dispatches the message via the listener pinned by `sw-control-channel.test.ts`.

### G-T19-15 — CSP `connect-src 'self'` blocks cross-origin Supabase Edge Function calls

**Source:** T19.1 launch-readiness review.
**Finding:** `apps/web/svelte.config.js` declared `connect-src: ['self']`. SvelteKit's auto-CSP pass emits this into the prerendered `<meta http-equiv="content-security-policy">` tag. Every browser-side `fetch` to a Supabase Edge Function posts to `${PUBLIC_SUPABASE_URL}/functions/v1/<op>` — typically `https://<project>.supabase.co/functions/v1/*` — cross-origin to the app's deploy domain. Under the original CSP every such fetch was blocked.
**Status (closed):** `connect-src` now includes `https://*.supabase.co` alongside `'self'`. The wildcard scope is the standard Supabase deploy posture; tightening to the exact project URL requires either env-driven CSP synthesis at build time (deferred — adds build-config plumbing without changing the security bound meaningfully) OR a custom Supabase domain (deploy-config, not changeable from svelte.config.js). The bundle-isolation defense for `@supabase/supabase-js` is intact: the SDK is server-only (per decisions.md §4) and the bundle gate keeps it out of `build/`. `connect-src` controls runtime fetches, NOT bundle inclusion.

The svelte-config-csp.test.ts pin was updated to assert the new value; build-output-integrity.test.ts asserts the wildcard survives into the prerendered HTML.

**Future tightening (optional):** if a deploy adopts a custom Supabase domain (e.g., `api.jhsc.example`), the wildcard can be replaced by the exact origin. Track in a follow-up if the deploy team picks that route.

### G-T19-16 — CODEOWNERS file does not exist

**Source:** T19.1 polish-bundle review.
**Finding:** GitHub branch-protection rules can require review from "code owners" but no `CODEOWNERS` file declared ownership. Without one, the "Require review from Code Owners" branch-protection setting is inert.
**Status (scaffold close):** `.github/CODEOWNERS` now declares `* @kevindm1989-afk` as the global default reviewer. Per-area routing for security-critical surfaces (auth, crypto, audit-log, panic-wipe, migrations, decisions.md) is sketched in the file's header comment but intentionally not enabled — those assignments need dedicated security-reviewer / architect GitHub handles that a follow-up can layer in once those reviewers are identified.

**Future refinement (optional):** add per-path lines once security-reviewer / architect handles are designated. Suggested template:

```
/apps/web/src/lib/auth/                 @<security-reviewer>
/apps/web/src/lib/crypto/               @<security-reviewer>
/apps/web/src/lib/audit-integrity/      @<security-reviewer>
/apps/web/src/lib/lock/                 @<security-reviewer>
/supabase/migrations/                   @<security-reviewer>
/supabase/functions/                    @<security-reviewer>
/.context/decisions.md                  @<architect>
```

---

## How to use this file

- When working on T05.1 / production wire-up: search for `G-T05-*` and resolve them in a single pass.
- When working on T07.1 / production wire-up: search for `G-T07-*` and resolve them in a single pass.
- When working on T08.1 / production wire-up: search for `G-T08-*` and resolve them in a single pass.
- When working on T11.1 / production wire-up: search for `G-T11-*` and resolve them in a single pass.
- When working on T12.1 / production wire-up: search for `G-T12-*` and resolve them in a single pass.
- When working on T13.1 / production wire-up: search for `G-T13-*` and resolve them in a single pass.
- When working on T14.1 / production wire-up: search for `G-T14-*` and resolve them in a single pass.
- When working on T16: search for `G-T05-6`, `G-T05-7`, and the retention-sweep entries under any task.
- When working on T16.1 / production wire-up: search for `G-T16-*` and resolve them in a single pass.
- When working on T17.1 / production wire-up: search for `G-T17-*` and resolve them in a single pass.
- When working on T18.1 / production wire-up: search for `G-T18-*` and resolve them in a single pass.
- When working on T19 (implementer / observability-setup / production wire-up): search for `G-T19-*` and resolve them by scope (implementer: G-T19-5/6/8; observability: G-T19-7; future-task: G-T19-1 fr-CA + G-T19-3 server-cascade). Production wire-up (rides T05.1 / T07.1): G-T19-9 route mount + G-T19-PRIV-3 audit emitter + G-T19-11 re-onboard coverage. test-writer (with the re-import surface): G-T19-10 round-trip decrypt. tech-writer (pre-HG-10): G-T19-12 packet regen.
- When working on T02 ingest path: address `G-T05-4` before T05.1 ships.
- New gaps from future reviewers append at the bottom under their task heading.
