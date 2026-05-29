/**
 * T19.1 — production wiring helper for the t14-op client pair
 * (`SupabaseWorkRefusalClient` for s.43, `SupabaseS51EvidenceClient`
 * for s.51 critical-injury).
 *
 * Unlike concern / reprisal, t14-op dispatches TWO domains (s.43 work
 * refusal + s.51 evidence). The factory returns both clients over a
 * single shared transport — these tests pin both that the pair is
 * constructed correctly AND that both clients route to /functions/v1/
 * t14-op via the same Authorization header. The shared transport's
 * deep semantics remain covered by `edge-fn-fetch-transport.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import { createSupabaseT14Clients } from '../../src/lib/server-client/t14-client-factory';
import {
  SupabaseS51EvidenceClient,
  SupabaseWorkRefusalClient
} from '../../src/lib/work-refusal/supabase-t14-client';

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

const TINY = new Uint8Array([0x01, 0x02, 0x03]);

describe('T19.1 — createSupabaseT14Clients (client pair)', () => {
  it('returns both SupabaseWorkRefusalClient + SupabaseS51EvidenceClient instances', () => {
    const { fetchImpl } = stubFetch([]);
    const pair = createSupabaseT14Clients({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => null,
      fetchImpl
    });
    expect(pair.workRefusal).toBeInstanceOf(SupabaseWorkRefusalClient);
    expect(pair.s51Evidence).toBeInstanceOf(SupabaseS51EvidenceClient);
  });

  it('both clients route to ${baseUrl}/functions/v1/t14-op (single transport)', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { ok: true, data: { id: 'wr-1' } } },
      { status: 200, body: { ok: true, data: { id: 's51-1' } } }
    ]);
    const pair = createSupabaseT14Clients({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt-token-shared',
      fetchImpl
    });
    await pair.workRefusal.submitWorkRefusal({ title_ct: TINY, notes_ct: TINY });
    await pair.s51Evidence.submitS51Evidence({ title_ct: TINY, notes_ct: TINY, photos: [] });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/t14-op');
    expect(calls[1]?.url).toBe('https://demo.supabase.co/functions/v1/t14-op');
    // Both calls carry the same Authorization header — proves they
    // share one transport (not two independent factories).
    expect((calls[0]?.init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer jwt-token-shared'
    );
    expect((calls[1]?.init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer jwt-token-shared'
    );
    expect(JSON.parse(calls[0]?.init.body as string).op).toBe('wr_submit');
    expect(JSON.parse(calls[1]?.init.body as string).op).toBe('s51_submit');
  });

  it('strips trailing slashes from baseUrl', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { ok: true, data: { id: 'wr-1' } } }
    ]);
    const pair = createSupabaseT14Clients({
      baseUrl: 'https://demo.supabase.co////',
      getJwt: () => 'jwt-x',
      fetchImpl
    });
    await pair.workRefusal.submitWorkRefusal({ title_ct: TINY, notes_ct: TINY });
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/t14-op');
  });

  it('omits Authorization header when getJwt() returns null (both clients)', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 401, body: { ok: false, error: 'rls_denied' } },
      { status: 401, body: { ok: false, error: 'rls_denied' } }
    ]);
    const pair = createSupabaseT14Clients({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => null,
      fetchImpl
    });
    await pair.workRefusal.submitWorkRefusal({ title_ct: TINY, notes_ct: TINY });
    await pair.s51Evidence.submitS51Evidence({ title_ct: TINY, notes_ct: TINY, photos: [] });
    expect((calls[0]?.init.headers as Record<string, string>)['Authorization']).toBeUndefined();
    expect((calls[1]?.init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('onSessionRevoked fires from EITHER client (shared transport channel)', async () => {
    const { fetchImpl } = stubFetch([
      { status: 401, body: { ok: false, error: 'rls_denied' } },
      { status: 401, body: { ok: false, error: 'rls_denied' } }
    ]);
    const onSessionRevoked = vi.fn();
    const pair = createSupabaseT14Clients({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'stale-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await pair.workRefusal.submitWorkRefusal({ title_ct: TINY, notes_ct: TINY });
    await pair.s51Evidence.submitS51Evidence({ title_ct: TINY, notes_ct: TINY, photos: [] });
    expect(onSessionRevoked).toHaveBeenCalledTimes(2);
  });

  it('does NOT fire onSessionRevoked on 403 (RLS denied this op, session live)', async () => {
    const { fetchImpl } = stubFetch([{ status: 403, body: { ok: false, error: 'rls_denied' } }]);
    const onSessionRevoked = vi.fn();
    const pair = createSupabaseT14Clients({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'valid-jwt',
      fetchImpl,
      onSessionRevoked
    });
    await pair.workRefusal.submitWorkRefusal({ title_ct: TINY, notes_ct: TINY });
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });

  it('surfaces a network error as { ok: false, reason: unknown, status: 0 } (both clients)', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const pair = createSupabaseT14Clients({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'jwt',
      fetchImpl
    });
    const r1 = await pair.workRefusal.submitWorkRefusal({ title_ct: TINY, notes_ct: TINY });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.status).toBe(0);
      expect(r1.reason).toBe('unknown');
    }
    const r2 = await pair.s51Evidence.submitS51Evidence({
      title_ct: TINY,
      notes_ct: TINY,
      photos: []
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.status).toBe(0);
      expect(r2.reason).toBe('unknown');
    }
  });

  it('back-compat: works when onSessionRevoked is undefined', async () => {
    const { fetchImpl } = stubFetch([{ status: 401, body: { ok: false, error: 'rls_denied' } }]);
    const pair = createSupabaseT14Clients({
      baseUrl: 'https://demo.supabase.co',
      getJwt: () => 'stale-jwt',
      fetchImpl
    });
    const r = await pair.workRefusal.submitWorkRefusal({ title_ct: TINY, notes_ct: TINY });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(401);
  });
});
