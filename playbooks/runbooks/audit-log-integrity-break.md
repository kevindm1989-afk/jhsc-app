# Runbook — Audit-log integrity break (A-AUDIT-001)

**Severity:** P1 — wake the incident-responder.
**Source:** F-50 / T18. Fires within 5 minutes of any of: scheduled
daily check, post-rotation trigger, post-export trigger.

## When this fires

The T18 hash-chain integrity job detected a `prev_hash` mismatch on a
row in `audit_log`. The chain is broken from that row forward. The
tamper-evident guarantee is invalidated until this is reconciled.

## Immediate triage (first 15 minutes)

1. **Acknowledge the page.** Note the timestamp; treat as a real
   tamper event until proven otherwise.
2. **Pull the alert payload.** It contains:
   - `first_bad_seq` — the lowest `id` whose `prev_hash` did not match
   - `last_good_seq` — the highest `id` whose chain still validates
   - `trigger` — `scheduled` / `post_rotation` / `post_export`
3. **Freeze writes if the break is recent.** If `first_bad_seq` is
   within the last hour, REVOKE INSERT from `audit_writer_role`
   temporarily — better to refuse new writes than to extend a broken
   chain. (This blocks the app's mutating paths; that is intended.)
4. **Snapshot the chain from a known-good source.** The
   incident-responder pulls the most recent backup (T17) and computes
   the chain head locally; compare with current `chain-head hash` from
   dashboard 6 tile 2.

## Escalation

- Incident-responder → co-chair (P1 routing already includes both).
- If `first_bad_seq` is in a window containing a `reprisal.*`,
  `export.generated`, or `committee_data_key.rotation.*` row →
  privacy-reviewer is paged additionally. The break may correlate with
  a real misuse.
- If the snapshot from backup also shows a chain break at the same
  seq → the corruption pre-dates the backup; this is a platform-side
  forgery scenario (A5 archetype, threat model §2).
- If platform-side forgery is suspected → **stop**, do not proceed
  with remediation alone. Loop in user (committee co-chair) and
  privacy lawyer per HG-10.

## Links

- Threat model: F-50 (§3.6).
- ADR-0003 Amendment A (chain construction).
- `observability/audit-log.md` §2, §5.
- `playbooks/incident-response.md` (general process).
