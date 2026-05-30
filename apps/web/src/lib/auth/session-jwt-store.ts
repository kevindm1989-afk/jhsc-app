/**
 * In-memory session JWT store — the production source of truth for the
 * current GoTrue access_token.
 *
 * Production callers (`createSupabaseT07Client`, the /sign-in route,
 * the /settings route, the landing page) read the current JWT via
 * `getJwt()` and subscribe to changes via `subscribeToJwt(cb)`. The
 * sign-in flow calls `setJwt(token)` after mint-session succeeds;
 * "Sign out" calls `clearJwt()`.
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
 * Cross-tab synchronization (this PR): each browser tab loads its
 * own copy of this module, so a sign-in / sign-out in tab B does not
 * by itself change tab A's `currentJwt`. Without sync, tab A would
 * only learn about the sign-out via the next t07-op call returning
 * 401 (then F-39 → onSessionRevoked → clearJwt → subscribers). That
 * is functionally correct but has a perceptible lag.
 *
 * `BroadcastChannel` (same-origin, in-memory) closes that lag: every
 * `setJwt`/`clearJwt` posts the new value to the `jhsc-session-jwt`
 * channel; inbound messages from sibling tabs apply the value
 * LOCALLY (no re-broadcast — see `__applyRemote` below) so a
 * sign-out broadcasts once and ripples through every tab's
 * subscribers in lockstep.
 *
 * The broadcast payload is the JWT string (or null). Same-origin
 * BroadcastChannel is in-memory and equivalent in trust to the
 * module's own `currentJwt`. A browser without BroadcastChannel
 * (older / non-standard environments) silently falls back to the
 * per-tab posture — the F-39 401-loop still catches stale tabs,
 * just on the original lag.
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
 *   - Cross-tab: a BroadcastChannel post applies the value locally
 *     without re-broadcasting (no infinite ping-pong).
 */

type JwtListener = (jwt: string | null) => void;

const BROADCAST_CHANNEL_NAME = 'jhsc-session-jwt';

let currentJwt: string | null = null;
const listeners = new Set<JwtListener>();

// BroadcastChannel handle — `null` when the runtime doesn't have the
// API (defensive: older browsers, jsdom without polyfill). Initialised
// lazily on first `setJwt`/`clearJwt`/`subscribeToJwt` call to avoid
// module-load-time side effects.
let channel: BroadcastChannel | null = null;
let channelInitialised = false;

function ensureChannel(): void {
  if (channelInitialised) return;
  channelInitialised = true;
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent) => {
      // Inbound from a sibling tab — apply locally WITHOUT
      // re-broadcasting (would create an infinite ping-pong) and
      // WITHOUT skipping the subscriber notification (the whole
      // point of the cross-tab sync is for sibling tabs' UI to
      // react). Defensive: validate the payload shape; a foreign
      // sender could in principle post arbitrary data.
      const data = event.data as { jwt?: unknown } | null | undefined;
      if (!data || typeof data !== 'object') return;
      const incoming = data.jwt;
      if (incoming !== null && typeof incoming !== 'string') return;
      __applyLocal(incoming);
    };
  } catch {
    // Channel construction failed (e.g. SecurityError in some
    // sandboxed contexts). Fall back to per-tab posture.
    channel = null;
  }
}

/**
 * Apply a JWT value to the local store + fire subscribers, WITHOUT
 * broadcasting to other tabs. Used both by the inbound message
 * handler and (transitively) by `setJwt` after it has broadcast.
 */
function __applyLocal(jwt: string | null): void {
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

/** Read the current JWT, or `null` when the caller is unauthenticated. */
export function getJwt(): string | null {
  return currentJwt;
}

/**
 * Set the current JWT. Pass `null` (or use `clearJwt()`) to sign out.
 * Notifies subscribers synchronously; throwing subscribers are isolated
 * via try/catch so a buggy listener cannot break the broadcast. Also
 * posts to the cross-tab `jhsc-session-jwt` BroadcastChannel so
 * sibling tabs reflect the change in lockstep.
 */
export function setJwt(jwt: string | null): void {
  ensureChannel();
  // Broadcast FIRST so sibling tabs apply in parallel with our local
  // subscribers. Defensive: a throw from postMessage (e.g. the channel
  // was unexpectedly closed) must not block local apply.
  if (channel) {
    try {
      channel.postMessage({ jwt });
    } catch {
      // ignore — local apply still happens below.
    }
  }
  __applyLocal(jwt);
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
 * `setJwt` / `clearJwt` (whether local or inbound from a sibling tab).
 * Does NOT fire with the current value on subscribe — callers that
 * want the current value should call `getJwt()` immediately after
 * subscribing.
 *
 * Returns an unsubscribe function. Calling it multiple times is a no-op.
 */
export function subscribeToJwt(listener: JwtListener): () => void {
  ensureChannel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only — reset module state between tests. NEVER call from production code. */
export function __resetForTest(): void {
  currentJwt = null;
  listeners.clear();
  if (channel) {
    try {
      channel.close();
    } catch {
      // ignore
    }
  }
  channel = null;
  channelInitialised = false;
}
