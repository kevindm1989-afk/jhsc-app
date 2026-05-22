# Observability — Worker-side JHSC app

> Phase-0 step 2 (per `workflows/new-project.md` §2). Status: SPEC for T02.
> Owner of next implementation pass: implementer (T02), with verifier
> running the Sentry self-test + canary-PII test as merge gates.
>
> Reading order for any agent touching observability:
> 1. This file.
> 2. `observability/logging.md` (structured-logging contract).
> 3. `observability/sentry-scrub.ts` (the only PI scrubber that ships).
> 4. `observability/audit-log.md` (the tamper-evident first-class data store).
> 5. `observability/alerts.md` (catalogue with runbook links).
> 6. `observability/dashboards.md`.
> 7. `playbooks/runbooks/*` (one per alert).

This document is the contract. If you change anything that affects what
leaves the browser, what hits Sentry, or what becomes an alert, this
file changes in the same PR.

---

## 1. What we observe, and where

| Pillar | Tool | What it sees | Where it lives | Residency | Retention |
|---|---|---|---|---|---|
| **Application errors** | Sentry SaaS (EU region, Frankfurt) | Scrubbed exceptions + breadcrumbs from browser + Edge Functions | sentry.io EU instance | EU (Frankfurt) | 30 days for errors; 7 days for breadcrumb tail; 90 days for releases |
| **Structured app logs** (browser → server) | Supabase Edge Function logs (Supabase native) | Field-allowlisted JSON-line events. No PI. | Supabase `ca-central-1` platform logs | Canada | 7 days on Pro tier (Supabase default); we extract to long-term store only the alert-bearing subset |
| **Structured Edge Function logs** | Supabase Edge Function logs | Field-allowlisted JSON-line events. No PI. No `req.body`. | Supabase `ca-central-1` | Canada | 7 days |
| **Audit log** (first-class data) | Postgres `audit_log` table | Closed-enum, hash-chained, PI-free by schema | Supabase Postgres `ca-central-1` | Canada | **24 months** (per `.context/constraints.md` "Audit logs retained at least 1 year"; we lift to 24 to match PIPEDA breach-record minimum) |
| **Metrics** | Supabase native + a `metrics_counters` Postgres table for app-defined RED/USE counters | Aggregate counters (per-minute buckets). Zero per-user series. | Supabase Postgres `ca-central-1` | Canada | 90 days |
| **Traces** | Deferred to SRE-specialist (Phase 4) | n/a | n/a | n/a | n/a |
| **Backup-bucket config drift** | GitHub Actions weekly job (T17) reading Backblaze B2 admin API | Bucket settings vs spec | GH Actions runner; result row in Postgres `bucket_drift_checks` | Bucket itself is Canada (B2 CA region) | 90 days for the drift result history |

### Stack constraints (non-negotiable, from JHSC-APP-PLAN.md §7)

- **No third-party JS at runtime in the app.** Sentry's SDK is bundled
  with the app (`@sentry/browser` imported and built; we do NOT load
  `https://browser.sentry-cdn.com/...`). Source-maps upload happens at
  build time over a server-side token — the running app does not contact
  Sentry's CDN for any code.
- **Single PI subprocessor beyond Supabase: Sentry.** No other tool
  (Datadog, New Relic, Honeycomb, LogRocket, Posthog cloud, etc.) gets
  added without a fresh ADR + a constraints.md rule-3 human gate. If
  anything in this directory or any downstream agent wants to add one,
  that's a flagged finding for the architect, not an action.
- **Traces are NOT in scope for Phase 0.** OpenTelemetry, custom tracing,
  or distributed-tracing tooling are deferred to the SRE-specialist
  (Phase 4) when there is real traffic + an SLO to defend. The audit-log
  + Sentry + structured logs are sufficient for diagnosis at this scale
  (50 workers, ~12 active members).

### Why traces are deferred (and what that means)

The three-pillars-or-bust default in the orchestrator spec assumes a
service big enough that you can't reason from logs alone. At ~12 active
users and a single tenant, the audit log IS the trace — every meaningful
action is hash-chained, attributed to a pseudonym, and timestamped. The
sre-specialist re-evaluates this when there is steady traffic. Until
then, we do not pay the cost (instrumentation surface, sampling
machinery, vendor — likely a new PI processor) of introducing tracing.

---

## 2. PI scrubbing posture

The rule: **PI is scrubbed at the SDK layer, before the event leaves
the browser or Edge Function.** Query-time scrubbing is never trusted
for PI in this project — someone, eventually, queries raw.

### Three independent scrubbing surfaces

1. **Sentry browser SDK `beforeSend` + `beforeBreadcrumb`** — see
   `observability/sentry-scrub.ts`. This is the load-bearing one for
   client-side errors. PI inventory from `.context/decisions.md`
   §System Design → all listed fields are redacted by key name.
2. **Sentry server SDK (Edge Functions)** — same scrubber module, re-used.
   Same redaction list. Same allowlist of safe extras.
3. **Structured logger (`safeFields` allowlist)** — see
   `observability/logging.md`. The logger only emits fields explicitly
   on the allowlist. The default for any new field is "rejected"; the
   schema fails closed.

All three surfaces share a single canonical PI inventory imported from
`.context/decisions.md` §System Design → "PI inventory" table. If a new
field is added there, the scrubber + logger + audit-log review all need
to update in the same PR.

### What "PI" means here (closed list, by class)

From the PI inventory:

- **C2 personally identifying:** `display_name`, `off_employer_contact`,
  `identity_privkey_recovery_blob`, `training_records.evidence_ct`.
- **C3 sensitive content:** all `*_ciphertext` / `*_ct` columns
  (concerns body, minutes draft + final, recommendations, inspections
  notes, recommendations responses). Even the ciphertext shape is
  PI-adjacent (size oracle); we redact field NAMES that match these
  patterns, not just values.
- **C4 highest sensitivity:** `source_name_ciphertext`,
  `reprisal_log.body_ciphertext`, `work_refusal.notes_ciphertext`,
  `s51_evidence.*_ciphertext`. Any appearance of any of these field
  names in an error event triggers a **P0** incident, not just a
  redaction — see `playbooks/runbooks/sentry-self-test-failed.md` for
  the "C4 plaintext seen in stack trace" branch. The scrub config drops
  the entire event in that case, not just the field.
- **Auth material:** Authorization headers, cookies, JWTs, TOTP codes
  (during T05 bootstrap window), passkey assertions / credentials,
  recovery passphrases. These are stripped at the SDK; if they appear,
  also flag as P0.
- **URLs that imply concern / reprisal / inspection paths:** `/concerns/*`,
  `/reprisal/*`, `/work-refusal/*`, `/s51/*`, `/inspections/*/photos/*`.
  Any breadcrumb URL matching these is dropped (route name kept; path +
  query stripped).

### Identifier handling (no `Sentry.setUser`)

ADR-0010 says no `Sentry.setUser`. We additionally compute an
**actor_pseudonym** at the SDK layer, BEFORE anything leaves the
browser, for the structured logger and audit-log emission paths:

```
actor_pseudonym = HMAC-BLAKE2b-256(
  key   = HMAC_PSEUDONYM_KEY,                  // server-only, 32 bytes
  msg   = supabase_auth.uid bytes
) -> hex-truncated to 16 chars
```

`HMAC_PSEUDONYM_KEY` lives only in the Edge Function environment —
the browser does NOT have it, which means the browser cannot derive
the pseudonym itself. For browser-emitted Sentry events the user
identifier field is **omitted entirely** (the original ADR-0010
direction). For server-emitted events the pseudonym is allowed in the
`user.id` field only.

The pseudonym is NOT reversible by anyone with Sentry access alone.
Reversal requires the server-side HMAC key AND the candidate `uid`
list — i.e., requires platform-level access on top of Sentry access.

### Size threshold

The Sentry `beforeSend` rejects any event whose JSON serialization
exceeds **15 KB**. An accidental dump of a form body, an Edge Function
that included `req.body`, or a stack trace carrying serialized state
will all trip this. The fixture proves it.

### No breadcrumbs of `xhr` / `fetch` to sensitive paths

Even with PI scrubbed from query strings, the *existence* of a request
to `/api/reprisal/123` is itself C1-adjacent (it leaks that user X read
reprisal entry 123 at time T). The breadcrumb hook drops the entire
breadcrumb if its category is `xhr` or `fetch` and its URL matches the
sensitive-path regex.

---

## 3. Logging contract (summary; full in `observability/logging.md`)

- One JSON-line per event.
- Required fields: `ts` (ISO-8601 UTC), `level`, `service`, `env`,
  `release`, `request_id`, `actor_pseudonym?` (server-side only),
  `route`, `outcome`, `latency_ms?`, `event`, `attributes?` (allowlisted).
- Forbidden fields (the logger drops them silently AND emits a CI-visible
  WARN on the build): everything in §2 "What 'PI' means here".
- `safeFields` allowlist in `apps/web/src/lib/log/safe-fields.ts` — every
  attribute key must be on the list; unknown keys are dropped.

---

## 4. Audit log (summary; full in `observability/audit-log.md`)

- **First-class app data**, NOT in Sentry, NOT in Edge Function logs.
- Postgres `audit_log` table, hash-chained per ADR-0003 Amendment A.
- Closed enum (~24 values today). Adding a value requires an architect
  amendment to ADR-0003 Amendment A.
- RLS: members SELECT; INSERT only via `SECURITY DEFINER` functions
  owned by `audit_writer_role` or `c4_read_service`; UPDATE and DELETE
  are revoked from every role except the retention service role
  (T16) operating on age-out only.
- Hash-chain integrity is checked by the T18 daily job + on every
  rotation + on every export — see F-50, alert wired in `alerts.md`.

---

## 5. Alerts (catalogue in `observability/alerts.md`)

| Severity | Definition | Routing |
|---|---|---|
| **P1** | Wake the incident-responder. Integrity broken or platform-down. | Sentry → email + (optional) phone to the on-call contact. The contact is configured in `.env`; no contact list in repo. |
| **P2** | Next business hour. Suspected misuse or degraded function. | Sentry → email; recorded in `audit_log` as `alert.fired`. |
| **P3** | Backlog. Cost / dependency / drift trend. | Weekly digest email. |

**Every alert has a runbook.** No alert ships without
`playbooks/runbooks/<alert-id>.md`. See `alerts.md` for the table.

---

## 6. Dashboards (summary; full in `observability/dashboards.md`)

Nine dashboards, all read from Postgres views (no third-party
dashboarding tool — that'd be another PI processor):

1. Auth health.
2. Concern intake throughput (counts only; no content).
3. Export feed (every export, concern-derived flag visible).
4. Sensitive-read feed (every C4 access; the HG-6 surface).
5. Sync health (HMAC pass/fail; queue depth).
6. Audit-log integrity (last successful chain check; time-since).
7. Backup health (last successful backup, last restore drill,
   bucket-config drift status).
8. Sentry error volume (P1/P2/P3 buckets; trend).
9. Cost dashboard (Supabase + Sentry + B2 monthly; rolling 3 months).

Dashboards are SvelteKit pages under `/internal/observability/*` (only
visible to active members; gated by RLS). Configs (queries) live in-repo
under `apps/web/src/routes/internal/observability/`, version-controlled.

---

## 7. SLO scaffolding (placeholder, not a claim)

**No SLOs are claimed in Phase 0.** Phase 0 wires the *measurement
substrate* so the SRE-specialist (Phase 4) can later set SLOs with
real baselines.

The placeholder shape, for whoever fills this in later:

```
Service:        worker-side-jhsc-app
SLO candidates:
  - Auth re-auth latency p95 < 2000 ms (after T05 ships, 90 days of data)
  - Concern create end-to-end p95 < 3000 ms (after T08, 90 days)
  - Export render-to-download p95 < 5000 ms (after T11, 90 days)
  - Audit-log chain integrity check completes < 60 s (after T18)
Error budget:   to be defined by SRE-specialist
Burn-rate alerts: deferred
```

Until the SRE-specialist has 90 days of real production data, anything
that smells like an "SLO" in this repo is a target, not a contract. The
alert catalog (`alerts.md`) holds the explicit operational alerts; it
does NOT yet hold error-budget burn alerts.

---

## 8. Cost posture

From `.context/decisions.md` "Capacity and cost sketch":

- Sentry SaaS Team plan, EU residency: ~$26 USD / month. 50k events /
  month is the included quota. At our scale we expect well under 5k
  events / month in steady state. **If we breach 25k in a month, that's
  itself a P2 alert** (`sentry.event_volume_burst` — see `alerts.md`).
- Supabase Pro: ~$25 USD / month (covers DB, logs, Edge Function
  invocations).
- Backblaze B2: <$1 / month for backups.
- **Total observability cost ceiling at v1: ~$30 USD / month**
  (Sentry + the B2 fraction; everything else lives inside the existing
  Supabase tier).

Anything that would push us over the Sentry Team tier ($26 → next tier)
in steady state is a flag to the cost-manager, not an autonomous
upgrade.

---

## 9. Handoff (Phase-0 → Phase-1/2)

### For the test-writer (next in line)

The test-writer reads:

1. `.context/threat-model.md` §8 (test obligations per task ID).
2. `observability/alerts.md` (this directory) — the alert catalog gives
   the *behavioural contracts* the tests verify (the audit emission
   contract, the integrity-break detection-time SLO, the canary scrub
   contract).
3. `observability/audit-log.md` — the closed enum and the schema. Tests
   on T07, T08, T11/T12, T13, T16, T18 all verify against this.
4. `observability/sentry-scrub.ts` — the fixture + test file at the
   bottom of that module is the spec for the canary-PII test gate.

Specifically these test artifacts must exist before the implementer
touches the corresponding task:

- **T02 (this work):** scrub fixture tests (already shipped in
  `sentry-scrub.ts`), structured-logger contract tests, audit-log
  closed-enum tests, Sentry self-test runbook.
- **T05:** auth failure burst alert wiring; passkey-without-TOTP-removal
  alert; the `auth.passkey.enrolled` / `auth.passkey.revoked` /
  `session.revoked` audit emissions.
- **T07:** the 8 key-material enum emissions (HG-2 / Invariant 8),
  alerts on enum gaps within 5 min, the F-50 chain-integrity alert.
- **T08:** `concern.created` audit emission; rate-limit metric +
  alert; intake-throughput dashboard.
- **T10:** `queue.integrity_fail` alert wiring (HG-4);
  `client.cache_policy_violation` alert wiring (HG-3);
  `inspection.synced` / `inspection.synced.hmac_fail` audit emissions.
- **T11/T12:** `export.generated` audit emission with
  `derived_from_concerns?` and `recipient_role` (RA-1); export feed
  dashboard; post-export rep notification surface.
- **T13:** server-emitted `reprisal.read` from `SECURITY DEFINER` view
  (HG-6); 4-eyes `reprisal.status_changed.4eyes_*` emissions.
- **T16:** `retention.deleted` summary emission (one per pass);
  retention-job-failure alert.
- **T17:** backup-bucket config drift alert wiring (HG-8); backup
  freshness alert.
- **T18:** the audit-log integrity check job that backs the F-50 alert,
  the recent-sensitive-activity feed (HG-6 + RA-1 surface).

### For the deployer (Phase 3)

Post-deploy verification dashboards:
- **Auth health** — passkey enrollment success rate, session revocations.
- **Sentry error volume** — within 1 hour after deploy, error rate
  should not exceed the pre-deploy 7-day median + 50%.
- **Sentry self-test** — within 5 min after deploy, the synthetic error
  must appear in Sentry and prove the scrub pipeline is alive.
- **Audit-log integrity** — chain check status green.

### For the release-manager

Rollout-gating signals:
- `client.cache_policy_violation` count must be 0 in canary window.
- `queue.integrity_fail` count must be 0 in canary window.
- Sentry self-test green.
- No P1 alerts firing.

### For the incident-responder

- `playbooks/runbooks/` — every alert has a stub here.
- `playbooks/incident-response.md` (existing pack file) — overarching
  process; runbook stubs link back to it.
- Correlation: a Sentry event → `request_id` → Edge Function log line
  → audit-log row (if a state change). The `request_id` is the common
  key across all three.

---

## 10. Findings surfaced (not actions taken)

These came up while writing this contract. They are notes for the
architect / threat-modeler / test-writer to follow up on. Nothing here
was modified in `.context/`.

1. **F-09 has no Edge Function logging spec yet.** The threat model
   requires the canary-plaintext test on Edge Function logs, but the
   *structured-logger contract for Edge Functions* is not in any ADR.
   This document writes it (`observability/logging.md` §4); the
   architect should ratify it next ADR pass — current treatment is
   "applies until contradicted".
2. **Audit-log retention is at the floor.** `constraints.md` requires
   "at least 1 year"; the architect specified 24 months. Phase-3
   privacy-reviewer should confirm 24 months is right given the OHSA
   limitation profile of the audit content (not the C3/C4 content,
   which is on the 7y schedule).
3. **No tracing means no distributed-request correlation across
   Supabase Edge Function → Postgres if a query slows down.** Acceptable
   at v1 scale; flag for the SRE-specialist's intake in Phase 4.
4. **The post-export rep notification window (60 s, per RA-1) is not
   yet a measured signal.** The notification firing is in the alert
   catalog, but the "notification arrived within 60 s" SLI is not
   measurable until T18 ships and the surface is live. Test-writer
   should write the integration test that establishes the measurement
   pipeline; baseline goes to the SRE-specialist.

---

## 11. Verification — how the implementer proves this is wired

See "Verification" at the end of this whole bundle (returned as the
final list to the parent agent). Each item below maps to a test
the implementer/test-writer must produce as part of T02.

1. **Synthetic error → Sentry**. Trigger a synthetic error in the
   browser, scoped by a build-time `SENTRY_SELFTEST=1` env. Verify a
   scrubbed event appears in Sentry within 5 minutes. The runbook
   `playbooks/runbooks/sentry-self-test-failed.md` covers the failure
   branches.
2. **Canary PI never appears in Sentry**. Submit a known canary
   (`CANARY_PII_X` for free-text fields; a synthetic phone-shaped
   string for contact fields; a libsodium-private-key-shape 32-byte
   sequence per Invariant 1 strengthened). Trigger an error along that
   code path. Capture the in-process Sentry transport payload (mocked
   in test). Grep for the canary; assert absent.
3. **Edge Function canary**. Same canary via Edge Function path
   (F-09): capture Supabase function logs; assert canary absent.
4. **Structured logger drops unknown fields**. Pass a log call with a
   field not on `safeFields`; assert the output JSON does NOT contain
   the field AND that the test environment emits a WARN to CI.
5. **Audit-log enum is closed**. Try to INSERT an audit row with an
   action string not in the enum; assert Postgres rejects (`CHECK`
   constraint).
6. **Audit-log chain integrity break is detected within 5 minutes**.
   Corrupt one row's `body_hash`; trigger the next scheduled or
   trigger-bound check; assert the alert fires within 5 min (per F-50).
7. **C4 read via SECURITY DEFINER writes audit in same transaction**
   (HG-6). Read a row through `reprisal_log_read_audited`; assert
   exactly one `reprisal.read` audit row appears with same-txn
   timestamp. Induce audit-INSERT failure; assert the SELECT rolls
   back.
8. **Audit-log UPDATE/DELETE is denied at RLS** for any role except
   the retention service role on age-out rows.
9. **Sentry scrubber drops oversized events**. Build a synthetic
   exception whose serialized form > 15 KB. Trigger; assert the
   `beforeSend` returned `null`.
10. **Sentry breadcrumb hook drops sensitive-path xhr/fetch**.
    Programmatically push a breadcrumb of category `fetch` with URL
    `/api/reprisal/123`; trigger an error; assert the breadcrumb is
    absent from the captured payload.
11. **Pseudonym is not reversible client-side**. The browser bundle
    must NOT contain `HMAC_PSEUDONYM_KEY`. CI test: grep the built
    bundle for the env var name or any 32-byte high-entropy literal
    matching the key.
12. **Backup-bucket drift check produces an alert when settings
    drift** (HG-8). Mutate the bucket config in a scratch project;
    run the weekly drift job; assert alert fires.
