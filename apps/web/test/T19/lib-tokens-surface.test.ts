/**
 * T19.1 — `$lib/tokens` accessor surface pin.
 *
 * Every component reads design values from `$lib/tokens` exclusively.
 * The token-audit gate (`scripts/verify-tokens.sh`) enforces this by
 * banning raw hex / px / rgba in source outside of files matching
 * `*.tokens.*` or `tokens/`. If the tokens module's public surface
 * changes (rename, drop the accessor, etc.), every component import
 * site breaks at once.
 *
 * Pin:
 *   - The module file exists at the canonical path.
 *   - It exports `tokens` (the typed accessor object).
 *   - It exports `Tokens` (the inferred type for component prop
 *     typings).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TOKENS_TS = resolve(__dirname, '../../src/lib/tokens.ts');

describe('T19.1 — $lib/tokens module surface', () => {
  it('tokens.ts exists at src/lib/tokens.ts', () => {
    expect(existsSync(TOKENS_TS)).toBe(true);
  });

  const src = readFileSync(TOKENS_TS, 'utf8');

  it('exports `tokens` — the typed accessor object components import', () => {
    expect(src).toMatch(/export\s+const\s+tokens\s*=/);
  });

  it('exports `Tokens` — the inferred type for component prop typings', () => {
    expect(src).toMatch(/export\s+type\s+Tokens\s*=\s*typeof\s+tokens/);
  });

  it('documents the no-raw-literal contract referenced by verify-tokens.sh', () => {
    // Defense pin: the module header explains the rule the token-
    // audit gate enforces. Drift here would orphan the gate's
    // rationale.
    expect(src).toMatch(/verify-tokens\.sh/);
  });
});
