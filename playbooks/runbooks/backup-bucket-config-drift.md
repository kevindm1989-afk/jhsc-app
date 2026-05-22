# Runbook — Backup bucket config drift (A-BACKUP-001) + freshness (A-BACKUP-002)

**Severity:** P2 (drift) / P1 (freshness).
**Source:** HG-8 / ADR-0012 amendment / F-49. Weekly CI job (drift),
36-hour freshness check.

## When A-BACKUP-001 fires

The weekly Backblaze B2 admin-API check found one or more of:
- versioning is OFF (should be ON),
- Object Lock retention is not 35d governance (drift, possibly accidental
  via console),
- lifecycle rule no longer deletes versions > 42d,
- the workflow credential's grants changed (e.g., gained `DeleteObject`
  or `BypassGovernanceRetention`).

The dashboard 7 tile names the specific drift.

## When A-BACKUP-002 fires

No `backup.completed` event has been observed in the last 36 hours.
Either the backup job didn't run, or it ran but failed silently.

## Immediate triage

### A-BACKUP-001 (drift)

1. **Compare actual vs expected** via dashboard 7.
2. **Determine the drift source:**
   - If someone reconfigured via the B2 console: the user/admin who
     did it; revert in console.
   - If a workflow PR changed bucket-management code: revert the PR.
3. **Restore the spec.** Re-apply versioning ON, Object Lock 35d
   governance, lifecycle 42d, scoped credential grants.
4. **Re-run the drift check** and confirm green before closing.
5. **If credentials were silently elevated** (e.g., DeleteObject added):
   rotate the credential immediately. The escalated credential may
   have been used.

### A-BACKUP-002 (freshness)

1. **Check the GitHub Actions backup workflow run history.** Find the
   most recent run.
2. **If the workflow didn't run:** investigate the schedule trigger.
   GitHub Actions cron is best-effort; if delayed, manually trigger
   one run.
3. **If the workflow ran and failed:** read the log. Common causes:
   - bucket credential rotated and Actions secret not updated,
   - Postgres connection failing (Supabase issue),
   - bucket full / quota exceeded (cost-manager flags).
4. **Catch up.** Run a manual backup. Confirm `backup.completed` event
   appears in the dashboard.

## Escalation

- If drift indicates an unexplained credential change → security-
  reviewer + privacy-reviewer + user; treat as possible platform
  compromise.
- If freshness > 72h → P1 escalation; the 35-day Object-Lock retention
  starts from each object write, so missing backups don't expire what
  exists, but the rolling window erodes.

## Links

- ADR-0012 amendment (Object Lock + versioning + lifecycle).
- Threat model: F-49 (§3.7).
- T17 acceptance: bucket-config tests, drift check, restore drill.
- `playbooks/backup-restore.md` (general procedure).
