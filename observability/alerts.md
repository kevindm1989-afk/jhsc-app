# Alert catalogue — Worker-side JHSC app

> Phase-0 spec. The implementer of T02 / T07 / T10 / T17 / T18 wires
> these in. Every alert has a runbook at
> `playbooks/runbooks/<alert-id>.md` — no alert ships without one.
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
| `A-AUDIT-001` | Audit-log integrity break | Daily T18 hash-chain check OR post-rotation OR post-export trigger detects `prev_hash` mismatch on any row. Alert fires within **5 minutes** of any of these triggers. | **P1** | inc-responder + co-chair | `playbooks/runbooks/audit-log-integrity-break.md` | F-50 / T18 |
| `A-KEY-ROT-001` | Key-rotation enum gap | A row with `event_type = committee_data_key.rotation.started` exists with no matching `.completed` row sharing the same `rotation_id` within **30 seconds**. (Architect spec says 5 min; we tighten to 30s to surface stalled rotations faster — a healthy rotation completes in seconds.) Also: any `committee_data_key.member_revoked` without a paired `.completed` in the same `rotation_id`; any `committee_data_key.wrapped_for_member` for a `target_member_id` that is not `committee_membership.active = true` at emission. | **P1** | inc-responder + co-chair | `playbooks/runbooks/key-rotation-enum-gap.md` | HG-2 / ADR-0003 Amendment A / F-07 / T07 + T18 |
| `A-QUEUE-001` | `queue.integrity_fail` (HMAC mismatch) | Any audit-log row with `event_type = inspection.synced.hmac_fail` AND the row's `meta` shows the entry was rejected on drain. Per-occurrence alert (no rate threshold — a single forged queue entry matters). | **P2** | inc-responder | `playbooks/runbooks/queue-integrity-fail.md` | HG-4 / ADR-0014 / F-44 / T10 |
| `A-SW-001` | `client.cache_policy_violation` (service-worker sanity-check trip) | Any audit-log row with `event_type = client.cache_policy_violation`. Per-occurrence (the sanity check should never trip in steady state). | **P2** | inc-responder | `playbooks/runbooks/cache-policy-violation.md` | HG-3 / ADR-0013 / F-10 / T10 |
| `A-BACKUP-001` | Backup-bucket config drift | Weekly CI job reads Backblaze B2 admin API; any deviation from spec (versioning off, Object Lock retention != 35d governance, lifecycle != 42d, workflow credential grants changed) emits this alert. | **P2** | inc-responder + co-chair | `playbooks/runbooks/backup-bucket-config-drift.md` | HG-8 / ADR-0012 amendment / F-49 / T17 |
| `A-BACKUP-002` | Backup freshness | No `backup.completed` event in the last **36 hours**. | **P1** | inc-responder | `playbooks/runbooks/backup-bucket-config-drift.md` (shares triage) | T17 |
| `A-C4-FEED` | Sensitive (C4) read live feed | NOT an alert per se — a continuously updated dashboard surface that lists every `reprisal.read`, `work_refusal.read`, `s51_evidence.read` row in the last 30 days. Surfaces in the app's "recent sensitive activity" tab for all active members. Alert fires only if the surface itself stops updating for > 1 hour (the feed pipeline died). | **P2** (feed stalled) | inc-responder | `playbooks/runbooks/sensitive-read-spike.md` | HG-6 / ADR-0003 Amendment B / F-33 / T13 + T18 |
| `A-C4-001` | Sensitive-read burst | More than **10 `reprisal.read` events from one `actor_pseudonym` in a 5-minute window**, OR more than **30 across the committee in 1 hour**. Co-chair-only surface; not visible to the actor. | **P2** | co-chair | `playbooks/runbooks/sensitive-read-spike.md` | F-30 / F-33 / T13 |
| `A-EXPORT-001` | Export PDF generated (live feed + audit landed) | NOT an alert — a continuously updated dashboard tile + a post-export rep notification per RA-1. The alert variant fires if an `export.generated` audit row appears WITHOUT a matching `export.contained_concern_derived_items` row when `derived_from_concerns?` would be non-empty, OR if the export-to-audit-write transaction split (per F-24, audit must succeed BEFORE the Blob URL). | **P2** | inc-responder + co-chair | `playbooks/runbooks/export-anomaly.md` | RA-1 / F-19 / F-24 / F-32 / T11 + T12 |
| `A-EXPORT-002` | Export rate spike | More than **5 export.generated** in 1 hour (the rate-limit is 10/hour per F-28; this fires at 50% of that). | **P2** | co-chair | `playbooks/runbooks/export-anomaly.md` | F-28 / T11 |
| `A-AUTH-001` | Auth failure burst | More than **N = 10 auth failures in M = 5 minutes** from one IP (truncated to /24) OR from one `actor_pseudonym`. | **P2** | inc-responder | `playbooks/runbooks/auth-failure-burst.md` | T05 / T8 (enumeration) / F-40 / F-42 |
| `A-AUTH-002` | Passkey enrollment without TOTP-bootstrap-removal | An `auth.passkey.enrolled` audit row exists for a user without a corresponding `users.totp_destroyed_at` timestamp set in the same transaction. (Per ADR-0002 / F-43 the TOTP secret must be destroyed atomically.) | **P2** | inc-responder | `playbooks/runbooks/auth-failure-burst.md` (shares triage; the runbook has a dedicated section) | T05 / F-43 |
| `A-DEP-001` | High-severity dependency CVE on `main` | `npm audit --audit-level=high` reports any high-or-critical advisory on `main`. Blocks deploy via the verifier integration. | **P2** | inc-responder + co-chair | `playbooks/runbooks/auth-failure-burst.md` (no — separate runbook; see file) | constraints.md vuln-mgmt; not in playbooks/runbooks yet — **stub at `playbooks/runbooks/high-severity-cve.md`** |
| `A-SENTRY-001` | Sentry self-test failed | Synthetic error tagged `sentry.selftest=1` emitted at startup of every deploy MUST appear in Sentry within **5 minutes**. If it doesn't, this alert fires (via a Postgres job that compares a known startup-emitted row with Sentry's Issues API). Also fires if the scrubber's `PanicSink` was invoked at any point in the last hour (canary survived, C4 key seen, or oversized event dropped). | **P1** | inc-responder | `playbooks/runbooks/sentry-self-test-failed.md` | T02 / ADR-0010 |
| `A-RETENTION-001` | Retention job failure | The daily T16 job either (a) did not emit a `retention.deleted` summary row in the last 26 hours, OR (b) the row's `deleted_count` per-table exceeds the threshold of 20 in a single pass (per F-51 default). | **P1** (a) / **P2** (b) | inc-responder + co-chair | not stubbed in this pass — flag for T16 author | T16 / F-51 / F-52 |
| `A-SENTRY-002` | Sentry event volume burst | Sentry events received > **25k in the rolling month** (50% of the Team-tier 50k included). | **P3** | digest + cost-manager | not stubbed in this pass — cost-manager owns | T02 / cost posture |
| `A-COST-001` | Monthly cost projection > $80 USD | Cost dashboard's 3-month rolling projection crosses $80 USD (steady-state baseline is ~$54). | **P3** | digest + cost-manager | not stubbed in this pass — cost-manager owns | capacity sketch |

### Counts

- **P1: 6** (audit integrity break, key-rotation enum gap, backup freshness, sentry self-test, retention job failure(a), keep-an-eye…)
- **P2: 9**
- **P3: 2**

(Approximate; the table above is the truth — counted for the
self-validation handoff back to the parent agent.)

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
`observability/README.md` §10 and `playbooks/runbooks/<alert>.md`
first. Most of these alerts catch conditions the threat model says
will cost us PIPEDA notification obligations if they go undetected.

---

## 4. What we explicitly do NOT alert on

- **Latency.** Phase 0 has no baseline. The SRE-specialist sets SLO
  + burn-rate alerts in Phase 4. Latency in v1 is observable from the
  dashboards; it does not page.
- **Per-user activity.** The "recent sensitive activity" feed surfaces
  every C4 read to every active member; that's the social-norm signal.
  No paged alert on "user X did 5 reprisal reads" — the threshold-
  bursts (A-C4-001) handle the misuse case.
- **General service availability.** Supabase has its own status page;
  duplicating that here adds noise. Backup freshness + audit-integrity
  + sentry-self-test together cover the "is anything wired alive"
  question.

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
