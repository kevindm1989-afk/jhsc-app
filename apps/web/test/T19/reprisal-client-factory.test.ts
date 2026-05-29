/**
 * T19.1 — production wiring helper for `SupabaseReprisalClient`
 * (reprisal-op Edge Function).
 *
 * The shared transport's deep semantics (URL composition, JWT
 * resolution, 401 → onSessionRevoked matrix, network → status 0,
 * non-JSON → body null) are already covered by
 * `edge-fn-fetch-transport.test.ts`. These tests pin the
 * reprisal-op-specific wiring: the URL targets `/functions/v1/reprisal-op`,
 * the SupabaseReprisalClient is constructed correctly over the transport,
 * and the F-39 `onSessionRevoked` option threads through.
 *
 * Hermetic: tests inject a stub `fetchImpl` that records the request
 * shape + returns canned responses. No real network.
 */

import { describe, expect, it, vi } from 'vitest';
import { createSupabaseReprisalClient } from '../../src/lib/server-client/reprisal-client-factory';
import { SupabaseReprisalClient } from '../../src/lib/reprisal/supabase-reprisal-client';

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

describe('T19.1 — createSupabaseReprisalClient', () => {
  it('returns a SupabaseReprisalClient instance', () => {
    const { fetchImpl } = stubFetch([]);
    const client = createSupabaseReprisalClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => null,
      fetchImpl
    });
    expect(client).toBeInstanceOf(SupabaseReprisalClient);
  });

  it('POSTs to ${baseUrl}/functions/v1/reprisal-op with the body as JSON', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { ok: true, data: [] } }]);
    const client = createSupabaseReprisalClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt-token-xyz',
      fetchImpl
    });
    const r = await client.listReprisalFeed();
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/reprisal-op');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer jwt-token-xyz');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ op: 'feed' });
  });

  it('strips trailing slashes from baseUrl', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { ok: true, data: [] } }]);
    const client = createSupabaseReprisalClient({
      baseUrl: 'https://demo.supabase.co////',
      getJwt: () => 'jwt-x',
      fetchImpl
    });
    await client.listReprisalFeed();
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/reprisal-op');
  });

  it('omits the Authorization header when getJwt() returns null', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 401, body: { ok: false, error: 'rls_denied' } }
    ]);
    const client = createSupabaseReprisalClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => null,
      fetchImpl
    });
    await client.listReprisalFeed();
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('fires onSessionRevoked when reprisal-op returns 401 (F-39 loop parity with t07/concern)', async () => {
    const { fetchImpl } = stubFetch([{ status: 401, body: { ok: false, error: 'rls_denied' } }]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseReprisalClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'stale-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await client.listReprisalFeed();
    expect(onSessionRevoked).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onSessionRevoked on 403 (RLS denied this op, session live)', async () => {
    const { fetchImpl } = stubFetch([{ status: 403, body: { ok: false, error: 'rls_denied' } }]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseReprisalClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'valid-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await client.listReprisalFeed();
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('surfaces a network error as { ok: false, reason: unknown, status: 0 }', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const client = createSupabaseReprisalClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt',
      fetchImpl
    });
    const r = await client.listReprisalFeed();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(0);
    expect(r.reason).toBe('unknown');
  });

  it('back-compat: works when onSessionRevoked is undefined', async () => {
    const { fetchImpl } = stubFetch([{ status: 401, body: { ok: false, error: 'rls_denied' } }]);
    const client = createSupabaseReprisalClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'stale-jwt',
      fetchImpl
    });
    const r = await client.listReprisalFeed();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(401);
  });
});
