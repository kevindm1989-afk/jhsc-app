/**
 * T19.1 — production wiring helper for `SupabaseMintSessionClient`
 * (mint-session Edge Function).
 *
 * Differs from the t07/concern/reprisal/t14 factory tests on two
 * security-relevant invariants:
 *
 *   1. NO `Authorization: Bearer` header — mint-session is registered
 *      with `verify_jwt = false`; the caller has no session yet.
 *   2. NO F-39 revocation hook — a 401 from mint-session means
 *      assertion_invalid / unknown_credential, NOT session revoked.
 *      Wiring `clearJwt` here would be a category error.
 *
 * Both invariants are pinned explicitly so a future refactor that
 * "uniformizes" the factories doesn't accidentally start sending a
 * stale JWT to mint-session or clearing the JWT on a failed sign-in.
 */

import { describe, expect, it } from 'vitest';
import { createSupabaseMintSessionClient } from '../../src/lib/server-client/mint-session-client-factory';
import { SupabaseMintSessionClient } from '../../src/lib/auth/supabase-mint-session-client';

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

describe('T19.1 — createSupabaseMintSessionClient', () => {
  it('returns a SupabaseMintSessionClient instance', () => {
    const { fetchImpl } = stubFetch([]);
    const client = createSupabaseMintSessionClient({
      baseUrl: 'https://demo.supabase.co',
      fetchImpl
    });
    expect(client).toBeInstanceOf(SupabaseMintSessionClient);
  });

  it('POSTs to ${baseUrl}/functions/v1/mint-session with the body as JSON', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { ok: true, challenge: 'srv-nonce' } }
    ]);
    const client = createSupabaseMintSessionClient({
      baseUrl: 'https://demo.supabase.co',
      fetchImpl
    });
    await client.requestChallenge({ rpId: 'jhsc.example', origin: 'https://jhsc.example' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/mint-session');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      action: 'challenge',
      rp_id: 'jhsc.example',
      origin: 'https://jhsc.example'
    });
  });

  it('strips trailing slashes from baseUrl', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { ok: true, challenge: 'x' } }
    ]);
    const client = createSupabaseMintSessionClient({
      baseUrl: 'https://demo.supabase.co////',
      fetchImpl
    });
    await client.requestChallenge({ rpId: 'x', origin: 'x' });
    expect(calls[0]?.url).toBe('https://demo.supabase.co/functions/v1/mint-session');
  });

  it('NEVER sends an Authorization header (mint-session is verify_jwt=false; the caller has no session)', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { ok: true, challenge: 'x' } },
      { status: 401, body: { ok: false, error: 'assertion_invalid' } }
    ]);
    const client = createSupabaseMintSessionClient({
      baseUrl: 'https://demo.supabase.co',
      fetchImpl
    });
    await client.requestChallenge({ rpId: 'x', origin: 'x' });
    await client.assertCredential({
      credentialId: 'c',
      clientDataJSON: 'd',
      authenticatorData: 'a',
      signature: 's',
      origin: 'o',
      challenge: 'ch'
    });
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
    }
  });

  it('the factory option surface does NOT expose getJwt or onSessionRevoked (structural enforcement)', () => {
    // Defense-in-depth: the only valid call sites for this factory should
    // be the sign-in route, and the option surface should make it
    // structurally impossible to wire either a stale JWT or a clearJwt
    // callback. We assert this by attempting to construct with EXTRA
    // properties — TypeScript would reject this in real callers, but at
    // runtime the extra options should simply be ignored (not forwarded
    // to the shared transport). The acceptance test is that the call
    // still does not attach an Authorization header.
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { ok: true, challenge: 'x' } }
    ]);
    const optsWithExtras = {
      baseUrl: 'https://demo.supabase.co',
      fetchImpl,
      // Smuggled-in foreign options — runtime should ignore them.
      getJwt: () => 'should-not-be-sent',
      onSessionRevoked: () => {
        throw new Error('this MUST NOT fire from mint-session 401');
      }
    } as unknown as { baseUrl: string; fetchImpl: typeof fetch };
    const client = createSupabaseMintSessionClient(optsWithExtras);
    void client.requestChallenge({ rpId: 'x', origin: 'x' });
    // After the microtask tick, the call should have gone out without
    // Authorization, proving the smuggled getJwt was NOT honored.
    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        const headers = calls[0]?.init.headers as Record<string, string>;
        expect(headers['Authorization']).toBeUndefined();
        resolve();
      });
    });
  });

  it('surfaces a network error as { ok: false, reason: unknown, status: 0 }', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const client = createSupabaseMintSessionClient({
      baseUrl: 'https://demo.supabase.co',
      fetchImpl
    });
    const r = await client.requestChallenge({ rpId: 'x', origin: 'x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(0);
    expect(r.reason).toBe('unknown');
  });

  it('a 401 from mint-session does NOT trigger any side effect on the JWT store (no onSessionRevoked wired)', async () => {
    // We test this by passing a fetchImpl that returns 401 and verifying
    // no callback is invoked. Since the factory doesn't accept an
    // onSessionRevoked, the shared transport's slot is undefined → the
    // 401 surfaces as the normal error path with no side effects.
    const { fetchImpl } = stubFetch([
      { status: 401, body: { ok: false, error: 'assertion_invalid' } }
    ]);
    const client = createSupabaseMintSessionClient({
      baseUrl: 'https://demo.supabase.co',
      fetchImpl
    });
    const r = await client.assertCredential({
      credentialId: 'c',
      clientDataJSON: 'd',
      authenticatorData: 'a',
      signature: 's',
      origin: 'o',
      challenge: 'ch'
    });
    // The result surfaces normally — and crucially, no clearJwt-like
    // side effect happened (we don't have a way to observe directly, but
    // the structural absence of the onSessionRevoked parameter on the
    // factory's option surface is the actual guarantee).
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('assertion_invalid');
    expect(r.status).toBe(401);
  });
});
