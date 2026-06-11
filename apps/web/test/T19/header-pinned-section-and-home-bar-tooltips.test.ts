/**
 * T19 — HeaderSearch dropdown surfaces pinned saved views;
 * HomeDashboard sparkline carries per-bar SVG <title> tooltips;
 * /search surfaces recent searches as quick-jump chips when the
 * query is empty + records ?q= queries into the recent-searches
 * store.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import HeaderSearch from '../../src/lib/ui/HeaderSearch.svelte';
import HomeDashboard from '../../src/lib/home/HomeDashboard.svelte';
import {
  addSavedView,
  setSavedViewPinned
} from '../../src/lib/saved-views/saved-views';
import { recordRecentSearch } from '../../src/lib/search/recent-searches';
import { ZERO_SUMMARY, type HomeSummary } from '../../src/lib/home/home-summary';

beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('T19 — HeaderSearch dropdown surfaces pinned saved views', () => {
  it('does not render the panel when there are no recents AND no pinned views', () => {
    render(HeaderSearch);
    expect(screen.queryByTestId('header-search-recents')).toBeNull();
  });

  it('opens the panel on focus when pinned views exist (even without recents)', async () => {
    const a = addSavedView({ name: 'Open H', route: '/concerns', search: '?filter=open' });
    setSavedViewPinned(a.id, true);
    render(HeaderSearch);
    await fireEvent.focus(screen.getByTestId('header-search-input'));
    await waitFor(() => {
      expect(screen.getByTestId('header-search-recents')).toBeDefined();
    });
    expect(screen.getByTestId('header-search-pinned')).toBeDefined();
    const link = screen.getByTestId('header-search-pinned-link');
    expect(link.getAttribute('href')).toBe('/concerns?filter=open');
    expect(link.getAttribute('data-id')).toBe(a.id);
  });

  it('only pinned views render in the pinned section (unpinned saved views are filtered)', async () => {
    addSavedView({ name: 'Other', route: '/concerns', search: '' });
    const a = addSavedView({ name: 'Pinned A', route: '/concerns', search: '?a=1' });
    setSavedViewPinned(a.id, true);
    render(HeaderSearch);
    await fireEvent.focus(screen.getByTestId('header-search-input'));
    await waitFor(() => {
      expect(screen.getByTestId('header-search-recents')).toBeDefined();
    });
    const rows = screen.getAllByTestId('header-search-pinned-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent ?? '').toContain('Pinned A');
  });

  it('clicking a pinned link closes the panel', async () => {
    const a = addSavedView({ name: 'X', route: '/c', search: '' });
    setSavedViewPinned(a.id, true);
    render(HeaderSearch);
    await fireEvent.focus(screen.getByTestId('header-search-input'));
    await waitFor(() => {
      expect(screen.getByTestId('header-search-recents')).toBeDefined();
    });
    await fireEvent.click(screen.getByTestId('header-search-pinned-link'));
    await waitFor(() => {
      expect(screen.queryByTestId('header-search-recents')).toBeNull();
    });
  });

  it('both sections render together when both recents + pinned views exist', async () => {
    recordRecentSearch('forklift');
    const a = addSavedView({ name: 'Pinned', route: '/c', search: '' });
    setSavedViewPinned(a.id, true);
    render(HeaderSearch);
    await fireEvent.focus(screen.getByTestId('header-search-input'));
    await waitFor(() => {
      expect(screen.getByTestId('header-search-recents')).toBeDefined();
    });
    expect(screen.getByTestId('header-search-pinned')).toBeDefined();
    expect(screen.getAllByTestId('header-search-recent-row')).toHaveLength(1);
  });
});

describe('T19 — HomeDashboard sparkline per-bar tooltip', () => {
  it('wraps each bar in a <g data-testid="hd-tile-report-spark-bar"> with a <title>', () => {
    const summary: HomeSummary = {
      ...ZERO_SUMMARY,
      currentMonthActivity: 12,
      priorMonthActivity: 7,
      monthlyActivityTrailing: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      monthlyActivityTrailingMonths: [
        '2025-07',
        '2025-08',
        '2025-09',
        '2025-10',
        '2025-11',
        '2025-12',
        '2026-01',
        '2026-02',
        '2026-03',
        '2026-04',
        '2026-05',
        '2026-06'
      ]
    };
    render(HomeDashboard, { props: { summary } });
    const bars = screen.getAllByTestId('hd-tile-report-spark-bar');
    expect(bars.length).toBe(12);
    // Each <g> contains a <title> with "Mmm YYYY: N"-shaped text.
    const firstTitle = bars[0]!.querySelector('title');
    expect(firstTitle?.textContent ?? '').toMatch(/2025/);
    expect(firstTitle?.textContent ?? '').toMatch(/\b1\b/);
    const lastTitle = bars[bars.length - 1]!.querySelector('title');
    expect(lastTitle?.textContent ?? '').toMatch(/Jun/);
    expect(lastTitle?.textContent ?? '').toMatch(/\b12\b/);
  });

  it('omits the <title> tooltip when there are no month labels', () => {
    const summary: HomeSummary = {
      ...ZERO_SUMMARY,
      currentMonthActivity: 12,
      monthlyActivityTrailing: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
      // No monthlyActivityTrailingMonths
    };
    render(HomeDashboard, { props: { summary } });
    const bars = screen.getAllByTestId('hd-tile-report-spark-bar');
    expect(bars.length).toBe(12);
    expect(bars[0]!.querySelector('title')).toBeNull();
  });
});

describe('T19 — home-summary carries the parallel month-label series', () => {
  it('ZERO_SUMMARY defaults monthlyActivityTrailingMonths to []', () => {
    expect(ZERO_SUMMARY.monthlyActivityTrailingMonths).toEqual([]);
  });
});

describe('T19 — /search recents chips + URL-driven recording', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/search/+page.svelte'),
    'utf8'
  );

  it('imports the recent-searches helpers', () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\blistRecentSearches\b[^}]*\}\s+from\s+['"]\$lib\/search\/recent-searches['"]/
    );
    expect(src).toMatch(
      /import\s*\{[^}]*\brecordRecentSearch\b[^}]*\}\s+from\s+['"]\$lib\/search\/recent-searches['"]/
    );
  });

  it('records the URL q param on transition (so deep-link landings are remembered)', () => {
    expect(src).toMatch(/recordRecentSearch\(q\)/);
  });

  it('renders a recents nav block when query is empty + recents exist', () => {
    expect(src).toMatch(/data-testid=["']search-recents["']/);
    expect(src).toMatch(/data-testid=["']search-recents-chip["']/);
  });

  it('each chip href is /search?q=<encoded>', () => {
    expect(src).toContain('/search?q=${encodeURIComponent(r)}');
  });
});

describe('T19 — landing page wires the parallel month-label series', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/+page.svelte'),
    'utf8'
  );

  it('captures trailingReports + maps the parallel month labels', () => {
    expect(src).toContain('monthlyActivityTrailingMonths');
    expect(src).toMatch(/trailingReports\.map\(\(r\)\s*=>\s*r\.month\)/);
  });
});

describe('T19 — i18n keys for the new affordances', () => {
  const catalog = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
  );

  it('headerSearch carries the pinned_label string', () => {
    expect(typeof catalog.common.headerSearch.pinned_label).toBe('string');
  });

  it('home.dashboard.tile carries the sparkline_bar_tooltip with {month} + {value}', () => {
    expect(catalog.home.dashboard.tile.sparkline_bar_tooltip).toContain('{month}');
    expect(catalog.home.dashboard.tile.sparkline_bar_tooltip).toContain('{value}');
  });

  it('search.page carries the recents label + aria strings', () => {
    expect(typeof catalog.search.page.recents_label).toBe('string');
    expect(typeof catalog.search.page.recents_aria).toBe('string');
  });
});
