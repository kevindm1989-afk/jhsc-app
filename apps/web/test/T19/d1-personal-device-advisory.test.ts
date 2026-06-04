/**
 * T19 — D.1 Personal-device advisory (additive to the 195-line scaffold).
 *
 * Covers:
 *   - F-101 / M-101a — advisory copy: heading + 4 clauses (a..d) + primary/secondary button text
 *   - F-101 / M-101b — explicit-click gate (no auto-advance; no keyboard auto-advance; no URL ?step=D.2 skip in production)
 *   - F-101 / M-101c — device fingerprint = UA + platform only (no IP, no Sec-CH-UA, no navigator.connection, no geolocation)
 *   - F-101 / M-101c — fingerprint string never appears in any audit-meta payload sent to the server
 *   - design-system §4 Surface D.T19.c — Device-fingerprint card spec (read-only, no app-level click handler)
 *   - design-system §4 Surface D / D.1 row — Personal-device advisory copy patterns
 *   - ADR-0020 Decision 2.b — D.1 → D.2 gate: explicit-click only; no auto-advance
 *
 * Tests REFERENCE i18n catalog KEYS via `t()` where the implementer is free to evolve copy
 * (HG-10 lawyer iteration). Tests REFERENCE literal regex where the existing 195-line
 * scaffold pins the literal (e.g., /personal device/i) — those literals are binding contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/svelte';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { createTestSupabase, type TestSupabase } from '../_helpers/supabase-test';
import { renderOnboarding, resetTestConfigs } from '../_helpers/render-with-test-config';
import { t } from '../../src/lib/i18n';

let supa: TestSupabase;
beforeEach(async () => {
  freezeClock();
  supa = await createTestSupabase();
});
afterEach(async () => {
  cleanup();
  restoreClock();
  resetTestConfigs();
  await supa.tearDown();
});

// ============================================================================
// Happy path — D.1 surface renders the four required copy clauses (M-101a)
// ============================================================================

describe('T19 / F-101 M-101a — D.1 advisory: 4 clauses present in body copy', () => {
  it('clause (a) — body states "this device will store identity material" (sign-in key)', async () => {
    renderOnboarding();
    const body = screen.getByTestId('onboarding-d1-body');
    // The catalog key onboarding.advisory_d1.body must communicate
    // that the device stores the key that signs the user in.
    expect(body.textContent ?? '').toMatch(/key that signs you in|stores? (the )?key|identity/i);
  });

  it('clause (b) — body forbids enrolling on a shared or employer-issued device', async () => {
    renderOnboarding();
    const body = screen.getByTestId('onboarding-d1-body');
    expect(body.textContent ?? '').toMatch(/employer.*(own|pay|manage)/i);
  });

  it('clause (c) — body states the app cannot detect MDM / employer management for the user', async () => {
    renderOnboarding();
    const body = screen.getByTestId('onboarding-d1-body');
    // ADR-0008 honest-framing — must explicitly say the app can NOT detect.
    expect(body.textContent ?? '').toMatch(/(cannot|can'?t|does not) detect|you have to choose/i);
  });

  it('clause (d) — body informs the user that a recovery passphrase is required (cross-device access)', async () => {
    renderOnboarding();
    const body = screen.getByTestId('onboarding-d1-body');
    // Either the body or a sibling helper conveys "recovery passphrase required" or
    // "this device is the way you reach your account".
    expect(body.textContent ?? '').toMatch(/recover|reach your account|set up another personal device/i);
  });

  it('confirmation checkbox is present (explicit consent step before the primary action enables)', async () => {
    renderOnboarding();
    // The advisory_d1.checkbox_label key SHOULD render a checkable input.
    const cb = screen.getByRole('checkbox', { name: /personal device|employer.*not own/i });
    expect((cb as HTMLInputElement).type).toBe('checkbox');
    expect((cb as HTMLInputElement).checked).toBe(false);
  });

  it('catalog keys for D.1 are reachable via t() (no [[…]] fallback)', () => {
    expect(t('onboarding.advisory_d1.heading')).not.toMatch(/^\[\[/);
    expect(t('onboarding.advisory_d1.body')).not.toMatch(/^\[\[/);
    expect(t('onboarding.advisory_d1.checkbox_label')).not.toMatch(/^\[\[/);
    expect(t('onboarding.advisory_d1.primary_button')).not.toMatch(/^\[\[/);
    expect(t('onboarding.advisory_d1.secondary_button')).not.toMatch(/^\[\[/);
    expect(t('onboarding.advisory_d1.fingerprint_label')).not.toMatch(/^\[\[/);
  });
});

// ============================================================================
// Explicit-click gate (M-101b) — no auto-advance / no keyboard skip
// ============================================================================

describe('T19 / F-101 M-101b — D.1 → D.2 gate is an explicit click', () => {
  it('a synthesized window "load" event does not advance past D.1', async () => {
    renderOnboarding();
    window.dispatchEvent(new Event('load'));
    // Heading on D.1 still matches /personal device/i; the D.2 body testid is absent.
    expect(screen.getByRole('heading', { name: /personal device/i })).toBeDefined();
    expect(screen.queryByTestId('onboarding-d2-body')).toBeNull();
  });

  it('pressing Enter on the body region does not advance past D.1 (no keyboard auto-advance)', async () => {
    renderOnboarding();
    const body = screen.getByTestId('onboarding-d1-body');
    fireEvent.keyDown(body, { key: 'Enter' });
    expect(screen.queryByTestId('onboarding-d2-body')).toBeNull();
  });

  it('the URL hash "#D.2" does not skip past D.1 (no URL-driven navigation in production)', async () => {
    // M-111a — wizard state is in-memory only; the URL hash is not a step source.
    window.location.hash = '#D.2';
    renderOnboarding();
    expect(screen.getByRole('heading', { name: /personal device/i })).toBeDefined();
    expect(screen.queryByTestId('onboarding-d2-body')).toBeNull();
    // Cleanup so we don't pollute other tests.
    window.location.hash = '';
  });

  it('clicking primary BEFORE the confirmation checkbox is checked does not advance past D.1', async () => {
    renderOnboarding();
    const primary = screen.getByRole('button', { name: /personal device.*continue/i });
    fireEvent.click(primary);
    expect(screen.queryByTestId('onboarding-d2-body')).toBeNull();
  });

  it('checking the confirmation checkbox + clicking primary DOES advance to D.2', async () => {
    renderOnboarding();
    const cb = screen.getByRole('checkbox', { name: /personal device|employer.*not own/i });
    fireEvent.click(cb);
    const primary = screen.getByRole('button', { name: /personal device.*continue/i });
    fireEvent.click(primary);
    expect(screen.getByTestId('onboarding-d2-body')).toBeDefined();
  });
});

// ============================================================================
// Device fingerprint composition (M-101c) — UA + platform ONLY
// ============================================================================

describe('T19 / F-101 M-101c — device fingerprint is UA + platform only', () => {
  it('fingerprint element renders navigator.userAgent + navigator.platform; no IPv4 shape; no IPv6 shape', async () => {
    renderOnboarding();
    const fp = screen.getByTestId('device-fingerprint');
    const text = fp.textContent ?? '';
    // M-101c hard rule: never an IP shape.
    expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(text).not.toMatch(/\b[0-9a-fA-F]{1,4}:[0-9a-fA-F]{1,4}:[0-9a-fA-F:]+\b/);
  });

  it('fingerprint does NOT render Sec-CH-UA-Full-Version-List substring', async () => {
    renderOnboarding();
    const fp = screen.getByTestId('device-fingerprint');
    expect(fp.textContent ?? '').not.toMatch(/Sec-CH-UA-Full-Version-List/i);
  });

  it('fingerprint does NOT render navigator.connection.effectiveType', async () => {
    // M-101c — no `navigator.connection.*` exposure.
    renderOnboarding();
    const fp = screen.getByTestId('device-fingerprint');
    // The connection enum values: 'slow-2g'|'2g'|'3g'|'4g'. None should appear.
    expect(fp.textContent ?? '').not.toMatch(/\b(slow-2g|2g|3g|4g)\b/);
  });

  it('fingerprint does NOT render geolocation latitude/longitude', async () => {
    renderOnboarding();
    const fp = screen.getByTestId('device-fingerprint');
    // Decimal degrees within Ontario (defensive — no geolocation should ever appear).
    expect(fp.textContent ?? '').not.toMatch(/-?\d{1,2}\.\d{4,}/);
  });

  it('fingerprint contains the user-agent substring (proves it was actually composed from navigator.userAgent)', async () => {
    renderOnboarding();
    const fp = screen.getByTestId('device-fingerprint');
    // navigator.userAgent in jsdom contains "Mozilla" or "jsdom"; either is fine.
    expect(fp.textContent ?? '').toMatch(/Mozilla|jsdom/);
  });

  it('fingerprint has aria-label naming it as browser information and explicitly stating "nothing sent to the server"', async () => {
    renderOnboarding();
    const fp = screen.getByTestId('device-fingerprint');
    const label = fp.getAttribute('aria-label') ?? '';
    expect(label).toMatch(/browser/i);
    expect(label).toMatch(/not sent|nothing.*sent|client-only/i);
  });
});

// ============================================================================
// Fingerprint never leaks into any audit-meta sent to the server (M-101c)
// ============================================================================

describe('T19 / F-101 M-101c — fingerprint never appears in any audit-meta payload', () => {
  it('after rendering D.1, no captured audit row carries the fingerprint string in any meta field', async () => {
    const auditSpy = supa.spyAuditWrites();
    renderOnboarding();
    const fp = screen.getByTestId('device-fingerprint');
    const fpText = (fp.textContent ?? '').trim();
    // Sanity — the fingerprint must be non-empty for this assertion to be meaningful.
    expect(fpText.length).toBeGreaterThan(0);

    for (const call of auditSpy.calls) {
      const flat = JSON.stringify(call.meta ?? {});
      // The fingerprint string itself MUST NOT appear in any audit-meta payload.
      expect(flat).not.toContain(fpText);
    }
  });
});

// ============================================================================
// Step indicator (D.T19.b) — D.1 is active; pills 2..7 are pending; complete pills carry a check icon
// ============================================================================

describe('T19 / Surface D.T19.b — step indicator at D.1', () => {
  it('renders 7 step pills (one <li> per D.1..D.7 step)', async () => {
    renderOnboarding();
    const list = screen.getByRole('list', { name: /(step|wizard) progress|account setup/i });
    const items = list.querySelectorAll('li');
    expect(items.length).toBe(7);
  });

  it('pill 1 carries aria-current="step" at D.1 entry', async () => {
    renderOnboarding();
    const list = screen.getByRole('list', { name: /(step|wizard) progress|account setup/i });
    const items = Array.from(list.querySelectorAll('li'));
    expect(items[0].getAttribute('aria-current')).toBe('step');
    for (let i = 1; i < 7; i++) {
      expect(items[i].getAttribute('aria-current')).not.toBe('step');
    }
  });

  it('pending pills (2..7) carry aria-disabled="true" at D.1 entry', async () => {
    renderOnboarding();
    const list = screen.getByRole('list', { name: /(step|wizard) progress|account setup/i });
    const items = Array.from(list.querySelectorAll('li'));
    for (let i = 1; i < 7; i++) {
      expect(items[i].getAttribute('aria-disabled')).toBe('true');
    }
  });
});
