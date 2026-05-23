/**
 * S51EvidenceStore — persistence boundary for T14.
 *
 * Per ADR-0002 Amendment H, this file is part of T14's library-only
 * deliverable. The SupabaseS51EvidenceStore + the `s51_evidence` SQL
 * migration land in T14.1 (sibling task) before any deploy carrying
 * real PI.
 *
 * Audit emissions follow the closed enum in `types.ts`. Note the
 * load-bearing ordering for `s51_evidence.read`: per HG-6 mirror, the
 * audit row MUST be persisted BEFORE the plaintext is handed back.
 *
 * Source: ADR-0003 Amendments A extension / B / D extension +
 * HG-5 cross-reference + observability/audit-log.md + threat-model
 * §3.4 F-21.
 */

import type {
  S51EvidenceAuditEvent,
  S51EvidenceEntry,
  S51EvidenceListItem,
  S51EvidenceStatus
} from './types';

export interface S51EvidenceAuditEmission {
  event_type: S51EvidenceAuditEvent;
  /** F-17 carries through: every audit row carries the submitter pseudonym. */
  actor_pseudonym: string;
  target_id: string;
  meta: Record<string, unknown>;
  /** Request-id correlation handle (Amendment G.7). */
  request_id?: string | null;
}

export interface InsertS51EvidenceOk {
  ok: true;
  id: string;
}

export interface InsertS51EvidenceDenied {
  ok: false;
  reason: 'rls_denied' | 'rate_limited';
  status: 403 | 429;
  /** No PI in denial body. */
  body: Record<string, unknown>;
}

export interface S51EvidenceStore {
  // ---- RLS / membership ----
  /**
   * Per F-21, INSERT/UPDATE on `s51_evidence` is restricted to active
   * `certified_member` roles. SELECT through the SECURITY DEFINER view
   * additionally admits co-chairs.
   */
  canWriteS51Evidence(user_id: string): Promise<boolean>;

  /**
   * Returns true if the user can read via the SECURITY DEFINER view —
   * active certified_member OR active worker_co_chair /
   * employer_co_chair.
   */
  canReadS51Evidence(user_id: string): Promise<boolean>;

  /** Test-only — install / remove active members. */
  __setActiveMember(user_id: string, active: boolean): void;

  // ---- s.51 evidence entries ----
  insertS51Evidence(opts: {
    actor_id: string;
    actor_pseudonym: string;
    title_ct: Uint8Array;
    notes_ct: Uint8Array;
    photos_ct: Uint8Array[];
    per_record_passphrase_hash: Uint8Array;
    now: number;
  }): Promise<InsertS51EvidenceOk | InsertS51EvidenceDenied>;

  /** Read an s.51 evidence row by id; null when absent. */
  getS51EvidenceById(id: string): Promise<S51EvidenceEntry | null>;

  /**
   * Update an s.51 evidence row's mutable text columns.
   */
  updateS51Evidence(opts: {
    id: string;
    patch: {
      title_ct?: Uint8Array;
      notes_ct?: Uint8Array;
      status?: S51EvidenceStatus;
    };
    now: number;
  }): Promise<{ ok: true } | { ok: false; reason: 'not_found' }>;

  /** Count rows under a given actor (used by retention tests). */
  countS51EvidenceByActor(actor_id: string): Promise<number>;

  // ---- Pseudonymized feed (Amendment D extension) ----
  /**
   * Project the s51_evidence.* audit rows to the public feed shape.
   *
   * The returned rows MUST NOT contain `actor_pseudonym` (structural
   * privacy-review §7 obligation 6). `ts_bucketed_to_hour` is the
   * ms-epoch of the event truncated to the nearest hour boundary.
   */
  listS51EvidenceFeed(): Promise<S51EvidenceListItem[]>;

  /** Underlying audit row debug accessor — forensic/test use only. */
  __debugAuditRows(): ReadonlyArray<{
    id: number;
    ts: string;
    event_type: S51EvidenceAuditEvent;
    actor_pseudonym: string;
    target_id: string;
    target_class: 'C4';
    prev_hash: Buffer;
    hash: Buffer;
    meta: Record<string, unknown>;
  }>;

  // ---- Audit ----
  /**
   * Emit an s.51-evidence-domain audit row. Returns AFTER the row has
   * committed. Throws on store-side failures so the core's strict-
   * await discipline aborts the read.
   */
  recordS51EvidenceEvent(event: S51EvidenceAuditEmission): Promise<void>;

  // ---- Helpers ----
  pseudonymOf(uid: string): string;
}
