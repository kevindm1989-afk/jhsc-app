/**
 * T19.1 — `$lib/log` safeFields + PI_DENYLIST surface pin.
 *
 * The structured logger uses an allowlist (`SAFE_FIELDS`) + a denylist
 * (`PI_DENYLIST`) to enforce the logging.md §4 contract: unknown keys
 * are dropped silently; denylisted keys (`email`, `phone`, etc.) are
 * dropped even if they accidentally end up in the allowlist due to
 * refactor drift. The defense-in-depth logic only works if both lists
 * are correctly exported AND non-empty.
 *
 * Plus `SAFE_FIELDS_ALLOWLIST_ID` — a digest of the allowlist that
 * lets server-side checks prove they're using the same list as the
 * browser (single-source-of-truth pin).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SAFE_FIELDS_TS = resolve(__dirname, '../../src/lib/log/safe-fields.ts');
const LOG_INDEX = resolve(__dirname, '../../src/lib/log/index.ts');

describe('T19.1 — $lib/log/safe-fields.ts surface', () => {
  it('safe-fields.ts exists', () => {
    expect(existsSync(SAFE_FIELDS_TS)).toBe(true);
  });

  const src = readFileSync(SAFE_FIELDS_TS, 'utf8');

  it('exports SAFE_FIELDS as a ReadonlySet<string>', () => {
    expect(src).toMatch(/export\s+const\s+SAFE_FIELDS:\s*ReadonlySet<string>\s*=\s*new\s+Set\(/);
  });

  it('exports PI_DENYLIST as a ReadonlySet<string>', () => {
    expect(src).toMatch(/export\s+const\s+PI_DENYLIST:\s*ReadonlySet<string>\s*=\s*new\s+Set\(/);
  });

  it('exports SAFE_FIELDS_ALLOWLIST_ID (digest pin for cross-process single-source-of-truth)', () => {
    expect(src).toMatch(/export\s+const\s+SAFE_FIELDS_ALLOWLIST_ID\s*=/);
  });
});

describe('T19.1 — $lib/log/index.ts re-exports the safeFields surface', () => {
  it('log/index.ts exists', () => {
    expect(existsSync(LOG_INDEX)).toBe(true);
  });

  const src = readFileSync(LOG_INDEX, 'utf8');

  it('imports SAFE_FIELDS + PI_DENYLIST from ./safe-fields', () => {
    expect(src).toMatch(
      /import\s*{\s*SAFE_FIELDS\s*,\s*PI_DENYLIST\s*}\s*from\s*['"]\.\/safe-fields['"]/
    );
  });

  it('re-exports SAFE_FIELDS_ALLOWLIST_ID', () => {
    // Re-export lets callers prove they're consuming the same
    // allowlist version as the logger without reaching into the
    // private safe-fields module.
    expect(src).toMatch(/export\s*{\s*SAFE_FIELDS_ALLOWLIST_ID\s*}\s*from\s*['"]\.\/safe-fields['"]/);
  });

  it('exports the `log` API (entry point for structured logging)', () => {
    expect(src).toMatch(/export\s+const\s+log\s*=/);
  });

  it('exports the LogLevel + LogLine + LogCall types', () => {
    expect(src).toMatch(/export\s+type\s+LogLevel\s*=/);
    expect(src).toMatch(/export\s+interface\s+LogLine\b/);
    expect(src).toMatch(/export\s+interface\s+LogCall\b/);
  });
});
