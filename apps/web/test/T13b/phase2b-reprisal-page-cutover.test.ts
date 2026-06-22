/**
 * Phase 2b PR1 / P2b-3 — UI cutover for the /reprisal route + the
 * ReprisalIntakeForm wiring (ADR-0028 Decision 5 + Decision 6).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
 *
 * Two surfaces:
 *
 *   (A) `apps/web/src/lib/reprisal/ReprisalIntakeForm.svelte` — currently
 *       inert. The submit handler (:142) validates then flips
 *       `state = 'submitting'` and STOPS (dead-ends). PR1 must add a `submit`
 *       prop and call it with the intake { title, body, passphrase } on a valid
 *       (consented + non-empty + matching-passphrase) submit, then surface the
 *       discriminated-union result in the form state. Mirrors the concerns
 *       ConcernIntakeForm wiring.
 *
 *   (B) `apps/web/src/routes/reprisal/+page.svelte` — currently demo-only
 *       (`buildDemoReprisals` / `fetchDemoReprisalPage`). PR1 must:
 *         - DROP the demo data source;
 *         - import `listReprisalFeedViaProduction` + `getCommitteeKeyState`;
 *         - render a probe-first `actor_has_wrap === false` branch with a
 *           "Complete encryption setup in Settings" link
 *           (data-testid="reprisal-needs-setup"), with the form NOT mounted;
 *         - render a "Report a reprisal" CTA (data-testid="reprisal-log-cta")
 *           mounting ReprisalIntakeForm wired to submitReprisalViaProduction;
 *         - render a per-row "read" affordance (passphrase →
 *           readReprisalViaProduction → temporary plaintext in a role=status
 *           region).
 *
 * The page module imports SvelteKit `$app/stores` + a long tail of widgets
 * whose unit-test mount needs heavy scaffolding, so (B) is asserted via a
 * source-level structural check (the faithful proxy the concerns cutover test
 * uses).
 *
 * TEST → AC / FINDING MAP
 *   AC-1 (submit wired)        — ReprisalIntakeForm calls the injected submit
 *                                with { title, body, passphrase }; the form
 *                                advances out of the success path on ok.
 *   AC-5 / F-163 (no-key guard)— page renders reprisal-needs-setup link for the
 *                                no-wrap branch (form not mounted).
 *   Decision 5 (live cutover)  — page imports listReprisalFeedViaProduction +
 *                                submitReprisalViaProduction + readReprisalVia
 *                                Production + getCommitteeKeyState; the demo
 *                                provider is removed.
 *   Decision 5 (read region)   — per-row read affordance renders the temporary
 *                                plaintext in a role=status region.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ReprisalIntakeForm from '../../src/lib/reprisal/ReprisalIntakeForm.svelte';

const PAGE_PATH = resolve(__dirname, '../../src/routes/reprisal/+page.svelte');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// (A) ReprisalIntakeForm — submit handler wires to the injected submit prop
// ---------------------------------------------------------------------------

/**
 * Drive the form to a valid submittable state: tick consent, fill title/body,
 * set matching passphrases. Mirrors the form's own pre-submit gate (:131-141).
 */
async function fillValidForm(passphrase = 'matching-pass') {
  // Consent checkbox must be checked (the click handler short-circuits otherwise).
  await fireEvent.click(screen.getByTestId('reprisal-consent-checkbox'));
  await fireEvent.input(screen.getByTestId('reprisal-title'), {
    target: { value: 'shift cut after raising a safety issue' }
  });
  await fireEvent.input(screen.getByTestId('reprisal-body'), {
    target: { value: 'detailed account of the reprisal' }
  });
  await fireEvent.input(screen.getByTestId('reprisal-passphrase'), {
    target: { value: passphrase }
  });
  await fireEvent.input(screen.getByTestId('reprisal-passphrase-confirm'), {
    target: { value: passphrase }
  });
}

describe('Phase 2b PR1 — ReprisalIntakeForm wiring (AC-1 / Decision 5)', () => {
  it('calls the injected submit prop with the intake { title, body, passphrase } on a valid submit', async () => {
    const calls: unknown[] = [];
    const submit = vi.fn(async (input: unknown) => {
      calls.push(input);
      return { status: 'ok', id: 'r-1' };
    });
    // The implementer adds a `submit` prop (the wired-in
    // submitReprisalViaProduction closure). RED until added.
    render(ReprisalIntakeForm, { props: { submit } as unknown as Record<string, unknown> });

    await fillValidForm('friction-pass');
    await fireEvent.click(screen.getByTestId('reprisal-save'));
    await Promise.resolve();
    await Promise.resolve();

    expect(submit).toHaveBeenCalledTimes(1);
    const intake = calls[0] as Record<string, unknown>;
    expect(intake.title).toBe('shift cut after raising a safety issue');
    expect(intake.body).toBe('detailed account of the reprisal');
    expect(intake.passphrase).toBe('friction-pass');
  });

  it('does NOT call submit when consent is unchecked (the structural gate still holds)', async () => {
    const submit = vi.fn(async () => ({ status: 'ok', id: 'r-2' }));
    render(ReprisalIntakeForm, { props: { submit } as unknown as Record<string, unknown> });

    // Fill everything EXCEPT ticking consent.
    await fireEvent.input(screen.getByTestId('reprisal-title'), { target: { value: 't' } });
    await fireEvent.input(screen.getByTestId('reprisal-body'), { target: { value: 'b' } });
    await fireEvent.input(screen.getByTestId('reprisal-passphrase'), { target: { value: 'p' } });
    await fireEvent.input(screen.getByTestId('reprisal-passphrase-confirm'), {
      target: { value: 'p' }
    });
    await fireEvent.click(screen.getByTestId('reprisal-save'));
    await Promise.resolve();
    await Promise.resolve();

    expect(submit).not.toHaveBeenCalled();
  });

  it('does NOT call submit when the passphrase + confirmation do not match', async () => {
    const submit = vi.fn(async () => ({ status: 'ok', id: 'r-3' }));
    render(ReprisalIntakeForm, { props: { submit } as unknown as Record<string, unknown> });

    await fireEvent.click(screen.getByTestId('reprisal-consent-checkbox'));
    await fireEvent.input(screen.getByTestId('reprisal-title'), { target: { value: 't' } });
    await fireEvent.input(screen.getByTestId('reprisal-body'), { target: { value: 'b' } });
    await fireEvent.input(screen.getByTestId('reprisal-passphrase'), {
      target: { value: 'one' }
    });
    await fireEvent.input(screen.getByTestId('reprisal-passphrase-confirm'), {
      target: { value: 'two-different' }
    });
    await fireEvent.click(screen.getByTestId('reprisal-save'));
    await Promise.resolve();
    await Promise.resolve();

    expect(submit).not.toHaveBeenCalled();
  });

  it('surfaces a non-PI error state when submit returns rate_limited (no submitted title/body/passphrase in the user-visible error)', async () => {
    const submit = vi.fn(async () => ({ status: 'rate_limited' }));
    render(ReprisalIntakeForm, { props: { submit } as unknown as Record<string, unknown> });

    const titleCanary = 'CANARY-TITLE-RL-FORM';
    const bodyCanary = 'CANARY-BODY-RL-FORM';
    const passCanary = 'CANARY-PASS-RL-FORM';
    await fireEvent.click(screen.getByTestId('reprisal-consent-checkbox'));
    await fireEvent.input(screen.getByTestId('reprisal-title'), { target: { value: titleCanary } });
    await fireEvent.input(screen.getByTestId('reprisal-body'), { target: { value: bodyCanary } });
    await fireEvent.input(screen.getByTestId('reprisal-passphrase'), {
      target: { value: passCanary }
    });
    await fireEvent.input(screen.getByTestId('reprisal-passphrase-confirm'), {
      target: { value: passCanary }
    });
    await fireEvent.click(screen.getByTestId('reprisal-save'));
    await Promise.resolve();
    await Promise.resolve();

    expect(submit).toHaveBeenCalled();
    const errors = screen.queryAllByRole('alert');
    expect(errors.length).toBeGreaterThan(0);
    const errorBlob = errors.map((e) => e.textContent ?? '').join(' ');
    expect(errorBlob).not.toContain(titleCanary);
    expect(errorBlob).not.toContain(bodyCanary);
    expect(errorBlob).not.toContain(passCanary);
    expect(errorBlob.toLowerCase()).not.toContain('hourly');
    expect(errorBlob.toLowerCase()).not.toContain('daily');
  });
});

// ---------------------------------------------------------------------------
// (B) /reprisal/+page.svelte — live cutover, demo removed, guard + CTAs
// ---------------------------------------------------------------------------

describe('Phase 2b PR1 — /reprisal page cutover (Decision 5 / Decision 6)', () => {
  it('the page no longer imports the demo provider (buildDemoReprisals / fetchDemoReprisalPage removed)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).not.toMatch(/buildDemoReprisals\b/);
    expect(src).not.toMatch(/fetchDemoReprisalPage\b/);
  });

  it('the page imports the live feed provider + the probe (listReprisalFeedViaProduction + getCommitteeKeyState)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/listReprisalFeedViaProduction/);
    expect(src).toMatch(/getCommitteeKeyState/);
  });

  it('the page imports the submit + read compositions and the ReprisalIntakeForm', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/submitReprisalViaProduction/);
    expect(src).toMatch(/readReprisalViaProduction/);
    expect(src).toMatch(/ReprisalIntakeForm/);
  });

  it('renders the probe-first no-wrap guard: a "Complete encryption setup in Settings" link (data-testid="reprisal-needs-setup") routing to /settings', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid="reprisal-needs-setup"/);
    expect(src).toMatch(/href="\/settings/);
  });

  it('renders a "Report a reprisal" CTA (data-testid="reprisal-log-cta") that mounts the intake form', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid="reprisal-log-cta"/);
  });

  it('renders a per-row read affordance whose revealed plaintext lives in a role=status region (data-testid contract)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // A stable testid for the per-row read control and the role=status region
    // that holds the temporary plaintext.
    expect(src).toMatch(/data-testid="reprisal-read/);
    expect(src).toMatch(/role="status"/);
  });
});
