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
import { screen, cleanup } from '@testing-library/svelte';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { renderOnboarding, resetTestConfigs } from '../_helpers/render-with-test-config';
import { t } from '../../src/lib/i18n';
import { existsSync, readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { WEB_ROOT, REPO_ROOT } from '../_helpers/paths';

beforeEach(() => {
  freezeClock();
});
afterEach(() => {
  cleanup();
  restoreClock();
  resetTestConfigs();
});

// ============================================================================
// D.2 hosting-tradeoff body — catalog key wired; copy meets grade-8 floor
// ============================================================================

describe('T19 / D.2 — hosting tradeoff body composes the catalog key', () => {
  it('the D.2 body composes onboarding.browser_baseline_d2.body_pass when the browser passes baseline', async () => {
    renderOnboarding({ step: 'D.2' });
    const body = screen.getByTestId('onboarding-d2-body');
    const catalogValue = t('onboarding.browser_baseline_d2.body_pass');
    // The first 80 chars of the catalog value (modulo whitespace) should appear in the rendered body.
    // (Direct equality is brittle — the scaffold uses regex matchers; we anchor on a stable substring.)
    const needle = catalogValue.slice(0, 60).replace(/\s+/g, ' ').trim();
    expect((body.textContent ?? '').replace(/\s+/g, ' ')).toContain(needle.slice(0, 40));
  });

  it('D.2 body does NOT contain Latin abbreviations (grade-8 reading-level floor — scaffold line 56)', async () => {
    renderOnboarding({ step: 'D.2' });
    const body = screen.getByTestId('onboarding-d2-body');
    expect(body.textContent ?? '').not.toMatch(/\bi\.e\.|\be\.g\.|\betc\.|\bvs\./);
  });

  it('D.2 body discloses Supabase + ca-central-1 (the hosting tradeoff is informed-of-purpose)', async () => {
    renderOnboarding({ step: 'D.2' });
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
    renderOnboarding({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        step: 'D.3'
      });
    const badge = screen.getByTestId('browser-baseline-badge');
    expect(badge.getAttribute('role')).toBe('status');
    expect(badge.textContent ?? '').toMatch(/ready|supported/i);
  });

  it('fail badge renders role="alert" and enumerates which sub-checks failed', async () => {
    // Old Safari 15 — below baseline.
    renderOnboarding({
        userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/15.6 Safari/605.1.15',
        step: 'D.3'
      });
    const badge = screen.getByTestId('browser-baseline-badge');
    expect(badge.getAttribute('role')).toBe('alert');
    // The badge MUST present a sub-check list (per Designer §4 D.T19.e fail row).
    const list = screen.getByRole('list', { name: /failed checks/i });
    expect(list).toBeDefined();
    expect(list.querySelectorAll('li').length).toBeGreaterThanOrEqual(1);
  });

  it('baseline_blocked terminal sub-state freezes the step indicator at D.3 (no continue button)', async () => {
    renderOnboarding({
        userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/15.6 Safari/605.1.15',
        step: 'D.3'
      });
    // Continue button must NOT exist on the baseline-blocked sub-state.
    expect(screen.queryByRole('button', { name: /set up passkey/i })).toBeNull();
    // The baseline-fail body matches /browser is too old/i per the existing scaffold.
    expect(screen.getByText(/browser is too old/i)).toBeDefined();
  });

  it('F-110 / M-110a — the baseline-fail body does NOT echo the rejected UA fingerprint into a user-visible toast', async () => {
    const canaryUA = 'Mozilla/5.0 (CANARY-FINGERPRINT-CAN-NOT-LEAK) BadBrowser/0.0';
    renderOnboarding({ userAgent: canaryUA, step: 'D.3' });
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
    const path = nodePath.join(WEB_ROOT, 'src/lib/onboarding/steps/D3PasskeyEnrollment.svelte');
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
      nodePath.join(REPO_ROOT, 'scripts/check-onboarding-test-props-stripped.sh'),
      nodePath.join(WEB_ROOT, 'scripts/check-onboarding-test-props-stripped.sh')
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

describe('T19 / Decision 8 — test-only config is injected via a production-stripped seam', () => {
  it('OnboardingFlow source declares NO `export let __test_*` props (the names would leak into the prod bundle)', () => {
    const path = nodePath.join(WEB_ROOT, 'src/lib/onboarding/OnboardingFlow.svelte');
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, 'utf8');
    // Svelte compiles every `export let __test_x` into a literal prop-name
    // string in the bundle even when runtime-stripped (issue #120). The
    // component must therefore declare none of them.
    expect(/export\s+let\s+__test_/.test(src)).toBe(false);
  });

  it('OnboardingFlow reads test config from the seam only under `!import.meta.env.PROD` (tree-shaken in prod)', () => {
    const path = nodePath.join(WEB_ROOT, 'src/lib/onboarding/OnboardingFlow.svelte');
    const src = readFileSync(path, 'utf8');
    // Injection now goes through the production-stripped `onboarding-test-config`
    // seam, read inside a `!import.meta.env.PROD` guard so Vite DCE + Rollup
    // tree-shake the seam (and the test-only config reads) out of the prod
    // bundle entirely — replacing the old `export let __test_*` + runtime-strip
    // strategy that baked the prop NAMES into the bundle.
    expect(src).toMatch(/getOnboardingTestConfig/);
    expect(src).toMatch(/!import\.meta\.env\.PROD/);
  });
});
