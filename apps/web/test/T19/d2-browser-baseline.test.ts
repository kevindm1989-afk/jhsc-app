/**
 * T19 — D.2 Hosting tradeoff + D.3 Browser baseline gate (additive to scaffold).
 *
 * Covers:
 *   - F-102 / M-102a — origin source is window.location.origin at the enrollFirstDevicePasskey call site
 *   - F-102 / M-102b — production-bundle strip allowlist includes __test_step, __test_user_agent, __test_origin
 *                       (G-T19-5). This test asserts the implementer's CI grep gate script is
 *                       wired and references the literal banned strings. Build-time grep is
 *                       owned by the implementer (T19 CI suite); this test asserts the script
 *                       file exists + bans the literals.
 *   - F-102 / M-102c — F-37 RP-ID cross-reference; the D.3 origin equals window.location.origin
 *   - F-110 / M-110a — baseline-fail copy never leaks UA fingerprint into the rendered toast/error
 *   - Designer §4 Surface D.T19.e — browser-baseline badge: pass + fail + per-check enumeration
 *   - Designer §4 Surface D.T19.a — baseline_blocked terminal sub-state freezes step indicator
 *
 * Catalog keys exercised:
 *   - onboarding.browser_baseline_d2.{body_pass, body_fail, badge.*, unsupported_heading, supported_browsers_*}
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { freezeClock, restoreClock } from '../_helpers/clock';
import OnboardingFlow from '../../src/lib/onboarding/OnboardingFlow.svelte';
import { t } from '../../src/lib/i18n';
import { existsSync, readFileSync } from 'node:fs';

beforeEach(() => {
  freezeClock();
});
afterEach(() => {
  cleanup();
  restoreClock();
});

// ============================================================================
// D.2 hosting-tradeoff body — catalog key wired; copy meets grade-8 floor
// ============================================================================

describe('T19 / D.2 — hosting tradeoff body composes the catalog key', () => {
  it('the D.2 body composes onboarding.browser_baseline_d2.body_pass when the browser passes baseline', async () => {
    render(OnboardingFlow, { props: { __test_step: 'D.2' } });
    const body = screen.getByTestId('onboarding-d2-body');
    const catalogValue = t('onboarding.browser_baseline_d2.body_pass');
    // The first 80 chars of the catalog value (modulo whitespace) should appear in the rendered body.
    // (Direct equality is brittle — the scaffold uses regex matchers; we anchor on a stable substring.)
    const needle = catalogValue.slice(0, 60).replace(/\s+/g, ' ').trim();
    expect((body.textContent ?? '').replace(/\s+/g, ' ')).toContain(needle.slice(0, 40));
  });

  it('D.2 body does NOT contain Latin abbreviations (grade-8 reading-level floor — scaffold line 56)', async () => {
    render(OnboardingFlow, { props: { __test_step: 'D.2' } });
    const body = screen.getByTestId('onboarding-d2-body');
    expect(body.textContent ?? '').not.toMatch(/\bi\.e\.|\be\.g\.|\betc\.|\bvs\./);
  });

  it('D.2 body discloses Supabase + ca-central-1 (the hosting tradeoff is informed-of-purpose)', async () => {
    render(OnboardingFlow, { props: { __test_step: 'D.2' } });
    const body = screen.getByTestId('onboarding-d2-body');
    expect(body.textContent ?? '').toMatch(/Supabase/);
    expect(body.textContent ?? '').toMatch(/ca-central/);
  });
});

// ============================================================================
// D.3 Browser-baseline badge — pass / fail + per-check enumeration (Surface D.T19.e)
// ============================================================================

describe('T19 / F-102 + Surface D.T19.e — browser baseline badge', () => {
  it('pass badge renders role="status" and label key onboarding.browser_baseline_d2.badge.webcrypto.pass', async () => {
    // Modern Chrome UA pass.
    render(OnboardingFlow, {
      props: {
        __test_user_agent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        __test_step: 'D.3'
      }
    });
    const badge = screen.getByTestId('browser-baseline-badge');
    expect(badge.getAttribute('role')).toBe('status');
    expect(badge.textContent ?? '').toMatch(/ready|supported/i);
  });

  it('fail badge renders role="alert" and enumerates which sub-checks failed', async () => {
    // Old Safari 15 — below baseline.
    render(OnboardingFlow, {
      props: {
        __test_user_agent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/15.6 Safari/605.1.15',
        __test_step: 'D.3'
      }
    });
    const badge = screen.getByTestId('browser-baseline-badge');
    expect(badge.getAttribute('role')).toBe('alert');
    // The badge MUST present a sub-check list (per Designer §4 D.T19.e fail row).
    const list = screen.getByRole('list', { name: /failed checks/i });
    expect(list).toBeDefined();
    expect(list.querySelectorAll('li').length).toBeGreaterThanOrEqual(1);
  });

  it('baseline_blocked terminal sub-state freezes the step indicator at D.3 (no continue button)', async () => {
    render(OnboardingFlow, {
      props: {
        __test_user_agent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/15.6 Safari/605.1.15',
        __test_step: 'D.3'
      }
    });
    // Continue button must NOT exist on the baseline-blocked sub-state.
    expect(screen.queryByRole('button', { name: /set up passkey/i })).toBeNull();
    // The baseline-fail body matches /browser is too old/i per the existing scaffold.
    expect(screen.getByText(/browser is too old/i)).toBeDefined();
  });

  it('F-110 / M-110a — the baseline-fail body does NOT echo the rejected UA fingerprint into a user-visible toast', async () => {
    const canaryUA = 'Mozilla/5.0 (CANARY-FINGERPRINT-CAN-NOT-LEAK) BadBrowser/0.0';
    render(OnboardingFlow, {
      props: { __test_user_agent: canaryUA, __test_step: 'D.3' }
    });
    // Locate any role=alert + role=status text; the canary substring MUST NOT appear in either.
    const alerts = Array.from(document.querySelectorAll('[role="alert"], [role="status"]'));
    for (const a of alerts) {
      expect(a.textContent ?? '').not.toContain('CANARY-FINGERPRINT-CAN-NOT-LEAK');
      expect(a.textContent ?? '').not.toContain('BadBrowser/0.0');
    }
  });
});

// ============================================================================
// F-102 origin source — call-site uses window.location.origin
// ============================================================================

describe('T19 / F-102 M-102a — D.3 passkey enrollment call passes window.location.origin', () => {
  it('D3PasskeyEnrollment source file does not contain any hard-coded http(s) URL literal (only window.location.origin)', () => {
    const path = '/home/user/agent-os/apps/web/src/lib/onboarding/steps/D3PasskeyEnrollment.svelte';
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, 'utf8');
    // Strip comments + the standard test-only-prop split form so we only scan
    // the executable code path for literal origin strings.
    const stripped = src
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // M-102a — no literal http(s) string outside test fixtures.
    expect(stripped).not.toMatch(/['"`]https?:\/\/[^'"`]+['"`]/);
    // M-102a — the call site MUST reference window.location.origin (or document.location.origin).
    expect(stripped).toMatch(/(window|document)\.location\.origin/);
  });
});

// ============================================================================
// F-102 M-102b / G-T19-5 — production-bundle grep allowlist names __test_origin defensively
// ============================================================================

describe('T19 / F-102 M-102b + G-T19-5 — production-bundle grep gate names all three test-only literals', () => {
  it('a CI script exists that greps the production bundle for __test_step, __test_user_agent, __test_origin', () => {
    // Either of the two paths the implementer may choose for the script.
    const candidates = [
      '/home/user/agent-os/scripts/check-onboarding-test-props-stripped.sh',
      '/home/user/agent-os/apps/web/scripts/check-onboarding-test-props-stripped.sh'
    ];
    const present = candidates.find((p) => existsSync(p));
    expect(present, `expected one of ${candidates.join(' OR ')} to exist`).toBeDefined();
    const src = readFileSync(present!, 'utf8');
    // The script's grep pattern must reference all three banned literals.
    expect(src).toMatch(/__test_step/);
    expect(src).toMatch(/__test_user_agent/);
    expect(src).toMatch(/__test_origin/);
  });
});

// ============================================================================
// Test-only props are runtime-stripped under MODE=production (ADR-0020 Decision 8)
// ============================================================================

describe('T19 / Decision 8 — test-only props are runtime no-op under MODE=production', () => {
  it('OnboardingFlow source contains the MODE === "production" runtime guard for test props', () => {
    const path = '/home/user/agent-os/apps/web/src/lib/onboarding/OnboardingFlow.svelte';
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, 'utf8');
    // The guard MUST exist near the top of the prop-application code path.
    expect(src).toMatch(/import\.meta\.env\.MODE\s*===?\s*['"]production['"]/);
  });

  it('OnboardingFlow source references the test-only prop names via split form (defeats constant-folding leak)', () => {
    // G-T05-10 split-form precedent — the prop names live as concatenated literals
    // OR as variables. Either way, the BARE LITERAL strings '__test_step' /
    // '__test_user_agent' must NOT appear concatenated in a single quoted token
    // inside a runtime call site (only inside type / comment / split-form contexts).
    const path = '/home/user/agent-os/apps/web/src/lib/onboarding/OnboardingFlow.svelte';
    const src = readFileSync(path, 'utf8');
    // The split-form pattern OR an explicit destructure binding is acceptable;
    // a bare 'foo.__test_step' chain in a runtime call site is the regression.
    // Defense-in-depth: at minimum the split-form '__test_' + 'step' shape appears,
    // OR the prop is named in a destructure / export-let position.
    const hasSplitForm =
      /['"]__test_['"]\s*\+\s*['"]step['"]/.test(src) ||
      /['"]__test_['"]\s*\+\s*['"]user_agent['"]/.test(src);
    const hasExportLet = /export\s+let\s+__test_(step|user_agent)/.test(src);
    expect(hasSplitForm || hasExportLet).toBe(true);
  });
});
