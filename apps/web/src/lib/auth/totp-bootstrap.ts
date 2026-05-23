/**
 * TOTP bootstrap — one-shot code for first-device passkey enrollment.
 *
 * Source obligations:
 *   - F-38 — single-use; ≤15min validity; ≤5 attempts/15min/user.
 *   - F-43 — consumed atomically with the first passkey enrollment.
 *   - ADR-0002 — TOTP is NOT a login mechanism on its own; only consumed by
 *     the enrollment ceremony.
 *
 * The bootstrap row is destroyed atomically with the passkey-enrollment
 * SQL transaction (`public.enroll_first_passkey`). A separate
 * `auth_totp_consumed_log` row records the consumed-code so a reuse
 * attempt can still be detected without bringing the row back.
 *
 * This module re-exports the surface; the implementation lives in
 * `./auth-core.ts` and the storage in `./store.ts`.
 */

import type { AuthClient, AuthResponse } from './types';

export async function attemptTotpLogin(
  auth: AuthClient,
  user_id: string,
  totp_code: string
): Promise<AuthResponse> {
  return auth.attemptTotpLogin(user_id, totp_code);
}
