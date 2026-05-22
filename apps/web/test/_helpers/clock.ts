/**
 * Deterministic clock helpers.
 *
 * Per the test-writer determinism rules: NO real clock in tests.
 * All time-bearing tests pin Date.now() to FROZEN_NOW_MS unless they
 * explicitly advance via `advanceTo` / `advanceBy`.
 *
 * Tests verify behavior across edge-of-day, DST switch, leap day where
 * relevant. The fixtures expose constants for these edges:
 *   - DST_SWITCH_SPRING_2026_ET  (2026-03-08 02:00 EST → 03:00 EDT)
 *   - DST_SWITCH_FALL_2026_ET    (2026-11-01 02:00 EDT → 01:00 EST)
 *   - LEAP_DAY_2028              (2028-02-29 12:00 UTC)
 *   - END_OF_DAY_UTC             (2026-05-22 23:59:59.999 UTC)
 */

import { vi } from 'vitest';
import { FROZEN_NOW_MS } from './fixtures';

export const DST_SWITCH_SPRING_2026_ET = Date.parse('2026-03-08T07:00:00.000Z'); // 02:00 ET → 03:00 EDT
export const DST_SWITCH_FALL_2026_ET = Date.parse('2026-11-01T06:00:00.000Z');
export const LEAP_DAY_2028 = Date.parse('2028-02-29T12:00:00.000Z');
export const END_OF_DAY_UTC = Date.parse('2026-05-22T23:59:59.999Z');

export function freezeClock(at: number = FROZEN_NOW_MS): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
}

export function advanceBy(ms: number): void {
  vi.advanceTimersByTime(ms);
}

export function advanceTo(at: number): void {
  vi.setSystemTime(new Date(at));
}

export function restoreClock(): void {
  vi.useRealTimers();
}
