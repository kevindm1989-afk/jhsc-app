/**
 * T19.1 — FilterChipsRail component + concerns / recommendations
 * route page wiring.
 *
 * Pins:
 *   - The chip rail renders one chip per item in `chips`.
 *   - The chip whose `value` matches `activeValue` carries
 *     aria-current="page" + the active class.
 *   - Each chip's href + data-value attributes match what's supplied.
 *   - The route pages now declare the four canonical status values
 *     they support (so a refactor that drops one is loud) and use
 *     the FilterChipsRail to surface them.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import FilterChipsRail from '../../src/lib/ui/FilterChipsRail.svelte';

afterEach(() => {
  cleanup();
});

const SAMPLE_CHIPS = [
  { href: '/concerns', label: 'All', value: null },
  { href: '/concerns?filter=open', label: 'Open', value: 'open' },
  { href: '/concerns?filter=triaged', label: 'Triaged', value: 'triaged' },
  { href: '/concerns?filter=resolved', label: 'Resolved', value: 'resolved' },
  { href: '/concerns?filter=archived', label: 'Archived', value: 'archived' }
];

describe('T19.1 — FilterChipsRail', () => {
  it('renders one chip per supplied item', () => {
    render(FilterChipsRail, { props: { chips: SAMPLE_CHIPS, activeValue: null } });
    const chips = screen.getAllByTestId('filter-chip');
    expect(chips.length).toBe(SAMPLE_CHIPS.length);
  });

  it('marks the chip whose value matches activeValue with aria-current="page"', () => {
    render(FilterChipsRail, { props: { chips: SAMPLE_CHIPS, activeValue: 'open' } });
    const chips = screen.getAllByTestId('filter-chip');
    const active = chips.filter((c) => c.getAttribute('aria-current') === 'page');
    expect(active.length).toBe(1);
    expect(active[0]!.getAttribute('data-value')).toBe('open');
    expect(active[0]!.textContent?.trim()).toBe('Open');
  });

  it('marks the "All" chip active when activeValue is null', () => {
    render(FilterChipsRail, { props: { chips: SAMPLE_CHIPS, activeValue: null } });
    const chips = screen.getAllByTestId('filter-chip');
    const active = chips.filter((c) => c.getAttribute('aria-current') === 'page');
    expect(active.length).toBe(1);
    expect(active[0]!.textContent?.trim()).toBe('All');
    // The "All" chip uses an empty string for data-value (null → '' attr).
    expect(active[0]!.getAttribute('data-value')).toBe('');
  });

  it('preserves each chip href and label verbatim', () => {
    render(FilterChipsRail, { props: { chips: SAMPLE_CHIPS, activeValue: 'triaged' } });
    const chips = screen.getAllByTestId('filter-chip');
    const hrefs = chips.map((c) => c.getAttribute('href'));
    expect(hrefs).toEqual(SAMPLE_CHIPS.map((c) => c.href));
  });
});

// T19.1 — /concerns route wires the FilterChipsRail — RETIRED by ADR-0027
// Phase 2a PR2: live /concerns has no status filter rail (Decision 6 — status
// is out of Phase 2a). The post-cutover contract is pinned by the PR2 page-
// cutover test. The component-level tests above are unaffected.

describe('T19.1 — /recommendations route wires the FilterChipsRail with all four status chips', () => {
  const PAGE_PATH = resolve(__dirname, '../../src/routes/recommendations/+page.svelte');

  it('imports FilterChipsRail and mounts it with chips + activeValue', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(
      /import\s+FilterChipsRail\s+from\s+['"]\$lib\/ui\/FilterChipsRail\.svelte['"]/
    );
    expect(src).toMatch(/<FilterChipsRail\s+\{chips\}\s+\{activeValue\}/);
  });

  it('declares the four canonical status values', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    for (const value of ['responded', 'pending', 'overdue', 'archived']) {
      expect(src).toContain(`'${value}'`);
    }
  });
});

describe('T19.1 — common.filterChips.* i18n keys are present', () => {
  it('the catalog has aria_label + all', () => {
    const catalogPath = resolve(__dirname, '../../../../i18n/en-CA.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    expect(catalog.common.filterChips).toBeDefined();
    expect(typeof catalog.common.filterChips.aria_label).toBe('string');
    expect(typeof catalog.common.filterChips.all).toBe('string');
  });
});
