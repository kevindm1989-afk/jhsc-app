/**
 * SupabaseConcernClient — production-shaped client for the concern-op
 * Edge Function (T08.1 / G-T08-2).
 *
 * Same design rationale as SupabaseT07Client (see ../crypto/supabase-t07-client.ts):
 * the test orchestrator's `ConcernStore` interface decomposes a single
 * high-level operation (submit a concern, reveal the source) into many small
 * steps (isActiveMember + tryConsumeRateBudget + insertConcern +
 * recordConcernEvent etc.). PRODUCTION folds these into one SECURITY DEFINER
 * SQL function per high-level op (`concern_submit` / `concern_update` /
 * `reveal_concern_source` from migration 0004) — atomicity is the point. A
 * 1:1 `SupabaseConcernStore implements ConcernStore` would have to either
 * (a) leave most methods as throw-stubs or (b) re-implement the server-side
 * orchestration in TS, defeating atomicity. So we expose the HIGH-LEVEL
 * operations 1:1 with the concern-op Edge Function ops; downstream callers
 * (T19 onboarding, concern intake UI) invoke them directly.
 *
 * Wire format: every op POSTs `{ op: <name>, ...args }` JSON to concern-op
 * with the caller's JWT in `Authorization: Bearer`. The Edge Function calls
 * the corresponding SECURITY DEFINER SQL function and returns
 * `{ ok: true, data: ... } | { ok: false, error: <ConcernReason>, status: <http> }`
 * mirroring `supabase/functions/concern-op/core.ts`.
 *
 * Transport injection: the constructor takes an `invoke` function so this
 * module has zero runtime dependency on `@supabase/supabase-js`. Production
 * callers wire `invoke` to `supabase.functions.invoke('concern-op', { body: op })`
 * (or a hand-rolled fetch); tests inject a stub that records calls.
 *
 * E2EE: all ciphertext (title_ct, body_ct, source_name_ct) is sealed
 * CLIENT-SIDE under the committee key (ADR-0003 Invariant 1) before being
 * handed to this client. The wire carries bytea as PostgREST hex (`\x…`);
 * this layer never sees plaintext or the key.
 */

import { bytesToPgHex, pgHexToBytes } from '../server-client/pg-hex';

// ---------------------------------------------------------------------------
// Wire shape — mirrors supabase/functions/concern-op/core.ts ConcernReason.
// ---------------------------------------------------------------------------

export type ConcernOpReason =
  | 'rls_denied'
  | 'rate_limited'
  | 'not_found'
  | 'invalid_input'
  | 'unknown';

export type ConcernOpResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: ConcernOpReason; status: number };

/**
 * Edge Function transport. Returns the parsed JSON body + the response
 * status. Implementations live next to whichever Supabase client the
 * caller uses; see the SupabaseT07Client docstring for a wiring example.
 */
export type ConcernOpTransport = (
  body: Record<string, unknown>
) => Promise<{ status: number; body: unknown }>;

interface ConcernOpWireOk<T> {
  ok: true;
  data: T;
}
interface ConcernOpWireErr {
  ok: false;
  error: ConcernOpReason;
}

async function invoke<T>(
  transport: ConcernOpTransport,
  body: Record<string, unknown>
): Promise<ConcernOpResult<T>> {
  const r = await transport(body);
  const payload = r.body as Partial<ConcernOpWireOk<T>> & Partial<ConcernOpWireErr>;
  if (payload && payload.ok === true) {
    return { ok: true, data: payload.data as T };
  }
  const reason: ConcernOpReason = (payload?.error as ConcernOpReason | undefined) ?? 'unknown';
  return { ok: false, reason, status: r.status };
}

// ---------------------------------------------------------------------------
// SupabaseConcernClient
// ---------------------------------------------------------------------------

export interface SupabaseConcernClientOptions {
  transport: ConcernOpTransport;
}

/**
 * Mirror of the `ConcernListItem` shape exposed by the
 * `concerns_default_view` (F-18 — no source_name_ct). The list op returns
 * an array of these.
 */
export interface ConcernListRow {
  id: string;
  title_ct: string;
  body_ct: string;
  hazard_class: string;
  severity: string;
  location_id: string;
  anonymous_default_kept: boolean;
  created_at: string;
  actor_pseudonym: string;
}

export class SupabaseConcernClient {
  constructor(private opts: SupabaseConcernClientOptions) {}

  /**
   * Submit a concern. The caller has already sealed title/body/source-name
   * under the committee key; we wire-encode the bytea and post to
   * concern-op. The Edge Function calls `concern_submit` which gates on
   * session_is_live + is_active_member, enforces the rate budget (F-20),
   * writes the row, and emits `concern.created` — all in one transaction.
   * F-17: `actor_id` is always recorded server-side from `auth.uid()`,
   * regardless of the `anonymous` flag.
   */
  submitConcern(input: {
    title_ct: Uint8Array;
    body_ct: Uint8Array;
    hazard_class: string;
    severity: string;
    location_id: string;
    anonymous: boolean;
    source_name_ct?: Uint8Array | null;
    source_passphrase?: string | null;
  }): Promise<ConcernOpResult<{ id: string }>> {
    return invoke<{ id: string }>(this.opts.transport, {
      op: 'submit',
      title_ct: bytesToPgHex(input.title_ct),
      body_ct: bytesToPgHex(input.body_ct),
      hazard_class: input.hazard_class,
      severity: input.severity,
      location_id: input.location_id,
      anonymous: input.anonymous,
      source_name_ct: input.source_name_ct ? bytesToPgHex(input.source_name_ct) : null,
      source_passphrase: input.source_passphrase ?? null
    });
  }

  /**
   * Update a concern row. Only provided fields are forwarded; the SQL
   * treats NULL as "unchanged". The audit row carries
   * `prev_field_hashes` (F-16) computed server-side from the prior
   * ciphertext columns, not from anything supplied here.
   */
  updateConcern(input: {
    id: string;
    title_ct?: Uint8Array;
    body_ct?: Uint8Array;
    hazard_class?: string;
    severity?: string;
    location_id?: string;
  }): Promise<ConcernOpResult<null>> {
    const args: Record<string, unknown> = { op: 'update', id: input.id };
    if (input.title_ct !== undefined) args.title_ct = bytesToPgHex(input.title_ct);
    if (input.body_ct !== undefined) args.body_ct = bytesToPgHex(input.body_ct);
    if (input.hazard_class !== undefined) args.hazard_class = input.hazard_class;
    if (input.severity !== undefined) args.severity = input.severity;
    if (input.location_id !== undefined) args.location_id = input.location_id;
    return invoke<null>(this.opts.transport, args);
  }

  /**
   * F-18 source-reveal. The SQL function `reveal_concern_source` emits the
   * `concern.source_revealed` audit row BEFORE returning the ciphertext —
   * the row persists even if the response is dropped on the wire. Returns
   * the sealed `source_name_ct` as `Uint8Array`, or `null` when the
   * concern was logged anonymously (no source recorded).
   */
  async revealConcernSource(input: {
    id: string;
    passphrase?: string | null;
  }): Promise<ConcernOpResult<{ source_name_ct: Uint8Array | null; key_id?: string }>> {
    const r = await invoke<{ source_name_ct: string | null; key_id?: string }>(
      this.opts.transport,
      {
        op: 'reveal',
        id: input.id,
        passphrase: input.passphrase ?? null
      }
    );
    if (!r.ok) return r;
    const data: { source_name_ct: Uint8Array | null; key_id?: string } = {
      source_name_ct: r.data.source_name_ct ? pgHexToBytes(r.data.source_name_ct) : null
    };
    // ADR-0027 PR2 / C2 — pass through any server-observed key_id so the
    // production composition can route it through holder.onKeyRotationObserved.
    if (typeof r.data.key_id === 'string' && r.data.key_id.length > 0) {
      data.key_id = r.data.key_id;
    }
    return { ok: true, data };
  }

  /**
   * List concerns via the default projection. Per F-18 this projection
   * MUST NOT include `source_name_ct`; the `ConcernListRow` shape enforces
   * the absence structurally.
   */
  listConcerns(): Promise<ConcernOpResult<ConcernListRow[]>> {
    return invoke<ConcernListRow[]>(this.opts.transport, { op: 'list' });
  }
}
