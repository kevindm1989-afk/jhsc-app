/**
 * Edge Function session-liveness pre-check (ADR-0023 Amendment A).
 *
 * Source obligations:
 *   - ADR-0023 Amendment A §1 (F-116 enforcement uniformity is
 *     structural via CI grep) — every privileged op dispatcher MUST
 *     call this helper at the top, OR be on the MINT_SESSION_PATHS
 *     allowlist (which mint-session/index.ts is, compensated by
 *     F-128's post-mint EXISTS check).
 *   - threat-model.md §3.14 F-116 / F-121 / F-122 (testable mitigations).
 *
 * The check:
 *   1. Read the JWT from the caller's Authorization header.
 *   2. Decode the `session_id` claim (the jti).
 *   3. Call `session_is_live()` against the project DB. The function
 *      reads `request.jwt.claims->>session_id` server-side so it
 *      cannot be lied to from the caller side; it returns boolean.
 *   4. False ⇒ throw SessionNotLiveError (the dispatcher converts to
 *      401 + emits the structured "session_not_live" log line); true ⇒
 *      return cleanly.
 *
 * The pre-check is BELT-AND-BRACES with the existing SECURITY DEFINER
 * RPCs that also check `session_is_live()` internally (per migrations
 * 0002, 0004, 0005). The dispatcher-side check fails fast on a
 * revoked session BEFORE the dispatcher does any other DB round-trip
 * (saves work) and provides a single, regrep-able choke point the CI
 * grep can enforce structurally.
 *
 * Per-process state: none. The check runs on every dispatch (no
 * memoisation — a revoked session must lose access immediately, and
 * memoising the result would defeat the F-39 5s propagation contract).
 */

import { isMintSessionPath, MINT_SESSION_PATHS as _AllowlistMarker } from './session-live-allowlist.ts';

// Marker import so a future allowlist refactor that renames the
// export breaks this file too — keeps the two surfaces in lockstep.
void _AllowlistMarker;
void isMintSessionPath;

/**
 * Sentinel error class. Dispatchers catch this and return 401.
 */
export class SessionNotLiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionNotLiveError';
  }
}

/**
 * Caller-supplied surface for invoking `session_is_live()` on the
 * project DB. The dispatcher passes a callable bound to its existing
 * JWT-bound supabase client (which sets `request.jwt.claims` for the
 * SECURITY DEFINER function to read).
 */
export type SessionIsLiveFetcher = () => Promise<boolean>;

/**
 * Dispatcher-side session-liveness precheck.
 *
 * Usage in an EF dispatcher:
 *
 *   await assertSessionLive(() => supabase.rpc('session_is_live')
 *     .then(r => r.data === true));
 *
 * Place this call AT THE TOP of each privileged op handler, BEFORE
 * the first `await this.deps.X(...)` / `await supabase.rpc(...)` call
 * (per the CI grep's structural assertion in
 * `scripts/verify-session-live-uniformity.sh`).
 *
 * On false ⇒ throws SessionNotLiveError. The dispatcher's catch path
 * returns 401 + emits structured `session_not_live` log line. The
 * caller's client retries with a fresh assertion (re-mint flow).
 */
export async function assertSessionLive(
  fetchSessionIsLive: SessionIsLiveFetcher
): Promise<void> {
  let live: boolean;
  try {
    live = await fetchSessionIsLive();
  } catch (e) {
    // Fail-closed: an RPC error returns 401 (we cannot prove
    // liveness ⇒ treat as not-live). Same outcome as actual revocation.
    throw new SessionNotLiveError(
      `session_is_live RPC failed; treating as not-live (fail-closed). ` +
        `cause: ${e instanceof Error ? e.constructor.name : 'Error'}`
    );
  }
  if (!live) {
    throw new SessionNotLiveError('session_is_live() returned false; session revoked or expired');
  }
}
