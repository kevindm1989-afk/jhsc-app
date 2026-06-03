/**
 * auth-op / core — T05.1 SupabaseAuthStore Edge Function entry point.
 *
 * Runtime: Deno (Supabase Edge Function). This module is the testable
 * dispatcher + business logic; the HTTP handler (index.ts) handles
 * Deno.serve wiring + JSON parsing and forwards to `handleAuthOp`.
 *
 * Closes G-T05-1 incrementally: every method on the browser-side
 * `AuthStore` interface routes through this dispatcher via a single
 * Edge Function endpoint (`/functions/v1/auth-op`) instead of one
 * Edge Function per method (mirrors the op-dispatch pattern used by
 * `concern-op`, `reprisal-op`, `t07-op`).
 *
 * First wired op: `get_user`. The remaining ~30 AuthStore methods land
 * incrementally — each one adds a case to the switch + a corresponding
 * test. Until a method is wired, the dispatcher returns
 * `{ ok: false, reason: 'not_implemented', status: 501 }`.
 *
 * Threat conditions (carried forward from T05):
 *   - F-43: TOTP destruction is atomic with first-passkey enrollment
 *     (handled by the `consume_totp_and_enroll_passkey` op when wired).
 *   - F-117: any op that returns a user identifier derives it
 *     server-side from the credential / session, NEVER from the
 *     request body.
 *   - Hard rule (decisions.md §4): the SUPABASE-JS SDK is server-only.
 *     The browser hits this Edge Function via the shared
 *     `createEdgeFnFetchTransport`; no `@supabase/supabase-js` ships
 *     in the browser bundle.
 */

import type { CredentialRow, SessionRow, UserRow } from './types.ts';

export type AuthOpReason =
  | 'bad_request'
  | 'not_implemented'
  | 'not_found'
  | 'rls_denied'
  | 'unknown';

export type AuthOpResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; reason: AuthOpReason; status: number };

/**
 * Persistence + audit dependencies. The HTTP handler wires real
 * `@supabase/supabase-js`-backed implementations; tests inject stubs.
 */
export interface AuthOpDeps {
  getUserById(user_id: string): Promise<UserRow | null>;
  getSessionById(session_id: string): Promise<SessionRow | null>;
  listActiveSessionsForUser(user_id: string): Promise<SessionRow[]>;
  listCredentialsForUser(user_id: string): Promise<CredentialRow[]>;
  revokeMySession(session_id: string): Promise<{ ok: true } | { ok: false; reason: AuthOpReason; status: number }>;
  revokeAllMySessions(): Promise<{ ok: true; data: { revoked_count: number } } | { ok: false; reason: AuthOpReason; status: number }>;
  revokeMyPasskey(credential_id: string): Promise<{ ok: true } | { ok: false; reason: AuthOpReason; status: number }>;
  /**
   * The caller's `auth.uid()` from the JWT. Used by the dispatcher to
   * enforce that AuthStore.revokeAllForUser's `user_id` argument
   * matches the caller — the SQL wrapper ignores any client-supplied
   * user_id and derives from auth.uid(), but the dispatcher rejects
   * impersonation attempts up-front (clearer error than letting the
   * wrapper silently revoke a different user's sessions than the
   * caller intended).
   */
  callerUid(): Promise<string | null>;
}

/**
 * Generic op-dispatch input. Every browser-side AuthStore method
 * serialises to `{ op: '<name>', ...args }` per the
 * `SupabaseAuthStore` client encoding.
 */
export interface AuthOpInput {
  op: string;
  [key: string]: unknown;
}

export async function handleAuthOp(
  input: AuthOpInput,
  deps: AuthOpDeps
): Promise<AuthOpResult> {
  if (!input || typeof input !== 'object' || typeof input.op !== 'string') {
    return { ok: false, reason: 'bad_request', status: 400 };
  }

  switch (input.op) {
    case 'get_user': {
      const user_id = typeof input.user_id === 'string' ? input.user_id : '';
      if (!user_id) return { ok: false, reason: 'bad_request', status: 400 };
      const row = await deps.getUserById(user_id);
      if (row === null) return { ok: false, reason: 'not_found', status: 404 };
      return { ok: true, data: row };
    }

    case 'get_session': {
      const session_id = typeof input.session_id === 'string' ? input.session_id : '';
      if (!session_id) return { ok: false, reason: 'bad_request', status: 400 };
      const row = await deps.getSessionById(session_id);
      if (row === null) return { ok: false, reason: 'not_found', status: 404 };
      return { ok: true, data: row };
    }

    case 'list_active_sessions': {
      const user_id = typeof input.user_id === 'string' ? input.user_id : '';
      if (!user_id) return { ok: false, reason: 'bad_request', status: 400 };
      const rows = await deps.listActiveSessionsForUser(user_id);
      // Empty result is `{ok: true, data: []}`, NOT `not_found` — a
      // user with no active sessions is a normal state (e.g., right
      // after logout-everywhere), not an error.
      return { ok: true, data: rows };
    }

    case 'revoke_session': {
      // Invokes the `revoke_my_session` SECURITY DEFINER wrapper that
      // verifies auth.uid() = session.user_id internally. The
      // dispatcher passes session_id through; ownership enforcement
      // happens inside the SQL function (G-T05-3 partial close).
      const session_id = typeof input.session_id === 'string' ? input.session_id : '';
      if (!session_id) return { ok: false, reason: 'bad_request', status: 400 };
      const r = await deps.revokeMySession(session_id);
      if (!r.ok) return r;
      // The AuthStore.revokeSession contract returns void on success.
      // Return null in the data slot so the wire shape stays
      // `{ok:true, data:...}`.
      return { ok: true, data: null };
    }

    case 'revoke_all_for_user': {
      // The AuthStore.revokeAllForUser signature takes a user_id, but
      // the Supabase wrapper restricts to self-revoke. Verify that the
      // requested user_id matches the caller's auth.uid() up-front; if
      // not, return rls_denied immediately so the client sees a clear
      // error rather than silently revoking nothing (the wrapper
      // ignores client-supplied user_id and derives from auth.uid()).
      const user_id = typeof input.user_id === 'string' ? input.user_id : '';
      if (!user_id) return { ok: false, reason: 'bad_request', status: 400 };
      const callerUid = await deps.callerUid();
      if (!callerUid || callerUid !== user_id) {
        return { ok: false, reason: 'rls_denied', status: 403 };
      }
      const r = await deps.revokeAllMySessions();
      if (!r.ok) return r;
      // AuthStore.revokeAllForUser returns the array of session_ids
      // revoked. We can't enumerate them from a bulk UPDATE without
      // adding RETURNING — so we return the count for now and the
      // browser-side AuthStore returns an empty array (the contract
      // doesn't depend on the exact session_ids; callers use it for
      // logging). A future PR can extend the SQL function to RETURNING
      // session_id[] if a consumer needs the list.
      return { ok: true, data: r.data };
    }

    case 'revoke_passkey': {
      // Invokes the `revoke_my_passkey` SECURITY DEFINER wrapper.
      // Collapsed rls_denied on both "not yours" and "not found".
      const credential_id =
        typeof input.credential_id === 'string' ? input.credential_id : '';
      if (!credential_id) return { ok: false, reason: 'bad_request', status: 400 };
      const r = await deps.revokeMyPasskey(credential_id);
      if (!r.ok) return r;
      return { ok: true, data: null };
    }

    case 'list_credentials_for_user': {
      // Lists the caller's WebAuthn credentials. RLS enforces row-
      // scope via `webauthn_credentials_select_self` (auth.uid() =
      // user_id), so a caller can only see their own credentials.
      // Empty result is a normal state (e.g., a freshly-revoked
      // account); returns `{ok: true, data: []}`, NOT 404.
      const user_id = typeof input.user_id === 'string' ? input.user_id : '';
      if (!user_id) return { ok: false, reason: 'bad_request', status: 400 };
      const rows = await deps.listCredentialsForUser(user_id);
      return { ok: true, data: rows };
    }

    // Every other AuthStore method is staged-not-implemented; each one
    // lands as a follow-up PR with its own dispatcher case + tests +
    // (where required) migration / RPC binding. Maintaining a single
    // 'not_implemented' return for un-wired ops keeps the client side
    // able to depend on a stable shape across the staging window.
    default:
      return { ok: false, reason: 'not_implemented', status: 501 };
  }
}
