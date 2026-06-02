/**
 * T19.1 — `apps/web/test/setup.ts` jest-shim pin.
 *
 * `test/setup.ts` is wired by `vitest.config.ts`'s
 * `setupFiles: ['./test/setup.ts']` (pinned by vitest-config.test.ts),
 * so the FILE's existence is implicitly load-bearing — vitest would
 * fail at runtime with a missing-file error if it disappeared.
 *
 * What's NOT pinned is the file's CONTENT. The shim it installs is
 * load-bearing for two distinct test-runner contracts:
 *
 *   - `globalThis.jest` with `advanceTimersByTime` mapped to
 *     `vi.advanceTimersByTime` — without this, testing-library/dom's
 *     `waitFor` polls via the real `setInterval` (which fake-timers
 *     has already replaced), so every async-state assertion in the
 *     component-test surfaces times out silently. The detection
 *     function in @testing-library/dom v10 reads `globalThis.jest`
 *     to decide whether to use fake-timer advancement; Vitest's API
 *     is compatible but isn't auto-detected.
 *
 *   - `globalThis.vi` (Vitest itself) — pinned because the T13
 *     reprisal-log test references `vi.fn()` without an explicit
 *     import, and `globals: false` in vitest.config.ts (also pinned)
 *     means the symbol isn't on the global by default. Removing the
 *     shim would break that test's pre-consent gate assertion.
 *
 * A refactor that accidentally drops either shim would land here
 * BEFORE the test suite goes red on flaky timeouts in CI.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SETUP_PATH = resolve(__dirname, '../setup.ts');

describe('T19.1 — test/setup.ts exists + imports vi from vitest', () => {
  it('test/setup.ts exists at the expected path', () => {
    expect(existsSync(SETUP_PATH)).toBe(true);
  });

  it('imports vi from vitest (single source of truth for fake timers)', () => {
    const src = readFileSync(SETUP_PATH, 'utf8');
    expect(src).toMatch(/import\s*{\s*vi\s*}\s*from\s*['"]vitest['"]/);
  });
});

describe('T19.1 — globalThis.jest shim for testing-library/dom waitFor', () => {
  const src = readFileSync(SETUP_PATH, 'utf8');

  it('assigns to `globalThis.jest` (testing-library detection target)', () => {
    // @testing-library/dom v10's jestFakeTimersAreEnabled reads
    // globalThis.jest; without this assignment the waitFor loop
    // polls real setInterval and times out under fake timers.
    expect(src).toMatch(/globalThis[^=]*\.jest\b[^=]*=/);
  });

  it('exposes advanceTimersByTime mapping to vi.advanceTimersByTime', () => {
    // The mapping is the load-bearing part: when testing-library
    // calls jest.advanceTimersByTime(N) to drive its polling loop,
    // the call must reach Vitest's fake-timer engine.
    expect(src).toMatch(/advanceTimersByTime:\s*\([^)]*\)\s*=>\s*vi\.advanceTimersByTime/);
  });

  it('exposes useFakeTimers + useRealTimers bound to vi', () => {
    expect(src).toMatch(/useFakeTimers:\s*vi\.useFakeTimers\.bind\s*\(\s*vi\s*\)/);
    expect(src).toMatch(/useRealTimers:\s*vi\.useRealTimers\.bind\s*\(\s*vi\s*\)/);
  });
});

describe('T19.1 — globalThis.vi shim for the T13 reprisal-log test', () => {
  const src = readFileSync(SETUP_PATH, 'utf8');

  it('exposes vi on globalThis (T13 reprisal-log uses bare vi.fn())', () => {
    // vitest.config.ts pins `globals: false`, so the `vi` symbol
    // isn't on the global by default. The T13 reprisal-log test
    // references `vi.fn()` without an explicit import per .context/
    // test-plan.md §6 (tests are read-only). The shim makes that
    // bare reference resolve.
    expect(src).toMatch(/globalThis[^=]*\.vi\b[^=]*=\s*vi\b/);
  });
});
