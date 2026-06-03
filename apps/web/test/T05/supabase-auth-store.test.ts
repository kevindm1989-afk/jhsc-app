/**
 * T05.1 / G-T05-1 staged-rollout scaffold — SupabaseAuthStore.
 *
 * The first sliver of the T05.1 production wire-up. This file pins:
 *
 *   - SupabaseAuthStore implements the full AuthStore interface
 *     (structural-type pin so a future drift in either side is caught
 *     at typecheck time).
 *   - getUser is wired end-to-end against a fake transport: emits the
 *     correct op-dispatch body, parses the success response into a
 *     UserRow, and degrades to `null` on the documented failure modes
 *     (404, network error, malformed body).
 *   - Every other AuthStore method throws
 *     SupabaseAuthStoreNotImplementedError carrying the op name —
 *     callers see CLEARLY which op needs landing.
 */

import { describe, expect, it } from 'vitest';
import type { AuthStore, UserRow } from '../../src/lib/auth/store';
import {
  SupabaseAuthStore,
  SupabaseAuthStoreNotImplementedError,
  type AuthOpTransport
} from '../../src/lib/auth/supabase-auth-store';

function captureTransport(
  status: number,
  body: unknown
): { transport: AuthOpTransport; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const transport: AuthOpTransport = async (b) => {
    calls.push(b);
    return { status, body };
  };
  return { transport, calls };
}

describe('T05.1 / G-T05-1 — SupabaseAuthStore structural pins', () => {
  it('is constructable from a transport closure', () => {
    const { transport } = captureTransport(200, { ok: true, data: null });
    const store = new SupabaseAuthStore({ transport });
    expect(store).toBeInstanceOf(SupabaseAuthStore);
  });

  it('implements AuthStore (type-check pin — drift in either side breaks here)', () => {
    const { transport } = captureTransport(200, { ok: true, data: null });
    // The annotation is the load-bearing check; if SupabaseAuthStore
    // and AuthStore drift, tsc fails this assignment.
    const store: AuthStore = new SupabaseAuthStore({ transport });
    expect(store).toBeDefined();
  });
});

describe('T05.1 / G-T05-1 — SupabaseAuthStore.getUser (the one wired op)', () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const row: UserRow = {
    id: userId,
    totp_destroyed_at: 1_700_000_000_000,
    role: 'authenticated',
    active: true
  };

  it('emits the canonical op-dispatch body { op: "get_user", user_id }', async () => {
    const { transport, calls } = captureTransport(200, { ok: true, data: row });
    const store = new SupabaseAuthStore({ transport });
    await store.getUser(userId);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ op: 'get_user', user_id: userId });
  });

  it('returns the UserRow on a 200 { ok: true, data: row } response', async () => {
    const { transport } = captureTransport(200, { ok: true, data: row });
    const store = new SupabaseAuthStore({ transport });
    const out = await store.getUser(userId);
    expect(out).toEqual(row);
  });

  it('returns null on a 404 not_found response', async () => {
    const { transport } = captureTransport(404, { ok: false, reason: 'not_found' });
    const store = new SupabaseAuthStore({ transport });
    const out = await store.getUser('99999999-0000-4000-8000-000000000000');
    expect(out).toBeNull();
  });

  it('returns null on a network error (transport returns { status: 0, body: null })', async () => {
    // Mirrors the createEdgeFnFetchTransport contract: status 0 is
    // the "network error / offline" surface.
    const { transport } = captureTransport(0, null);
    const store = new SupabaseAuthStore({ transport });
    const out = await store.getUser(userId);
    expect(out).toBeNull();
  });

  it('returns null on a malformed body (missing data / ok=false on 200)', async () => {
    const { transport } = captureTransport(200, { ok: false, reason: 'unknown' });
    const store = new SupabaseAuthStore({ transport });
    const out = await store.getUser(userId);
    expect(out).toBeNull();
  });
});

describe('T05.1 / G-T05-1 — SupabaseAuthStoreNotImplementedError on deferred methods', () => {
  const { transport } = captureTransport(200, { ok: true, data: null });
  const store = new SupabaseAuthStore({ transport });

  // Single helper: every deferred method MUST throw the structured
  // error carrying its op name. The fan-out below is one test per
  // method so a failure pinpoints the regressed op rather than the
  // whole suite.

  it('ensureUser throws', () => {
    expect(() => store.ensureUser('x')).toThrow(SupabaseAuthStoreNotImplementedError);
    try {
      store.ensureUser('x');
    } catch (err) {
      expect((err as SupabaseAuthStoreNotImplementedError).op).toBe('ensureUser');
    }
  });

  it('issueTotpBootstrap throws', () => {
    expect(() => store.issueTotpBootstrap('x')).toThrow(SupabaseAuthStoreNotImplementedError);
  });

  it('getTotpBootstrap throws', () => {
    expect(() => store.getTotpBootstrap('x')).toThrow(SupabaseAuthStoreNotImplementedError);
  });

  it('wasTotpCodeConsumed throws', () => {
    expect(() => store.wasTotpCodeConsumed('x', 'y')).toThrow(
      SupabaseAuthStoreNotImplementedError
    );
  });

  it('recordTotpWrong throws', () => {
    expect(() => store.recordTotpWrong('x')).toThrow(SupabaseAuthStoreNotImplementedError);
  });

  it('lockTotpBootstrap throws', () => {
    expect(() => store.lockTotpBootstrap('x')).toThrow(SupabaseAuthStoreNotImplementedError);
  });

  it('consumeTotpAndEnrollPasskey throws', () => {
    expect(() =>
      store.consumeTotpAndEnrollPasskey({
        user_id: 'x',
        totp_code: 'y',
        credential: {} as never,
        now: 0
      })
    ).toThrow(SupabaseAuthStoreNotImplementedError);
  });

  it('getCredential throws', () => {
    expect(() => store.getCredential('x')).toThrow(SupabaseAuthStoreNotImplementedError);
  });

  it('listCredentialsForUser throws', () => {
    expect(() => store.listCredentialsForUser('x')).toThrow(SupabaseAuthStoreNotImplementedError);
  });

  it('saveCredential throws', () => {
    expect(() => store.saveCredential({} as never)).toThrow(SupabaseAuthStoreNotImplementedError);
  });

  it('deleteCredential throws', () => {
    expect(() => store.deleteCredential('x')).toThrow(SupabaseAuthStoreNotImplementedError);
  });

  it('createSession throws', () => {
    expect(() =>
      store.createSession({ user_id: 'x', now: 0, ttl_ms: 1000 })
    ).toThrow(SupabaseAuthStoreNotImplementedError);
  });

  it('getSession throws', () => {
    expect(() => store.getSession('x')).toThrow(SupabaseAuthStoreNotImplementedError);
  });

  it('listActiveSessions throws', () => {
    expect(() => store.listActiveSessions('x')).toThrow(SupabaseAuthStoreNotImplementedError);
  });

  it('revokeSession throws', () => {
    expect(() => store.revokeSession('x', 0)).toThrow(SupabaseAuthStoreNotImplementedError);
  });

  it('revokeAllForUser throws', () => {
    expect(() => store.revokeAllForUser('x', 0)).toThrow(SupabaseAuthStoreNotImplementedError);
  });

  it('emitAudit throws', () => {
    expect(() =>
      store.emitAudit({
        event_type: 'auth.test',
        actor_pseudonym: 'p',
        target_class: 'C0',
        severity: 'info',
        meta: {}
      })
    ).toThrow(SupabaseAuthStoreNotImplementedError);
  });

  it('pseudonymOf throws (browser MUST NOT compute the HMAC pseudonym)', () => {
    // Defense pin: returning the raw uid would silently break C2
    // pseudonymity. The throw is the load-bearing behaviour.
    expect(() => store.pseudonymOf('x')).toThrow(SupabaseAuthStoreNotImplementedError);
  });
});
