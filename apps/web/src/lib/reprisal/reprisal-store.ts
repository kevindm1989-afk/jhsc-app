/**
 * ReprisalStore — persistence boundary for T13.
 *
 * Per ADR-0002 Amendment H, this file is part of T13's library-only
 * deliverable. The SupabaseReprisalStore + the `reprisal_log` SQL migration
 * land in T13.1 (sibling task) before any deploy carrying real PI.
 *
 * Audit emissions follow the closed enum in `types.ts`. Note the load-
 * bearing ordering for `reprisal.read`: per HG-6 the audit row MUST be
 * persisted BEFORE the plaintext is handed back. The library mirrors the
 * ordering with strict `await` discipline; the production SECURITY
 * DEFINER view (T13.1) wraps the entire flow in a single transaction.
 *
 * Source: ADR-0003 Amendments B/D/E + ADR-0007 amendment + threat-model
 * §3.4 + observability/audit-log.md.
 */

import type {
  MemberRole,
  PendingFourEyesOp,
  ReprisalAuditEvent,
  ReprisalEntry,
  ReprisalFeedItem,
  ReprisalStatus
} from './types';

export interface ReprisalAuditEmission {
  event_type: ReprisalAuditEvent;
  /** F-17 carries through: every audit row carries the submitter pseudonym. */
  actor_pseudonym: string;
  target_id: string;
  meta: Record<string, unknown>;
  /** Request-id correlation handle (Amendment G.7). */
  request_id?: string | null;
}

export interface InsertReprisalOk {
  ok: true;
  id: string;
}

export interface InsertReprisalDenied {
  ok: false;
  reason: 'rls_denied' | 'rate_limited';
  status: 403 | 429;
  /** No PI in denial body (mirrors F-20 posture). */
  body: Record<string, unknown>;
}

export interface ReprisalStore {
  // ---- RLS / membership ----
  /**
   * Mirrors `is_active_member(uid)` from the T13.1 SQL migration. The
   * reprisal-core's INSERT path queries this BEFORE attempting the
   * insert so RLS denials surface as a structured `{ ok: false, reason:
   * 'rls_denied' }` rather than a Postgres error code.
   */
  isActiveMember(user_id: string): Promise<boolean>;

  /** Test-only — install / remove active members and set their role. */
  setMemberRole(user_id: string, role: MemberRole): void;

  /** Read the member's role. Defaults to 'worker_member'. */
  getMemberRole(user_id: string): MemberRole;

  // ---- Reprisal entries ----
  insertReprisal(opts: {
    actor_id: string;
    actor_pseudonym: string;
    title_ct: Uint8Array;
    body_ct: Uint8Array;
    per_record_passphrase_hash: Uint8Array;
    now: number;
  }): Promise<InsertReprisalOk | InsertReprisalDenied>;

  /** Read a reprisal row by id; null when absent or soft-deleted. */
  getReprisalById(id: string): Promise<ReprisalEntry | null>;

  /**
   * Update a reprisal row's mutable text columns. Per F-31 the audit
   * `reprisal.update` row carries `prev_field_hashes` — the caller (core)
   * supplies them; the store does not re-derive.
   */
  updateReprisal(opts: {
    id: string;
    patch: {
      title_ct?: Uint8Array;
      body_ct?: Uint8Array;
      status?: ReprisalStatus;
    };
    now: number;
  }): Promise<{ ok: true } | { ok: false; reason: 'not_found' }>;

  /** Hard-delete a reprisal row. ONLY callable by the retention service. */
  hardDeleteReprisal(
    id: string,
    opts: { caller_is_retention: boolean }
  ): Promise<{ ok: true } | { ok: false; reason: 'not_authorized' | 'not_found' }>;

  /** Count rows under a given actor (used by the retention test). */
  countReprisalsByActor(actor_id: string): Promise<number>;

  /** Rate budget (F-35): 10/hour/user. */
  tryConsumeRateBudget(opts: { actor_id: string; now: number }): Promise<boolean>;

  // ---- 4-eyes pending operations ----
  createPendingFourEyes(opts: {
    kind: 'status_flip' | 'forensic_reveal';
    proposer_id: string;
    target_table: 'reprisal_log' | 'audit_log';
    target_id: string;
    new_status: ReprisalStatus | null;
    reveal_reason: string | null;
    created_at: number;
  }): Promise<{ id: string }>;

  getPendingFourEyesById(id: string): Promise<PendingFourEyesOp | null>;

  approvePendingFourEyes(opts: {
    id: string;
    approver_id: string;
    approver_role: MemberRole;
    proposer_role: MemberRole;
    revealed_actor_pseudonym: string | null;
    now: number;
  }): Promise<
    | { ok: true }
    | { ok: false; reason: 'self_approve_denied' | 'role_pair_invalid' | 'expired' | 'not_found' }
  >;

  /** Expiry sweep: clear revealed_actor_pseudonym + set expired_at. */
  expireFourEyesReveals(now: number): Promise<{ expired: number }>;

  // ---- Pseudonymized feed (Amendment D) ----
  /**
   * Project the reprisal.* audit rows to the public feed shape.
   *
   * The returned rows MUST NOT contain `actor_pseudonym` (structural
   * privacy-review §7 obligation 1 + 2). `ts_bucketed_to_hour` is the
   * ms-epoch of the event truncated to the nearest hour boundary.
   */
  listReprisalFeed(): Promise<ReprisalFeedItem[]>;

  /** Underlying audit row for a target — admin/forensic use only. */
  __debugAuditRows(): ReadonlyArray<{
    id: number;
    ts: string;
    event_type: ReprisalAuditEvent;
    actor_pseudonym: string;
    target_id: string;
    target_class: 'C4';
    prev_hash: Buffer;
    hash: Buffer;
    meta: Record<string, unknown>;
  }>;

  // ---- Audit ----
  /**
   * Emit a reprisal-domain audit row. Returns AFTER the row has committed.
   *
   * The store does not enforce ordering relative to other operations —
   * the core does (`await store.recordReprisalEvent(...)` before the
   * decrypt step for `reprisal.read`).
   */
  recordReprisalEvent(event: ReprisalAuditEmission): Promise<void>;

  // ---- Helpers ----
  pseudonymOf(uid: string): string;
}
