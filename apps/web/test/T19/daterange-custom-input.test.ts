/**
 * T19 — DateRangeChips custom-range typeable inputs.
 *
 * Covers:
 *   - The custom-range block renders two date inputs + an Apply link.
 *   - Initial input values reflect ?from / ?to URL state.
 *   - Typing into an input updates the Apply link's href reactively.
 *   - The Apply link composes preservedParams (other URL state) into
 *     its href so it doesn't drop filter/sort axes.
 *   - The block carries data-print="hide" so it stays off paper.
 *   - The i18n keys are present.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import DateRangeChips from '../../src/lib/ui/DateRangeChips.svelte';

afterEach(() => {
  cleanup();
});

describe('T19 — DateRangeChips custom-range inputs', () => {
  it('renders two date inputs + an Apply link', () => {
    render(DateRangeChips, {
      props: { baseHref: '/audit', fromParam: null, toParam: null, preservedParams: {} }
    });
    expect(screen.getByTestId('date-range-custom-from')).toBeDefined();
    expect(screen.getByTestId('date-range-custom-to')).toBeDefined();
    expect(screen.getByTestId('date-range-custom-apply')).toBeDefined();
  });

  it('seeds the inputs with the current ?from / ?to URL state', () => {
    render(DateRangeChips, {
      props: {
        baseHref: '/audit',
        fromParam: '2026-05-01',
        toParam: '2026-05-31',
        preservedParams: {}
      }
    });
    const fromEl = /** @type {HTMLInputElement} */ (
      screen.getByTestId('date-range-custom-from')
    );
    const toEl = /** @type {HTMLInputElement} */ (
      screen.getByTestId('date-range-custom-to')
    );
    expect(fromEl.value).toBe('2026-05-01');
    expect(toEl.value).toBe('2026-05-31');
  });

  it('Apply href reflects the inputs (after the worker types) without dropping preserved params', async () => {
    render(DateRangeChips, {
      props: {
        baseHref: '/audit',
        fromParam: null,
        toParam: null,
        preservedParams: { filter: 'sessions' }
      }
    });
    const fromEl = /** @type {HTMLInputElement} */ (
      screen.getByTestId('date-range-custom-from')
    );
    const toEl = /** @type {HTMLInputElement} */ (
      screen.getByTestId('date-range-custom-to')
    );
    await fireEvent.input(fromEl, { target: { value: '2026-05-01' } });
    await fireEvent.input(toEl, { target: { value: '2026-05-31' } });
    const apply = screen.getByTestId('date-range-custom-apply');
    const href = apply.getAttribute('href') ?? '';
    expect(href).toContain('from=2026-05-01');
    expect(href).toContain('to=2026-05-31');
    expect(href).toContain('filter=sessions');
  });

  it('Apply href returns to the bare base when both inputs are empty', async () => {
    render(DateRangeChips, {
      props: {
        baseHref: '/audit',
        fromParam: '2026-05-01',
        toParam: '2026-05-31',
        preservedParams: {}
      }
    });
    const fromEl = /** @type {HTMLInputElement} */ (
      screen.getByTestId('date-range-custom-from')
    );
    const toEl = /** @type {HTMLInputElement} */ (
      screen.getByTestId('date-range-custom-to')
    );
    await fireEvent.input(fromEl, { target: { value: '' } });
    await fireEvent.input(toEl, { target: { value: '' } });
    expect(screen.getByTestId('date-range-custom-apply').getAttribute('href')).toBe('/audit');
  });

  it('the custom block carries data-print="hide"', () => {
    render(DateRangeChips, {
      props: { baseHref: '/audit', fromParam: null, toParam: null, preservedParams: {} }
    });
    expect(screen.getByTestId('date-range-custom').getAttribute('data-print')).toBe('hide');
  });
});

describe('T19 — common.dateRange custom-range i18n keys', () => {
  it('catalog carries the custom-range strings', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(typeof catalog.common.dateRange.custom_aria).toBe('string');
    expect(typeof catalog.common.dateRange.custom_from_label).toBe('string');
    expect(typeof catalog.common.dateRange.custom_to_label).toBe('string');
    expect(typeof catalog.common.dateRange.custom_apply).toBe('string');
  });
});
