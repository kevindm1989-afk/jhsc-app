# Audit-log emission contract

> Phase-0 spec. T18 implements the integrity-check job; T07, T08, T10,
> T11, T12, T13, T14, T16 each emit specific events listed below.
>
> Sources:
> - `.context/decisions.md` ADR-0003 Amendment A (Invariant 8 — HG-2)
> - `.context/decisions.md` ADR-0003 Amendment B (Invariant 7 strengthened — HG-6)
> - `.context/decisions.md` RA-1 (export feed surface — HG-1)
> - `.context/threat-model.md` §3.6 F-50, F-52; §6 Invariants 7 + 8
> - `.context/decisions.md` PI inventory (`audit_log.*` row)
>
> **The audit log is first-class app data.** It lives in Postgres,
> NOT in Sentry, NOT in Edge Function logs. The Sentry self-test
> never touches the audit-log table. The structured logger may emit
> an "audit echo" line at INFO level for correlation, but the
> canonical record is the row in `audit_log`.

---

## 1. The closed event-type enum

Adding a value requires an architect amendment to ADR-0003 Amendment A
and a migration. Adding a value during implementation without that
amendment is a CI failure (CHECK constraint on the `event_type`
column).

### Key-material (HG-2 / ADR-0003 Amendment A) — 8 values + Amendment F + T07.1 + T19

The first eight rows are exactly the values from the ADR. `identity_privkey.recovery_blob.viewed` is added by Amendment F. `recovery_reset.issued` is added by T07.1 (G-T07-8 — server-emitted from `issue_recovery_blob_reset`). `panic_wipe.invoked` is reserved by T19 (ADR-0020 Decision 5) and emitted client-side from `WipeStore.emitAudit`.

| Enum value | When emitted | Required `meta` fields |
|---|---|---|
| `identity_keypair.created` | First-login enrollment generates user's identity keypair | `ident_pubkey_fingerprint` (hex) |
| `identity_privkey.recovery_blob.written` | Recovery-passphrase enrollment completes (F-08) | `kdf_params_version`, `reset_consumed` |
| `identity_privkey.recovery_blob.restored` | Passphrase-based recovery on a new device | `device_fingerprint` (hashed; no raw UA) |
| `identity_privkey.recovery_blob.viewed` | Amendment F "show passphrase again" reveal (hold-to-reveal + cap-of-3 per enrollment session, server-enforced per G-T07-7) | `enrollment_session_id`, `reveal_count_in_session` |
| `recovery_reset.issued` | Co-chair-issued recovery-blob reset (F-12 / G-T07-8) — allows the next `store_recovery_blob` to succeed | `target_user_id`, `reset_id` |
| `panic_wipe.invoked` | Local-only panic wipe — written BEFORE IndexedDB is cleared (F-53 audit-before-side-effect) | `surface` ∈ {`settings`,`lock_screen`}, `wipe_scope` ∈ {`local_only`}, `completed` (boolean), `partial_failure_classes[]` |
| `committee_data_key.wrapped_for_member` | Existing member wraps committee privkey for a (new or re-added) member | `target_member_id`, `committee_key_id`, `rotation_id?` |
| `committee_data_key.unwrap` | A member opens own wrap to recover committee privkey | `committee_key_id` |
| `committee_data_key.rotation.started` | First step of rotation — advisory lock acquired, new keypair generated | `committee_key_id_prev`, `committee_key_id_next`, `rotation_id`, `trigger` ∈ {`member_removal`,`scheduled`,`incident`} |
| `committee_data_key.rotation.completed` | Final step of rotation — new wraps for all remaining members, previous in `committee_key_history` | `committee_key_id_prev`, `committee_key_id_next`, `rotation_id`, `members_rewrapped_count` |
| `committee_data_key.member_revoked` | Removed member's wrap row is deleted (paired by `rotation_id` with the surrounding rotation per Invariant 6) | `removed_member_id`, `committee_key_id`, `rotation_id` |

### Auth + session (T05)

| Enum value | When emitted | Required `meta` |
|---|---|---|
| `auth.passkey.enrolled` | First passkey bound on an account (TOTP destroyed in same txn) | `cred_id_pseudonym` (HMAC of WebAuthn credential id) |
| `auth.passkey.enroll_failed` | WebAuthn registration ceremony rejected (forged attestation, expired/replayed challenge, origin/rpId mismatch, alg downgrade) — bootstrap EF or future enrollment paths emit this BEFORE any user/credential write | `outcome` ∈ closed set, `rp_id`, `origin`, optional `cred_id_pseudonym` |
| `auth.passkey.revoked` | User or co-chair revokes a passkey | `cred_id_pseudonym`, `revoked_by_actor_pseudonym` |
| `session.revoked` | Session token explicitly revoked (user "Revoke all sessions" or co-chair removal) | `session_id_pseudonym`, `revoked_by_actor_pseudonym`, `reason` ∈ {`user_action`,`co_chair_remove`,`policy_panic`} |

### Concern intake (T08)

| Enum value | When emitted | Required `meta` |
|---|---|---|
| `concern.created` | A worker rep submits a concern (anonymous or not — `actor_id` is always the submitter) | `anonymous_default_kept` (boolean), `hazard_class`, `severity`, `location_id` |
| `concern.updated` | A concern's mutable text/classification columns are edited (F-16) | `prev_field_hashes` (object `{title_ct?, body_ct?}` — SHA-256 hex of each prior ciphertext column, server-computed) |
| `concern.source_revealed` | "Reveal source" action invoked, per-record passphrase entered + audit-log row written BEFORE plaintext returns to client | `concern_id`, `per_record_unlock_ts` |

### Inspections (T10)

| Enum value | When emitted | Required `meta` |
|---|---|---|
| `inspection.synced` | A queued inspection drains successfully (HMAC verified) | `inspection_id`, `queue_seq` |
| `inspection.synced.hmac_fail` | HMAC mismatch on drain — entry quarantined, no POST | `queue_seq`, `failure_reason` ∈ {`tag_mismatch`, `user_id_mismatch`, `salt_version_mismatch`} |

### Recommendations (T12)

| Enum value | When emitted | Required `meta` |
|---|---|---|
| `recommendation.created` | Draft recommendation row created | `recommendation_id` |
| `recommendation.employer_response_logged` | Co-chair (or rep) records the employer's response | `recommendation_id`, `response_received_ts` |

### Reprisal log (T13)

| Enum value | When emitted | Required `meta` |
|---|---|---|
| `reprisal.created` | A reprisal entry is created | `reprisal_id` |
| `reprisal.read` | **Server-emitted from the `SECURITY DEFINER` view** (HG-6) — atomic with SELECT. NOT client-cooperative. | `reprisal_id`, `read_via` ∈ {`security_definer_view`,`edge_fn_indirection`} |
| `reprisal.status_changed.4eyes_pending` | A status-flip proposal is filed in `pending_destructive_ops` | `reprisal_id`, `target_status`, `proposer_actor_pseudonym` |
| `reprisal.status_changed.4eyes_completed` | A second active member approves; status flip executes | `reprisal_id`, `target_status`, `proposer_actor_pseudonym`, `approver_actor_pseudonym` |
| `reprisal.update` | A reprisal entry's text columns are edited (F-31) | `prev_field_hashes` (object `{title_ct?, body_ct?}` — SHA-256 hex of each prior ciphertext, server-computed) |
| `sensitive.access_attempt` | A C4 read attempted with a wrong per-record passphrase (G-T13-6) — emitted, no plaintext returned | `reason` |
| `audit.forensic_reveal.4eyes_pending` | A forensic-reveal proposal is filed (Amendment E) | `reveal_reason`, `audit_log_id`, `pending_id` |
| `audit.forensic_reveal.4eyes_completed` | A second member (co-chair + co-chair / co-chair + certified) approves; the target audit row's actor pseudonym is revealed for ≤24h | `reveal_reason`, `proposer_actor_pseudonym`, `approver_actor_pseudonym` |

The same pattern is replicated for `work_refusal` and `s51_evidence`
in T14, enumerated below.

### Work refusal + s.51 evidence (T14)

| Enum value | When emitted | Required `meta` |
|---|---|---|
| `work_refusal.created` | An s.43 work-refusal entry is filed by a certified member (F-21 / F-17) | `created` |
| `work_refusal.read` | **Server-emitted from `work_refusal_read`** (HG-6) — audit-before-ciphertext; the read is granted to certified members and co-chairs | `read_via` |
| `work_refusal.update` | A work-refusal entry's text is edited (F-31) | `prev_field_hashes` (object `{title_ct?, notes_ct?}` — SHA-256 hex of each prior ciphertext, server-computed) |
| `s51_evidence.created` | An s.51 critical-injury evidence record is filed by a certified member; photos sealed client-side and stored as a per-photo blob array | `created`, `photo_count` |
| `s51_evidence.read` | **Server-emitted from `s51_evidence_read`** (HG-6) — audit-before-ciphertext; returns notes + sealed photos | `read_via` |
| `s51_evidence.update` | An s.51 evidence entry's text is edited (F-31) | `prev_field_hashes` (object `{title_ct?, notes_ct?}`) |
| `s51_evidence.create.rejected` | A submit was aborted because a photo failed `sanitizePhoto` (non-JPEG) — no row was written (G-T14-12) | `reason: 'photo_unsupported_format'`, `rejected_index` |

Wrong-passphrase reads on the T13/T14 surfaces emit the shared
`sensitive.access_attempt` row (`reason: 'wrong_passphrase'`, plus `table` ∈
{`work_refusal`, `s51_evidence`}); no plaintext returns.

### Export (T11 + T12 + RA-1)

| Enum value | When emitted | Required `meta` |
|---|---|---|
| `export.generated` | A co-chair-signed export was rendered AND the audit row was written BEFORE the Blob URL was created (F-24) | `export_kind` ∈ {`minutes.final`,`recommendation`}, `target_id`, `field_set_hash`, `recipient_role`, `derived_from_concerns_count` |
| `export.contained_concern_derived_items` | A second-class row written same-txn-as `export.generated` IFF the export included items derived from concerns (per RA-1). Lists the concern ids. | `export_audit_id`, `concern_ids` (uuid[]) |

### Retention (T16)

| Enum value | When emitted | Required `meta` |
|---|---|---|
| `retention.deleted` | One row per retention-job pass with per-table counts (F-52) | `deleted_per_table` (jsonb), `job_id`, `dry_run` (boolean) |

### Membership (T06)

| Enum value | When emitted | Required `meta` |
|---|---|---|
| `member.added` | Co-chair invites + member completes enrollment | `target_member_id` |
| `member.removed` | Co-chair removes a member; triggers key rotation downstream | `target_member_id`, `triggers_rotation_id` |
| `member.role_changed` | Co-chair changes a member's role set (ADR-0021; reserved by T06, SQL CHECK + retention-schedule half lands in T06.1) | `roles_before`, `roles_after` |
| `committee.key_rotated` | A scheduled (non-removal-triggered) rotation completes. NOTE: a member-removal rotation is captured by the `committee_data_key.rotation.*` enum above; this is the standalone case. | `committee_key_id_prev`, `committee_key_id_next`, `rotation_id`, `reason` |

### Service-worker / cache (T10 — HG-3)

| Enum value | When emitted | Required `meta` |
|---|---|---|
| `client.cache_policy_violation` | SW sanity check rejected a response (X-Data-Class C3/C4) for caching, queued for next online | `route`, `data_class` ∈ {`C3`,`C4`}, `allowlist_version` |
| `client.identity_selftest_fail` | Session-start identity-key self-test failed (F-03) | (no extra meta) |

### Queue integrity (T10 — HG-4)

| Enum value | When emitted | Required `meta` |
|---|---|---|
| `queue.integrity_fail` | Inspection-queue drain HMAC mismatch — equivalent to `inspection.synced.hmac_fail`; we keep both names for the threat-model cross-references. (Implementer chooses one canonical; the other becomes a forbidden alias caught by semgrep.) | same as `inspection.synced.hmac_fail` |

### Backup pipeline (T17)

| Enum value | When emitted | Required `meta` |
|---|---|---|
| `backup.manifest_written` | One row per backup pass that successfully committed (ADR-0018 §"Option H" / M8.A.3b). Emitted by `backup_emit_manifest_written` AS THE LAST step of a committed pass (F-72 step 10). NO PI — structural metadata only (G-T16-PRIV-7); `actor_pseudonym` at TOP LEVEL only (G-T16-PRIV-1; F-79). Retention: 7y (mirrors `retention.deleted` — manifest is the audit anchor). | `run_id`, `sha256`, `bytes`, `committee_data_key_kid`, `audit_log_head` (`{id, ts_ms, hash}`), `per_event_row_counts`, `per_table_row_counts`, `retention_sweep_runs_snapshot_ts_ms`, `schedule_hash`, `node_runtime_pin`, `status: 'committed'` |
| `backup.hard_deleted` | One row per `committed` → `hard_deleted` manifest transition fired by the 42-day retention pass (ADR-0018 §J / M8.A.3d). Emitted by `backup_emit_hard_deleted` AS THE LAST step of the transition. NO PI — structural metadata only; same F-79 / G-T16-PRIV-1 posture. Retention: 7y. | `run_id`, `object_ref`, `hard_deleted_at_ms`, `original_committed_at_ms` |

### Alerting infra echoes (T18)

| Enum value | When emitted | Required `meta` |
|---|---|---|
| `alert.fired` | The dispatcher emits one row per fired alert (so the alert pipeline itself is auditable) | `alert_id`, `severity`, `routing` |
| `audit.integrity_check.ran` | One row per integrity-check pass (ADR-0019 §3 / M8.B.2). Emitted by `integrity_check_emit_run_and_mismatches`. NO PI. Retention: 24mo (operational telemetry; mirrors `retention.deleted`). | `run_id`, `trigger` ∈ {`scheduled`,`post_rotation`,`post_export`,`weekly_anchor`}, `status` ∈ {`ok`,`mismatch_found`,`aborted`,`timed_out`}, `rows_walked`, `mismatches_count`, `schedule_hash`, `node_runtime_pin` |
| `audit.integrity_check.mismatch` | One row per mismatch the integrity pass discovered (ADR-0019 §3 / M8.B.2). Emitted by `integrity_check_emit_run_and_mismatches` alongside the `ran` row. Load-bearing forensic. Retention: 7y. | `run_id`, `audit_log_id`, `mismatch_kind` ∈ {`hash_mismatch`,`row_missing`,`row_unexpected`,`head_pointer_drift`}, `attributable` (boolean), `attribution_run_id?` (uuid) |
| `audit.chain_anchor.weekly` | One row per weekly off-app anchor delivery (ADR-0019 §"Optional audit_chain_anchors table" / G-T18-12). Emitted by `integrity_check_emit_chain_anchor_weekly`. NO PI — `email_recipient_pseudonym` is HMAC. Retention: 7y. | `anchor_id`, `head_audit_log_id`, `head_ts_ms`, `head_hash_hex`, `email_recipient_pseudonym` |

---

## 2. Row schema (every audit-log row)

```
table audit_log (
  id                bigint generated always as identity primary key,
  ts                timestamptz not null default now(),
  actor_pseudonym   varchar(16) not null,        -- HMAC-BLAKE2b-256(uid)[:16hex]
                                                  -- on retention-job rows the actor is
                                                  -- 'sys-retention'; on key-rotation
                                                  -- triggered by Edge Function the actor
                                                  -- is the user who triggered, NOT
                                                  -- 'sys-edge'
  event_type        text not null check (event_type in (<closed enum>)),
  target_id         uuid,                         -- nullable; set when there's a single
                                                  -- target row (concern_id, reprisal_id, etc.)
  target_class      text not null check (target_class in ('C0','C1','C2','C3','C4')),
  severity          text not null check (severity in ('info','notice','warn','alert')),
                                                  -- used by the alert dispatcher; most
                                                  -- rows are 'info' or 'notice'
  request_id        uuid,                         -- correlation key to logs + Sentry
  rotation_id       uuid,                         -- nullable; set for key-material rows
  meta              jsonb not null default '{}'::jsonb,
                                                  -- per-event required fields per §1
  prev_hash         bytea not null,               -- BLAKE2b-256 of the prior row's `hash`
                                                  -- (or genesis hash for row 1)
  hash              bytea not null,               -- BLAKE2b-256 of the canonical-JSON
                                                  -- serialization of this row (excluding
                                                  -- `hash` itself) + prev_hash
  signature         bytea,                        -- optional: server signature over `hash`
                                                  -- with a server-side Ed25519 key
                                                  -- (deferred to T18 — see §5)
  primary key (id)
);

create index audit_log_ts_idx on audit_log (ts);
create index audit_log_event_type_ts_idx on audit_log (event_type, ts);
create index audit_log_rotation_id_idx on audit_log (rotation_id) where rotation_id is not null;
```

### Field notes

- `actor_pseudonym`: NEVER the raw `auth.uid()`. The pseudonymization
  HMAC is the same one used in the structured logger (`HMAC_PSEUDONYM_KEY`).
  This means the same user appears under the same pseudonym across audit
  log + log lines + Sentry server events — correlatable, but not reversible
  outside the server boundary.
- `target_id`: nullable. For events where there is no single target
  (e.g., `retention.deleted` summarises many rows), it's `NULL` and
  `meta` carries the detail.
- `target_class`: REQUIRED on every row. The alert dispatcher uses this
  to route C4 reads to the right surface and to compute the per-class
  rate burst.
- `severity`: an internal-to-audit-log severity. Distinct from the
  alert severity. Most rows are `info`. A `reprisal.read` may be
  `notice`. An integrity break is `alert`.
- `request_id`: same UUID as the structured-log + Sentry correlation
  key. Allows walking a Sentry event → log line → audit row.
- `meta`: jsonb. Subject to a CHECK constraint OR an `assert_meta_shape`
  trigger that validates per-event-type required keys (per §1). A row
  whose `meta` is missing required keys is rejected at INSERT.

### Hash chain

- `prev_hash` = `BLAKE2b-256(prev_row.hash)`. Row 1 uses a fixed
  genesis hash documented in the migration.
- `hash` = `BLAKE2b-256(canonical_json({id, ts, actor_pseudonym, event_type,
  target_id, target_class, severity, request_id, rotation_id, meta,
  prev_hash}))`.
- Canonical JSON: keys sorted lexicographically; no whitespace; UTC
  timestamps in `ts`; bytea fields hex-encoded.
- The hash is computed by the SECURITY DEFINER `audit_emit(...)`
  function, NOT by the caller. Callers cannot forge a hash.

### Signature (deferred — flagged finding)

The schema reserves a `signature bytea` column for a server-side
Ed25519 signature over `hash`. T18 currently builds the chain without
the signature; the signature adds a second, key-protected verifier so a
platform admin (A5) with raw INSERT cannot also forge a chain that
internally validates. Implementing the signature requires the Ed25519
keypair to live somewhere the platform admin doesn't reach — a hardware
token, a 1Password-held escrowed key invoked by a pg_cron job, or an
external signer. **The architect should ratify the signer location
before T18 ships; this is surfaced as finding #4 below.**

---

## 3. Where it writes

- `audit_log` table in Supabase Postgres.
- INSERT permission is REVOKED from every role except:
  - `audit_writer_role` — used by `audit_emit(...)` SECURITY DEFINER
    functions called from every legitimate emission path.
  - `c4_read_service` — the role that owns `jhsc_log_sensitive_read`
    (HG-6 / Amendment B). This is a separate role only because it must
    be granted in the same transaction as the C4 SELECT; it can ONLY
    emit `reprisal.read`, `work_refusal.read`, `s51_evidence.read`
    (enforced by the CHECK in the function body).
- UPDATE: REVOKED FROM ALL ROLES. Period. There is no legitimate update
  path.
- DELETE: REVOKED FROM ALL ROLES except `retention_service_role`, which
  may DELETE rows where `ts < now() - interval '24 months'` — and only
  via the retention-pass function that emits its own
  `retention.deleted` summary row in the same transaction.
- SELECT: granted to `authenticated` AND gated by RLS:
  - active committee members see all rows;
  - inactive users see nothing;
  - the `c4_read_service` and `audit_writer_role` are not login roles
    (no JWT possible).

---

## 4. RLS policy outline

```
alter table audit_log enable row level security;

-- SELECT: active members only.
create policy audit_log_select_active_members on audit_log
  for select
  to authenticated
  using (is_active_member());

-- INSERT: deny all from `authenticated`. The insert path is
-- `audit_emit(...)` SECURITY DEFINER owned by `audit_writer_role`.
-- (We REVOKE INSERT explicitly to make the intent loud.)
revoke insert on audit_log from authenticated, anon, service_role;
grant insert on audit_log to audit_writer_role, c4_read_service;

-- UPDATE: denied to every role.
revoke update on audit_log from authenticated, anon, service_role,
                                audit_writer_role, c4_read_service,
                                retention_service_role;

-- DELETE: only the retention service role, only via the function.
revoke delete on audit_log from authenticated, anon, service_role,
                                audit_writer_role, c4_read_service;
grant delete on audit_log to retention_service_role;
```

The `is_active_member()` helper is the same one used across the schema
(per ADR system design §RLS).

---

## 5. Tests required (test-writer obligations)

For T18 / T07 / T13 specifically. The test-writer turns each into a
failing test before the implementer touches the code path.

1. **Chain integrity break is detected within 5 minutes.**
   - Insert a baseline of 100 rows via `audit_emit`.
   - Use a privileged test connection to UPDATE one row's `meta`
     (bypassing the RLS revocation — this is the *attack* the test
     simulates).
   - **Actually** since UPDATE is revoked from every role, the test has
     to drop the revocation TEMPORARILY in a savepoint, mutate, restore.
     The "real" attack is `A5 with platform credentials"; the
     test simulates that authority.
   - Trigger the T18 integrity job (either scheduled, post-rotation, or
     post-export per F-50).
   - Assert an `A-AUDIT-001` alert fires within **5 minutes** (the F-50
     contract). For CI fast-fire, advance the clock if the job is
     time-driven; otherwise trigger directly.
2. **UPDATE attempt on `audit_log` fails at RLS** for every role
   (`authenticated`, `anon`, `service_role`, `audit_writer_role`,
   `c4_read_service`, `retention_service_role`). Six assertions.
3. **DELETE attempt fails for every role except `retention_service_role`
   on aged rows.** Including: `retention_service_role` DELETE of a
   row newer than 24 months FAILS (the function-level filter blocks).
4. **C4 read via SECURITY DEFINER view writes audit row in same
   transaction** (HG-6).
   - SELECT from `reprisal_log_read_audited` as an authorised member.
   - Assert exactly one `reprisal.read` row appears with matching
     `target_id`, `actor_pseudonym`, and a `ts` that is identical
     (microsecond-level) to the SELECT's transaction timestamp.
   - Induce a `jhsc_log_sensitive_read` failure (REVOKE INSERT on
     `audit_log` from `c4_read_service` inside a test transaction);
     assert the SELECT rolls back; no row returned; no partial audit
     row.
5. **Direct `SELECT * FROM reprisal_log` (bypassing the view) returns
   zero rows AND no audit row** for any role (HG-6 coverage).
6. **Closed enum is enforced.** Attempt `audit_emit` with
   `event_type='not.a.real.event'`; assert the CHECK constraint
   rejects.
7. **`meta` shape is enforced.** Attempt `audit_emit` of
   `committee_data_key.rotation.completed` without `members_rewrapped_count`;
   assert the assertion trigger rejects.
8. **Hash is computed server-side, not by the caller.** Pass a forged
   `hash` to `audit_emit`; assert it is ignored / overwritten.
9. **Key-rotation enum-gap alert.** Emit
   `committee_data_key.rotation.started` with `rotation_id = R1`; do
   NOT emit `.completed`. Wait the configured window. Assert
   `A-KEY-ROT-001` fires.
10. **Retention pass writes one summary row + zero per-deleted-row
    rows.** Run a retention pass that would delete 5 rows; assert one
    `retention.deleted` row with `deleted_per_table = {<table>: 5}`
    appears.

---

## 6. Findings surfaced (for architect / threat-modeler — not actions)

1. **Audit-row signature deferred.** §2's `signature` column is reserved
   but unfilled. With INSERT permission held by `audit_writer_role`
   (and `c4_read_service`), a platform admin (A5) with `audit_writer_role`
   credentials can forge a chain — the chain itself is internally
   consistent. The signature would close that gap by requiring a key the
   platform admin doesn't have. **Surface to architect:** decide if v1
   ships with hash-only or hash+signature; if hash+signature, where the
   signing key lives (1Password vault + pg_cron, hardware token, or
   external signer). The recommendation is to ship hash-only at v1 and
   document the residual as an accepted risk in §7 of the threat model,
   with the upgrade triggered on any incident pattern that suggests
   platform-side forgery.
2. **`queue.integrity_fail` vs `inspection.synced.hmac_fail` duplication.**
   The architect's amendments use both names in different places. The
   contract above picks one canonical (`inspection.synced.hmac_fail`)
   and lists the alias. Architect should pick one in ADR-0014 to
   eliminate the ambiguity.
3. **`work_refusal.read` / `s51_evidence.read` are not enumerated in
   the architect's amendment.** T14 will need them. Adding to the
   enum is mechanical; flag for the architect's T14 amendment pass.
   **[RESOLVED — ADR-0003 Amendment A extension (`.context/decisions.md`
   line 5835) ratifies both enum values; G-T14-7 closure status block
   in `.context/known-gaps.md` documents the structural landing. All
   six T14 events are in §1 above (lines 96–101) and in
   `scripts/check-audit-enum-coverage.sh` `EXPECTED_ENUM`.]**
4. **The `reprisal.created` event reveals to ALL active members that a
   reprisal entry exists.** This is intended (the read-feed surface is
   the social-norm backstop) but the rep who entered the reprisal may
   reasonably expect more discretion. **Surface to privacy-reviewer**
   before T13 ships; the privacy notice may need to name this
   explicitly.
   **[RESOLVED — ADR-0003 Amendment D (`.context/decisions.md` around
   line 6024+) mitigates via a `reprisal_audit_feed_pseudonymized`
   `SECURITY DEFINER` view that suppresses `actor_pseudonym` and
   buckets `ts` to the hour in the member-visible feed. Forensic
   un-projected access requires the Amendment E 4-eyes procedure.
   The social-norm backstop survives without the load-bearing
   author-inference vector. Privacy-reviewer Q1 sign-off ratified.]**
