# Runbook — Export anomaly (A-EXPORT-001) / rate spike (A-EXPORT-002)

**Severity:** P2.
**Source:** RA-1 / F-19 / F-24 / F-28 / F-32. T11 + T12.

## A-EXPORT-001 — Export anomaly

### When this fires

One of:
1. An `export.generated` audit row appeared without a paired
   `export.contained_concern_derived_items` row when
   `derived_from_concerns?` would be non-empty (RA-1 contract: the
   second-class row must accompany the first).
2. The export-to-audit-write transaction split — an `export.generated`
   row exists, but the structured log shows the Blob URL was created
   for the same `request_id` BEFORE the audit-row INSERT timestamp.
   (F-24 contract is reversed.)

Either indicates the export pathway is not following the
compensating controls that make RA-1 defensible.

### Immediate triage

1. **Confirm which condition fired** from the alert payload.
2. **Pull the export's `request_id`.** Walk the structured logs +
   audit rows to confirm the ordering / pairing was indeed wrong.
3. **If F-24 ordering was reversed** (Blob before audit):
   - The export occurred without a guaranteed audit. This is a
     LAUNCH-BLOCKER class defect — the post-export rep notification
     and the social-norm backstop both depend on the audit being
     written first.
   - Roll back the deploy that introduced the regression.
   - File a privacy-reviewer ticket: did any export in the regression
     window go undocumented? If yes, manually emit an audit row + a
     `export.contained_concern_derived_items` row to make the
     committee whole, then notify all active members.
4. **If RA-1 pair-row is missing** (concern-derived items not
   recorded):
   - The compensating control "visible concern-derived items flag" is
     impaired.
   - Same rollback + retroactive-audit procedure as above.
5. **In either case:** RA-1 trigger #5 ("loss of the post-export
   notification surface or the audit-log emission") has just been hit
   — RA-1 must be re-opened. Loop in architect + privacy-reviewer per
   the re-opening procedure.

## A-EXPORT-002 — Export rate spike

### When this fires

> 5 exports in 1 hour (the rate-limit per F-28 is 10/hour, so this
fires at 50% of the ceiling).

### Possible causes

1. **Pre-meeting export rush** — co-chair preparing for a JHSC meeting.
   Common; benign.
2. **A bug retrying an export** that thinks it failed but actually
   succeeded.
3. **A coerced co-chair being walked through exports.**

### Immediate triage

1. **Talk to the co-chair OUT OF BAND.**
2. **Inspect the export feed** (dashboard 3). Are exports for distinct
   target_ids (legitimate) or duplicates (bug)?
3. **If duplicates** — investigate the export client; the rate-limit
   protects us but the duplicates suggest a state-machine bug.
4. **If coercion is plausible** — same procedure as
   `sensitive-read-spike.md`.

## Escalation

- A-EXPORT-001 + reprisal incident → invoke RA-1 re-open procedure;
  default response is to upgrade to full 4-eyes.

## Links

- RA-1 (single-signer export risk acceptance + compensating controls).
- ADR-0001 "Linked risk acceptances" pointer.
- Threat model: F-19 (LAUNCH BLOCKER), F-24, F-28, F-29, F-32.
- T11 / T12 acceptance.
