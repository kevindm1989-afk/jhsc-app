# Test plan — Phase 2 (T02, T05, T07, T08, T10, T11, T12, T13, T14, T16, T17, T18, T19)

> **Status:** failing-test suite landed before any implementer code.
> **Owner:** test-writer (this pass).
> **Next agent:** implementer — see §6 handoff.
>
> Hard rules (recorded so the implementer cannot soften them):
> - Tests are not modified to make them green. The implementer adapts code to the tests.
> - Every test references its source obligation (threat-model F-id, privacy-review obligation #, ADR amendment, HG-id) either in the test name or in a comment block above the test.
> - Determinism: no real clock, no real network, no real RNG, no shared mutable state, no order dependence, no sleep. Frozen clock per `_helpers/clock.ts`; seeded test fixtures per `_helpers/fixtures.ts`.
> - Synthetic PI only. Canaries match `observability/sentry-scrub.ts` exactly.

---

## 1. Test files and obligation coverage matrix

Reading order: each row is `Task → test file → source obligations covered`. A coverage matrix follows in §1.B.

### 1.A — Files

| Task | File (absolute path) | Test count (approx.) |
|---|---|---|
| T02 | `/home/user/agent-os/apps/web/test/T02/sentry-scrub.test.ts` | 14 |
| T02 | `/home/user/agent-os/apps/web/test/T02/structured-logger.test.ts` | 10 |
| T02 | `/home/user/agent-os/apps/web/test/T02/ci-gates.test.ts` | 9 |
| T02 (Edge Function) | `/home/user/agent-os/supabase/functions/_shared/test/log.test.ts` | 4 |
| T05 | `/home/user/agent-os/apps/web/test/T05/auth-passkey.test.ts` | 19 |
| T07 | `/home/user/agent-os/apps/web/test/T07/e2ee-key-core.test.ts` | 30 |
| T08 | `/home/user/agent-os/apps/web/test/T08/concern-intake.test.ts` | 14 |
| T10 (HMAC) | `/home/user/agent-os/apps/web/test/T10/offline-queue-hmac.test.ts` | 10 |
| T10 (EXIF) | `/home/user/agent-os/apps/web/test/T10/photo-sanitize.test.ts` | 8 |
| T10 (SW cache) | `/home/user/agent-os/apps/web/test/T10/sw-cache.snapshot.test.ts` | 6 |
| T11/T12 | `/home/user/agent-os/apps/web/test/T11_T12/export-pipeline.test.ts` | 22 |
| T13 | `/home/user/agent-os/apps/web/test/T13/reprisal-log.test.ts` | 27 |
| T14 | `/home/user/agent-os/apps/web/test/T14/c3-read-audit.test.ts` | 11 |
| T16 | `/home/user/agent-os/apps/web/test/T16/retention.test.ts` | 27 (18 SCENARIOS rows + 9 non-parameterized) |
| T17 | `/home/user/agent-os/apps/web/test/T17/backup-object-lock.test.ts` | 11 |
| T18 | `/home/user/agent-os/apps/web/test/T18/audit-integrity.test.ts` | 13 |
| T19 | `/home/user/agent-os/apps/web/test/T19/onboarding.test.ts` | 10 |
| pgTAP (T13/T14/T16/T18) | `/home/user/agent-os/supabase/test/c4_read_audited_rls.sql` | 18 |

**Total failing tests at hand-off: ~261 assertions across 18 files** (Vitest counts each `it.each` entry as its own test; conservative count without `it.each` expansion ≈ 195).

### 1.B — Obligation coverage matrix

| Source obligation | Where covered |
|---|---|
| **T02** | |
| threat-model §8 T02 canary contract | `sentry-scrub.test.ts` — canary-PII redaction tests; `structured-logger.test.ts` — canary in attributes test |
| ADR-0010 — `beforeSend` strips cookies/auth/query/body | `sentry-scrub.test.ts` — cookies/Authorization/URL/query/data tests |
| ADR-0010 — no `Sentry.setUser` on browser | `ci-gates.test.ts` — `no-direct-sentry-setuser` semgrep rule |
| ADR-0010 Amendment F-D Rule 1 (no PI in Edge Function logs) | `log.test.ts` (Deno) — Edge Function canary; `structured-logger.test.ts` — denylist drop |
| ADR-0010 Amendment F-D Rule 2 (scrub at emit; WARN on unknown key) | `structured-logger.test.ts` — unknown-key CI WARN test |
| ADR-0010 Amendment F-D Rule 3 (request_id propagation) | `structured-logger.test.ts` — request_id propagation; `log.test.ts` |
| ADR-0010 Amendment F-B (`queue.integrity_fail` canonical; alias forbidden) | `offline-queue-hmac.test.ts` — alias absence; `ci-gates.test.ts` — semgrep rule |
| Invariant 1 strengthened (private-key-shape canary) | `sentry-scrub.test.ts` — 32+ byte base64 scrub; `e2ee-key-core.test.ts` — canary never in logs/Sentry |
| Invariant 5 strengthened (no key-shaped URL params) | `e2ee-key-core.test.ts` — route inventory; `ci-gates.test.ts` — semgrep rule |
| observability-README §11.1–§11.12 | items 2/4/5/8/9/10/11 covered across `sentry-scrub.test.ts` + `structured-logger.test.ts` + `audit-integrity.test.ts`; item 1 (Sentry-self-test SaaS round-trip) → `test.skip` with TODO; item 12 (B2 drift alert) → `backup-object-lock.test.ts` |
| logging.md §7 (7 CI rules) | `ci-gates.test.ts` — one assertion per semgrep rule + audit-enum-coverage script |
| **T05** | |
| F-37 / T7 — passkey origin binding | `auth-passkey.test.ts` — origin mismatch (2 tests) |
| F-38 — TOTP bootstrap | `auth-passkey.test.ts` — single-use, 15-min expiry, 5-attempt lock |
| F-39 — server-side jti revocation | `auth-passkey.test.ts` — revoke-all 5s propagation + sustained 401 |
| F-40 / T8 — enumeration prevention | `auth-passkey.test.ts` — byte-identical + ≤50ms timing + no enumerating body |
| F-42 — auth rate limit | `auth-passkey.test.ts` — 11th 429 + A-AUTH-001 alert |
| F-43 — TOTP destroyed atomically with passkey enrollment | `auth-passkey.test.ts` — TOTP row deletion + totp_destroyed_at + 401 on reuse |
| ADR-0002 — minimum browser baseline | `auth-passkey.test.ts` — Safari 15 blocked + Chrome 130 allowed |
| Audit emissions — passkey enrolled/revoked, session.revoked | `auth-passkey.test.ts` — revoke-passkey + revoke-all |
| ADR-0003 Amendment A extension — `auth.passkey.assert` volumetric | `auth-passkey.test.ts` — 100 asserts → 0 chain rows + 100 log lines |
| **T07** | |
| ADR-0003 Invariants 1–7 (verbatim) | `e2ee-key-core.test.ts` — Invariant 1 (ciphertext shape + canary), Invariant 2 (no admin recovery routes), Invariants 4/5/6 (rotation race + atomic + history), Invariant 7 covered via T13 HG-6 tests |
| F-01 — wrap RLS | `e2ee-key-core.test.ts` — inactive + non-existent + non-retroactive |
| F-02 — pubkey/privkey pairing self-test | `e2ee-key-core.test.ts` |
| F-03 — IndexedDB self-test | `e2ee-key-core.test.ts` — corrupted blob + audit emission |
| F-04 — rotation race | `e2ee-key-core.test.ts` — concurrent rotation, no mixed state |
| F-05 — removed member purge | `e2ee-key-core.test.ts` — current + history empty; same-txn session invalidation |
| F-07 / HG-2 / Invariant 8 — 8 enum values | `e2ee-key-core.test.ts` — one test per enum + hash-chain + abort + CI grep + alerting |
| F-08 — Argon2id floor | `e2ee-key-core.test.ts` — ops ≥ 4 + mem ≥ 512MB + type-back |
| F-09 / Invariant 3 — Edge Function canary | `e2ee-key-core.test.ts` — Edge Function log capture |
| F-12 — recovery blob single-POST | `e2ee-key-core.test.ts` — second POST 409 + co-chair reset path |
| F-54 / HG-12 / Amendment F M-54a/b/c/d | `e2ee-key-core.test.ts` — hold-to-reveal, audit gates render, 3-cap + restart, no TTS/clipboard, static lint, i18n contract |
| **T08** | |
| F-15 — RLS denies non-active-member INSERT | `concern-intake.test.ts` |
| F-16 — UPDATE writes prev_field_hashes | `concern-intake.test.ts` |
| F-17 — anonymous default-ON / audit always carries actor_id | `concern-intake.test.ts` — anon=true + anon=false both carry actor + structural default-ON lock |
| F-18 — list payload omits source_name_ct; reveal logs before plaintext returns | `concern-intake.test.ts` |
| F-20 — rate limit + 429 no PI body | `concern-intake.test.ts` |
| ADR-0007 — no public-write route | `concern-intake.test.ts` — route inventory |
| design-system §4.B + WCAG | `concern-intake.test.ts` — switch label, role=status advisory, aria-describedby |
| **T10** | |
| F-44 / HG-4 / ADR-0014 — HMAC tamper + cross-device replay + sequence + salt version + known-answer | `offline-queue-hmac.test.ts` |
| F-45 — IndexedDB plaintext hygiene | `offline-queue-hmac.test.ts` |
| F-46 / HG-5 — EXIF/IPTC/XMP strip + canvas re-encode + GPS byte-grep + no "use my location" | `photo-sanitize.test.ts` |
| F-47 — queue cap | `offline-queue-hmac.test.ts` |
| F-10 / HG-3 / ADR-0013 — SW snapshot + X-Data-Class sanity check + lock-clears-cache + version-bump | `sw-cache.snapshot.test.ts` |
| alerts.md A-QUEUE-001 | `offline-queue-hmac.test.ts` |
| **T11/T12** | |
| F-19 — closed allowlist + ESLint forbids spread + PDF text grep | `export-pipeline.test.ts` — inline snapshots + frozen const + C4 absence + PDF text |
| F-22 — RLS gating finalized minutes | `export-pipeline.test.ts` |
| F-24 — audit before Blob URL | `export-pipeline.test.ts` — ordering + audit-fail aborts |
| F-25 — no server PDF route | `export-pipeline.test.ts` — route inventory |
| F-27 — allowlist hash audit binding + monkey-patch detection | `export-pipeline.test.ts` |
| F-28 — export rate limit | `export-pipeline.test.ts` |
| F-29 / HG-1 / RA-1 — single-signer co-chair re-auth + approver_id = actor_id | `export-pipeline.test.ts` |
| RA-1 compensating control #3 — concern-derived items flag | `export-pipeline.test.ts` — interstitial + audit row + checkbox gating |
| RA-1 compensating control #4 — post-export notification | `export-pipeline.test.ts` — 60s feed visibility + notification-failure non-blocking |
| F-53 / Amendment C extension M-53a/b/c | `export-pipeline.test.ts` — parameterized over 5 protected modal variants + ready promise + inert |
| **T13** | |
| F-30 — session invalidation ≤5s | `reprisal-log.test.ts` |
| F-31 — UPDATE surfaces in feed ≤60s + prev_field_hashes | `reprisal-log.test.ts` |
| F-32 — 4-eyes DELETE | `reprisal-log.test.ts` (under HG-7) |
| F-33 / HG-6 / Amendment B — server-side enforced read audit (atomic, definer view) | `reprisal-log.test.ts` — direct bypass + view success + atomicity + pg_proc coverage |
| F-34 — passphrase is UX-only | `reprisal-log.test.ts` — ck_priv decrypt without passphrase + access_attempt audit |
| F-35 — rate limit | `reprisal-log.test.ts` |
| F-36 / HG-7 — soft-delete (status-flip) gated by 4-eyes | `reprisal-log.test.ts` — 4 tests including retention-only hard delete |
| HG-13 / Amendment D / privacy-review §7 obligations 1–3 | `reprisal-log.test.ts` — projection columns + direct bypass + time bucketing + default-list payload |
| HG-13 / Amendment E / privacy-review §7 obligation 4 | `reprisal-log.test.ts` — proposer self-approve denied + distinct approval + non-pair denied + single-co-chair pair + expiry |
| HG-13 / ADR-0007 amendment / privacy-review §7 obligation 5 | `reprisal-log.test.ts` — four bullets + Save gating + per-intake re-render + i18n heading |
| F-53 (passphrase_prompt variant) | `reprisal-log.test.ts` |
| RLS access matrix (author / co-chair / certified / other-worker) | `reprisal-log.test.ts` |
| No automatic export inclusion | `reprisal-log.test.ts` |
| **T14** | |
| F-21 — certified_member-only RLS | `c3-read-audit.test.ts` — positive + 2 negatives + co-chair via view |
| Amendment A extension — work_refusal.read / s51_evidence.read enums | `c3-read-audit.test.ts` — view + atomicity + coverage |
| Amendment D extension (privacy-review §7 obligation 6) | `c3-read-audit.test.ts` — pseudonymized projection on T14 events + bypass |
| HG-5 cross-reference — s.51 evidence photo sanitize | `c3-read-audit.test.ts` — round-trip + byte-grep |
| C4 wrap-and-key (ciphertext shape) | `c3-read-audit.test.ts` |
| **T16** | |
| HG-14 / ADR-0015 / privacy-review §7 obligation 7 — per-event schedule | `retention.test.ts` — 18 parameterized SCENARIOS (covering 90d, 24mo, 7y groups + match-underlying-record) |
| privacy-review §7 obligation 8 — underlying-record-ceiling (30d buffer) | `retention.test.ts` — orphan + within-buffer |
| privacy-review §7 obligation 9 — retention.deleted 7y carve-out | `retention.test.ts` |
| privacy-review §7 obligation 10 — schedule vs enum drift | `retention.test.ts` — coverage + phantom enum + phantom row |
| privacy-review §7 obligation 11 — `retention.deleted` per-event-type counts | `retention.test.ts` |
| F-51 — dry-run default + volume alert | `retention.test.ts` |
| F-52 — single summary per pass + hash-chained | `retention.test.ts` |
| **T17** | |
| F-06 — backup ciphertext-of-ciphertext | `backup-object-lock.test.ts` |
| F-48 — dump-key not adjacent | `backup-object-lock.test.ts` |
| F-49 / HG-8 — Object Lock + versioning + lifecycle + scoped grants + drift check | `backup-object-lock.test.ts` — 5 drift-check variants + lifecycle 42d + 35–42d grace + overwrite-creates-version + retention-violation denied |
| Restore drill | `backup-object-lock.test.ts` |
| **T18** | |
| F-50 — 5-min detection on scheduled / post-rotation / post-export | `audit-integrity.test.ts` |
| RA-2 / F-A — live-vs-backup diff (pivot-rewrite catch) | `audit-integrity.test.ts` — pivot fires alert + no-false-positive |
| audit-log.md §5 obligations 2/3/6/7/8/9 | `audit-integrity.test.ts` — UPDATE/DELETE roles, CHECK constraint, meta shape, server-side hash, key-rot enum gap |
| Amendment A extension — closed-enum coverage + volumetric exclusion | `audit-integrity.test.ts` — CI grep + 100 asserts |
| T11 sensitive-read notification | `audit-integrity.test.ts` |
| **T19** | |
| ADR-0008 / D.1 — personal-device advisory | `onboarding.test.ts` |
| ADR-0001 / D.2 — hosting tradeoff copy | `onboarding.test.ts` |
| ADR-0002 / D.3 — browser baseline | `onboarding.test.ts` |
| Amendment F / F-54 — full D.1→D.7 with show-again | `onboarding.test.ts` |
| T2 / panic wipe + F-53 destructive_confirm variant (M-53a/b/c) | `onboarding.test.ts` |
| WCAG 2.0 AA on every onboarding screen | `onboarding.test.ts` (axe check) |

---

## 2. Obligations covered vs deferred

### 2.A — Deferred (marked `test.skip` with TODO citing the obligation)

| Obligation | File | Why deferred |
|---|---|---|
| observability-README §11.1 — synthetic-error → Sentry SaaS round-trip within 5 minutes | `T02/sentry-scrub.test.ts` (covered indirectly via scrubber; the real SaaS round-trip is a CI gate that needs an environment with a Sentry DSN) | Real Sentry transport; needs CI env with DSN. Marked skip in CI-gates with TODO. |
| `verify.sh` smoke (exits 0 on a clean tree) | `T02/ci-gates.test.ts` | `scripts/verify.sh` is currently a placeholder; smoke wired after T00 scaffold. |
| Bundle-grep — `HMAC_PSEUDONYM_KEY` not in built bundle | `T02/sentry-scrub.test.ts` | Build artifact does not exist until T00 + T02 implementer pass produces it. Real assertion lives in `scripts/verify.sh` once the build is wired. |

### 2.B — Architect-deferred items the test-writer surfaces

- **HMAC_PSEUDONYM_KEY rotation policy** is flagged by privacy-review §4 cross-cutting observation #3 as architect-decided-later. No test in this pass exercises a key-rotation path because the policy does not yet exist; when it lands, two tests will be needed: (a) post-rotation, old-era audit rows are not correlatable to the new era's pseudonyms; (b) the rotation event itself emits an enum row on the chain. **Surfaced for architect** — not silently added.
- **`reprisal.created` actor-pseudonym surfacing in the visible feed** is now closed by Amendment D's pseudonymized projection (T13 tests cover). Recorded so a future amendment that re-exposes the column triggers the privacy-review re-open.
- **`pending_destructive_ops` schema for T13 4-eyes** is consumed by the tests but the architect did not enumerate column names in ADR-0003 Amendment B / system design RLS outline beyond "two distinct approver IDs". The tests assume `proposer_id` / `approver_id` / `target_table` / `target_id` columns; if the migration uses different names, the implementer surfaces back to architect for an ADR amendment, not a test rewrite.

---

## 3. Infrastructure requirements (propose-and-handoff)

The implementer must stand these up before any test runs. None is wired today.

### 3.A — Vitest + SvelteKit web app (T00 scaffold)
- `apps/web/` SvelteKit + Vitest, with `@testing-library/svelte` for component-level tests.
- `apps/web/vite.config.ts` + `apps/web/vitest.config.ts`.
- `pnpm verify` runs `vitest run` for unit + integration; `vitest run --project=e2e` for the Playwright e2e tier.
- All tests use the frozen-clock helper in `apps/web/test/_helpers/clock.ts`. The test-runner config must NOT inject a real-clock side effect.

### 3.B — Supabase local stack
- `supabase start` with migrations applied (T04 baseline + T07 key tables + T13 reprisal_log + T14 work_refusal/s51_evidence + T16 retention).
- A scratch Supabase project is spun up per test file (test isolation). The harness is `apps/web/test/_helpers/supabase-test.ts` (stubbed; implementer wires).
- Region pin verified by a CI script reading the project metadata (ADR-0001).

### 3.C — pgTAP for SQL-level RLS / schema tests
- **Proposed.** pgTAP is the SQL test harness. The Supabase local image needs `CREATE EXTENSION pgtap` enabled at boot. Tests are run via `pg_prove -d postgres -h localhost supabase/test/*.sql` in CI.
- File at `supabase/test/c4_read_audited_rls.sql` covers RLS + GRANT/REVOKE + view existence + ownership + CHECK constraints for T13/T14/T16/T18.

### 3.D — Edge Function tests
- Deno's built-in test runner: `deno test --allow-read supabase/functions/_shared/test/log.test.ts`.
- The Edge Function shared logger lives in `supabase/functions/_shared/log.ts`; tests live alongside.

### 3.E — Service Worker tests
- The `T10/sw-cache.snapshot.test.ts` requires a SW test harness (`_helpers/sw-test-harness.ts`) that simulates `caches.open`/`Cache.put`/`Cache.match` deterministically. Vitest's jsdom environment is augmented with a fake Cache Storage. **Proposed.**

### 3.F — Photo / EXIF fixtures
- `_helpers/exif-fixtures.ts` builds JPEGs with known EXIF GPS, IPTC by-line, XMP creator-tool tags from synthetic primitives (no real photos).
- `_helpers/exif-parser.ts` parses EXIF/IPTC/XMP for the round-trip assertion. **Proposed:** ship as a dependency-free shim or use `exifr` pinned and verified.

### 3.G — Backblaze B2 fake
- `_helpers/b2-fake.ts` implements the B2 admin/workflow API surface enough to enforce Object Lock (governance, 35d), versioning, lifecycle (42d). No real B2 calls. **Proposed.**

### 3.H — Crypto known-answer vectors
- `_helpers/libsodium-helpers.ts` exposes deterministic test keys and the secretbox encrypt/decrypt path with seeded RNG. **Proposed.**

### 3.I — Playwright (deferred to T00 + when first e2e test lands)
- Not used by any test in this pass. Listed for completeness; the e2e suite for T11 export interstitial may need it once the implementer's protected-modal-harness covers the in-process surface fully.

### 3.J — Test environment determinism
- `NODE_ENV=test` for browser-side suites; `DENO_ENV=test` for Edge Function tests.
- No outbound network. Sentry transport is stubbed via `setPanicSink` (per the in-file fixture in `observability/sentry-scrub.ts` §6).
- Frozen clock at `2026-05-22T14:37:42.123456Z` unless a specific test advances or moves it (e.g., `T16/retention.test.ts` advances by days/years).

---

## 4. Per-task acceptance criteria the implementer must satisfy

The implementer's contract: every test in §1.A must pass without modification.

### T02
- Wire `apps/web/src/lib/observability/sentry-scrub.ts` from the `observability/sentry-scrub.ts` spec (verbatim).
- Wire `apps/web/src/lib/log/` (browser + server) and `supabase/functions/_shared/log.ts` (Edge Functions) per `observability/logging.md` §2–§4.
- Land seven semgrep rules in `.semgrep/` per `observability/logging.md` §7.
- Land `scripts/check-audit-enum-coverage.sh` per ADR-0003 Amendment A extension.

### T05
- Implement Supabase Auth + WebAuthn passkeys + TOTP bootstrap per ADR-0002.
- TOTP destroyed atomically with first passkey (single SQL transaction).
- Server-side jti revocation with ≤5s propagation.
- Byte-identical + timing-equivalent (≤50ms) auth failure responses.
- Rate limits per F-42; `A-AUTH-001` alert wiring.
- `auth.passkey.assert` emits to structured-log only (NOT audit_log).

### T07
- libsodium-wrappers; identity keys + committee key + per-member wrap + rotation per ADR-0003.
- All 8 audit-log enum emissions for key-material mutations (Amendment A), hash-chained.
- Recovery-passphrase Argon2id at the floor; type-back verify; single-POST + co-chair reset.
- `IdentitySelfTest` on session start with audit emission on failure.
- Rotation atomic; advisory lock; member-removal wraps purged.
- Surface D.6 "show again" control with M-54a/b/c/d (Amendment F).
- Static lint: no TTS/clipboard in recovery flow.

### T08
- Concern intake form; anonymous toggle defaults ON; structurally locked across mounts.
- Named-source advisory rendered BEFORE source_name field with aria-describedby.
- RLS: `is_active_member()` for INSERT; revoked-member JWT invalidates ≤60s.
- Audit `concern.created` always carries actor_pseudonym regardless of anonymous.
- Default list payload omits `source_name_ct`; reveal audit precedes plaintext.
- Rate limit + no-PI 429 body.

### T10
- Inspection queue HMAC per ADR-0014 (BLAKE2b-256 keyed + HKDF + versioned salt `jhsc.queue.hmac.v1`).
- Photo sanitize per ADR-0011 amendment: strip EXIF/IPTC/XMP + canvas re-encode + GPS-shape byte-grep + no "use my location" UI.
- SW cache per ADR-0013: closed allowlist; `X-Data-Class: C3|C4` sanity check; cache clear on lock/logout/panic.
- Snapshot fixture under reviewer-gated change.

### T11/T12
- Closed-const allowlist module; ESLint forbids spread outside it.
- F-24 audit row precondition; F-25 no server PDF; F-27 allowlist hash binding; F-28 rate limit.
- RA-1: single-signer co-chair re-auth; approver_id = actor_id; concern-derived flag interstitial; post-export rep notification within 60s.
- F-53 Amendment C extension M-53a/b/c on all five protected modal variants.

### T13
- HG-6 server-enforced read audit via `reprisal_log_read_audited` SECURITY DEFINER view + `c4_read_service` role.
- HG-7 soft-delete (status-flip) gated by 4-eyes; only retention-job hard-deletes.
- HG-13 Amendment D: `reprisal_audit_feed_pseudonymized` view; column-level GRANT-revoke OR row-level RLS for actor_pseudonym on reprisal.* events; default list payload uses view.
- HG-13 Amendment E: `pending_forensic_reveals` table + `forensic_read_service` role + `jhsc_forensic_reveal_actor_pseudonym` function + 2 new enum values; 24h reveal-session expiry.
- HG-13 ADR-0007 amendment: Surface C consent surface — four bullets, structurally-gated Save, per-intake re-render.

### T14
- C4 read indirection mirroring T13 HG-6 on `work_refusal_read_audited` and `s51_evidence_read_audited`; new enum values `work_refusal.read` / `s51_evidence.read`.
- Amendment D extension: pseudonymized projection covers T14 write events.
- HG-5 sanitize pipeline applied to s.51 evidence photos.

### T16
- ADR-0015 per-event-type retention schedule with `audit_log_retention_schedule` table, `audit_log.retention_class` column (NOT NULL + CHECK), and CI drift assertion.
- Underlying-record-ceiling rule (30-day buffer); `retention.deleted` carve-out at 7y.
- Per-event-type jsonb count in `retention.deleted.meta`.
- Dry-run default; volume alert >20.

### T17
- Backblaze B2 (Canadian) bucket with Object Lock (governance, 35d) + versioning + 42d lifecycle.
- Workflow credential scoped to {PutObject, GetObject, ListObjects}.
- Weekly drift-check CI job; alert on any drift.
- Restore drill that decrypts a fixture row with the test committee key.

### T18
- Hash-chained audit log with daily integrity job + post-rotation + post-export triggers; ≤5-min `A-AUDIT-001` detection.
- RA-2 live-vs-backup diff with no false positive on rows newer than the dump.
- audit-log.md §5 schema-level invariants (UPDATE/DELETE roles, CHECK, meta shape, server-side hash).
- A-KEY-ROT-001 alert when `rotation.started` lacks `.completed` within 30s.

### T19
- Onboarding flow D.1 (personal-device advisory) → D.7 with browser-baseline gate at D.3.
- Full Amendment F integration: at least one "show again" invocation; audit row under partially-enrolled user; counter resets on D.7.
- Panic-wipe destructive_confirm with M-53a/b/c invariants including the literal-phrase gating before `ready`.
- WCAG 2.0 AA on every onboarding screen (axe check).

---

## 5. Tests that depend on architect-deferred items

| Test | Architect-deferred item | What changes when resolved |
|---|---|---|
| (none currently exercises an HMAC_PSEUDONYM_KEY rotation path) | rotation policy for HMAC_PSEUDONYM_KEY | adds 2 tests under `T18/audit-integrity.test.ts` |
| `T13 / Amendment D — direct bypass (test obligation 2)` | architect's choice between column-level GRANT-revoke vs row-level RLS for `actor_pseudonym` on reprisal events | the test covers both shapes per privacy-review §7 closing note ("test both paths"). Once the architect picks, the unchosen branch may be dropped — but until then, both shapes are exercised. |
| `T16 / phantom enum / phantom schedule drift` | architect's choice of enum CHECK vs lookup-table FK | the test exercises an integration-shaped drift; the implementer may need to adjust how the phantom is added/removed |
| `T17 / restore drill` | bucket provider (resolved as Backblaze B2 Canadian per Q1) | the test runs against a fake B2; real B2 integration is a deferred CI gate (needs real-network credential) |

---

## 6. Handoff

**Next agent: implementer (Phase 2 build loop).**

Reading order before touching code:

1. **`/home/user/agent-os/.context/test-plan.md`** (this file) — what's being tested, why, and the acceptance criteria.
2. **`/home/user/agent-os/.context/decisions.md`** — every ADR + amendment + RA-1/RA-2; especially:
   - ADR-0003 Amendments A, B, C extension, D, E, F.
   - ADR-0007 amendment (reprisal-intake consent).
   - ADR-0011 amendment (EXIF strip).
   - ADR-0012 amendment (Object Lock).
   - ADR-0013 (SW cache allowlist).
   - ADR-0014 (queue HMAC).
   - ADR-0015 (per-event retention).
3. **`/home/user/agent-os/.context/threat-model.md` §8** — task-by-task obligations.
4. **`/home/user/agent-os/.context/privacy-review.md` §7** — the 11 obligations (6 on T13, 5 on T16).
5. **`/home/user/agent-os/observability/`** (all four files) — the canonical PI-scrub and audit-log contracts.
6. **`/home/user/agent-os/.context/design-system.md`** — every component state every UI test asserts.
7. **`/home/user/agent-os/design-tokens.json`** — token-only assertions in UI tests; no hex/px hard-coding.
8. **`/home/user/agent-os/i18n/en-CA.json`** — every visible string lives here; tests assert key resolution + the explicit a11y announcement strings from the a11y-review.

Per-task execution order (mirrors architect's task list):

T02 → T05 → T07 (after T05) → T08 → T10 → T11/T12 → T13 (after T07) → T14 (after T13) → T16 (HG-14 ratified 2026-05-22; unblocked) → T17 → T18 → T19.

**The implementer is forbidden from modifying any test file in this pass.** A failing test surfaces a missing or wrong implementation; the right response is to fix the implementation, not the test. If a test seems wrong, surface back to the architect via a finding (do not silently edit).

---
