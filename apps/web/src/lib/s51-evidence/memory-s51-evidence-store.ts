/**
 * In-memory implementation of S51EvidenceStore (T14).
 *
 * Mirrors the SQL semantics that will ship in T14.1 (the migration is
 * deferred per ADR-0002 Amendment H; see G-T14-* in `.context/known-
 * gaps.md`).
 *
 * Determinism: every mutation is synchronous on the JS event loop.
 *
 * Pseudonymisation: HMAC-SHA-256 keyed by a per-store random key OR a
 * caller-supplied shared key. Same approach as `MemoryReprisalStore`
 * per ADR-0016 §Decision 1.
 *
 * Source: ADR-0003 Amendments A extension / B / D extension +
 * HG-5 cross-reference + observability/audit-log.md + threat-model
 * §3.4 F-21.
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type {
  InsertS51EvidenceDenied,
  InsertS51EvidenceOk,
  S51EvidenceAuditEmission,
  S51EvidenceStore
} from './s51-evidence-store';
import type {
  S51EvidenceAuditEvent,
  S51EvidenceEntry,
  S51EvidenceListItem,
  S51EvidenceStatus
} from './types';

/**
 * Test-only superset of the production `S51EvidenceStore` (G-T14-17 split).
 *
 * Adds the seeding + poisoning hooks the T14 test files consume via deep
 * import. `SupabaseS51EvidenceStore` (T14.1) MUST implement
 * `S51EvidenceStore` only — narrowing it back to `TestS51EvidenceStore` is
 * a type error.
 *
 * Mirrors the T18 `TestIntegrityStore` pattern + the T14 work-refusal
 * sibling and the privacy-reviewer T14-A7 obligation.
 */
export interface TestS51EvidenceStore extends S51EvidenceStore {
  /** Test-only — install / remove active members. */
  __setActiveMember(user_id: string, active: boolean): void;
  /** Test-only — grant the write role to a uid. */
  __grantWriteRole(user_id: string): void;
  /** Test-only — grant the read-only role to a uid. */
  __grantReadOnlyRole(user_id: string): void;
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
  /** Underlying s.51-evidence-row debug accessor — test use only. */
  __debugS51EvidenceRows(): readonly S51EvidenceEntry[];
}

interface AuditRow {
  id: number;
  ts: string;
  ts_ms: number;
  event_type: S51EvidenceAuditEvent;
  actor_pseudonym: string;
  target_id: string;
  target_class: 'C4';
  prev_hash: Buffer;
  hash: Buffer;
  meta: Record<string, unknown>;
  request_id: string | null;
}

/** ms-per-hour for the projection bucketing. */
const HOUR_MS = 60 * 60_000;

/**
 * Bucket a ms-epoch DOWN to the nearest hour boundary.
 *
 * Privacy-review §7 obligation 6 — `ts_bucketed_to_hour` is the UTC
 * hour the event occurred in.
 */
function bucketToHour(ts_ms: number): number {
  return Math.floor(ts_ms / HOUR_MS) * HOUR_MS;
}

export class MemoryS51EvidenceStore implements TestS51EvidenceStore {
  private rows = new Map<string, S51EvidenceEntry>();
  private writeAuthorized = new Set<string>();
  private readAuthorized = new Set<string>();
  private auditRows: AuditRow[] = [];
  private auditSeq = 0;
  private chainPrevHash: Buffer = Buffer.alloc(32, 0);

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
  async canWriteS51Evidence(user_id: string): Promise<boolean> {
    return this.writeAuthorized.has(user_id);
  }

  async canReadS51Evidence(user_id: string): Promise<boolean> {
    return this.readAuthorized.has(user_id);
  }

  __setActiveMember(user_id: string, active: boolean): void {
    if (!active) {
      this.writeAuthorized.delete(user_id);
      this.readAuthorized.delete(user_id);
    }
  }

  /** Test-only — install role-based grants per F-21. */
  __grantWriteRole(user_id: string): void {
    this.writeAuthorized.add(user_id);
    this.readAuthorized.add(user_id);
  }

  /** Test-only — install read-only role (co-chair). */
  __grantReadOnlyRole(user_id: string): void {
    this.readAuthorized.add(user_id);
  }

  // -------------------------------------------------------------------
  // s.51 evidence entries
  // -------------------------------------------------------------------
  async insertS51Evidence(opts: {
    actor_id: string;
    actor_pseudonym: string;
    title_ct: Uint8Array;
    notes_ct: Uint8Array;
    photos_ct: Uint8Array[];
    per_record_passphrase_hash: Uint8Array;
    now: number;
  }): Promise<InsertS51EvidenceOk | InsertS51EvidenceDenied> {
    if (!this.writeAuthorized.has(opts.actor_id)) {
      return {
        ok: false,
        reason: 'rls_denied',
        status: 403,
        body: { error: 'forbidden' }
      };
    }
    const id = randomUUID();
    this.rows.set(id, {
      id,
      actor_id: opts.actor_id,
      title_ct: new Uint8Array(opts.title_ct),
      notes_ct: new Uint8Array(opts.notes_ct),
      photos_ct: opts.photos_ct.map((p) => new Uint8Array(p)),
      per_record_passphrase_hash: new Uint8Array(opts.per_record_passphrase_hash),
      status: 'open',
      created_at: opts.now,
      updated_at: opts.now
    });
    return { ok: true, id };
  }

  async getS51EvidenceById(id: string): Promise<S51EvidenceEntry | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    return {
      ...row,
      title_ct: new Uint8Array(row.title_ct),
      notes_ct: new Uint8Array(row.notes_ct),
      photos_ct: row.photos_ct.map((p) => new Uint8Array(p)),
      per_record_passphrase_hash: new Uint8Array(row.per_record_passphrase_hash)
    };
  }

  async updateS51Evidence(opts: {
    id: string;
    patch: {
      title_ct?: Uint8Array;
      notes_ct?: Uint8Array;
      status?: S51EvidenceStatus;
    };
    now: number;
  }): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
    const row = this.rows.get(opts.id);
    if (!row) return { ok: false, reason: 'not_found' };
    if (opts.patch.title_ct !== undefined) row.title_ct = new Uint8Array(opts.patch.title_ct);
    if (opts.patch.notes_ct !== undefined) row.notes_ct = new Uint8Array(opts.patch.notes_ct);
    if (opts.patch.status !== undefined) row.status = opts.patch.status;
    row.updated_at = opts.now;
    return { ok: true };
  }

  async countS51EvidenceByActor(actor_id: string): Promise<number> {
    let n = 0;
    for (const r of this.rows.values()) if (r.actor_id === actor_id) n += 1;
    return n;
  }

  // -------------------------------------------------------------------
  // Pseudonymized feed (Amendment D extension)
  // -------------------------------------------------------------------
  async listS51EvidenceFeed(): Promise<S51EvidenceListItem[]> {
    const out: S51EvidenceListItem[] = [];
    for (const r of this.auditRows) {
      if (!r.event_type.startsWith('s51_evidence.')) continue;
      out.push({
        id: r.id,
        event_type: r.event_type,
        ts_bucketed_to_hour: bucketToHour(r.ts_ms),
        target_id: r.target_id,
        target_class: r.target_class,
        prev_hash: r.prev_hash.toString('hex'),
        hash: r.hash.toString('hex')
      });
    }
    return out;
  }

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
  }> {
    return this.auditRows.map((r) => ({
      id: r.id,
      ts: r.ts,
      event_type: r.event_type,
      actor_pseudonym: r.actor_pseudonym,
      target_id: r.target_id,
      target_class: r.target_class,
      prev_hash: Buffer.from(r.prev_hash),
      hash: Buffer.from(r.hash),
      meta: r.meta
    }));
  }

  // -------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------
  async recordS51EvidenceEvent(event: S51EvidenceAuditEmission): Promise<void> {
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
    this.auditRows.push({
      id: this.auditSeq,
      ts: new Date(now_ms).toISOString(),
      ts_ms: now_ms,
      event_type: event.event_type,
      actor_pseudonym: event.actor_pseudonym,
      target_id: String(event.target_id),
      target_class: 'C4',
      prev_hash,
      hash,
      meta: event.meta,
      request_id: event.request_id ?? randomUUID()
    });
  }

  // -------------------------------------------------------------------
  // Test-only
  // -------------------------------------------------------------------
  __debugS51EvidenceRows(): readonly S51EvidenceEntry[] {
    return [...this.rows.values()];
  }
}
