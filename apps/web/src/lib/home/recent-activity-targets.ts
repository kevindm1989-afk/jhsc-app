/**
 * Pure mapping from a canonical audit `event_type` to the worker-side
 * route that surfaces that kind of event. Powers the "click a row to
 * jump to the register" affordance on the home Recent Activity card.
 *
 * Falls back to `/audit` for events that don't map to a specific
 * register surface (read events, retention passes, rate-limit events,
 * etc.) — the audit log is the canonical place to inspect them.
 */

export function eventTypeToHref(event_type: string): string {
  if (event_type.startsWith('concern.')) return '/concerns';
  if (event_type.startsWith('reprisal.')) return '/reprisal';
  if (event_type.startsWith('work_refusal')) return '/work-refusal';
  if (event_type.startsWith('s51_evidence')) return '/s51-evidence';
  if (event_type.startsWith('recommendation')) return '/recommendations';
  if (event_type.startsWith('inspection')) return '/inspections';
  if (event_type.startsWith('minutes')) return '/minutes';
  if (
    event_type.startsWith('session.') ||
    event_type.startsWith('panic_wipe') ||
    event_type.startsWith('recovery_blob') ||
    event_type.startsWith('identity_keypair')
  ) {
    return '/settings';
  }
  // committee_member.*, audit_log.read, retention.pass, rate_limit,
  // client.*, queue.integrity_fail → drop to the audit log where the
  // full row is inspectable.
  return '/audit';
}
