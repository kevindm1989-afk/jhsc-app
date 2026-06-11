/**
 * T19 — ActiveFiltersBar component.
 *
 * Covers:
 *   - The bar renders nothing when no filters are active (so the
 *     chrome stays out of the way in the common case).
 *   - With filters supplied it renders one pill per filter plus a
 *     "Clear all" pill linking back to the base route.
 *   - Each pill's remove link points to the supplied removeHref.
 *   - The /concerns route page wires it up: imports, computes the
 *     activeFilters array, and mounts the component above its chip
 *     rails.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ActiveFiltersBar from '../../src/lib/ui/ActiveFiltersBar.svelte';

afterEach(() => {
  cleanup();
});

describe('T19 — ActiveFiltersBar', () => {
  it('renders nothing when filters is empty', () => {
    render(ActiveFiltersBar, { props: { baseHref: '/concerns', filters: [] } });
    expect(screen.queryByTestId('active-filters-bar')).toBeNull();
  });

  it('renders one pill per filter + a "Clear all" pill', () => {
    render(ActiveFiltersBar, {
      props: {
        baseHref: '/concerns',
        filters: [
          { key: 'status', label: 'Status: Open', removeHref: '/concerns?severity=high' },
          {
            key: 'severity',
            label: 'Severity: High',
            removeHref: '/concerns?filter=open'
          }
        ]
      }
    });
    expect(screen.getByTestId('active-filters-bar')).toBeDefined();
    expect(screen.getAllByTestId('active-filter-pill').length).toBe(2);
    expect(screen.getByTestId('active-filters-clear-all').getAttribute('href')).toBe(
      '/concerns'
    );
  });

  it("each pill's remove link points to the supplied removeHref", () => {
    render(ActiveFiltersBar, {
      props: {
        baseHref: '/concerns',
        filters: [
          { key: 'status', label: 'Status: Open', removeHref: '/concerns?severity=high' }
        ]
      }
    });
    const remove = screen.getByTestId('active-filter-remove');
    expect(remove.getAttribute('href')).toBe('/concerns?severity=high');
    expect(remove.getAttribute('data-key')).toBe('status');
  });

  it('carries data-print="hide" so it does not appear in printed views', () => {
    render(ActiveFiltersBar, {
      props: {
        baseHref: '/concerns',
        filters: [{ key: 'status', label: 'x', removeHref: '/concerns' }]
      }
    });
    expect(screen.getByTestId('active-filters-bar').getAttribute('data-print')).toBe('hide');
  });
});

describe('T19 — /concerns route wires ActiveFiltersBar', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/concerns/+page.svelte'),
    'utf8'
  );

  it('imports + mounts ActiveFiltersBar', () => {
    expect(src).toMatch(
      /import\s+ActiveFiltersBar\s+from\s+['"]\$lib\/ui\/ActiveFiltersBar\.svelte['"]/
    );
    expect(src).toMatch(/<ActiveFiltersBar/);
  });

  it('computes an activeFilters array reactively from the current axes', () => {
    expect(src).toMatch(/\$:\s*activeFilters\s*=/);
  });

  it('exposes a removeHref entry per active axis (status, severity, hazard, date, sort)', () => {
    // The descriptor objects carry a `key` matching each axis name.
    for (const k of ['status', 'severity', 'hazard', 'date', 'sort']) {
      expect(src).toContain(`key: '${k}'`);
    }
  });
});

describe('T19 — common.activeFilters.* i18n keys', () => {
  it('catalog has label + region_aria + clear_all + remove_aria', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(typeof catalog.common.activeFilters.label).toBe('string');
    expect(typeof catalog.common.activeFilters.region_aria).toBe('string');
    expect(typeof catalog.common.activeFilters.clear_all).toBe('string');
    // remove_aria carries a {label} placeholder
    expect(catalog.common.activeFilters.remove_aria).toContain('{label}');
  });

  it('catalog has axis labels for every multi-axis dimension', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    for (const axis of [
      'status',
      'severity',
      'hazard',
      'stage',
      'scene_state',
      'validity',
      'integrity_status',
      'category',
      'sensitivity',
      'sort',
      'date_range'
    ]) {
      expect(typeof catalog.common.activeFilters.axis[axis]).toBe('string');
    }
  });
});
