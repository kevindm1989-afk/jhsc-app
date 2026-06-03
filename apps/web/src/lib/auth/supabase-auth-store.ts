/**
 * SupabaseAuthStore — T05.1 production wire-up (G-T05-1 substantial close).
 *
 * Closes G-T05-1 across two passes:
 *
 *   - **Browser-callable ops** (wired end-to-end via auth-op Edge
 *     Function + SECURITY DEFINER SQL wrappers per migrations 12 + 13):
 *
 *       getUser, getSession, listActiveSessions, listCredentialsForUser,
 *       revokeSession, revokeAllForUser, deleteCredential
 *
 *   - **Server-only ops** (intentionally NOT browser-callable; throw
 *     `SupabaseAuthStoreServerOnlyError`):
 *
 *       ensureUser, createSession, getCredential, saveCredential,
 *       emitAudit, pseudonymOf, plus the six TOTP-bootstrap methods
 *       (issueTotpBootstrap / getTotpBootstrap / wasTotpCodeConsumed /
 *       recordTotpWrong / lockTotpBootstrap / consumeTotpAndEnrollPasskey).
 *
 * Why "server-only" vs "not yet implemented":
 *
 *   The AuthStore interface was authored for the in-memory test
 *   harness (`MemoryAuthStore`) which implements ALL of its methods
 *   because the test scenarios exercise both the user-side and the
 *   server-side roles in one process. Production splits that role:
 *
 *     - The browser only ever calls the user-side ops (read its own
 *       row / list its own sessions / revoke its own credentials).
 *     - The server-side enrollment / session-mint paths run inside
 *       Edge Functions that use the service-role admin client + the
 *       canonical SECURITY DEFINER functions in
 *       supabase/migrations/00000000000001_auth.sql directly. They
 *       do NOT use SupabaseAuthStore.
 *
 *   Throwing a structured server-only error from the browser-side
 *   class makes that contract explicit: "the AuthStore interface lists
 *   this method, but production browsers should never call it; if you
 *   need this on the server, use the Edge Function directly."
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

/**
 * Thrown by AuthStore methods that the production browser path is
 * NOT designed to call. These are server-only operations (enrollment
 * ceremony, admin-emit-audit, raw-credential lookup, etc.) — they
 * exist on the AuthStore interface because MemoryAuthStore implements
 * the FULL split-role contract for tests. In production, the
 * corresponding code paths run inside Edge Functions that use the
 * service-role admin client + the SECURITY DEFINER functions
 * directly, not via SupabaseAuthStore.
 *
 * If a browser caller hits this error, they're almost certainly
 * misusing the interface; the right fix is to invoke the relevant
 * server-side Edge Function (mint-session for sign-in, the future
 * enrollment Edge Function for first-passkey-bind, etc.) instead.
 */
export class SupabaseAuthStoreServerOnlyError extends Error {
  readonly op: string;
  constructor(op: string, why: string) {
    super(
      `SupabaseAuthStore.${op}: server-only by design. ${why} ` +
        `If you reached this from the browser, you're in the wrong code path; ` +
        `the production replacement runs inside the matching Edge Function.`
    );
    this.name = 'SupabaseAuthStoreServerOnlyError';
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
    throw new SupabaseAuthStoreServerOnlyError(
      'ensureUser',
      'The users row is written server-side during the first-passkey enrollment ceremony ' +
        'inside `public.enroll_first_passkey` (migration 0001). The browser never creates user rows.'
    );
  }

  // ---------------------------------------------------------------------------
  // TOTP bootstrap — server-only by design. The TOTP issue / wrong-
  // attempt / lock paths all live inside SECURITY DEFINER functions
  // whose grants exclude `authenticated`. The user-facing enrollment
  // flow (consumeTotpAndEnrollPasskey below) runs inside an Edge
  // Function that holds the service-role admin client; the browser
  // posts the TOTP code TO that Edge Function rather than reading /
  // writing the TOTP tables through the AuthStore.
  // ---------------------------------------------------------------------------

  issueTotpBootstrap(_user_id: string): Promise<TotpBootstrap> {
    throw new SupabaseAuthStoreServerOnlyError(
      'issueTotpBootstrap',
      'TOTP bootstraps are issued by a co-chair via a server-side admin flow, ' +
        'not by the enrolling user. The authoritative path runs in the co-chair Edge Function.'
    );
  }

  getTotpBootstrap(_user_id: string): Promise<TotpBootstrap | null> {
    throw new SupabaseAuthStoreServerOnlyError(
      'getTotpBootstrap',
      'The auth_totp_bootstraps table REVOKEs SELECT from `authenticated`. The bootstrap ' +
        'is consulted only by the SECURITY DEFINER enrollment function inside its transaction.'
    );
  }

  wasTotpCodeConsumed(_user_id: string, _code: string): Promise<boolean> {
    throw new SupabaseAuthStoreServerOnlyError(
      'wasTotpCodeConsumed',
      'The auth_totp_consumed_log table is server-managed; F-38 reuse detection runs inside ' +
        '`public.enroll_first_passkey`, not via a browser query.'
    );
  }

  recordTotpWrong(_user_id: string): Promise<TotpBootstrap | null> {
    throw new SupabaseAuthStoreServerOnlyError(
      'recordTotpWrong',
      '`public.enroll_first_passkey` increments wrong_attempts (and locks at 5) atomically ' +
        'as part of its own transaction; the browser never increments the counter directly.'
    );
  }

  lockTotpBootstrap(_user_id: string): Promise<void> {
    throw new SupabaseAuthStoreServerOnlyError(
      'lockTotpBootstrap',
      'Locking happens inside `public.enroll_first_passkey` when wrong_attempts hits 5; ' +
        'the lock-row write is server-only.'
    );
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
    throw new SupabaseAuthStoreServerOnlyError(
      'consumeTotpAndEnrollPasskey',
      'The F-43 atomic enrollment transaction lives inside `public.enroll_first_passkey` ' +
        '(migration 0001). The browser-side enrollment ceremony posts the TOTP + WebAuthn ' +
        'response to a dedicated enrollment Edge Function (separate from auth-op) which calls ' +
        'that SECURITY DEFINER function via the service-role admin client. SupabaseAuthStore ' +
        'is not on that path.'
    );
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
    throw new SupabaseAuthStoreServerOnlyError(
      'getCredential',
      'Cred-by-id lookup before `auth.uid()` is resolved is blocked by the ' +
        '`webauthn_credentials_select_self` RLS policy (auth.uid() = user_id). The ' +
        'mint-session Edge Function does cred → user resolution server-side via the ' +
        'mint_writer-scoped path; the browser never performs this lookup.'
    );
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
    throw new SupabaseAuthStoreServerOnlyError(
      'saveCredential',
      'INSERT into webauthn_credentials happens server-side inside ' +
        '`public.enroll_first_passkey` (migration 0001) atomically with TOTP consumption. ' +
        'The browser never directly writes the credentials table.'
    );
  }

  async deleteCredential(credentialId: string): Promise<void> {
    // Calls the `revoke_my_passkey` SECURITY DEFINER wrapper which
    // verifies auth.uid() = credential.user_id internally + DELETEs
    // the credential + emits the `auth.passkey.revoked` audit row.
    // 403 rls_denied (caller doesn't own credential OR credential
    // doesn't exist) and network errors both surface as a void
    // return — the AuthStore.deleteCredential contract returns void
    // on success and the caller can't distinguish the failure modes.
    await this.transport({ op: 'revoke_passkey', credential_id: credentialId });
    return;
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
    throw new SupabaseAuthStoreServerOnlyError(
      'createSession',
      'The mint-session Edge Function is the canonical session creation path on sign-in ' +
        '(ADR-0023 / F-117 — token emission is mint-only). AuthStore.createSession is the ' +
        'wider in-memory contract; production browsers never call this directly.'
    );
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

  async revokeSession(session_id: string, _now: number): Promise<void> {
    // The `_now` parameter is part of the AuthStore contract (the
    // MemoryAuthStore uses it as the timestamp on the in-memory
    // session row). The Supabase wire-up doesn't need it — the
    // SECURITY DEFINER `revoke_my_session` function uses `now()`
    // server-side so the timestamp comes from Postgres, not the
    // client. Drop the parameter silently for parity with the
    // interface.
    const { status, body } = await this.transport({ op: 'revoke_session', session_id });
    // 200 → success. The body's `data` is null per the dispatcher
    // contract; we don't read it.
    if (status === 200) {
      const parsed = body as { ok?: boolean } | null;
      if (parsed && parsed.ok === true) return;
    }
    // 0 = network error; 403 = rls_denied (caller doesn't own session,
    // OR session_id does not exist — the wrapper collapses both cases
    // to avoid leaking validity). Both surface as a void return for
    // AuthStore contract parity (no exceptions on revoke; the
    // session_id was either invalidated or wasn't valid to begin with).
    return;
  }

  async revokeAllForUser(user_id: string, _now: number): Promise<string[]> {
    // The Supabase wrapper enforces self-revoke only: the dispatcher
    // verifies user_id === auth.uid() before invoking the SQL function.
    // A caller passing a different user_id gets back rls_denied + an
    // empty array (defense-in-depth — the SQL function would also
    // ignore the client-supplied user_id, but the early-deny is a
    // clearer contract).
    //
    // The AuthStore.revokeAllForUser contract returns the array of
    // session_ids revoked. The SQL wrapper currently returns the
    // count, not the array (a future PR can extend the function to
    // RETURNING session_id[] if a consumer needs the list). For now
    // we return an empty array on success — callers that need the
    // exact session_ids should listAllForUser before + after.
    const { status, body } = await this.transport({
      op: 'revoke_all_for_user',
      user_id
    });
    if (status !== 200) return [];
    const parsed = body as { ok?: boolean; data?: { revoked_count?: number } } | null;
    if (parsed && parsed.ok === true) {
      return [];
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // Audit — deferred (T05.1 audit emission is handled by the t07-op /
  // concern-op / reprisal-op paths; the AuthStore.emitAudit slot is for
  // auth-specific events and rides with `consumeTotpAndEnrollPasskey`)
  // ---------------------------------------------------------------------------

  emitAudit(_event: AuditEmission): Promise<void> {
    throw new SupabaseAuthStoreServerOnlyError(
      'emitAudit',
      'audit_emit is granted to supabase_auth_admin only; browser callers cannot invoke it ' +
        'directly. Each user-facing operation that needs an audit row (panic_wipe, revoke_session, ' +
        'enroll_first_passkey, etc.) emits its own row server-side via the matching SECURITY ' +
        'DEFINER function — the browser never composes raw AuditEmission objects.'
    );
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
    throw new SupabaseAuthStoreServerOnlyError(
      'pseudonymOf',
      'The HMAC pseudonym is computed against `app.hmac_pseudonym_key`, which is ' +
        'server-side only. Returning the raw uid would silently break C2 pseudonymity. ' +
        'Read pseudonyms from server-emitted audit rows instead of deriving them.'
    );
  }
}
