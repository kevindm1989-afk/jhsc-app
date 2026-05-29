/**
 * Production wiring helpers — construct a `SupabaseT07Client` over the
 * shared browser-fetch transport + build the `PanicWipeAuditEmitter`
 * adapter that bridges it into `BrowserWipeStore` (G-T19-PRIV-3 follow-up).
 *
 * The downstream consumers (`apps/web/src/routes/onboarding/+page.svelte`,
 * `apps/web/src/routes/settings/+page.svelte`, the T19 wizard step
 * components, `hooks.client.ts`'s default panic-wipe client) each
 * construct one of these per session and pass it to the relevant
 * primitive.
 *
 * Why a factory instead of a top-level `t07Client` singleton: the JWT
 * provider has to be settable AFTER auth completes (the caller starts
 * unauthenticated and acquires a JWT once the passkey-sign-in flow
 * succeeds). A singleton would either need a mutable JWT slot (race-y) or
 * would have to be reconstructed on every auth change. The factory
 * pattern lets each route construct its own client with a closure over
 * the latest JWT source.
 *
 * Transport contract: see `edge-fn-fetch-transport.ts` for the canonical
 * semantics (JWT-bearer, 401 → onSessionRevoked, network → status 0, ...).
 * This factory is a thin wrapper that fixes `opName: 't07-op'` and
 * threads the result into `SupabaseT07Client`.
 */

import { SupabaseT07Client, type SupabaseT07ClientOptions } from '../crypto/supabase-t07-client';
import type { LocalIdentityStore } from '../crypto/key-store';
import type { PanicWipeAuditEmitter } from '../lock/wipe-store';
import { createEdgeFnFetchTransport, type JwtProvider } from './edge-fn-fetch-transport';

export type { JwtProvider };

export interface CreateSupabaseT07ClientOptions {
  /** Base URL of the Supabase project (e.g. `https://abcd.supabase.co`). */
  baseUrl: string;
  /** Callback that returns the caller's current JWT, if any. */
  getJwt: JwtProvider;
  /** Optional device-local identity store (typically BrowserLocalIdentityStore). */
  localIdentity?: LocalIdentityStore;
  /**
   * Override `fetch` for tests / non-browser environments. Defaults to
   * `globalThis.fetch`. Production calls leave this undefined.
   */
  fetchImpl?: typeof fetch;
  /**
   * Fired exactly when the t07-op Edge Function returns HTTP 401 — the
   * server-side `session_is_live()` gate's response when the session
   * was revoked, expired, or never authenticated. See the F-39 contract
   * in `session-jwt-store.ts`. Wiring this to `clearJwt` (in
   * `hooks.client.ts` / route mounts) closes the loop.
   *
   * NOT fired on 403 (session live, RLS denies this op), 200, or
   * network errors (status 0).
   *
   * Errors thrown from this callback are swallowed.
   */
  onSessionRevoked?: () => void;
}

/**
 * Build a production `SupabaseT07Client` over the shared browser-fetch
 * transport, fixed at `opName: 't07-op'`.
 */
export function createSupabaseT07Client(opts: CreateSupabaseT07ClientOptions): SupabaseT07Client {
  const transport = createEdgeFnFetchTransport({
    baseUrl: opts.baseUrl,
    opName: 't07-op',
    getJwt: opts.getJwt,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.onSessionRevoked ? { onSessionRevoked: opts.onSessionRevoked } : {})
  });

  const clientOpts: SupabaseT07ClientOptions = { transport };
  if (opts.localIdentity) clientOpts.localIdentity = opts.localIdentity;
  return new SupabaseT07Client(clientOpts);
}

/**
 * Wrap a `SupabaseT07Client` as a `PanicWipeAuditEmitter` so a
 * `BrowserWipeStore` can route its audit-emit through t07-op. The
 * `BrowserWipeStore` only needs the `{ok: boolean}` shape; this adapter
 * collapses the client's `T07OpResult<null>` to that shape.
 *
 * Failure modes the adapter forwards (per PR #36):
 *  - Network throws → caught by BrowserWipeStore.emitAudit (which wraps
 *    this call in its own try/catch and surfaces {ok: false}).
 *  - 403 rls_denied (caller unauthenticated or session revoked) → ok:false.
 *  - 200 success → ok:true.
 *
 * Either way the audit-before-side-effect contract holds: a panic-wipe
 * that can't honestly emit its row fails fast and leaves local state
 * intact.
 */
export function createPanicWipeAuditEmitter(client: SupabaseT07Client): PanicWipeAuditEmitter {
  return {
    async recordPanicWipeInvoked({ meta }) {
      const r = await client.recordPanicWipeInvoked({ meta });
      return { ok: r.ok };
    }
  };
}
