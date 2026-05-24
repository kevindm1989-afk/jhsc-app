/**
 * Device fingerprint composition (T19 / D.1).
 *
 * Per F-101 M-101c: the fingerprint is ONLY `navigator.userAgent` +
 * `navigator.platform`. NEVER an IP. NEVER `navigator.connection.*`.
 * NEVER `Sec-CH-UA-Full-Version-List`. NEVER geolocation. NEVER GPU
 * info. NEVER canvas fingerprint. NEVER font enumeration.
 *
 * The string is rendered client-only at D.1 for the user to inspect.
 * It NEVER appears in any structured audit-meta payload sent to the
 * server (the integration test asserts this).
 *
 * @see `.context/threat-model.md` §8.T19 F-101 M-101c
 */

export interface DeviceFingerprint {
  user_agent: string;
  platform: string;
  /** Human-readable composition for rendering. */
  display: string;
}

/**
 * Compose a device-fingerprint shape from the live navigator.
 *
 * The optional `__test_user_agent` override (T19 test-only prop) lets
 * tests inject a UA without touching navigator. Production callers
 * MUST NOT pass this argument (the test-only prop is runtime-stripped
 * per ADR-0020 Decision 8).
 */
export function composeDeviceFingerprint(opts?: {
  user_agent_override?: string;
}): DeviceFingerprint {
  const ua =
    opts?.user_agent_override ??
    (typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown');
  const platform = typeof navigator !== 'undefined' ? navigator.platform || 'unknown' : 'unknown';
  return {
    user_agent: ua,
    platform,
    display: `${ua}\n${platform}`
  };
}
