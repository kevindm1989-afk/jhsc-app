/**
 * T08 / G-T08-12 residual — explicit `role="alert"` per-submit error
 * pattern on the named-source `sourceName` input.
 *
 * The library at `concern-core.ts:143-146` already catches empty
 * `source_name_plaintext` with `anonymous: false` (403 with
 * `{error: 'forbidden'}`) — defense-in-depth. The prior partial-close
 * (`aria-required="true"` + `aria-describedby` to the advisory) covered
 * the structural-announcement half but not the per-submit visible-error
 * half. This file pins the residual: an empty `sourceName` submitted
 * with named-source selected surfaces an inline `<p role="alert">`
 * mirroring the title/body error pattern, and the form's `state` flips
 * to `'error'` rather than submitting.
 *
 * NEW file (existing T08 tests are read-only per test-plan.md §6).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import ConcernIntakeForm from '../../src/lib/concerns/ConcernIntakeForm.svelte';

beforeEach(() => {
  // No clock dependence here — pure form-side validation.
});
afterEach(() => {
  cleanup();
});

describe('T08 / G-T08-12 — per-submit role="alert" on empty named-source name', () => {
  it('switching to named-source, leaving sourceName empty, submitting → inline role="alert" appears + form does NOT enter submitting state', async () => {
    const { container } = render(ConcernIntakeForm);

    // Flip off anonymous (the source-name input + advisory render).
    await fireEvent.click(screen.getByRole('switch', { name: /anonymous/i }));

    // Fill title + body so the OTHER validation gates don't trip and
    // mask the source-name path. This isolates the G-T08-12 assertion.
    await fireEvent.input(screen.getByTestId('concern-title'), { target: { value: 'a title' } });
    await fireEvent.input(screen.getByTestId('concern-body'), { target: { value: 'a body' } });

    // Confirm sourceName is empty (the bind:value default).
    const sourceName = screen.getByTestId('concern-source-name') as HTMLInputElement;
    expect(sourceName.value).toBe('');

    // Submit.
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    await fireEvent.submit(form!);

    // role="alert" inline error appears and announces the validation
    // message. The advisory ALSO uses role="status" — we narrow on
    // role="alert" to disambiguate.
    const alerts = screen.getAllByRole('alert');
    const sourceNameError = alerts.find((el) =>
      /worker['’]s name|switch back to anonymous/i.test(el.textContent ?? '')
    );
    expect(sourceNameError, 'expected a role="alert" with the source-name validation copy').toBeDefined();

    // The source-name input wires `aria-invalid` + `aria-describedby` to
    // both the advisory id AND the new error id, mirroring title/body.
    expect(sourceName.getAttribute('aria-invalid')).toBe('true');
    const describedBy = sourceName.getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(/\s+/)).toContain('concern-source-name-err');

    // Form did NOT enter submitting state (aria-busy stays false).
    const section = screen.getByTestId('concern-intake-form');
    expect(section.getAttribute('aria-busy')).toBe('false');
  });

  it('switching to named-source with a valid sourceName clears the error path on the next submit attempt', async () => {
    const { container } = render(ConcernIntakeForm);
    await fireEvent.click(screen.getByRole('switch', { name: /anonymous/i }));
    await fireEvent.input(screen.getByTestId('concern-title'), { target: { value: 'a title' } });
    await fireEvent.input(screen.getByTestId('concern-body'), { target: { value: 'a body' } });

    // First submit with empty source — error appears.
    await fireEvent.submit(container.querySelector('form')!);
    const sourceName = screen.getByTestId('concern-source-name') as HTMLInputElement;
    expect(sourceName.getAttribute('aria-invalid')).toBe('true');

    // Fill it in. (The `aria-invalid` only flips back when `state` is
    // no longer 'error' AND the source is non-empty — we submit again
    // to advance state.)
    await fireEvent.input(sourceName, { target: { value: 'A. Reporter' } });
    await fireEvent.submit(container.querySelector('form')!);

    // Form left 'error' state (aria-busy flipped to 'true' for the
    // submitting branch, OR the alert is gone — assert the latter
    // because the submit may have moved to 'submitting' in this
    // render-only harness).
    const alerts = screen.queryAllByRole('alert');
    const stillBadName = alerts.find((el) =>
      /worker['’]s name|switch back to anonymous/i.test(el.textContent ?? '')
    );
    expect(stillBadName, 'source-name role="alert" must clear once the name is non-empty').toBeUndefined();
  });

  it('anonymous=true (default) — the source-name input is unrendered, so the validation gate cannot fire on it', async () => {
    const { container } = render(ConcernIntakeForm);
    await fireEvent.input(screen.getByTestId('concern-title'), { target: { value: 'a title' } });
    await fireEvent.input(screen.getByTestId('concern-body'), { target: { value: 'a body' } });
    await fireEvent.submit(container.querySelector('form')!);

    // No source-name input in the DOM under anonymous=true.
    expect(screen.queryByTestId('concern-source-name')).toBeNull();
    // And no source-name-flavoured role="alert".
    const alerts = screen.queryAllByRole('alert');
    const sourceNameAlert = alerts.find((el) =>
      /worker['’]s name|switch back to anonymous/i.test(el.textContent ?? '')
    );
    expect(sourceNameAlert).toBeUndefined();
  });
});
