/**
 * T19.1 — `$lib/i18n` module public-surface pin.
 *
 * Every route + component imports `t` from `$lib/i18n` to resolve
 * visible text. A rename or signature change would cascade across
 * the entire UI surface. The module also exposes `hasKey` (for
 * conditional rendering when a key may be absent) and `LOCALE` (the
 * canonical "en-CA" string used by `<html lang>` and the manifest).
 *
 * The catalog loader merges the root `i18n/en-CA.json` + the scoped
 * `onboarding.en-CA.json` per ADR-0020 Decision 11; this pin defends
 * the public surface, not the loader internals (which the catalog-
 * coverage tests already cover).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const I18N_DIR = resolve(__dirname, '../../src/lib/i18n');
const INDEX_TS = resolve(I18N_DIR, 'index.ts');

describe('T19.1 — $lib/i18n module surface', () => {
  it('the i18n module exists at src/lib/i18n/index.ts', () => {
    expect(existsSync(INDEX_TS)).toBe(true);
  });

  const src = readFileSync(INDEX_TS, 'utf8');

  it('exports `t(key, vars?)` with the canonical signature', () => {
    expect(src).toMatch(
      /export\s+function\s+t\s*\(\s*key:\s*string,\s*vars\?:\s*Record<string,\s*string\s*\|\s*number>\s*\)\s*:\s*string/
    );
  });

  it('exports `hasKey(key)` for conditional rendering', () => {
    expect(src).toMatch(/export\s+function\s+hasKey\s*\(\s*key:\s*string\s*\)\s*:\s*boolean/);
  });

  it('exports `LOCALE = "en-CA"` (canonical locale tag — mirrors <html lang>)', () => {
    expect(src).toMatch(/export\s+const\s+LOCALE\s*=\s*['"]en-CA['"]/);
  });

  it('the scoped onboarding catalog (onboarding.en-CA.json) exists', () => {
    // Per ADR-0020 Decision 11 the T19 surfaces use a scoped catalog
    // overlaid on the root i18n/en-CA.json. The scoped file must
    // exist; if absent, the loader's overlay step would fail at
    // module init and break every route.
    expect(existsSync(resolve(I18N_DIR, 'onboarding.en-CA.json'))).toBe(true);
  });
});
