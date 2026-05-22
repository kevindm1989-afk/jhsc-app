# Dashboards

> Phase-0 spec. Nine dashboards. All implemented as SvelteKit pages
> under `/internal/observability/*`, gated by RLS to active committee
> members (the co-chair sees a slightly expanded set described per
> dashboard).
>
> **No third-party dashboarding tool.** Adding one would add a new PI
> processor — JHSC-APP-PLAN.md §7 forbids it. Postgres + a server-
> rendered Svelte page is the design constraint, by intent.
>
> All queries read from views (`v_*`) defined in migrations. The views
> aggregate / project from `audit_log` and the `metrics_counters` table;
> they NEVER select ciphertext columns. The views have RLS pass-through
> based on `is_active_member()`.

---

## Dashboard 1 — Auth health (`/internal/observability/auth`)

**Audience:** all active members; the co-chair sees a slightly fuller
view (passkey enrollment funnel breakdown).

**Tiles:**

1. **Sign-in success rate (7d / 30d)** — `auth.method=passkey` outcomes,
   from `audit_log` where `event_type='auth.passkey.assert'` (when
   added in T05 — see open finding §F4 below). Big number + 7d
   sparkline.
2. **Passkey enrollment funnel** — TOTP-invite-issued →
   TOTP-consumed → first-passkey-enrolled →
   TOTP-destroyed-in-same-txn. Five steps; drop-off by step. Pulls
   from `auth.passkey.enrolled` + the `users.totp_destroyed_at` check.
3. **Sessions revoked (last 30d)** — count + per-reason breakdown
   (`user_action` / `co_chair_remove` / `policy_panic`), from
   `session.revoked` rows.
4. **Active sessions** — current count (live). Sourced from
   `auth.sessions` snapshot; not from audit log.
5. **Auth failure burst status** — has the `A-AUTH-001` alert fired in
   the last 24h? Green/amber/red.

**Forbidden:** username, email, IP. Actor identification is
pseudonym-only.

---

## Dashboard 2 — Concern intake throughput (`/internal/observability/concerns`)

**Audience:** all active members.

**Tiles:**

1. **Concerns created (counts only)** — 7d / 30d / 90d. Bar by week.
   Counts only; the dashboard never decrypts a body, never queries
   a `*_ciphertext` column.
2. **Open / triaged / closed split** — counts by `status` enum.
3. **Per-`hazard_class` split (last 90d)** — bar chart by enum
   (C1 metadata; safe to display).
4. **Per-`severity` split (last 90d)** — bar chart.
5. **Anonymous-default-kept rate** — what fraction of `concern.created`
   rows have `meta.anonymous_default_kept = true`. (If this drops
   sharply, the social default is eroding — the privacy-reviewer flag.)

**Forbidden:** any concern body, any source name, any
`source_revealed` per-concern detail. The reveal events show as an
opaque per-pseudonym count only.

---

## Dashboard 3 — Export feed (`/internal/observability/exports`)

**Audience:** all active members. This is the RA-1 social-norm surface.

**Tiles:**

1. **Recent exports (live feed)** — every `export.generated` row from
   the last 30 days. Columns:
   - timestamp (UTC + relative "3 hours ago")
   - `actor_pseudonym` (the co-chair who exported; co-chair sees their
     own actions clearly)
   - `export_kind` (`minutes.final` / `recommendation`)
   - `target_id` (the document id — opaque uuid)
   - `field_set_hash` (hex, first 8 chars) — for forensic comparison
     against the in-repo allowlist hash
   - `derived_from_concerns_count` — **bolded if > 0**, with a tooltip
     listing the concern ids (linked to the concern view, which itself
     gates content access by RLS)
2. **Export-rate spark** — rolling 7d count per day.
3. **Last export's audit/Blob ordering** — green check if every
   `export.generated` in the last 30d had its row INSERTed BEFORE the
   corresponding `request_id` saw any download-link emission in the
   structured log. (F-24 contract.)

**Forbidden:** the export contents themselves; the recipient email; any
detail beyond what the audit row holds.

---

## Dashboard 4 — Sensitive-read feed (`/internal/observability/sensitive`)

**Audience:** all active members (per HG-6 + T11 mitigation — the feed
IS the visibility).

**Tiles:**

1. **Recent C4 reads (live feed)** — every `reprisal.read`,
   `work_refusal.read`, `s51_evidence.read` row in the last 30d.
   Columns: timestamp, `actor_pseudonym`, `c4.table`, `target_id`,
   `read_via` (`security_definer_view` / `edge_fn_indirection`).
2. **Per-actor 30d burst signal** — actors with > N reads in any
   5-minute window (the `A-C4-001` threshold) are flagged.
3. **Coverage assertion** — count of C4 SELECTs in the last 24h vs
   count of C4 audit rows in the same window. Numbers must match.
   Divergence triggers `A-AUDIT-001` (because the SECURITY DEFINER
   contract is broken).
4. **Time-since-last-read per C4 table** — gauge.

**Forbidden:** the C4 row content; the per-record passphrase; any hint
that would let a coerced reader figure out who reads what.

---

## Dashboard 5 — Sync health (`/internal/observability/sync`)

**Audience:** all active members.

**Tiles:**

1. **HMAC pass / fail (last 7d)** — `inspection.synced` vs
   `inspection.synced.hmac_fail` counts.
2. **Offline-queue depth distribution** — histogram of queue depths
   reported by browser logs. (Source: structured-log `sync.queue_depth`
   gauge events; aggregated server-side.)
3. **Stuck inspections** — inspections that have been in the offline
   queue for > 7 days (likely the inspector lost the device or the
   session is locked). Count only.
4. **SW cache-policy-violation count (last 30d)** — should be 0 in
   steady state. Any non-zero triggers `A-SW-001`.

---

## Dashboard 6 — Audit-log integrity (`/internal/observability/audit-integrity`)

**Audience:** all active members.

**Tiles:**

1. **Last successful chain check** — timestamp + how-long-ago.
2. **Total rows + last-seq + chain-head hash** — the chain's current
   head. Useful for the incident-responder to compare against a
   known-good off-system snapshot.
3. **Per-trigger run counts (30d)** — scheduled / post-rotation /
   post-export.
4. **Failures (last 90d)** — should be 0 entries. Any entry links
   directly to the `playbooks/runbooks/audit-log-integrity-break.md`
   runbook.
5. **Key-rotation enum-gap status** — has `A-KEY-ROT-001` fired in the
   last 30d? Green/red.

---

## Dashboard 7 — Backup health (`/internal/observability/backups`)

**Audience:** all active members; the co-chair sees the restore-drill
schedule.

**Tiles:**

1. **Last successful backup** — timestamp + size + age in hours.
   Red banner if > 36h.
2. **Last successful restore drill** — timestamp + report link (signed
   per T17 / plan §13.F). Red banner if > 95 days (the
   "quarterly" cadence).
3. **Bucket config drift status** — green / amber / red. Reads from
   the `bucket_drift_checks` table (weekly CI job rows).
   Shows the most recent diff if amber/red.
4. **Object Lock active** — boolean. Should be true. From drift check.
5. **Object Lock default retention** — should be `35d governance`.
6. **Versioning enabled** — boolean.
7. **Lifecycle rule active** — should delete versions > 42d.

---

## Dashboard 8 — Sentry error volume (`/internal/observability/errors`)

**Audience:** all active members.

**Tiles:**

1. **Event counts (7d / 30d)** by P1/P2/P3 bucket. (Bucket is assigned
   in Sentry alert rule, not in the SDK.)
2. **New issues vs regressions (last 7d)** — pulled from Sentry's
   Issues API via a server-side polling job (so the dashboard page
   does not call sentry.io directly — JS-runtime constraint).
3. **Scrub canary status** — was the `PanicSink` invoked in the last
   hour? Yes → red, with a direct link to the
   `sentry-self-test-failed.md` runbook.
4. **Sentry self-test status** — was the synthetic startup event
   observed in Sentry within 5 min of the most recent deploy? Yes →
   green; no → P1 alert + red.
5. **Top error classes (last 7d)** — by `error_class`, not by message.

**Forbidden:** Sentry stack-trace excerpts containing scrubbed text;
the dashboard shows counts and class names, not message bodies.

---

## Dashboard 9 — Cost (`/internal/observability/cost`)

**Audience:** co-chair (privacy-budget signal); displayed weekly in the
digest email.

**Tiles:**

1. **Last month total** — Supabase + Sentry + B2 invoiced amounts.
   Sources: cost-manager-uploaded monthly CSV (the cost-manager agent
   is the upstream).
2. **3-month rolling projection** — for the next 3 months at current
   trajectory.
3. **Sentry event-quota burn** — events used / 50k included this
   month, with end-of-month projection.
4. **Supabase storage trend** — GB used vs 100GB allowance.
5. **Alert state** — has `A-SENTRY-002` (event volume burst) or
   `A-COST-001` (projection > $80) fired in the last 30d?

---

## Findings surfaced (for follow-up)

1. **`auth.passkey.assert` is not in the audit-log enum** but the auth-
   health dashboard wants it for the success/fail ratio. Either (a)
   add to the enum (architect amendment) or (b) emit it as a structured-
   log event only (no chain participation, since each assert is not a
   state mutation worth chaining). The recommendation is (b) — assert
   is high-frequency and pollutes the chain.  **Flag for architect.**
2. **Cost dashboard depends on the cost-manager agent.** The cost-
   manager has not run yet at Phase 0. The dashboard ships with a
   "no data yet" panel until the first cost-manager run.
3. **No SLO panels yet** — the dashboards show signal, not SLO
   compliance. SRE-specialist owns adding those in Phase 4.
4. **The "active sessions" tile (Dashboard 1, tile 4)** reads from
   `auth.sessions` directly. Confirm with the auth-reviewer (T05)
   that this read is safe under the session-model RLS; if it requires
   service-role access, route through a SECURITY DEFINER view that
   exposes counts only (no session ids, no JWTs).
