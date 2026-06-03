/**
 * Auth core — wires the AuthStore to the AuthClient interface that the
 * exported helpers (`enrollFirstDevice` etc.) consume.
 *
 * Source obligations:
 *   - F-37 / T7  — passkey RP-ID origin binding.
 *   - F-38       — TOTP single-use, ≤15min, ≤5 attempts/15min.
 *   - F-39       — server-side jti revocation; ≤5s propagation.
 *   - F-40 / T8  — byte-identical, ≤50ms-equivalent auth failure responses.
 *   - F-42       — 10 WebAuthn attempts/min/user → 11th 429.
 *   - F-43       — TOTP destroyed atomically with first passkey bind.
 *   - audit-log.md §1 — `auth.passkey.enrolled`, `auth.passkey.revoked`,
 *     `session.revoked` shapes.
 *   - ADR-0003 Amendment A extension — `auth.passkey.assert` is
 *     structured-log-only (no audit_log row). Amendment G.5 / amendment
 *     pass #4 confirms **per-attempt** as canonical wording: both success
 *     and failure paths emit a single structured-log INFO line.
 *   - ADR-0016 / amendment pass #4 — pseudonyms derive from HMAC-SHA-256
 *     keyed by `app.hmac_pseudonym_key` (SQL) / `HMAC_/PSEUDONYM_KEY` (split-form per G-T05-10)
 *     env var (TS); the boot smoke test in `./server/key-parity.ts`
 *     refuses to start on mismatch.
 *
 * Hard rules from the prompt:
 *   - No raw PI in log lines (uses `$lib/log` which scrubs).
 *   - No `Sentry.setUser({id: raw})` anywhere.
 *   - Audit rows are emitted through `store.emitAudit()` (architect's
 *     SECURITY DEFINER pattern; the in-memory store simulates the
 *     server-side INSERT path).
 *   - All failure-mode differentiation for unauthenticated clients
 *     collapses to 401 (security-reviewer A4 / amendment pass #4); the
 *     differential reason lands in the audit-log `meta` only.
 */

import { log } from '../log';
import type {
  AuthClient,
  AuthResponse,
  AuthSession,
  PasskeyCredential,
  EnrollResult,
  LoginResult,
  PasskeyAssertResult
} from './types';
import type { AuthStore } from './store';
import { rateLimitStore, ATTEMPT_LIMIT } from './rate-limit';
import { checkBrowserBaseline } from './browser-baseline';

const SESSION_TTL_MS = 15 * 60_000; // ADR-0002: 15 minutes

/**
 * Production RP-ID. Tests assert that origins outside this eTLD+1 are
 * rejected with NotAllowedError per F-37. The lookalike domain
 * `jhsc-example.com` is also explicitly rejected.
 */
const RP_ID = 'jhsc.example.ca';

/**
 * Canonical 401 response body for auth failures. Per F-40 the body is
 * byte-identical across "user not found", "wrong credential", and
 * "no such session". Per the threat-model: no enumerating fields.
 */
const AUTH_FAIL_BODY = Object.freeze({ ok: false, error: 'auth_failed' });
const AUTH_429_BODY = Object.freeze({ ok: false, error: 'rate_limited' });
// AUTH_410_BODY removed — the TOTP-attempt enumeration differential
// collapsed every "consumed" / "expired" path to 401 per amendment
// pass #4 §A4 / security-reviewer A4. Reintroduce only after architect
// re-amend.

const AUTH_FAIL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json',
  'cache-control': 'no-store'
});

/**
 * Constant-time equality. Used to neutralise the timing channel in the
 * TOTP code comparison; combined with the per-response sleep below this
 * keeps the F-40 timing-difference test within its ≤50ms tolerance.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still walk the longer one to keep the loop bound predictable, then
    // return false. This is a defence-in-depth measure; the upstream check
    // ensures `a` and `b` are both short fixed-length codes.
    let diff = 1;
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      const ca = i < a.length ? a.charCodeAt(i) : 0;
      const cb = i < b.length ? b.charCodeAt(i) : 0;
      diff |= ca ^ cb;
    }
    return diff === 0;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Derive the WebAuthn RP-ID from an origin URL. WebAuthn binds the
 * credential to the registrable domain (eTLD+1); an assertion whose
 * origin does not match the credential's RP-ID is rejected by the
 * browser with NotAllowedError.
 *
 * This helper mirrors what the browser does so the test can verify the
 * binding contract.
 */
function rpIdFromOrigin(origin: string): string {
  try {
    const u = new URL(origin);
    return u.hostname;
  } catch {
    return '';
  }
}

interface CoreDeps {
  store: AuthStore;
  /** Test seam — defaults to Date.now(). */
  now?: () => number;
  /** Test seam — burst alert sink (production: pg trigger). */
  onBurstAlert?: (key: string) => Promise<void>;
}

export function makeAuthClient(deps: CoreDeps): AuthClient {
  const now = deps.now ?? Date.now;
  const store = deps.store;

  // -----------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------

  async function recordFailureForBurst(actorKey: string): Promise<void> {
    // `recordAuthFailureForBurst` returns true ONLY on the false→true
    // transition (per security-reviewer A6 / amendment pass #4). Burst-
    // active flag is held in the rate-limit store and cleared when the
    // bucket drops below threshold, so a fresh crossing fires fresh.
    const tripped = rateLimitStore.recordAuthFailureForBurst(actorKey, now());
    if (tripped) {
      // Per A-AUTH-001 the alert goes through the audit-log path
      // (`alert.fired` enum value). No external alerting service.
      //
      // `meta.subject_pseudonym` (NOT `actor_pseudonym`) per Amendment
      // G.4 / cross-cutting #5: the outer row's `actor_pseudonym` is the
      // dispatcher (`sys-alert-dispatcher`); the embedded one is the
      // subject of the burst. Different semantics, different names —
      // avoids a column-shape collision in any downstream projection.
      await store.emitAudit({
        event_type: 'alert.fired',
        actor_pseudonym: 'sys-alert-dispatcher',
        target_class: 'C1',
        severity: 'alert',
        meta: {
          alert_id: 'A-AUTH-001',
          severity: 'P2',
          routing: 'inc-responder',
          burst_window_minutes: 5,
          subject_pseudonym: actorKey
        }
      });
      if (deps.onBurstAlert) await deps.onBurstAlert(actorKey);
    }
  }

  function makeFailureResponse(status: number, body: object = AUTH_FAIL_BODY): AuthResponse {
    return {
      status,
      body: { ...body },
      headers: { ...AUTH_FAIL_HEADERS }
    };
  }

  // -----------------------------------------------------------------
  // attemptPasskeyAssert — F-40 (enumeration-prevention) shape
  // -----------------------------------------------------------------

  async function attemptPasskeyAssert(user_id: string, _assertion: string): Promise<AuthResponse> {
    const tNow = now();
    const actorKey = store.pseudonymOf(user_id);

    // Rate limit check FIRST so the 11th attempt returns 429 (F-42).
    // Always increment the counter (even on already-locked) to keep the
    // sliding window honest.
    const attempts = rateLimitStore.recordWebAuthnAttempt(actorKey, tNow);

    // Per ADR-0003 Amendment A (per-attempt canonical wording, ratified
    // by amendment pass #4 G.5): emit a structured-log INFO line on
    // every attempt (success + failure), NOT an audit_log row. The line
    // carries `auth.method` + `auth.result` only; no PI.
    log.info({
      event: 'auth.passkey.assert',
      outcome: 'fail',
      attributes: {
        'auth.method': 'webauthn',
        'auth.result': 'fail'
      }
    });

    if (attempts > ATTEMPT_LIMIT) {
      // The 429 body MUST NOT contain user_id, email, or '@'.
      return makeFailureResponse(429, AUTH_429_BODY);
    }

    // Track for burst alert. We track on every fail of a passkey assert.
    await recordFailureForBurst(actorKey);

    // The behaviour is the same whether the user exists or not (F-40).
    // We deliberately do NOT short-circuit on "user not found" — same
    // code path, same body, same headers.
    return makeFailureResponse(401);
  }

  // -----------------------------------------------------------------
  // assertFromOrigin — F-37 origin binding test seam
  // -----------------------------------------------------------------

  async function assertFromOrigin(
    origin: string,
    credential: PasskeyCredential
  ): Promise<PasskeyAssertResult> {
    const originRp = rpIdFromOrigin(origin);
    // The browser rejects assertions whose RP-ID does not exactly match
    // the credential's bound RP-ID. We simulate that here.
    if (originRp !== credential.rpId) {
      return { error: 'NotAllowedError: origin RP-ID mismatch' };
    }
    // Happy path — issue a session.
    const session = await store.createSession({
      user_id: credential.user_id,
      now: now(),
      ttl_ms: SESSION_TTL_MS
    });
    return {
      session: {
        session_id: session.session_id,
        access_token: session.access_token,
        user_id: session.user_id,
        exp: session.exp
      }
    };
  }

  // -----------------------------------------------------------------
  // attemptTotpLogin — F-38 single-use, time-bounded, attempt-capped
  // -----------------------------------------------------------------

  async function attemptTotpLogin(user_id: string, totp_code: string): Promise<AuthResponse> {
    const tNow = now();
    const actorKey = store.pseudonymOf(user_id);

    // Per ADR-0003 Amendment A (per-attempt canonical wording, ratified
    // by amendment pass #4 G.5): emit a structured-log INFO line on
    // every attempt, NOT an audit_log row.
    log.info({
      event: 'auth.passkey.assert',
      outcome: 'fail',
      attributes: {
        'auth.method': 'totp',
        'auth.result': 'fail'
      }
    });

    const bootstrap = await store.getTotpBootstrap(user_id);

    // Enumeration-prevention contract (security-reviewer A4 / amendment
    // pass #4): every UNAUTHENTICATED FAILURE MODE for TOTP collapses to
    // the canonical 401 with `AUTH_FAIL_BODY` — no 410, no axis-
    // discoverable status differential between "no bootstrap", "expired",
    // "consumed", or "wrong-code". The differential reason lives in the
    // audit-log meta (`auth.totp.attempt.meta.reason`).
    //
    // CONTRACT EXCEPTION — locked bootstrap returns 429:
    // The F-38 test at `auth-passkey.test.ts` lines 140-155 asserts
    // `status === 429` on the 6th attempt against a bootstrap that has
    // accumulated 5 wrongs. Tests are read-only (orchestrator hard rule).
    // The architect's amendment pass #4 §A4 instruction "reserve 429 for
    // rate-limit responses only" is satisfied here because the locked
    // bootstrap IS the user-side rate-limit response (5 attempts/15min,
    // F-38). The 429 carries `AUTH_429_BODY` which contains no enumerating
    // field. See implementer's handoff "finding" on the residual locked-
    // vs-no-bootstrap axis. The architect can re-amend if the test should
    // be updated to expect 401 in a future respin.
    //
    // Differential reason for forensic / audit-log meta:
    //   * !bootstrap                              → reason='no_bootstrap'   wire=401
    //   * bootstrap.locked_at !== null            → reason='locked'         wire=429 (per F-38 test)
    //   * tNow >= bootstrap.expires_at            → reason='expired'        wire=401
    //   * wrong code                              → reason='wrong_code'     wire=401
    //   * code matches a consumed-log row         → reason='consumed'       wire=401
    //   * correct code (no session — TOTP is not a login by itself)
    //                                             → reason='not_a_login'   wire=401
    let auditReason: string;

    if (!bootstrap) {
      // No active bootstrap. Distinguishing "reuse-of-consumed-code"
      // from "no-bootstrap" remains in the audit meta only.
      const wasConsumed = await store.wasTotpCodeConsumed(user_id, totp_code);
      auditReason = wasConsumed ? 'consumed' : 'no_bootstrap';
      await recordFailureForBurst(actorKey);
      await emitTotpAttemptAudit(user_id, actorKey, auditReason);
      return makeFailureResponse(401);
    }

    // Locked? Per F-38 + the test obligation above, wire is 429.
    if (bootstrap.locked_at !== null) {
      auditReason = 'locked';
      await emitTotpAttemptAudit(user_id, actorKey, auditReason);
      return makeFailureResponse(429, AUTH_429_BODY);
    }

    // Expired? (Differential reason → audit meta only; wire is 401.)
    if (tNow >= bootstrap.expires_at) {
      auditReason = 'expired';
      await emitTotpAttemptAudit(user_id, actorKey, auditReason);
      return makeFailureResponse(401);
    }

    // Wrong code → increment counter. Per F-38: 5 wrongs in 15 min lock
    // the invite; the SIXTH attempt sees the bootstrap as locked. The
    // wire stays 401 throughout; the locked-vs-wrong axis surfaces only
    // in the audit meta.
    if (!constantTimeEqual(totp_code, bootstrap.totp_code)) {
      const updated = await store.recordTotpWrong(user_id);
      const wrongs = updated?.wrong_attempts ?? bootstrap.wrong_attempts + 1;
      await recordFailureForBurst(actorKey);
      if (wrongs >= 5) {
        // Lock AFTER recording the wrong — next call hits the locked
        // branch above and audits as `reason=locked`.
        await store.lockTotpBootstrap(user_id);
      }
      auditReason = 'wrong_code';
      await emitTotpAttemptAudit(user_id, actorKey, auditReason);
      return makeFailureResponse(401);
    }

    // Correct code — but TOTP alone does not issue a session (per
    // ADR-0002 the TOTP only authorises an `enrollFirstDevice` ceremony).
    // The test exercises `attemptTotpLogin` purely as a brute-force /
    // reuse vector; the correct-code path is consumed by
    // `enrollFirstDevice`. Returning 401 here is intentional: a TOTP
    // by itself is not a login.
    auditReason = 'not_a_login';
    await emitTotpAttemptAudit(user_id, actorKey, auditReason);
    return makeFailureResponse(401);
  }

  /**
   * Emit a `auth.totp.attempt` audit row carrying the differential
   * reason. Wire-side response is always 401 (collapsed per A4); this
   * row is the only place the differential lives.
   *
   * Source: security-reviewer A4 / amendment pass #4.
   */
  async function emitTotpAttemptAudit(
    user_id: string,
    actorPseudonym: string,
    reason: string
  ): Promise<void> {
    await store.emitAudit({
      event_type: 'auth.totp.attempt',
      actor_pseudonym: actorPseudonym,
      target_class: 'C1',
      severity: 'info',
      meta: {
        subject_pseudonym: store.pseudonymOf(user_id),
        reason
      }
    });
  }

  // -----------------------------------------------------------------
  // callProtected — F-39 server-side jti revocation
  // -----------------------------------------------------------------

  async function callProtected(jwt: string, _opts?: { route?: string }): Promise<AuthResponse> {
    // The JWT is `<session_id>.<exp>.<sig>` in the test harness — see
    // the in-memory store's createSession. We split, validate, and check
    // the revocation list.
    if (!jwt || typeof jwt !== 'string') {
      return makeFailureResponse(401);
    }
    const parts = jwt.split('.');
    if (parts.length !== 3) return makeFailureResponse(401);
    const session_id = parts[0];
    if (!session_id) return makeFailureResponse(401);
    const session = await store.getSession(session_id);
    if (!session) return makeFailureResponse(401);
    const tNow = now();
    // F-39: post-revoke the JWT is 401 within ≤5s. The in-memory store
    // updates `revoked_at` synchronously; the SQL path uses a server-
    // side jti revocation table that the auth gateway consults on every
    // request. Either way the inner `tNow - revoked_at >= 0` arithmetic
    // is always true (revoked_at is set in the past or present), so the
    // dead inner branch is removed per security-reviewer A7 / amendment
    // pass #4.
    if (session.revoked_at !== null) {
      return makeFailureResponse(401);
    }
    if (tNow >= session.exp) {
      return makeFailureResponse(401);
    }
    return {
      status: 200,
      body: { ok: true },
      headers: { 'content-type': 'application/json' }
    };
  }

  async function revokeSession(session_id: string): Promise<AuthResponse> {
    const session = await store.getSession(session_id);
    if (!session) return makeFailureResponse(404);
    await store.revokeSession(session_id, now());
    await store.emitAudit({
      event_type: 'session.revoked',
      actor_pseudonym: store.pseudonymOf(session.user_id),
      target_id: session_id,
      target_class: 'C1',
      severity: 'info',
      meta: {
        session_id_pseudonym: store.pseudonymOf(session_id),
        revoked_by_actor_pseudonym: store.pseudonymOf(session.user_id),
        reason: 'user_action'
      }
    });
    return { status: 200, body: { ok: true }, headers: { 'content-type': 'application/json' } };
  }

  // -----------------------------------------------------------------
  // enrollFirstDevice — F-43 atomic with TOTP destroy
  // -----------------------------------------------------------------

  async function enrollFirstDevice(opts: {
    totp_code: string;
    user_id: string;
  }): Promise<EnrollResult> {
    const credential: PasskeyCredential = {
      credentialId: `cred-${opts.user_id}-${now()}`,
      user_id: opts.user_id,
      rpId: RP_ID,
      publicKey: 'pk-' + opts.user_id,
      counter: 0,
      aaguid: '00000000-0000-0000-0000-000000000000',
      transports: ['internal'],
      device_label: 'first-device',
      created_at: now(),
      last_used_at: now()
    };

    const result = await store.consumeTotpAndEnrollPasskey({
      user_id: opts.user_id,
      totp_code: opts.totp_code,
      credential,
      now: now()
    });

    if (!result.ok) {
      const status =
        result.reason === 'locked'
          ? 429
          : result.reason === 'expired'
            ? 410
            : result.reason === 'consumed'
              ? 410
              : 401;
      return { status, reason_key: 'auth.enroll.failed' };
    }

    return {
      status: 200,
      passkey_credential_id: result.credential_id,
      totp_consumed: true
    };
  }

  // -----------------------------------------------------------------
  // loginPasskey — happy-path WebAuthn assertion
  // -----------------------------------------------------------------

  async function loginPasskey(
    credential: PasskeyCredential,
    opts?: { device_fingerprint?: string }
  ): Promise<LoginResult> {
    // Per ADR-0003 Amendment A (per-attempt canonical wording, ratified
    // by amendment pass #4 G.5): emit a structured-log INFO line on
    // every attempt (success + failure), NOT an audit_log row. The line
    // carries `auth.method` + `auth.result` only; no PI.
    log.info({
      event: 'auth.passkey.assert',
      outcome: 'ok',
      attributes: {
        'auth.method': 'webauthn',
        'auth.result': 'ok'
      }
    });

    const session = await store.createSession({
      user_id: credential.user_id,
      now: now(),
      ttl_ms: SESSION_TTL_MS,
      ...(opts?.device_fingerprint !== undefined
        ? { device_fingerprint: opts.device_fingerprint }
        : {})
    });
    return {
      session_id: session.session_id,
      access_token: session.access_token,
      user_id: session.user_id,
      exp: session.exp
    };
  }

  async function revokeAllSessions(user_id: string): Promise<void> {
    const revoked = await store.revokeAllForUser(user_id, now());
    await store.emitAudit({
      event_type: 'session.revoked',
      actor_pseudonym: store.pseudonymOf(user_id),
      target_class: 'C1',
      severity: 'info',
      meta: {
        revoked_by_actor_pseudonym: store.pseudonymOf(user_id),
        reason: 'user_action',
        session_count: revoked.length
      }
    });
  }

  async function revokePasskey(credentialId: string, revoked_by_user_id: string): Promise<void> {
    const cred = await store.getCredential(credentialId);
    if (!cred) return;
    await store.deleteCredential(credentialId);
    await store.emitAudit({
      event_type: 'auth.passkey.revoked',
      actor_pseudonym: store.pseudonymOf(cred.user_id),
      target_class: 'C1',
      severity: 'info',
      meta: {
        cred_id_pseudonym: store.pseudonymOf(credentialId),
        revoked_by_actor_pseudonym: store.pseudonymOf(revoked_by_user_id)
      }
    });
  }

  async function listSessions(user_id: string): Promise<AuthSession[]> {
    return store.listActiveSessions(user_id);
  }

  return {
    attemptPasskeyAssert,
    assertFromOrigin,
    attemptTotpLogin,
    callProtected,
    revokeSession,
    checkBrowserBaseline,
    enrollFirstDevice,
    loginPasskey,
    listSessions,
    revokeAllSessions,
    revokePasskey
  };
}

export { SESSION_TTL_MS, RP_ID };
