/**
 * reprisal-op / core — high-level reprisal RPC client (T13.1; mirrors
 * concern-op/core.ts). Edge Function, not a +server.ts (adapter-static).
 *
 * Forwards to the consolidated SECURITY DEFINER RPCs (migration 0005), each of
 * which gates (session_is_live + is_active_member) and audits in one txn, and
 * maps the Postgres RAISEs onto a stable {ok,reason,status} contract. All
 * title/body ciphertext is sealed CLIENT-SIDE under the committee key (E2EE);
 * the wire carries bytea as PostgREST hex (`\x…`). The per-record passphrase
 * (HG-6 / G-T13-6) is a UX friction gate verified server-side.
 */

export interface RpcError {
  code: string | null;
  message: string;
}

export type RpcPort = (
  fn: string,
  args: Record<string, unknown>
) => Promise<{ data: unknown; error: RpcError | null }>;

export type ReprisalReason =
  | 'rls_denied'
  | 'rate_limited'
  | 'not_found'
  | 'self_approve_denied'
  | 'role_pair_invalid'
  | 'expired'
  | 'invalid_status'
  | 'unknown';

export type OpResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: ReprisalReason; status: 400 | 403 | 404 | 409 | 422 | 429 };

const KNOWN_REASONS: ReadonlySet<string> = new Set([
  'rls_denied',
  'rate_limited',
  'not_found',
  'self_approve_denied',
  'role_pair_invalid',
  'expired',
  'invalid_status'
]);

const STATUS: Record<ReprisalReason, 400 | 403 | 404 | 409 | 422 | 429> = {
  rls_denied: 403,
  self_approve_denied: 403,
  role_pair_invalid: 403,
  rate_limited: 429,
  not_found: 404,
  expired: 409,
  invalid_status: 422,
  unknown: 400
};

/**
 * Map a Postgres error onto the reprisal denial contract. The functions RAISE
 * the reason literal as the message (so self_approve_denied / role_pair_invalid
 * — though raised with SQLSTATE 42501 — map by message, not collapse to
 * rls_denied); SQLSTATE is the fallback (42501 → rls_denied, 23514 →
 * invalid_status).
 */
export function mapRpcError(error: RpcError): { reason: ReprisalReason; status: 400 | 403 | 404 | 409 | 422 | 429 } {
  let reason: ReprisalReason = 'unknown';
  if (KNOWN_REASONS.has(error.message)) {
    reason = error.message as ReprisalReason;
  } else if (error.code === '42501') {
    reason = 'rls_denied';
  } else if (error.code === '23514') {
    reason = 'invalid_status';
  }
  return { reason, status: STATUS[reason] };
}

async function call<T>(rpc: RpcPort, fn: string, args: Record<string, unknown>): Promise<OpResult<T>> {
  const { data, error } = await rpc(fn, args);
  if (error) return { ok: false, ...mapRpcError(error) };
  return { ok: true, data: data as T };
}

// ---- operations -------------------------------------------------------------

export function submitReprisal(
  rpc: RpcPort,
  input: { title_ct: string; body_ct: string; passphrase?: string | null }
): Promise<OpResult<{ id: string }>> {
  return call<string>(rpc, 'reprisal_submit', {
    p_title_ct: input.title_ct,
    p_body_ct: input.body_ct,
    p_passphrase: input.passphrase ?? null
  }).then((r) => (r.ok ? { ok: true, data: { id: r.data } } : r));
}

/** HG-6 read. Returns the sealed {title_ct, body_ct}, or null when the read was
 *  denied (wrong passphrase) or the row is missing — both surface as no rows. */
export function readReprisal(
  rpc: RpcPort,
  input: { id: string; passphrase?: string | null }
): Promise<OpResult<{ title_ct: string; body_ct: string } | null>> {
  return call<Array<{ title_ct: string; body_ct: string }>>(rpc, 'reprisal_read', {
    p_id: input.id,
    p_passphrase: input.passphrase ?? null
  }).then((r) => (r.ok ? { ok: true, data: r.data?.[0] ?? null } : r));
}

export function updateReprisal(
  rpc: RpcPort,
  input: { id: string; title_ct?: string; body_ct?: string }
): Promise<OpResult<null>> {
  const args: Record<string, unknown> = { p_id: input.id };
  if (input.title_ct !== undefined) args.p_title_ct = input.title_ct;
  if (input.body_ct !== undefined) args.p_body_ct = input.body_ct;
  return call<null>(rpc, 'reprisal_update', args);
}

export function proposeStatus(
  rpc: RpcPort,
  input: { reprisal_id: string; new_status: string }
): Promise<OpResult<{ pending_id: string }>> {
  return call<string>(rpc, 'reprisal_propose_status', {
    p_reprisal_id: input.reprisal_id,
    p_new_status: input.new_status
  }).then((r) => (r.ok ? { ok: true, data: { pending_id: r.data } } : r));
}

export function approveStatus(rpc: RpcPort, input: { pending_id: string }): Promise<OpResult<null>> {
  return call<null>(rpc, 'reprisal_approve_status', { p_pending_id: input.pending_id });
}

export function proposeForensic(
  rpc: RpcPort,
  input: { audit_log_id: string; reveal_reason: string }
): Promise<OpResult<{ pending_id: string }>> {
  return call<string>(rpc, 'reprisal_propose_forensic', {
    p_audit_log_id: input.audit_log_id,
    p_reveal_reason: input.reveal_reason
  }).then((r) => (r.ok ? { ok: true, data: { pending_id: r.data } } : r));
}

/** Approve a forensic reveal; returns the revealed actor pseudonym (≤24h). */
export function approveForensic(
  rpc: RpcPort,
  input: { pending_id: string }
): Promise<OpResult<{ revealed_actor_pseudonym: string | null }>> {
  return call<string | null>(rpc, 'reprisal_approve_forensic', { p_pending_id: input.pending_id }).then((r) =>
    r.ok ? { ok: true, data: { revealed_actor_pseudonym: r.data } } : r
  );
}
