/**
 * WorkRefusalStore — persistence boundary for T14.
 *
 * Per ADR-0002 Amendment H, this file is part of T14's library-only
 * deliverable. The SupabaseWorkRefusalStore + the `work_refusal` SQL
 * migration land in T14.1 (sibling task) before any deploy carrying
 * real PI.
 *
 * Audit emissions follow the closed enum in `types.ts`. Note the load-
 * bearing ordering for `work_refusal.read`: per HG-6 the audit row
 * MUST be persisted BEFORE the plaintext is handed back. The library
 * mirrors the ordering with strict `await` discipline; the production
 * SECURITY DEFINER view (T14.1) wraps the entire flow in a single
 * transaction.
 *
 * Source: ADR-0003 Amendments A extension / B / D extension +
 * observability/audit-log.md + threat-model §3.4 F-21.
 */

import type {
  WorkRefusalAuditEvent,
  WorkRefusalEntry,
  WorkRefusalListItem,
  WorkRefusalStatus
} from './types';

export interface WorkRefusalAuditEmission {
  event_type: WorkRefusalAuditEvent;
  /** F-17 carries through: every audit row carries the submitter pseudonym. */
  actor_pseudonym: string;
  target_id: string;
  meta: Record<string, unknown>;
  /** Request-id correlation handle (Amendment G.7). */
  request_id?: string | null;
}

export interface InsertWorkRefusalOk {
  ok: true;
  id: string;
}

export interface InsertWorkRefusalDenied {
  ok: false;
  reason: 'rls_denied' | 'rate_limited';
  status: 403 | 429;
  /** No PI in denial body. */
  body: Record<string, unknown>;
}

export interface WorkRefusalStore {
  // ---- RLS / membership ----
  /**
   * Mirrors `is_certified_member(uid)` from the T14.1 SQL migration.
   * Per F-21, INSERT/UPDATE on `work_refusal` is restricted to active
   * `certified_member` roles. SELECT through the SECURITY DEFINER view
   * additionally admits co-chairs.
   */
  canWriteWorkRefusal(user_id: string): Promise<boolean>;

  /**
   * Returns true if the user can read via the SECURITY DEFINER view —
   * active certified_member OR active worker_co_chair / employer_co_chair.
   */
  canReadWorkRefusal(user_id: string): Promise<boolean>;

  // ---- Work-refusal entries ----
  insertWorkRefusal(opts: {
    actor_id: string;
    actor_pseudonym: string;
    title_ct: Uint8Array;
    notes_ct: Uint8Array;
    per_record_passphrase_hash: Uint8Array;
    now: number;
  }): Promise<InsertWorkRefusalOk | InsertWorkRefusalDenied>;

  /** Read a work-refusal row by id; null when absent. */
  getWorkRefusalById(id: string): Promise<WorkRefusalEntry | null>;

  /**
   * Update a work-refusal row's mutable text columns.
   */
  updateWorkRefusal(opts: {
    id: string;
    patch: {
      title_ct?: Uint8Array;
      notes_ct?: Uint8Array;
      status?: WorkRefusalStatus;
    };
    now: number;
  }): Promise<{ ok: true } | { ok: false; reason: 'not_found' }>;

  /** Count rows under a given actor (used by retention tests). */
  countWorkRefusalsByActor(actor_id: string): Promise<number>;

  // ---- Pseudonymized feed (Amendment D extension) ----
  /**
   * Project the work_refusal.* audit rows to the public feed shape.
   *
   * The returned rows MUST NOT contain `actor_pseudonym` (structural
   * privacy-review §7 obligation 6). `ts_bucketed_to_hour` is the
   * ms-epoch of the event truncated to the nearest hour boundary.
   */
  listWorkRefusalFeed(): Promise<WorkRefusalListItem[]>;

  // ---- Audit ----
  /**
   * Emit a work-refusal-domain audit row. Returns AFTER the row has
   * committed. Throws on store-side failures so the core's strict-
   * await discipline aborts the read.
   */
  recordWorkRefusalEvent(event: WorkRefusalAuditEmission): Promise<void>;

  // ---- Helpers ----
  pseudonymOf(uid: string): string;
}
