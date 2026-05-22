# Runbook — Offline-queue HMAC integrity failure (A-QUEUE-001)

**Severity:** P2 — next business hour.
**Source:** HG-4 / ADR-0014 / F-44. Per-occurrence trigger on any
`inspection.synced.hmac_fail` audit row.

## When this fires

A queued inspection entry's BLAKE2b-256 HMAC did not validate at
drain time. The entry was quarantined to `rejected_queue_entries` and
NOT uploaded. Either:

- a local attacker / malicious browser extension wrote a forged row
  into the user's IndexedDB queue, or
- the user copied a queue entry between devices (cross-device replay),
  which is also rejected by the user_id binding in the MAC scope.

## Immediate triage (first business hour)

1. **Identify the actor.** The audit row carries the
   `actor_pseudonym` of the user whose drain failed. The incident-
   responder cannot reverse the pseudonym — escalate to the co-chair
   who can map it to a member via the HMAC key.
2. **Reach out to the user OUT OF BAND.** Phone or in-person, NOT
   through the app. Confirm whether they recently:
   - moved between devices,
   - installed a new browser extension,
   - had their device out of their possession,
   - tried to restore from a backup.
3. **If the user has no innocent explanation:**
   - Treat as a possible T2 (employer-device) or T6 (theft) event.
   - Request the user trigger panic-wipe (T19) — clears IndexedDB.
   - Revoke the user's sessions.
   - Co-chair issues a fresh TOTP invite for re-enrollment.
4. **Preserve the quarantined entry** for forensics — the
   `rejected_queue_entries` store on the device should be exported
   before the wipe if feasible.

## Escalation

- If multiple `queue.integrity_fail` from the same actor in 24h →
  upgrade to P1; treat as confirmed device compromise.
- If multiple `queue.integrity_fail` from different actors in 24h →
  this is not a single-device problem; consider a shared malicious
  extension or a build-side bug. Loop in the implementer + the
  security-reviewer.

## Links

- Threat model: F-44 (§3.6).
- ADR-0014 (offline queue HMAC).
- T10 acceptance: HMAC integrity tests.
- `playbooks/incident-response.md`.
