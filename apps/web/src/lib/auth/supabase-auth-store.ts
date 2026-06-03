/**
 * SupabaseAuthStore — T05.1 production wire-up scaffold (G-T05-1 begin).
 *
 * Closes G-T05-1 INCREMENTALLY. The browser-side `AuthStore` interface
 * (`store.ts`) has ~30 methods spanning users / TOTP bootstrap /
 * passkeys / sessions / audit. Each one needs:
 *
 *   - A corresponding Edge Function op (in `supabase/functions/auth-op/`).
 *   - A migration / RPC binding for the SQL side (most methods reach
 *     the SECURITY DEFINER functions in
 *     `supabase/migrations/00000000000001_auth.sql`).
 *   - A unit test pair (this file's vitest counterpart + the Edge
 *     Function's deno test).
 *
 * Shipping that all in one PR would be a 1500+ line drop. This PR
 * stages the architecture:
 *
 *   - `getUser` is wired end-to-end (real op, real Edge Function
 *     handler, real test on both sides). Proves the dispatcher
 *     contract.
 *   - Every other method throws `SupabaseAuthStoreNotImplementedError`,
 *     a structured error that names the missing op and references
 *     G-T05-1. Future PRs replace each throw with a transport call.
 *
 * Consumers can already start migrating from `MemoryAuthStore` to
 * `SupabaseAuthStore` for code paths that only need `getUser` (the
 * route layer + the session-jwt-store; the `consumeTotpAndEnrollPasskey`
 * path waits for its own wire-up).
 *
 * Wire shape (same as t07-op / concern-op / reprisal-op / t14-op):
 *
 *   POST `${baseUrl}/functions/v1/auth-op`
 *     headers: { Authorization: 'Bearer <jwt>', Content-Type: 'application/json' }
 *     body: { op: '<name>', ...method_args }
 *     → { ok: true, data: <T> } | { ok: false, reason: '<reason>' }
 *
 * The shared `createEdgeFnFetchTransport` honours the F-39 401 →
 * `onSessionRevoked` loop for free.
 */

import type { AuditEmission, AuthStore, TotpBootstrap, UserRow } from './store.ts';
import type { AuthSession, PasskeyCredential } from './types.ts';

/**
 * Transport closure — produced by `createEdgeFnFetchTransport({
 * opName: 'auth-op', ... })` in production; tests inject a fake.
 */
export type AuthOpTransport = (body: Record<string, unknown>) => Promise<{
  status: number;
  body: unknown;
}>;

/**
 * Thrown by every AuthStore method that has not yet been wired in this
 * staged rollout. Carries the op name so the call site sees clearly
 * which op needs landing.
 */
export class SupabaseAuthStoreNotImplementedError extends Error {
  readonly op: string;
  constructor(op: string) {
    super(
      `SupabaseAuthStore.${op}: not yet wired (G-T05-1 staged rollout). ` +
        `The MemoryAuthStore is the only implementation today; this op ` +
        `will be wired in a follow-up PR.`
    );
    this.name = 'SupabaseAuthStoreNotImplementedError';
    this.op = op;
  }
}

export interface SupabaseAuthStoreOptions {
  transport: AuthOpTransport;
}

/**
 * Type-only pin: a SupabaseAuthStore is structurally an AuthStore.
 * The test surface includes `const _: AuthStore = new
 * SupabaseAuthStore(...)` to enforce this at typecheck time.
 */
export class SupabaseAuthStore implements AuthStore {
  private readonly transport: AuthOpTransport;

  constructor(opts: SupabaseAuthStoreOptions) {
    this.transport = opts.transport;
  }

  // ---------------------------------------------------------------------------
  // Users (one method wired; ensureUser deferred — it needs an RPC + grant
  // pass before it can ship)
  // ---------------------------------------------------------------------------

  async getUser(user_id: string): Promise<UserRow | null> {
    const { status, body } = await this.transport({ op: 'get_user', user_id });
    if (status === 0) return null;
    if (status === 404) return null;
    const parsed = body as { ok?: boolean; data?: UserRow } | null;
    if (parsed && parsed.ok === true && parsed.data) {
      return parsed.data;
    }
    return null;
  }

  ensureUser(_user_id: string, _opts?: { role?: string; active?: boolean }): Promise<UserRow> {
    throw new SupabaseAuthStoreNotImplementedError('ensureUser');
  }

  // ---------------------------------------------------------------------------
  // TOTP bootstrap — all deferred
  // ---------------------------------------------------------------------------

  issueTotpBootstrap(_user_id: string): Promise<TotpBootstrap> {
    throw new SupabaseAuthStoreNotImplementedError('issueTotpBootstrap');
  }

  getTotpBootstrap(_user_id: string): Promise<TotpBootstrap | null> {
    throw new SupabaseAuthStoreNotImplementedError('getTotpBootstrap');
  }

  wasTotpCodeConsumed(_user_id: string, _code: string): Promise<boolean> {
    throw new SupabaseAuthStoreNotImplementedError('wasTotpCodeConsumed');
  }

  recordTotpWrong(_user_id: string): Promise<TotpBootstrap | null> {
    throw new SupabaseAuthStoreNotImplementedError('recordTotpWrong');
  }

  lockTotpBootstrap(_user_id: string): Promise<void> {
    throw new SupabaseAuthStoreNotImplementedError('lockTotpBootstrap');
  }

  consumeTotpAndEnrollPasskey(_opts: {
    user_id: string;
    totp_code: string;
    credential: PasskeyCredential;
    now: number;
  }): Promise<
    | { ok: true; credential_id: string }
    | { ok: false; status: number; reason: 'expired' | 'wrong_code' | 'locked' | 'consumed' }
  > {
    throw new SupabaseAuthStoreNotImplementedError('consumeTotpAndEnrollPasskey');
  }

  // ---------------------------------------------------------------------------
  // Passkeys — listCredentialsForUser wired (read-only on
  // webauthn_credentials; RLS policy webauthn_credentials_select_self
  // enforces caller-scope).
  //
  // getCredential remains deferred: lookup by credential_id requires
  // visiting a row before auth.uid() is resolved (the credential is the
  // basis for the eventual session). That cross-row lookup is mint-
  // session's job — it runs server-side via the mint_writer-scoped
  // path with the credential_id as input and resolves the user_id
  // before any JWT is issued (F-117). Exposing the same lookup as a
  // browser AuthStore method would either need a SECURITY DEFINER
  // function (with careful access controls) or a separate Edge
  // Function — both deferred to a focused PR.
  //
  // saveCredential / deleteCredential require INSERT/DELETE on the
  // table, which RLS doesn't permit for `authenticated` today. They
  // ride on the enrollment / revocation SQL paths.
  // ---------------------------------------------------------------------------

  getCredential(_credentialId: string): Promise<PasskeyCredential | null> {
    throw new SupabaseAuthStoreNotImplementedError('getCredential');
  }

  async listCredentialsForUser(user_id: string): Promise<PasskeyCredential[]> {
    const { status, body } = await this.transport({
      op: 'list_credentials_for_user',
      user_id
    });
    if (status === 0) return [];
    const parsed = body as { ok?: boolean; data?: PasskeyCredential[] } | null;
    if (parsed && parsed.ok === true && Array.isArray(parsed.data)) {
      return parsed.data;
    }
    return [];
  }

  saveCredential(_cred: PasskeyCredential): Promise<void> {
    throw new SupabaseAuthStoreNotImplementedError('saveCredential');
  }

  deleteCredential(_credentialId: string): Promise<void> {
    throw new SupabaseAuthStoreNotImplementedError('deleteCredential');
  }

  // ---------------------------------------------------------------------------
  // Sessions — getSession + listActiveSessions wired (read-only on
  // existing auth_sessions table; RLS enforces caller-scope).
  //
  // createSession is the responsibility of the mint-session Edge
  // Function on the sign-in path today (ADR-0023 / F-117 — token
  // emission is mint-only). The AuthStore.createSession contract is
  // wider than what mint-session does and stays deferred until the
  // matching dispatcher op lands.
  //
  // Note on access_token: F-117 forbids the server from re-emitting a
  // previously-minted token, so getSession / listActiveSessions return
  // an empty `access_token` string. Callers using these methods for
  // revocation checks or for the sessions UI don't need the token; the
  // metadata is what matters.
  // ---------------------------------------------------------------------------

  createSession(_opts: {
    user_id: string;
    now: number;
    ttl_ms: number;
    device_fingerprint?: string;
  }): Promise<AuthSession> {
    throw new SupabaseAuthStoreNotImplementedError('createSession');
  }

  async getSession(session_id: string): Promise<AuthSession | null> {
    const { status, body } = await this.transport({ op: 'get_session', session_id });
    if (status === 0) return null;
    if (status === 404) return null;
    const parsed = body as { ok?: boolean; data?: AuthSession } | null;
    if (parsed && parsed.ok === true && parsed.data) {
      return parsed.data;
    }
    return null;
  }

  async listActiveSessions(user_id: string): Promise<AuthSession[]> {
    const { status, body } = await this.transport({ op: 'list_active_sessions', user_id });
    if (status === 0) return [];
    const parsed = body as { ok?: boolean; data?: AuthSession[] } | null;
    if (parsed && parsed.ok === true && Array.isArray(parsed.data)) {
      return parsed.data;
    }
    return [];
  }

  revokeSession(_session_id: string, _now: number): Promise<void> {
    throw new SupabaseAuthStoreNotImplementedError('revokeSession');
  }

  revokeAllForUser(_user_id: string, _now: number): Promise<string[]> {
    throw new SupabaseAuthStoreNotImplementedError('revokeAllForUser');
  }

  // ---------------------------------------------------------------------------
  // Audit — deferred (T05.1 audit emission is handled by the t07-op /
  // concern-op / reprisal-op paths; the AuthStore.emitAudit slot is for
  // auth-specific events and rides with `consumeTotpAndEnrollPasskey`)
  // ---------------------------------------------------------------------------

  emitAudit(_event: AuditEmission): Promise<void> {
    throw new SupabaseAuthStoreNotImplementedError('emitAudit');
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  pseudonymOf(_uid: string): string {
    // The pseudonym derivation lives server-side (HMAC against
    // `app.hmac_pseudonym_key`). The browser MUST NOT compute it
    // locally (it would need the secret). Production callers should
    // read the pseudonym from server-emitted audit rows, not derive
    // it. We throw rather than returning the raw uid (which would
    // silently break the C2 pseudonymity contract).
    throw new SupabaseAuthStoreNotImplementedError('pseudonymOf');
  }
}
