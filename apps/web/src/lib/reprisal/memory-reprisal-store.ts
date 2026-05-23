/**
 * In-memory implementation of ReprisalStore (T13).
 *
 * Mirrors the SQL semantics that will ship in T13.1 (the migration is
 * deferred per ADR-0002 Amendment H; see G-T13-* in `.context/known-gaps.md`).
 *
 * Determinism: every mutation is synchronous on the JS event loop.
 *
 * Pseudonymisation: HMAC-SHA-256 keyed by a per-store random key OR a
 * caller-supplied shared key. Same approach as `MemoryAuthStore` /
 * `MemoryKeyStore` / `MemoryConcernStore` per ADR-0016 §Decision 1.
 *
 * Source: ADR-0003 Amendments B/D/E + ADR-0007 amendment + threat-model
 * §3.4 + observability/audit-log.md.
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type {
  InsertReprisalDenied,
  InsertReprisalOk,
  ReprisalAuditEmission,
  ReprisalStore
} from './reprisal-store';
import type {
  MemberRole,
  PendingFourEyesOp,
  ReprisalAuditEvent,
  ReprisalEntry,
  ReprisalFeedItem,
  ReprisalStatus
} from './types';

interface AuditRow {
  id: number;
  ts: string;
  ts_ms: number;
  event_type: ReprisalAuditEvent;
  actor_pseudonym: string;
  target_id: string;
  target_class: 'C4';
  prev_hash: Buffer;
  hash: Buffer;
  meta: Record<string, unknown>;
  request_id: string | null;
}

/** F-35 — 10 reprisals / hour per author. */
const RATE_LIMIT_PER_HOUR = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60_000;
/** Amendment E — 24h forensic-reveal session. */
const FORENSIC_REVEAL_SESSION_MS = 24 * 60 * 60_000;
/** ms-per-hour for the projection bucketing. */
const HOUR_MS = 60 * 60_000;

/**
 * Bucket a ms-epoch DOWN to the nearest hour boundary.
 *
 * Privacy-review §7 obligation 3 — `ts_bucketed_to_hour` is the UTC hour
 * the event occurred in. The underlying `audit_log.ts` retains
 * microseconds for forensic-reveal use.
 */
function bucketToHour(ts_ms: number): number {
  return Math.floor(ts_ms / HOUR_MS) * HOUR_MS;
}

export class MemoryReprisalStore implements ReprisalStore {
  private rows = new Map<string, ReprisalEntry>();
  private activeMembers = new Set<string>();
  private memberRoles = new Map<string, MemberRole>();
  private auditRows: AuditRow[] = [];
  private auditSeq = 0;
  private chainPrevHash: Buffer = Buffer.alloc(32, 0);
  private pendingOps = new Map<string, PendingFourEyesOp>();
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

  setMemberRole(user_id: string, role: MemberRole): void {
    this.memberRoles.set(user_id, role);
    this.activeMembers.add(user_id);
  }

  getMemberRole(user_id: string): MemberRole {
    return this.memberRoles.get(user_id) ?? 'worker_member';
  }

  // -------------------------------------------------------------------
  // Reprisal entries
  // -------------------------------------------------------------------
  async insertReprisal(opts: {
    actor_id: string;
    actor_pseudonym: string;
    title_ct: Uint8Array;
    body_ct: Uint8Array;
    per_record_passphrase_hash: Uint8Array;
    now: number;
  }): Promise<InsertReprisalOk | InsertReprisalDenied> {
    if (!this.activeMembers.has(opts.actor_id)) {
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
      body_ct: new Uint8Array(opts.body_ct),
      per_record_passphrase_hash: new Uint8Array(opts.per_record_passphrase_hash),
      status: 'open',
      created_at: opts.now,
      updated_at: opts.now
    });
    return { ok: true, id };
  }

  async getReprisalById(id: string): Promise<ReprisalEntry | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    return {
      ...row,
      title_ct: new Uint8Array(row.title_ct),
      body_ct: new Uint8Array(row.body_ct),
      per_record_passphrase_hash: new Uint8Array(row.per_record_passphrase_hash)
    };
  }

  async updateReprisal(opts: {
    id: string;
    patch: {
      title_ct?: Uint8Array;
      body_ct?: Uint8Array;
      status?: ReprisalStatus;
    };
    now: number;
  }): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
    const row = this.rows.get(opts.id);
    if (!row) return { ok: false, reason: 'not_found' };
    if (opts.patch.title_ct !== undefined) row.title_ct = new Uint8Array(opts.patch.title_ct);
    if (opts.patch.body_ct !== undefined) row.body_ct = new Uint8Array(opts.patch.body_ct);
    if (opts.patch.status !== undefined) row.status = opts.patch.status;
    row.updated_at = opts.now;
    return { ok: true };
  }

  async hardDeleteReprisal(
    id: string,
    opts: { caller_is_retention: boolean }
  ): Promise<{ ok: true } | { ok: false; reason: 'not_authorized' | 'not_found' }> {
    // HG-7 — only the retention service is authorized to hard-delete.
    if (!opts.caller_is_retention) return { ok: false, reason: 'not_authorized' };
    if (!this.rows.has(id)) return { ok: false, reason: 'not_found' };
    this.rows.delete(id);
    return { ok: true };
  }

  async countReprisalsByActor(actor_id: string): Promise<number> {
    let n = 0;
    for (const r of this.rows.values()) if (r.actor_id === actor_id) n += 1;
    return n;
  }

  // -------------------------------------------------------------------
  // Rate limit (F-35)
  // -------------------------------------------------------------------
  async tryConsumeRateBudget(opts: { actor_id: string; now: number }): Promise<boolean> {
    let bucket = this.insertTimestampsByActor.get(opts.actor_id);
    if (!bucket) {
      bucket = [];
      this.insertTimestampsByActor.set(opts.actor_id, bucket);
    }
    const cutoff = opts.now - RATE_LIMIT_WINDOW_MS;
    while (bucket.length > 0 && bucket[0]! <= cutoff) bucket.shift();
    if (bucket.length >= RATE_LIMIT_PER_HOUR) return false;
    bucket.push(opts.now);
    return true;
  }

  // -------------------------------------------------------------------
  // 4-eyes pending operations (HG-7 + Amendment E)
  // -------------------------------------------------------------------
  async createPendingFourEyes(opts: {
    kind: 'status_flip' | 'forensic_reveal';
    proposer_id: string;
    target_table: 'reprisal_log' | 'audit_log';
    target_id: string;
    new_status: ReprisalStatus | null;
    reveal_reason: string | null;
    created_at: number;
  }): Promise<{ id: string }> {
    const id = randomUUID();
    const expires_at =
      opts.kind === 'forensic_reveal' ? opts.created_at + FORENSIC_REVEAL_SESSION_MS : null;
    const row: PendingFourEyesOp = {
      id,
      kind: opts.kind,
      proposer_id: opts.proposer_id,
      approver_id: null,
      target_table: opts.target_table,
      target_id: opts.target_id,
      new_status: opts.new_status,
      reveal_reason: opts.reveal_reason,
      created_at: opts.created_at,
      expires_at,
      expired_at: null,
      revealed_actor_pseudonym: null
    };
    this.pendingOps.set(id, row);
    return { id };
  }

  async getPendingFourEyesById(id: string): Promise<PendingFourEyesOp | null> {
    const r = this.pendingOps.get(id);
    return r ? { ...r } : null;
  }

  async approvePendingFourEyes(opts: {
    id: string;
    approver_id: string;
    approver_role: MemberRole;
    proposer_role: MemberRole;
    revealed_actor_pseudonym: string | null;
    now: number;
  }): Promise<
    | { ok: true }
    | { ok: false; reason: 'self_approve_denied' | 'role_pair_invalid' | 'expired' | 'not_found' }
  > {
    const row = this.pendingOps.get(opts.id);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.proposer_id === opts.approver_id) {
      return { ok: false, reason: 'self_approve_denied' };
    }
    if (row.expires_at !== null && opts.now > row.expires_at) {
      return { ok: false, reason: 'expired' };
    }
    // Role-pairing rule per ADR-0003 Amendment E: co-chair + co-chair OR
    // co-chair + certified_member. At least one side must be a co-chair.
    const coChairLike = (r: MemberRole) => r === 'worker_co_chair' || r === 'employer_co_chair';
    const validPair =
      (coChairLike(opts.proposer_role) && coChairLike(opts.approver_role)) ||
      (coChairLike(opts.proposer_role) && opts.approver_role === 'certified_member') ||
      (opts.proposer_role === 'certified_member' && coChairLike(opts.approver_role));
    if (!validPair) {
      return { ok: false, reason: 'role_pair_invalid' };
    }
    row.approver_id = opts.approver_id;
    if (opts.revealed_actor_pseudonym !== null) {
      row.revealed_actor_pseudonym = opts.revealed_actor_pseudonym;
    }
    return { ok: true };
  }

  async expireFourEyesReveals(now: number): Promise<{ expired: number }> {
    let n = 0;
    for (const r of this.pendingOps.values()) {
      if (
        r.kind === 'forensic_reveal' &&
        r.expires_at !== null &&
        now > r.expires_at &&
        r.expired_at === null
      ) {
        r.expired_at = now;
        r.revealed_actor_pseudonym = null;
        n += 1;
      }
    }
    return { expired: n };
  }

  // -------------------------------------------------------------------
  // Pseudonymized feed (Amendment D)
  // -------------------------------------------------------------------
  async listReprisalFeed(): Promise<ReprisalFeedItem[]> {
    // Only reprisal.* events; structural projection excludes actor_pseudonym.
    const out: ReprisalFeedItem[] = [];
    for (const r of this.auditRows) {
      if (!r.event_type.startsWith('reprisal.')) continue;
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
    event_type: ReprisalAuditEvent;
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
  async recordReprisalEvent(event: ReprisalAuditEmission): Promise<void> {
    this.auditSeq += 1;
    const now_ms = this.nowProvider();
    const prev_hash = Buffer.from(this.chainPrevHash);
    // Deterministic hash chain: SHA-256(prev_hash || seq || event_type || target_id || meta).
    // Coerce every field to string before update() — `target_id` may be a
    // number (e.g., an audit_log row id from the Amendment E forensic-
    // reveal path) and createHash rejects non-string/non-Buffer input.
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
  __debugReprisalRows(): readonly ReprisalEntry[] {
    return [...this.rows.values()];
  }

  __debugPendingOps(): readonly PendingFourEyesOp[] {
    return [...this.pendingOps.values()];
  }

  /**
   * Test-only — expose the live row map so the harness can backdate
   * `created_at` for the retention-job test (the test simulates an 8y
   * old row by directly editing the column). NEVER consume in production
   * code — the production SupabaseReprisalStore has no analog.
   */
  __debugReprisalRowsMutable(): Map<string, ReprisalEntry> {
    return this.rows;
  }
}
