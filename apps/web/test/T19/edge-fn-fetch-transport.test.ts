/**
 * T19.1 — shared Edge Function browser-fetch transport (extracted from
 * t07-client-factory.ts in this PR).
 *
 * The same transport semantics apply to every op-dispatch Edge Function
 * client (t07-op, concern-op, reprisal-op, t14-op, committee-op,
 * mint-session). This file is the canonical unit test of the shared
 * helper's behaviour; the existing `t07-client-factory.test.ts` still
 * exercises the full path end-to-end via `createSupabaseT07Client`.
 *
 * Hermetic: tests inject a stub `fetchImpl` that records the request
 * shape + returns canned responses. No real network.
 */

import { describe, expect, it, vi } from 'vitest';
import { createEdgeFnFetchTransport } from '../../src/lib/server-client/edge-fn-fetch-transport';

interface StubResponse {
  status: number;
  body: unknown;
  throwOnJson?: boolean;
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
      json: async () => {
        if (r.throwOnJson) throw new Error('not json');
        return r.body;
      }
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('T19.1 — createEdgeFnFetchTransport URL composition', () => {
  it('POSTs to ${baseUrl}/functions/v1/${opName} with the body as JSON', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { ok: true, data: null } }]);
    const transport = createEdgeFnFetchTransport({
      baseUrl: 'https://demo.supabase.co',
      opName: 'concern-op',
      getJwt: () => 'jwt-token-abc',
      fetchImpl
    });
    const r = await transport({ op: 'submit', x: 1 });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/concern-op');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer jwt-token-abc');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ op: 'submit', x: 1 });
  });

  it('strips trailing slashes from baseUrl so the endpoint stays canonical', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { ok: true, data: null } }]);
    const transport = createEdgeFnFetchTransport({
      baseUrl: 'https://demo.supabase.co////',
      opName: 'reprisal-op',
      getJwt: () => 'jwt-x',
      fetchImpl
    });
    await transport({ op: 'list' });
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/reprisal-op');
  });

  it('honors arbitrary opName values (t07-op, concern-op, t14-op, mint-session, etc.)', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { ok: true, data: null } },
      { status: 200, body: { ok: true, data: null } },
      { status: 200, body: { ok: true, data: null } }
    ]);
    for (const opName of ['t07-op', 't14-op', 'mint-session']) {
      const transport = createEdgeFnFetchTransport({
        baseUrl: 'https://demo.supabase.co',
        opName,
        getJwt: () => 'jwt-x',
        fetchImpl
      });
      await transport({ op: 'x' });
    }
    expect(calls.map((c) => c.url)).toEqual([
      'https://demo.supabase.co/functions/v1/t07-op',
      'https://demo.supabase.co/functions/v1/t14-op',
      'https://demo.supabase.co/functions/v1/mint-session'
    ]);
  });
});

describe('T19.1 — createEdgeFnFetchTransport JWT resolution', () => {
  it('omits the Authorization header when getJwt() returns null (unauthenticated)', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 401, body: { ok: false, error: 'rls_denied' } }]);
    const transport = createEdgeFnFetchTransport({
      baseUrl: 'https://demo.supabase.co',
      opName: 't07-op',
      getJwt: () => null,
      fetchImpl
    });
    await transport({ op: 'x' });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('awaits an async getJwt and reads it fresh per call', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { ok: true, data: null } },
      { status: 200, body: { ok: true, data: null } }
    ]);
    let token: string | null = null;
    const transport = createEdgeFnFetchTransport({
      baseUrl: 'https://demo.supabase.co',
      opName: 't07-op',
      getJwt: async () => token,
      fetchImpl
    });
    await transport({ op: 'x' });
    expect((calls[0]?.init.headers as Record<string, string>)['Authorization']).toBeUndefined();
    token = 'fresh-jwt';
    await transport({ op: 'x' });
    expect((calls[1]?.init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer fresh-jwt'
    );
  });

  it('surfaces a thrown getJwt() as null (does not crash the transport)', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 401, body: { ok: false, error: 'rls_denied' } }]);
    const transport = createEdgeFnFetchTransport({
      baseUrl: 'https://demo.supabase.co',
      opName: 't07-op',
      getJwt: () => {
        throw new Error('jwt provider blew up');
      },
      fetchImpl
    });
    const r = await transport({ op: 'x' });
    expect(r.status).toBe(401);
    expect((calls[0]?.init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });
});

describe('T19.1 — createEdgeFnFetchTransport response handling', () => {
  it('surfaces network errors as { status: 0, body: null }', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const transport = createEdgeFnFetchTransport({
      baseUrl: 'https://demo.supabase.co',
      opName: 't07-op',
      getJwt: () => 'jwt',
      fetchImpl
    });
    const r = await transport({ op: 'x' });
    expect(r.status).toBe(0);
    expect(r.body).toBe(null);
  });

  it('surfaces non-JSON / empty response bodies as { body: null } with the original status', async () => {
    const { fetchImpl } = stubFetch([{ status: 500, body: null, throwOnJson: true }]);
    const transport = createEdgeFnFetchTransport({
      baseUrl: 'https://demo.supabase.co',
      opName: 't07-op',
      getJwt: () => 'jwt',
      fetchImpl
    });
    const r = await transport({ op: 'x' });
    expect(r.status).toBe(500);
    expect(r.body).toBe(null);
  });
});

describe('T19.1 — createEdgeFnFetchTransport onSessionRevoked (F-39 loop)', () => {
  it('fires onSessionRevoked exactly on HTTP 401', async () => {
    const { fetchImpl } = stubFetch([{ status: 401, body: { ok: false, error: 'rls_denied' } }]);
    const onSessionRevoked = vi.fn();
    const transport = createEdgeFnFetchTransport({
      baseUrl: 'https://demo.supabase.co',
      opName: 't07-op',
      getJwt: () => 'stale-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await transport({ op: 'x' });
    expect(onSessionRevoked).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onSessionRevoked on 403 (RLS denied, session live)', async () => {
    const { fetchImpl } = stubFetch([{ status: 403, body: { ok: false, error: 'rls_denied' } }]);
    const onSessionRevoked = vi.fn();
    const transport = createEdgeFnFetchTransport({
      baseUrl: 'https://demo.supabase.co',
      opName: 't07-op',
      getJwt: () => 'valid-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await transport({ op: 'x' });
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('does NOT fire onSessionRevoked on 200', async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: { ok: true, data: null } }]);
    const onSessionRevoked = vi.fn();
    const transport = createEdgeFnFetchTransport({
      baseUrl: 'https://demo.supabase.co',
      opName: 't07-op',
      getJwt: () => 'jwt',
      fetchImpl,
      onSessionRevoked
    });
    await transport({ op: 'x' });
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('does NOT fire onSessionRevoked on network error (status 0 — not a server revocation signal)', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const onSessionRevoked = vi.fn();
    const transport = createEdgeFnFetchTransport({
      baseUrl: 'https://demo.supabase.co',
      opName: 't07-op',
      getJwt: () => 'jwt',
      fetchImpl,
      onSessionRevoked
    });
    await transport({ op: 'x' });
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('swallows a throwing onSessionRevoked — the caller still sees the 401', async () => {
    const { fetchImpl } = stubFetch([{ status: 401, body: { ok: false, error: 'rls_denied' } }]);
    const onSessionRevoked = vi.fn(() => {
      throw new Error('clearJwt blew up');
    });
    const transport = createEdgeFnFetchTransport({
      baseUrl: 'https://demo.supabase.co',
      opName: 't07-op',
      getJwt: () => 'stale-jwt',
      fetchImpl,
      onSessionRevoked
    });
    const r = await transport({ op: 'x' });
    expect(onSessionRevoked).toHaveBeenCalledTimes(1);
    expect(r.status).toBe(401);
  });

  it('back-compat: works when onSessionRevoked is undefined (401 surfaces unchanged)', async () => {
    const { fetchImpl } = stubFetch([{ status: 401, body: { ok: false, error: 'rls_denied' } }]);
    const transport = createEdgeFnFetchTransport({
      baseUrl: 'https://demo.supabase.co',
      opName: 't07-op',
      getJwt: () => 'stale-jwt',
      fetchImpl
    });
    const r = await transport({ op: 'x' });
    expect(r.status).toBe(401);
  });
});
