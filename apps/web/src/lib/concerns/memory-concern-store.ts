/**
 * In-memory implementation of ConcernStore (T08).
 *
 * Mirrors the SQL semantics that will ship in T08.1 (the migration was
 * deferred per ADR-0002 Amendment H; see G-T08-1 in `.context/known-gaps.md`).
 *
 * Determinism: every mutation is synchronous on the JS event loop. No
 * concurrent mutators in tests (vitest singleThread).
 *
 * Pseudonymisation: HMAC-SHA-256 keyed by a per-store random key OR a
 * caller-supplied shared key. Same approach as `MemoryAuthStore` /
 * `MemoryKeyStore` per ADR-0016 §Decision 1.
 *
 * Source: ADR-0007 + threat-model F-15..F-20 + ADR-0002 Amendment H.
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { ConcernAuditEmission, ConcernStore, InsertDenied, InsertOk } from './concern-store';
import type { ConcernAuditEvent, ConcernIntake, ConcernListItem, ConcernRow } from './types';

interface AuditRow {
  id: number;
  ts: string;
  event_type: ConcernAuditEvent;
  actor_pseudonym: string;
  target_id: string;
  request_id: string | null;
  meta: Record<string, unknown>;
}

const RATE_LIMIT_PER_HOUR = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60_000;

export class MemoryConcernStore implements ConcernStore {
  private rows = new Map<string, ConcernRow>();
  private activeMembers = new Set<string>();
  private auditRows: AuditRow[] = [];
  private auditSeq = 0;
  /** Sliding-window timestamps of recent inserts, keyed by actor_id. */
  private insertTimestampsByActor = new Map<string, number[]>();

  private hmacKey: Buffer;
  private nowProvider: () => number;

  constructor(nowProvider: () => number = Date.now, hmacKey?: Buffer) {
    this.hmacKey = hmacKey ?? randomBytes(32);
    this.nowProvider = nowProvider;
  }

  // -------------------------------------------------------------------
  // Pseudonym — HMAC-SHA-256 keyed (ADR-0016 §Decision 1)
  // -------------------------------------------------------------------
  pseudonymOf(uid: string): string {
    return createHmac('sha256', this.hmacKey).update(uid).digest('hex').slice(0, 16);
  }

  // -------------------------------------------------------------------
  // RLS / membership
  // -------------------------------------------------------------------
  async isActiveMember(user_id: string): Promise<boolean> {
    return this.activeMembers.has(user_id);
  }

  /** Test-only — install / remove active members. */
  __setActiveMember(user_id: string, active: boolean): void {
    if (active) this.activeMembers.add(user_id);
    else this.activeMembers.delete(user_id);
  }

  // -------------------------------------------------------------------
  // Concerns
  // -------------------------------------------------------------------
  async insertConcern(opts: {
    actor_id: string;
    actor_pseudonym: string;
    title_ct: Uint8Array;
    body_ct: Uint8Array;
    source_name_ct: Uint8Array | null;
    hazard_class: ConcernIntake['hazard_class'];
    severity: ConcernIntake['severity'];
    location_id: string;
    now: number;
  }): Promise<InsertOk | InsertDenied> {
    // F-15 — RLS active-member gate.
    if (!this.activeMembers.has(opts.actor_id)) {
      return {
        ok: false,
        reason: 'rls_denied',
        status: 403,
        // F-20 — no PI in denial body.
        body: { error: 'forbidden' }
      };
    }

    const id = randomUUID();
    const row: ConcernRow = {
      id,
      actor_id: opts.actor_id,
      title_ct: new Uint8Array(opts.title_ct),
      body_ct: new Uint8Array(opts.body_ct),
      source_name_ct: opts.source_name_ct === null ? null : new Uint8Array(opts.source_name_ct),
      hazard_class: opts.hazard_class,
      severity: opts.severity,
      location_id: opts.location_id,
      created_at: opts.now,
      updated_at: opts.now
    };
    this.rows.set(id, row);
    return { ok: true, id };
  }

  async getConcernById(id: string): Promise<ConcernRow | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    return {
      ...row,
      title_ct: new Uint8Array(row.title_ct),
      body_ct: new Uint8Array(row.body_ct),
      source_name_ct: row.source_name_ct === null ? null : new Uint8Array(row.source_name_ct)
    };
  }

  async updateConcern(opts: {
    id: string;
    patch: {
      title_ct?: Uint8Array;
      body_ct?: Uint8Array;
      hazard_class?: ConcernIntake['hazard_class'];
      severity?: ConcernIntake['severity'];
      location_id?: string;
    };
    now: number;
  }): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
    const row = this.rows.get(opts.id);
    if (!row) return { ok: false, reason: 'not_found' };
    if (opts.patch.title_ct !== undefined) row.title_ct = new Uint8Array(opts.patch.title_ct);
    if (opts.patch.body_ct !== undefined) row.body_ct = new Uint8Array(opts.patch.body_ct);
    if (opts.patch.hazard_class !== undefined) row.hazard_class = opts.patch.hazard_class;
    if (opts.patch.severity !== undefined) row.severity = opts.patch.severity;
    if (opts.patch.location_id !== undefined) row.location_id = opts.patch.location_id;
    row.updated_at = opts.now;
    return { ok: true };
  }

  async listConcerns(opts: { actor_id: string; limit?: number }): Promise<ConcernListItem[]> {
    // F-15 — list is also active-member-gated. The default projection
    // omits source_name_ct (F-18); the `has_named_source` boolean is a
    // safe summary the UI can use to render a "Reveal name" affordance.
    if (!this.activeMembers.has(opts.actor_id)) return [];
    const items: ConcernListItem[] = [];
    const all = [...this.rows.values()].sort((a, b) => b.created_at - a.created_at);
    const take = opts.limit ?? all.length;
    for (const r of all.slice(0, take)) {
      items.push({
        id: r.id,
        actor_id: r.actor_id,
        title_ct: new Uint8Array(r.title_ct),
        body_ct: new Uint8Array(r.body_ct),
        hazard_class: r.hazard_class,
        severity: r.severity,
        location_id: r.location_id,
        created_at: r.created_at,
        updated_at: r.updated_at,
        has_named_source: r.source_name_ct !== null
      });
    }
    return items;
  }

  async getConcernSourceCiphertext(id: string): Promise<Uint8Array | null> {
    const row = this.rows.get(id);
    if (!row || row.source_name_ct === null) return null;
    return new Uint8Array(row.source_name_ct);
  }

  // -------------------------------------------------------------------
  // Rate limit (F-20)
  // -------------------------------------------------------------------
  async tryConsumeRateBudget(opts: { actor_id: string; now: number }): Promise<boolean> {
    let bucket = this.insertTimestampsByActor.get(opts.actor_id);
    if (!bucket) {
      bucket = [];
      this.insertTimestampsByActor.set(opts.actor_id, bucket);
    }
    // Drop entries outside the 1h window.
    const cutoff = opts.now - RATE_LIMIT_WINDOW_MS;
    while (bucket.length > 0 && bucket[0]! <= cutoff) bucket.shift();
    if (bucket.length >= RATE_LIMIT_PER_HOUR) return false;
    bucket.push(opts.now);
    return true;
  }

  async countConcernsByActor(actor_id: string): Promise<number> {
    let n = 0;
    for (const r of this.rows.values()) if (r.actor_id === actor_id) n += 1;
    return n;
  }

  // -------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------
  async recordConcernEvent(event: ConcernAuditEmission): Promise<void> {
    this.auditSeq += 1;
    const request_id = event.request_id === undefined ? randomUUID() : event.request_id;
    this.auditRows.push({
      id: this.auditSeq,
      ts: new Date(this.nowProvider()).toISOString(),
      event_type: event.event_type,
      actor_pseudonym: event.actor_pseudonym,
      target_id: event.target_id,
      request_id,
      meta: event.meta
    });
  }

  // -------------------------------------------------------------------
  // Test-only
  // -------------------------------------------------------------------
  __debugAuditRows(): readonly AuditRow[] {
    return this.auditRows;
  }
  __debugConcerns(): readonly ConcernRow[] {
    return [...this.rows.values()];
  }
}
