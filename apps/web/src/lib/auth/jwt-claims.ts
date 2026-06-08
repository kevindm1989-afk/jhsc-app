/**
 * JWT-claims helper — decode the `sub` / `jti` / `exp` claims out of a
 * GoTrue-issued access token so the client can answer "who am I?" and
 * "which session is this?" without round-tripping the server.
 *
 * Decode-only — there is NO signature verification here. The server is
 * the trust boundary: every protected endpoint re-verifies the JWT via
 * Supabase's JWKS-based check. Client-side decoding is purely for UI
 * affordances (e.g., "this is my current session" highlight in the
 * sessions list) and MUST NOT be treated as authoritative for any
 * security decision.
 *
 * Why a custom decoder instead of pulling jose / jsonwebtoken?
 *   - Bundle hygiene — those packages drag in pem parsers, EC math,
 *     and Buffer shims we don't need for unverified base64url decode.
 *   - The verify-no-third-party-js bundle gate stays cleanest with
 *     zero new runtime deps.
 *   - The implementation is ~10 lines of base64url + JSON.parse.
 *
 * The two helpers exposed:
 *   - decodeJwtClaims(jwt) — returns the parsed payload as a record,
 *     or null if the token is malformed.
 *   - getCurrentUserId() — convenience over getJwt() + decodeJwtClaims
 *     that returns the active user_id (sub claim) or null if no JWT.
 */

import { getJwt } from './session-jwt-store';

/** Minimal shape of a Supabase GoTrue access-token payload. */
export interface JwtClaims {
  /** Subject — Supabase user_id (uuid). */
  sub?: string;
  /** JWT ID — the auth_sessions.session_id this token corresponds to. */
  jti?: string;
  /** Issued-at (epoch seconds, NOT ms — JWT convention). */
  iat?: number;
  /** Expiry (epoch seconds). */
  exp?: number;
  /** Role (`authenticated` for end users). */
  role?: string;
  /** Free-form additional claims. */
  [key: string]: unknown;
}

/**
 * Decode a JWT's payload without verifying its signature.
 * Returns the parsed claims object, or `null` if the token is
 * malformed (wrong segment count, non-base64url payload, non-JSON
 * payload, etc.).
 *
 * SAFETY: the returned claims are UNVERIFIED. Treat them as
 * UI-only hints; never as a security decision.
 */
export function decodeJwtClaims(jwt: string | null | undefined): JwtClaims | null {
  if (!jwt || typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const payloadSeg = parts[1];
  if (!payloadSeg) return null;
  try {
    // base64url → base64 (RFC 7515 §2): replace -/_ with +/, pad to 4.
    let b64 = payloadSeg.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4;
    if (pad === 2) b64 += '==';
    else if (pad === 3) b64 += '=';
    else if (pad !== 0) return null;
    const json =
      typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('utf-8');
    const parsed = JSON.parse(json) as JwtClaims;
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Convenience over getJwt() + decodeJwtClaims — returns the current
 * user_id (sub claim) of the in-memory access token, or null if no
 * token is set or the token is malformed.
 *
 * Used by UI surfaces that need to scope a query to the caller (e.g.,
 * SessionsList calls listActiveSessions(getCurrentUserId())).
 */
export function getCurrentUserId(): string | null {
  const claims = decodeJwtClaims(getJwt());
  if (!claims || typeof claims.sub !== 'string' || claims.sub.length === 0) {
    return null;
  }
  return claims.sub;
}

/**
 * Convenience — returns the current session_id (jti claim) of the
 * in-memory access token, or null. Used by SessionsList to highlight
 * the row corresponding to the CURRENT browser session.
 */
export function getCurrentSessionId(): string | null {
  const claims = decodeJwtClaims(getJwt());
  if (!claims || typeof claims.jti !== 'string' || claims.jti.length === 0) {
    return null;
  }
  return claims.jti;
}
