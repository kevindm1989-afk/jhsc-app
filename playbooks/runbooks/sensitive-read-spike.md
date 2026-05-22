# Runbook — Sensitive (C4) read spike (A-C4-001) / feed stalled (A-C4-FEED)

**Severity:** P2.
**Source:** HG-6 / ADR-0003 Amendment B / F-33 / T13.

## A-C4-001 — Sensitive-read burst

### When this fires

> 10 `reprisal.read` events from one `actor_pseudonym` in a 5-minute
window, OR > 30 across the committee in 1 hour.

### Possible causes (descending likelihood)

1. **A rep is reviewing reprisal-log history** for a meeting or a
   filing. The most common cause. Triage by talking to the rep, not
   by reading their reads.
2. **A coerced rep is being walked through reprisal entries** by a
   coercive actor (T11 archetype).
3. **A compromised passkey is being used** to scrape C4 content.
4. **A bug in a list-view fans out unintentional reads.** (e.g., a
   page that re-reads every C4 row on a refresh.)

### Immediate triage

1. **The actor is named (by pseudonym) only to the co-chair.** The
   incident-responder is paged but the user is the one who maps the
   pseudonym to a member.
2. **Reach the rep OUT OF BAND** (phone / in person). Ask:
   - Are you currently working on a reprisal review?
   - Is anyone with you who shouldn't be?
   - Is your device in your possession?
3. **If the rep confirms it's their work** — no action; mark the alert
   acknowledged in the runbook log.
4. **If the rep is unreachable, or says no** — assume coercion or
   compromise:
   - Revoke their sessions immediately.
   - Notify the co-chair to convene a committee discussion about the
     reprisal entries that were read (the audit rows name the
     `target_id`s; the entries themselves remain encrypted).
   - File an incident per `playbooks/incident-response.md` §4
     (Coercion / duress).
5. **If the burst is across multiple actors** — look for a UI bug
   that's fanning out reads. Roll back recent deploys.

### Escalation

- If the user under coercion is the co-chair → second co-chair (if
  any) makes the freeze decision; otherwise the user (committee
  designate) does. Time-sensitive.

## A-C4-FEED — Sensitive-read feed stalled

### When this fires

The "recent sensitive activity" feed surface stopped updating for >
1 hour. This is a P2 because the social-norm backstop relies on
visibility; if the feed is blind, the deterrent is weaker.

### Immediate triage

1. **Check the dashboard 4 status tile.**
2. **Inspect the SECURITY DEFINER view** — has the `c4_read_service`
   role's INSERT grant on `audit_log` been revoked? If yes (someone
   reverted it) → restore the grant immediately; this also breaks the
   atomicity test (HG-6).
3. **Check for a pg_cron / Edge Function failure** that powers the
   feed materialization.
4. **Confirm: are C4 reads still happening?** If no rows AT ALL in
   24h, the surface looks stalled because there are genuinely zero
   reads — not a failure. (Unlikely in a real workplace.)

### Escalation

- Feed stalled + recent deploy touching audit_log RLS → rollback.
- Feed stalled + concurrent A-AUDIT-001 → assume tampering;
  follow the audit-log-integrity-break runbook.

## Links

- ADR-0003 Amendment B (server-side enforced C4 read-audit).
- Threat model: F-33 (§3.4), Invariant 7 strengthened (§6), T11 (§4.5).
- T13 / T14 acceptance.
- `playbooks/incident-response.md` §4 (Coercion / duress).
