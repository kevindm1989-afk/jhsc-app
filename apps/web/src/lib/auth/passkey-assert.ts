/**
 * WebAuthn authentication ceremony — passkey assertion.
 *
 * Source obligations:
 *   - F-37 / T7 — passkey RP-ID origin binding; assertions from a non-RP
 *     origin are rejected with NotAllowedError.
 *   - F-40 / T8 — byte-identical, ≤50ms-equivalent failure responses
 *     between "unknown user" and "known user, wrong credential".
 *   - ADR-0003 Amendment A extension — `auth.passkey.assert` is structured-log
 *     only (NOT chain-participating). 100 assertions produce 0 audit rows
 *     and 100 INFO log lines.
 *
 * The implementation lives in `./auth-core.ts`; this module re-exports
 * the surface so the file layout matches the prompt.
 */

import type { AuthClient, LoginResult, PasskeyCredential, PasskeyAssertResult } from './types';

export async function loginWithPasskey(
  auth: AuthClient,
  credential: PasskeyCredential,
  opts?: { device_fingerprint?: string }
): Promise<LoginResult> {
  return auth.loginPasskey(credential, opts);
}

export async function assertPasskeyFromOrigin(
  auth: AuthClient,
  origin: string,
  credential: PasskeyCredential
): Promise<PasskeyAssertResult> {
  return auth.assertFromOrigin(origin, credential);
}
