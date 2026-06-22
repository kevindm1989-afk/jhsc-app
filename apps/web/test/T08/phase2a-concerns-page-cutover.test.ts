/**
 * Phase 2a PR2 / P2a-9 — UI cutover for the /concerns route
 * (ADR-0027 Decision 4 + Decision 7).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY.
 *
 * Two surfaces:
 *
 *   (A) `apps/web/src/lib/concerns/ConcernIntakeForm.svelte` — currently
 *       inert. The submit handler (:151-162) validates then flips
 *       `state = 'submitting'` and stops. PR2 must wire it to call
 *       `submitConcernViaProduction` with injected client/keyHolder/
 *       localIdentity/user_id props, surface the discriminated-union
 *       result (ok / rate_limited / rls_denied / session_expiry /
 *       needs_setup / failed) in the form state, and call an
 *       `onSubmitted` callback prop on success.
 *
 *   (B) `apps/web/src/routes/concerns/+page.svelte` — currently mounts
 *       `buildDemoConcerns(50)` and `fetchDemoConcernsPage(...)`. PR2 must
 *       drop the demo data source, wire a LIVE provider that calls
 *       `listConcernsViaProduction`, mount the `ConcernIntakeForm` behind a
 *       "Log a concern" CTA, render a Phase-0a-setup link when
 *       `actor_has_wrap === false`, and remove the demo-only `status`
 *       filter chip rail (Decision 6: no status in Phase 2a).
 *
 * The page module imports SvelteKit `$app/stores` + a long tail of widgets
 * (FilterChipsRail / SavedViewsRail / SortToggle …) whose unit-test mount
 * requires considerable harness scaffolding. To keep this test hermetic +
 * fast we assert the page CONTRACT via a source-level structural check
 * (the implementer's PR2 diff MUST satisfy the contract; the source-level
 * assertions are a faithful proxy for the cutover behavior).
 *
 * TEST → AC / FINDING MAP
 *   AC-1 (submit wired)          — ConcernIntakeForm calls
 *                                  submitConcernViaProduction with the
 *                                  intake; the form state advances to a
 *                                  submitted state on ok.
 *   AC-6 (rate-limit surface)    — rate_limited result surfaces as an
 *                                  error state (no PI in copy; no window
 *                                  disclosed).
 *   AC-7 (no-key guard, page)    — page renders the "Complete encryption
 *                                  setup in Settings" link when
 *                                  actor_has_wrap=false.
 *   Decision 6 (no status)       — the page's `status` chip rail / filter
 *                                  axis is removed from the live path.
 *   Decision 4 (form CTA + live) — page imports the live list provider +
 *                                  the ConcernIntakeForm; the demo
 *                                  provider is no longer imported.
 *
 * Hermetic: real ConcernIntakeForm component; mocked
 * submitConcernViaProduction injected through a typed prop slot the
 * implementer adds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ConcernIntakeForm from '../../src/lib/concerns/ConcernIntakeForm.svelte';

const PAGE_PATH = resolve(__dirname, '../../src/routes/concerns/+page.svelte');

beforeEach(() => {
  // Nothing — each test owns its own mocks/spies.
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// (A) ConcernIntakeForm — submit handler wires to submitConcernViaProduction
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — ConcernIntakeForm wiring (AC-1 / Decision 4 step 4)', () => {
  it('calls the injected submit handler with the intake payload (title/body/anonymous/hazard/severity/location) on a valid submit', async () => {
    const calls: unknown[] = [];
    const submit = vi.fn(async (input: unknown) => {
      calls.push(input);
      return { status: 'ok', id: 'c-1' };
    });
    // The implementer adds a `submit` prop (the wired-in
    // submitConcernViaProduction closure) so the form is testable without
    // hauling the full crypto stack into a unit test. RED until added.
    render(ConcernIntakeForm, { props: { submit } as unknown as Record<string, unknown> });

    await fireEvent.input(screen.getByTestId('concern-title'), {
      target: { value: 'forklift incident' }
    });
    await fireEvent.input(screen.getByTestId('concern-body'), {
      target: { value: 'near miss in receiving' }
    });
    // Hazard, severity, location — keep their default-empty values to keep
    // the test minimal; the library validates them downstream. The form's
    // pre-submit gate only blocks on empty title/body/source-name.
    await fireEvent.click(screen.getByTestId('concern-save'));
    // Allow microtasks for the async submit handler to fire.
    await Promise.resolve();
    await Promise.resolve();

    expect(submit).toHaveBeenCalledTimes(1);
    const intake = calls[0] as Record<string, unknown>;
    expect(intake.title).toBe('forklift incident');
    expect(intake.body).toBe('near miss in receiving');
    expect(intake.anonymous).toBe(true);
  });

  it('forwards anonymous=false + a non-empty source_name_plaintext when the toggle is flipped off and a name is typed', async () => {
    const submit = vi.fn(async () => ({ status: 'ok', id: 'c-2' }));
    render(ConcernIntakeForm, { props: { submit } as unknown as Record<string, unknown> });

    // Flip the toggle off (named source).
    await fireEvent.click(screen.getByTestId('concern-anonymous-toggle'));
    await fireEvent.input(screen.getByTestId('concern-source-name'), {
      target: { value: 'CANARY-FIXTURE-NAME-DO-NOT-USE' }
    });
    await fireEvent.input(screen.getByTestId('concern-title'), {
      target: { value: 't' }
    });
    await fireEvent.input(screen.getByTestId('concern-body'), {
      target: { value: 'b' }
    });
    await fireEvent.click(screen.getByTestId('concern-save'));
    await Promise.resolve();
    await Promise.resolve();

    expect(submit).toHaveBeenCalledTimes(1);
    const intake = (submit.mock.calls[0]![0] ?? {}) as Record<string, unknown>;
    expect(intake.anonymous).toBe(false);
    expect(intake.source_name_plaintext).toBe('CANARY-FIXTURE-NAME-DO-NOT-USE');
  });

  it('surfaces the rate_limited result as a non-PI error state (no submitted title/body strings in the user-visible error)', async () => {
    const submit = vi.fn(async () => ({ status: 'rate_limited' }));
    render(ConcernIntakeForm, { props: { submit } as unknown as Record<string, unknown> });
    const titleCanary = 'CANARY-TITLE-RATE-LIMIT-XYZ';
    const bodyCanary = 'CANARY-BODY-RATE-LIMIT-XYZ';
    await fireEvent.input(screen.getByTestId('concern-title'), {
      target: { value: titleCanary }
    });
    await fireEvent.input(screen.getByTestId('concern-body'), {
      target: { value: bodyCanary }
    });
    await fireEvent.click(screen.getByTestId('concern-save'));
    await Promise.resolve();
    await Promise.resolve();

    expect(submit).toHaveBeenCalled();
    // The form is no longer in the success/submitted state; some user-
    // visible error is rendered (role=alert) without leaking the submitted
    // canaries or any "hourly"/"daily" hint.
    const errors = screen.queryAllByRole('alert');
    expect(errors.length).toBeGreaterThan(0);
    const errorBlob = errors.map((e) => e.textContent ?? '').join(' ');
    expect(errorBlob).not.toContain(titleCanary);
    expect(errorBlob).not.toContain(bodyCanary);
    expect(errorBlob.toLowerCase()).not.toContain('hourly');
    expect(errorBlob.toLowerCase()).not.toContain('daily');
  });

  it('surfaces session_expiry as an explicit sign-in-required surface (so the route can hand-off to /sign-in)', async () => {
    const submit = vi.fn(async () => ({ status: 'session_expiry' }));
    render(ConcernIntakeForm, { props: { submit } as unknown as Record<string, unknown> });
    await fireEvent.input(screen.getByTestId('concern-title'), { target: { value: 't' } });
    await fireEvent.input(screen.getByTestId('concern-body'), { target: { value: 'b' } });
    await fireEvent.click(screen.getByTestId('concern-save'));
    await Promise.resolve();
    await Promise.resolve();

    // Implementer renders some indication of session-expired (data-testid
    // OR an alert with sign-in copy). At minimum the form did NOT advance
    // to a success state — the form-error role=alert is visible.
    const errors = screen.queryAllByRole('alert');
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (B) /concerns/+page.svelte — live provider + form CTA + no-status + guard
// ---------------------------------------------------------------------------

describe('Phase 2a PR2 — /concerns page cutover (Decision 4 / Decision 6 / Decision 7)', () => {
  it('the page imports the live ConcernIntakeForm and the live list provider — and no longer imports the demo provider', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Live path imports:
    expect(src).toMatch(/ConcernIntakeForm/);
    expect(src).toMatch(/listConcernsViaProduction/);
    // Demo path imports removed:
    expect(src).not.toMatch(/buildDemoConcerns\b/);
    expect(src).not.toMatch(/fetchDemoConcernsPage\b/);
  });

  it('the page renders a "Log a concern" CTA that mounts the intake form (data-testid contract)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Either a literal data-testid attribute or an explicit CTA marker.
    expect(src).toMatch(/data-testid="concerns-log-cta"/);
  });

  it('the page renders a "Complete encryption setup in Settings" link when actor_has_wrap===false (AC-7)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // The guard surface — a stable testid for the no-wrap branch.
    expect(src).toMatch(/data-testid="concerns-needs-setup"/);
    // Routes the worker to Settings (the Phase 0a setup card).
    expect(src).toMatch(/href="\/settings/);
  });

  it('the live path drops the demo-only `status` filter chip rail (Decision 6: no status in Phase 2a)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // The demo path had `STATUS_VALUES` + `statusChips` + a FilterChipsRail
    // for status; the live path removes them. (Severity + hazard + date-
    // range chips remain — those map to real columns.)
    expect(src).not.toMatch(/STATUS_VALUES/);
    expect(src).not.toMatch(/statusChips/);
  });

  it('the page wires a per-row source-reveal affordance for has_named_source rows (passphrase prompt → revealConcernSourceViaProduction)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    // Reveal CTA + the production composition import (or a wrapper that
    // imports it). The implementer chooses the exact testid name; we pin
    // the stable contract.
    expect(src).toMatch(/revealConcernSourceViaProduction/);
    expect(src).toMatch(/data-testid="concerns-reveal-source"/);
  });

  it('the page consults getCommitteeKeyState as the probe-first guard before reaching the disclosure RPC (Decision 7)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/getCommitteeKeyState/);
  });
});
