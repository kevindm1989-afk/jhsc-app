/**
 * Auth-store interface (T05).
 *
 * The auth client is intentionally split from its persistence so that the
 * Vitest harness can substitute an in-memory store while production wires
 * Supabase Edge Functions backed by the migration in
 * `supabase/migrations/00000000000001_auth.sql`.
 *
 * Every method on `AuthStore` corresponds to a single SQL operation (or a
 * `BEGIN ... COMMIT` transaction in the case of `consumeTotpAndEnrollPasskey`).
 * The interface is the contract between auth-core and the persistence layer;
 * adding a method requires updating both sides.
 */

import type { AuthSession, PasskeyCredential } from './types';

export interface TotpBootstrap {
  id: string;
  user_id: string;
  /** Plaintext TOTP code (in production: derived from secret + time-step). */
  totp_code: string;
  /** Issued-at (ms epoch). */
  issued_at: number;
  /** Expires at (ms epoch). */
  expires_at: number;
  /** Consumed-at (ms epoch). null until consumed. */
  consumed_at: number | null;
  /** Wrong-attempt counter (F-38: 5 wrongs → 429). */
  wrong_attempts: number;
  /** Lockout-at (ms epoch). null until locked. */
  locked_at: number | null;
}

export interface UserRow {
  id: string;
  /** Set when the first passkey binds; per F-43. */
  totp_destroyed_at: number | null;
  role?: string;
  active: boolean;
}

export interface AuditEmission {
  event_type: string;
  actor_pseudonym: string;
  target_id?: string;
  target_class: 'C0' | 'C1' | 'C2' | 'C3' | 'C4';
  severity: 'info' | 'notice' | 'warn' | 'alert';
  meta: Record<string, unknown>;
  rotation_id?: string;
  /**
   * Request-id correlation handle. Mirrors the SQL `audit_emit(...,
   * p_request_id uuid)` parameter added in Amendment G.7 / cross-cutting
   * #4. Pre-T18 callers may pass `null` (cheaper than rewriting every
   * caller during T18). Server hot-path callers SHOULD thread the
   * `event.locals.request_id` value from `hooks.server.ts`.
   *
   * Source: decisions.md amendment-pass-#4 ADR-0002 Amendment G.7.
   */
  request_id?: string | null;
}

export interface AuthStore {
  // ---- Users ----
  ensureUser(user_id: string, opts?: { role?: string; active?: boolean }): Promise<UserRow>;
  getUser(user_id: string): Promise<UserRow | null>;

  // ---- TOTP bootstrap ----
  issueTotpBootstrap(user_id: string): Promise<TotpBootstrap>;
  getTotpBootstrap(user_id: string): Promise<TotpBootstrap | null>;
  /**
   * Returns true if the (user, code) tuple has been recorded in the
   * consumed-log. The bootstrap row is deleted on consume per F-43; this
   * separate audit-shaped lookup is the only way to distinguish "reuse"
   * (410) from "no such bootstrap" (401).
   */
  wasTotpCodeConsumed(user_id: string, code: string): Promise<boolean>;
  recordTotpWrong(user_id: string): Promise<TotpBootstrap | null>;
  lockTotpBootstrap(user_id: string): Promise<void>;

  /**
   * Atomic: verify TOTP, enroll passkey, destroy TOTP, set
   * users.totp_destroyed_at, emit `auth.passkey.enrolled` audit row.
   *
   * Per F-43 this is one transaction. If any step fails the whole
   * transaction rolls back.
   */
  consumeTotpAndEnrollPasskey(opts: {
    user_id: string;
    totp_code: string;
    credential: PasskeyCredential;
    now: number;
  }): Promise<
    | { ok: true; credential_id: string }
    | { ok: false; status: number; reason: 'expired' | 'wrong_code' | 'locked' | 'consumed' }
  >;

  // ---- Passkeys ----
  getCredential(credentialId: string): Promise<PasskeyCredential | null>;
  listCredentialsForUser(user_id: string): Promise<PasskeyCredential[]>;
  saveCredential(cred: PasskeyCredential): Promise<void>;
  deleteCredential(credentialId: string): Promise<void>;

  // ---- Sessions ----
  createSession(opts: {
    user_id: string;
    now: number;
    ttl_ms: number;
    device_fingerprint?: string;
  }): Promise<AuthSession>;
  getSession(session_id: string): Promise<AuthSession | null>;
  listActiveSessions(user_id: string): Promise<AuthSession[]>;
  revokeSession(session_id: string, now: number): Promise<void>;
  revokeAllForUser(user_id: string, now: number): Promise<string[]>; // returns session_ids revoked

  // ---- Audit ----
  emitAudit(event: AuditEmission): Promise<void>;

  // ---- Helpers ----
  pseudonymOf(uid: string): string;
}
