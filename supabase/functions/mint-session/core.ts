/**
 * mint-session / core — passkey-assertion → GoTrue session minting (ADR-0023).
 *
 * Security-critical orchestration. Runtime: Deno (Supabase Edge Function).
 * This module is the testable heart; the HTTP handler (index.ts) and the
 * production adapters (real WebAuthn verification, asymmetric JWT signing,
 * auth_sessions / webauthn_credentials access via @supabase/supabase-js) inject
 * the `MintDeps` and are wired in a later increment.
 *
 * Threat conditions enforced here (threat-model §3.12):
 *   - F-117: the minted token's `sub` is derived SERVER-SIDE from the proven
 *     credential (verifyAssertion → credential_id → lookupUserIdByCredential),
 *     NEVER from a request body. `AssertionInput` deliberately has no uid
 *     field, so a client-supplied uid is structurally impossible to honour.
 *     The signer is unreachable unless the assertion verifies first.
 *   - F-118: signing is delegated to `signJwt` (the isolated signing key);
 *     this module never touches a service-role client or reads data.
 *   - F-119: only a credential that resolves to a real user_id yields a
 *     session; an unknown credential is rejected (401).
 *   - F-116: the token TTL is bounded to ≤300s and the session row (jti) is
 *     written to the revocation list BEFORE the token is returned, so a
 *     revoke can deny it within its lifetime.
 */

/** Raw WebAuthn assertion material. Note: NO user id field (F-117). */
export interface AssertionInput {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  /** Request origin; the verifier checks RP-ID derivation (F-37). */
  origin: string;
}

export interface MintDeps {
  /** Verify the assertion; returns ONLY the credential it proves (F-117). */
  verifyAssertion(
    input: AssertionInput
  ): Promise<{ ok: true; credentialId: string } | { ok: false }>;
  /** Resolve the uid from the proven credential, server-side (F-117/F-119). */
  lookupUserIdByCredential(credentialId: string): Promise<string | null>;
  /** Write the jti row to auth_sessions (the revocation list). */
  createSession(opts: { user_id: string; expires_at_ms: number }): Promise<{ session_id: string }>;
  /** Sign the short-lived JWT with the isolated signing key (F-118). */
  signJwt(claims: {
    sub: string;
    role: 'authenticated';
    session_id: string;
    iat: number;
    exp: number;
  }): Promise<string>;
  /** ms-epoch clock. */
  now(): number;
  /** Token lifetime in seconds; clamped to ≤300 (F-116). */
  ttlSeconds?: number;
}

export type MintResult =
  | { ok: true; access_token: string; session_id: string; expires_at_ms: number }
  | { ok: false; reason: 'assertion_invalid' | 'unknown_credential'; status: 401 };

/** Hard ceiling on the minted token lifetime (ADR-0023 / F-116). */
export const MAX_TTL_SECONDS = 300;

export async function mintSessionFromAssertion(
  deps: MintDeps,
  input: AssertionInput
): Promise<MintResult> {
  // F-117: verify FIRST. The signer must be unreachable without a verified
  // assertion in this same invocation.
  const verified = await deps.verifyAssertion(input);
  if (!verified.ok) return { ok: false, reason: 'assertion_invalid', status: 401 };

  // F-117 / F-119: uid comes from the proven credential, server-side — never
  // from the request. An unknown credential cannot mint a session.
  const user_id = await deps.lookupUserIdByCredential(verified.credentialId);
  if (!user_id) return { ok: false, reason: 'unknown_credential', status: 401 };

  // F-116: clamp TTL to the ceiling regardless of caller input.
  const ttl = Math.min(deps.ttlSeconds ?? MAX_TTL_SECONDS, MAX_TTL_SECONDS);
  const nowMs = deps.now();
  const expiresAtMs = nowMs + ttl * 1000;

  // Write the jti to the revocation list BEFORE issuing the token, so a
  // concurrent revoke can deny it for its whole life (F-116).
  const { session_id } = await deps.createSession({ user_id, expires_at_ms: expiresAtMs });

  const access_token = await deps.signJwt({
    sub: user_id,
    role: 'authenticated',
    session_id,
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + ttl
  });

  return { ok: true, access_token, session_id, expires_at_ms: expiresAtMs };
}
