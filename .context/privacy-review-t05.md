# Privacy Review T05 — Auth Core + Auth Migration

Status: **FAIL** — APPROVED-WITH-CHANGES on Q1; APPROVED-WITH-CHANGES on Q2; APPROVED-WITH-CHANGES on Q3 (two blocking findings); APPROVED on Q4; APPROVED-WITH-CHANGES on Q5.

> Note on file authorship. Captured inline from the privacy-reviewer agent per the precedent in `.context/privacy-review.md:5`. Nothing depends on the agent itself writing this file.

HUMAN GATES TRIGGERED:
- **HG-9 (Retention schedule final approval)** — `auth_totp_consumed_log` 24-hour retention rule must be ratified by the user before T16 ships. Per `.context/decisions.md` ADR-0015, every audit-shaped persistent table needs to land on the per-event-type schedule (or, where the table is operational rather than audit, on plan §8 retention table).
- **No cross-border-transfer gate** in this diff — Supabase region pin is asserted in the test harness (`supabase-test.ts:103-112`). No new subprocessor introduced.

---

## 1. Scope

**Covered.** T05 introduces the first real PII-touching code in the app — passkey + TOTP auth core and the auth schema migration. The five Qs from the implementer:
- Q1: `auth_totp_consumed_log` PIPEDA defensibility, retention, PI inventory amendment
- Q2: `auth.passkey.assert` structured-log-only carve-out PIPEDA defensibility
- Q3: General PI handling sanity check (raw user_id/email/IP flow)
- Q4: Browser-baseline UA handling
- Q5: Test harness fixture posture + `cred_id_pseudonym` derivation

**PI touchpoints in diff.**
- `supabase/migrations/00000000000001_auth.sql:111-118` — `public.users` (NEW PI custodian)
- `supabase/migrations/00000000000001_auth.sql:131-145` — `auth_totp_bootstraps` (stores both `secret_hash bytea` AND plaintext `totp_code text`)
- `supabase/migrations/00000000000001_auth.sql:166-179` — `auth_totp_consumed_log` (NEW; not in prior PI inventory)
- `supabase/migrations/00000000000001_auth.sql:185-209` — `webauthn_credentials`
- `supabase/migrations/00000000000001_auth.sql:219-237` — `auth_sessions`
- `supabase/migrations/00000000000001_auth.sql:294-295, 317, 357, 437` — plain `digest(..., 'sha256')` used as pseudonym derivation (NOT HMAC)
- `apps/web/src/lib/auth/auth-core.ts:167-174, 228-235, 408-415` — `auth.passkey.assert` structured-log INFO emissions
- `apps/web/src/lib/auth/memory-store.ts:47, 176` — `consumedTotpCodes` Map stores raw plaintext TOTP code (test harness only)

---

## 2. Q1 — `auth_totp_consumed_log` table

### 2.1 PIPEDA Principle 4.4 defensibility

**Defensible in principle; FAIL as implemented.**

The HMAC-of-code-only posture is the right architectural shape under Principle 4.4 — the purpose (single-use detection for ~15min bootstrap lifetime) is real, and recording the consumed-code without an identifier sufficient to reach back to the bootstrap row is minimization. **However, two specifics make the as-shipped table not minimized:**

**Finding 1 (BLOCK — PIPEDA Principle 2 / Accountability + Principle 4 / Limiting Collection):**
- **Regime:** PIPEDA Principle 4.2 (Identifying Purposes — 4.2.1, 4.2.3) + Principle 4.4 (Limiting Collection).
- **Location:** `supabase/migrations/00000000000001_auth.sql:166-179` (the table) and `.context/decisions.md` §PI inventory lines 2947–2986 (the table is NOT listed).
- **Issue:** `auth_totp_consumed_log` is a new persistent PII-adjacent table whose purpose, retention rule, and classification are not documented in any ADR or in §PI inventory. The implementer's claim "T16 will own the retention rule" is the pattern called out in `.context/constraints.md` "Hard Rules" #6 ("require a documented purpose in `.context/decisions.md` before implementation").
- **Fix:**
  1. Add a row to `.context/decisions.md` §PI inventory — fields `user_id` (C1), `totp_code_hash` (C1 — derived from a single-use short-lived secret), `consumed_at` (C1 — timestamp).
  2. Add a row to ADR-0015 or new ADR-0016 covering "Auth-supporting operational tables retention." Recommended retention: **24 hours after consumption**.
  3. ADR-0002 should be amended (Amendment G) to enumerate the F-38 reuse-detection table.

**Finding 2 (BLOCK — PIPEDA Principle 4.7 Safeguards):**
- **Regime:** PIPEDA Principle 4.7. The implementer's verdict claim is "HMAC(code) only." That claim is FALSE in the SQL.
- **Location:** `supabase/migrations/00000000000001_auth.sql:294-295, 317, 357, 437` — every "hash" derivation uses `digest(p_totp_code, 'sha256')` which is **plain unkeyed SHA-256**. The structured logger and audit-log spec both call for **HMAC** with `HMAC_PSEUDONYM_KEY` (cf. `observability/audit-log.md:131-138` "HMAC-BLAKE2b-256(uid)[:16hex]" and `observability/logging.md:48`).
- **Issue:** A 6-digit TOTP code has only ~10^6 possible values. Plain SHA-256 of "123456" is the same on every install everywhere. The "consumed-log" is effectively a precomputed-rainbow-table-friendly fingerprint, recoverable in microseconds. The pseudonymization claim made by the implementer ("HMAC(code) only, no PI") is not supported by the code.
- **Fix:**
  1. Replace `digest(X, 'sha256')` with `hmac(X, current_setting('app.hmac_pseudonym_key'), 'sha256')` (or whichever Postgres extension lands the keyed HMAC).
  2. Add a migration step that sets `app.hmac_pseudonym_key` from a Supabase secret.
  3. Semgrep rule on `supabase/migrations/`: ban bare `digest(..., 'sha256')`.

### 2.2 PIPEDA Principle 4.5 retention

24 hours after `consumed_at` is **defensible** and aligns with the bootstrap's own 15-min lifetime. The architect should land this in either ADR-0015 (as a carve-out for non-audit-log tables) or in plan §8 retention table.

### Verdict on Q1
**APPROVED-WITH-CHANGES** (Findings 1 + 2 block).

---

## 3. Q2 — `auth.passkey.assert` structured-log-only

### 3.1 PIPEDA Principle 4.9 (Individual Access)

**Defensible.** The user-facing question "when did I sign in last?" is answerable from `auth_sessions.created_at` / `last_seen_at`, not from `audit_log`. PIPEDA s.8 access request returns the user's session history from `auth_sessions`. The architect's reasoning at `.context/decisions.md:1908` ("forensic record, not an activity stream") is consistent.

### 3.2 PIPEDA Principle 4.7 — equivalent scrubbing

**Confirmed equivalent.** The structured logger (`apps/web/src/lib/log/index.ts:78-115`) runs the same PI denylist (`PI_DENYLIST` at `apps/web/src/lib/log/safe-fields.ts:107-174`) before emit.

### 3.3 Retention coherence

`auth.passkey.assert` is structured-log only → falls into the **7-day Supabase log retention** by default. No coherence issue with the 24h consumed-log — they live in different surfaces.

**Finding 3 (FLAG, non-blocking):**
- `auth-core.ts:167-174` and `:228-235` emit on **failure paths** BEFORE the rate-limit gate. Architect should pick: per-attempt vs per-successful-assertion canonical wording in Amendment A.

**Finding 4 (CONFIRM with NOTE):**
- Three INFO emissions OMIT `actor_pseudonym`. Per `observability/logging.md:48` the server-side line SHOULD carry it. Browser-side is per-spec (forbidden in browser). Mark as a T05-prod-deployment obligation in the test plan.

### Verdict on Q2
**APPROVED-WITH-CHANGES.**

---

## 4. Q3 — General PI handling sanity check

### 4.1 Raw-user_id / email / IP flow

- `auth-core.ts:138` — `actor_pseudonym: actorKey` (pseudonym, not raw). ✔
- `auth-core.ts:160` — `store.pseudonymOf(user_id)` at SDK boundary. ✔ (with Finding 2 caveat)
- JWT `session_id` parsing — never logged. ✔
- `revokeSession` returns 404 (vs 401) — non-blocking; session_id is not user-enumerating.
- `users` table — NO email, NO phone, NO display_name, NO off_employer_contact in this migration. ✔
- No IP reads, logs, or stores. ✔

### 4.2 `webauthn_credentials.device_label`

**Confirmed user-provided, not UA-derived.** ✔

### 4.3 `users` minimization

**Finding 5 (BLOCK — PIPEDA Principle 4.4):**
- **Location:** `supabase/migrations/00000000000001_auth.sql:111-118`.
- **Issue:** The PI inventory enumerates `users` as `{id, display_name, off_employer_contact, identity_pubkey, identity_privkey_recovery_blob}`. The migration creates `{id, active, role, totp_destroyed_at, created_at, updated_at}`. (a) `active` and `role` are in `committee_membership` in the PI inventory, not `users`. (b) `totp_destroyed_at` is a new field not in the PI inventory. (c) Other inventory fields are deferred to T06/T07 without explicit documentation.
- **Fix:** ADR-0002 Amendment (or inline note) clarifying which task owns which `users` field. Update §PI inventory rows for `users.*` to reflect T05's actual schema and add `users.totp_destroyed_at`.

### 4.4 Plaintext TOTP code duplication

**Finding 6 (BLOCK — PIPEDA Principle 4.7):**
- **Location:** `supabase/migrations/00000000000001_auth.sql:131-145`. Both `secret_hash bytea NOT NULL` AND `totp_code text NOT NULL`. The `UNIQUE (user_id, totp_code)` constraint cements the plaintext column.
- **Issue:** Over-collection (Principle 4.4) and safeguard gap (Principle 4.7). A Postgres backup at T+5min from issue captures the code.
- **Fix:** Drop the `totp_code` column. The comparison in `enroll_first_passkey` at line 284 becomes `v_bootstrap.secret_hash <> hmac(p_totp_code, ...)`. The UNIQUE constraint becomes `(user_id)` only.

### Verdict on Q3
**APPROVED-WITH-CHANGES** — Findings 5 + 6 block.

---

## 5. Q4 — Browser-baseline gate

### 5.1 No UA leak

`apps/web/src/lib/auth/browser-baseline.ts:40-53` — UA consumed-and-discarded within function stack frame. No log call, no fetch, no storage write, no Sentry call, no audit emission. Returns generic i18n reason_key. ✔

### Verdict on Q4
**APPROVED.**

---

## 6. Q5 — Test harness

### 6.1 Synthetic fixtures

All `apps/web/test/_helpers/fixtures.ts` content uses `CANARY_*` prefixes, `.test`/`.invalid` TLDs, synthetic UUIDs. No real-PI shapes. ✔

### 6.2 `cred_id_pseudonym` derivation

**Finding 7 (FLAG, non-blocking):**
- Test harness uses HMAC-SHA-256; production spec is HMAC-BLAKE2b-256. Acceptable for in-memory tests; align after Finding 2 fix.

### 6.3 "Co-chair issues invite" flows

**Finding 8 (FLAG, non-blocking — for T06):**
- Test harness shortcuts the consent surface. T06 test-writer should exercise the actual consent ceremony.

### Verdict on Q5
**APPROVED-WITH-CHANGES.**

---

## 7. Inventory amendments (architect folds into `.context/decisions.md` §PI inventory)

| New row | Class | Retention | Notes |
|---|---|---|---|
| `auth_totp_bootstraps.user_id` | C1 | 15-min ceiling, hard-deleted on consume (F-43) | FK to `users.id` |
| `auth_totp_bootstraps.secret_hash` | C2 | 15-min ceiling, hard-deleted on consume | Single-use bootstrap secret |
| `auth_totp_bootstraps.totp_code` | **REMOVE** | n/a | Finding 6 — drop the column |
| `auth_totp_consumed_log.user_id` | C1 | 24h after `consumed_at` | F-38 reuse detection |
| `auth_totp_consumed_log.totp_code_hash` | C1 (HMAC of short-lived code) | 24h after `consumed_at` | MUST be HMAC, not SHA (Finding 2) |
| `webauthn_credentials.credential_id` | C1 | Until passkey revoked OR membership inactive + 24mo | Pseudonymized in audit_log |
| `webauthn_credentials.public_key` | C1 | Until passkey revoked OR membership inactive + 24mo | Public key — no secrecy required |
| `webauthn_credentials.aaguid` | C1 | Until passkey revoked OR membership inactive + 24mo | Authenticator model |
| `webauthn_credentials.transports[]` | C0 | Until passkey revoked OR membership inactive + 24mo | Enum |
| `webauthn_credentials.device_label` | C2 | Until passkey revoked OR membership inactive + 24mo | USER-PROVIDED only |
| `webauthn_credentials.rp_id` | C0 | Until passkey revoked OR membership inactive + 24mo | Server-determined |
| `auth_sessions.session_id` | C1 | 15-min TTL + 90d revocation history | Pseudonymized in audit_log |
| `auth_sessions.device_label` | C2 | 15-min TTL + 90d | USER-PROVIDED only |
| `auth_sessions.device_fingerprint` | C2 | 15-min TTL + 90d | HASHED by caller; NEVER raw UA |
| `users.totp_destroyed_at` | C1 | Membership + 24mo | F-43 audit field |
| `users.active`, `users.role` | C1 | Membership + 24mo | Migrated from `committee_membership` (see Finding 5) |

---

## 8. Cross-cutting observations

1. **`audit_log` stub at lines 36-50** — full schema lands in T18. Architect should confirm gap is acceptable, or that T18 backfills hash for pre-T18 rows.
2. **`audit_emit` missing `retention_class` column** — required by ADR-0015 §Schema Requirements #1. T18 must ADD it AND backfill.
3. **`audit_log` RLS at lines 60-62** is default-deny SELECT. Architecture in Amendments B + D calls for active-member SELECT via pseudonymized projection view. Architect tracks that deny-default is replaced (not augmented) when T13 lands.
4. **`audit_emit` signature does NOT include `p_request_id`** — `observability/audit-log.md:147-148` requires it. Non-blocking at T05; T18 ALTERs the function.
5. **`actor_pseudonym` in `meta` of `alert.fired`** — undocumented extension to the spec. Architect either adds it to the documented meta or renames to `subject_pseudonym`.

---

## 9. Architect amendments needed

1. **ADR-0002 Amendment G (new)** — "TOTP consumed-log table for F-38 reuse detection." Documents purpose, retention (24h after consume), classification (C1), HMAC-not-SHA pseudonymization.
2. **`.context/decisions.md` §PI inventory** — add the new rows in §7 above.
3. **ADR-0015 or new ADR-0016** — non-audit-log operational tables retention schedule. User ratifies under HG-9 / HG-14.
4. **ADR-0003 Amendment A extension wording fix** — clarify per-attempt vs per-successful-assertion.
5. **`observability/audit-log.md` alert.fired meta shape** — add the `actor_pseudonym` / `subject_pseudonym` field. Observability-setup pass owns.
6. **CI / semgrep rule** — ban `digest(..., 'sha256')` in `supabase/migrations/` for pseudonym derivation.
7. **HG-9 / HG-14 user ratification** — user signs off on new operational-table retention schedule before T16 ships.

---

## 10. Verdict per question

- **Q1 (`auth_totp_consumed_log`):** **APPROVED-WITH-CHANGES.** Findings 1 + 2 block.
- **Q2 (`auth.passkey.assert` structured-log-only):** **APPROVED-WITH-CHANGES.** Findings 3 + 4 non-blocking.
- **Q3 (General PI handling):** **APPROVED-WITH-CHANGES.** Findings 5 + 6 block.
- **Q4 (Browser-baseline):** **APPROVED.**
- **Q5 (Test harness):** **APPROVED-WITH-CHANGES.** Findings 7 + 8 non-blocking.

**Overall T05 status: BLOCKED on Findings 1, 2, 5, 6.** T05 should not merge until they are addressed.

---

## 11. Handoff

**Next agent: architect-coordinator.**

The architect-coordinator must:
1. Ratify the §PI inventory amendments (§7 above) — Finding 1.
2. Pick the fix for the SQL pseudonymization (HMAC-BLAKE2b-256 vs HMAC-SHA-256 with `HMAC_PSEUDONYM_KEY`) — Finding 2.
3. Confirm the `public.users` field set in the migration matches their intent, or amend the PI inventory + ADR-0002 — Finding 5.
4. Decide whether to drop the `totp_code` plaintext column or gate it with a CHECK constraint — Finding 6.
5. Adopt or reject the architect-amendment pointer list in §9.

After architect amendments land:
- **migration-handler** updates the migration per Findings 2, 5, 6.
- **test-writer** adds test obligations.
- **privacy-reviewer** re-runs on the resulting diff before T05 merges.

---

## Re-review after architect amendment #4 (2026-05-23)

**Re-review scope.** Combined respin diff `ceb4992..31955f0` on `claude/jhsc-app-plan-nUriS`. Files re-read: `supabase/migrations/00000000000001_auth.sql` (all 583 lines), `apps/web/src/lib/auth/server/key-parity.ts` (new), `apps/web/src/hooks.server.ts`, `apps/web/src/lib/auth/memory-store.ts:1-120`, `apps/web/src/lib/auth/auth-core.ts` (comment + emission sites), `scripts/verify-no-third-party-js.sh`, `.context/decisions.md` ADR-0016 + ADR-0002 Amendment G + amendment-pass-#4 summary.

### What changed since prior review

1. **ADR-0016 (NEW, top of `decisions.md` lines 28-175)** — operational-table retention schedule + HMAC-SHA-256 + `app.hmac_pseudonym_key` GUC standard. HG-15 bundles user ratification.
2. **ADR-0002 Amendment G (lines 2618-2762)** — folds the four T05 auth-side-table decisions into the auth ADR. G.1 documents `auth_totp_consumed_log`; G.2 drops `auth_totp_bootstraps.totp_code`; G.3 reconciles `public.users` field set with the migration; G.4 ratifies HMAC-keyed pseudonyms + `subject_pseudonym` rename; G.5 ratifies per-attempt canonical wording for `auth.passkey.assert`; G.6 + G.7 fold-in `retention_class` + `request_id` at T05.
3. **PI inventory amendments (`decisions.md:3251-3261+`)** — `users.{active,role,totp_destroyed_at}` rows added; `auth_totp_consumed_log.*` rows added; `auth_totp_bootstraps.totp_code` row removed; T06/T07-deferred `users` fields explicitly marked.
4. **Migration** — pseudonym derivation at lines 400, 413, 439, 484, 571 all use `hmac(X::bytea, current_setting('app.hmac_pseudonym_key')::bytea, 'sha256')`. `auth_totp_bootstraps.totp_code` removed; `UNIQUE (user_id)` only. `auth_totp_consumed_log` created with `(user_id, totp_code_hash bytea, consumed_at)`. GUC presence check fails the migration if unset. `audit_log.retention_class` + `audit_emit(p_request_id uuid, …)` + `retention_class_for(event_type)` all present. `alert.fired` uses `subject_pseudonym` in meta; outer `actor_pseudonym = 'sys-alert-dispatcher'`.
5. **New file `apps/web/src/lib/auth/server/key-parity.ts`** — boot-time TS↔Postgres SHA-of-key parity check. Caches SHA only; constant-time verify; never logs key/SHA. Server-only via `lib/auth/server/` convention + `typeof window` guard.
6. **`apps/web/src/hooks.server.ts`** — gated boot smoke test; on failure `_drained = true` and every request returns 503 with generic body. Drained reason in logs only.
7. **`scripts/verify-no-third-party-js.sh:69`** — added `HMAC_PSEUDONYM_KEY` to bundle-leak denylist.
8. **`memory-store.ts:23,49-99`** — pseudonym + TOTP-code-hash both use HMAC-SHA-256 keyed by per-store `randomBytes(32)`. Algorithm parity with prod; key independence by design.

### Per-Q verdict (re-issue)

- **Q1 (`auth_totp_consumed_log`):** APPROVED-WITH-CHANGES → **APPROVED.** Documentation: ADR-0016 row + ADR-0002 Amendment G.1 + PI inventory rows for `user_id`, `totp_code_hash`, `consumed_at` all present. Principles 4.2 + 4.5 defensibility holds. HMAC implementation at `00000000000001_auth.sql:413`. Retention 24h documented; enforcer is T16 (see new Finding R3).

- **Q2 (`auth.passkey.assert` structured-log-only):** APPROVED-WITH-CHANGES → **APPROVED.** Per-attempt canonical wording ratified in Amendment G.5. Code cites at lines 14-17, 188-189, 253-254, 485-487. `actor_pseudonym` omission on server INFO emissions remains a T05-prod-deployment obligation (carry forward).

- **Q3 (General PI handling):** APPROVED-WITH-CHANGES → **APPROVED.** B3 (Finding 5): `public.users` is `{id, active, role, totp_destroyed_at, created_at, updated_at}` exactly. PI inventory matches. B4 (Finding 6): `auth_totp_bootstraps` has `secret_hash bytea` only; no plaintext column. `UNIQUE (user_id)` only. Comparison rewritten. PIPEDA Principle 4.4 + 4.7 satisfied.

- **Q4 (Browser-baseline gate):** **APPROVED.** Unchanged.

- **Q5 (Test harness):** APPROVED-WITH-CHANGES → **APPROVED-WITH-ADVISORY.** Algorithm parity achieved (HMAC-SHA-256 both sides); key independence is acceptable under Principle 4.7 — the security property is "not recoverable to underlying id without the key," not "bit-identical output across processes." Finding 8 (consent surface bypass) still applies to T06.

### New findings from the respin (R1–R7)

**Finding R1 (ADVISORY — gate hygiene):** `scripts/verify-no-third-party-js.sh:36-44` falls back to `SRC_DIR` scan when `BUILD_DIR` is absent; three comment-only occurrences of `HMAC_PSEUDONYM_KEY` in source files would false-positive. CI runs `pnpm build` first so production CI is unaffected; local dev / future CI paths without build could erroneously block. Fix: exclude comment lines from source-fallback scan or downgrade source-fallback to warn. Non-blocking.

**Finding R2 (ADVISORY — drift check):** `00000000000001_auth.sql:117-150` `retention_class_for()` is a hand-typed mirror of ADR-0015/ADR-0016. Currently aligned (22 rows match), but no test asserts the mirror. Future ADR amendment that adds an event_type without updating the function silently falls through to `'24mo'`. Test-writer carries forward a drift-check test enumerating event_type values across (a) `audit_log_retention_schedule` table and (b) `retention_class_for()` output, asserting equality.

**Finding R3 (ADVISORY but operational gate — Principle 4.5 enforcer):** ADR-0016 documents 24h retention for `auth_totp_consumed_log` but T05 ships no sweep job; T16 owns it. Between T05 ship and T16 ship, no automated deletion. Acceptable on a low-volume single-tenant v0 but PIPEDA 4.5 is only satisfied by an enforced retention. **T16 is a hard prerequisite for the first production deploy where real PI lands.** Not a blocker on T05 merge; is a blocker on T05-bearing production deploy.

**Finding R4 (ADVISORY — defense-in-depth):** Boot smoke test runs only when `_isProduction === true` (`hooks.server.ts:82-88`). In a misconfigured staging where `MODE=production` isn't set but real PI flows (e.g., preview deploy pointed at real Supabase), the parity check is skipped. Fix: either tighten the gate (any presence of `HMAC_PSEUDONYM_KEY` env var triggers the check regardless of MODE — defense in depth) OR document explicitly that `MODE=production` is a deploy-time requirement. Architect-level decision; deploy-runbook item.

**Finding R5 (CONFIRMED — `subject_pseudonym` rename OK):** Outer `actor_pseudonym: 'sys-alert-dispatcher'`; `meta.subject_pseudonym: actorKey` (HMAC-SHA-256 of user_id). No raw user_id, no email, no IP. Second `subject_pseudonym` use at line 367 also keyed-HMAC. No regression. Closed.

**Finding R6 (CONFIRMED — `audit_emit(p_request_id uuid)` safe):** request_id from `crypto.randomUUID()` (no user input) or strict UUIDv4-regex-validated incoming header. Propagated as X-Request-ID response header. `event.locals.request_id` typed. No cookie / local-storage / PI-tagged log alongside. Closed.

**Finding R7 (CONFIRMED — `auth_totp_consumed_log.totp_code_hash` shape):** `bytea NOT NULL`, full 32 bytes, no truncation. Cleaner than text-hex; entropy preserved for byte-equality. Closed.

### Overall T05 verdict

**APPROVED-WITH-ADVISORIES.** All four prior blocking findings (1, 2, 5, 6) closed. Four new advisories (R1–R4) non-blocking. **R3 is a hard prerequisite for first production deploy** (T16 retention sweep must land before real PI flows). R4 is a deploy-runbook item.

Human-gate posture:
- **HG-15 (NEW)** — user ratification of (a) ADR-0016's operational-table retention schedule and (b) the HMAC-SHA-256 + GUC posture. Bundled per Amendment G. Architect recommendation to user: APPROVE both as proposed. Until HG-15 lands, T05 is merge-eligible but T16 / production deploy is gated.
- No new cross-border-transfer gate. No new third-party processor.

### Handoff

Next agent: **orchestrator / user (HG-15)**.

Carry-forwards:
- **T16:** 24h sweep for `auth_totp_consumed_log` (R3); per-event-type retention-schedule drift assertion (R2).
- **Test-writer:** Amendment G testable assertions §1–9 at `decisions.md:2715-2727`; retention-class-mirror drift check (R2).
- **Implementer / migration-handler:** CI gate refinement for source-fallback false-positives (R1, optional); boot-smoke-test activation rule tightening (R4, optional deploy-runbook item).
- **Unchanged carry-forward:** `auth.passkey.assert` server INFO `actor_pseudonym` inclusion is a T05-prod-deployment obligation (prior Finding 4).

T05 cleared on its own merits for merge. Production deploy gates on T16 landing + HG-15 ratification.
