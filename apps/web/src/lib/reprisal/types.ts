/**
 * Reprisal log types (T13).
 *
 * Source obligations:
 *   - threat-model §3.4 F-30..F-36, F-53 (passphrase_prompt variant).
 *   - ADR-0003 Amendment B (HG-6) — server-side enforced C4 read-audit via
 *     SECURITY DEFINER view + c4_read_service role.
 *   - ADR-0003 Amendment C extension (HG-11) — protected-modal trap-on-mount.
 *   - ADR-0003 Amendment D (HG-13) — pseudonymized reprisal-feed projection.
 *   - ADR-0003 Amendment E (HG-13) — forensic-reveal 4-eyes procedure.
 *   - ADR-0007 amendment (HG-13) — reprisal-intake consent surface.
 *   - observability/audit-log.md — reprisal.* event shapes.
 *
 * Per ADR-0002 Amendment H this file ships in T13 (library only). The
 * SupabaseReprisalStore + SQL migration land in T13.1 (sibling task —
 * see G-T13-* entries in `.context/known-gaps.md`).
 *
 * The shape mirrors the T05 AuthStore / T07 KeyStore / T08 ConcernStore
 * split:
 *   - persistent rows + projection rows are typed here;
 *   - the `ReprisalStore` interface is the persistence boundary;
 *   - `MemoryReprisalStore` satisfies the interface for tests;
 *   - production `SupabaseReprisalStore` ships in T13.1.
 */

/**
 * Reprisal entry lifecycle status. The `deleted` status is the soft-delete
 * sentinel per HG-7 — the row stays in the table (only the retention job
 * hard-deletes after the active matter + 7y window). Status flips to
 * `deleted` AND every other status change require the 4-eyes flow.
 */
export type ReprisalStatus = 'open' | 'under_review' | 'closed' | 'deleted';

/**
 * Reprisal intake — what the form submits.
 *
 * The body is the highest-sensitivity (C4) plaintext in the system. It is
 * encrypted under the committee key BEFORE persisting; the persistent row
 * carries only `body_ct` (a `Uint8Array`).
 *
 * Per F-34 the `per_record_passphrase` is a UX friction layer ONLY (the
 * cryptographic gate is `ck_priv` + the per-record key wrapped to
 * `ck_pub`). The library accepts the string opaquely; the production
 * SupabaseReprisalStore (T13.1) wires the bcrypt/argon2 verify step.
 */
export interface ReprisalIntake {
  title: string;
  body: string;
  /** Per-record passphrase. Opaque to the library; verified at T13.1. */
  passphrase: string;
}

/**
 * Persistent reprisal row (server-shape mirror).
 *
 * `title_ct` / `body_ct` are committee-key-sealed ciphertext. `actor_id`
 * is the author — F-17 invariant carries through; the author IS recorded
 * (there is no anonymous mode on reprisal entries, per design-system §4 C).
 *
 * `per_record_passphrase_hash` is an opaque server-shaped hash placeholder
 * — the library does not enforce a value, but stores the supplied
 * passphrase as an HMAC hash so the production store's verify step
 * (T13.1) has a slot to consume.
 */
export interface ReprisalEntry {
  id: string;
  actor_id: string;
  title_ct: Uint8Array;
  body_ct: Uint8Array;
  per_record_passphrase_hash: Uint8Array;
  status: ReprisalStatus;
  created_at: number;
  updated_at: number;
}

/**
 * Pseudonymized reprisal-feed projection (Amendment D).
 *
 * Structural enforcement: the type DOES NOT carry `actor_pseudonym`. The
 * `ts_bucketed_to_hour` is the ms-epoch of the original event rounded
 * DOWN to the nearest hour boundary; the underlying `audit_log.ts`
 * retains microseconds for forensic-reveal use (Amendment E).
 *
 * Privacy-review §7 obligation 1 — closed set of columns.
 */
export interface ReprisalFeedItem {
  id: number;
  event_type: ReprisalAuditEvent;
  /** ms-epoch rounded DOWN to the nearest hour boundary. */
  ts_bucketed_to_hour: number;
  target_id: string;
  target_class: 'C4';
  prev_hash: string;
  hash: string;
}

/**
 * The full closed set of audit events emitted by the reprisal library.
 *
 * `reprisal.read` is server-emitted from the SECURITY DEFINER view in
 * production (HG-6); the library mirrors the ordering — emit-then-decrypt
 * — with explicit `await` discipline. The audit row commits BEFORE the
 * plaintext returns. See `reprisal-core.ts:readReprisalEntry`.
 *
 * Adding a new event requires (a) an `observability/audit-log.md` update
 * and (b) a corresponding `observability/alerts.md` entry if actionable.
 */
export const REPRISAL_AUDIT_EVENTS = [
  'reprisal.created',
  'reprisal.read',
  'reprisal.update',
  'reprisal.status_changed.4eyes_pending',
  'reprisal.status_changed.4eyes_completed',
  'sensitive.access_attempt',
  'audit.forensic_reveal.4eyes_pending',
  'audit.forensic_reveal.4eyes_completed'
] as const;

export type ReprisalAuditEvent = (typeof REPRISAL_AUDIT_EVENTS)[number];

/**
 * Pending 4-eyes operation (status flip OR forensic reveal).
 *
 * The schema mirrors the architect's `pending_destructive_ops` /
 * `pending_forensic_reveals` table shapes ratified in ADR-0003 Amendment B
 * + Amendment E. Columns:
 *   - `proposer_id`: the actor who proposed (REQUIRED).
 *   - `approver_id`: the actor who approved (NULL until approval).
 *   - `target_table`: 'reprisal_log' or 'audit_log'.
 *   - `target_id`: the row being modified / revealed.
 *   - `kind`: 'status_flip' | 'forensic_reveal'.
 *   - `new_status` / `reveal_reason`: kind-discriminated metadata.
 *   - `expires_at`: 24h after creation for forensic reveals.
 *   - `revealed_actor_pseudonym`: populated on approve for forensic
 *     reveals; cleared on expiry.
 */
export interface PendingFourEyesOp {
  id: string;
  kind: 'status_flip' | 'forensic_reveal';
  proposer_id: string;
  approver_id: string | null;
  target_table: 'reprisal_log' | 'audit_log';
  target_id: string;
  new_status: ReprisalStatus | null;
  reveal_reason: string | null;
  created_at: number;
  expires_at: number | null;
  expired_at: number | null;
  revealed_actor_pseudonym: string | null;
}

/**
 * Member role — used by the role-pairing rule (co-chair + co-chair OR
 * co-chair + certified_member). Mirrors the SQL `members.role` enum.
 */
export type MemberRole =
  | 'worker_member'
  | 'worker_co_chair'
  | 'employer_member'
  | 'employer_co_chair'
  | 'certified_member';
