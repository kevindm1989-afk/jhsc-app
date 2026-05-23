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

## How to use this file

- When working on T05.1 / production wire-up: search for `G-T05-*` and resolve them in a single pass.
- When working on T16: search for `G-T05-6` and `G-T05-7`.
- When working on T02 ingest path: address `G-T05-4` before T05.1 ships.
- New gaps from future reviewers append at the bottom under their task heading.
