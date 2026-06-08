/**
 * Production wiring helper — construct a `SupabaseAuthStore` over the
 * shared browser-fetch transport, pointed at the `auth-op` Edge Function.
 *
 * Mirrors `concern-client-factory.ts` and `t07-client-factory.ts`:
 * a thin wrapper that fixes `opName: 'auth-op'` and threads the result
 * into `SupabaseAuthStore`. The F-39 client revocation loop comes free
 * via `createEdgeFnFetchTransport`'s `onSessionRevoked` plumbing — a 401
 * response from the dispatcher clears the in-memory JWT so subsequent
 * calls don't keep posting the stale token.
 *
 * Downstream consumers (the soon-to-land /settings sessions surface,
 * the Settings panic-wipe modal already mounted) construct one of these
 * per session and pass `SupabaseAuthStore` instance to the relevant
 * component.
 *
 * Transport contract: see `edge-fn-fetch-transport.ts` for the
 * canonical semantics (JWT-bearer, 401 → onSessionRevoked, network →
 * status 0, ...).
 */

import { SupabaseAuthStore } from '../auth/supabase-auth-store';
import { createEdgeFnFetchTransport, type JwtProvider } from './edge-fn-fetch-transport';

export interface CreateSupabaseAuthStoreOptions {
  /** Base URL of the Supabase project (e.g. `https://abcd.supabase.co`). */
  baseUrl: string;
  /** Callback that returns the caller's current JWT, if any. */
  getJwt: JwtProvider;
  /**
   * Override `fetch` for tests / non-browser environments. Defaults to
   * `globalThis.fetch`. Production calls leave this undefined.
   */
  fetchImpl?: typeof fetch;
  /**
   * Fired exactly when auth-op returns HTTP 401 — the F-39 client
   * revocation loop. See `edge-fn-fetch-transport.ts` /
   * `session-jwt-store.ts` for the full contract. Wiring this to
   * `clearJwt` (in `hooks.client.ts` / route mounts) closes the loop.
   */
  onSessionRevoked?: () => void;
}

/**
 * Build a production `SupabaseAuthStore` over the shared browser-fetch
 * transport, fixed at `opName: 'auth-op'`.
 */
export function createSupabaseAuthStore(opts: CreateSupabaseAuthStoreOptions): SupabaseAuthStore {
  const transport = createEdgeFnFetchTransport({
    baseUrl: opts.baseUrl,
    opName: 'auth-op',
    getJwt: opts.getJwt,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.onSessionRevoked ? { onSessionRevoked: opts.onSessionRevoked } : {})
  });

  return new SupabaseAuthStore({ transport });
}
