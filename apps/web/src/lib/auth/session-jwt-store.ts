/**
 * In-memory session JWT store — the production source of truth for the
 * current GoTrue access_token.
 *
 * Production callers (`createSupabaseT07Client`, the soon-to-land
 * sign-in route, the eventual Settings → Sessions surface) read the
 * current JWT via `getJwt()` and subscribe to changes via
 * `subscribeToJwt(cb)`. The sign-in flow calls `setJwt(token)` after
 * mint-session succeeds; "Sign out" calls `clearJwt()`.
 *
 * Storage posture (deliberately conservative):
 *   - In-memory ONLY. No sessionStorage. No localStorage. No URL hash.
 *     Same discipline as the T19 wizard state (F-111 M-111a "wizard
 *     state in-memory only"). A page reload requires re-sign-in.
 *   - F-39 (server-side jti revocation, ≤5s budget) is the
 *     authoritative revocation channel; the in-memory JWT can become
 *     stale within that window. Production code that holds a JWT MUST
 *     therefore tolerate a 401 from any t07-op (or other RPC) call as
 *     "session revoked" and call `clearJwt()` + redirect to sign-in.
 *   - The closure-captured `currentJwt` is module-private. There is
 *     no DOM exposure and no `window.__jhsc_jwt` global. Bundle-strip
 *     gates do not need to verify anything new here.
 *
 * SSR note: this module is only ever loaded in the browser bundle
 * (the routes that consume it declare `ssr=false`). The module-level
 * singleton is fine under that posture; if a future route enables SSR
 * the module MUST be refactored to per-request scope first.
 *
 * Test contract:
 *   - Initial `getJwt()` returns `null` (nothing on file).
 *   - `setJwt(x)` then `getJwt()` returns `x`.
 *   - `setJwt(null)` and `clearJwt()` are equivalent.
 *   - Subscribers are called synchronously after `setJwt` / `clearJwt`.
 *   - Returned `unsubscribe` is idempotent.
 *   - A throwing subscriber does NOT prevent other subscribers from
 *     being called.
 */

type JwtListener = (jwt: string | null) => void;

let currentJwt: string | null = null;
const listeners = new Set<JwtListener>();

/** Read the current JWT, or `null` when the caller is unauthenticated. */
export function getJwt(): string | null {
  return currentJwt;
}

/**
 * Set the current JWT. Pass `null` (or use `clearJwt()`) to sign out.
 * Notifies subscribers synchronously; throwing subscribers are isolated
 * via try/catch so a buggy listener cannot break the broadcast.
 */
export function setJwt(jwt: string | null): void {
  currentJwt = jwt;
  for (const listener of listeners) {
    try {
      listener(jwt);
    } catch {
      // Subscriber errors are swallowed by design (one bad listener
      // MUST NOT take down others). Surfacing them is the listener's
      // responsibility — it already had a reference to the JWT, after
      // all.
    }
  }
}

/**
 * Equivalent to `setJwt(null)`. Provided as a named entry point so
 * sign-out call sites read naturally (e.g. `clearJwt()` after a 401
 * surface from any t07-op).
 */
export function clearJwt(): void {
  setJwt(null);
}

/**
 * Subscribe to JWT changes. The callback fires once on each subsequent
 * `setJwt` / `clearJwt`. Does NOT fire with the current value on
 * subscribe — callers that want the current value should call
 * `getJwt()` immediately after subscribing.
 *
 * Returns an unsubscribe function. Calling it multiple times is a no-op.
 */
export function subscribeToJwt(listener: JwtListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only — reset module state between tests. NEVER call from production code. */
export function __resetForTest(): void {
  currentJwt = null;
  listeners.clear();
}
