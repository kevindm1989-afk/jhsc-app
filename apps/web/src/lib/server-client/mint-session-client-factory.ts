/**
 * Production wiring helper — construct a `SupabaseMintSessionClient`
 * over the shared browser-fetch transport (T19.1 / ADR-0023 sign-in
 * production wire-up).
 *
 * Differs from `t07-client-factory.ts` / `concern-client-factory.ts`
 * etc. in two ways:
 *
 *   1. NO `getJwt` parameter — the mint-session Edge Function is
 *      registered with `verify_jwt = false` (the caller has no session
 *      yet; that's the whole point of mint-session). The shared
 *      transport's `getJwt` slot is therefore hard-wired to a
 *      `() => null` constant so the `Authorization: Bearer` header is
 *      structurally omitted.
 *
 *   2. NO `onSessionRevoked` parameter — a 401 from mint-session means
 *      `assertion_invalid` / `unknown_credential`, NOT session revoked.
 *      Firing `clearJwt` on those would be a category error (there's no
 *      session to clear pre-sign-in). The shared transport's
 *      `onSessionRevoked` slot is left undefined.
 *
 * Downstream consumer: the sign-in route (follow-up PR) constructs one
 * of these per session boot, calls `requestChallenge` → posts the
 * signed assertion → calls `assertCredential` → calls `setJwt(token)`
 * to populate the session-jwt-store.
 *
 * Transport contract: see `edge-fn-fetch-transport.ts` for the
 * canonical semantics (JSON body, network → status 0, ...).
 */

import {
  SupabaseMintSessionClient,
  type SupabaseMintSessionClientOptions
} from '../auth/supabase-mint-session-client';
import { createEdgeFnFetchTransport } from './edge-fn-fetch-transport';

export interface CreateSupabaseMintSessionClientOptions {
  /** Base URL of the Supabase project (e.g. `https://abcd.supabase.co`). */
  baseUrl: string;
  /**
   * Override `fetch` for tests / non-browser environments. Defaults to
   * `globalThis.fetch`. Production calls leave this undefined.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Build a production `SupabaseMintSessionClient` over the shared
 * browser-fetch transport, fixed at `opName: 'mint-session'` with no
 * JWT bearer and no F-39 revocation hook (see module header for why).
 */
export function createSupabaseMintSessionClient(
  opts: CreateSupabaseMintSessionClientOptions
): SupabaseMintSessionClient {
  const transport = createEdgeFnFetchTransport({
    baseUrl: opts.baseUrl,
    opName: 'mint-session',
    getJwt: () => null,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {})
  });

  const clientOpts: SupabaseMintSessionClientOptions = { transport };
  return new SupabaseMintSessionClient(clientOpts);
}
