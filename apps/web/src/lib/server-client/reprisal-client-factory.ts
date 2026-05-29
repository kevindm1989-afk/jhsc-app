/**
 * Production wiring helper — construct a `SupabaseReprisalClient` over
 * the shared browser-fetch transport (T13.1 production wire-up).
 *
 * Mirrors `concern-client-factory.ts` / `t07-client-factory.ts` in
 * posture: a thin wrapper that fixes `opName: 'reprisal-op'` and threads
 * the result into `SupabaseReprisalClient`. The F-39 client revocation
 * loop comes for free via `createEdgeFnFetchTransport`'s
 * `onSessionRevoked` plumbing.
 *
 * Downstream consumers (the soon-to-land ReprisalIntakeForm route, the
 * eventual reprisal-list / status-flip / forensic-reveal admin surfaces)
 * construct one of these per session and pass it to the relevant
 * primitive.
 *
 * Transport contract: see `edge-fn-fetch-transport.ts` for the
 * canonical semantics (JWT-bearer, 401 → onSessionRevoked, network →
 * status 0, ...).
 */

import {
  SupabaseReprisalClient,
  type SupabaseReprisalClientOptions
} from '../reprisal/supabase-reprisal-client';
import { createEdgeFnFetchTransport, type JwtProvider } from './edge-fn-fetch-transport';

export interface CreateSupabaseReprisalClientOptions {
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
   * Fired exactly when reprisal-op returns HTTP 401 — the F-39 client
   * revocation loop. See `edge-fn-fetch-transport.ts` /
   * `session-jwt-store.ts` for the full contract. Wiring this to
   * `clearJwt` (in `hooks.client.ts` / route mounts) closes the loop.
   */
  onSessionRevoked?: () => void;
}

/**
 * Build a production `SupabaseReprisalClient` over the shared
 * browser-fetch transport, fixed at `opName: 'reprisal-op'`.
 */
export function createSupabaseReprisalClient(
  opts: CreateSupabaseReprisalClientOptions
): SupabaseReprisalClient {
  const transport = createEdgeFnFetchTransport({
    baseUrl: opts.baseUrl,
    opName: 'reprisal-op',
    getJwt: opts.getJwt,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.onSessionRevoked ? { onSessionRevoked: opts.onSessionRevoked } : {})
  });

  const clientOpts: SupabaseReprisalClientOptions = { transport };
  return new SupabaseReprisalClient(clientOpts);
}
