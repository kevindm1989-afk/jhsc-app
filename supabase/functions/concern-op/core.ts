/**
 * concern-op / core — high-level concern RPC client (T08.1; mirrors
 * committee-op/core.ts, ADR-0023 Decision 3).
 *
 * Runtime: Deno (Supabase Edge Function). The app is adapter-static (no
 * SvelteKit server runtime), so — exactly like committee-op — the concern
 * write/read path is an Edge Function, NOT a `+server.ts` route (this
 * supersedes the `/api/concerns/+server.ts` framing in G-T08-7; the
 * `requireAuthenticated` gate is the JWT-bound client + the RPC's own
 * session_is_live()/is_active_member() checks). Keeping @supabase/supabase-js
 * out of the browser bundle (CSP connect-src 'self' + the no-third-party-JS
 * gate) is the same rationale committee-op records.
 *
 * The consolidated SQL RPCs (concern_submit / concern_update /
 * reveal_concern_source — migration 00000000000004) each do gate → (rate) →
 * write → audit in ONE transaction. This core forwards to them and maps the
 * Postgres errors they RAISE onto a stable {ok,reason,status} contract. All
 * ciphertext is sealed CLIENT-SIDE under the committee key (E2EE); the wire
 * carries bytea as PostgREST hex (`\x…`) strings — this layer never sees
 * plaintext or the key.
 */

export interface RpcError {
  /** Postgres SQLSTATE, e.g. '42501', 'P0001', '23514'. */
  code: string | null;
  /** The RAISE message — our functions raise the reason literal directly. */
  message: string;
}

/** Calls a named Postgres RPC; mirrors supabase-js `.rpc(fn, args)`. */
export type RpcPort = (
  fn: string,
  args: Record<string, unknown>
) => Promise<{ data: unknown; error: RpcError | null }>;

export type ConcernReason = 'rls_denied' | 'rate_limited' | 'not_found' | 'invalid_input' | 'unknown';

export type OpResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: ConcernReason; status: 400 | 403 | 404 | 422 | 429 };

const KNOWN_REASONS: ReadonlySet<string> = new Set([
  'rls_denied',
  'rate_limited',
  'not_found',
  'invalid_input'
]);

const STATUS: Record<ConcernReason, 400 | 403 | 404 | 422 | 429> = {
  rls_denied: 403,
  rate_limited: 429,
  not_found: 404,
  invalid_input: 422,
  unknown: 400
};

/**
 * Map a Postgres error onto the concern denial contract. The concern functions
 * RAISE the reason literal as the message (`rls_denied` / `rate_limited` /
 * `not_found`); SQLSTATE is the fallback (42501 → rls_denied, 23514
 * check-violation → invalid_input, e.g. a bad hazard_class/severity enum).
 */
export function mapRpcError(error: RpcError): { reason: ConcernReason; status: 400 | 403 | 404 | 422 | 429 } {
  let reason: ConcernReason = 'unknown';
  if (KNOWN_REASONS.has(error.message)) {
    reason = error.message as ConcernReason;
  } else if (error.code === '42501') {
    reason = 'rls_denied';
  } else if (error.code === '23514') {
    reason = 'invalid_input';
  }
  return { reason, status: STATUS[reason] };
}

async function call<T>(rpc: RpcPort, fn: string, args: Record<string, unknown>): Promise<OpResult<T>> {
  const { data, error } = await rpc(fn, args);
  if (error) return { ok: false, ...mapRpcError(error) };
  return { ok: true, data: data as T };
}

// ---- High-level operations (one per SECURITY DEFINER RPC) -------------------

export interface SubmitConcernInput {
  /** Committee-key-sealed ciphertext as PostgREST bytea hex (`\x…`). */
  title_ct: string;
  body_ct: string;
  hazard_class: string;
  severity: string;
  location_id: string;
  anonymous: boolean;
  /** Required (non-null) when `anonymous === false`; the sealed source name. */
  source_name_ct?: string | null;
  /** Optional per-record reveal passphrase (F-18 / G-T08-6). */
  source_passphrase?: string | null;
}

export function submitConcern(rpc: RpcPort, input: SubmitConcernInput): Promise<OpResult<{ id: string }>> {
  return call<string>(rpc, 'concern_submit', {
    p_title_ct: input.title_ct,
    p_body_ct: input.body_ct,
    p_hazard_class: input.hazard_class,
    p_severity: input.severity,
    p_location_id: input.location_id,
    p_anonymous: input.anonymous,
    p_source_name_ct: input.source_name_ct ?? null,
    p_source_passphrase: input.source_passphrase ?? null
  }).then((r) => (r.ok ? { ok: true, data: { id: r.data } } : r));
}

export interface UpdateConcernInput {
  id: string;
  title_ct?: string;
  body_ct?: string;
  hazard_class?: string;
  severity?: string;
  location_id?: string;
}

export function updateConcern(rpc: RpcPort, input: UpdateConcernInput): Promise<OpResult<null>> {
  // Only forward provided fields; the SQL treats NULL as "unchanged".
  const args: Record<string, unknown> = { p_id: input.id };
  if (input.title_ct !== undefined) args.p_title_ct = input.title_ct;
  if (input.body_ct !== undefined) args.p_body_ct = input.body_ct;
  if (input.hazard_class !== undefined) args.p_hazard_class = input.hazard_class;
  if (input.severity !== undefined) args.p_severity = input.severity;
  if (input.location_id !== undefined) args.p_location_id = input.location_id;
  return call<null>(rpc, 'concern_update', args);
}

/** Reveal the source ciphertext (F-18). Returns the sealed bytea hex, or null
 *  when the concern was logged anonymously. Decryption is client-side. */
export function revealSource(
  rpc: RpcPort,
  input: { id: string; passphrase?: string | null }
): Promise<OpResult<{ source_name_ct: string | null }>> {
  return call<string | null>(rpc, 'reveal_concern_source', {
    p_id: input.id,
    p_passphrase: input.passphrase ?? null
  }).then((r) => (r.ok ? { ok: true, data: { source_name_ct: r.data } } : r));
}
