/**
 * auth-op shared types — mirror the AuthStore-side row shapes so the
 * Edge Function and the browser-side `SupabaseAuthStore` agree on the
 * wire-level structure.
 *
 * Drift between this file and `apps/web/src/lib/auth/store.ts` would
 * silently mis-decode RPC results. The browser-side test surface
 * (`apps/web/test/T05/supabase-auth-store.test.ts`) re-asserts the
 * field set; a CI drift-check could be added later if the shapes
 * grow.
 */

export interface UserRow {
  id: string;
  totp_destroyed_at: number | null;
  role?: string;
  active: boolean;
}

/**
 * Server-side PasskeyCredential shape — mirrors `PasskeyCredential` in
 * apps/web/src/lib/auth/types.ts, with field-name conversion for the
 * snake_case ↔ camelCase boundary handled by the dispatcher serializer
 * (NOT by the SQL query, which uses the table's snake_case columns).
 *
 * `publicKey` is the hex-shaped form Postgres returns for a `bytea`
 * column via PostgREST (e.g., `\x04abcd...`). The browser-side
 * AuthStore doesn't validate the key cryptographically — that
 * happens server-side in mint-session — so the hex form is fine.
 */
export interface CredentialRow {
  credentialId: string;
  user_id: string;
  rpId: string;
  publicKey: string;
  counter: number;
  aaguid: string;
  transports: string[];
  device_label: string;
}

/**
 * Server-side AuthSession shape returned by `get_session` /
 * `list_active_sessions`. Mirrors the AuthStore.AuthSession interface
 * with one production-realistic difference: `access_token` is the
 * empty string because the table doesn't store the minted JWT (F-117 —
 * the server never re-emits a previously-minted token).
 *
 * Callers using `getSession` for revocation checks (the F-116 path)
 * or for listing the user's active sessions (UI) don't need the
 * token; the metadata is enough.
 */
export interface SessionRow {
  session_id: string;
  user_id: string;
  access_token: '';
  iat: number;
  exp: number;
  device_fingerprint?: string;
  revoked_at: number | null;
}
