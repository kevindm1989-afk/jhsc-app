/**
 * T19.1 — eslint.config.js rule pins.
 *
 * The flat ESLint config carries two project-specific rules that are
 * load-bearing for the threat model + ADR-0010 logging contract:
 *
 *   - `no-console` set to `error` (with the `['warn', 'error']`
 *     allowlist) — pushes every emission through `$lib/log` (the
 *     structured logger) instead of bare `console.log(...)`. Bare
 *     console calls bypass the safeFields denylist + the Sentry-
 *     scrub `beforeBreadcrumb` pass, leaking PI into the browser
 *     DevTools console where any onlooker can read it.
 *
 *   - `@typescript-eslint/no-explicit-any` set to `warn` — discourages
 *     `any` casts that defeat the strict-mode contracts the rest of
 *     the codebase pins (tsconfig strict, noImplicitAny,
 *     strictNullChecks, etc.).
 *
 *   - `@typescript-eslint/no-unused-vars` with the `^_` prefix
 *     exception so intentionally-unused vars can be marked.
 *
 * None of these were structurally pinned. A future refactor that
 * drops one of them would silently re-enable the bypass.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONFIG_PATH = resolve(__dirname, '../../eslint.config.js');

describe('T19.1 — eslint.config.js exists + has the load-bearing rules', () => {
  it('eslint.config.js exists at the expected path', () => {
    expect(existsSync(CONFIG_PATH)).toBe(true);
  });

  it('declares `no-console` as `error` with the warn/error allowlist', () => {
    // The structured logger ($lib/log) is the only sanctioned
    // emission point. Bare console.log bypasses safeFields + the
    // Sentry-scrub beforeBreadcrumb pass — a PI leak channel.
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(/['"]no-console['"]\s*:\s*\[\s*['"]error['"]/);
    // The allowlist preserves console.warn + console.error (those
    // surface through the same Sentry scrub path as logger output).
    expect(src).toMatch(/allow:\s*\[\s*['"]warn['"]\s*,\s*['"]error['"]\s*\]/);
  });

  it('declares `@typescript-eslint/no-explicit-any` as a warning', () => {
    // `any` casts defeat the strict-mode contracts (tsconfig strict,
    // noImplicitAny). The warn level lets specific cases through with
    // an inline `// eslint-disable-next-line` comment that documents
    // why; pinning prevents silent demotion to "off".
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(
      /['"]@typescript-eslint\/no-explicit-any['"]\s*:\s*['"]warn['"]/
    );
  });

  it('declares `@typescript-eslint/no-unused-vars` with the `^_` prefix exception', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(/['"]@typescript-eslint\/no-unused-vars['"]/);
    // Both `args` and `vars` patterns must use the `^_` prefix
    // exception so intentionally-unused vars can be marked with the
    // underscore convention (matches the codebase pattern in
    // /onboarding/+page.svelte's `_accent`).
    expect(src).toMatch(/argsIgnorePattern:\s*['"]\^_['"]/);
    expect(src).toMatch(/varsIgnorePattern:\s*['"]\^_['"]/);
  });

  it('the BASE `no-console` rule is `error` (not `off`) — scoped overrides for tests + the logger module itself are allowed', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    // The base config (first `files: ['**/*.ts', '**/*.tsx']` block)
    // MUST set no-console to error. Test files and the logger module
    // legitimately scope-override to 'off' — they are the sanctioned
    // console boundary. The positive `error` pin above already covers
    // the contract; this assertion adds a directional pin that the
    // FIRST occurrence of `no-console:` is the `error` form, not the
    // override `off` form (defense against the override blocks being
    // moved before the base block).
    const firstNoConsoleAt = src.search(/['"]no-console['"]/);
    const firstErrorAt = src.indexOf("'error'", firstNoConsoleAt);
    const firstOffAt = src.indexOf("'off'", firstNoConsoleAt);
    expect(firstNoConsoleAt).toBeGreaterThan(-1);
    expect(firstErrorAt).toBeGreaterThan(-1);
    // The first `'error'` after the first `no-console` reference must
    // come BEFORE the first `'off'` after that same point (or the off
    // reference doesn't exist at all if there are no scope overrides).
    if (firstOffAt > -1) {
      expect(firstErrorAt).toBeLessThan(firstOffAt);
    }
  });

  it('loads the @eslint/js recommended preset (baseline `no-undef`, `no-unused-vars`, etc.)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(/import\s+js\s+from\s+['"]@eslint\/js['"]/);
    expect(src).toMatch(/js\.configs\.recommended/);
  });

  it('loads the @typescript-eslint plugin (TS-specific rules + parser)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(
      /import\s+tsPlugin\s+from\s+['"]@typescript-eslint\/eslint-plugin['"]/
    );
    expect(src).toMatch(/import\s+tsParser\s+from\s+['"]@typescript-eslint\/parser['"]/);
  });

  it('loads the eslint-plugin-svelte (Svelte-component-specific rules + parser)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(/import\s+sveltePlugin\s+from\s+['"]eslint-plugin-svelte['"]/);
    expect(src).toMatch(/import\s+svelteParser\s+from\s+['"]svelte-eslint-parser['"]/);
  });
});
