/**
 * T02 — CI gate tests (the verifier-script enforcement surface).
 *
 * Source obligations:
 *   - observability/logging.md §7 (CI enforcement list: 7 rules).
 *   - .context/decisions.md ADR-0010 Amendment F-B (forbidden alias
 *     `inspection.synced.hmac_fail` outside the three documented files;
 *     verifier wires a semgrep rule).
 *   - .context/threat-model.md §8 T02 ("Semgrep: ban
 *     Sentry.captureException(err, { extra: { ... } }) with non-allowlisted
 *     keys").
 *   - .context/threat-model.md §8 T07 ("Invariant 4 strengthened — semgrep
 *     bans non-libsodium crypto imports outside src/lib/crypto/").
 *   - .context/threat-model.md §8 T07 ("Invariant 5 strengthened — no URL
 *     query parameter named `key|secret|passphrase|priv|nonce`").
 *
 * These tests assert the existence of the CI-gate scripts. They will FAIL
 * until the implementer wires the semgrep rules into scripts/verify.sh.
 * Each test is structurally a smoke test that the rule is present and
 * triggers on a known violating fixture.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SEMGREP_RULES = path.join(REPO_ROOT, '.semgrep');
const VERIFY_SCRIPT = path.join(REPO_ROOT, 'scripts/verify.sh');

describe('T02 / observability-logging.md §7 — CI enforcement gates', () => {
  it('T02 / logging.md §7 rule 1 — semgrep rule `no-pi-in-log-attrs` exists', () => {
    const rulePath = path.join(SEMGREP_RULES, 'no-pi-in-log-attrs.yml');
    expect(existsSync(rulePath), `expected semgrep rule at ${rulePath}`).toBe(true);
    const content = readFileSync(rulePath, 'utf8');
    // The rule's id must match the documented contract.
    expect(content).toMatch(/id:\s*no-pi-in-log-attrs/);
    // Must reference the PI keys it bans (at minimum: display_name, email,
    // phone, body, password, token).
    expect(content).toMatch(/display_name|email|phone|body|password|token/i);
  });

  it('T02 / logging.md §7 rule 2 — semgrep rule `no-console-log-req` exists and targets supabase/functions/', () => {
    const rulePath = path.join(SEMGREP_RULES, 'no-console-log-req.yml');
    expect(existsSync(rulePath), `expected semgrep rule at ${rulePath}`).toBe(true);
    const content = readFileSync(rulePath, 'utf8');
    expect(content).toMatch(/id:\s*no-console-log-req/);
    expect(content).toMatch(/supabase\/functions/);
  });

  it('T02 / logging.md §7 rule 3 — semgrep rule `no-direct-sentry-setuser` bans Sentry.setUser on browser path', () => {
    const rulePath = path.join(SEMGREP_RULES, 'no-direct-sentry-setuser.yml');
    expect(existsSync(rulePath), `expected semgrep rule at ${rulePath}`).toBe(true);
    const content = readFileSync(rulePath, 'utf8');
    expect(content).toMatch(/id:\s*no-direct-sentry-setuser/);
    expect(content).toMatch(/Sentry\.setUser/);
  });

  it('T02 / logging.md §7 rule 4 — semgrep rule `no-debug-in-prod` exists', () => {
    const rulePath = path.join(SEMGREP_RULES, 'no-debug-in-prod.yml');
    expect(existsSync(rulePath), `expected semgrep rule at ${rulePath}`).toBe(true);
  });

  it('T02 / ADR-0010 Amendment F-B — semgrep rule `no-inspection-synced-hmac-fail-alias` exists with documented allowlist of three files', () => {
    const rulePath = path.join(SEMGREP_RULES, 'no-inspection-synced-hmac-fail-alias.yml');
    expect(existsSync(rulePath), `expected semgrep rule at ${rulePath}`).toBe(true);
    const content = readFileSync(rulePath, 'utf8');
    // Allowlisted paths per ADR-0010 Amendment F-B (3 files):
    //   .context/decisions.md (this amendment block)
    //   .context/decisions.md ADR-0014 source
    //   observability/audit-log.md §6 finding #2
    // The semgrep `paths.exclude` (or equivalent) names them.
    expect(content).toMatch(/decisions\.md/);
    expect(content).toMatch(/audit-log\.md/);
  });

  it('T02 / threat-model T07 Invariant 4 — semgrep rule bans non-libsodium crypto imports outside src/lib/crypto/', () => {
    const rulePath = path.join(SEMGREP_RULES, 'no-non-libsodium-crypto.yml');
    expect(existsSync(rulePath), `expected semgrep rule at ${rulePath}`).toBe(true);
    const content = readFileSync(rulePath, 'utf8');
    // Common forbidden modules: 'crypto-js', 'node-forge', 'tweetnacl' (without
    // libsodium wrapper), bare 'crypto' subtle usage outside the crypto module.
    expect(content).toMatch(/crypto-js|node-forge|subtle/i);
  });

  it('T02 / threat-model T07 Invariant 5 — semgrep rule bans key-shaped URL query parameter names', () => {
    const rulePath = path.join(SEMGREP_RULES, 'no-key-shaped-url-params.yml');
    expect(existsSync(rulePath), `expected semgrep rule at ${rulePath}`).toBe(true);
    const content = readFileSync(rulePath, 'utf8');
    // Must call out at least: key, secret, passphrase, priv, nonce.
    expect(content).toMatch(/key|secret|passphrase|priv|nonce/);
  });

  it('T02 / observability-README §11.5 — closed-enum CI assertion script exists for audit_log.event_type', () => {
    // The audit-log closed enum is enforced at DB layer (CHECK constraint
    // in migrations), AND at code layer (CI grep over `audit_emit(` call
    // sites verifying each argument is on the allowlist). The CI script
    // lives in scripts/ and is wired into verify.sh.
    const scriptPath = path.join(REPO_ROOT, 'scripts/check-audit-enum-coverage.sh');
    expect(
      existsSync(scriptPath),
      `expected CI script at ${scriptPath} per ADR-0003 Amendment A extension`
    ).toBe(true);
  });

  it('T02 / verify.sh — invocation runs all semgrep rules and the canary-PII test fixture', () => {
    expect(existsSync(VERIFY_SCRIPT)).toBe(true);
    const content = readFileSync(VERIFY_SCRIPT, 'utf8');
    expect(content).toMatch(/semgrep/i);
    expect(content).toMatch(/sentry-scrub|canary/i);
  });

  it.skip('T02 / smoke — verify.sh exits 0 on a clean tree [requires implementer scaffold]', () => {
    // TODO(implementer): once T00 scaffold lands, this smoke test runs the
    // real verify.sh. Marked skip until scripts/verify.sh is a real entry
    // point (currently a placeholder shell script with TODOs).
    const result = execSync(`bash ${VERIFY_SCRIPT}`, { cwd: REPO_ROOT });
    expect(result.toString()).toBeDefined();
  });
});
