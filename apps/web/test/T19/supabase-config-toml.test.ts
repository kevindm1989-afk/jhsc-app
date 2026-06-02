/**
 * T19.1 — supabase/config.toml load-bearing-value pins.
 *
 * The local-stack supabase/config.toml mirrors the production posture
 * for the values that are deploy-config invariants (jwt_expiry, signup
 * gates). Drift here would let the local stack run with different
 * security posture than production, masking issues in CI.
 *
 *   - `project_id = "jhsc-app"` — pins the local-stack identity.
 *   - `jwt_expiry = 300` — F-116 threat-model contract: JWT TTL ≤ 300s.
 *     Drift up would extend the window for revoked-JWT replay.
 *   - `enable_signup = false` — ADR-0023 / threat-model F-117: signup
 *     is server-side via the mint-session ceremony, never GoTrue's
 *     /signup endpoint. Enabling it would open a bypass around the
 *     passkey-bound identity contract.
 *   - `enable_anonymous_sign_ins = false` — anonymous auth would
 *     defeat RLS's `auth.uid()`-based isolation.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONFIG_PATH = resolve(__dirname, '../../../../supabase/config.toml');

describe('T19.1 — supabase/config.toml load-bearing values', () => {
  it('the config file exists at supabase/config.toml', () => {
    expect(existsSync(CONFIG_PATH)).toBe(true);
  });

  const src = readFileSync(CONFIG_PATH, 'utf8');

  it('declares `project_id = "jhsc-app"` (local-stack identity pin)', () => {
    expect(src).toMatch(/^project_id\s*=\s*"jhsc-app"\s*$/m);
  });

  it('declares `jwt_expiry = 300` (F-116 TTL ≤ 300s contract)', () => {
    expect(src).toMatch(/^jwt_expiry\s*=\s*300\s*$/m);
  });

  it('disables GoTrue signup (`enable_signup = false`) — mint-session is the only ID path', () => {
    // ADR-0023 / threat-model F-117: identity is minted server-side
    // by mint-session against a verified WebAuthn assertion. GoTrue's
    // /signup endpoint would bypass that flow.
    expect(src).toMatch(/^enable_signup\s*=\s*false\s*$/m);
  });

  it('disables anonymous sign-ins (`enable_anonymous_sign_ins = false`) — RLS depends on real auth.uid()', () => {
    expect(src).toMatch(/^enable_anonymous_sign_ins\s*=\s*false\s*$/m);
  });

  it('does NOT enable signup anywhere via `enable_signup = true` (regression guard)', () => {
    // Defense pin: a refactor that adds `enable_signup = true` under
    // a different table heading (e.g., [auth.email]) would silently
    // re-enable the bypass.
    expect(src).not.toMatch(/^enable_signup\s*=\s*true\s*$/m);
  });
});
