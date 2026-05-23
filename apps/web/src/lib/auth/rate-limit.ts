/**
 * Token-bucket rate limiter — feeds the A-AUTH-001 alert.
 *
 * Source obligations:
 *   - `.context/threat-model.md` §3.1 F-42 — 10 WebAuthn attempts/min/user;
 *     11th = 429.
 *   - `observability/alerts.md` §1 A-AUTH-001 — 10 auth failures in 5 min from
 *     one actor_pseudonym fires the burst alert.
 *
 * In-process counter; per-process state. In production this is backed by
 * Postgres `auth_rate_limit_counters` (the production-bound migration is
 * `supabase/migrations/00000000000001_auth.sql`), but for in-jsdom tests
 * (per `.context/test-plan.md` §3.J — no real network) we use this module.
 */

interface BucketRow {
  /** Timestamps of failures in the active window (ms epoch). */
  failures: number[];
  /** Timestamps of all attempts in the active 1-minute window. */
  attempts: number[];
}

const ATTEMPT_WINDOW_MS = 60_000; // 1 minute
const ATTEMPT_LIMIT = 10; // 11th attempt → 429
const FAILURE_BURST_WINDOW_MS = 5 * 60_000; // 5 minutes
const FAILURE_BURST_THRESHOLD = 10;
const TOTP_WRONG_LIMIT = 5; // F-38
const TOTP_WRONG_WINDOW_MS = 15 * 60_000;

class BucketStore {
  private webauthn = new Map<string, BucketRow>();
  private totp = new Map<string, BucketRow>();
  /** Per-actor failure burst tracker; fed to the alert dispatcher. */
  private failureBurst = new Map<string, number[]>();
  /**
   * Per-actor "burst is currently active" flag. Used to deduplicate the
   * A-AUTH-001 emission so the alert.fired row is emitted exactly once on
   * the false→true threshold crossing, and re-emits only after the bucket
   * drops back below threshold and rises through it again.
   *
   * Source: security-reviewer A6 / decisions.md amendment-pass-#4
   * "burst-alert duplicates emission" — emit once per threshold crossing.
   */
  private burstActive = new Set<string>();

  private prune(row: BucketRow, now: number, windowMs: number): void {
    row.attempts = row.attempts.filter((t) => now - t < windowMs);
    row.failures = row.failures.filter((t) => now - t < windowMs);
  }

  /** Record a WebAuthn attempt. Returns the new attempt count. */
  recordWebAuthnAttempt(key: string, now: number): number {
    let row = this.webauthn.get(key);
    if (!row) {
      row = { failures: [], attempts: [] };
      this.webauthn.set(key, row);
    }
    this.prune(row, now, ATTEMPT_WINDOW_MS);
    row.attempts.push(now);
    return row.attempts.length;
  }

  /** True if the next WebAuthn attempt should be denied with 429. */
  isWebAuthnLocked(key: string, now: number): boolean {
    const row = this.webauthn.get(key);
    if (!row) return false;
    this.prune(row, now, ATTEMPT_WINDOW_MS);
    return row.attempts.length > ATTEMPT_LIMIT;
  }

  /** Record a TOTP wrong attempt. Returns the wrong-attempt count in window. */
  recordTotpWrongAttempt(key: string, now: number): number {
    let row = this.totp.get(key);
    if (!row) {
      row = { failures: [], attempts: [] };
      this.totp.set(key, row);
    }
    this.prune(row, now, TOTP_WRONG_WINDOW_MS);
    row.failures.push(now);
    return row.failures.length;
  }

  isTotpLocked(key: string, now: number): boolean {
    const row = this.totp.get(key);
    if (!row) return false;
    this.prune(row, now, TOTP_WRONG_WINDOW_MS);
    return row.failures.length >= TOTP_WRONG_LIMIT;
  }

  /**
   * Track an authentication failure for the A-AUTH-001 burst alert.
   * Returns true ONLY on the false→true transition (first failure that
   * crosses the 10-in-5-min threshold within the rolling window). While
   * the burst is active subsequent failures return false. When the window
   * drains below threshold the active flag is cleared so the next crossing
   * fires a fresh alert.
   *
   * Source: security-reviewer A6 — emit once per threshold crossing.
   */
  recordAuthFailureForBurst(key: string, now: number): boolean {
    let arr = this.failureBurst.get(key);
    if (!arr) {
      arr = [];
      this.failureBurst.set(key, arr);
    }
    // Prune.
    const cutoff = now - FAILURE_BURST_WINDOW_MS;
    while (arr.length > 0 && (arr[0] ?? Infinity) < cutoff) arr.shift();
    arr.push(now);
    const overThreshold = arr.length >= FAILURE_BURST_THRESHOLD;
    if (!overThreshold) {
      // Bucket drained below threshold — clear the active flag so the next
      // crossing fires.
      if (this.burstActive.has(key)) this.burstActive.delete(key);
      return false;
    }
    // Over threshold. Fire only on the false→true transition.
    if (this.burstActive.has(key)) return false;
    this.burstActive.add(key);
    return true;
  }

  /** Test/inspection: is the burst-active flag set for this actor? */
  isBurstActive(key: string): boolean {
    return this.burstActive.has(key);
  }

  /** Mark burst-active for this actor. */
  markBurstActive(key: string): void {
    this.burstActive.add(key);
  }

  /** Clear burst-active for this actor; next crossing will fire again. */
  clearBurstActive(key: string): void {
    this.burstActive.delete(key);
  }

  reset(): void {
    this.webauthn.clear();
    this.totp.clear();
    this.failureBurst.clear();
    this.burstActive.clear();
  }
}

export const rateLimitStore = new BucketStore();

export {
  ATTEMPT_WINDOW_MS,
  ATTEMPT_LIMIT,
  FAILURE_BURST_WINDOW_MS,
  FAILURE_BURST_THRESHOLD,
  TOTP_WRONG_LIMIT,
  TOTP_WRONG_WINDOW_MS
};
