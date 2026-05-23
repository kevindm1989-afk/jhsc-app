/**
 * ExportStore — persistence boundary for T11/T12.
 *
 * Per ADR-0002 Amendment H, this file is part of T11/T12's library-only
 * deliverable. The SupabaseExportStore + the `minutes_final` /
 * `recommendations` SQL migrations land in T11.1/T12.1 (sibling tasks)
 * before any deploy carrying real PI.
 *
 * Audit emissions follow the closed enum in `types.ts`. Ordering is
 * load-bearing: per F-24 the `export.generated` row MUST be persisted
 * BEFORE the Blob URL is created. The library enforces this with strict
 * `await` discipline in `proceedExport`; the production SQL function
 * (T11.1) wraps the entire flow in a single transaction.
 *
 * Source: F-19/F-22/F-24/F-25/F-27/F-28/F-29/RA-1 + threat-model §3.3 +
 * observability/audit-log.md.
 */

import type { ExportAuditEvent, ExportKind } from './types';

/**
 * Server-shape mirror of a finalized minutes row. The library never reads
 * the encrypted ciphertext columns directly — only the allowlist-keyed
 * plaintext projection the store returns to the renderer.
 */
export interface MinutesFinalRow {
  id: string;
  finalized_at: number;
  agenda_items: readonly string[];
  decisions: readonly string[];
  recommendations_summary: string;
  attendees_present: readonly string[];
  next_meeting_at: number | null;
  co_chair_signature_block: string;
  /**
   * Concern provenance — set when the minutes references concerns. RA-1
   * compensating control #3 reads this for the interstitial flag.
   */
  derived_from_concerns: readonly string[];
}

export interface RecommendationRow {
  id: string;
  title: string;
  body: string;
  rationale: string;
  created_at: number;
  sent_at: number | null;
  twentyone_day_due_at: number | null;
  co_chair_signature_block: string;
  derived_from_concerns: readonly string[];
}

export interface ExportAuditEmission {
  event_type: ExportAuditEvent;
  /** F-17 carries through: every audit row carries the actor pseudonym. */
  actor_pseudonym: string;
  /** RA-1 / HG-1: single-signer co-chair posture — approver = actor. */
  approver_pseudonym: string;
  /** Target document id (minutes_id OR recommendation_id). */
  target_id: string;
  meta: Record<string, unknown>;
}

export interface ExportStore {
  // ---- RLS / membership ----
  /** Per F-22: only an active worker_co_chair may read finalized minutes. */
  isCoChair(user_id: string): Promise<boolean>;

  /** Per F-22: a non-co-chair GET returns 403/404. */
  fetchMinutesFinalRow(
    user_id: string,
    minutes_id: string
  ): Promise<{ ok: true; row: MinutesFinalRow } | { ok: false; status: 403 | 404 }>;

  fetchRecommendationRow(
    user_id: string,
    recommendation_id: string
  ): Promise<{ ok: true; row: RecommendationRow } | { ok: false; status: 403 | 404 }>;

  /** F-28 — 10 exports/co-chair/hour; 11th = 429. */
  tryConsumeExportBudget(opts: { actor_id: string; now: number }): Promise<boolean>;

  /**
   * Marks the actor's bucket as rate-limited so the A-EXPORT-002 alert
   * fires exactly once per threshold crossing (mirrors burst-alert
   * dedup posture from rate-limit.ts).
   */
  shouldFireRateLimitAlertOnce(actor_id: string): Promise<boolean>;

  /**
   * Emit an audit row. Returns AFTER the row has committed. A throw
   * aborts the export — the caller (`proceedExport`) MUST `await` and
   * propagate.
   *
   * In production this calls the same RPC as the rest of the audit-emit
   * surface; in tests the `MemoryExportStore` writes to a per-store
   * buffer that the test harness reads back via adminQuery.
   */
  recordExportEvent(event: ExportAuditEmission): Promise<{ audit_id: string }>;

  /**
   * Post-export notification path (RA-1 compensating control #4).
   *
   * Implementation: fanout to every active member's "recent sensitive
   * activity" feed within 60s. Failure is non-blocking (the audit row is
   * the gate); the caller surfaces a warning toast.
   */
  sendPostExportNotification(opts: {
    audit_id: string;
    actor_pseudonym: string;
    export_kind: ExportKind;
    target_id: string;
    now_ms: number;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;

  /**
   * Verify a passkey re-auth assertion. The library only checks
   * presence + actor binding + freshness; the production T11.1 verifies
   * the signature + counter + RP id.
   */
  verifyReauthAssertion(opts: {
    actor_user_id: string;
    ceremony_id: string;
    issued_at_ms: number;
    now_ms: number;
  }): Promise<boolean>;

  // ---- Helpers ----
  pseudonymOf(uid: string): string;
}
