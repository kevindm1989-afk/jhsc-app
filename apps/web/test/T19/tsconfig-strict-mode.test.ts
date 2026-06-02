/**
 * T19.1 — tsconfig.json strict-mode flag pins.
 *
 * The TypeScript strict-mode flags are load-bearing for type safety
 * across the entire codebase. The `strict: true` umbrella flag turns
 * on a bundle of strict-mode behaviour; the individual strict-* flags
 * are documented explicitly in the config so a future TS version that
 * adds new strict-* options under the umbrella doesn't silently
 * weaken the contract by changing the default.
 *
 * Specific load-bearing flags:
 *
 *   - `strict: true` — umbrella for the canonical set.
 *   - `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`,
 *     `strictBindCallApply`, `strictPropertyInitialization`,
 *     `noImplicitThis`, `alwaysStrict` — the original strict bundle.
 *   - `exactOptionalPropertyTypes` — catches `prop?: T` vs
 *     `prop: T | undefined` confusion that the existing API surfaces
 *     depend on (e.g., the `MintSessionResult` discriminated union).
 *   - `noUncheckedIndexedAccess` — every array/object index returns
 *     `T | undefined`. The recovery-blob ciphertext parsing depends
 *     on this for its boundary checks.
 *   - `noImplicitOverride` — every `override` modifier must be
 *     explicit. Defense against accidental method shadowing.
 *   - `noFallthroughCasesInSwitch` — exhaustiveness in the state-
 *     machine switches throughout the auth flow.
 *
 * A regression that flips any of these to `false` would weaken the
 * type-safety contract globally without any code change failing tsc.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TSCONFIG_PATH = resolve(__dirname, '../../tsconfig.json');

describe('T19.1 — tsconfig.json strict-mode flags', () => {
  it('tsconfig.json exists', () => {
    expect(existsSync(TSCONFIG_PATH)).toBe(true);
  });

  it('extends .svelte-kit/tsconfig.json (the SvelteKit-generated baseline)', () => {
    const src = readFileSync(TSCONFIG_PATH, 'utf8');
    expect(src).toMatch(/['"]extends['"]\s*:\s*['"]\.\/\.svelte-kit\/tsconfig\.json['"]/);
  });

  // Parse JSON-with-comments isn't natively supported; tsconfig.json
  // in this project is plain JSON (verified by `JSON.parse` below).
  const cfg = JSON.parse(readFileSync(TSCONFIG_PATH, 'utf8'));
  const opts = cfg.compilerOptions ?? {};

  it('enables `strict: true` (umbrella for the canonical strict-mode bundle)', () => {
    expect(opts.strict).toBe(true);
  });

  it('enables `noImplicitAny: true`', () => {
    expect(opts.noImplicitAny).toBe(true);
  });

  it('enables `strictNullChecks: true`', () => {
    expect(opts.strictNullChecks).toBe(true);
  });

  it('enables `strictFunctionTypes: true`', () => {
    expect(opts.strictFunctionTypes).toBe(true);
  });

  it('enables `strictBindCallApply: true`', () => {
    expect(opts.strictBindCallApply).toBe(true);
  });

  it('enables `strictPropertyInitialization: true`', () => {
    expect(opts.strictPropertyInitialization).toBe(true);
  });

  it('enables `noImplicitThis: true`', () => {
    expect(opts.noImplicitThis).toBe(true);
  });

  it('enables `alwaysStrict: true`', () => {
    expect(opts.alwaysStrict).toBe(true);
  });

  it('enables `exactOptionalPropertyTypes: true` (load-bearing for MintSessionResult-shape unions)', () => {
    expect(opts.exactOptionalPropertyTypes).toBe(true);
  });

  it('enables `noUncheckedIndexedAccess: true` (every index returns T | undefined)', () => {
    // The recovery-blob ciphertext parsing relies on this for its
    // boundary checks (e.g. extracting the nonce prefix from a byte
    // array). Disabling this flag would let undefined slip through
    // those slices.
    expect(opts.noUncheckedIndexedAccess).toBe(true);
  });

  it('enables `noImplicitOverride: true`', () => {
    expect(opts.noImplicitOverride).toBe(true);
  });

  it('enables `noFallthroughCasesInSwitch: true`', () => {
    // Defends the exhaustiveness of state-machine switches throughout
    // the auth + onboarding flow.
    expect(opts.noFallthroughCasesInSwitch).toBe(true);
  });

  it('declares ES2022 target + ESNext module (modern personal-device baseline)', () => {
    expect(opts.target).toBe('ES2022');
    expect(opts.module).toBe('ESNext');
  });

  it('sets `noEmit: true` (vitest + svelte-check own the type pass; tsc never writes JS)', () => {
    expect(opts.noEmit).toBe(true);
  });
});
