/**
 * Public API for the JHSC auth surface (T05).
 *
 * Source obligations:
 *   - ADR-0002 — passkeys-only, TOTP enrollment bootstrap.
 *   - F-37..F-43 (threat-model.md §3.1).
 *   - observability/audit-log.md §1 Auth + session.
 *
 * The runtime is a thin client over an in-process or Supabase-backed store
 * (in tests: in-memory; in prod: Supabase Edge Functions wired by
 * `apps/web/src/hooks.server.ts`). The harness in
 * `apps/web/test/_helpers/supabase-test.ts` injects a test client.
 */

export type {
  AuthClient,
  AuthResponse,
  AuthSession,
  PasskeyCredential,
  EnrollResult,
  LoginResult,
  PasskeyAssertResult,
  BrowserBaselineCheck
} from './types';

export { checkBrowserBaseline } from './browser-baseline';
export { rateLimitStore } from './rate-limit';

import type {
  AuthClient,
  EnrollResult,
  LoginResult,
  AuthSession,
  PasskeyCredential
} from './types';

/**
 * Enroll the first device for an account: consume the TOTP bootstrap and
 * bind a new passkey. Per F-43 the TOTP secret is destroyed atomically
 * with the passkey enrollment (the implementation does both in one
 * pseudo-transaction on the in-memory store; the SQL migration uses a
 * real `BEGIN ... COMMIT` block).
 */
export async function enrollFirstDevice(
  auth: AuthClient,
  opts: { totp_code: string; user_id: string }
): Promise<EnrollResult> {
  return auth.enrollFirstDevice(opts);
}

/**
 * Log in with an existing passkey credential. Returns a fresh session.
 *
 * Per ADR-0002, sessions are short-lived (15 min TTL) and have no
 * long-lived refresh token. The `session_id` doubles as the JWT `jti` —
 * the server-side revocation list (F-39) checks against this id on every
 * request.
 */
export async function loginPasskey(
  auth: AuthClient,
  credential: PasskeyCredential,
  opts?: { device_fingerprint?: string }
): Promise<LoginResult> {
  return auth.loginPasskey(credential, opts);
}

/**
 * Revoke ALL sessions for a user (Settings → "Revoke all sessions").
 *
 * Per F-39 this propagates server-side within 5 seconds: subsequent
 * authenticated requests carrying any of the user's outstanding JWTs
 * return 401 immediately.
 *
 * Emits `session.revoked` audit row per `observability/audit-log.md` §1.
 */
export async function revokeAllSessions(auth: AuthClient, user_id: string): Promise<void> {
  return auth.revokeAllSessions(user_id);
}

/**
 * Revoke a single passkey. Subsequent assertions with that credential
 * fail. Emits `auth.passkey.revoked` per `observability/audit-log.md` §1.
 */
export async function revokePasskey(
  auth: AuthClient,
  credentialId: string,
  revoked_by_user_id: string
): Promise<void> {
  return auth.revokePasskey(credentialId, revoked_by_user_id);
}

/**
 * List a user's active sessions (Settings → Sessions surface).
 *
 * Returns only sessions where `revoked_at IS NULL` — the design-system
 * spec at §4.H shows a "Revoke" affordance per row.
 */
export async function listSessions(auth: AuthClient, user_id: string): Promise<AuthSession[]> {
  return auth.listSessions(user_id);
}
