/**
 * s.51 critical-injury evidence types (T14) — OHSA s.51.
 *
 * Source obligations:
 *   - threat-model §3.4 F-21 (RLS — certified_member-only on the
 *     work_refusal + s51_evidence tables; co-chair read via SECURITY
 *     DEFINER view indirection).
 *   - ADR-0003 Amendment A extension — `s51_evidence.read` enum value
 *     (server-emitted; HG-6 mirror).
 *   - ADR-0003 Amendment B (HG-6) — server-side enforced C4 read-audit
 *     via SECURITY DEFINER view + c4_read_service role.
 *   - ADR-0003 Amendment D extension (privacy-review §7 obligation 6) —
 *     pseudonymized projection extended to `s51_evidence.*` write
 *     events.
 *   - HG-5 cross-reference (ADR-0011 amendment) — s.51 evidence photos
 *     go through the same strip-EXIF + canvas-reencode pipeline as
 *     T10 inspection photos.
 *   - observability/audit-log.md §1 — `s51_evidence.*` event shapes
 *     (T14 extension of the closed enum).
 *
 * Per ADR-0002 Amendment H this file ships in T14 (library only). The
 * SupabaseS51EvidenceStore + SQL migration land in T14.1 (sibling
 * task — see G-T14-* entries in `.context/known-gaps.md`).
 */

/**
 * s.51 evidence lifecycle status. Statutory critical-injury records
 * are preserved (no soft-delete in T14); the retention ceiling is the
 * underlying-record schedule (Active matter + 7y).
 */
export type S51EvidenceStatus = 'open' | 'under_review' | 'closed';

/**
 * s.51 evidence intake — what the form submits.
 *
 * The narrative `body` is C4 plaintext. It is encrypted under the
 * committee key BEFORE persisting. Photos (s.51 scene evidence) flow
 * through the HG-5 sanitize pipeline (strip EXIF/IPTC/XMP, canvas
 * re-encode) BEFORE the secretbox seal so workplace GPS coordinates
 * never reach DB ciphertext or backup blobs.
 */
export interface S51EvidenceIntake {
  title: string;
  body: string;
  /** Per-record passphrase. Opaque to the library; verified at T14.1. */
  passphrase: string;
  /**
   * Optional scene photos. Each entry is the raw JPEG bytes the
   * worker captured; the library will strip metadata + re-encode +
   * encrypt before persisting (HG-5 ordering: sanitize-BEFORE-encrypt).
   */
  photos?: Uint8Array[];
}

/**
 * Persistent s.51 evidence row (server-shape mirror).
 *
 * `title_ct` / `notes_ct` are committee-key-sealed ciphertext. The
 * `photos_ct` is an array of per-photo sealed blobs (each blob is
 * `nonce || ciphertext`).
 */
export interface S51EvidenceEntry {
  id: string;
  actor_id: string;
  title_ct: Uint8Array;
  notes_ct: Uint8Array;
  photos_ct: Uint8Array[];
  per_record_passphrase_hash: Uint8Array;
  status: S51EvidenceStatus;
  created_at: number;
  updated_at: number;
}

/**
 * Pseudonymized s.51-evidence-feed projection (Amendment D extension).
 *
 * Structural enforcement: the type DOES NOT carry `actor_pseudonym`.
 * Identical privacy posture to T13's `ReprisalFeedItem` — privacy-
 * review §7 obligation 6 extended Amendment D's projection to cover
 * T14 write events.
 */
export interface S51EvidenceListItem {
  id: number;
  event_type: S51EvidenceAuditEvent;
  /** ms-epoch rounded DOWN to the nearest hour boundary. */
  ts_bucketed_to_hour: number;
  target_id: string;
  target_class: 'C4';
  prev_hash: string;
  hash: string;
}

/**
 * The full closed set of audit events emitted by the s.51 evidence
 * library.
 *
 * `s51_evidence.read` is server-emitted from the SECURITY DEFINER view
 * in production (HG-6 mirror per Amendment A extension); the library
 * mirrors the ordering — emit-then-decrypt — with explicit `await`
 * discipline (same pattern as T13's `reprisal.read`).
 *
 * Adding a new event requires (a) an `observability/audit-log.md`
 * update and (b) a corresponding `observability/alerts.md` entry if
 * actionable. The T14.1 sibling task adds the new values to
 * `scripts/check-audit-enum-coverage.sh`.
 */
export const S51_EVIDENCE_AUDIT_EVENTS = [
  's51_evidence.created',
  's51_evidence.read',
  's51_evidence.update',
  's51_evidence.create.rejected'
] as const;

export type S51EvidenceAuditEvent = (typeof S51_EVIDENCE_AUDIT_EVENTS)[number];
