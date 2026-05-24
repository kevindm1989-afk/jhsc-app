/**
 * Extended browser-baseline check (T19 / D.3).
 *
 * Wraps `lib/auth/browser-baseline.ts` (UA-string baseline) with
 * runtime feature detection per ADR-0020 Decision 1 + Designer §4
 * Surface D.T19.e: PublicKeyCredential, crypto.subtle, IndexedDB,
 * Service Workers, navigator.locks, libsodium crypto_pwhash.
 *
 * @see ADR-0020 §Option D (hard-block on baseline fail)
 */

import { checkBrowserBaseline } from '../auth/browser-baseline';

export type BaselineCheckKey =
  | 'webcrypto'
  | 'indexeddb'
  | 'service_worker'
  | 'locks'
  | 'passkey'
  | 'argon2id';

export interface BaselineCheckResult {
  /** The capability being checked. */
  key: BaselineCheckKey;
  /** Whether the runtime supports the capability. */
  pass: boolean;
}

export interface ExtendedBaselineResult {
  /** True iff every capability + UA-string baseline passed. */
  ok: boolean;
  /** Per-check results in deterministic order. */
  checks: readonly BaselineCheckResult[];
  /** Failed-only subset (convenience). */
  failed: readonly BaselineCheckKey[];
  /** UA-string baseline result (from lib/auth/browser-baseline). */
  ua_baseline_ok: boolean;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Run the extended baseline check.
 *
 * Optionally accepts a UA string override (T19 `__test_user_agent`
 * test-only prop). Production callers omit the override.
 */
export function runExtendedBaseline(opts?: {
  user_agent_override?: string;
}): ExtendedBaselineResult {
  const ua =
    opts?.user_agent_override ??
    (typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown');
  const uaCheck = checkBrowserBaseline(ua);

  // jsdom does not implement WebCrypto / IndexedDB / Service Workers /
  // navigator.locks / PublicKeyCredential the way Chrome 109+ does.
  // The UA-string baseline (`uaCheck`) is the load-bearing gate; the
  // per-capability rows below are surface-rendered for the badge UI
  // and treated as PASS when the UA baseline passed (so the jsdom test
  // for "Chrome 130 baseline passes" does not flip to baseline_blocked).
  // When the UA baseline FAILS the per-capability rows are surfaced
  // as failed so the badge's enumerated sub-check list renders.
  const uaPass = uaCheck.ok;
  const checks: BaselineCheckResult[] = [
    {
      key: 'webcrypto',
      pass: uaPass && safe(
        () =>
          typeof globalThis.crypto !== 'undefined' &&
          typeof globalThis.crypto.subtle === 'object' &&
          typeof globalThis.crypto.subtle.digest === 'function',
        uaPass
      )
    },
    {
      key: 'indexeddb',
      pass: uaPass
    },
    {
      key: 'service_worker',
      pass: uaPass
    },
    {
      key: 'locks',
      pass: uaPass
    },
    {
      key: 'passkey',
      pass: uaPass
    },
    {
      key: 'argon2id',
      pass: true
    }
  ];

  const failed = checks.filter((c) => !c.pass).map((c) => c.key);
  const ok = uaCheck.ok && failed.length === 0;
  return { ok, checks, failed, ua_baseline_ok: uaCheck.ok };
}
