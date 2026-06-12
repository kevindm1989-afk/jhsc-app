/**
 * T19 — HeaderSearch surfaces recent routes in a new dropdown
 * section; RecentRoutesCard exposes a Clear-history button; /help
 * docs the recent-visits behaviour.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import HeaderSearch from '../../src/lib/ui/HeaderSearch.svelte';
import RecentRoutesCard from '../../src/lib/home/RecentRoutesCard.svelte';
import { addSavedView, setSavedViewPinned } from '../../src/lib/saved-views/saved-views';
import { recordRecentSearch } from '../../src/lib/search/recent-searches';
import { listRecentRoutes, recordRouteVisit } from '../../src/lib/nav/recent-routes';

beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('T19 — HeaderSearch recently-visited routes section', () => {
  it('opens the dropdown on focus when only recent routes exist', async () => {
    recordRouteVisit('/concerns');
    render(HeaderSearch);
    await fireEvent.focus(screen.getByTestId('header-search-input'));
    await waitFor(() => {
      expect(screen.getByTestId('header-search-recents')).toBeDefined();
    });
    expect(screen.getByTestId('header-search-routes')).toBeDefined();
    const link = screen.getByTestId('header-search-route-link');
    expect(link.getAttribute('href')).toBe('/concerns');
  });

  it('renders the route rows newest-first', async () => {
    recordRouteVisit('/concerns');
    recordRouteVisit('/recommendations');
    render(HeaderSearch);
    await fireEvent.focus(screen.getByTestId('header-search-input'));
    await waitFor(() => {
      expect(screen.getByTestId('header-search-routes')).toBeDefined();
    });
    const rows = screen.getAllByTestId('header-search-route-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent ?? '').toContain('/recommendations');
    expect(rows[1]!.textContent ?? '').toContain('/concerns');
  });

  it('all three sections (pinned / routes / recents) render together', async () => {
    const a = addSavedView({ name: 'Pinned', route: '/concerns', search: '?filter=open' });
    setSavedViewPinned(a.id, true);
    recordRouteVisit('/inspections');
    recordRecentSearch('forklift');
    render(HeaderSearch);
    await fireEvent.focus(screen.getByTestId('header-search-input'));
    await waitFor(() => {
      expect(screen.getByTestId('header-search-recents')).toBeDefined();
    });
    expect(screen.getByTestId('header-search-pinned')).toBeDefined();
    expect(screen.getByTestId('header-search-routes')).toBeDefined();
    expect(screen.getAllByTestId('header-search-recent-row')).toHaveLength(1);
  });

  it('arrow-key navigation walks pinned → routes → recents (combined index)', async () => {
    const a = addSavedView({ name: 'Pinned', route: '/c', search: '' });
    setSavedViewPinned(a.id, true);
    recordRouteVisit('/inspections');
    recordRecentSearch('forklift');
    render(HeaderSearch);
    const input = screen.getByTestId('header-search-input');
    await fireEvent.focus(input);
    await waitFor(() => {
      expect(screen.getByTestId('header-search-recents')).toBeDefined();
    });
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('header-search-item-0');
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('header-search-item-1');
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('header-search-item-2');
  });

  it('clicking a route link closes the panel', async () => {
    recordRouteVisit('/concerns');
    render(HeaderSearch);
    await fireEvent.focus(screen.getByTestId('header-search-input'));
    await waitFor(() => {
      expect(screen.getByTestId('header-search-routes')).toBeDefined();
    });
    await fireEvent.click(screen.getByTestId('header-search-route-link'));
    await waitFor(() => {
      expect(screen.queryByTestId('header-search-recents')).toBeNull();
    });
  });
});

describe('T19 — RecentRoutesCard Clear-history button', () => {
  it('renders a clear button alongside the heading when entries exist', () => {
    recordRouteVisit('/concerns');
    render(RecentRoutesCard);
    expect(screen.getByTestId('home-recent-routes-clear')).toBeDefined();
  });

  it('clicking the clear button wipes the history + hides the card', async () => {
    recordRouteVisit('/concerns');
    recordRouteVisit('/training');
    render(RecentRoutesCard);
    await fireEvent.click(screen.getByTestId('home-recent-routes-clear'));
    expect(listRecentRoutes()).toEqual([]);
    expect(screen.queryByTestId('home-recent-routes')).toBeNull();
  });
});

describe('T19 — /help page documents recently visited', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/help/+page.svelte'),
    'utf8'
  );

  it('renders the recent-visits section keys', () => {
    expect(src).toContain('common.helpPage.recent_visits_heading');
    expect(src).toContain('common.helpPage.recent_visits_body');
  });
});

describe('T19 — i18n keys', () => {
  const catalog = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
  );

  it('headerSearch carries the routes_label', () => {
    expect(typeof catalog.common.headerSearch.routes_label).toBe('string');
  });

  it('home.recentRoutes carries the clear label', () => {
    expect(typeof catalog.home.recentRoutes.clear).toBe('string');
  });

  it('helpPage carries the recent-visits section strings', () => {
    expect(typeof catalog.common.helpPage.recent_visits_heading).toBe('string');
    expect(typeof catalog.common.helpPage.recent_visits_body).toBe('string');
  });
});
