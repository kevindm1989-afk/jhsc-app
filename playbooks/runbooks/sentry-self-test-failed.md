# Runbook — Sentry self-test failed / scrub canary tripped (A-SENTRY-001)

**Severity:** P1.
**Source:** T02 / ADR-0010.

## When this fires

Either:
1. **Self-test absent.** A synthetic error tagged `sentry.selftest=1`
   is emitted at every deploy startup. It MUST appear in Sentry's
   Issues API within 5 minutes. If not, this alert fires.
2. **PanicSink invoked.** The Sentry scrubber's `PanicSink` (see
   `observability/sentry-scrub.ts`) was called within the last hour.
   `PanicSink` fires for one of three reasons:
   - `canary` — a canary string survived all the scrubbing and was
     about to be sent. The scrubber dropped the event AND raised here.
   - `c4_field` — a key from the `C4_KEY_PANIC` set appeared in an
     event tree. The scrubber dropped the event AND raised here.
   - `oversize` — an event > 15 KB was about to be sent (probable
     accidental payload dump). Dropped + raised.

## Immediate triage

### Branch 1: self-test absent

1. **Confirm Sentry is up.** Hit Sentry status page out of band. If
   Sentry-side outage: page incident-responder; nothing to fix our
   side; resume self-test when Sentry returns.
2. **Check the deploy.** Did the most recent deploy actually start the
   browser code path that emits the self-test? Health-check endpoint?
3. **Check Sentry DSN.** Did the deploy's env include
   `PUBLIC_SENTRY_DSN`? Misconfigured DSN means the SDK silently
   no-ops.
4. **Check the bundle.** Did the build bundle `@sentry/browser`? (CI
   gate exists — if it's missing the bundle, CI should have already
   blocked the deploy. If it didn't, that's a separate finding.)
5. **Check the CDN-rule violation.** JHSC-APP-PLAN.md §7 forbids
   loading Sentry from sentry.io's CDN. If a recent PR introduced a
   CDN script tag, the strict CSP should have blocked it. If the CSP
   was relaxed, treat it as a P1 regression.

### Branch 2: PanicSink invoked

#### `canary` — a canary string survived scrubbing

**This is a scrubber failure.** It means an event was about to leave
the browser carrying a real canary value. Treat with the same urgency
as a near-miss PI leak.

1. **Capture the event metadata** from the panic payload (`event_id`).
   The event was dropped — it did NOT reach Sentry — so Sentry has
   nothing to query. The canary's presence is itself the diagnostic.
2. **Re-run the scrubber test fixture.** A failing test reproduces
   the regression and isolates the field that leaked.
3. **Roll back the deploy** that introduced the regression.
4. **File a privacy-reviewer ticket.** Even though the event was
   dropped, the regression means future events MAY leak — and a
   different canary (real PI) might not exist to trip the panic.

#### `c4_field` — a C4 key appeared in an event

**This is a P0-class incident.** A code path attempted to send a
stack trace or event tree containing a C4 column name. Even though
the scrubber dropped the event, the appearance means a code path is
serializing C4 content close to the error-reporting boundary.

1. **Identify the code path** from the panic meta. The `event_id` is
   helpful; if the event was a captured exception, the
   `error_class` and the stack trace's top frames identify the call
   site.
2. **Stop the bleeding.** Disable the affected feature flag (T15 +
   feature_flags table) immediately if available; otherwise roll back.
3. **Privacy-reviewer + security-reviewer + user.** PIPEDA breach-
   notification map (§5 threat model) says C4 leakage near-miss is
   P0-treat-as-breach-pending-confirmation. Determine: did any C4
   content actually traverse to Sentry on a previous deploy of the
   same code path? If yes → breach notification flow.

#### `oversize` — an event > 15 KB

**Less severe individually; common cause is a stack trace that
serialized a large state object.**

1. **Inspect the call site** from the panic meta.
2. **If the oversize is a synthetic dump** (someone passed an entire
   form to a logger): file a fix. The scrubber did its job.
3. **If repeated:** the implementer needs to add a smaller error-
   carrying shape; the call site is leaking shape, not necessarily PI.

## Escalation

- Branch 2 `c4_field` always escalates to user + privacy-reviewer.
- Branch 2 `canary` escalates if it reproduces on a clean deploy.
- Branch 1 self-test-absent for > 1 hour after rollback → assume
  Sentry SDK is broken in our build; freeze deploys until fixed.

## Links

- ADR-0010 (Sentry SaaS + SDK scrubbing).
- `observability/sentry-scrub.ts` (the scrubber itself + fixture).
- `observability/README.md` §2 (PI scrubbing posture).
- Threat model: T9 (telemetry leakage), F-09 (Edge Function logs), §5
  (breach notification map).
- `playbooks/incident-response.md`.
