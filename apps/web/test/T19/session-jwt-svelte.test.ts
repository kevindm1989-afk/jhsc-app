/**
 * T19.1 — Svelte readable-store wrappers over session-jwt-store.
 *
 * The Svelte readable contract isn't trivial: subscribers receive an
 * initial value synchronously, then update on each call to `set` in the
 * start function's body or via the unsubscribe-returning subscriber.
 *
 * These tests pin:
 *   - the initial value seen on subscribe matches the underlying
 *     session-jwt-store (no `null` flash for a returning user)
 *   - updates from `setJwt`/`clearJwt` propagate
 *   - the unsubscribe handle (returned by the store's subscribe) detaches
 *     the listener from the underlying session-jwt-store (no leak)
 *   - `isSignedIn` derives correctly from the JWT presence
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetForTest,
  clearJwt,
  setJwt
} from '../../src/lib/auth/session-jwt-store';
import { isSignedIn, jwt } from '../../src/lib/auth/session-jwt-svelte';

beforeEach(() => {
  __resetForTest();
});
afterEach(() => {
  __resetForTest();
});

describe('T19.1 — session-jwt-svelte jwt store', () => {
  it('synchronously emits the current JWT (null) on subscribe', () => {
    const spy = vi.fn();
    const unsubscribe = jwt.subscribe(spy);
    expect(spy).toHaveBeenCalledWith(null);
    unsubscribe();
  });

  it('synchronously emits an existing JWT on subscribe (returning-user posture)', () => {
    setJwt('returning-user-jwt');
    const spy = vi.fn();
    const unsubscribe = jwt.subscribe(spy);
    expect(spy).toHaveBeenCalledWith('returning-user-jwt');
    unsubscribe();
  });

  it('propagates setJwt / clearJwt updates to subscribers', () => {
    const seen: Array<string | null> = [];
    const unsubscribe = jwt.subscribe((v) => seen.push(v));
    // First seen[0] is the initial null.
    setJwt('first');
    setJwt('second');
    clearJwt();
    expect(seen).toEqual([null, 'first', 'second', null]);
    unsubscribe();
  });

  it('the unsubscribe handle detaches from the underlying store (no leak)', () => {
    const seen: Array<string | null> = [];
    const unsubscribe = jwt.subscribe((v) => seen.push(v));
    setJwt('captured');
    unsubscribe();
    setJwt('after-unsubscribe');
    // 'after-unsubscribe' must NOT appear.
    expect(seen).toEqual([null, 'captured']);
  });

  it('multiple subscribers each receive the same notifications', () => {
    const a: Array<string | null> = [];
    const b: Array<string | null> = [];
    const ua = jwt.subscribe((v) => a.push(v));
    const ub = jwt.subscribe((v) => b.push(v));
    setJwt('shared');
    expect(a).toEqual([null, 'shared']);
    expect(b).toEqual([null, 'shared']);
    ua();
    ub();
  });
});

describe('T19.1 — session-jwt-svelte isSignedIn store', () => {
  it('synchronously emits false on subscribe when no JWT is set', () => {
    const spy = vi.fn();
    const unsubscribe = isSignedIn.subscribe(spy);
    expect(spy).toHaveBeenCalledWith(false);
    unsubscribe();
  });

  it('synchronously emits true on subscribe when a JWT is already set (returning-user posture)', () => {
    setJwt('existing-token');
    const spy = vi.fn();
    const unsubscribe = isSignedIn.subscribe(spy);
    expect(spy).toHaveBeenCalledWith(true);
    unsubscribe();
  });

  it('flips to true on setJwt, false on clearJwt', () => {
    const seen: boolean[] = [];
    const unsubscribe = isSignedIn.subscribe((v) => seen.push(v));
    setJwt('x');
    setJwt('y'); // still signed in — same boolean value but Svelte may de-dupe; we don't assert that
    clearJwt();
    // Permissive on the middle: Svelte's readable may or may not emit
    // when the value is unchanged. The terminal transitions matter.
    expect(seen[0]).toBe(false);
    expect(seen).toContain(true);
    expect(seen[seen.length - 1]).toBe(false);
    unsubscribe();
  });

  it('the unsubscribe handle detaches from the underlying store (no leak)', () => {
    const seen: boolean[] = [];
    const unsubscribe = isSignedIn.subscribe((v) => seen.push(v));
    setJwt('captured');
    unsubscribe();
    setJwt('after-unsubscribe');
    clearJwt();
    // No transitions after unsubscribe should appear. The recorded
    // history must remain `[false, true]`.
    expect(seen).toEqual([false, true]);
  });
});
