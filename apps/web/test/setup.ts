/**
 * Vitest global setup.
 *
 * Bridges Vitest fake timers to @testing-library/dom's `waitFor` polling
 * loop, which detects fake timers via the global `jest` object (see
 * @testing-library/dom/dist/helpers.js `jestFakeTimersAreEnabled`).
 *
 * Without this shim, `waitFor` polls via the real (already-replaced)
 * `setInterval` and times out. With the shim it correctly drives
 * `vi.advanceTimersByTime(interval)` between checks.
 *
 * Source obligations:
 *   - apps/web/test/_helpers/clock.ts (the project's `freezeClock()`
 *     helper uses `vi.useFakeTimers()`).
 *   - testing-library/dom v10 fake-timer integration assumes Jest.
 *     Vitest is API-compatible — the shim aliases `jest.advanceTimersByTime`
 *     to `vi.advanceTimersByTime` and exposes the marker attribute on
 *     `setTimeout` that the detection function reads.
 *   - This is a TEST-ONLY shim. It runs before every test file and only
 *     affects globalThis inside the test runner process.
 */

import { vi } from 'vitest';

// The test-runner's `setTimeout` is whatever vitest's fake-timers swaps
// in when `vi.useFakeTimers()` is active. We don't intercept it; we
// just expose `globalThis.jest` with the API surface that
// `jestFakeTimersAreEnabled` reads.
(globalThis as { jest?: unknown }).jest = {
  advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms),
  // The detection function tests for either `_isMockFunction` or
  // `clock` on `setTimeout`. Vitest's fake `setTimeout` carries the
  // `clock` property; the real `setTimeout` does not. So this branch
  // works as long as `vi.useFakeTimers()` is active when `waitFor` runs.
  useFakeTimers: vi.useFakeTimers.bind(vi),
  useRealTimers: vi.useRealTimers.bind(vi)
};

// jsdom does not implement Blob URL APIs. CsvDownloadButton's click
// handler calls URL.createObjectURL(blob) to materialise a download — in
// jsdom this would throw. We stub both halves with no-ops so the click
// path can complete without affecting the assertion surface (no test
// asserts against the returned URL string).
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:test-stub';
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => {};
}
