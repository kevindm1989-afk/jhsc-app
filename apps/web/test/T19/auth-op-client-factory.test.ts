/**
 * T19.1 — auth-op-client-factory wiring pins.
 *
 * Mirrors concern-client-factory.test.ts / t07-client-factory.test.ts:
 * the factory's job is to thread a JwtProvider + F-39 onSessionRevoked
 * hook through createEdgeFnFetchTransport into a SupabaseAuthStore.
 * Tests pin:
 *   - The factory constructs a SupabaseAuthStore instance.
 *   - opName is fixed to 'auth-op' (the canonical Edge Function name).
 *   - getJwt is called lazily on each request, so a setJwt after
 *     factory construction is observed.
 *   - onSessionRevoked fires on a 401 response (F-39 contract).
 *   - The transport posts to <baseUrl>/functions/v1/auth-op with the
 *     JWT in the Authorization header.
 */

import { describe, expect, it, vi } from 'vitest';
import { createSupabaseAuthStore } from '../../src/lib/server-client/auth-op-client-factory';
import { SupabaseAuthStore } from '../../src/lib/auth/supabase-auth-store';

describe('T19.1 — createSupabaseAuthStore', () => {
  it('returns a SupabaseAuthStore instance', () => {
    const store = createSupabaseAuthStore({
      baseUrl: 'https://example.supabase.co',
      getJwt: () => 'jwt-1',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ ok: true, data: null })))
    });
    expect(store).toBeInstanceOf(SupabaseAuthStore);
  });

  it('posts to <baseUrl>/functions/v1/auth-op with op + bearer', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, data: { user_id: 'u1' } }))
    );
    const store = createSupabaseAuthStore({
      baseUrl: 'https://example.supabase.co',
      getJwt: () => 'jwt-1',
      fetchImpl
    });
    await store.getUser('u1');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0]!;
    expect(String(call[0])).toBe('https://example.supabase.co/functions/v1/auth-op');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-1');
    const body = JSON.parse(init.body as string);
    expect(body.op).toBe('get_user');
    expect(body.user_id).toBe('u1');
  });

  it('reads the JWT lazily — a setJwt-after-construction value is observed', async () => {
    let current: string | null = 'jwt-initial';
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, data: { user_id: 'u1' } }))
    );
    const store = createSupabaseAuthStore({
      baseUrl: 'https://example.supabase.co',
      getJwt: () => current,
      fetchImpl
    });

    await store.getUser('u1');
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer jwt-initial'
    });

    current = 'jwt-rotated';
    await store.getUser('u1');
    expect((fetchImpl.mock.calls[1]![1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer jwt-rotated'
    });
  });

  it('fires onSessionRevoked on a 401 (F-39 client revocation loop)', async () => {
    const onSessionRevoked = vi.fn();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, error: 'rls_denied' }), { status: 401 })
    );
    const store = createSupabaseAuthStore({
      baseUrl: 'https://example.supabase.co',
      getJwt: () => 'jwt-1',
      fetchImpl,
      onSessionRevoked
    });

    await store.getUser('u1');
    expect(onSessionRevoked).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onSessionRevoked on a 200 response', async () => {
    const onSessionRevoked = vi.fn();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, data: { user_id: 'u1' } }))
    );
    const store = createSupabaseAuthStore({
      baseUrl: 'https://example.supabase.co',
      getJwt: () => 'jwt-1',
      fetchImpl,
      onSessionRevoked
    });

    await store.getUser('u1');
    expect(onSessionRevoked).not.toHaveBeenCalled();
  });
});
