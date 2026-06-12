/**
 * T19 — recent-routes service + HomeDashboard RecentRoutesCard +
 * layout records every navigation.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import RecentRoutesCard from '../../src/lib/home/RecentRoutesCard.svelte';
import {
  clearRecentRoutes,
  listRecentRoutes,
  MAX_ENTRIES,
  recordRouteVisit
} from '../../src/lib/nav/recent-routes';

beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('T19 — recent-routes service', () => {
  it('listRecentRoutes returns [] on a fresh device', () => {
    expect(listRecentRoutes()).toEqual([]);
  });

  it('recordRouteVisit persists a normalized route + ISO timestamp', () => {
    recordRouteVisit('/concerns');
    const all = listRecentRoutes();
    expect(all).toHaveLength(1);
    expect(all[0]!.route).toBe('/concerns');
    expect(all[0]!.visitedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('strips querystrings + fragments before storing', () => {
    recordRouteVisit('/concerns?filter=open#row-1');
    expect(listRecentRoutes()[0]!.route).toBe('/concerns');
  });

  it('dedupes (moves an existing route to the front instead of duplicating)', () => {
    recordRouteVisit('/concerns');
    recordRouteVisit('/recommendations');
    recordRouteVisit('/concerns');
    const all = listRecentRoutes();
    expect(all).toHaveLength(2);
    expect(all[0]!.route).toBe('/concerns');
    expect(all[1]!.route).toBe('/recommendations');
  });

  it('caps the history at MAX_ENTRIES', () => {
    for (const r of [
      '/concerns',
      '/recommendations',
      '/training',
      '/inspections',
      '/library',
      '/minutes',
      '/audit'
    ]) {
      recordRouteVisit(r);
    }
    expect(listRecentRoutes()).toHaveLength(MAX_ENTRIES);
  });

  it('ignores Home, search, more, saved-views, help, and auth pages', () => {
    for (const r of [
      '/',
      '/search',
      '/more',
      '/saved-views',
      '/help',
      '/onboarding',
      '/sign-in',
      '/settings',
      '/privacy'
    ]) {
      recordRouteVisit(r);
    }
    expect(listRecentRoutes()).toEqual([]);
  });

  it('ignores empty / non-pathname input', () => {
    recordRouteVisit('');
    recordRouteVisit('   ');
    recordRouteVisit('not-a-path');
    expect(listRecentRoutes()).toEqual([]);
  });

  it('clearRecentRoutes wipes the history', () => {
    recordRouteVisit('/concerns');
    clearRecentRoutes();
    expect(listRecentRoutes()).toEqual([]);
  });

  it('tolerates corrupt JSON in storage', () => {
    localStorage.setItem('jhsc-recent-routes', '{not json');
    expect(listRecentRoutes()).toEqual([]);
  });

  it('ignores non-array storage contents', () => {
    localStorage.setItem('jhsc-recent-routes', JSON.stringify({ foo: 1 }));
    expect(listRecentRoutes()).toEqual([]);
  });
});

describe('T19 — RecentRoutesCard', () => {
  it('renders nothing on a fresh device', () => {
    render(RecentRoutesCard);
    expect(screen.queryByTestId('home-recent-routes')).toBeNull();
  });

  it('renders one chip per recent route, newest first', () => {
    recordRouteVisit('/concerns');
    recordRouteVisit('/recommendations');
    render(RecentRoutesCard);
    const chips = screen.getAllByTestId('home-recent-route-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]!.getAttribute('href')).toBe('/recommendations');
    expect(chips[1]!.getAttribute('href')).toBe('/concerns');
  });

  it('renders a "just now" relative stamp on a fresh visit', () => {
    recordRouteVisit('/concerns');
    render(RecentRoutesCard);
    const when = screen.getByTestId('home-recent-route-when');
    expect(when.textContent ?? '').toMatch(/just now/i);
  });

  it('carries data-print="hide"', () => {
    recordRouteVisit('/concerns');
    render(RecentRoutesCard);
    expect(screen.getByTestId('home-recent-routes').getAttribute('data-print')).toBe('hide');
  });
});

describe('T19 — layout records every navigation', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/+layout.svelte'),
    'utf8'
  );

  it('imports recordRouteVisit from the service', () => {
    expect(src).toMatch(
      /import\s*\{\s*recordRouteVisit\s*\}\s+from\s+['"]\$lib\/nav\/recent-routes['"]/
    );
  });

  it('calls recordRouteVisit reactively with currentPath', () => {
    expect(src).toMatch(/recordRouteVisit\(currentPath\)/);
  });
});

describe('T19 — landing page mounts RecentRoutesCard', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/+page.svelte'),
    'utf8'
  );

  it('imports + mounts <RecentRoutesCard />', () => {
    expect(src).toMatch(
      /import\s+RecentRoutesCard\s+from\s+['"]\$lib\/home\/RecentRoutesCard\.svelte['"]/
    );
    expect(src).toMatch(/<RecentRoutesCard\s*\/>/);
  });
});

describe('T19 — i18n keys for recent routes', () => {
  const catalog = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
  );

  it('home.recentRoutes carries heading + relative-stamp strings', () => {
    expect(typeof catalog.home.recentRoutes.heading).toBe('string');
    expect(typeof catalog.home.recentRoutes.just_now).toBe('string');
    expect(catalog.home.recentRoutes.minutes_ago).toContain('{n}');
    expect(catalog.home.recentRoutes.hours_ago).toContain('{n}');
  });
});
