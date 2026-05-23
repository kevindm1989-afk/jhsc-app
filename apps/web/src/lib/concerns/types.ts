/**
 * Concern intake types (T08).
 *
 * Source obligations:
 *   - ADR-0007 — committee-members-only intake; no public-write route.
 *   - threat-model §3.2 F-15..F-20 — RLS, audit, anonymous toggle, list-payload
 *     exclusion, rate limit.
 *   - observability/audit-log.md — `concern.created`, `concern.updated`,
 *     `concern.source_revealed` event shapes.
 *   - design-system §4 Surface B — anonymous toggle defaults ON.
 *
 * Per ADR-0002 Amendment H, this file ships in T08 (library only). The
 * SupabaseConcernStore + SQL migration land in T08.1 (sibling task).
 *
 * The shape mirrors the T05 AuthStore / T07 KeyStore split:
 *   - persistent rows are typed here;
 *   - the `ConcernStore` interface is the persistence boundary;
 *   - `MemoryConcernStore` satisfies the interface for tests;
 *   - production `SupabaseConcernStore` ships in T08.1.
 */

/** Hazard classification — synced with the C1 enum on `concerns.hazard_class`. */
export type HazardClass =
  | 'physical'
  | 'chemical'
  | 'biological'
  | 'ergonomic'
  | 'psychosocial'
  | 'other';

/** Severity ordinal — synced with the C1 enum on `concerns.severity`. */
export type Severity = 'low' | 'medium' | 'high' | 'critical';

/** Concern source mode. Default is `'anonymous'` per F-17 structural lock. */
export type ConcernSource = 'anonymous' | 'named';

/**
 * Concern intake — what the form submits.
 *
 * `source_name_plaintext` is the worker's name when `anonymous === false`.
 * The intake pipeline encrypts it under the committee key BEFORE persisting;
 * the persistent row carries only `source_name_ct` (a `Uint8Array`).
 *
 * Per F-17 the audit row carries the submitter's pseudonym REGARDLESS of
 * `anonymous`. The `anonymous` flag affects what is stored in the row's
 * `source_name_ct` column (NULL when anonymous), not the audit row's actor.
 */
export interface ConcernIntake {
  title: string;
  body: string;
  hazard_class: HazardClass;
  severity: Severity;
  location_id: string;
  anonymous: boolean;
  /** Required when `anonymous === false`; ignored when `anonymous === true`. */
  source_name_plaintext?: string;
}

/**
 * Persistent concern row (server-shape mirror).
 *
 * `title_ct` / `body_ct` are committee-key-sealed ciphertext. `source_name_ct`
 * is also sealed and is ONLY present when the rep recorded a named source.
 * `actor_id` is the submitter — F-17 invariant: NEVER null, regardless of
 * the anonymous toggle.
 */
export interface ConcernRow {
  id: string;
  actor_id: string;
  title_ct: Uint8Array;
  body_ct: Uint8Array;
  /** Null when the source was logged anonymously. */
  source_name_ct: Uint8Array | null;
  hazard_class: HazardClass;
  severity: Severity;
  location_id: string;
  created_at: number;
  updated_at: number;
}

/**
 * Default list-payload row — per F-18 the default list view MUST NOT
 * include `source_name_ct` (or any aliased key). The shape below is the
 * authoritative projection.
 */
export interface ConcernListItem {
  id: string;
  actor_id: string;
  title_ct: Uint8Array;
  body_ct: Uint8Array;
  hazard_class: HazardClass;
  severity: Severity;
  location_id: string;
  created_at: number;
  updated_at: number;
  /** `true` when the row has a `source_name_ct` value; the ciphertext is
   *  intentionally omitted from this projection per F-18. */
  has_named_source: boolean;
}

/**
 * Update-patch shape. Any subset of mutable text columns may be supplied;
 * the pipeline re-encrypts each provided plaintext under the current
 * committee key. Per F-16 every UPDATE emits an audit row carrying the
 * SHA-256 of each prior ciphertext column (`prev_field_hashes`).
 */
export interface ConcernUpdate {
  title?: string;
  body?: string;
  hazard_class?: HazardClass;
  severity?: Severity;
  location_id?: string;
}

/** Reveal-result shape — per F-18 the audit row is written BEFORE this returns. */
export interface ConcernSourceReveal {
  source_name: string;
  /** ms epoch of the moment the plaintext was returned to the caller. */
  received_at_ts: number;
}

/**
 * The full closed set of audit events emitted by the concern intake
 * library. Wider audit-enum coverage lives in observability/audit-log.md;
 * this constant is the source of truth for what the library emits.
 *
 * Adding a new event requires (a) an audit-log.md update and (b) a
 * corresponding observability/alerts.md entry if it's actionable.
 */
export const CONCERN_AUDIT_EVENTS = [
  'concern.created',
  'concern.updated',
  'concern.source_revealed'
] as const;

export type ConcernAuditEvent = (typeof CONCERN_AUDIT_EVENTS)[number];
