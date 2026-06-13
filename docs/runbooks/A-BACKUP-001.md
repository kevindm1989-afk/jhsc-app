# `A-BACKUP-001` — backup object still locked past the 42-day window

**Audience:** the on-call operator. The 42-day backup-retention pass tried to hard-delete a manifest's object but the object-lock window had not yet expired.

**Authority:** ADR-0018 §J (42-day hard-delete); threat-model §3.10 F-75 (cooperative-caller defense — `still_locked` past window); `apps/web/src/lib/backup/backup-core.ts` (where `would_fire_alert: 'A-BACKUP-001'` originates); `apps/web/src/lib/alerts/result-adapters.ts` (dispatch).

**Severity:** **page**. A `still_locked` past 42d means the bucket's object-lock policy has drifted from the library's `BACKUP_OBJECT_LOCK_DAYS = 42` constant, OR an operator extended a hold without coordinating. Either way, the retention pass cannot age out the manifest, which over time will accumulate cost AND violate the operational-table retention schedule.

**Pager source:** structured-log line `event: 'alert.fired'` with `alert.symbol: 'A-BACKUP-001'`.

---

## §1. What this means

`runBackupRetentionPass` iterated committed manifests older than `BACKUP_HARD_DELETE_DAYS = 42` and called `store.deleteObjectIfUnlocked(object_ref)`. At least one object returned `{deleted: false, reason: 'still_locked'}` even though the manifest's `committed_at_ms` is `>= 42d` old.

The pass DID NOT hard-delete the manifest row (the row stays as `committed`, age continues to grow). The next pass will try again.

---

## §2. Diagnose

1. **Grab `alert.deleted_count`** from the alert meta — that's the count that DID succeed in the same pass. Non-zero means partial progress.
2. **Find the offending manifests:**
   ```sql
   SELECT run_id, object_ref, committed_at_ms, object_lock_until_ms,
          (extract(epoch from now()) * 1000)::bigint - committed_at_ms AS age_ms
     FROM public.backup_manifests
    WHERE manifest_status = 'committed'
      AND committed_at_ms < (extract(epoch from now()) * 1000)::bigint
                            - (42::bigint * 86400000)
    ORDER BY committed_at_ms ASC;
   ```
3. **Check the bucket's policy.** In the Supabase Storage console (or AWS S3 console if the bucket pre-dates the migration), inspect the object-lock policy on the offending object_ref. The retention mode should be `governance` (NOT `compliance` — compliance can ONLY be removed by AWS root account) and the retention period should be `≤ 42 days`.

---

## §3. Respond

- **Policy drift on the bucket.** If §2.3 shows the bucket policy is longer than 42d, the bucket was provisioned (or recently re-configured) with a non-matching policy. **Do not** widen `BACKUP_OBJECT_LOCK_DAYS` in code — that's an ADR-0018 §J amendment, not an operator change. The correct fix is to update the bucket policy back to `42d` and wait for the existing objects' locks to expire naturally. Document the bucket-policy change in the on-call log.
- **Operator-extended hold.** If a member of the team manually extended an object's lock (e.g., for litigation hold), the manifest's row stays as a documented exception. Tag it in `public.backup_manifests.object_ref` via the on-call log; suppress this alert for that `run_id` via the alert sink's suppression list (see [observability/alerts.md](../../observability/alerts.md)).
- **Unexplained.** Page the SRE on-call. Likely the bucket's vendor changed its policy semantics (rare but possible after a vendor maintenance window).

---

## §4. Escalate

- Bucket-policy drift on a regulated-PI bucket → privacy-reviewer (PIPEDA Safeguards principle — over-retention IS a finding).
- Suspected vendor-side policy change → architect (re-evaluate ADR-0018 §J in light of vendor behaviour).
- The bucket is offline / cross-region replication failed → SRE on-call + Supabase support.

---

## §5. Post-mortem trigger

Any case that reaches §4 OR persists across two consecutive nightly passes without explanation. Capture the affected `run_id` list, the bucket policy snapshot, and the timeline of the lock-extension (if operator-driven).

---

## §6. Known false positives

None known at time of writing (M9). The library uses `lock_until_ms < nowMs()` strictly; clock-skew false positives are bounded by the deploy-time NTP sync.
