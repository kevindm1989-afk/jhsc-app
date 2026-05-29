/**
 * T19.1 — production wiring helper for `SupabaseConcernClient`
 * (concern-op Edge Function).
 *
 * Most of the transport semantics (URL composition, JWT resolution,
 * 401 → onSessionRevoked, network → status 0, non-JSON → body null)
 * are already covered by `edge-fn-fetch-transport.test.ts` since this
 * factory delegates to the shared helper. These tests pin the
 * concern-op-specific wiring: the URL targets `/functions/v1/concern-op`,
 * the SupabaseConcernClient is constructed correctly over the transport,
 * and the F-39 `onSessionRevoked` option threads through.
 *
 * Hermetic: tests inject a stub `fetchImpl` that records the request
 * shape + returns canned responses. No real network.
 */

import { describe, expect, it, vi } from 'vitest';
import { createSupabaseConcernClient } from '../../src/lib/server-client/concern-client-factory';
import { SupabaseConcernClient } from '../../src/lib/concerns/supabase-concern-client';

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

describe('T19.1 — createSupabaseConcernClient', () => {
  it('returns a SupabaseConcernClient instance', () => {
    const { fetchImpl } = stubFetch([]);
    const client = createSupabaseConcernClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => null,
      fetchImpl
    });
    expect(client).toBeInstanceOf(SupabaseConcernClient);
  });

  it('POSTs to ${baseUrl}/functions/v1/concern-op with the body as JSON', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { ok: true, data: [] } }]);
    const client = createSupabaseConcernClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt-token-xyz',
      fetchImpl
    });
    const r = await client.listConcerns();
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/concern-op');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer jwt-token-xyz');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ op: 'list' });
  });

  it('strips trailing slashes from baseUrl', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { ok: true, data: [] } }]);
    const client = createSupabaseConcernClient({
      baseUrl: 'https://demo.supabase.co////',
      getJwt: () => 'jwt-x',
      fetchImpl
    });
    await client.listConcerns();
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/concern-op');
  });

  it('omits the Authorization header when getJwt() returns null', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 401, body: { ok: false, error: 'rls_denied' } }]);
    const client = createSupabaseConcernClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => null,
      fetchImpl
    });
    await client.listConcerns();
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('fires onSessionRevoked when concern-op returns 401 (F-39 loop parity with t07)', async () => {
    const { fetchImpl } = stubFetch([{ status: 401, body: { ok: false, error: 'rls_denied' } }]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseConcernClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'stale-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await client.listConcerns();
    expect(onSessionRevoked).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onSessionRevoked on 403 (RLS denied this op, session live)', async () => {
    const { fetchImpl } = stubFetch([{ status: 403, body: { ok: false, error: 'rls_denied' } }]);
    const onSessionRevoked = vi.fn();
    const client = createSupabaseConcernClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'valid-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await client.listConcerns();
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('surfaces a network error as { ok: false, reason: unknown, status: 0 }', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const client = createSupabaseConcernClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt',
      fetchImpl
    });
    const r = await client.listConcerns();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(0);
    expect(r.reason).toBe('unknown');
  });

  it('back-compat: works when onSessionRevoked is undefined', async () => {
    const { fetchImpl } = stubFetch([{ status: 401, body: { ok: false, error: 'rls_denied' } }]);
    const client = createSupabaseConcernClient({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'stale-jwt',
      fetchImpl
    });
    const r = await client.listConcerns();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(401);
  });
});
