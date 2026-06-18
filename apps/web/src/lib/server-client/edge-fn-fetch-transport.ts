/**
 * Shared browser-fetch transport for every Supabase Edge Function client
 * (t07-op, concern-op, reprisal-op, t14-op, committee-op, mint-session,
 * future Edge Functions). The op-dispatch wire shape is identical across
 * all of them: POST a JSON body with `Authorization: Bearer <jwt>` to
 * `${baseUrl}/functions/v1/<op-name>` and parse `{status, body}` back.
 *
 * Why centralize: every t07-client must honor the F-39 client-side
 * revocation loop (401 → onSessionRevoked → clearJwt). The contract is
 * documented in `session-jwt-store.ts`: "Production code that holds a
 * JWT MUST tolerate a 401 from any t07-op (or other RPC) call as
 * 'session revoked' and call `clearJwt()` + redirect to sign-in." With
 * one shared transport, the loop is enforced structurally — every
 * Edge Function factory that goes through this helper gets the loop
 * for free, and there's only one place to audit.
 *
 * Transport semantics (uniform across every Edge Function client):
 *  - JWT resolved lazily per call via `getJwt()` — a freshly-minted JWT
 *    after sign-in is picked up without recreating the client. Async
 *    `getJwt` is awaited; a throwing `getJwt` is treated as null
 *    (unauthenticated).
 *  - 401 (server's `session_is_live()` gate denied) → `onSessionRevoked`
 *    fires best-effort (errors swallowed). NOT fired on 403 (live
 *    session, RLS denies this op), 200 (success), or 0 (network error).
 *  - Network errors surface as `{status: 0, body: null}`. The downstream
 *    wire parser collapses that to `{ok: false, reason: 'unknown'}`.
 *  - Non-JSON / empty response bodies surface as `body: null`.
 */

/**
 * Provider for the caller's current GoTrue JWT. Returning `null` means
 * the caller is unauthenticated; the transport will still POST but the
 * Edge Function's `session_is_live()` gate will RAISE 401 / `rls_denied`
 * server-side. (Unauthenticated callers SHOULD short-circuit before
 * calling the client, but the contract is defensive.)
 */
export type JwtProvider = () => string | null | Promise<string | null>;

/**
 * Shared transport return shape — `{status, body}` matches every
 * Edge Function client's `*OpTransport` type (T07OpTransport,
 * ConcernOpTransport, ReprisalOpTransport, T14OpTransport, ...).
 */
export type EdgeFnFetchTransport = (
  body: Record<string, unknown>
) => Promise<{ status: number; body: unknown }>;

export interface CreateEdgeFnFetchTransportOptions {
  /** Base URL of the Supabase project (e.g. `https://abcd.supabase.co`). */
  baseUrl: string;
  /**
   * Edge Function name as it appears in the URL path
   * (`t07-op`, `concern-op`, `reprisal-op`, `t14-op`, ...). The full
   * endpoint becomes `${baseUrl}/functions/v1/${opName}`.
   */
  opName: string;
  /** Callback that returns the caller's current JWT, if any. */
  getJwt: JwtProvider;
  /**
   * Override `fetch` for tests / non-browser environments. Defaults to
   * `globalThis.fetch`. Production calls leave this undefined.
   */
  fetchImpl?: typeof fetch;
  /**
   * Fired exactly when the Edge Function returns HTTP 401 — the
   * server-side `session_is_live()` gate's response when the session
   * was revoked, expired, or never authenticated. Wiring this to
   * `clearJwt` (in `hooks.client.ts` / route mounts) closes the F-39
   * loop. Errors thrown from this callback are swallowed: a buggy
   * onSessionRevoked MUST NOT prevent the caller from seeing the 401.
   */
  onSessionRevoked?: () => void;
}

/**
 * Build a browser-`fetch` transport for an Edge Function client. The
 * returned function is the transport closure each Edge Function client
 * (`SupabaseT07Client`, the soon-to-land `SupabaseConcernClient`
 * production factory, etc.) takes as its `transport` constructor arg.
 */
export function createEdgeFnFetchTransport(
  opts: CreateEdgeFnFetchTransportOptions
): EdgeFnFetchTransport {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const endpoint = `${baseUrl}/functions/v1/${opts.opName}`;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return async (body) => {
    let jwt: string | null;
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
}
