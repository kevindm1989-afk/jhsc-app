/**
 * T19.1 — session-jwt-store contract tests.
 *
 * Pins the production-source-of-truth posture for the current JWT:
 *   - Module-private storage; no DOM exposure.
 *   - get/set/clear round-trip.
 *   - Subscribers notified synchronously; throwing subscribers isolated.
 *   - `__resetForTest` zeros module state so tests stay hermetic.
 *
 * `__resetForTest` runs in `beforeEach` so module-level singleton state
 * doesn't leak between tests in this file (the module is intentionally
 * a process-singleton; the alternative — making every consumer
 * construct their own store — defeats the SSR-fallback fail-safe
 * documented in the source).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetForTest,
  clearJwt,
  getJwt,
  setJwt,
  subscribeToJwt
} from '../../src/lib/auth/session-jwt-store';

beforeEach(() => {
  __resetForTest();
});
afterEach(() => {
  __resetForTest();
});

describe('T19.1 — session-jwt-store', () => {
  it('getJwt() returns null on first read (unauthenticated default)', () => {
    expect(getJwt()).toBeNull();
  });

  it('setJwt(x) then getJwt() returns x', () => {
    setJwt('jwt-token-abc');
    expect(getJwt()).toBe('jwt-token-abc');
  });

  it('setJwt(null) clears the JWT', () => {
    setJwt('jwt-token-abc');
    setJwt(null);
    expect(getJwt()).toBeNull();
  });

  it('clearJwt() is equivalent to setJwt(null)', () => {
    setJwt('jwt-token-abc');
    clearJwt();
    expect(getJwt()).toBeNull();
  });

  it('subscribeToJwt notifies on set + clear with the new value', () => {
    const notified: Array<string | null> = [];
    subscribeToJwt((jwt) => notified.push(jwt));
    setJwt('first');
    setJwt('second');
    clearJwt();
    expect(notified).toEqual(['first', 'second', null]);
  });

  it('subscribeToJwt does NOT fire with the current value at subscribe time', () => {
    setJwt('already-set');
    const spy = vi.fn();
    subscribeToJwt(spy);
    expect(spy).not.toHaveBeenCalled();
  });

  it('the returned unsubscribe stops further notifications', () => {
    const spy = vi.fn();
    const unsubscribe = subscribeToJwt(spy);
    setJwt('first');
    unsubscribe();
    setJwt('second');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('first');
  });

  it('unsubscribe is idempotent (calling twice does not throw)', () => {
    const spy = vi.fn();
    const unsubscribe = subscribeToJwt(spy);
    expect(() => {
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
  });

  it('a throwing subscriber does NOT prevent other subscribers from being called', () => {
    const goodSpy = vi.fn();
    subscribeToJwt(() => {
      throw new Error('this listener is broken');
    });
    subscribeToJwt(goodSpy);
    expect(() => setJwt('x')).not.toThrow();
    expect(goodSpy).toHaveBeenCalledWith('x');
  });

  it('multiple subscribers each receive the same notification', () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    subscribeToJwt(a);
    subscribeToJwt(b);
    subscribeToJwt(c);
    setJwt('shared');
    expect(a).toHaveBeenCalledWith('shared');
    expect(b).toHaveBeenCalledWith('shared');
    expect(c).toHaveBeenCalledWith('shared');
  });
});
