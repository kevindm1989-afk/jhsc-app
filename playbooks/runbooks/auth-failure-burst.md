# Runbook — Auth failure burst (A-AUTH-001) + passkey-without-TOTP-removal (A-AUTH-002)

**Severity:** P2.
**Source:** T05 / F-40 / F-42 / F-43 / T8 (enumeration).

## A-AUTH-001 — Auth failure burst

### When this fires

> 10 auth failures in 5 minutes from one IP (truncated to /24) OR
from one `actor_pseudonym`.

### Possible causes (descending likelihood)

1. **Legitimate user retrying after a passkey hiccup.** Most common.
   Look for a corresponding success within minutes.
2. **TOTP-bootstrap brute force** (F-38). Should fall to the rate
   limit at 5/15min; if the burst is across many users, possibly an
   enumeration attempt — but T8 mitigation means responses don't
   differentiate, so the attacker gets no signal anyway.
3. **WebAuthn flood / DoS** (F-42).
4. **Targeted attack on a single user.** If the burst is concentrated
   on one `actor_pseudonym`, the user's account may be specifically
   targeted.

### Immediate triage

1. **Check the dashboard 1 tile 5** for the alert window.
2. **Determine whether the burst is concentrated** on one IP or one
   actor:
   - Single IP + many actors → enumeration / scraping; rate limits are
     working. Watch for escalation.
   - Single actor + many IPs → distributed attack on one user.
     Co-chair should reach the user OUT OF BAND and ask whether they
     are seeing failures. Consider revoking the user's sessions and
     re-issuing a TOTP invite.
   - Single IP + single actor → likely user retry. No action.
3. **If the burst correlates with deploys** (last hour): the recent
   deploy likely broke the auth flow. Rollback-orchestrator.

### Escalation

- Multiple bursts within 24h → P1 escalation; possible coordinated
  attack.
- Burst + a `session.revoked` of suspicious origin → assume the user
  is compromised; freeze the account.

## A-AUTH-002 — Passkey enrollment without TOTP-bootstrap-removal

### When this fires

An `auth.passkey.enrolled` audit row exists for a user without the
corresponding `users.totp_destroyed_at` set in the same transaction.
This means the TOTP secret remains usable AFTER the passkey was bound
— a permanent bypass.

### Immediate triage

1. **Treat as a P2 security regression** in T05's enrollment flow.
2. **Verify in DB:** query `users` for the affected `actor_pseudonym`;
   confirm `totp_destroyed_at IS NULL`.
3. **Forcibly destroy the TOTP** via a one-off migration or admin
   action; emit a manual audit row recording the action.
4. **Roll back the deploy** that introduced the regression. The flow
   must be a single transaction (ADR-0002, F-43 test).
5. **Notify the affected user** to re-enroll their passkey (the TOTP
   bypass means their auth model is weaker than expected).

### Escalation

- Multiple users affected → freeze TOTP-issuance entirely until fixed;
  loop in second-opinion-reviewer (auth).

## Links

- T05 acceptance (auth tests).
- Threat model: F-40, F-42, F-43, T8.
- ADR-0002 (passkey-first auth).
- `playbooks/incident-response.md` §5 (Auth).
