/**
 * Minimum-browser-baseline gate (ADR-0002 Operational rules; T19 onboarding D.3).
 *
 * Per the test suite obligations:
 *   - Safari 15.6 (below 16.4) is blocked with reason_key
 *     `onboarding.browser.unsupported_heading`.
 *   - Chrome 130 (above 109) is supported.
 *
 * Baselines were chosen so WebAuthn discoverable credentials (passkeys) are
 * available on the device without polyfill. Sources: webauthn.io support
 * matrix; passkeys.dev compatibility chart.
 *
 * The detection is intentionally minimal — UA string parsing is enough to
 * gate. The detailed feature-detection at runtime (presence of
 * `PublicKeyCredential`, `isConditionalMediationAvailable`, etc.) lives in
 * `passkey-enroll.ts`.
 */
import type { BrowserBaselineCheck } from './types';

interface BaselineRow {
  /** Regex that matches the engine + product version in a UA. */
  matcher: RegExp;
  /** Minimum version for this engine. */
  minVersion: number;
}

// Order matters — most specific first. iOS Safari and Chrome are detected
// before generic Safari/Chrome strings.
const BASELINES: BaselineRow[] = [
  // Edge — Chromium-based; same baseline as Chrome.
  { matcher: /Edg\/(\d+)/, minVersion: 109 },
  // Chrome (must be tested before Safari because Chrome UA contains "Safari").
  { matcher: /Chrome\/(\d+)/, minVersion: 109 },
  // Firefox.
  { matcher: /Firefox\/(\d+)/, minVersion: 122 },
  // Safari (desktop or iOS) — `Version/x.y Safari/...`. Strip the major.
  { matcher: /Version\/(\d+)(?:\.\d+)?\s+Safari/, minVersion: 16 }
];

export function checkBrowserBaseline(userAgent: string): BrowserBaselineCheck {
  for (const row of BASELINES) {
    const m = userAgent.match(row.matcher);
    if (m && typeof m[1] === 'string') {
      const ver = Number.parseInt(m[1], 10);
      if (Number.isFinite(ver) && ver >= row.minVersion) {
        return { ok: true };
      }
      return { ok: false, reason_key: 'onboarding.browser.unsupported_heading' };
    }
  }
  // Unknown UA — default to unsupported.
  return { ok: false, reason_key: 'onboarding.browser.unsupported_heading' };
}
