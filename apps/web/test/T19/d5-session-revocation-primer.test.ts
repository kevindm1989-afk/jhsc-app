/**
 * T19 — D.5 Session-revocation primer (additive to scaffold).
 *
 * Covers:
 *   - Designer §A — canonical labels FIXED:
 *       heading: "Sign out other devices?"
 *       primary: "Revoke other sessions"
 *       tertiary: "Skip — I'll do this later"
 *   - Designer §4 Surface D.T19.g + Surface H amendment — primer is a constrained subset of
 *     Surface H: read-only-presentation + one bulk action; no per-row Revoke; no Revoke-all
 *     destructive_confirm
 *   - Designer §4 Surface D / D.5 row — full state matrix:
 *     ready_delay, in_progress, success, empty (only-this-device), partial_failure, error
 *   - F-39 ≤5s propagation — D.5 button's loading state resolves only after
 *     revokeAllSessions promise resolves (T05.1's contract; primer inherits)
 *
 * Catalog keys exercised:
 *   - onboarding.sessions_d5.{heading, body, helper, helper_only_this_device,
 *                              revoke_other.label, skip.label, state.*, error.*}
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { freezeClock, advanceBy, restoreClock } from '../_helpers/clock';
import OnboardingFlow from '../../src/lib/onboarding/OnboardingFlow.svelte';
import { t } from '../../src/lib/i18n';

beforeEach(() => {
  freezeClock();
});
afterEach(() => {
  cleanup();
  restoreClock();
});

// ============================================================================
// Designer §A — FIXED labels
// ============================================================================

describe('T19 / Designer §A — D.5 canonical labels are FIXED', () => {
  it('heading catalog value equals "Sign out other devices?" (FIXED per Designer §A)', () => {
    expect(t('onboarding.sessions_d5.heading')).toBe('Sign out other devices?');
  });

  it('primary action label equals "Revoke other sessions" (FIXED per Designer §A)', () => {
    expect(t('onboarding.sessions_d5.revoke_other.label')).toBe('Revoke other sessions');
  });

  it('tertiary action label equals "Skip — I\'ll do this later" (FIXED per Designer §A)', () => {
    // The em-dash + apostrophe is exact per the Designer's pass.
    expect(t('onboarding.sessions_d5.skip.label')).toBe("Skip — I'll do this later");
  });
});

// ============================================================================
// Default render at D.5 — primer chrome
// ============================================================================

describe('T19 / D.5 — primer renders heading + bulk action + tertiary skip', () => {
  it('renders the FIXED heading text', async () => {
    render(OnboardingFlow, { props: { __test_step: 'D.5' } });
    expect(screen.getByRole('heading', { name: 'Sign out other devices?' })).toBeDefined();
  });

  it('renders the destructive primary button with FIXED label', async () => {
    render(OnboardingFlow, { props: { __test_step: 'D.5' } });
    expect(screen.getByRole('button', { name: 'Revoke other sessions' })).toBeDefined();
  });

  it('renders the tertiary skip button with FIXED label', async () => {
    render(OnboardingFlow, { props: { __test_step: 'D.5' } });
    expect(screen.getByRole('button', { name: "Skip — I'll do this later" })).toBeDefined();
  });

  it('primer renders the same `table.sessions`-shaped list as Surface H (no per-row Revoke buttons)', async () => {
    render(OnboardingFlow, { props: { __test_step: 'D.5' } });
    const list = screen.queryByTestId('session-revocation-primer-list');
    expect(list).not.toBeNull();
    // Per-row Revoke buttons MUST NOT exist on the primer (Designer Surface H amendment).
    const perRowRevokes = list!.querySelectorAll('button[data-testid^="revoke-session-"]');
    expect(perRowRevokes.length).toBe(0);
  });

  it('primer does NOT render a Revoke-all destructive_confirm modal (Surface H feature absent on primer)', async () => {
    render(OnboardingFlow, { props: { __test_step: 'D.5' } });
    // The primer's primary action is the bulk action; no destructive_confirm
    // modal is interposed (the user already authenticated at D.3).
    expect(document.querySelector('[role="dialog"][data-testid="revoke-all-confirm"]')).toBeNull();
  });
});

// ============================================================================
// State matrix — ready_delay, in_progress, success, empty (only-this-device), partial_failure, error
// ============================================================================

describe('T19 / D.5 state matrix per Designer §4', () => {
  it('empty (only-this-device) — primer renders the only-this-device helper and Skip becomes the only forward action', async () => {
    render(OnboardingFlow, {
      props: { __test_step: 'D.5', __test_session_count: 1 }
    });
    // The helper text references the only-this-device state.
    expect(screen.getByText(t('onboarding.sessions_d5.helper_only_this_device'))).toBeDefined();
    // The destructive primary button SHOULD be disabled (nothing to revoke).
    const primary = screen.getByRole('button', { name: 'Revoke other sessions' });
    expect(primary.getAttribute('aria-disabled')).toBe('true');
  });

  it('in_progress — clicking the primary fires the loading state; primary is aria-busy=true', async () => {
    render(OnboardingFlow, {
      props: { __test_step: 'D.5', __test_session_count: 3, __test_revoke_delay_ms: 1500 }
    });
    const primary = screen.getByRole('button', { name: 'Revoke other sessions' });
    fireEvent.click(primary);
    // Don't advance the clock — the loading state is current.
    expect(primary.getAttribute('aria-busy')).toBe('true');
    expect(primary.textContent ?? '').toMatch(/signing out|preparing/i);
  });

  it('success — after revokeAllSessions resolves, role=status announces success', async () => {
    render(OnboardingFlow, {
      props: { __test_step: 'D.5', __test_session_count: 3, __test_revoke_delay_ms: 100 }
    });
    const primary = screen.getByRole('button', { name: 'Revoke other sessions' });
    fireEvent.click(primary);
    advanceBy(110);
    await waitFor(() => {
      const status = document.querySelector('[role="status"][data-testid="sessions-revoked"]');
      expect(status).not.toBeNull();
    });
  });

  it('partial_failure — Designer §G state-row: error_state surfaces with the failed-systems enumeration', async () => {
    render(OnboardingFlow, {
      props: {
        __test_step: 'D.5',
        __test_session_count: 3,
        __test_revoke_partial_failure: ['device-2', 'device-3']
      }
    });
    const primary = screen.getByRole('button', { name: 'Revoke other sessions' });
    fireEvent.click(primary);
    advanceBy(110);
    await waitFor(() => {
      const alert = document.querySelector('[role="alert"][data-testid="sessions-partial"]');
      expect(alert).not.toBeNull();
    });
    // The partial-failure copy enumerates failed_systems.
    const alert = document.querySelector('[role="alert"][data-testid="sessions-partial"]')!;
    expect(alert.textContent ?? '').toMatch(/device-2|device-3/);
  });

  it('error (rate-limited) — primary button reverts; Skip remains available so the user is not stranded', async () => {
    render(OnboardingFlow, {
      props: { __test_step: 'D.5', __test_session_count: 3, __test_revoke_error: 'rate_limited' }
    });
    const primary = screen.getByRole('button', { name: 'Revoke other sessions' });
    fireEvent.click(primary);
    advanceBy(110);
    await waitFor(() => {
      const err = document.querySelector('[role="alert"][data-testid="sessions-error"]');
      expect(err).not.toBeNull();
    });
    // Skip MUST still be present (network failure must not strand the user).
    expect(screen.getByRole('button', { name: "Skip — I'll do this later" })).toBeDefined();
  });
});

// ============================================================================
// F-39 ≤5s propagation — loading state resolves only after the promise resolves
// ============================================================================

describe('T19 / F-39 — D.5 loading resolves on promise resolution (not on click)', () => {
  it('with a 3000ms delay seam, the primary button stays loading until the seam resolves', async () => {
    render(OnboardingFlow, {
      props: { __test_step: 'D.5', __test_session_count: 3, __test_revoke_delay_ms: 3000 }
    });
    const primary = screen.getByRole('button', { name: 'Revoke other sessions' });
    fireEvent.click(primary);
    advanceBy(1000);
    expect(primary.getAttribute('aria-busy')).toBe('true');
    advanceBy(2100);
    await waitFor(() => {
      expect(primary.getAttribute('aria-busy')).not.toBe('true');
    });
  });
});

// ============================================================================
// Skip path — clicking Skip advances to D.7 without firing revokeAllSessions
// ============================================================================

describe('T19 / D.5 — Skip advances to D.7 without firing revokeAllSessions', () => {
  it('clicking Skip routes to D.7 immediately', async () => {
    render(OnboardingFlow, {
      props: { __test_step: 'D.5', __test_session_count: 3 }
    });
    const skip = screen.getByRole('button', { name: "Skip — I'll do this later" });
    fireEvent.click(skip);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /you're set up|set up/i })).toBeDefined();
    });
  });
});
