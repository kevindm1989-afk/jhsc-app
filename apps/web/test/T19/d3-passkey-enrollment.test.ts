/**
 * T19 — D.3 Passkey enrollment (additive to scaffold).
 *
 * Covers:
 *   - F-103 / M-103a — TOTP wrong-attempt rate-limit (≤5 per 15min per user); the 6th locks
 *     the invite and D.3 surfaces a user-readable copy key (no echo of code/identifier)
 *   - F-103 / M-103b — constant-time TOTP comparison preserved through the D.3 composition;
 *     no `===` short-circuit on the TOTP code inside D.3 source
 *   - F-103 / M-103c — collapsed 410/401 user surface: same DOM text for both reasons;
 *     no canary code / canary identifier in the rendered error
 *   - Designer §4 Surface D.T19.f indirectly — D.3 error surface uses error_state pattern
 *   - F-110 / M-110a — TOTP code never appears in the rendered error toast (canary test)
 *
 * Catalog keys exercised:
 *   - onboarding.passkey_d3.{heading, body, totp_label, totp_helper, primary_button}
 *   - onboarding.passkey_d3.error.{totp_invalid, totp_rate_limited, totp_locked,
 *                                  passkey_ceremony_failed, enrollment_failed_generic}
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { freezeClock, restoreClock } from '../_helpers/clock';
import OnboardingFlow from '../../src/lib/onboarding/OnboardingFlow.svelte';
import { t } from '../../src/lib/i18n';
import { existsSync, readFileSync } from 'node:fs';
import { TOTP_WRONG_LIMIT } from '../../src/lib/auth/rate-limit';

const CHROME_130_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

beforeEach(() => {
  freezeClock();
});
afterEach(() => {
  cleanup();
  restoreClock();
});

// ============================================================================
// Happy path — D.3 catalog keys reachable
// ============================================================================

describe('T19 / D.3 — catalog keys reachable', () => {
  it('all D.3 user-facing keys resolve via t() (no [[…]] fallback)', () => {
    expect(t('onboarding.passkey_d3.heading')).not.toMatch(/^\[\[/);
    expect(t('onboarding.passkey_d3.body')).not.toMatch(/^\[\[/);
    expect(t('onboarding.passkey_d3.totp_label')).not.toMatch(/^\[\[/);
    expect(t('onboarding.passkey_d3.totp_helper')).not.toMatch(/^\[\[/);
    expect(t('onboarding.passkey_d3.primary_button')).not.toMatch(/^\[\[/);
    expect(t('onboarding.passkey_d3.continue_button')).not.toMatch(/^\[\[/);
  });

  it('all D.3 error keys resolve via t()', () => {
    expect(t('onboarding.passkey_d3.error.totp_invalid')).not.toMatch(/^\[\[/);
    expect(t('onboarding.passkey_d3.error.totp_rate_limited')).not.toMatch(/^\[\[/);
    expect(t('onboarding.passkey_d3.error.totp_locked')).not.toMatch(/^\[\[/);
    expect(t('onboarding.passkey_d3.error.passkey_ceremony_failed')).not.toMatch(/^\[\[/);
    expect(t('onboarding.passkey_d3.error.enrollment_failed_generic')).not.toMatch(/^\[\[/);
    expect(t('onboarding.passkey_d3.error.rp_mismatch')).not.toMatch(/^\[\[/);
  });
});

// ============================================================================
// F-103 M-103a — TOTP rate-limit surfaces the totp_locked copy after threshold
// ============================================================================

describe('T19 / F-103 M-103a — TOTP rate-limit surfaced at D.3', () => {
  it('D.3 source consumes onboarding.passkey_d3.error.totp_locked when rate-limit fires (catalog key reference)', () => {
    const path = '/home/user/agent-os/apps/web/src/lib/onboarding/steps/D3PasskeyEnrollment.svelte';
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, 'utf8');
    // The component MUST reference the canonical key (so the closed-allowlist
    // CI gate at copy-keys.ts trips on missing entries).
    expect(src).toMatch(/onboarding\.passkey_d3\.error\.totp_locked/);
    expect(src).toMatch(/onboarding\.passkey_d3\.error\.totp_rate_limited/);
  });

  it('rate-limit threshold constant from lib/auth/rate-limit matches F-38 = 5 (TOTP_WRONG_LIMIT)', () => {
    // Defense-in-depth: T19 composes against the existing T05 rate-limit constants;
    // a future change that weakens TOTP_WRONG_LIMIT must trip this test.
    expect(TOTP_WRONG_LIMIT).toBe(5);
  });

  it('the user-facing totp_locked copy directs the user to ask their worker co-chair for a new invite', () => {
    const copy = t('onboarding.passkey_d3.error.totp_locked');
    expect(copy).toMatch(/co-?chair/i);
    expect(copy).toMatch(/invite|new code|send/i);
  });
});

// ============================================================================
// F-103 M-103b — constant-time TOTP compare; no `===` near totp/code in D.3 source
// ============================================================================

describe('T19 / F-103 M-103b — D.3 source does not use `===` on the TOTP code', () => {
  it('D.3 source has zero occurrences of `===` on the same line as `totp` and `code`', () => {
    const path = '/home/user/agent-os/apps/web/src/lib/onboarding/steps/D3PasskeyEnrollment.svelte';
    const src = readFileSync(path, 'utf8');
    const lines = src.split('\n');
    const offenders = lines.filter(
      (l, idx) =>
        // Skip comments + strip-comment region to avoid documentation false-positives.
        !/^\s*\/\//.test(l) &&
        /===/.test(l) &&
        /\btotp\b/i.test(l) &&
        /\bcode\b/i.test(l) &&
        // Allow the assertion line in case the implementer writes a defensive
        // comment "// MUST NOT use === on totp code".
        idx >= 0
    );
    expect(
      offenders,
      `D3PasskeyEnrollment uses === on a totp+code line:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});

// ============================================================================
// F-103 M-103c — collapsed 410/401 user surface
// ============================================================================

describe('T19 / F-103 M-103c — collapsed user-visible 410/401 surface', () => {
  it('the catalog provides exactly one generic enrollment_failed key for collapsed 410/401', () => {
    // M-103c — D.3 surfaces a SINGLE generic copy regardless of underlying reason.
    const generic = t('onboarding.passkey_d3.error.enrollment_failed_generic');
    expect(generic).not.toMatch(/^\[\[/);
    expect(generic).toMatch(/.+/);
    // The user-visible string MUST NOT distinguish "expired" vs "consumed" verbatim
    // (G-T05-11 differential remains open at the network layer, but the rendered
    // string is intentionally collapsed).
    expect(generic.toLowerCase()).not.toMatch(/\bexpired\b/);
    expect(generic.toLowerCase()).not.toMatch(/\bconsumed\b/);
  });

  it('D.3 source references the collapsed-error key (closed-allowlist consumption)', () => {
    const path = '/home/user/agent-os/apps/web/src/lib/onboarding/steps/D3PasskeyEnrollment.svelte';
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/onboarding\.passkey_d3\.error\.enrollment_failed_generic/);
  });
});

// ============================================================================
// F-110 M-110a — TOTP code canary never lands in the rendered error toast
// ============================================================================

describe('T19 / F-110 M-110a — D.3 error rendering does not echo the TOTP code', () => {
  it('with a baseline-pass UA, the D.3 surface renders the totp input WITHOUT exposing the entered value in the error', async () => {
    render(OnboardingFlow, {
      props: { __test_user_agent: CHROME_130_UA, __test_step: 'D.3' }
    });
    const totpInput = screen.getByRole('textbox', { name: /one-time code|invite slip|totp/i });
    // Inject a canary code; in any error state the rendered toast/alert text
    // must NOT contain the canary.
    const CANARY = '987654';
    fireEvent.input(totpInput, { target: { value: CANARY } });

    // Click "Set up passkey now" — the WebAuthn ceremony will fail in jsdom
    // (no PublicKeyCredential); an error surface appears.
    const start = screen.getByRole('button', { name: /set up passkey/i });
    fireEvent.click(start);

    // Scan every role=alert / role=status / [data-testid=enrollment-error] block.
    const surfaces = Array.from(
      document.querySelectorAll('[role="alert"], [role="status"], [data-testid="enrollment-error"]')
    );
    for (const s of surfaces) {
      expect(s.textContent ?? '').not.toContain(CANARY);
    }
  });
});

// ============================================================================
// D.3 input attributes — totp input does not invite paste-history leak
// ============================================================================

describe('T19 / D.3 — totp input attributes', () => {
  it('totp input has autocomplete="one-time-code" (or "off"); never "username"/"current-password"', async () => {
    render(OnboardingFlow, {
      props: { __test_user_agent: CHROME_130_UA, __test_step: 'D.3' }
    });
    const totp = screen.getByRole('textbox', { name: /one-time code|invite slip|totp/i });
    const ac = totp.getAttribute('autocomplete') ?? '';
    expect(['one-time-code', 'off']).toContain(ac);
  });

  it('totp input has inputmode="numeric" (mobile keyboard hint)', async () => {
    render(OnboardingFlow, {
      props: { __test_user_agent: CHROME_130_UA, __test_step: 'D.3' }
    });
    const totp = screen.getByRole('textbox', { name: /one-time code|invite slip|totp/i });
    expect(totp.getAttribute('inputmode')).toBe('numeric');
  });
});
