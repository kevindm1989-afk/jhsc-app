/**
 * Work-refusal types (T14) — OHSA s.43.
 *
 * Source obligations:
 *   - threat-model §3.4 F-21 (RLS — certified_member-only on the
 *     work_refusal + s51_evidence tables; mirrored access for co-chairs
 *     through the same SECURITY DEFINER indirection).
 *   - ADR-0003 Amendment A extension — `work_refusal.read` enum value
 *     (server-emitted; HG-6 mirror).
 *   - ADR-0003 Amendment B (HG-6) — server-side enforced C4 read-audit
 *     via SECURITY DEFINER view + c4_read_service role. T14 inherits
 *     the same pattern as T13 reprisal-log.
 *   - ADR-0003 Amendment D extension (privacy-review §7 obligation 6) —
 *     pseudonymized projection extended to `work_refusal.*` write
 *     events.
 *   - observability/audit-log.md §1 — `work_refusal.*` event shapes
 *     (T14 extension of the closed enum).
 *
 * Per ADR-0002 Amendment H this file ships in T14 (library only). The
 * SupabaseWorkRefusalStore + SQL migration land in T14.1 (sibling task —
 * see G-T14-* entries in `.context/known-gaps.md`).
 *
 * The shape mirrors the T13 reprisal-log split:
 *   - persistent rows + projection rows are typed here;
 *   - the `WorkRefusalStore` interface is the persistence boundary;
 *   - `MemoryWorkRefusalStore` satisfies the interface for tests;
 *   - production `SupabaseWorkRefusalStore` ships in T14.1.
 */

/**
 * Work-refusal entry lifecycle status. Soft-delete is not in T14 scope
 * (s.43 entries follow the underlying-record retention ceiling — Active
 * matter + 7y); the schema is forward-compatible with T13's status set
 * if a future amendment introduces a 4-eyes flow.
 */
export type WorkRefusalStatus = 'open' | 'under_review' | 'closed';

/**
 * Work-refusal intake — what the form submits.
 *
 * Per F-21 the `body` (s.43 notes / refusal narrative) is C4 plaintext.
 * It is encrypted under the committee key BEFORE persisting; the
 * persistent row carries only `notes_ct` (a `Uint8Array`).
 *
 * The library accepts `passphrase` opaquely as a UX-friction shim that
 * mirrors T13; the cryptographic gate remains `ck_priv` per ADR-0003
 * Invariant 1.
 */
export interface WorkRefusalIntake {
  title: string;
  body: string;
  /** Per-record passphrase. Opaque to the library; verified at T14.1. */
  passphrase: string;
}

/**
 * Persistent work-refusal row (server-shape mirror).
 *
 * `title_ct` / `notes_ct` are committee-key-sealed ciphertext. The
 * column name `notes_ct` matches the audit-log + retention schedule
 * for s.43 narrative bodies. `actor_id` is the rep who filed; F-17
 * carries through — there is no anonymous mode on s.43 entries
 * (statutory obligation to identify the filer).
 */
export interface WorkRefusalEntry {
  id: string;
  actor_id: string;
  title_ct: Uint8Array;
  notes_ct: Uint8Array;
  per_record_passphrase_hash: Uint8Array;
  status: WorkRefusalStatus;
  created_at: number;
  updated_at: number;
}

/**
 * Pseudonymized work-refusal-feed projection (Amendment D extension).
 *
 * Structural enforcement: the type DOES NOT carry `actor_pseudonym`.
 * Identical privacy posture to T13's `ReprisalFeedItem` — privacy-
 * review §7 obligation 6 extended Amendment D's projection to cover
 * T14 write events.
 */
export interface WorkRefusalListItem {
  id: number;
  event_type: WorkRefusalAuditEvent;
  /** ms-epoch rounded DOWN to the nearest hour boundary. */
  ts_bucketed_to_hour: number;
  target_id: string;
  target_class: 'C4';
  prev_hash: string;
  hash: string;
}

/**
 * The full closed set of audit events emitted by the work-refusal
 * library.
 *
 * `work_refusal.read` is server-emitted from the SECURITY DEFINER view
 * in production (HG-6 mirror per Amendment A extension); the library
 * mirrors the ordering — emit-then-decrypt — with explicit `await`
 * discipline (same pattern as T13's `reprisal.read`).
 *
 * Adding a new event requires (a) an `observability/audit-log.md`
 * update and (b) a corresponding `observability/alerts.md` entry if
 * actionable. The T14.1 sibling task adds the new values to
 * `scripts/check-audit-enum-coverage.sh`.
 */
export const WORK_REFUSAL_AUDIT_EVENTS = [
  'work_refusal.created',
  'work_refusal.read',
  'work_refusal.update'
] as const;

export type WorkRefusalAuditEvent = (typeof WORK_REFUSAL_AUDIT_EVENTS)[number];
