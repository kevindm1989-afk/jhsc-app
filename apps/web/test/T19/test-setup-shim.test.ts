/**
 * T19.1 — `apps/web/test/setup.ts` jest-shim pin.
 *
 * `test/setup.ts` is wired by `vitest.config.ts`'s
 * `setupFiles: ['./test/setup.ts']` (pinned by vitest-config.test.ts),
 * so the FILE's existence is implicitly load-bearing — vitest would
 * fail at runtime with a missing-file error if it disappeared.
 *
 * What's NOT pinned is the file's CONTENT. The shim it installs is
 * load-bearing for the testing-library/dom timer-detection contract:
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
 * A refactor that accidentally drops the jest-shim would land here
 * BEFORE the test suite goes red on flaky timeouts in CI.
 *
 * G-T13-12 history: setup.ts also briefly exposed `globalThis.vi` so
 * the T13 reprisal-log test's bare `vi.fn()` would resolve under
 * `globals: false`. That shim was removed (G-T13-12 closure); the
 * test now imports `vi` explicitly from `'vitest'`. The convention
 * pin lives in the second describe block below.
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
    // Match any named-import shape that includes `vi` from 'vitest' — bare
    // `{ vi }`, or alongside other vitest symbols like `{ afterEach, vi }`.
    expect(src).toMatch(/import\s*\{[^}]*\bvi\b[^}]*\}\s*from\s*['"]vitest['"]/);
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

describe('T19.1 — T13 reprisal-log vi import convention (G-T13-12 closure)', () => {
  const src = readFileSync(SETUP_PATH, 'utf8');

  it('does NOT expose vi on globalThis (the G-T13-12 shim was removed in favour of explicit import)', () => {
    // vitest.config.ts pins `globals: false`. G-T13-12 originally
    // landed a `(globalThis as ...).vi = vi` shim so the T13
    // reprisal-log test's bare `vi.fn()` would resolve. The closure
    // pass removed the shim AND added `vi` to the explicit
    // `'vitest'` import in apps/web/test/T13/reprisal-log.test.ts.
    // The repo convention is now "explicit import per test file"
    // and matches every other test in the suite. This pin guards
    // against the shim returning silently.
    expect(src).not.toMatch(/globalThis[^=]*\.vi\b[^=]*=\s*vi\b/);
  });

  it('the T13 reprisal-log test imports vi explicitly from vitest', () => {
    const t13src = readFileSync(resolve(__dirname, '../T13/reprisal-log.test.ts'), 'utf8');
    // Match: `import { ..., vi, ... } from 'vitest'` — the bare-vi
    // line at :464 of the test is now resolved by the import, not
    // the globalThis shim.
    expect(t13src).toMatch(/import\s*\{[^}]*\bvi\b[^}]*\}\s*from\s*['"]vitest['"]/);
  });
});
