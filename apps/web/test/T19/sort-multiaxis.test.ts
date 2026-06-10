/**
 * T19.1 — Sort + multi-axis filter bundle.
 *
 *   - `buildHref` composes URLs preserving + overriding params.
 *   - SortToggle renders two links + marks the active direction.
 *   - /concerns supports status + severity + hazard simultaneously.
 *   - /concerns and /recommendations mount SortToggle.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import SortToggle from '../../src/lib/ui/SortToggle.svelte';
import { buildHref } from '../../src/lib/ui/url-state';

afterEach(() => {
  cleanup();
});

describe('T19.1 — buildHref', () => {
  it('returns the bare path when no params are set', () => {
    expect(buildHref('/concerns')).toBe('/concerns');
  });

  it('merges preserved params with explicit overrides', () => {
    expect(buildHref('/concerns', { filter: 'open' }, { sort: 'oldest' })).toBe(
      '/concerns?filter=open&sort=oldest'
    );
  });

  it('null override removes that key while keeping others', () => {
    expect(buildHref('/concerns', { filter: 'open', severity: 'critical' }, { filter: null })).toBe(
      '/concerns?severity=critical'
    );
  });

  it('empty string is treated as absent', () => {
    expect(buildHref('/x', { a: '', b: 'one' })).toBe('/x?b=one');
  });

  it('undefined values are skipped', () => {
    expect(buildHref('/x', { a: undefined, b: 'one' })).toBe('/x?b=one');
  });

  it('override fully replaces the preserved value', () => {
    expect(buildHref('/x', { filter: 'open' }, { filter: 'archived' })).toBe(
      '/x?filter=archived'
    );
  });
});

describe('T19.1 — SortToggle', () => {
  it('renders two sort-direction links', () => {
    render(SortToggle, {
      props: { baseHref: '/concerns', activeSort: null, preservedParams: {} }
    });
    const links = screen.getAllByTestId('sort-link');
    expect(links.length).toBe(2);
    expect(links[0]!.getAttribute('data-value')).toBe('newest');
    expect(links[1]!.getAttribute('data-value')).toBe('oldest');
  });

  it('marks the newest link active when no sort is set', () => {
    render(SortToggle, {
      props: { baseHref: '/concerns', activeSort: null, preservedParams: {} }
    });
    const links = screen.getAllByTestId('sort-link');
    expect(links[0]!.classList.contains('active')).toBe(true);
    expect(links[0]!.getAttribute('aria-current')).toBe('true');
    expect(links[1]!.getAttribute('aria-current')).toBe('false');
  });

  it('marks the oldest link active when activeSort is "oldest"', () => {
    render(SortToggle, {
      props: { baseHref: '/concerns', activeSort: 'oldest', preservedParams: {} }
    });
    const links = screen.getAllByTestId('sort-link');
    expect(links[1]!.classList.contains('active')).toBe(true);
    expect(links[1]!.getAttribute('aria-current')).toBe('true');
  });

  it('preserves other params in the sort links', () => {
    render(SortToggle, {
      props: {
        baseHref: '/concerns',
        activeSort: null,
        preservedParams: { filter: 'open', severity: 'critical' }
      }
    });
    const links = screen.getAllByTestId('sort-link');
    expect(links[0]!.getAttribute('href')).toBe('/concerns?filter=open&severity=critical');
    expect(links[1]!.getAttribute('href')).toBe(
      '/concerns?filter=open&severity=critical&sort=oldest'
    );
  });

  it('carries data-print="hide"', () => {
    render(SortToggle, {
      props: { baseHref: '/x', activeSort: null, preservedParams: {} }
    });
    const rail = screen.getByTestId('sort-toggle');
    expect(rail.getAttribute('data-print')).toBe('hide');
  });
});

describe('T19.1 — /concerns multi-axis filter wiring', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/concerns/+page.svelte'),
    'utf8'
  );

  it('declares severity + hazard value arrays', () => {
    expect(src).toContain('SEVERITY_VALUES');
    expect(src).toContain('HAZARD_VALUES');
    for (const v of ['low', 'medium', 'high', 'critical']) expect(src).toContain(`'${v}'`);
    for (const v of ['physical', 'chemical', 'biological', 'ergonomic', 'psychosocial']) {
      expect(src).toContain(`'${v}'`);
    }
  });

  it('mounts three FilterChipsRails — status, severity, hazard', () => {
    // Each chip rail has its own activeValue prop; count the mounts.
    const matches = src.match(/<FilterChipsRail/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('composes the predicate across all three axes', () => {
    expect(src).toContain('activeStatus');
    expect(src).toContain('activeSeverity');
    expect(src).toContain('activeHazard');
    // The predicate AND-chains: returns false on any axis mismatch.
    expect(src).toMatch(/if\s*\(activeStatus\s*&&\s*r\.status\s*!==\s*activeStatus\)/);
    expect(src).toMatch(/if\s*\(activeSeverity\s*&&\s*r\.severity\s*!==\s*activeSeverity\)/);
    expect(src).toMatch(/if\s*\(activeHazard\s*&&\s*r\.hazard_class\s*!==\s*activeHazard\)/);
  });
});

describe('T19.1 — SortToggle mounted on /concerns and /recommendations', () => {
  for (const route of ['concerns', 'recommendations']) {
    it(`/${route} imports + mounts SortToggle with preservedParams`, () => {
      const src = readFileSync(
        resolve(__dirname, `../../src/routes/${route}/+page.svelte`),
        'utf8'
      );
      expect(src).toMatch(
        /import\s+SortToggle\s+from\s+['"]\$lib\/ui\/SortToggle\.svelte['"]/
      );
      expect(src).toMatch(/<SortToggle/);
      expect(src).toMatch(/baseHref="\/(concerns|recommendations)"/);
      expect(src).toMatch(/activeSort=\{sortParam\}/);
      expect(src).toMatch(/preservedParams=/);
    });
  }
});

describe('T19.1 — common.sortToggle.* i18n keys', () => {
  it('catalog has aria_label + newest + oldest', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(typeof catalog.common.sortToggle.aria_label).toBe('string');
    expect(typeof catalog.common.sortToggle.newest).toBe('string');
    expect(typeof catalog.common.sortToggle.oldest).toBe('string');
    expect(typeof catalog.common.filterChips.severity_aria_label).toBe('string');
    expect(typeof catalog.common.filterChips.hazard_aria_label).toBe('string');
  });
});
