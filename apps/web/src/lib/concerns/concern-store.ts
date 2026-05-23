/**
 * ConcernStore — interface mirroring T05's AuthStore + T07's KeyStore.
 *
 * Per ADR-0002 Amendment H, this file is part of T08's library-only
 * deliverable. The SupabaseConcernStore + the `concerns` SQL migration
 * land in T08.1 (sibling task) before any deploy carrying real PI.
 *
 * RLS semantics are mirrored at the interface boundary by `attemptInsert`
 * returning `{ ok: false, reason: 'rls_denied' }` instead of throwing —
 * tests use this to assert the F-15 mitigation without coupling to SQL
 * error codes. The production SupabaseConcernStore maps Postgres RLS
 * failures (42501 / `permission denied for table concerns`) onto the same
 * shape.
 *
 * Audit emissions follow the closed enum in `types.ts`:
 *   - `concern.created`         — every successful insert (F-17 carries actor)
 *   - `concern.updated`         — every successful update (F-16 prev_field_hashes)
 *   - `concern.source_revealed` — every reveal flow (F-18 audit-before-plaintext)
 *
 * Source: ADR-0007 + threat-model F-15..F-20 + observability/audit-log.md.
 */

import type {
  ConcernAuditEvent,
  ConcernIntake,
  ConcernListItem,
  ConcernRow,
  ConcernUpdate
} from './types';

export interface ConcernAuditEmission {
  event_type: ConcernAuditEvent;
  /** F-17 — NEVER null, regardless of intake `anonymous` flag. */
  actor_pseudonym: string;
  target_id: string;
  meta: Record<string, unknown>;
  /** Request-id correlation handle (Amendment G.7). */
  request_id?: string | null;
}

export interface InsertOk {
  ok: true;
  id: string;
}

export interface InsertDenied {
  ok: false;
  reason: 'rls_denied' | 'rate_limited';
  /** HTTP-shaped status for the route-mapper. 403 for RLS, 429 for rate-limit. */
  status: 403 | 429;
  /** Response body — per F-20 MUST NOT contain PI. */
  body: Record<string, unknown>;
}

export interface ConcernStore {
  // ---- RLS / membership ----
  /**
   * Mirrors `is_active_member(uid)` from the T08.1 SQL migration. The
   * concern-core's INSERT path queries this BEFORE attempting the insert
   * so RLS denials surface as a structured `{ ok: false, reason: 'rls_denied' }`
   * rather than a Postgres error code.
   */
  isActiveMember(user_id: string): Promise<boolean>;

  // ---- Concerns ----
  /**
   * Insert a concern row. Returns `{ ok: false, reason: 'rls_denied' }`
   * when `is_active_member(actor_id) === false`. The audit emission for
   * `concern.created` is the caller's responsibility (concern-core wires
   * it) so a single transaction can sequence RLS check → row insert →
   * audit emit → return.
   */
  insertConcern(opts: {
    actor_id: string;
    actor_pseudonym: string;
    title_ct: Uint8Array;
    body_ct: Uint8Array;
    source_name_ct: Uint8Array | null;
    hazard_class: ConcernIntake['hazard_class'];
    severity: ConcernIntake['severity'];
    location_id: string;
    now: number;
  }): Promise<InsertOk | InsertDenied>;

  /** Read a concern row by id (no projection — used by update + reveal flows). */
  getConcernById(id: string): Promise<ConcernRow | null>;

  /**
   * Update a concern row. The caller (concern-core) supplies the prior
   * field hashes — the store does not re-derive them. Per F-16 the
   * caller emits the `concern.updated` audit row carrying those hashes.
   */
  updateConcern(opts: {
    id: string;
    patch: {
      title_ct?: Uint8Array;
      body_ct?: Uint8Array;
      hazard_class?: ConcernIntake['hazard_class'];
      severity?: ConcernIntake['severity'];
      location_id?: string;
    };
    now: number;
  }): Promise<{ ok: true } | { ok: false; reason: 'not_found' }>;

  /**
   * Default-projection list. Per F-18 this projection MUST NOT include
   * `source_name_ct`. The `ConcernListItem` shape enforces it structurally;
   * tests assert the absence of the key on every row.
   */
  listConcerns(opts: { actor_id: string; limit?: number }): Promise<ConcernListItem[]>;

  // ---- Source-reveal flow (F-18) ----
  /**
   * Return the raw (ciphertext) source_name for a concern. The caller is
   * required by the F-18 contract to emit the `concern.source_revealed`
   * audit row BEFORE handing the ciphertext to the caller. The store
   * itself does not gate this — the concern-core enforces the order.
   */
  getConcernSourceCiphertext(id: string): Promise<Uint8Array | null>;

  // ---- Rate limit (F-20) ----
  /**
   * Atomic check-and-increment. Returns `false` when the actor has
   * already submitted at-or-above the cap for the current window.
   * Defaults: 20/hour/user, 200/24h/user per F-20. The MemoryConcernStore
   * uses a sliding-window count; the production SupabaseConcernStore
   * uses the same shape via a SECURITY DEFINER function.
   */
  tryConsumeRateBudget(opts: { actor_id: string; now: number }): Promise<boolean>;

  /** Test/admin — used by the harness `count(*)::int FROM concerns WHERE actor_id`. */
  countConcernsByActor(actor_id: string): Promise<number>;

  // ---- Audit ----
  recordConcernEvent(event: ConcernAuditEmission): Promise<void>;

  // ---- Helpers ----
  pseudonymOf(uid: string): string;
}

export type { ConcernIntake, ConcernListItem, ConcernRow, ConcernUpdate };
