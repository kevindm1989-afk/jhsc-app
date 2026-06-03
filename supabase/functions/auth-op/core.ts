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

import type { UserRow } from './types.ts';

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

    // Every other AuthStore method is staged-not-implemented; each one
    // lands as a follow-up PR with its own dispatcher case + tests +
    // (where required) migration / RPC binding. Maintaining a single
    // 'not_implemented' return for un-wired ops keeps the client side
    // able to depend on a stable shape across the staging window.
    default:
      return { ok: false, reason: 'not_implemented', status: 501 };
  }
}
