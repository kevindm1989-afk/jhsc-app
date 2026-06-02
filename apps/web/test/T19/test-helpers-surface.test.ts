/**
 * T19.1 — `apps/web/test/_helpers/` public-surface pins.
 *
 * The test helpers under _helpers/ are imported by hundreds of test
 * call-sites:
 *
 *   - `clock.ts` — freezeClock / restoreClock / advanceBy; FROZEN_NOW_MS
 *     fixture. Removing or renaming any export breaks half the test
 *     suite at once.
 *   - `axe-check.ts` — default-export `axeCheck(root, options)` for the
 *     a11y-specialist's per-state coverage.
 *   - `fixtures.ts` — synthetic-PI canary literals + UUIDs; must stay
 *     in sync with the Sentry-scrub CANARIES list.
 *
 * Pin the export names so a refactor that renames (e.g.,
 * `freezeClock → freeze`) lands here before every consumer test fails.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HELPERS = resolve(__dirname, '../_helpers');

function read(name: string): string {
  return readFileSync(resolve(HELPERS, name), 'utf8');
}

describe('T19.1 — _helpers/clock.ts public exports', () => {
  it('clock.ts exists', () => {
    expect(existsSync(resolve(HELPERS, 'clock.ts'))).toBe(true);
  });

  const src = read('clock.ts');

  it('exports freezeClock', () => {
    expect(src).toMatch(/export\s+function\s+freezeClock\b/);
  });

  it('exports restoreClock', () => {
    expect(src).toMatch(/export\s+function\s+restoreClock\b/);
  });

  it('exports advanceBy (test-clock advance helper)', () => {
    expect(src).toMatch(/export\s+function\s+advanceBy\b/);
  });

  it('exports the DST + leap-day fixture constants', () => {
    expect(src).toMatch(/export\s+const\s+DST_SWITCH_SPRING_2026_ET\b/);
    expect(src).toMatch(/export\s+const\s+DST_SWITCH_FALL_2026_ET\b/);
    expect(src).toMatch(/export\s+const\s+LEAP_DAY_2028\b/);
  });
});

describe('T19.1 — _helpers/axe-check.ts public surface', () => {
  it('axe-check.ts exists', () => {
    expect(existsSync(resolve(HELPERS, 'axe-check.ts'))).toBe(true);
  });

  const src = read('axe-check.ts');

  it('exports the AxeViolation + AxeResult + AxeCheckOptions interfaces', () => {
    expect(src).toMatch(/export\s+interface\s+AxeViolation\b/);
    expect(src).toMatch(/export\s+interface\s+AxeResult\b/);
    expect(src).toMatch(/export\s+interface\s+AxeCheckOptions\b/);
  });

  it('exports axeCheck as the default export (single-call a11y assertion)', () => {
    expect(src).toMatch(/export\s+default\s+async\s+function\s+axeCheck\b/);
  });
});

describe('T19.1 — _helpers/fixtures.ts canary literals', () => {
  it('fixtures.ts exists', () => {
    expect(existsSync(resolve(HELPERS, 'fixtures.ts'))).toBe(true);
  });

  const src = read('fixtures.ts');

  it('exports the four original canary literals (must mirror CANARIES in sentry-scrub.ts)', () => {
    expect(src).toMatch(/export\s+const\s+CANARY_PII_X\s*=\s*['"]CANARY_PII_X['"]/);
    expect(src).toMatch(/export\s+const\s+CANARY_PHONE_E164\s*=\s*['"]\+15555550100['"]/);
    expect(src).toMatch(/export\s+const\s+CANARY_EMAIL\s*=\s*['"]canary\.user@example\.test['"]/);
    expect(src).toMatch(/export\s+const\s+CANARY_PRIVKEY_SHAPE\s*=\s*['"]CANARY_PRIVKEY_SHAPE_FIXTURE['"]/);
  });

  it('exports the passphrase + TOTP canary literals (PR #80 / G-T19-7 F-110 M-110c)', () => {
    expect(src).toMatch(/export\s+const\s+CANARY_PASSPHRASE\s*=\s*['"]CANARY_PASSPHRASE_FIXTURE['"]/);
    expect(src).toMatch(/export\s+const\s+CANARY_TOTP\s*=\s*['"]CANARY_TOTP_FIXTURE['"]/);
  });

  it('exports FROZEN_NOW_MS + FROZEN_NOW_ISO (test-clock anchor)', () => {
    expect(src).toMatch(/export\s+const\s+FROZEN_NOW_ISO\b/);
    expect(src).toMatch(/export\s+const\s+FROZEN_NOW_MS\b/);
  });
});
