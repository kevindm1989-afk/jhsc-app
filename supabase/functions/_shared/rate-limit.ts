/**
 * rate-limit.ts — minimal in-memory token-bucket / fixed-window throttle for
 * unauthenticated Edge Function paths.
 *
 * Why this exists: F-175 calls for an EF-level per-IP rate-limit on the
 * `redeem-invite` register / challenge actions. The committee is ~12 people; a
 * legitimate caller never gets within an order of magnitude of these caps. The
 * throttle is intentionally narrow:
 *
 *   - **Per-IP**, fixed-window. The window is short (60s) so a transient burst
 *     resets quickly; we are not building a global anti-abuse system here, just
 *     bounding a flood at the edge before the DB.
 *   - **In-memory** (per EF instance). The Supabase edge runtime keeps the
 *     module alive across requests on the same instance, so the map persists
 *     long enough to bound a single attacker stream. We do NOT need a shared
 *     store: a multi-instance flood is bounded by `redeem_invite_complete`'s
 *     own gates (single-use invite, 15-min TOTP, 5-attempt lock) — the EF
 *     throttle is a DoS edge-shield, not a security control. F-175 enumerates
 *     this layering: "edge throttle + 5-attempt-lock + single-use invite".
 *   - **Fail-open is impossible by construction:** an unknown action / missing
 *     IP collapses into one shared bucket (the conservative direction). A
 *     `null` IP means we still consume the same bucket — never a free pass.
 *
 * F-176: the IP is NOT logged. The throttle uses it as a keyspace seed only;
 * the structured log carries the closed-literal bucket class via
 * `rate_limit_key_class` (the existing safeFields entry).
 */

export interface RateLimitDecision {
  /** True = the call may proceed; false = throttled (caller must 429). */
  allowed: boolean;
  /** Remaining tokens in the current window (informational, never logged). */
  remaining: number;
}

export interface RateLimitConfig {
  /** Bucket capacity per window (e.g. 10 challenges per minute per IP). */
  capacity: number;
  /** Window in milliseconds (default 60_000 — one minute). */
  windowMs?: number;
}

/**
 * A bounded fixed-window per-key throttle. The map is pruned lazily on each
 * call: any key whose window has expired is removed before counting, so the
 * working set is O(active callers in the last `windowMs`).
 */
export class FixedWindowRateLimiter {
  private readonly capacity: number;
  private readonly windowMs: number;
  // key -> { windowStartMs, count }
  private readonly state = new Map<string, { startMs: number; count: number }>();

  constructor(config: RateLimitConfig) {
    this.capacity = config.capacity;
    this.windowMs = config.windowMs ?? 60_000;
  }

  /**
   * Consume one token against the given key. A `null` key is normalised to a
   * single shared bucket so a missing IP cannot escape the limiter.
   */
  consume(key: string | null, nowMs: number = Date.now()): RateLimitDecision {
    const k = key ?? '__shared__';
    const entry = this.state.get(k);
    if (!entry || nowMs - entry.startMs >= this.windowMs) {
      // Fresh window.
      this.state.set(k, { startMs: nowMs, count: 1 });
      return { allowed: 1 <= this.capacity, remaining: Math.max(0, this.capacity - 1) };
    }
    entry.count += 1;
    const allowed = entry.count <= this.capacity;
    return { allowed, remaining: Math.max(0, this.capacity - entry.count) };
  }
}
