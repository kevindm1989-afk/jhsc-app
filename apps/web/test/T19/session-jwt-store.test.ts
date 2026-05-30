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

// ---------------------------------------------------------------------------
// Cross-tab synchronization via BroadcastChannel
// ---------------------------------------------------------------------------

describe('T19.1 — session-jwt-store cross-tab synchronization (BroadcastChannel)', () => {
  // A minimal in-process BroadcastChannel mock that lets all instances
  // with the same `name` deliver messages to each other. Mimics the
  // browser's same-origin BroadcastChannel semantics for the test
  // surface — instantiations on the same "name" form a group; a
  // postMessage from one delivers to the others (but NOT to the
  // sender, per the spec).
  const channelsByName = new Map<string, Set<MockChannel>>();

  class MockChannel {
    name: string;
    onmessage: ((event: MessageEvent) => void) | null = null;
    private closed = false;
    constructor(name: string) {
      this.name = name;
      let group = channelsByName.get(name);
      if (!group) {
        group = new Set();
        channelsByName.set(name, group);
      }
      group.add(this);
    }
    postMessage(data: unknown): void {
      if (this.closed) return;
      const group = channelsByName.get(this.name);
      if (!group) return;
      for (const peer of group) {
        if (peer === this || peer.closed) continue;
        peer.onmessage?.({ data } as MessageEvent);
      }
    }
    close(): void {
      this.closed = true;
      channelsByName.get(this.name)?.delete(this);
    }
  }

  function installBroadcastChannelShim() {
    channelsByName.clear();
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel =
      MockChannel as unknown as typeof BroadcastChannel;
  }

  function removeBroadcastChannelShim() {
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    channelsByName.clear();
  }

  afterEach(() => {
    removeBroadcastChannelShim();
  });

  it('setJwt posts the new value to the jhsc-session-jwt BroadcastChannel', () => {
    installBroadcastChannelShim();
    // Establish a peer "tab" on the same channel BEFORE the store
    // instantiates its own — so the store's outbound post can reach it.
    const peer = new MockChannel('jhsc-session-jwt');
    const peerReceived: unknown[] = [];
    peer.onmessage = (event) => peerReceived.push(event.data);

    setJwt('tab-A-token');
    expect(peerReceived).toEqual([{ jwt: 'tab-A-token' }]);
  });

  it('clearJwt posts { jwt: null } to the channel', () => {
    installBroadcastChannelShim();
    const peer = new MockChannel('jhsc-session-jwt');
    const peerReceived: unknown[] = [];
    peer.onmessage = (event) => peerReceived.push(event.data);

    setJwt('first');
    clearJwt();
    expect(peerReceived).toEqual([{ jwt: 'first' }, { jwt: null }]);
  });

  it('an inbound message from a sibling tab applies LOCALLY (no re-broadcast → no ping-pong)', () => {
    installBroadcastChannelShim();
    // First subscribe — this ensures the store's channel is initialised
    // and listening for inbound messages.
    const spy = vi.fn();
    subscribeToJwt(spy);

    // Now a sibling "tab" posts a new JWT.
    const sibling = new MockChannel('jhsc-session-jwt');
    let siblingReceived = 0;
    sibling.onmessage = () => siblingReceived++;
    sibling.postMessage({ jwt: 'from-sibling' });

    // The store applied the value locally (subscriber + getJwt see it).
    expect(spy).toHaveBeenCalledWith('from-sibling');
    expect(getJwt()).toBe('from-sibling');

    // Crucially: the store did NOT re-broadcast. The sibling sees zero
    // inbound messages (the BroadcastChannel spec excludes the sender,
    // so the sibling would only see its own post if the store had
    // re-broadcast — which would cause the infinite ping-pong this
    // contract exists to prevent).
    expect(siblingReceived).toBe(0);
  });

  it('inbound messages with malformed shape are silently ignored (defensive)', () => {
    installBroadcastChannelShim();
    const spy = vi.fn();
    subscribeToJwt(spy);

    const sibling = new MockChannel('jhsc-session-jwt');
    // Foreign sender posts non-object / wrong-typed payloads.
    sibling.postMessage(null);
    sibling.postMessage('a plain string');
    sibling.postMessage({ jwt: 42 }); // wrong type for jwt
    sibling.postMessage({ jwt: { not: 'a string' } });

    expect(spy).not.toHaveBeenCalled();
    expect(getJwt()).toBeNull();
  });

  it('runtimes without BroadcastChannel (e.g. older browsers) fall back to per-tab posture (no throws)', () => {
    // Ensure the shim is NOT installed.
    removeBroadcastChannelShim();
    expect(typeof (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel).toBe(
      'undefined'
    );
    // setJwt + subscribe + clearJwt all still work; the in-memory
    // singleton is the only state.
    const spy = vi.fn();
    subscribeToJwt(spy);
    setJwt('local-only');
    expect(spy).toHaveBeenCalledWith('local-only');
    expect(getJwt()).toBe('local-only');
    clearJwt();
    expect(getJwt()).toBeNull();
  });

  it('a postMessage that throws does NOT prevent local apply (the local subscribers still fire)', () => {
    // Install a shim whose postMessage throws synchronously.
    class ThrowingChannel {
      name: string;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(name: string) {
        this.name = name;
      }
      postMessage(): never {
        throw new Error('channel unexpectedly closed');
      }
      close(): void {}
    }
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel =
      ThrowingChannel as unknown as typeof BroadcastChannel;

    const spy = vi.fn();
    subscribeToJwt(spy);
    expect(() => setJwt('despite-throw')).not.toThrow();
    expect(spy).toHaveBeenCalledWith('despite-throw');
    expect(getJwt()).toBe('despite-throw');
  });
});
