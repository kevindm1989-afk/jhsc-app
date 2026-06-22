/**
 * committee-op / core — high-level committee RPC client (ADR-0023 Decision 3).
 *
 * Runtime: Deno (Supabase Edge Function). Realizes the "SupabaseCommitteeClient"
 * as server-side Edge Function logic so @supabase/supabase-js stays out of the
 * browser bundle (CSP connect-src 'self' + the no-third-party-JS gate). The app
 * is adapter-static, so the browser calls this function; the function calls the
 * SECURITY DEFINER RPCs (migration 00000000000002) with the caller's JWT.
 *
 * This core is the testable heart: it takes an injected `RpcPort` (a thin
 * "call a named RPC, get {data,error}" seam) and maps Postgres errors raised by
 * the committee functions onto the SAME {ok:false,reason} contract the T06
 * library (committee-core) produces, so the production surface matches the
 * MemoryCommitteeStore reference. The handler (index.ts) constructs the real
 * RpcPort from a JWT-bound supabase client in a later increment.
 */

export interface RpcError {
  /** Postgres SQLSTATE, e.g. '42501' (insufficient_privilege), 'P0001', '23514'. */
  code: string | null;
  /** The RAISE message — our functions raise the reason literal directly. */
  message: string;
}

/** Calls a named Postgres RPC; mirrors supabase-js `.rpc(fn, args)`. */
export type RpcPort = (
  fn: string,
  args: Record<string, unknown>
) => Promise<{ data: unknown; error: RpcError | null }>;

export type CommitteeReason =
  | 'rls_denied'
  | '4eyes_required'
  | 'last_co_chair'
  | 'invalid_role'
  | 'employer_contact_rejected'
  | 'not_found'
  | 'invite_invalid'
  | 'already_active'
  | 'membership_exists'
  | 'unknown';

export type OpResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: CommitteeReason; status: 400 | 403 | 404 | 409 | 422 };

const KNOWN_REASONS: ReadonlySet<string> = new Set([
  'rls_denied',
  '4eyes_required',
  'last_co_chair',
  'invalid_role',
  'employer_contact_rejected',
  'not_found',
  'invite_invalid',
  'already_active',
  'membership_exists'
]);

const STATUS: Record<CommitteeReason, 400 | 403 | 404 | 409 | 422> = {
  rls_denied: 403,
  '4eyes_required': 403,
  last_co_chair: 409,
  already_active: 409,
  membership_exists: 409,
  not_found: 404,
  invalid_role: 422,
  employer_contact_rejected: 422,
  invite_invalid: 422,
  unknown: 400
};

/**
 * Map a Postgres error onto the committee denial contract. The committee
 * functions RAISE the reason literal as the message (e.g. `RAISE EXCEPTION
 * 'rls_denied'`), so message-matching is authoritative; SQLSTATE is the
 * fallback (42501 → rls_denied, 23514 check-violation → invalid_role).
 */
export function mapRpcError(error: RpcError): { reason: CommitteeReason; status: 400 | 403 | 404 | 409 | 422 } {
  let reason: CommitteeReason = 'unknown';
  if (KNOWN_REASONS.has(error.message)) {
    reason = error.message as CommitteeReason;
  } else if (error.code === '42501') {
    reason = 'rls_denied';
  } else if (error.code === '23514') {
    reason = 'invalid_role';
  }
  return { reason, status: STATUS[reason] };
}

async function call<T>(rpc: RpcPort, fn: string, args: Record<string, unknown>): Promise<OpResult<T>> {
  const { data, error } = await rpc(fn, args);
  if (error) return { ok: false, ...mapRpcError(error) };
  return { ok: true, data: data as T };
}

// ---- High-level operations (one per SECURITY DEFINER RPC) -------------------

export function inviteMember(
  rpc: RpcPort,
  opts: {
    target_user_id: string;
    roles: string[];
    display_name?: string | null;
    off_employer_contact?: string | null;
  }
): Promise<OpResult<{ invite_id: string }>> {
  return call(rpc, 'committee_invite_member', {
    p_target_user_id: opts.target_user_id,
    p_roles: opts.roles,
    p_display_name: opts.display_name ?? null,
    p_off_employer_contact: opts.off_employer_contact ?? null
  }).then((r) => (r.ok ? { ok: true, data: { invite_id: r.data as unknown as string } } : r));
}

export function activateMembership(
  rpc: RpcPort,
  opts: { invite_id: string; enrolling_uid: string }
): Promise<OpResult<null>> {
  return call(rpc, 'committee_activate_membership', {
    p_invite_id: opts.invite_id,
    p_enrolling_uid: opts.enrolling_uid
  });
}

export function setRoles(
  rpc: RpcPort,
  opts: { target_user_id: string; roles: string[]; second_approver_id?: string | null }
): Promise<OpResult<null>> {
  return call(rpc, 'committee_set_roles', {
    p_target_user_id: opts.target_user_id,
    p_roles: opts.roles,
    p_second_approver_id: opts.second_approver_id ?? null
  });
}

export function removeMember(
  rpc: RpcPort,
  opts: { target_user_id: string; second_approver_id?: string | null }
): Promise<OpResult<{ grace_until: string }>> {
  return call(rpc, 'committee_remove_member', {
    p_target_user_id: opts.target_user_id,
    p_second_approver_id: opts.second_approver_id ?? null
  });
}

export function reactivateMember(
  rpc: RpcPort,
  opts: { target_user_id: string }
): Promise<OpResult<null>> {
  return call(rpc, 'committee_reactivate_member', { p_target_user_id: opts.target_user_id });
}

/**
 * ADR-0029 P1-3 — co-chair-side invite issuance via the SQL keystone
 * `issue_member_invite(p_roles text[], p_totp_code text, p_ttl_minutes int)`
 * (migration 0041). The keystone:
 *   - validates the co-chair gate + role array,
 *   - creates the invitee `public.users` row,
 *   - creates an `auth_totp_bootstraps` row (15-min TTL, secret_hash = HMAC(code)),
 *   - delegates to `committee_invite_member` with the named bootstrap_id/ttl,
 *   - returns ONE row `{invite_id, invitee_user_id, bootstrap_id}` which
 *     supabase-js delivers as a single object on `data` (matching how
 *     `inviteMember` reads its scalar result).
 *
 * F-176: the raw 6-digit `code` is forwarded to the RPC as `p_totp_code` and
 * then never touched here again — no log, no error body, no carrying field
 * on the OpResult. The RPC stores only `HMAC(code)` at rest.
 *
 * Note (back-compat / Decision 3): the existing `inviteMember` arm is
 * untouched and continues to call `committee_invite_member` directly for the
 * "user row already exists" reactivation path.
 */
export function issueInvite(
  rpc: RpcPort,
  opts: { roles: string[]; code: string; ttl_minutes: number }
): Promise<
  OpResult<{ invite_id: string; invitee_user_id: string; bootstrap_id: string }>
> {
  // Field names match the keystone signature byte-for-byte
  // (migration 0041:54-58): p_roles / p_totp_code / p_ttl_minutes.
  return call(rpc, 'issue_member_invite', {
    p_roles: opts.roles,
    p_totp_code: opts.code,
    p_ttl_minutes: opts.ttl_minutes
  });
}
