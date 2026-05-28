/**
 * SupabaseReprisalClient — production-shaped client for the reprisal-op
 * Edge Function (T13.1 / G-T13-2).
 *
 * Same design rationale as SupabaseT07Client / SupabaseConcernClient: the
 * test orchestrator's `ReprisalStore` interface decomposes a single
 * high-level operation (submit a reprisal, approve a status flip via
 * 4-eyes, approve a forensic reveal) into many small steps. PRODUCTION
 * folds these into one SECURITY DEFINER SQL function per high-level op
 * (`reprisal_submit` / `reprisal_read` / `reprisal_update` /
 * `reprisal_propose_status` / `reprisal_approve_status` /
 * `reprisal_propose_forensic` / `reprisal_approve_forensic` from migration
 * 0005) — atomicity is the point. So we expose the high-level ops 1:1
 * with the reprisal-op Edge Function ops.
 *
 * Wire format: every op POSTs `{ op: <name>, ...args }` JSON to reprisal-op
 * with the caller's JWT in `Authorization: Bearer`. The Edge Function
 * dispatches to the corresponding SQL function and returns
 * `{ ok: true, data: ... } | { ok: false, error: <ReprisalReason>, status: <http> }`
 * mirroring `supabase/functions/reprisal-op/core.ts`.
 *
 * HG-6 read: `readReprisal` is the audited C4 read — the SQL function
 * `reprisal_read` emits the `reprisal.read` audit row BEFORE returning the
 * ciphertext. On wrong passphrase the row is missing-but-no-throw and a
 * `sensitive.access_attempt` audit row lands instead. Both surface here as
 * `{ ok: true, data: null }` (consistent with the Edge Function contract).
 *
 * Amendment D feed: `listReprisalFeed` reads the pseudonymized
 * `reprisal_feed` view — no actor, ts bucketed to the hour, no ciphertext.
 *
 * E2EE: all ciphertext (title_ct, body_ct) is sealed CLIENT-SIDE under
 * the committee key (ADR-0003 Invariant 1) before being handed to this
 * client. The wire carries bytea as PostgREST hex (`\x…`); this layer
 * never sees plaintext or the key.
 *
 * Transport injection: the constructor takes an `invoke` function so this
 * module has zero runtime dependency on `@supabase/supabase-js`.
 */

import { bytesToPgHex, pgHexToBytes } from '../server-client/pg-hex';

// ---------------------------------------------------------------------------
// Wire shape — mirrors supabase/functions/reprisal-op/core.ts ReprisalReason.
// ---------------------------------------------------------------------------

export type ReprisalOpReason =
  | 'rls_denied'
  | 'rate_limited'
  | 'not_found'
  | 'self_approve_denied'
  | 'role_pair_invalid'
  | 'expired'
  | 'invalid_status'
  | 'unknown';

export type ReprisalOpResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: ReprisalOpReason; status: number };

export type ReprisalOpTransport = (
  body: Record<string, unknown>
) => Promise<{ status: number; body: unknown }>;

interface ReprisalOpWireOk<T> {
  ok: true;
  data: T;
}
interface ReprisalOpWireErr {
  ok: false;
  error: ReprisalOpReason;
}

async function invoke<T>(
  transport: ReprisalOpTransport,
  body: Record<string, unknown>
): Promise<ReprisalOpResult<T>> {
  const r = await transport(body);
  const payload = r.body as Partial<ReprisalOpWireOk<T>> & Partial<ReprisalOpWireErr>;
  if (payload && payload.ok === true) {
    return { ok: true, data: payload.data as T };
  }
  const reason: ReprisalOpReason = (payload?.error as ReprisalOpReason | undefined) ?? 'unknown';
  return { ok: false, reason, status: r.status };
}

// ---------------------------------------------------------------------------
// SupabaseReprisalClient
// ---------------------------------------------------------------------------

export interface SupabaseReprisalClientOptions {
  transport: ReprisalOpTransport;
}

/**
 * Mirror of the Amendment D `reprisal_feed` view shape — pseudonymized,
 * ts bucketed to the hour, NO actor and NO ciphertext.
 */
export interface ReprisalFeedRow {
  id: number;
  event_type: string;
  /** ms-epoch rounded DOWN to the nearest hour boundary. */
  ts_bucketed_to_hour: number;
  target_id: string;
  target_class: 'C4';
  prev_hash: string;
  hash: string;
}

export class SupabaseReprisalClient {
  constructor(private opts: SupabaseReprisalClientOptions) {}

  /**
   * F-17 / F-35 — gates on session_is_live + is_active_member; enforces
   * the rate budget (200/24h, 20/h); INSERTs the row + emits
   * `reprisal.created` atomically. `actor_id` is always recorded
   * server-side from `auth.uid()`. Per-record `passphrase` is the F-34
   * friction-layer gate (G-T13-6); the SQL hashes it with pgcrypto bf.
   */
  submitReprisal(input: {
    title_ct: Uint8Array;
    body_ct: Uint8Array;
    passphrase?: string | null;
  }): Promise<ReprisalOpResult<{ id: string }>> {
    return invoke<{ id: string }>(this.opts.transport, {
      op: 'submit',
      title_ct: bytesToPgHex(input.title_ct),
      body_ct: bytesToPgHex(input.body_ct),
      passphrase: input.passphrase ?? null
    });
  }

  /**
   * HG-6 audited C4 read. The SQL `reprisal_read` audits BEFORE returning
   * the ciphertext (or emits `sensitive.access_attempt` on wrong-passphrase
   * and returns no rows). `null` data covers both "row missing" and
   * "wrong passphrase" — the Edge Function contract collapses them to
   * mirror the SQL function shape.
   */
  async readReprisal(input: {
    id: string;
    passphrase?: string | null;
  }): Promise<ReprisalOpResult<{ title_ct: Uint8Array; body_ct: Uint8Array } | null>> {
    const r = await invoke<{ title_ct: string; body_ct: string } | null>(this.opts.transport, {
      op: 'read',
      id: input.id,
      passphrase: input.passphrase ?? null
    });
    if (!r.ok) return r;
    if (!r.data) return { ok: true, data: null };
    return {
      ok: true,
      data: {
        title_ct: pgHexToBytes(r.data.title_ct),
        body_ct: pgHexToBytes(r.data.body_ct)
      }
    };
  }

  /**
   * F-31 — only provided fields are forwarded; SQL treats NULL as
   * unchanged. The audit row carries `prev_field_hashes` (server-computed
   * from the prior ciphertext columns).
   */
  updateReprisal(input: {
    id: string;
    title_ct?: Uint8Array;
    body_ct?: Uint8Array;
  }): Promise<ReprisalOpResult<null>> {
    const args: Record<string, unknown> = { op: 'update', id: input.id };
    if (input.title_ct !== undefined) args.title_ct = bytesToPgHex(input.title_ct);
    if (input.body_ct !== undefined) args.body_ct = bytesToPgHex(input.body_ct);
    return invoke<null>(this.opts.transport, args);
  }

  // -----------------------------------------------------------------------
  // HG-7 — 4-eyes status flip
  // -----------------------------------------------------------------------

  /**
   * File a status-flip proposal. Emits
   * `reprisal.status_changed.4eyes_pending` and inserts a row in
   * `pending_four_eyes_ops`. Returns the pending op id the approver will
   * reference.
   */
  proposeStatusFlip(input: {
    reprisal_id: string;
    new_status: string;
  }): Promise<ReprisalOpResult<{ pending_id: string }>> {
    return invoke<{ pending_id: string }>(this.opts.transport, {
      op: 'propose_status',
      reprisal_id: input.reprisal_id,
      new_status: input.new_status
    });
  }

  /**
   * Approve a pending status flip. Distinct second active member required
   * (the `self_approve_denied` reason fires when the proposer = approver).
   * Atomic: status flip + `reprisal.status_changed.4eyes_completed` audit.
   */
  approveStatusFlip(input: { pending_id: string }): Promise<ReprisalOpResult<null>> {
    return invoke<null>(this.opts.transport, {
      op: 'approve_status',
      pending_id: input.pending_id
    });
  }

  // -----------------------------------------------------------------------
  // Amendment E — forensic reveal (24h TTL, role-pair restricted)
  // -----------------------------------------------------------------------

  /**
   * File a forensic-reveal proposal against a target audit_log row.
   * Emits `audit.forensic_reveal.4eyes_pending`; the pending row carries
   * a 24h `expires_at`.
   */
  proposeForensicReveal(input: {
    audit_log_id: string;
    reveal_reason: string;
  }): Promise<ReprisalOpResult<{ pending_id: string }>> {
    return invoke<{ pending_id: string }>(this.opts.transport, {
      op: 'propose_forensic',
      audit_log_id: input.audit_log_id,
      reveal_reason: input.reveal_reason
    });
  }

  /**
   * Approve a forensic reveal. Role-pair rule (co-chair+co-chair or
   * co-chair+certified) enforced server-side; `role_pair_invalid` on
   * mismatch. Returns the revealed pseudonym from the target audit_log
   * row, or `null` if the row was already wiped by retention.
   */
  approveForensicReveal(input: {
    pending_id: string;
  }): Promise<ReprisalOpResult<{ revealed_actor_pseudonym: string | null }>> {
    return invoke<{ revealed_actor_pseudonym: string | null }>(this.opts.transport, {
      op: 'approve_forensic',
      pending_id: input.pending_id
    });
  }

  // -----------------------------------------------------------------------
  // Amendment D — pseudonymized feed
  // -----------------------------------------------------------------------

  /**
   * Read the pseudonymized feed (`reprisal_feed` view — Amendment D).
   * Surfaces reprisal.* / work_refusal.* / s51_evidence.* events with
   * ts bucketed to the hour, no actor, no ciphertext. Used by the
   * shared sensitive-activity surface; gated by `is_active_member()` in
   * the view body.
   */
  listReprisalFeed(): Promise<ReprisalOpResult<ReprisalFeedRow[]>> {
    return invoke<ReprisalFeedRow[]>(this.opts.transport, { op: 'feed' });
  }
}
