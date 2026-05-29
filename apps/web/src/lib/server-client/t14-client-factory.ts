/**
 * Production wiring helper — construct the t14-op client pair
 * (`SupabaseWorkRefusalClient` for s.43, `SupabaseS51EvidenceClient`
 * for s.51 critical-injury) over a single shared browser-fetch
 * transport (T14.1 production wire-up).
 *
 * Why a single factory returning both: t14-op is a single Edge Function
 * that dispatches both `wr_*` (s.43) and `s51_*` (s.51) ops; one
 * transport serves both clients. A naïve "two separate factories" shape
 * would either build two transports (wasteful — same JWT, same
 * endpoint) or force the caller to wire the transport-sharing
 * themselves. The shared-pair pattern keeps both clients in lockstep
 * with one F-39 revocation channel and one `onSessionRevoked` wiring.
 *
 * Mirrors `concern-client-factory.ts` / `reprisal-client-factory.ts`
 * posture: fixes `opName: 't14-op'` and threads the result into both
 * client constructors. The F-39 client revocation loop comes for free
 * via `createEdgeFnFetchTransport`'s `onSessionRevoked` plumbing.
 *
 * Transport contract: see `edge-fn-fetch-transport.ts` for the
 * canonical semantics (JWT-bearer, 401 → onSessionRevoked, network →
 * status 0, ...).
 */

import {
  SupabaseS51EvidenceClient,
  SupabaseWorkRefusalClient,
  type SupabaseT14ClientOptions
} from '../work-refusal/supabase-t14-client';
import { createEdgeFnFetchTransport, type JwtProvider } from './edge-fn-fetch-transport';

export interface CreateSupabaseT14ClientsOptions {
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
   * Fired exactly when t14-op returns HTTP 401 — the F-39 client
   * revocation loop. See `edge-fn-fetch-transport.ts` /
   * `session-jwt-store.ts` for the full contract. Wiring this to
   * `clearJwt` (in `hooks.client.ts` / route mounts) closes the loop.
   */
  onSessionRevoked?: () => void;
}

export interface SupabaseT14ClientPair {
  workRefusal: SupabaseWorkRefusalClient;
  s51Evidence: SupabaseS51EvidenceClient;
}

/**
 * Build the production t14-op client pair over a single shared
 * browser-fetch transport, fixed at `opName: 't14-op'`.
 */
export function createSupabaseT14Clients(
  opts: CreateSupabaseT14ClientsOptions
): SupabaseT14ClientPair {
  const transport = createEdgeFnFetchTransport({
    baseUrl: opts.baseUrl,
    opName: 't14-op',
    getJwt: opts.getJwt,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.onSessionRevoked ? { onSessionRevoked: opts.onSessionRevoked } : {})
  });

  const clientOpts: SupabaseT14ClientOptions = { transport };
  return {
    workRefusal: new SupabaseWorkRefusalClient(clientOpts),
    s51Evidence: new SupabaseS51EvidenceClient(clientOpts)
  };
}
