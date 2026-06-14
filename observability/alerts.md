# Alert catalogue — Worker-side JHSC app

> Phase-0 spec. The implementer of T02 / T07 / T10 / T17 / T18 wires
> these in. Every alert has a runbook at
> `docs/runbooks/<alert-id>.md` — no alert ships without one.
>
> Source for each alert is stated explicitly. If you add an alert,
> you also add a runbook in the same PR.

Severity definitions (full posture in `observability/README.md` §5):

- **P1** — wake the incident-responder. Integrity broken or service down.
- **P2** — next business hour. Suspected misuse or degraded function.
- **P3** — backlog. Cost / dependency / drift trend.

Routing legend:
- **inc-responder** — primary on-call contact (configured in `.env`,
  not in repo); pager + email.
- **co-chair** — worker co-chair contact (`.env`); email only.
- **digest** — weekly digest email to the co-chair.

---

## 1. Catalogue (every alert)

| ID | Name | Trigger (concrete condition) | Severity | Routing | Runbook | Source |
|---|---|---|---|---|---|---|
| `A-AUDIT-001` | Audit-log integrity break | Daily T18 hash-chain check OR post-rotation OR post-export trigger detects `prev_hash` mismatch on any row. Alert fires within **5 minutes** of any of these triggers. | **P1** | inc-responder + co-chair | [`docs/runbooks/A-AUDIT-001.md`](../docs/runbooks/A-AUDIT-001.md) | F-50 / T18 |
| `A-KEY-ROT-001` | Key-rotation enum gap | A row with `event_type = committee_data_key.rotation.started` exists with no matching `.completed` row sharing the same `rotation_id` within **30 seconds**. (Architect spec says 5 min; we tighten to 30s to surface stalled rotations faster — a healthy rotation completes in seconds.) Also: any `committee_data_key.member_revoked` without a paired `.completed` in the same `rotation_id`; any `committee_data_key.wrapped_for_member` for a `target_member_id` that is not `committee_membership.active = true` at emission. | **P1** | inc-responder + co-chair | `docs/runbooks/key-rotation-enum-gap.md` | HG-2 / ADR-0003 Amendment A / F-07 / T07 + T18 |
| `A-QUEUE-001` | `queue.integrity_fail` (HMAC mismatch) | Any audit-log row with `event_type = inspection.synced.hmac_fail` AND the row's `meta` shows the entry was rejected on drain. Per-occurrence alert (no rate threshold — a single forged queue entry matters). | **P2** | inc-responder | `docs/runbooks/queue-integrity-fail.md` | HG-4 / ADR-0014 / F-44 / T10 |
| `A-SW-001` | `client.cache_policy_violation` (service-worker sanity-check trip) | Any audit-log row with `event_type = client.cache_policy_violation`. Per-occurrence (the sanity check should never trip in steady state). | **P2** | inc-responder | `docs/runbooks/cache-policy-violation.md` | HG-3 / ADR-0013 / F-10 / T10 |
| `A-BACKUP-001` | Backup object still locked past 42d window (M9 dispatch) **+** legacy: backup-bucket config drift (CI job) | M9: the 42-day backup-retention pass tried to hard-delete an object but the object-lock had not yet expired (F-75 cooperative-caller defense). **Legacy reading (CI bucket-config drift) is retained for the weekly CI gate**; the on-call routing distinguishes by `alert.source` (`backup` for the M9 runtime path vs the CI workflow's own structured-log event for the bucket-drift path). | **P1** (M9) / **P2** (legacy) | inc-responder + co-chair | [`docs/runbooks/A-BACKUP-001.md`](../docs/runbooks/A-BACKUP-001.md) | M9 / HG-8 / ADR-0018 §J / F-75 |
| `A-BACKUP-002` | Backup freshness | No `backup.completed` event in the last **36 hours**. | **P1** | inc-responder | `docs/runbooks/backup-bucket-config-drift.md` (shares triage) | T17 |
| `A-C4-FEED` | Sensitive (C4) read live feed | NOT an alert per se — a continuously updated dashboard surface that lists every `reprisal.read`, `work_refusal.read`, `s51_evidence.read` row in the last 30 days. Surfaces in the app's "recent sensitive activity" tab for all active members. Alert fires only if the surface itself stops updating for > 1 hour (the feed pipeline died). | **P2** (feed stalled) | inc-responder | `docs/runbooks/sensitive-read-spike.md` | HG-6 / ADR-0003 Amendment B / F-33 / T13 + T18 |
| `A-C4-001` | Sensitive-read burst | More than **10 `reprisal.read` events from one `actor_pseudonym` in a 5-minute window**, OR more than **30 across the committee in 1 hour**. Co-chair-only surface; not visible to the actor. | **P2** | co-chair | `docs/runbooks/sensitive-read-spike.md` | F-30 / F-33 / T13 |
| `A-EXPORT-001` | Export PDF generated (live feed + audit landed) | NOT an alert — a continuously updated dashboard tile + a post-export rep notification per RA-1. The alert variant fires if an `export.generated` audit row appears WITHOUT a matching `export.contained_concern_derived_items` row when `derived_from_concerns?` would be non-empty, OR if the export-to-audit-write transaction split (per F-24, audit must succeed BEFORE the Blob URL). | **P2** | inc-responder + co-chair | `docs/runbooks/export-anomaly.md` | RA-1 / F-19 / F-24 / F-32 / T11 + T12 |
| `A-EXPORT-002` | Export rate spike | More than **5 export.generated** in 1 hour (the rate-limit is 10/hour per F-28; this fires at 50% of that). | **P2** | co-chair | `docs/runbooks/export-anomaly.md` | F-28 / T11 |
| `A-AUTH-001` | Auth failure burst | More than **N = 10 auth failures in M = 5 minutes** from one IP (truncated to /24) OR from one `actor_pseudonym`. | **P2** | inc-responder | `docs/runbooks/auth-failure-burst.md` | T05 / T8 (enumeration) / F-40 / F-42 |
| `A-AUTH-002` | Passkey enrollment without TOTP-bootstrap-removal | An `auth.passkey.enrolled` audit row exists for a user without a corresponding `users.totp_destroyed_at` timestamp set in the same transaction. (Per ADR-0002 / F-43 the TOTP secret must be destroyed atomically.) | **P2** | inc-responder | `docs/runbooks/auth-failure-burst.md` (shares triage; the runbook has a dedicated section) | T05 / F-43 |
| `A-DEP-001` | High-severity dependency CVE on `main` | `npm audit --audit-level=high` reports any high-or-critical advisory on `main`. Blocks deploy via the verifier integration. | **P2** | inc-responder + co-chair | `docs/runbooks/A-DEP-001.md` (TBD; separate runbook from auth-failure-burst) | constraints.md vuln-mgmt; runbook not in `docs/runbooks/` yet — **stub at `docs/runbooks/A-DEP-001.md`** |
| `A-SENTRY-001` | Sentry self-test failed | Synthetic error tagged `sentry.selftest=1` emitted at startup of every deploy MUST appear in Sentry within **5 minutes**. If it doesn't, this alert fires (via a Postgres job that compares a known startup-emitted row with Sentry's Issues API). Also fires if the scrubber's `PanicSink` was invoked at any point in the last hour (canary survived, C4 key seen, or oversized event dropped). | **P1** | inc-responder | `docs/runbooks/sentry-self-test-failed.md` | T02 / ADR-0010 |
| `A-RETENTION-001` | Retention job failure | (a) Watchdog: no `retention.deleted` audit row in the last 26h. (b) M9-dispatched: a pass returned with `alarm_fired: true` (per-table delete count exceeded `alarm_threshold`, default 20 per F-57) — either pre-delete abort or operator-confirmed completion. | **P1** | inc-responder + co-chair | [`docs/runbooks/A-RETENTION-001.md`](../docs/runbooks/A-RETENTION-001.md) | M9 / T16 / F-57 |
| `A-SENTRY-002` | Sentry event volume burst | Sentry events received > **25k in the rolling month** (50% of the Team-tier 50k included). | **P3** | digest + cost-manager | not stubbed in this pass — cost-manager owns | T02 / cost posture |
| `A-COST-001` | Monthly cost projection > $80 USD | Cost dashboard's 3-month rolling projection crosses $80 USD (steady-state baseline is ~$54). | **P3** | digest + cost-manager | not stubbed in this pass — cost-manager owns | capacity sketch |
| `A-INTEGRITY-001` | Integrity-check watchdog — no successful pass in window | The M9.B watchdog probe (`apps/web/src/lib/audit-integrity/watchdog.ts`) finds no `integrity_check_runs` row with `status='ok'` newer than `nowMs - WATCHDOG_DEFAULT_WINDOW_MS` (default 9h = 2× the 4:30 ET daily cadence + slack). Fires once per watchdog tick that stays no-recent-pass. | **P1** | inc-responder | [`docs/runbooks/A-INTEGRITY-001.md`](../docs/runbooks/A-INTEGRITY-001.md) | M9.B / ADR-0019 §3 |
| `A-INTEGRITY-002` | Integrity-check unattributable reconcile | The audit-integrity pass found at least one mismatch the runner could NOT attribute to a known retention sweep (`unattributable_count > 0` on the result). Fires alongside `A-AUDIT-001` when both apply. | **P2** | inc-responder | [`docs/runbooks/A-INTEGRITY-002.md`](../docs/runbooks/A-INTEGRITY-002.md) | M8.B / ADR-0019 §3 |

### Counts

- **P1: 7** (audit integrity break, key-rotation enum gap, backup freshness, sentry self-test, retention job failure(a), integrity-check watchdog, …)
- **P2: 10** (+ A-INTEGRITY-002)
- **P3: 2**

(Approximate; the table above is the truth — counted for the
self-validation handoff back to the parent agent.)

### Severity ↔ M9 dispatch mapping

The M9 dispatch infrastructure (`apps/web/src/lib/alerts/dispatch.ts`,
M9 PR landed) uses three closed severities — `page` / `warn` / `info`
— that map onto the P1/P2/P3 ladder for the runbook routing tables
above:

| dispatch.ts severity | catalogue severity | routing default |
|---|---|---|
| `page` | P1 | inc-responder + co-chair |
| `warn` | P2 | inc-responder (work-day) |
| `info` | P3 | digest |

The current closed `AlertSymbol` union surfaces 5 symbols against
this catalogue (the §6 dispatch table maps them).

---

## 2. How each alert lands

Three transport paths:

1. **Postgres trigger → email.** The audit-log + integrity-check pipeline
   runs entirely in Supabase. A small `alerts` table receives a row when
   any condition above trips. A `pg_cron` job (`alert_dispatcher`)
   reads the table, sends email via Supabase's built-in SMTP, and marks
   the row `dispatched`. P1 events also write to a `pager_queue` table
   that a separate phone/SMS provider (out of scope for this pass; user
   chooses provider as part of incident-responder setup) picks up.
2. **Sentry-native alerts.** Sentry has its own alert rules for client-
   side error volume / regression. These fire only for genuine
   application errors — they are NOT used for any audit-derived signal
   (audit signals never leave the database).
3. **CI alerts.** The dependency-CVE alert and the bundle-grep alerts
   fire from GitHub Actions runs — they post a comment on the PR and
   the workflow exit code blocks merge. No external transport.

---

## 3. Why these thresholds (and not silence-by-default)

Default-silent alerting is an anti-pattern called out in the
observability-engineer spec. The defaults here come from:

- **F-50** explicitly requires "alerts within 5 minutes" for chain
  corruption.
- **RA-1** explicitly requires "within 60 seconds" for the post-export
  notification — implemented as the live feed surface, not as a paged
  alert.
- **F-42** lists `<= 10 WebAuthn attempts/user/minute` as the rate-limit
  floor — the auth-failure-burst threshold (10 in 5 min) is well under
  the rate limit, which is intentional: this surfaces the attempt
  pattern that gets *close to* the limit, not just the bounce.
- **HG-2 / Invariant 8 / Amendment A** lists the exact conditions for
  the key-rotation enum-gap alert. We tightened the 5-min rotation
  completion window to 30 s on the theory that a real rotation
  completes in seconds; the architect's 5-min window is for the
  *integrity job's detection window*, which we honour separately
  (A-AUDIT-001).
- **HG-8 / ADR-0012 amendment** specifies the bucket-drift weekly
  check; we add backup freshness (A-BACKUP-002) as a sibling because
  a fresh backup with the right config is the real success signal.

If you're tempted to silence one of these "for now", read
`observability/README.md` §10 and `docs/runbooks/<alert>.md`
first. Most of these alerts catch conditions the threat model says
will cost us PIPEDA notification obligations if they go undetected.

---

## 4. What we explicitly do NOT alert on

- **Per-user activity.** The "recent sensitive activity" feed surfaces
  every C4 read to every active member; that's the social-norm signal.
  No paged alert on "user X did 5 reprisal reads" — the threshold-
  bursts (A-C4-001) handle the misuse case.
- **General service availability.** Supabase has its own status page;
  duplicating that here adds noise. Backup freshness + audit-integrity
  + sentry-self-test together cover the "is anything wired alive"
  question.
- **Free-form latency.** §7 below carries the closed SLO list — only
  flows the threat-model / ADRs name explicitly get an SLO row. Other
  latency stays on the dashboard surface; it does not page.

---

## 5. Test obligations (handoff to test-writer)

Each alert needs an integration test that proves:

1. The trigger fires under the named condition.
2. The trigger does NOT fire under near-miss conditions (e.g.,
   `A-AUTH-001` does NOT fire on 9 failures in 5 min).
3. The alert routing reaches the configured transport (test uses a
   mock transport).
4. The runbook is linked from the alert payload (a `runbook_url` field
   in the `alerts` row).

The threat-model.md §8 obligations per task ID map onto these as
follows:

- T07 + T18: `A-AUDIT-001`, `A-KEY-ROT-001`.
- T10: `A-QUEUE-001`, `A-SW-001`.
- T11 + T12: `A-EXPORT-001`, `A-EXPORT-002`.
- T13: `A-C4-001`, `A-C4-FEED` (feed-stalled variant).
- T17: `A-BACKUP-001`, `A-BACKUP-002`.
- T16: `A-RETENTION-001`.
- T05: `A-AUTH-001`, `A-AUTH-002`.
- T02 (this pass): `A-SENTRY-001` (the self-test that proves the
  whole pipeline is alive).

Test-writer takes this list + `audit-log.md` (closed enum + schema)
+ `sentry-scrub.ts` (fixture) as the spec for T02, T05, T07, T08, T10,
T11, T12, T13, T17, T18.

---

## 6. M9 dispatch infrastructure (`apps/web/src/lib/alerts/`)

The catalogue above is the spec; this section documents the
production-time dispatch path that turns library results into routed
alerts.

### Closed `AlertSymbol` union

The TS-side union (`apps/web/src/lib/alerts/dispatch.ts`) is the
authoritative shipping list. Adding a new symbol requires the same
M9 four-step:

1. Extend the `AlertSymbol` union.
2. Extend the `ALERT_SEVERITY` closed table (page/warn/info).
3. Add a runbook stub at `docs/runbooks/A-<NAME>.md`.
4. Add a catalogue row in §1 above + the dispatch row below.

### `AlertSymbol` ↔ catalogue row + adapter

| AlertSymbol | Catalogue row | Adapter | Source library |
|---|---|---|---|
| `A-RETENTION-001` | A-RETENTION-001 (P1) | `dispatchRetentionAlerts(result, ts_ms)` | `lib/retention` (`alarm_fired` on result) |
| `A-BACKUP-001` | A-BACKUP-001 (P2 in legacy spec — surface re-uses ID; the M9 dispatch wires the F-75 still-locked path at `page` severity) | `dispatchBackupRetentionAlerts(result, ts_ms)` | `lib/backup` (`would_fire_alert: 'A-BACKUP-001'` on retention pass) |
| `A-AUDIT-001` | A-AUDIT-001 (P1) | `dispatchIntegrityAlerts(result, ts_ms)` | `lib/audit-integrity` (`would_fire_alert` array entry) |
| `A-INTEGRITY-001` | A-INTEGRITY-001 (P1) | `dispatchWatchdogAlerts(result, ts_ms)` | `lib/audit-integrity/watchdog` (`status: 'no_recent_pass'`) |
| `A-INTEGRITY-002` | A-INTEGRITY-002 (P2) | `dispatchIntegrityAlerts(result, ts_ms)` (same adapter, separate symbol in `would_fire_alert` array) | `lib/audit-integrity` (`unattributable_count > 0`) |

### Transport

`StructuredLogAlertSink` is the default production wiring. Each fire
becomes one structured-log line:

- `event: 'alert.fired'`
- `attributes.alert.symbol`, `attributes.alert.severity`,
  `attributes.alert.source`, `attributes.alert.ts_ms`, plus
  adapter-composed structural meta (`alert.run_id`,
  `alert.outcome`, etc. — see `lib/log/safe-fields.ts` for the
  closed list).

The on-call surface (PagerDuty bridge / Sentry issue alert /
pg_cron probe) picks up by `event: 'alert.fired'` and routes by
`attributes.alert.severity`. The runbook link is `docs/runbooks/<attributes.alert.symbol>.md`.

### PI defense

Three layers:

1. **Adapter discipline.** Adapters in
   `apps/web/src/lib/alerts/result-adapters.ts` compose meta from
   structural ids + counts ONLY. The M9 PI-canary vitest asserts
   no PI-shaped key (email / phone / passphrase / totp_code / etc.)
   ever appears in any adapter's meta.
2. **`SAFE_FIELDS` allowlist.** The structured logger drops any
   field not on the closed allowlist (both browser + edge
   surfaces; the structural drift test asserts parity).
3. **Sentry beforeSend scrubber.** If `StructuredLogAlertSink` is
   ever swapped to a sink that routes via Sentry, the beforeSend
   path re-runs the PI scrub (`observability/sentry-scrub.ts`).

---

## 7. Service-level objectives (SLOs)

The closed list of load-bearing flows the threat-model / ADRs name
with an explicit SLO. SLO breach is observed via dashboards; the
"sustained breach" condition is what fires the matching alert.

| SLO | Target | Window | Breach signal | Alert |
|---|---|---|---|---|
| Session-revocation propagation | ≤ 5s from `auth_sessions.revoked_at` to next privileged op returning 401 | per-op (rolling) | F-39: any privileged op that mints under a revoked session beyond the 5s grace fires `A-AUDIT-001`-class via the mint-session race detector (`auth.mint.revoked_during_mint` event) | (covered by `A-AUDIT-001` + the ADR-0023 Amendment A F-128 mint-session race detector audit row) |
| Retention sweep daily-pass success | one `retention.deleted` row in `audit_log` per ≤ 26h window | 26h | `A-RETENTION-001` (a) | `A-RETENTION-001` (a) — P1 |
| Audit-integrity weekly anchor | one `audit.chain_anchor.weekly` row per ≤ 8 days | 8d | the M8.B emit fn writes the row + the off-app email; absence fires `A-INTEGRITY-001`-adjacent via the watchdog (extended window) | `A-INTEGRITY-001` (watchdog) |
| Integrity-check pass cadence | one `integrity_check_runs` row with `status='ok'` per ≤ 9h | 9h | `WATCHDOG_DEFAULT_WINDOW_MS = 9 * 60 * 60 * 1000` in `apps/web/src/lib/audit-integrity/watchdog.ts` | `A-INTEGRITY-001` — P1 |
| Export fanout (post-export rep notification) | p95 ≤ 60s from `export.generated` audit row to feed entry visible | 60s | RA-1 / F-30 / F-32 budget; dashboard surface, no page (surface stalled > 1h fires `A-C4-FEED`) | (covered by `A-C4-FEED`) |
| Backup freshness | one `backup.manifest_written` audit row per ≤ 36h | 36h | `A-BACKUP-002` (legacy catalogue) | `A-BACKUP-002` — P1 |

The numbers above come from the threat-model + ADR text verbatim;
the architect re-ratifies them only on explicit ADR amendment (the
SLO breach is the gate, not the SLO number itself). Adding a new
SLO requires the same four-step as adding an alert symbol — there
is no "soft" SLO that operators can adjust ad-hoc.
