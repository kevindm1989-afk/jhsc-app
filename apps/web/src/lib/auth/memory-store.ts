/**
 * In-memory implementation of the AuthStore (T05).
 *
 * Used by the Vitest harness in `apps/web/test/_helpers/supabase-test.ts`.
 * Mirrors the SQL semantics in `supabase/migrations/00000000000001_auth.sql`
 * sufficient to make the T05 tests pass.
 *
 * Determinism: every state mutation is synchronous on the JS event loop.
 * "Transactions" are simulated by performing all writes inside a single
 * function body; no concurrent mutators in tests.
 *
 * The pseudonymisation HMAC uses a per-store random key so that pseudonyms
 * are stable within a test but never leak across tests.
 */

import { createHmac, randomBytes } from 'node:crypto';
import type { AuthStore, AuditEmission, TotpBootstrap, UserRow } from './store';
import type { AuthSession, PasskeyCredential } from './types';

const TOTP_VALIDITY_MS = 15 * 60_000; // F-38

interface AuditRow {
  id: number;
  ts: string;
  actor_pseudonym: string;
  event_type: string;
  target_id: string | null;
  target_class: string;
  severity: string;
  rotation_id: string | null;
  meta: Record<string, unknown>;
}

export class MemoryAuthStore implements AuthStore {
  private users = new Map<string, UserRow>();
  private bootstraps = new Map<string, TotpBootstrap>();
  /**
   * Audit-shaped record of consumed TOTP codes (per user). The
   * `auth_totp_bootstraps` row is DELETED on consume (per F-43 atomic
   * destroy + the T05 test "TOTP row deleted in the SAME transaction").
   * To distinguish "reuse of an already-consumed code" (410 Gone, per
   * F-38) from "no bootstrap exists" (401), we keep a small hashed
   * record of the consumed code. Storing only the code itself is
   * acceptable here: the code is short-lived, single-use, has no PI
   * content, and is destroyed when retention cleans the row at 24h.
   */
  private consumedTotpCodes = new Map<string, Array<{ code: string; consumed_at: number }>>();
  private credentials = new Map<string, PasskeyCredential>();
  private sessions = new Map<string, AuthSession>();
  private auditRows: AuditRow[] = [];
  private auditSeq = 0;
  private bootstrapSeq = 0;
  private credSeq = 0;
  private sessionSeq = 0;
  private hmacKey: Buffer;
  private nowProvider: () => number;

  constructor(nowProvider: () => number = Date.now) {
    this.hmacKey = randomBytes(32);
    this.nowProvider = nowProvider;
  }

  // -----------------------------------------------------------------
  // Pseudonym — HMAC-BLAKE2b-256 in production; HMAC-SHA-256 here is
  // adequate for the test harness (the key never leaves the process).
  // -----------------------------------------------------------------
  pseudonymOf(uid: string): string {
    return createHmac('sha256', this.hmacKey).update(uid).digest('hex').slice(0, 16);
  }

  // -----------------------------------------------------------------
  // Users
  // -----------------------------------------------------------------
  async ensureUser(user_id: string, opts?: { role?: string; active?: boolean }): Promise<UserRow> {
    const existing = this.users.get(user_id);
    if (existing) {
      if (opts?.role) existing.role = opts.role;
      if (opts?.active !== undefined) existing.active = opts.active;
      return existing;
    }
    const row: UserRow = {
      id: user_id,
      totp_destroyed_at: null,
      active: opts?.active ?? true,
      ...(opts?.role !== undefined ? { role: opts.role } : {})
    };
    this.users.set(user_id, row);
    return row;
  }

  async getUser(user_id: string): Promise<UserRow | null> {
    return this.users.get(user_id) ?? null;
  }

  // -----------------------------------------------------------------
  // TOTP bootstrap
  // -----------------------------------------------------------------
  async issueTotpBootstrap(user_id: string): Promise<TotpBootstrap> {
    await this.ensureUser(user_id);
    // Code generation: synthetic 6-digit, deterministic per call sequence.
    // Test fixture; production uses HMAC-based time-step (RFC 6238).
    this.bootstrapSeq += 1;
    const code = `${100000 + (this.bootstrapSeq % 900000)}`;
    const issued_at = this.nowProvider();
    const row: TotpBootstrap = {
      id: `totp-${this.bootstrapSeq}`,
      user_id,
      totp_code: code,
      issued_at,
      expires_at: issued_at + TOTP_VALIDITY_MS,
      consumed_at: null,
      wrong_attempts: 0,
      locked_at: null
    };
    this.bootstraps.set(user_id, row);
    return row;
  }

  async getTotpBootstrap(user_id: string): Promise<TotpBootstrap | null> {
    return this.bootstraps.get(user_id) ?? null;
  }

  async wasTotpCodeConsumed(user_id: string, code: string): Promise<boolean> {
    const consumed = this.consumedTotpCodes.get(user_id);
    if (!consumed) return false;
    return consumed.some((c) => c.code === code);
  }

  async recordTotpWrong(user_id: string): Promise<TotpBootstrap | null> {
    const row = this.bootstraps.get(user_id);
    if (!row) return null;
    row.wrong_attempts += 1;
    return row;
  }

  async lockTotpBootstrap(user_id: string): Promise<void> {
    const row = this.bootstraps.get(user_id);
    if (!row) return;
    row.locked_at = this.nowProvider();
  }

  async consumeTotpAndEnrollPasskey(opts: {
    user_id: string;
    totp_code: string;
    credential: PasskeyCredential;
    now: number;
  }): Promise<
    | { ok: true; credential_id: string }
    | { ok: false; status: number; reason: 'expired' | 'wrong_code' | 'locked' | 'consumed' }
  > {
    const row = this.bootstraps.get(opts.user_id);
    if (!row) return { ok: false, status: 401, reason: 'wrong_code' };
    if (row.consumed_at !== null) return { ok: false, status: 410, reason: 'consumed' };
    if (row.locked_at !== null) return { ok: false, status: 429, reason: 'locked' };
    if (opts.now >= row.expires_at) return { ok: false, status: 410, reason: 'expired' };
    if (row.totp_code !== opts.totp_code) {
      // Caller (auth-core) does the wrong-attempt counting; this
      // path is only reached on a code mismatch on the enrollment ceremony,
      // which should not happen if the caller is doing its job.
      return { ok: false, status: 401, reason: 'wrong_code' };
    }

    // ATOMIC — F-43: destroy TOTP, set totp_destroyed_at, save credential,
    // emit audit row. Mirror the SQL `BEGIN ... COMMIT` block.
    //
    // The bootstrap row is DELETED (the test asserts `SELECT id FROM
    // auth_totp_bootstraps WHERE user_id = $1` returns zero rows). To
    // still distinguish "reuse of consumed code" (410) from "no
    // bootstrap at all" (401), we record the consumed code in a
    // separate audit-shaped store. See class-level comment.
    let consumed = this.consumedTotpCodes.get(opts.user_id);
    if (!consumed) {
      consumed = [];
      this.consumedTotpCodes.set(opts.user_id, consumed);
    }
    consumed.push({ code: row.totp_code, consumed_at: opts.now });
    this.bootstraps.delete(opts.user_id);

    const user = await this.ensureUser(opts.user_id);
    user.totp_destroyed_at = opts.now;

    this.credSeq += 1;
    this.credentials.set(opts.credential.credentialId, { ...opts.credential });

    await this.emitAudit({
      event_type: 'auth.passkey.enrolled',
      actor_pseudonym: this.pseudonymOf(opts.user_id),
      target_class: 'C1',
      severity: 'info',
      meta: {
        cred_id_pseudonym: this.pseudonymOf(opts.credential.credentialId),
        totp_destroyed_at: opts.now
      }
    });

    return { ok: true, credential_id: opts.credential.credentialId };
  }

  // -----------------------------------------------------------------
  // Passkeys
  // -----------------------------------------------------------------
  async getCredential(credentialId: string): Promise<PasskeyCredential | null> {
    return this.credentials.get(credentialId) ?? null;
  }

  async listCredentialsForUser(user_id: string): Promise<PasskeyCredential[]> {
    return [...this.credentials.values()].filter((c) => c.user_id === user_id);
  }

  async saveCredential(cred: PasskeyCredential): Promise<void> {
    this.credentials.set(cred.credentialId, { ...cred });
  }

  async deleteCredential(credentialId: string): Promise<void> {
    this.credentials.delete(credentialId);
  }

  // -----------------------------------------------------------------
  // Sessions
  // -----------------------------------------------------------------
  async createSession(opts: {
    user_id: string;
    now: number;
    ttl_ms: number;
    device_fingerprint?: string;
  }): Promise<AuthSession> {
    this.sessionSeq += 1;
    const session_id = `sess-${this.sessionSeq}-${opts.user_id}`;
    // Synthetic JWT: `<session_id>.<exp_b64>.<sig_b64>`.
    const exp = opts.now + opts.ttl_ms;
    const access_token = `${session_id}.${Buffer.from(String(exp)).toString('base64url')}.sig`;
    const session: AuthSession = {
      session_id,
      user_id: opts.user_id,
      access_token,
      iat: opts.now,
      exp,
      revoked_at: null,
      ...(opts.device_fingerprint !== undefined
        ? { device_fingerprint: opts.device_fingerprint }
        : {})
    };
    this.sessions.set(session_id, session);
    return session;
  }

  async getSession(session_id: string): Promise<AuthSession | null> {
    return this.sessions.get(session_id) ?? null;
  }

  async listActiveSessions(user_id: string): Promise<AuthSession[]> {
    return [...this.sessions.values()].filter(
      (s) => s.user_id === user_id && s.revoked_at === null
    );
  }

  async revokeSession(session_id: string, now: number): Promise<void> {
    const s = this.sessions.get(session_id);
    if (!s) return;
    if (s.revoked_at === null) s.revoked_at = now;
  }

  async revokeAllForUser(user_id: string, now: number): Promise<string[]> {
    const ids: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.user_id === user_id && s.revoked_at === null) {
        s.revoked_at = now;
        ids.push(s.session_id);
      }
    }
    return ids;
  }

  // -----------------------------------------------------------------
  // Audit
  // -----------------------------------------------------------------
  async emitAudit(event: AuditEmission): Promise<void> {
    this.auditSeq += 1;
    this.auditRows.push({
      id: this.auditSeq,
      ts: new Date(this.nowProvider()).toISOString(),
      actor_pseudonym: event.actor_pseudonym,
      event_type: event.event_type,
      target_id: event.target_id ?? null,
      target_class: event.target_class,
      severity: event.severity,
      rotation_id: event.rotation_id ?? null,
      meta: event.meta
    });
  }

  // -----------------------------------------------------------------
  // Test-only — used by the harness to back `adminQuery`.
  // -----------------------------------------------------------------
  __debugAuditRows(): readonly AuditRow[] {
    return this.auditRows;
  }
  __debugUsers(): readonly UserRow[] {
    return [...this.users.values()];
  }
  __debugBootstraps(): readonly TotpBootstrap[] {
    return [...this.bootstraps.values()];
  }
}
