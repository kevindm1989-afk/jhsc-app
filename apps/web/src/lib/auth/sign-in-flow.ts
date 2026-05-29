/**
 * Production sign-in orchestration — mint-session end-to-end (ADR-0023).
 *
 * Mirrors the posture of `enrollIdentityViaProduction` in
 * `crypto/production-flows.ts`: a callback-driven orchestrator that
 * separates the WebAuthn DOM call from the wire-level client + the
 * session-jwt-store. Three injected dependencies make it hermetically
 * testable:
 *
 *   - `client`              — the `SupabaseMintSessionClient` (challenge
 *                             + assert wire shapes).
 *   - `getAssertion`        — the WebAuthn signing callback. Production
 *                             wraps `navigator.credentials.get`; tests
 *                             return a canned `SignedAssertion`. Returning
 *                             `null` (or a thrown NotAllowedError) signals
 *                             user cancellation.
 *   - `setJwt`              — the session-jwt-store mutator. Production
 *                             passes the real `setJwt` from
 *                             `$lib/auth/session-jwt-store`; tests pass a
 *                             recording spy. ONLY called when the assert
 *                             returns `{ ok: true }` so a failed sign-in
 *                             never poisons the store.
 *
 * Five-step orchestration (each step is observable via the return shape):
 *
 *   1. `client.requestChallenge` → server-minted nonce (F-37, ≤120s, single-use).
 *   2. `getAssertion(challenge)` → caller signs via WebAuthn. Null or
 *      thrown error ⇒ `{status: 'cancelled'}`.
 *   3. `client.assertCredential` → server verifies the assertion + mints
 *      the token (F-117 sub derived server-side from the proven credential).
 *   4. `setJwt(access_token)` → the session-jwt-store is populated; this is
 *      the moment all four Edge Function factories' lazy `getJwt()` start
 *      seeing a real bearer.
 *   5. Return `{status: 'ok', ...}` so the caller (the sign-in route) can
 *      navigate / show a success state.
 *
 * F-39 boundary: this orchestrator does NOT clear the JWT on a failed
 * sign-in (there's no JWT to clear pre-sign-in). The mint-session client's
 * 401 from `assertion_invalid` / `unknown_credential` is NOT routed to
 * `clearJwt` — see `mint-session-client-factory.ts` for the structural
 * rationale.
 */

import type { MintSessionReason, SupabaseMintSessionClient } from './supabase-mint-session-client';

/** The WebAuthn assertion bytes the caller signs over the challenge. */
export interface SignedAssertion {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

export type SignInProductionResult =
  | { status: 'ok'; access_token: string; session_id: string; expires_at: string }
  | { status: 'cancelled' }
  | { status: 'failed'; reason: MintSessionReason; http: number };

export interface SignInViaMintSessionOptions {
  client: SupabaseMintSessionClient;
  /** RP-ID — typically the registrable domain (e.g. `jhsc.example`). */
  rpId: string;
  /** Origin — the full origin of the calling page (e.g. `https://jhsc.example`). */
  origin: string;
  /**
   * WebAuthn signing callback. Receives the server-minted challenge,
   * returns the signed assertion bytes, OR `null` (or throws — typically
   * `NotAllowedError`) when the user cancels the platform prompt. The
   * orchestrator treats both null and thrown errors as cancellation.
   */
  getAssertion: (challenge: string) => Promise<SignedAssertion | null> | SignedAssertion | null;
  /**
   * Session-jwt-store mutator. Production passes the imported `setJwt`
   * from `$lib/auth/session-jwt-store`; tests pass a recording spy. Only
   * invoked when the assert returns `{ ok: true }` so a failed sign-in
   * never poisons the store.
   */
  setJwt: (jwt: string) => void;
}

/**
 * End-to-end production sign-in. See module header for the contract.
 */
export async function signInViaMintSession(
  opts: SignInViaMintSessionOptions
): Promise<SignInProductionResult> {
  const challengeResult = await opts.client.requestChallenge({
    rpId: opts.rpId,
    origin: opts.origin
  });
  if (!challengeResult.ok) {
    return { status: 'failed', reason: challengeResult.reason, http: challengeResult.status };
  }
  const challenge = challengeResult.data.challenge;

  let assertion: SignedAssertion | null;
  try {
    assertion = await Promise.resolve(opts.getAssertion(challenge));
  } catch {
    // WebAuthn throws NotAllowedError on user cancellation / timeout /
    // no-matching-credential. The catch-all is intentional: the
    // browser's WebAuthn surface has multiple thrown shapes (DOMException
    // subclasses) and we treat every one as "user did not complete the
    // ceremony" — the audit-trail signal is the absence of a
    // subsequent mint.assert audit row, not a separate failure code here.
    return { status: 'cancelled' };
  }
  if (!assertion) return { status: 'cancelled' };

  const assertResult = await opts.client.assertCredential({
    credentialId: assertion.credentialId,
    clientDataJSON: assertion.clientDataJSON,
    authenticatorData: assertion.authenticatorData,
    signature: assertion.signature,
    origin: opts.origin,
    challenge
  });
  if (!assertResult.ok) {
    return { status: 'failed', reason: assertResult.reason, http: assertResult.status };
  }

  opts.setJwt(assertResult.data.access_token);

  return {
    status: 'ok',
    access_token: assertResult.data.access_token,
    session_id: assertResult.data.session_id,
    expires_at: assertResult.data.expires_at
  };
}
