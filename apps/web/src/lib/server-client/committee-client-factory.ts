/**
 * Production wiring helper — construct a `SupabaseCommitteeClient` over
 * the shared browser-fetch transport (ADR-0029 P1-3 production wire-up).
 *
 * Mirrors `concern-client-factory.ts` / `t07-client-factory.ts` /
 * `reprisal-client-factory.ts` in posture: a thin wrapper that fixes
 * `opName: 'committee-op'` and threads the result into
 * `SupabaseCommitteeClient`. The F-39 client revocation loop comes free
 * via `createEdgeFnFetchTransport`'s `onSessionRevoked` plumbing.
 *
 * Downstream consumers (the soon-to-land /committee co-chair route and
 * `wrapMemberInViaProduction`, P1-5/P1-8) construct one of these per
 * session and pass it to the relevant primitive.
 *
 * Transport contract: see `edge-fn-fetch-transport.ts` for the
 * canonical semantics (JWT-bearer, 401 → onSessionRevoked, network →
 * status 0, ...).
 */

import {
  SupabaseCommitteeClient,
  type SupabaseCommitteeClientOptions
} from '../committee/supabase-committee-client';
import { createEdgeFnFetchTransport, type JwtProvider } from './edge-fn-fetch-transport';

export interface CreateSupabaseCommitteeClientOptions {
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
   * Fired exactly when committee-op returns HTTP 401 — the F-39 client
   * revocation loop. See `edge-fn-fetch-transport.ts` /
   * `session-jwt-store.ts` for the full contract. Wiring this to
   * `clearJwt` (in `hooks.client.ts` / route mounts) closes the loop.
   *
   * NOT fired on 403 (session live, RLS denies this op), 200, or
   * network errors (status 0).
   */
  onSessionRevoked?: () => void;
}

/**
 * Build a production `SupabaseCommitteeClient` over the shared
 * browser-fetch transport, fixed at `opName: 'committee-op'`.
 *
 * ADR-0029 Decision 3 explicitly slots the new `issue_invite` op into the
 * EXISTING `committee-op` Edge Function (no new EF name); the URL the
 * shared transport composes is therefore `${baseUrl}/functions/v1/committee-op`.
 */
export function createSupabaseCommitteeClient(
  opts: CreateSupabaseCommitteeClientOptions
): SupabaseCommitteeClient {
  const transport = createEdgeFnFetchTransport({
    baseUrl: opts.baseUrl,
    opName: 'committee-op',
    getJwt: opts.getJwt,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.onSessionRevoked ? { onSessionRevoked: opts.onSessionRevoked } : {})
  });

  const clientOpts: SupabaseCommitteeClientOptions = { transport };
  return new SupabaseCommitteeClient(clientOpts);
}
