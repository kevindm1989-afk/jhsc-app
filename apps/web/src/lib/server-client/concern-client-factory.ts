/**
 * Production wiring helper — construct a `SupabaseConcernClient` over
 * the shared browser-fetch transport (T08.1 production wire-up).
 *
 * Mirrors `t07-client-factory.ts` in posture: a thin wrapper that fixes
 * `opName: 'concern-op'` and threads the result into
 * `SupabaseConcernClient`. The F-39 client revocation loop comes free
 * via `createEdgeFnFetchTransport`'s `onSessionRevoked` plumbing.
 *
 * Downstream consumers (the soon-to-land ConcernIntakeForm route, the
 * eventual concern-list / source-reveal admin surface) construct one
 * of these per session and pass it to the relevant primitive.
 *
 * Transport contract: see `edge-fn-fetch-transport.ts` for the
 * canonical semantics (JWT-bearer, 401 → onSessionRevoked, network →
 * status 0, ...).
 */

import {
  SupabaseConcernClient,
  type SupabaseConcernClientOptions
} from '../concerns/supabase-concern-client';
import { createEdgeFnFetchTransport, type JwtProvider } from './edge-fn-fetch-transport';

export interface CreateSupabaseConcernClientOptions {
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
   * Fired exactly when concern-op returns HTTP 401 — the F-39 client
   * revocation loop. See `edge-fn-fetch-transport.ts` /
   * `session-jwt-store.ts` for the full contract. Wiring this to
   * `clearJwt` (in `hooks.client.ts` / route mounts) closes the loop.
   */
  onSessionRevoked?: () => void;
}

/**
 * Build a production `SupabaseConcernClient` over the shared
 * browser-fetch transport, fixed at `opName: 'concern-op'`.
 */
export function createSupabaseConcernClient(
  opts: CreateSupabaseConcernClientOptions
): SupabaseConcernClient {
  const transport = createEdgeFnFetchTransport({
    baseUrl: opts.baseUrl,
    opName: 'concern-op',
    getJwt: opts.getJwt,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.onSessionRevoked ? { onSessionRevoked: opts.onSessionRevoked } : {})
  });

  const clientOpts: SupabaseConcernClientOptions = { transport };
  return new SupabaseConcernClient(clientOpts);
}
