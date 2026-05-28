/**
 * t14-op / core — high-level work-refusal (s.43) + s.51-evidence RPC client
 * (T14.1; mirrors concern-op / reprisal-op).
 *
 * Forwards to the consolidated SECURITY DEFINER RPCs (migration 0006). F-21 is
 * enforced server-side: write functions gate on is_certified_member,
 * audited reads on is_certified_or_cochair. All title/notes/photo ciphertext is
 * client-sealed (E2EE); the wire carries bytea as PostgREST hex (`\x…`). s.51
 * photos arrive as an array of `\x…` hex strings (bytea[]). Per-record
 * passphrase verification is server-side (HG-6 / G-T14-5/10).
 */

export interface RpcError { code: string | null; message: string }
export type RpcPort = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError | null }>;

export type T14Reason = 'rls_denied' | 'not_found' | 'invalid_input' | 'unknown';

export type OpResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: T14Reason; status: 400 | 403 | 404 | 422 };

const KNOWN_REASONS: ReadonlySet<string> = new Set(['rls_denied', 'not_found', 'invalid_input']);
const STATUS: Record<T14Reason, 400 | 403 | 404 | 422> = { rls_denied: 403, not_found: 404, invalid_input: 422, unknown: 400 };

/** Map Postgres error → T14 denial contract. The functions RAISE the reason literal as the message;
 *  42501 → rls_denied (F-21 gate), 23514 → invalid_input (CHECK violation). */
export function mapRpcError(error: RpcError): { reason: T14Reason; status: 400 | 403 | 404 | 422 } {
  let reason: T14Reason = 'unknown';
  if (KNOWN_REASONS.has(error.message)) reason = error.message as T14Reason;
  else if (error.code === '42501') reason = 'rls_denied';
  else if (error.code === '23514') reason = 'invalid_input';
  return { reason, status: STATUS[reason] };
}

async function call<T>(rpc: RpcPort, fn: string, args: Record<string, unknown>): Promise<OpResult<T>> {
  const { data, error } = await rpc(fn, args);
  if (error) return { ok: false, ...mapRpcError(error) };
  return { ok: true, data: data as T };
}

// ---- work_refusal (s.43) ----------------------------------------------------

export function submitWorkRefusal(rpc: RpcPort, input: { title_ct: string; notes_ct: string; passphrase?: string | null }): Promise<OpResult<{ id: string }>> {
  return call<string>(rpc, 'work_refusal_submit', { p_title_ct: input.title_ct, p_notes_ct: input.notes_ct, p_passphrase: input.passphrase ?? null })
    .then((r) => (r.ok ? { ok: true, data: { id: r.data } } : r));
}

/** HG-6 read. Returns the sealed {title_ct, notes_ct}, or null when denied
 *  (wrong passphrase) or row missing — both surface as no rows. */
export function readWorkRefusal(rpc: RpcPort, input: { id: string; passphrase?: string | null }): Promise<OpResult<{ title_ct: string; notes_ct: string } | null>> {
  return call<Array<{ title_ct: string; notes_ct: string }>>(rpc, 'work_refusal_read', { p_id: input.id, p_passphrase: input.passphrase ?? null })
    .then((r) => (r.ok ? { ok: true, data: r.data?.[0] ?? null } : r));
}

export function updateWorkRefusal(rpc: RpcPort, input: { id: string; title_ct?: string; notes_ct?: string }): Promise<OpResult<null>> {
  const args: Record<string, unknown> = { p_id: input.id };
  if (input.title_ct !== undefined) args.p_title_ct = input.title_ct;
  if (input.notes_ct !== undefined) args.p_notes_ct = input.notes_ct;
  return call<null>(rpc, 'work_refusal_update', args);
}

// ---- s51_evidence -----------------------------------------------------------

export function submitS51(rpc: RpcPort, input: { title_ct: string; notes_ct: string; photos_ct?: string[]; passphrase?: string | null }): Promise<OpResult<{ id: string }>> {
  return call<string>(rpc, 's51_evidence_submit', {
    p_title_ct: input.title_ct,
    p_notes_ct: input.notes_ct,
    p_photos_ct: input.photos_ct ?? [],
    p_passphrase: input.passphrase ?? null
  }).then((r) => (r.ok ? { ok: true, data: { id: r.data } } : r));
}

/** HG-6 read. Returns sealed {title_ct, notes_ct, photos_ct[]} or null. */
export function readS51(rpc: RpcPort, input: { id: string; passphrase?: string | null }): Promise<OpResult<{ title_ct: string; notes_ct: string; photos_ct: string[] } | null>> {
  return call<Array<{ title_ct: string; notes_ct: string; photos_ct: string[] }>>(rpc, 's51_evidence_read', { p_id: input.id, p_passphrase: input.passphrase ?? null })
    .then((r) => (r.ok ? { ok: true, data: r.data?.[0] ?? null } : r));
}

export function updateS51(rpc: RpcPort, input: { id: string; title_ct?: string; notes_ct?: string }): Promise<OpResult<null>> {
  const args: Record<string, unknown> = { p_id: input.id };
  if (input.title_ct !== undefined) args.p_title_ct = input.title_ct;
  if (input.notes_ct !== undefined) args.p_notes_ct = input.notes_ct;
  return call<null>(rpc, 's51_evidence_update', args);
}
