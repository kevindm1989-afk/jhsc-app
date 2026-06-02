/**
 * T19.1 — `.semgrep/` rule files structural pins.
 *
 * The Semgrep rules under `.semgrep/` run in the hardening gates as
 * the project's static-analysis layer for security-critical patterns:
 *   - no-bare-sha256-in-migrations.yml (audit-log §2 same-key pin)
 *   - no-pi-in-log-attrs.yml (logging.md §4)
 *   - no-non-libsodium-crypto.yml (crypto-primitive allowlist)
 *   - no-direct-sentry-setuser.yml (ADR-0010 PI-leak channel)
 *   - no-google-fonts.yml (no third-party CDN per JHSC-APP-PLAN.md §7)
 *   - no-debug-in-prod.yml (debug-only artefact)
 *   - no-key-shaped-url-params.yml (URL-leak channel)
 *   - no-console-log-req.yml (logger boundary)
 *   - no-inspection-synced-hmac-fail-alias.yml (T11 invariant)
 *   - no-raw-pi-in-logs.yml (logging.md §4 mirror)
 *
 * If any rule file is silently removed, the corresponding pattern
 * stops being checked at PR time. Pin existence + the canonical
 * structure of the no-bare-sha256 rule (the most security-critical
 * one).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SEMGREP = resolve(__dirname, '../../../../.semgrep');

function ruleExists(name: string): boolean {
  return existsSync(resolve(SEMGREP, name));
}

describe('T19.1 — .semgrep/ rule files exist (each defends a load-bearing invariant)', () => {
  it('no-bare-sha256-in-migrations.yml (audit-log same-key pseudonym pin)', () => {
    expect(ruleExists('no-bare-sha256-in-migrations.yml')).toBe(true);
  });

  it('no-pi-in-log-attrs.yml (logging.md §4 — PI keys in log attrs)', () => {
    expect(ruleExists('no-pi-in-log-attrs.yml')).toBe(true);
  });

  it('no-non-libsodium-crypto.yml (crypto-primitive allowlist)', () => {
    expect(ruleExists('no-non-libsodium-crypto.yml')).toBe(true);
  });

  it('no-direct-sentry-setuser.yml (ADR-0010 — Sentry.setUser is forbidden)', () => {
    expect(ruleExists('no-direct-sentry-setuser.yml')).toBe(true);
  });

  it('no-google-fonts.yml (JHSC-APP-PLAN.md §7 — no third-party CDN)', () => {
    expect(ruleExists('no-google-fonts.yml')).toBe(true);
  });

  it('no-debug-in-prod.yml (debug-only artefact in production code)', () => {
    expect(ruleExists('no-debug-in-prod.yml')).toBe(true);
  });

  it('no-key-shaped-url-params.yml (URL-leak channel)', () => {
    expect(ruleExists('no-key-shaped-url-params.yml')).toBe(true);
  });

  it('no-raw-pi-in-logs.yml (mirror of safeFields in static analysis)', () => {
    expect(ruleExists('no-raw-pi-in-logs.yml')).toBe(true);
  });
});

describe('T19.1 — canonical structure of no-bare-sha256-in-migrations rule', () => {
  const src = readFileSync(resolve(SEMGREP, 'no-bare-sha256-in-migrations.yml'), 'utf8');

  it('targets the SQL migrations path', () => {
    expect(src).toMatch(/supabase\/migrations\/\*\*\.sql/);
  });

  it('matches the bare digest pattern', () => {
    expect(src).toMatch(/digest\(\$X,\s*['"]sha256['"]\)/);
  });

  it('declares severity: ERROR (not WARNING) — pseudonym pin is blocking', () => {
    expect(src).toMatch(/severity:\s*ERROR/);
  });
});
