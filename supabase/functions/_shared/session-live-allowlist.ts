/**
 * Edge Function paths exempt from the per-dispatcher `session_is_live`
 * precheck (ADR-0023 Amendment A / F-122).
 *
 * The mint paths are the ONE legitimate exemption: they are how a
 * caller acquires a live session in the first place, so pre-checking
 * `session_is_live(jti)` is tautological — the jti either doesn't
 * exist yet (challenge) or was just minted by the same dispatcher
 * (assert). Both paths are compensated by F-128 (the post-mint
 * EXISTS check in `mint-session/index.ts`) which closes the TOCTOU
 * race the absence of the precheck would otherwise open.
 *
 * Expanding this list requires a successor ADR-0023 amendment. No
 * expansion via comment, no expansion via global pattern, no
 * `// allowlist: ...` annotations. The constant is named, exact, and
 * reviewed.
 *
 * The `scripts/verify-session-live-uniformity.sh` CI grep reads BOTH
 * this file AND its embedded allowlist (a drift assertion catches the
 * case where one is updated without the other).
 */

// F-122: closed allowlist of EF paths exempt from the session_is_live
// precheck. The compensating control for these paths is F-128 (the
// post-mint EXISTS check in mint-session/index.ts) which closes the
// TOCTOU race against concurrent revoke_all_sessions.
export const MINT_SESSION_PATHS: readonly string[] = [
  'mint-session/challenge',
  'mint-session/assert',
] as const;

/**
 * Type-level guarantee that the array is read-only — defense in depth
 * against a runtime mutation that would skirt the closed-set invariant.
 */
export type MintSessionPath = (typeof MINT_SESSION_PATHS)[number];

/**
 * True when the given path is on the closed allowlist. The path is
 * the EF directory slug + the op verb (e.g. 'mint-session/assert').
 */
export function isMintSessionPath(p: string): boolean {
  return (MINT_SESSION_PATHS as readonly string[]).includes(p);
}
