/**
 * ADR-0029 P1-8c — co-chair invite one-time-code helpers (Surface K screens 2/4).
 *
 * Two load-bearing constants/functions the invite + re-send UI depends on:
 *
 *   - `INVITE_TTL_MINUTES` (10080 = 7 days): the value the co-chair UI passes as
 *     `issueInvite({ ttl_minutes })`. This sets the INVITE's `expires_at`
 *     (the 7-day validity window), NOT the 15-minute server-fixed TOTP bootstrap
 *     window — passing 15 here would expire the whole invite in 15 minutes and
 *     break the "invite Monday, redeem Thursday" model (orchestrator resolution
 *     2026-07-13; design-system.md Surface K Open-question #2).
 *
 *   - `generateInviteCode()`: mint the 6-digit one-time code CLIENT-SIDE from a
 *     CSPRNG. F-176 / Decision 8: the code is created + held in memory on the
 *     co-chair's device and rides `issueInvite`/`reissueTotp` to the Edge
 *     Function; it is never logged, persisted, or put in a URL. The entropy
 *     source MUST be `crypto.getRandomValues` — never `Math.random` (which is
 *     not a CSPRNG). Rejection sampling removes the modulo bias so all
 *     1,000,000 codes are equiprobable (leading zeros preserved).
 */

/** The 7-day INVITE validity window in minutes (NOT the 15-min TOTP window). */
export const INVITE_TTL_MINUTES = 10080;

/** Number of decimal codes: 000000–999999. */
const CODE_SPACE = 1_000_000;
/** 2^32 — the exclusive upper bound of a Uint32 draw. */
const UINT32_CEIL = 4_294_967_296;
/**
 * Largest multiple of CODE_SPACE that fits under UINT32_CEIL. Draws at or above
 * this bound are rejected so `% CODE_SPACE` is unbiased (uniform).
 */
const UNBIASED_BOUND = UINT32_CEIL - (UINT32_CEIL % CODE_SPACE);

/**
 * Mint a uniformly-random 6-digit one-time code as a zero-padded string.
 * Uses `crypto.getRandomValues` (CSPRNG) with rejection sampling; NEVER
 * `Math.random`. Returns e.g. "482917" or "007420" (leading zeros kept).
 */
export function generateInviteCode(): string {
  const draw = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(draw);
    n = draw[0]!;
  } while (n >= UNBIASED_BOUND);
  return String(n % CODE_SPACE).padStart(6, '0');
}
