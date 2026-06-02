/**
 * T19.1 — `scripts/verify*.sh` + `scripts/check-*.sh` structural pins.
 *
 * The verify-stack scripts are the entry points for the CI hardening
 * gates. If any of them is silently removed, the gate they implement
 * stops running on PRs — locally tests still pass.
 *
 * Pins exact file presence + a distinguishing line from each script's
 * header so a refactor that empties the file (but keeps the path)
 * also lands here.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPTS = resolve(__dirname, '../../../../scripts');

function exists(name: string): boolean {
  return existsSync(resolve(SCRIPTS, name));
}
function readSh(name: string): string {
  return readFileSync(resolve(SCRIPTS, name), 'utf8');
}

describe('T19.1 — scripts/verify.sh (entry point for the gate stack)', () => {
  it('exists', () => {
    expect(exists('verify.sh')).toBe(true);
  });

  it('declares the gate-aggregator header', () => {
    expect(readSh('verify.sh')).toMatch(/verify\.sh — full verification gate stack/);
  });

  it('has the OVERALL: PASS / FAIL summary section', () => {
    // Defense pin: a refactor that drops the summary would let the
    // script silently exit 0 on a failed gate.
    expect(readSh('verify.sh')).toMatch(/OVERALL:/);
  });
});

describe('T19.1 — scripts/verify-i18n.sh (ADR-0009 raw-string scanner)', () => {
  it('exists', () => {
    expect(exists('verify-i18n.sh')).toBe(true);
  });

  it('declares the ADR-0009 source obligation', () => {
    expect(readSh('verify-i18n.sh')).toMatch(/ADR-0009/);
  });
});

describe('T19.1 — scripts/check-supabase-region.sh (ADR-0001 ca-central-1 pin)', () => {
  it('exists', () => {
    expect(exists('check-supabase-region.sh')).toBe(true);
  });

  it('declares the ADR-0001 source obligation + ca-central-1', () => {
    const src = readSh('check-supabase-region.sh');
    expect(src).toMatch(/ADR-0001/);
    expect(src).toMatch(/ca-central-1/);
  });
});

describe('T19.1 — scripts/check-onboarding-no-passphrase-leak.sh (G-T19-6 lint)', () => {
  it('exists', () => {
    expect(exists('check-onboarding-no-passphrase-leak.sh')).toBe(true);
  });
});

describe('T19.1 — scripts/verify-no-third-party-js.sh (bundle scan)', () => {
  it('exists', () => {
    expect(exists('verify-no-third-party-js.sh')).toBe(true);
  });
});

describe('T19.1 — scripts/check-audit-enum-coverage.sh (audit-log enum mirror)', () => {
  it('exists', () => {
    expect(exists('check-audit-enum-coverage.sh')).toBe(true);
  });
});
