/**
 * In-memory implementation of ExportStore (T11/T12).
 *
 * Mirrors the SQL semantics that will ship in T11.1 / T12.1.
 *
 * Determinism: every mutation is synchronous on the JS event loop.
 *
 * Pseudonymisation: HMAC-SHA-256 keyed by a per-store random key OR a
 * caller-supplied shared key. Same approach as `MemoryAuthStore` /
 * `MemoryKeyStore` / `MemoryReprisalStore` per ADR-0016 §Decision 1 (the
 * harness shares the AuthStore's key so pseudonyms join across surfaces).
 *
 * Source: F-19/F-22/F-24/F-25/F-27/F-28/F-29/RA-1.
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type {
  ExportAuditEmission,
  ExportStore,
  MinutesFinalRow,
  RecommendationRow
} from './export-store';
import type { ExportAuditEvent, ExportKind } from './types';

/** F-28 — 10 exports / hour / co-chair. */
const RATE_LIMIT_PER_HOUR = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60_000;
/** Re-auth assertion freshness window (5 min). */
const REAUTH_FRESHNESS_MS = 5 * 60_000;

interface AuditRow {
  id: number;
  ts: string;
  ts_ms: number;
  event_type: ExportAuditEvent;
  actor_pseudonym: string;
  target_id: string;
  target_class: 'C3';
  prev_hash: Buffer;
  hash: Buffer;
  meta: Record<string, unknown>;
}

interface AuthAuditEmitter {
  /**
   * Optional cross-store audit sink. When set, the export store ALSO
   * pushes its audit rows into the AuthStore so the test harness's
   * generic `audit_log` adminQuery handlers (which read from the
   * AuthStore) surface them.
   */
  emitAudit(opts: {
    event_type: string;
    actor_pseudonym: string;
    target_class: 'C1' | 'C3' | 'C4';
    severity: 'info' | 'warn' | 'alert';
    meta: Record<string, unknown>;
  }): Promise<void>;
}

export class MemoryExportStore implements ExportStore {
  private coChairs = new Set<string>();
  private minutesById = new Map<string, MinutesFinalRow>();
  private recommendationsById = new Map<string, RecommendationRow>();
  private exportTimestampsByActor = new Map<string, number[]>();
  private rateLimitAlertFired = new Set<string>();
  private auditRows: AuditRow[] = [];
  private auditSeq = 0;
  private chainPrevHash: Buffer = Buffer.alloc(32, 0);
  /** Force-fail flag for the F-24 audit-failure test. */
  private auditFailEvents = new Set<ExportAuditEvent>();
  /** Force-fail flag for the RA-1 #4 notification-failure test. */
  private notificationForcedFail = false;

  private hmacKey: Buffer;
  private nowProvider: () => number;
  private bridge: AuthAuditEmitter | null;

  constructor(nowProvider: () => number = Date.now, hmacKey?: Buffer, bridge?: AuthAuditEmitter) {
    this.hmacKey = hmacKey ?? randomBytes(32);
    this.nowProvider = nowProvider;
    this.bridge = bridge ?? null;
  }

  // -------------------------------------------------------------------
  // Pseudonym
  // -------------------------------------------------------------------
  pseudonymOf(uid: string): string {
    return createHmac('sha256', this.hmacKey).update(uid).digest('hex').slice(0, 16);
  }

  // -------------------------------------------------------------------
  // RLS / membership
  // -------------------------------------------------------------------
  async isCoChair(user_id: string): Promise<boolean> {
    return this.coChairs.has(user_id);
  }

  /** Test-only — install / remove co-chair members. */
  __setCoChair(user_id: string, isCoChair: boolean): void {
    if (isCoChair) this.coChairs.add(user_id);
    else this.coChairs.delete(user_id);
  }

  /** Test-only — write a finalized minutes row. */
  __putMinutesFinalRow(row: MinutesFinalRow): void {
    this.minutesById.set(row.id, {
      ...row,
      agenda_items: [...row.agenda_items],
      decisions: [...row.decisions],
      attendees_present: [...row.attendees_present],
      derived_from_concerns: [...row.derived_from_concerns]
    });
  }

  /** Test-only — write a recommendation row. */
  __putRecommendationRow(row: RecommendationRow): void {
    this.recommendationsById.set(row.id, {
      ...row,
      derived_from_concerns: [...row.derived_from_concerns]
    });
  }

  /** Test-only — flip the audit-failure flag for a specific event. */
  __setAuditFailForEvent(event: ExportAuditEvent, fail: boolean): void {
    if (fail) this.auditFailEvents.add(event);
    else this.auditFailEvents.delete(event);
  }

  /** Test-only — flip the notification-failure flag. */
  __setNotificationForcedFail(forced: boolean): void {
    this.notificationForcedFail = forced;
  }

  async fetchMinutesFinalRow(
    user_id: string,
    minutes_id: string
  ): Promise<{ ok: true; row: MinutesFinalRow } | { ok: false; status: 403 | 404 }> {
    if (!this.coChairs.has(user_id)) {
      // F-22 — non-co-chair GET on finalized minutes ciphertext denied.
      // Mirror production posture: 403 (RLS deny) for an authenticated
      // user that lacks the role, 404 if the row does not exist.
      return { ok: false, status: 403 };
    }
    const row = this.minutesById.get(minutes_id);
    if (!row) return { ok: false, status: 404 };
    return {
      ok: true,
      row: {
        ...row,
        agenda_items: [...row.agenda_items],
        decisions: [...row.decisions],
        attendees_present: [...row.attendees_present],
        derived_from_concerns: [...row.derived_from_concerns]
      }
    };
  }

  async fetchRecommendationRow(
    user_id: string,
    recommendation_id: string
  ): Promise<{ ok: true; row: RecommendationRow } | { ok: false; status: 403 | 404 }> {
    if (!this.coChairs.has(user_id)) {
      return { ok: false, status: 403 };
    }
    const row = this.recommendationsById.get(recommendation_id);
    if (!row) return { ok: false, status: 404 };
    return {
      ok: true,
      row: { ...row, derived_from_concerns: [...row.derived_from_concerns] }
    };
  }

  // -------------------------------------------------------------------
  // Rate limit (F-28)
  // -------------------------------------------------------------------
  async tryConsumeExportBudget(opts: { actor_id: string; now: number }): Promise<boolean> {
    let bucket = this.exportTimestampsByActor.get(opts.actor_id);
    if (!bucket) {
      bucket = [];
      this.exportTimestampsByActor.set(opts.actor_id, bucket);
    }
    const cutoff = opts.now - RATE_LIMIT_WINDOW_MS;
    while (bucket.length > 0 && (bucket[0] ?? Infinity) <= cutoff) bucket.shift();
    if (bucket.length >= RATE_LIMIT_PER_HOUR) return false;
    bucket.push(opts.now);
    return true;
  }

  async shouldFireRateLimitAlertOnce(actor_id: string): Promise<boolean> {
    if (this.rateLimitAlertFired.has(actor_id)) return false;
    this.rateLimitAlertFired.add(actor_id);
    return true;
  }

  // -------------------------------------------------------------------
  // Re-auth assertion
  // -------------------------------------------------------------------
  async verifyReauthAssertion(opts: {
    actor_user_id: string;
    ceremony_id: string;
    issued_at_ms: number;
    now_ms: number;
  }): Promise<boolean> {
    if (!opts.ceremony_id) return false;
    if (opts.now_ms - opts.issued_at_ms > REAUTH_FRESHNESS_MS) return false;
    if (opts.now_ms < opts.issued_at_ms) return false;
    return true;
  }

  // -------------------------------------------------------------------
  // Audit (HG-6 / F-24 ordering — caller awaits before Blob URL)
  // -------------------------------------------------------------------
  async recordExportEvent(event: ExportAuditEmission): Promise<{ audit_id: string }> {
    if (this.auditFailEvents.has(event.event_type)) {
      // F-24: simulate the audit-log POST failure path. The throw aborts
      // the caller (`proceedExport`) BEFORE the Blob URL is created.
      const err = new Error('audit_endpoint_500_simulated');
      (err as Error & { __testExpected?: boolean }).__testExpected = true;
      throw err;
    }
    this.auditSeq += 1;
    const now_ms = this.nowProvider();
    const prev_hash = Buffer.from(this.chainPrevHash);
    const h = createHash('sha256');
    h.update(prev_hash);
    h.update(String(this.auditSeq));
    h.update(String(event.event_type));
    h.update(String(event.target_id));
    h.update(JSON.stringify(event.meta));
    const hash = h.digest();
    this.chainPrevHash = hash;
    const auditRow: AuditRow = {
      id: this.auditSeq,
      ts: new Date(now_ms).toISOString(),
      ts_ms: now_ms,
      event_type: event.event_type,
      actor_pseudonym: event.actor_pseudonym,
      target_id: String(event.target_id),
      target_class: 'C3',
      prev_hash,
      hash,
      meta: event.meta
    };
    this.auditRows.push(auditRow);
    // Cross-store bridge — push into the AuthStore so the harness's
    // generic `audit_log` queries surface the row.
    if (this.bridge) {
      await this.bridge.emitAudit({
        event_type: event.event_type,
        actor_pseudonym: event.actor_pseudonym,
        target_class: 'C3',
        severity: 'info',
        meta: { ...event.meta, target_id: String(event.target_id) }
      });
    }
    return { audit_id: String(auditRow.id) };
  }

  // -------------------------------------------------------------------
  // Post-export notification (RA-1 #4)
  // -------------------------------------------------------------------
  async sendPostExportNotification(opts: {
    audit_id: string;
    actor_pseudonym: string;
    export_kind: ExportKind;
    target_id: string;
    now_ms: number;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.notificationForcedFail) {
      return { ok: false, reason: 'notification_endpoint_500' };
    }
    // In-memory store: the notification IS the audit row visibility in
    // the sensitive-activity feed (which projects `export.*` rows). No
    // additional persistence required for the in-memory test path.
    void opts;
    return { ok: true };
  }

  // -------------------------------------------------------------------
  // Test-only debug surfaces
  // -------------------------------------------------------------------
  __debugAuditRows(): ReadonlyArray<{
    id: number;
    ts: string;
    event_type: ExportAuditEvent;
    actor_pseudonym: string;
    target_id: string;
    meta: Record<string, unknown>;
  }> {
    return this.auditRows.map((r) => ({
      id: r.id,
      ts: r.ts,
      event_type: r.event_type,
      actor_pseudonym: r.actor_pseudonym,
      target_id: r.target_id,
      meta: r.meta
    }));
  }

  __getMinutesIds(): string[] {
    return [...this.minutesById.keys()];
  }

  __getRecommendationIds(): string[] {
    return [...this.recommendationsById.keys()];
  }

  /** Reset for cross-test cleanup. */
  __reset(): void {
    this.exportTimestampsByActor.clear();
    this.rateLimitAlertFired.clear();
    this.notificationForcedFail = false;
    this.auditFailEvents.clear();
  }

  /** Build a synthetic id for new rows in non-test paths. */
  static newId(): string {
    return randomUUID();
  }
}
