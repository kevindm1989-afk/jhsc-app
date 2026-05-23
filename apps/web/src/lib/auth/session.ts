/**
 * Session management — create, list, revoke.
 *
 * Source obligations:
 *   - ADR-0002 — 15-min session TTL; no long-lived refresh token.
 *   - F-39 — server-side jti revocation; ≤5s propagation; revoked session
 *     remains 401 for the JWT's TTL.
 *   - design-system §4.H — Session list + per-device revocation.
 *   - audit-log.md §1 — `session.revoked` emission shape.
 *
 * Implementation lives in `./auth-core.ts`; this module is a re-export
 * surface so the file structure matches the prompt.
 */

import type { AuthClient, AuthSession } from './types';

export async function listSessions(auth: AuthClient, user_id: string): Promise<AuthSession[]> {
  return auth.listSessions(user_id);
}

export async function revokeOneSession(auth: AuthClient, session_id: string): Promise<void> {
  await auth.revokeSession(session_id);
}

export async function revokeAllSessions(auth: AuthClient, user_id: string): Promise<void> {
  return auth.revokeAllSessions(user_id);
}
