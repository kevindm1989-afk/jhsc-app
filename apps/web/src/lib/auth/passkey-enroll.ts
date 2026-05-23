/**
 * WebAuthn registration ceremony — first-device enrollment.
 *
 * Source obligations:
 *   - ADR-0002 — first device uses a one-shot TOTP bootstrap; subsequent
 *     devices are gated by an existing passkey assertion.
 *   - F-43 — TOTP secret destroyed atomically with the passkey enrollment.
 *
 * The atomic txn lives on the server (Postgres function
 * `enroll_first_passkey` in `supabase/migrations/00000000000001_auth.sql`);
 * the browser-side surface here only orchestrates the ceremony and dispatches
 * to the server function via the auth client.
 */

import type { AuthClient, EnrollResult } from './types';

export async function enrollFirstDevicePasskey(
  auth: AuthClient,
  opts: { totp_code: string; user_id: string }
): Promise<EnrollResult> {
  return auth.enrollFirstDevice(opts);
}

export { enrollFirstDevicePasskey as enrollFirstDevice };
