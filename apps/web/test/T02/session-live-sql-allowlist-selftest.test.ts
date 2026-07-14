/**
 * T02 / F-121 — CI-gate self-test for the SQL-layer session-live allowlist.
 *
 * Finding: F-121 (open HIGH — session-revocation uniformity). Companion to the
 * pgTAP behavioural proof at supabase/test/t05_session_live_rls.sql.
 *
 * Source obligations:
 *   - threat-model.md §3.14 F-116 / F-121 (session_is_live uniformity).
 *   - ADR-0023 (session_is_live) + ADR-0023 Amendment A (the uniformity gate
 *     is STRUCTURAL, enforced by scripts/verify-session-live-uniformity.sh).
 *   - .context/lessons.md 2026-06-16 ("verify a gate FIRES with a synthetic
 *     probe" — a gate that cannot fail catches nothing).
 *
 * WHAT THIS PINS
 *   Today scripts/verify-session-live-uniformity.sh enforces the F-116
 *   EF-DISPATCHER surface (every op EF imports+calls assertSessionLive, or is
 *   on the permanent allowlist). The OPEN F-121 surface is the SQL layer: the
 *   three self-scoped READ policies and the three authenticated-grantable
 *   REVOKE RPCs must each contain a `session_is_live` gate. This test requires
 *   the implementer to EXTEND the script with:
 *     (1) a SQL-layer allowlist section that asserts each of the six symbols
 *         below actually contains `session_is_live` in the migrations, and
 *     (2) a `--self-test` mode that PROVES that section is regression-catching
 *         by running it against a synthetic fixture with the gate stripped and
 *         confirming a NON-ZERO exit (the lessons.md synthetic-probe rule).
 *
 * RED-FIRST (against current `main`):
 *   `verify-session-live-uniformity.sh --self-test` currently IGNORES the flag
 *   (no arg parsing) and runs only the EF-grep path, printing the EF "OK"
 *   line and exiting 0. It emits NONE of the SQL-layer markers this test
 *   requires — so every assertion below fails until the section + `--self-test`
 *   land. Confirmed on main: the flag is a no-op.
 *
 * DETERMINISM
 *   Pure subprocess of a shell script over checked-in files. No clock, no
 *   network, no RNG, no shared state. Mirrors the execSync harness in
 *   apps/web/test/T02/ci-gates.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/verify-session-live-uniformity.sh');

// The six SQL surfaces F-121 requires the gate on (threat-model §3.14). The
// script's SQL-layer allowlist section MUST name each — three read policies
// and three revoke RPCs.
const GATED_SURFACES = [
  'users_select_self',
  'auth_sessions_select_self',
  'webauthn_credentials_select_self',
  'revoke_my_session',
  'revoke_all_my_sessions',
  'revoke_my_passkey'
] as const;

interface RunResult {
  status: number;
  output: string; // stdout + stderr combined
}

function runScript(args: string[]): RunResult {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { status: 0, output: stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    const out = `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`;
    return { status: err.status ?? 1, output: out };
  }
}

describe('T02 / F-121 — verify-session-live-uniformity.sh SQL-layer allowlist self-test', () => {
  it('F-121 — the uniformity script exists', () => {
    expect(existsSync(SCRIPT), `expected the gate script at ${SCRIPT}`).toBe(true);
  });

  it('F-121 — `--self-test` runs a SQL-layer session-live allowlist check that names all six gated surfaces', () => {
    const { output } = runScript(['--self-test']);
    // The self-test must announce it is the SQL-layer session-live check
    // (distinct from the EF-dispatcher grep the base script already runs).
    expect(
      /self-test/i.test(output),
      `expected --self-test to announce a self-test run; got:\n${output}`
    ).toBe(true);
    expect(
      /session_is_live/.test(output),
      `expected --self-test to reference the session_is_live gate; got:\n${output}`
    ).toBe(true);
    expect(
      /F-121/.test(output),
      `expected --self-test to cite F-121 as the finding it guards; got:\n${output}`
    ).toBe(true);
    // It must enumerate the exact six SQL surfaces so a future PR that drops
    // one from the allowlist is caught.
    for (const surface of GATED_SURFACES) {
      expect(
        output.includes(surface),
        `expected --self-test to name gated surface '${surface}'; got:\n${output}`
      ).toBe(true);
    }
  });

  it('F-121 — `--self-test` self-validates (synthetic stripped-gate fixture is caught) and exits 0 on a correct tree', () => {
    const { status, output } = runScript(['--self-test']);
    // The self-test's contract (lessons.md 2026-06-16 synthetic-probe rule):
    // internally strip `session_is_live` from an allowlisted policy/function,
    // run the SQL-layer allowlist check against that fixture, and assert it
    // returns NON-ZERO. The `--self-test` invocation then exits 0 iff that
    // negative control was correctly caught AND the real migrations pass.
    // It must report that the synthetic regression was detected.
    expect(
      /(negative control|synthetic|stripped|tamper)/i.test(output),
      `expected --self-test to exercise a synthetic stripped-gate negative control; got:\n${output}`
    ).toBe(true);
    expect(
      status,
      `expected --self-test to exit 0 on a correct tree (negative control caught, real migrations gated); got exit ${status} and:\n${output}`
    ).toBe(0);
    // Guard-of-the-guard (security/adversarial review F-121): the negative control
    // MUST exercise a FUNCTION surface, not only a policy. The 3 revoke RPCs gate
    // via `_t07_gate_session()` (not the literal `session_is_live`), so a
    // comment-only false-green is caught ONLY if a function-surface strip is
    // tested. Require the self-test to report a function-surface (revoke_my_session)
    // gate strip being CAUGHT — otherwise a regression to policy-only coverage
    // (which cannot catch a dropped PERFORM) would slip through unnoticed.
    expect(
      /caught[^\n]*revoke_my_session|revoke_my_session[^\n]*caught/i.test(output),
      `expected --self-test to catch a FUNCTION-surface (revoke_my_session) gate strip, not only a policy; got:\n${output}`
    ).toBe(true);
  });
});
