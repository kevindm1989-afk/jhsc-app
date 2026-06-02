/**
 * T19.1 — vitest.config.ts structural pin.
 *
 * The Vitest config establishes the test-runner contract — the test
 * environment, the determinism guarantees the test-plan mandates, and
 * the setup files that install the test sinks. Drift on any of these
 * silently changes the meaning of every test in the suite:
 *
 *   - `environment: 'jsdom'` — the test DOM. Drift to 'node' would
 *     leave every component test without a window/document, failing
 *     half the suite. Drift to 'happy-dom' would silently change DOM
 *     quirks (event ordering, mutation observers, etc.) that some
 *     tests depend on.
 *
 *   - `globals: false` — vitest's globals (describe/it/expect) are
 *     IMPORTED, not magic. Drift to `globals: true` would let tests
 *     accidentally rely on global vitest functions, making the test
 *     files harder to refactor / move.
 *
 *   - `sequence.shuffle: false` + `sequence.concurrent: false` —
 *     test-plan.md §3.J determinism contract. Drift to either true
 *     silently introduces order-sensitive bugs that pass locally
 *     but flake in CI.
 *
 *   - `setupFiles: ['./test/setup.ts']` — installs the test clock,
 *     the log sink replacement, and the test-only fixture wiring.
 *     Drift to a different setup file (or no setup) would silently
 *     leak the structured logger to real console + real Date.now,
 *     making half the time-sensitive tests flaky.
 *
 *   - `pool: 'threads'` + `singleThread: true` — single-threaded
 *     execution. The determinism contract assumes serial execution;
 *     drift to `'forks'` or multi-thread breaks the singleThread
 *     guarantee that the assertion helpers depend on.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONFIG_PATH = resolve(__dirname, '../../vitest.config.ts');

describe('T19.1 — vitest.config.ts structural contract', () => {
  it('vitest.config.ts exists', () => {
    expect(existsSync(CONFIG_PATH)).toBe(true);
  });

  it('sets test.environment to jsdom (browser-shaped DOM for component tests)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(/\benvironment:\s*['"]jsdom['"]/);
  });

  it('sets test.globals to false (explicit imports, no magic globals)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(/\bglobals:\s*false/);
  });

  it('sets sequence.shuffle to false (test-plan.md §3.J determinism)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(/\bshuffle:\s*false/);
  });

  it('sets sequence.concurrent to false (test-plan.md §3.J determinism)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(/\bconcurrent:\s*false/);
  });

  it('declares setupFiles: [\'./test/setup.ts\'] (clock + log-sink installation)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(/setupFiles:\s*\[\s*['"]\.\/test\/setup\.ts['"]\s*\]/);
  });

  it('uses pool: \'threads\' with singleThread: true (serial-execution determinism)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    expect(src).toMatch(/\bpool:\s*['"]threads['"]/);
    expect(src).toMatch(/\bsingleThread:\s*true/);
  });

  it('excludes the Deno edge-functions test root (those run in a separate Deno runner)', () => {
    const src = readFileSync(CONFIG_PATH, 'utf8');
    // Defense pin: a refactor that drops the exclude would have vitest
    // try to load the Deno-shaped test files, which use Deno-only
    // imports and would fail in confusing ways.
    expect(src).toMatch(/supabase\/functions/);
  });
});
