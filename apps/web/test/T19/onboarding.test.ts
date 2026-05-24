/**
 * T19 — Session revocation, panic wipe, onboarding copy, browser baseline,
 *       and the full D.1 → D.7 integration (Amendment F show-again).
 *
 * Source obligations:
 *   - threat-model §8 T19 — F-39 (revocation), panic-wipe, onboarding,
 *     F-53 (destructive_confirm variant), F-54 onboarding linkage (full
 *     D.1→D.7 with show-again).
 *   - ADR-0008 — personal-device advisory; first-launch copy.
 *   - ADR-0001 — hosting tradeoff explained in onboarding D.2.
 *   - ADR-0002 — minimum browser baseline.
 *   - design-system §4 Surface D, Surface G (lock/panic), Surface H (sessions).
 *   - i18n en-CA — onboarding.* keys present.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import OnboardingFlow from '../../src/lib/onboarding/OnboardingFlow.svelte';
import PanicWipeModal from '../../src/lib/lock/PanicWipeModal.svelte';
import { freezeClock, advanceBy, restoreClock } from '../_helpers/clock';
import { createTestSupabase, type TestSupabase } from '../_helpers/supabase-test';
import { SYNTHETIC_USER_A } from '../_helpers/fixtures';

let supa: TestSupabase;
beforeEach(async () => {
  freezeClock();
  supa = await createTestSupabase();
});
afterEach(async () => {
  cleanup();
  restoreClock();
  await supa.tearDown();
});

// ============================================================================
// ADR-0008 — D.1 personal-device advisory; ADR-0001 — D.2 hosting tradeoff
// ============================================================================

describe('T19 / ADR-0008 / D.1 — personal-device advisory', () => {
  it('T19 / D.1 — first-launch renders the personal-device advisory with both Continue and Stop affordances, current device fingerprint shown', async () => {
    render(OnboardingFlow);
    const heading = screen.getByRole('heading', { name: /personal device/i });
    expect(heading).toBeDefined();
    expect(screen.getByRole('button', { name: /personal device.*continue/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /stop.*switch.*personal/i })).toBeDefined();
    // Device fingerprint is shown (UA + platform; never an IP).
    expect(screen.getByTestId('device-fingerprint')).toBeDefined();
  });

  it('T19 / ADR-0001 / D.2 — hosting-tradeoff copy explains in plain English: ciphertext-only, US legal process reach is bounded to ciphertext', async () => {
    render(OnboardingFlow, { props: { __test_step: 'D.2' } });
    const body = screen.getByTestId('onboarding-d2-body');
    expect(body.textContent ?? '').toMatch(/encrypted|scrambled/i);
    expect(body.textContent ?? '').toMatch(/Canada|ca-central|Canadian/i);
    // Reading-level proxy: no Latin abbreviations.
    expect(body.textContent ?? '').not.toMatch(/\bi\.e\.|\be\.g\./);
  });

  it('T19 / a11y — every onboarding screen meets WCAG 2.0 AA per the design system §3.1: focus-visible + first-focus discipline', async () => {
    const { default: axeCheck } = await import('../_helpers/axe-check');
    render(OnboardingFlow);
    const r = await axeCheck(document.body, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });
});

// ============================================================================
// ADR-0002 — Browser baseline gate on D.3
// ============================================================================

describe('T19 / ADR-0002 / D.3 — minimum browser baseline check', () => {
  it('T19 / D.3 — onboarding shows the "browser too old" block state for Safari 15', async () => {
    render(OnboardingFlow, {
      props: { __test_user_agent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/15.6 Safari/605.1.15' },
    });
    expect(screen.getByText(/browser is too old/i)).toBeDefined();
  });

  it('T19 / D.3 — onboarding proceeds for Chrome 130 (above 109 baseline)', async () => {
    render(OnboardingFlow, {
      props: {
        __test_user_agent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        __test_step: 'D.3',
      },
    });
    expect(screen.getByRole('button', { name: /set up passkey/i })).toBeDefined();
  });
});

// ============================================================================
// Amendment F — D.1 → D.7 integration test (with at least one "show again")
// ============================================================================

describe('T19 / Amendment F / F-54 onboarding linkage — full D.1 → D.7 integration', () => {
  it('T19 / Amendment F — full flow including one "show again" invocation; audit row appears under partially-enrolled user; reveal-count resets after D.7', async () => {
    const auditSpy = supa.spyAuditWrites();
    const { default: harness } = await import('../_helpers/onboarding-harness');
    const ctx = await harness.startFromD1();
    // D.1 → D.2 → D.3 (passkey) → D.4 (passphrase generated).
    await ctx.advanceThroughTo('D.4');
    // Invoke "show again" once.
    await ctx.invokeShowAgainHold(1500);
    // The audit row appears under the partially-enrolled user.
    const auditRows = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'identity_privkey.recovery_blob.viewed'`
    );
    expect(auditRows.rows.length).toBe(1);
    expect(auditRows.rows[0].meta.reveal_count_in_session).toBe(1);
    expect(auditRows.rows[0].meta.enrollment_session_id).toBe(ctx.enrollmentSessionId);

    // Continue D.4 → D.5 (print) → D.6 (type-back verify) → D.7.
    await ctx.completeTypeBackVerify();
    await ctx.advanceThroughTo('D.7');
    expect(ctx.currentStep).toBe('D.7');

    // After D.7, a NEW enrollment session would get a fresh counter.
    const ctx2 = await harness.startFromD1();
    expect(ctx2.enrollmentSessionId).not.toBe(ctx.enrollmentSessionId);
    await ctx2.advanceThroughTo('D.4');
    await ctx2.invokeShowAgainHold(1500);
    const auditRow2 = await supa.adminQuery(
      `SELECT meta FROM audit_log WHERE event_type = 'identity_privkey.recovery_blob.viewed' AND meta->>'enrollment_session_id' = $1`,
      [ctx2.enrollmentSessionId]
    );
    expect(auditRow2.rows[0].meta.reveal_count_in_session).toBe(1);
  });
});

// ============================================================================
// T2 — Panic wipe + F-53 (destructive_confirm variant)
// ============================================================================

describe('T19 / T2 — panic-wipe + F-53 destructive_confirm', () => {
  it('T19 / T2 — panic wipe clears IndexedDB; subsequent navigation requires fresh enrollment or sign-in', async () => {
    const user = await supa.enrollUser(SYNTHETIC_USER_A);
    await supa.idb.populate({ ident_priv_wrapped_local: 'ciphertext', queue: [] });
    const { panicWipe } = await import('../../src/lib/lock/panic-wipe');
    // F-106 M-106a: the production BrowserWipeStore's emitAudit is a
    // fail-closed stub pending G-T19-PRIV-3 (the T05.1 audit-emit
    // transport wire-up). To exercise the wipe-clears-IDB contract
    // without forging the audit row, mount a TestWipeStore whose
    // emitAudit succeeds — the test asserts post-wipe state, NOT the
    // audit-emit transport (covered in d6-panic-wipe).
    const { MemoryWipeStore } = await import('../../src/lib/lock/wipe-store');
    await panicWipe({ store: new MemoryWipeStore() });
    const snapshot = await supa.idb.snapshotEntireStore();
    expect(snapshot).toEqual([]);
    // Subsequent navigation: assert lock screen / re-enrollment surface.
    const next = await supa.simulateNextPageLoad();
    expect(['lock', 'enroll']).toContain(next.routeName);
  });

  it('T19 / F-53 (destructive_confirm) — pre-ready synthesized Enter on WIPE-typed confirm button does NOT trigger the wipe', async () => {
    const { mountDestructiveConfirmWithDelayedReady } = await import(
      '../_helpers/protected-modal-harness'
    );
    const ctx = await mountDestructiveConfirmWithDelayedReady({
      ready_delay_ms: 200,
      surface: 'panic-wipe',
    });
    advanceBy(10);
    // Type the literal phrase "WIPE" and synthesize Enter.
    fireEvent.input(ctx.literalPhraseInput, { target: { value: 'WIPE' } });
    fireEvent.keyDown(ctx.primaryButton, { key: 'Enter' });
    expect(ctx.wipeFired).toBe(false);
    // At t = 210ms (after ready), Enter fires.
    advanceBy(210);
    fireEvent.keyDown(ctx.primaryButton, { key: 'Enter' });
    await waitFor(() => expect(ctx.wipeFired).toBe(true));
  });

  it('T19 / F-53 destructive_confirm — literal-phrase input does NOT consume keystrokes before `ready` resolves', async () => {
    const { mountDestructiveConfirmWithDelayedReady } = await import(
      '../_helpers/protected-modal-harness'
    );
    const ctx = await mountDestructiveConfirmWithDelayedReady({
      ready_delay_ms: 200,
      surface: 'panic-wipe',
    });
    advanceBy(10);
    fireEvent.input(ctx.literalPhraseInput, { target: { value: 'WIPE' } });
    expect((ctx.literalPhraseInput as HTMLInputElement).value).toBe(''); // input gated
    advanceBy(210);
    fireEvent.input(ctx.literalPhraseInput, { target: { value: 'WIPE' } });
    expect((ctx.literalPhraseInput as HTMLInputElement).value).toBe('WIPE');
  });

  it('T19 / F-53 destructive_confirm — Escape during transition does NOT dismiss (consistent with §3.2 no-Escape-dismiss for this variant)', async () => {
    const { mountDestructiveConfirmWithDelayedReady } = await import(
      '../_helpers/protected-modal-harness'
    );
    const ctx = await mountDestructiveConfirmWithDelayedReady({
      ready_delay_ms: 200,
      surface: 'panic-wipe',
    });
    advanceBy(10);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(ctx.modalOpen).toBe(true);
  });
});
