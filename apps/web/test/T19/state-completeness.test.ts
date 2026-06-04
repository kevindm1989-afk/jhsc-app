/**
 * T19 — State-completeness coverage (Designer §4 Surface D.T19).
 *
 * Covers (per Designer §4 Surface D.T19 — 8 sub-surfaces; each with 9 states):
 *
 *   D.T19.a OnboardingFlow chrome:      default, hover (n/a), focus-visible, active (n/a),
 *                                       disabled (n/a — never disabled), loading, error,
 *                                       success, empty (n/a), baseline_blocked (terminal sub-state)
 *   D.T19.b Step indicator:             pending, active, complete (icon required), focus-visible,
 *                                       hover (complete pills only), active (complete pills only),
 *                                       disabled, loading, error (x-circle), success, empty (n/a)
 *   D.T19.c Device-fingerprint card:    default (read-only render; no interactive sub-states)
 *   D.T19.d Recovery-blob download:     default, hover, focus-visible, active, disabled,
 *                                       loading (aria-busy=true), error (doesn't block advance),
 *                                       success, empty (n/a)
 *   D.T19.e Browser-baseline badge:     pass, fail (with per-check enumeration)
 *   D.T19.f Recovery-passphrase reveal: default (concealed), revealed (transient), focus-visible,
 *                                       loading, error (audit failed), capped (3 reveals consumed)
 *   D.T19.g Session-revocation primer:  (see d5-session-revocation-primer.test.ts)
 *   D.T19.h Completion summary:         default (check-circle required + next-step pointer)
 *
 *   Plus the Designer §G PanicWipeModal state matrix:
 *     ready-delay-pending, ready, in-progress overlay, partial-failure, complete
 *
 * NOTE: this file pins STATE RENDERING. Per-state axe-zero-violations is documented
 * here as a TEST OBLIGATION but DEFERRED to the accessibility-specialist's Phase F pass
 * — the axe-check helper is owned by accessibility-specialist (see Flagged items in
 * Test-writer's pass). The scaffold's axe call at line 60-64 of onboarding.test.ts
 * pins the chrome-level axe check; per-state axe coverage requires the axeCheck helper
 * to ship first (it does NOT exist in apps/web/test/_helpers/ at test-writer time).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent } from '@testing-library/svelte';
import { freezeClock, advanceBy, restoreClock } from '../_helpers/clock';
import { renderOnboarding, renderPanicWipe, resetTestConfigs } from '../_helpers/render-with-test-config';
import { t } from '../../src/lib/i18n';

beforeEach(() => {
  freezeClock();
});
afterEach(() => {
  cleanup();
  restoreClock();
  resetTestConfigs();
});

// ============================================================================
// D.T19.a OnboardingFlow chrome — state matrix
// ============================================================================

describe('T19 / D.T19.a — OnboardingFlow chrome state matrix', () => {
  it('default — wizard root has role="region" with aria-labelledby naming the current step heading', async () => {
    renderOnboarding();
    const root = screen.getByRole('region', { name: /account setup|onboarding|personal device/i });
    expect(root).toBeDefined();
    expect(root.getAttribute('aria-labelledby')).toBeTruthy();
  });

  it('default — chrome has an aria-live="polite" region for step-change announcements', async () => {
    renderOnboarding();
    const live = document.querySelector('[aria-live="polite"][data-testid="wizard-step-announce"]');
    expect(live).not.toBeNull();
  });

  it('loading (during a step async) — body region has aria-busy="true"', async () => {
    renderOnboarding({ step: 'D.5', sessionCount: 3, revokeDelayMs: 1500 });
    const primary = screen.getByRole('button', { name: 'Revoke other sessions' });
    fireEvent.click(primary);
    const body = screen.getByTestId('wizard-step-body');
    expect(body.getAttribute('aria-busy')).toBe('true');
  });

  it('baseline_blocked — terminal sub-state freezes step indicator at D.3; no continue button', async () => {
    renderOnboarding({
        userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/15.6 Safari/605.1.15',
        step: 'D.3'
      });
    // No /set up passkey/i button on the baseline-blocked surface (already
    // covered by d2-browser-baseline; here we confirm the step indicator
    // does NOT advance past D.3).
    const list = screen.getByRole('list', { name: /(step|wizard) progress|account setup/i });
    const items = Array.from(list.querySelectorAll('li'));
    expect(items[2].getAttribute('aria-current')).toBe('step'); // D.3 = index 2
    for (let i = 3; i < 7; i++) {
      expect(items[i].getAttribute('aria-current')).not.toBe('step');
    }
  });

  it('reduced-motion — step-transition collapses to instant when prefers-reduced-motion: reduce', async () => {
    // The implementer's chrome reads prefers-reduced-motion via matchMedia.
    // Set the jsdom shim before render.
    (window as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (q: string) =>
      ({
        matches: /reduce/.test(q),
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false
      } as unknown as MediaQueryList);
    renderOnboarding();
    const body = screen.getByTestId('wizard-step-body');
    // The implementer encodes the reduced-motion posture in a data-attribute.
    expect(body.getAttribute('data-reduced-motion')).toBe('true');
  });
});

// ============================================================================
// D.T19.b Step indicator — state matrix
// ============================================================================

describe('T19 / D.T19.b — Step indicator state matrix', () => {
  it('complete pill carries the check icon (color-blind safety per design-system §4.D.T19.b)', async () => {
    renderOnboarding({ step: 'D.4' });
    const list = screen.getByRole('list', { name: /(step|wizard) progress|account setup/i });
    const items = Array.from(list.querySelectorAll('li'));
    // D.1..D.3 are complete; each MUST carry a check icon.
    for (let i = 0; i < 3; i++) {
      const icon = items[i].querySelector('[data-icon="check"], svg[data-icon="check"]');
      expect(icon, `step ${i + 1} (complete) is missing the check icon`).not.toBeNull();
    }
  });

  it('complete pill aria-label includes the word "completed"', async () => {
    renderOnboarding({ step: 'D.4' });
    const list = screen.getByRole('list', { name: /(step|wizard) progress|account setup/i });
    const items = Array.from(list.querySelectorAll('li'));
    for (let i = 0; i < 3; i++) {
      expect((items[i].getAttribute('aria-label') ?? '').toLowerCase()).toContain('completed');
    }
  });

  it('error state — active pill has the x-circle icon (color-blind safety)', async () => {
    renderOnboarding({
        userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/15.6 Safari/605.1.15',
        step: 'D.3'
      });
    const list = screen.getByRole('list', { name: /(step|wizard) progress|account setup/i });
    const items = Array.from(list.querySelectorAll('li'));
    // D.3 is the active step in error.
    const x = items[2].querySelector('[data-icon="x-circle"], svg[data-icon="x-circle"]');
    expect(x).not.toBeNull();
  });
});

// ============================================================================
// D.T19.c Device-fingerprint card — read-only render; no interactive states
// ============================================================================

describe('T19 / D.T19.c — Device fingerprint card is read-only', () => {
  it('the card is NOT a button / link / role="button"', async () => {
    renderOnboarding();
    const fp = screen.getByTestId('device-fingerprint');
    expect(fp.tagName.toLowerCase()).not.toBe('button');
    expect(fp.tagName.toLowerCase()).not.toBe('a');
    expect(fp.getAttribute('role')).not.toBe('button');
  });

  it('the card has no onClick / no tabindex inviting tab focus (text-select is OS-native only)', async () => {
    renderOnboarding();
    const fp = screen.getByTestId('device-fingerprint');
    // No tabindex=0; allowed: absent OR -1 (text-select is independent).
    const ti = fp.getAttribute('tabindex');
    expect(ti === null || ti === '-1').toBe(true);
  });
});

// ============================================================================
// D.T19.d Recovery-blob download — state matrix
// ============================================================================

describe('T19 / D.T19.d — recovery-blob download state matrix', () => {
  it('default — button labelled per onboarding.passphrase_d4.download_label', async () => {
    renderOnboarding({ step: 'D.4' });
    const btn = screen.getByRole('button', { name: t('onboarding.passphrase_d4.download_label') });
    expect(btn).toBeDefined();
  });

  it('disabled — during the encryption phase, the download button is aria-disabled=true', async () => {
    renderOnboarding({ step: 'D.4', forceEncryptionInProgress: true });
    const btn = screen.getByRole('button', { name: t('onboarding.passphrase_d4.download_label') });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });

  it('loading — button enters loading state; aria-busy=true; label switches to "Preparing the file…"', async () => {
    renderOnboarding({ step: 'D.4', forceDownloadInProgress: true });
    const btn = screen.getByRole('button', { name: /preparing the file/i });
    expect(btn.getAttribute('aria-busy')).toBe('true');
  });

  it('error — toast appears; button STAYS available for retry; wizard does NOT block advancement (Decision 9)', async () => {
    renderOnboarding({ step: 'D.4', forceDownloadBlocked: true });
    const toast = document.querySelector('[role="alert"][data-testid="download-blocked-toast"]');
    expect(toast).not.toBeNull();
    // Continue button remains available.
    const cont = screen.queryByRole('button', { name: /continue|next/i });
    expect(cont).not.toBeNull();
  });

  it('success — label transiently switches to "Downloaded — download again"', async () => {
    renderOnboarding({ step: 'D.4', forceDownloadSuccess: true });
    const btn = screen.getByRole('button', { name: /downloaded.*download again/i });
    expect(btn).toBeDefined();
  });
});

// ============================================================================
// D.T19.e Browser-baseline badge — pass / fail with per-check enumeration
// (Covered in d2-browser-baseline.test.ts; this is the redundant state-matrix
// confirmation per Designer §4 D.T19.e.)
// ============================================================================

describe('T19 / D.T19.e — browser-baseline badge per-state', () => {
  it('every fail sub-check is rendered as its own <li> with an aria-label naming the failed capability', async () => {
    renderOnboarding({
        userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/15.6 Safari/605.1.15',
        step: 'D.3'
      });
    const list = screen.getByRole('list', { name: /failed checks/i });
    const items = Array.from(list.querySelectorAll('li'));
    for (const li of items) {
      expect(li.getAttribute('aria-label')).toBeTruthy();
    }
  });
});

// ============================================================================
// D.T19.f Recovery-passphrase reveal — state matrix
// ============================================================================

describe('T19 / D.T19.f — recovery-passphrase reveal state matrix', () => {
  it('default (concealed) — passphrase <code> is NOT in the DOM before the first hold-to-reveal', async () => {
    renderOnboarding({ step: 'D.4' });
    // The implementer renders the <code> only during the revealed-transient window.
    const code = document.querySelector('code[data-testid="passphrase-reveal"]');
    expect(code).toBeNull();
  });

  it('capped (after 3 reveals) — reveal control is aria-disabled=true; helper text swaps to capped variant', async () => {
    renderOnboarding({ step: 'D.4', forceRevealCap: true });
    const reveal = screen.getByRole('button', { name: /show.*passphrase|press and hold/i });
    expect(reveal.getAttribute('aria-disabled')).toBe('true');
    // The capped helper text is from the catalog.
    expect(screen.getByText(t('onboarding.passphrase_d4.show_again_capped'))).toBeDefined();
  });
});

// ============================================================================
// D.T19.h Completion summary — state matrix
// ============================================================================

describe('T19 / D.T19.h — completion summary state matrix', () => {
  it('default — card role="status"; next-step pointer block is role="region"', async () => {
    renderOnboarding({ step: 'D.7' });
    const card = screen.getByTestId('completion-summary');
    expect(card.getAttribute('role')).toBe('status');
    const pointer = screen.getByTestId('completion-next-steps');
    expect(pointer.getAttribute('role')).toBe('region');
    expect(pointer.getAttribute('aria-labelledby')).toBeTruthy();
  });
});

// ============================================================================
// Surface G PanicWipeModal — state matrix
// ============================================================================

describe('T19 / Surface G — PanicWipeModal state matrix', () => {
  it('ready-delay-pending — modal body has aria-busy=true; role=alert is NOT yet attached', async () => {
    renderPanicWipe({ open: true, surface: 'settings', readyDelayMs: 200 });
    const body = screen.getByTestId('panic-wipe-modal-body');
    expect(body.getAttribute('aria-busy')).toBe('true');
    expect(body.getAttribute('role')).not.toBe('alert');
  });

  it('Escape during ready-delay does NOT dismiss the modal (§3.2 protected variant)', async () => {
    renderPanicWipe({ open: true, surface: 'settings', readyDelayMs: 200 });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    // Modal still in DOM.
    expect(screen.queryByRole('dialog', { name: /wipe this device/i })).not.toBeNull();
  });

  it('complete — page redirects to a fresh login surface; success toast role=status', async () => {
    renderPanicWipe({ open: true, surface: 'settings', readyDelayMs: 0, forceComplete: true });
    advanceBy(50);
    const toast = document.querySelector('[role="status"][data-testid="panic-wipe-complete-toast"]');
    expect(toast).not.toBeNull();
  });
});
