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
   * Returns true when this failure crosses the 10-in-5-min threshold for
   * the first time in the rolling window.
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
    return arr.length >= FAILURE_BURST_THRESHOLD;
  }

  reset(): void {
    this.webauthn.clear();
    this.totp.clear();
    this.failureBurst.clear();
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
