/**
 * T19.1 — Sort rollout across the remaining 9 routes + DateRangeChips
 * helpers + /audit date-range wiring.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import DateRangeChips from '../../src/lib/ui/DateRangeChips.svelte';
import {
  quickRange,
  detectQuickRange,
  withinRange
} from '../../src/lib/ui/date-range';

afterEach(() => {
  cleanup();
});

describe('T19.1 — SortToggle is mounted on the remaining 9 routes', () => {
  const ROUTES = [
    'training',
    'work-refusal',
    's51-evidence',
    'reprisal',
    'minutes',
    'inspections',
    'library',
    'audit',
    'sensitive-feed'
  ];
  for (const route of ROUTES) {
    it(`/${route} imports + mounts SortToggle`, () => {
      const src = readFileSync(
        resolve(__dirname, `../../src/routes/${route}/+page.svelte`),
        'utf8'
      );
      expect(src).toMatch(
        /import\s+SortToggle\s+from\s+['"]\$lib\/ui\/SortToggle\.svelte['"]/
      );
      expect(src).toMatch(/<SortToggle/);
      expect(src).toMatch(/baseHref=/);
      expect(src).toMatch(/activeSort=\{sortParam\}/);
    });
  }
});

describe('T19.1 — quickRange', () => {
  const PIN = new Date(2026, 5, 10); // June 10, 2026

  it('today returns a same-day window', () => {
    expect(quickRange('today', PIN)).toEqual({ from: '2026-06-10', to: '2026-06-10' });
  });

  it('7days returns a 7-day-inclusive window ending today', () => {
    expect(quickRange('7days', PIN)).toEqual({ from: '2026-06-04', to: '2026-06-10' });
  });

  it('30days returns a 30-day-inclusive window ending today', () => {
    expect(quickRange('30days', PIN)).toEqual({ from: '2026-05-12', to: '2026-06-10' });
  });
});

describe('T19.1 — detectQuickRange', () => {
  const PIN = new Date(2026, 5, 10);

  it('returns the matching name for a canonical pair', () => {
    expect(detectQuickRange('2026-06-10', '2026-06-10', PIN)).toBe('today');
    expect(detectQuickRange('2026-06-04', '2026-06-10', PIN)).toBe('7days');
    expect(detectQuickRange('2026-05-12', '2026-06-10', PIN)).toBe('30days');
  });

  it('returns null for non-canonical (custom) ranges', () => {
    expect(detectQuickRange('2026-06-01', '2026-06-05', PIN)).toBeNull();
  });

  it('returns null when either side is missing', () => {
    expect(detectQuickRange(null, '2026-06-10', PIN)).toBeNull();
    expect(detectQuickRange('2026-06-10', null, PIN)).toBeNull();
    expect(detectQuickRange(null, null, PIN)).toBeNull();
  });
});

describe('T19.1 — withinRange', () => {
  it('passes when no range is set', () => {
    expect(withinRange('2026-06-10T10:00:00.000Z', null, null)).toBe(true);
  });

  it('excludes timestamps before from', () => {
    expect(withinRange('2026-06-03T23:59:59.999Z', '2026-06-04', null)).toBe(false);
  });

  it('includes timestamps within the inclusive window', () => {
    expect(withinRange('2026-06-04T00:00:00.000Z', '2026-06-04', '2026-06-10')).toBe(true);
    expect(withinRange('2026-06-10T23:59:59.000Z', '2026-06-04', '2026-06-10')).toBe(true);
  });

  it('excludes timestamps past the end-of-day on to', () => {
    expect(withinRange('2026-06-11T00:00:00.001Z', '2026-06-04', '2026-06-10')).toBe(false);
  });
});

describe('T19.1 — DateRangeChips', () => {
  it('renders four chips', () => {
    render(DateRangeChips, {
      props: { baseHref: '/audit', fromParam: null, toParam: null, preservedParams: {} }
    });
    expect(screen.getAllByTestId('date-range-chip').length).toBe(4);
  });

  it('marks "All time" active when from/to are absent', () => {
    render(DateRangeChips, {
      props: { baseHref: '/audit', fromParam: null, toParam: null, preservedParams: {} }
    });
    const chips = screen.getAllByTestId('date-range-chip');
    expect(chips[0]!.getAttribute('aria-current')).toBe('true');
  });

  it('preserves other URL params when building chip hrefs', () => {
    render(DateRangeChips, {
      props: {
        baseHref: '/audit',
        fromParam: null,
        toParam: null,
        preservedParams: { filter: 'sessions' }
      }
    });
    const chips = screen.getAllByTestId('date-range-chip');
    expect(chips[0]!.getAttribute('href')).toContain('filter=sessions');
    expect(chips[1]!.getAttribute('href')).toContain('filter=sessions');
  });

  it('carries data-print="hide"', () => {
    render(DateRangeChips, {
      props: { baseHref: '/audit', fromParam: null, toParam: null, preservedParams: {} }
    });
    const rail = screen.getByTestId('date-range-chips');
    expect(rail.getAttribute('data-print')).toBe('hide');
  });
});

describe('T19.1 — /audit route wires DateRangeChips + composes the predicate', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/audit/+page.svelte'),
    'utf8'
  );

  it('imports DateRangeChips + withinRange', () => {
    expect(src).toMatch(
      /import\s+DateRangeChips\s+from\s+['"]\$lib\/ui\/DateRangeChips\.svelte['"]/
    );
    expect(src).toMatch(/import\s+\{\s*withinRange\s*\}\s+from\s+['"]\$lib\/ui\/date-range['"]/);
  });

  it('reads fromParam + toParam from the URL', () => {
    expect(src).toMatch(/\$:\s*fromParam\s*=/);
    expect(src).toMatch(/\$:\s*toParam\s*=/);
  });

  it('composes the date-range predicate with the existing event-type predicate', () => {
    expect(src).toContain('withinRange(r.ts, fromParam, toParam)');
  });

  it('mounts DateRangeChips', () => {
    expect(src).toMatch(/<DateRangeChips/);
  });
});

describe('T19.1 — common.dateRange.* i18n keys', () => {
  it('catalog has the chip labels', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(typeof catalog.common.dateRange.all_time).toBe('string');
    expect(typeof catalog.common.dateRange.today).toBe('string');
    expect(typeof catalog.common.dateRange.last_7_days).toBe('string');
    expect(typeof catalog.common.dateRange.last_30_days).toBe('string');
  });
});

describe('T19.1 — /sensitive-feed route wires DateRangeChips + composes the predicate', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/sensitive-feed/+page.svelte'),
    'utf8'
  );

  it('imports DateRangeChips + withinRange', () => {
    expect(src).toMatch(
      /import\s+DateRangeChips\s+from\s+['"]\$lib\/ui\/DateRangeChips\.svelte['"]/
    );
    expect(src).toMatch(/import\s+\{\s*withinRange\s*\}\s+from\s+['"]\$lib\/ui\/date-range['"]/);
  });

  it('reads fromParam + toParam from the URL', () => {
    expect(src).toMatch(/\$:\s*fromParam\s*=/);
    expect(src).toMatch(/\$:\s*toParam\s*=/);
  });

  it('composes the date-range predicate with the existing tier predicate', () => {
    expect(src).toContain('withinRange(r.ts, fromParam, toParam)');
  });

  it('mounts DateRangeChips', () => {
    expect(src).toMatch(/<DateRangeChips/);
  });
});

describe('T19.1 — /concerns route wires DateRangeChips into its multi-axis predicate', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/concerns/+page.svelte'),
    'utf8'
  );

  it('imports DateRangeChips + withinRange', () => {
    expect(src).toMatch(
      /import\s+DateRangeChips\s+from\s+['"]\$lib\/ui\/DateRangeChips\.svelte['"]/
    );
    expect(src).toMatch(/import\s+\{\s*withinRange\s*\}\s+from\s+['"]\$lib\/ui\/date-range['"]/);
  });

  it('reads fromParam + toParam from the URL', () => {
    expect(src).toMatch(/\$:\s*fromParam\s*=/);
    expect(src).toMatch(/\$:\s*toParam\s*=/);
  });

  it('extends anyAxisActive to include the date range', () => {
    expect(src).toMatch(/anyAxisActive\s*=[\s\S]*fromParam[\s\S]*toParam/);
  });

  it('composes withinRange into the multi-axis predicate against r.filed_at', () => {
    expect(src).toContain('withinRange(r.filed_at, fromParam, toParam)');
  });

  it('mounts <DateRangeChips> with its own preservedParams set', () => {
    expect(src).toMatch(/<DateRangeChips/);
    expect(src).toMatch(/preservedForDateRange/);
  });

  it('every existing axis preserves from + to in its chip hrefs', () => {
    for (const name of ['preservedForStatus', 'preservedForSeverity', 'preservedForHazard', 'preservedForSort']) {
      const re = new RegExp(`${name}[\\s\\S]*?from:\\s*fromParam[\\s\\S]*?to:\\s*toParam`);
      expect(src).toMatch(re);
    }
  });

  it('viewerKey includes fromParam + toParam so the viewer re-mounts on date-range change', () => {
    expect(src).toMatch(/viewerKey\s*=\s*`[^`]*fromParam[^`]*toParam/);
  });
});

describe('T19.1 — DateRangeChips rollout across the 8 register routes', () => {
  // Each register has a different primary date field — the rollout
  // pins both the structural wiring AND the per-route date-field name
  // so a regression where a route accidentally uses the wrong field
  // (e.g. filed_at vs meeting_date) gets caught.
  const ROUTES = /** @type {const} */ [
    { route: 'training', field: 'completed_at' },
    { route: 'work-refusal', field: 'filed_at' },
    { route: 's51-evidence', field: 'opened_at' },
    { route: 'reprisal', field: 'filed_at' },
    { route: 'minutes', field: 'meeting_date' },
    { route: 'inspections', field: 'conducted_at' },
    { route: 'library', field: 'updated_at' },
    { route: 'recommendations', field: 'filed_at' }
  ];

  for (const { route, field } of ROUTES) {
    describe(`/${route}`, () => {
      const src = readFileSync(
        resolve(__dirname, `../../src/routes/${route}/+page.svelte`),
        'utf8'
      );

      it('imports DateRangeChips + withinRange', () => {
        expect(src).toMatch(
          /import\s+DateRangeChips\s+from\s+['"]\$lib\/ui\/DateRangeChips\.svelte['"]/
        );
        expect(src).toMatch(
          /import\s+\{\s*withinRange\s*\}\s+from\s+['"]\$lib\/ui\/date-range['"]/
        );
      });

      it('reads fromParam + toParam from the URL', () => {
        expect(src).toMatch(/\$:\s*fromParam\s*=/);
        expect(src).toMatch(/\$:\s*toParam\s*=/);
      });

      it(`composes the date-range predicate against r.${field}`, () => {
        expect(src).toContain(`withinRange(r.${field}, fromParam, toParam)`);
      });

      it('mounts <DateRangeChips> + preserves filter+sort through the chips', () => {
        expect(src).toMatch(/<DateRangeChips/);
        expect(src).toMatch(/preservedParams=\{\{[^}]*filter:\s*filterParam[^}]*sort:\s*sortParam/);
      });

      it('SortToggle preserves filter+from+to', () => {
        expect(src).toMatch(
          /preservedParams=\{\{[^}]*filter:\s*filterParam[^}]*from:\s*fromParam[^}]*to:\s*toParam/
        );
      });

      it('filterActive composes filterParam || fromParam || toParam', () => {
        expect(src).toMatch(/filterActive=\{[^}]*filterParam\s*!==\s*null[^}]*fromParam[^}]*toParam/);
      });

      it('{#key} includes fromParam + toParam so the viewer re-mounts on any axis change', () => {
        expect(src).toMatch(/#key[^`]*`[^`]*fromParam[^`]*toParam/);
      });
    });
  }
});
