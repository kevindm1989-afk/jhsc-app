/**
 * Production wiring helpers — construct a `SupabaseT07Client` over a
 * browser `fetch` transport + build the `PanicWipeAuditEmitter` adapter
 * that bridges it into `BrowserWipeStore` (G-T19-PRIV-3 follow-up).
 *
 * The downstream consumers (`apps/web/src/routes/onboarding/+page.svelte`,
 * a future SettingsPage with PanicWipeModal, the T19 wizard step
 * components) each construct one of these per session and pass it to the
 * relevant primitive. This module is the single source of truth for the
 * t07-op base URL + Authorization header convention so subsequent
 * call sites stay symmetrical.
 *
 * Why a factory instead of a top-level `t07Client` singleton: the JWT
 * provider has to be settable AFTER auth completes (the caller starts
 * unauthenticated and acquires a JWT once the passkey-sign-in flow
 * succeeds). A singleton would either need a mutable JWT slot (race-y) or
 * would have to be reconstructed on every auth change. The factory
 * pattern lets each route construct its own client with a closure over
 * the latest JWT source.
 *
 * Transport contract: t07-op (the Edge Function the SupabaseT07Client
 * targets) expects POST + `Authorization: Bearer <jwt>` + JSON body. The
 * Edge Function returns `{ ok: true, data: ... } | { ok: false, error,
 * status }`; we forward `r.status` (HTTP) and `r.body` (parsed JSON) to
 * `SupabaseT07Client`'s `T07OpTransport` shape.
 */

import {
  SupabaseT07Client,
  type SupabaseT07ClientOptions,
  type T07OpTransport
} from '../crypto/supabase-t07-client';
import type { LocalIdentityStore } from '../crypto/key-store';
import type { PanicWipeAuditEmitter } from '../lock/wipe-store';

/**
 * Provider for the caller's current GoTrue JWT. Returning `null` means
 * the caller is unauthenticated; the transport will still POST but the
 * t07-op Edge Function's `session_is_live()` gate will RAISE 401 /
 * `rls_denied` server-side. (Unauthenticated callers SHOULD short-circuit
 * before calling the client, but the contract is defensive.)
 */
export type JwtProvider = () => string | null | Promise<string | null>;

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
   * was revoked, expired, or never authenticated. The session-jwt-store
   * header documents the contract: production callers MUST treat 401 as
   * "session revoked" and call `clearJwt()` so subsequent calls don't
   * keep posting a stale token. Wiring this callback to `clearJwt` (in
   * `hooks.client.ts`) closes that loop.
   *
   * NOT fired on 403 (session live, RLS denies this op), on 200, or on
   * network errors (status 0) — those don't imply revocation.
   *
   * Errors thrown from this callback are swallowed (a buggy clearJwt
   * MUST NOT take down the transport response — the caller is already
   * about to see the 401 itself and handle it).
   */
  onSessionRevoked?: () => void;
}

/**
 * Build a production `SupabaseT07Client` over a browser fetch transport.
 *
 * The transport:
 * - Resolves the JWT lazily via `getJwt()` on every call (so a freshly-
 *   minted JWT after sign-in is picked up without recreating the client).
 * - POSTs to `${baseUrl}/functions/v1/t07-op` with `Authorization: Bearer`
 *   and a JSON body.
 * - Best-effort parses the response body; non-JSON / empty responses
 *   surface as `body: null` (the SupabaseT07Client's wire-parser handles
 *   the null path → `{ok: false, reason: 'unknown'}`).
 * - Catches network errors and surfaces them as `{status: 0, body: null}`
 *   — the client maps that to `{ok: false, reason: 'unknown', status: 0}`.
 */
export function createSupabaseT07Client(opts: CreateSupabaseT07ClientOptions): SupabaseT07Client {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const endpoint = `${baseUrl}/functions/v1/t07-op`;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const transport: T07OpTransport = async (body) => {
    let jwt: string | null = null;
    try {
      jwt = await Promise.resolve(opts.getJwt());
    } catch {
      jwt = null;
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
      if (response.status === 401 && opts.onSessionRevoked) {
        try {
          opts.onSessionRevoked();
        } catch {
          // A throwing onSessionRevoked MUST NOT prevent the caller from
          // observing the 401 — they're already going to handle it.
        }
      }
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        // Empty / non-JSON body — leave parsed as null.
      }
      return { status: response.status, body: parsed };
    } catch {
      // Network error (offline, DNS, etc.). Surface status 0 / null body;
      // the wire parser collapses this to {ok: false, reason: 'unknown'}.
      return { status: 0, body: null };
    }
  };

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
