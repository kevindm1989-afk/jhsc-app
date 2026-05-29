/**
 * T19.1 — production wiring helpers (T19.1 follow-up to PRs #34 / #36).
 *
 * Covers `createSupabaseT07Client` (fetch-based transport) and
 * `createPanicWipeAuditEmitter` (the SupabaseT07Client ↔
 * BrowserWipeStore adapter shim).
 *
 * Hermetic: tests inject a stub `fetchImpl` that records the request
 * shape + returns canned responses. No real network.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createPanicWipeAuditEmitter,
  createSupabaseT07Client
} from '../../src/lib/server-client/t07-client-factory';

// ---------------------------------------------------------------------------
// createSupabaseT07Client
// ---------------------------------------------------------------------------

interface StubResponse {
  status: number;
  body: unknown;
}

function stubFetch(responses: StubResponse[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: typeof url === 'string' ? url : url.toString(), init: init ?? {} });
    const r = responses[i++];
    if (!r) throw new Error('no response queued');
    return {
      status: r.status,
      json: async () => r.body
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('T19.1 — createSupabaseT07Client', () => {
  it('POSTs to ${baseUrl}/functions/v1/t07-op with the body as JSON', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { ok: true, data: { key_id: 'k-1', epoch: 1 } } }
    ]);
    const client = createSupabaseT07Client({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt-token-abc',
      fetchImpl
    });
    const r = await client.initCommitteeDataKey();
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/t07-op');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer jwt-token-abc');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ op: 'init_key' });
  });

  it('strips trailing slashes from baseUrl so the endpoint stays canonical', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { ok: true, data: null } }
    ]);
    const client = createSupabaseT07Client({
      baseUrl: 'https://demo.supabase.co////',
      getJwt: () => 'jwt-x',
      fetchImpl
    });
    await client.recordIdentitySelftestFail();
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/t07-op');
  });

  it('omits the Authorization header when getJwt() returns null (unauthenticated)', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 401, body: { ok: false, error: 'rls_denied' } }
    ]);
    const client = createSupabaseT07Client({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => null,
      fetchImpl
    });
    const r = await client.recordIdentitySelftestFail();
    expect(r.ok).toBe(false);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('awaits an async getJwt and reads it fresh per call (post-sign-in JWT picked up without reconstruction)', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { ok: true, data: null } },
      { status: 200, body: { ok: true, data: null } }
    ]);
    let token: string | null = null;
    const client = createSupabaseT07Client({
      baseUrl: 'https://demo.supabase.co',
      getJwt: async () => token,
      fetchImpl
    });
    await client.recordIdentitySelftestFail();
    expect((calls[0]?.init.headers as Record<string, string>)['Authorization']).toBeUndefined();
    // User signs in mid-session.
    token = 'fresh-jwt';
    await client.recordIdentitySelftestFail();
    expect((calls[1]?.init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer fresh-jwt'
    );
  });

  it('surfaces a thrown getJwt() as null (does not crash the transport)', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 401, body: { ok: false, error: 'rls_denied' } }
    ]);
    const client = createSupabaseT07Client({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => {
        throw new Error('jwt provider blew up');
      },
      fetchImpl
    });
    const r = await client.recordIdentitySelftestFail();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('rls_denied');
    expect((calls[0]?.init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('surfaces a network error as { status: 0, reason: unknown } (offline / DNS failure)', async () => {
    const fetchImpl = (async () => {
      throw new Error('network offline');
    }) as unknown as typeof fetch;
    const client = createSupabaseT07Client({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt-token',
      fetchImpl
    });
    const r = await client.recordIdentitySelftestFail();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(0);
    expect(r.reason).toBe('unknown');
  });

  it('surfaces non-JSON / empty response bodies as { ok: false, reason: unknown }', async () => {
    const fetchImpl = (async () => {
      return {
        status: 500,
        json: async () => {
          throw new Error('not json');
        }
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = createSupabaseT07Client({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt-token',
      fetchImpl
    });
    const r = await client.recordIdentitySelftestFail();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(500);
    expect(r.reason).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// onSessionRevoked — F-39 / session-jwt-store contract closure
// ---------------------------------------------------------------------------

describe('T19.1 — createSupabaseT07Client onSessionRevoked (401 → clearJwt loop)', () => {
  it('fires onSessionRevoked when the server returns 401 (session_is_live gate denied)', async () => {
    const { fetchImpl } = stubFetch([{ status: 401, body: { ok: false, error: 'rls_denied' } }]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseT07Client({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'stale-jwt',
      fetchImpl,
      onSessionRevoked
    });
    const r = await client.recordIdentitySelftestFail();
    expect(r.ok).toBe(false);
    expect(onSessionRevoked).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onSessionRevoked on 403 (session live, RLS denies this op)', async () => {
    const { fetchImpl } = stubFetch([{ status: 403, body: { ok: false, error: 'rls_denied' } }]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseT07Client({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'valid-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await client.recordIdentitySelftestFail();
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('does NOT fire onSessionRevoked on 200 success', async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: { ok: true, data: null } }]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseT07Client({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'valid-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await client.recordIdentitySelftestFail();
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('does NOT fire onSessionRevoked on a network error (status 0 — not a server revocation signal)', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const onSessionRevoked = vi.fn();
    const client = createSupabaseT07Client({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'valid-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await client.recordIdentitySelftestFail();
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('does NOT fire onSessionRevoked on 500 / other server errors (only 401)', async () => {
    const { fetchImpl } = stubFetch([{ status: 500, body: { ok: false, error: 'unknown' } }]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseT07Client({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'valid-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await client.recordIdentitySelftestFail();
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('swallows a throwing onSessionRevoked — the caller still sees the 401', async () => {
    const { fetchImpl } = stubFetch([{ status: 401, body: { ok: false, error: 'rls_denied' } }]);
    const onSessionRevoked = vi.fn(() => {
      throw new Error('clearJwt blew up');
    });
    const client = createSupabaseT07Client({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'stale-jwt',
      fetchImpl,
      onSessionRevoked
    });
    const r = await client.recordIdentitySelftestFail();
    expect(onSessionRevoked).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(401);
    expect(r.reason).toBe('rls_denied');
  });

  it('fires onSessionRevoked once per 401 call (not deduplicated across calls)', async () => {
    const { fetchImpl } = stubFetch([
      { status: 401, body: { ok: false, error: 'rls_denied' } },
      { status: 401, body: { ok: false, error: 'rls_denied' } }
    ]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseT07Client({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'stale-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await client.recordIdentitySelftestFail();
    await client.recordIdentitySelftestFail();
    expect(onSessionRevoked).toHaveBeenCalledTimes(2);
  });

  it('works when onSessionRevoked is undefined (back-compat: 401 still surfaces)', async () => {
    const { fetchImpl } = stubFetch([{ status: 401, body: { ok: false, error: 'rls_denied' } }]);
    const client = createSupabaseT07Client({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'stale-jwt',
      fetchImpl
    });
    const r = await client.recordIdentitySelftestFail();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// createPanicWipeAuditEmitter
// ---------------------------------------------------------------------------

describe('T19.1 — createPanicWipeAuditEmitter (BrowserWipeStore adapter)', () => {
  it('forwards meta to client.recordPanicWipeInvoked + collapses T07OpResult → { ok: boolean }', async () => {
    const spy = vi.fn(async () => ({ ok: true as const, data: null }));
    const fakeClient = { recordPanicWipeInvoked: spy } as unknown as Parameters<
      typeof createPanicWipeAuditEmitter
    >[0];
    const emitter = createPanicWipeAuditEmitter(fakeClient);
    const meta = { surface: 'settings', wipe_scope: 'local_only', completed: true };
    const r = await emitter.recordPanicWipeInvoked({ meta });
    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith({ meta });
  });

  it('returns { ok: false } when the client returns { ok: false }', async () => {
    const spy = vi.fn(async () => ({
      ok: false as const,
      reason: 'rls_denied' as const,
      status: 403
    }));
    const fakeClient = { recordPanicWipeInvoked: spy } as unknown as Parameters<
      typeof createPanicWipeAuditEmitter
    >[0];
    const emitter = createPanicWipeAuditEmitter(fakeClient);
    const r = await emitter.recordPanicWipeInvoked({ meta: {} });
    expect(r.ok).toBe(false);
  });

  it('lets thrown errors bubble (BrowserWipeStore.emitAudit catches them → fail-closed)', async () => {
    const fakeClient = {
      async recordPanicWipeInvoked() {
        throw new Error('network');
      }
    } as unknown as Parameters<typeof createPanicWipeAuditEmitter>[0];
    const emitter = createPanicWipeAuditEmitter(fakeClient);
    await expect(emitter.recordPanicWipeInvoked({ meta: {} })).rejects.toThrow(/network/);
  });
});
