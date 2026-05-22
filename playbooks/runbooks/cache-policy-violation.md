# Runbook — Service-worker cache-policy violation (A-SW-001)

**Severity:** P2 — next business hour.
**Source:** HG-3 / ADR-0013 / F-10. Per-occurrence trigger on any
`client.cache_policy_violation` audit row.

## When this fires

The service-worker fetch handler's sanity check rejected a response for
caching because:

- the response carried `X-Data-Class: C3` or `X-Data-Class: C4`, AND
- the URL was matched (or would have been matched) by a cacheable
  handler — meaning the URL allowlist and the data class disagreed.

In steady state this should NEVER fire. A non-zero count means either
(a) the URL allowlist was changed without updating the snapshot test
(implementation bug), or (b) the server started emitting
`X-Data-Class` on a route the SW expected to be C0/C1 (server bug).

## Immediate triage (first business hour)

1. **Confirm the violation is genuine.** Pull the audit row's `route`
   and `data_class`. Cross-reference against the SW snapshot
   (`apps/web/test/sw-cache.snapshot.test.ts`).
2. **Decide which side is wrong:**
   - If the URL is supposed to be C0/C1 (e.g., `/library/...` returning
     a public doc): the **server** is wrong — it's emitting
     `X-Data-Class: C3` for a non-C3 response. File a bug; the server
     handler is the one to fix.
   - If the URL is supposed to be cacheable (e.g., `/_app/...` static
     bundle) but the server returned C3: investigate whether a build
     output started shipping a sensitive payload (much more serious).
   - If the URL is `/api/...` and the SW had it in the allowlist: the
     **allowlist is wrong** — remove it. SW snapshot will reject the
     next CI run if you forgot to also delete the snapshot entry.
3. **Check for cached leakage.** If the response went to cache before
   the sanity check (race condition possible if the check is async):
   - Roll a build-hash bump so all SWs invalidate caches on next load.
   - Notify all active members to refresh.

## Escalation

- If the violating URL returned an actual C3/C4 ciphertext: privacy-
  reviewer + security-reviewer paged. This is close to (but not
  necessarily) a breach — confirm the cache did NOT retain the entry.
- If the violation appears multiple times in different routes within
  24h: pull the deploy that introduced the regression; consider rolling
  back (rollback-orchestrator).

## Links

- Threat model: F-10 (§3.1).
- ADR-0013 (service-worker cache allowlist).
- T10 acceptance: SW snapshot test, sanity check test.
- `apps/web/test/sw-cache.snapshot.test.ts`.
