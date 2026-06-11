/**
 * T19 — Recent-searches service + HeaderSearch dropdown, SaveViewButton
 * pin-on-save checkbox, /help page docs the new affordances.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import HeaderSearch from '../../src/lib/ui/HeaderSearch.svelte';
import SaveViewButton from '../../src/lib/ui/SaveViewButton.svelte';
import {
  clearRecentSearches,
  deleteRecentSearch,
  listRecentSearches,
  MAX_ENTRIES,
  recordRecentSearch
} from '../../src/lib/search/recent-searches';
import { listSavedViews } from '../../src/lib/saved-views/saved-views';

beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('T19 — recent-searches service', () => {
  it('listRecentSearches returns [] on a fresh device', () => {
    expect(listRecentSearches()).toEqual([]);
  });

  it('recordRecentSearch persists trimmed queries newest-first', () => {
    recordRecentSearch('forklift');
    recordRecentSearch(' eyewash ');
    expect(listRecentSearches()).toEqual(['eyewash', 'forklift']);
  });

  it('dedupes (moves an existing query to the front instead of duplicating)', () => {
    recordRecentSearch('forklift');
    recordRecentSearch('eyewash');
    recordRecentSearch('forklift');
    expect(listRecentSearches()).toEqual(['forklift', 'eyewash']);
  });

  it('caps the history at MAX_ENTRIES', () => {
    for (const q of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) recordRecentSearch(q);
    expect(listRecentSearches()).toHaveLength(MAX_ENTRIES);
    // Newest is on top.
    expect(listRecentSearches()[0]).toBe('g');
  });

  it('ignores empty / whitespace-only queries', () => {
    recordRecentSearch('');
    recordRecentSearch('   ');
    expect(listRecentSearches()).toEqual([]);
  });

  it('caps individual queries at 80 chars', () => {
    recordRecentSearch('x'.repeat(120));
    expect(listRecentSearches()[0]!.length).toBe(80);
  });

  it('deleteRecentSearch removes the entry + returns true when matched', () => {
    recordRecentSearch('forklift');
    recordRecentSearch('eyewash');
    expect(deleteRecentSearch('forklift')).toBe(true);
    expect(listRecentSearches()).toEqual(['eyewash']);
  });

  it('deleteRecentSearch returns false when no match', () => {
    expect(deleteRecentSearch('does-not-exist')).toBe(false);
  });

  it('clearRecentSearches wipes the history', () => {
    recordRecentSearch('a');
    clearRecentSearches();
    expect(listRecentSearches()).toEqual([]);
  });

  it('tolerates corrupt storage and non-array contents', () => {
    localStorage.setItem('jhsc-recent-searches', '{not json');
    expect(listRecentSearches()).toEqual([]);
    localStorage.setItem('jhsc-recent-searches', JSON.stringify({ foo: 1 }));
    expect(listRecentSearches()).toEqual([]);
  });
});

describe('T19 — HeaderSearch recent-searches dropdown', () => {
  it('does not surface the dropdown when there is no history', () => {
    render(HeaderSearch);
    expect(screen.queryByTestId('header-search-recents')).toBeNull();
  });

  it('opens the dropdown on input focus when history exists', async () => {
    recordRecentSearch('forklift');
    recordRecentSearch('eyewash');
    render(HeaderSearch);
    const input = screen.getByTestId('header-search-input');
    await fireEvent.focus(input);
    await waitFor(() => {
      expect(screen.getByTestId('header-search-recents')).toBeDefined();
    });
    expect(screen.getAllByTestId('header-search-recent-row')).toHaveLength(2);
  });

  it('each entry links to /search?q=<encoded>', async () => {
    recordRecentSearch('hot work');
    render(HeaderSearch);
    await fireEvent.focus(screen.getByTestId('header-search-input'));
    await waitFor(() => {
      expect(screen.getByTestId('header-search-recents')).toBeDefined();
    });
    const link = screen.getByTestId('header-search-recent-link');
    expect(link.getAttribute('href')).toBe('/search?q=hot%20work');
  });

  it("clicking the × removes that one entry from the list", async () => {
    recordRecentSearch('a');
    recordRecentSearch('b');
    render(HeaderSearch);
    await fireEvent.focus(screen.getByTestId('header-search-input'));
    await waitFor(() => {
      expect(screen.getAllByTestId('header-search-recent-row')).toHaveLength(2);
    });
    const removes = screen.getAllByTestId('header-search-recent-remove');
    await fireEvent.click(removes[0]!);
    expect(listRecentSearches()).toHaveLength(1);
  });

  it("submitting the form records the typed query (no-JS fallback survives)", async () => {
    render(HeaderSearch);
    const input = screen.getByTestId('header-search-input') as HTMLInputElement;
    input.value = 'h2s monitor';
    const form = screen.getByTestId('header-search');
    // Use a real submit dispatch to fire the on:submit handler.
    await fireEvent.submit(form);
    expect(listRecentSearches()).toEqual(['h2s monitor']);
  });
});

describe('T19 — SaveViewButton pin-on-save checkbox', () => {
  it('the checkbox is unchecked by default when the input opens', async () => {
    render(SaveViewButton);
    await fireEvent.click(screen.getByTestId('save-view-trigger'));
    const cb = screen.getByTestId('save-view-pin-checkbox') as HTMLInputElement;
    expect(cb.checked).toBe(false);
  });

  it('saving with the box ticked marks the new view pinnedToHome=true', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: new URL('http://localhost/concerns?filter=open')
    });
    render(SaveViewButton);
    await fireEvent.click(screen.getByTestId('save-view-trigger'));
    const input = screen.getByTestId('save-view-name-input');
    await fireEvent.input(input, { target: { value: 'Open H' } });
    const cb = screen.getByTestId('save-view-pin-checkbox');
    await fireEvent.click(cb);
    await fireEvent.click(screen.getByTestId('save-view-confirm'));
    const all = listSavedViews();
    expect(all.length).toBe(1);
    expect(all[0]!.pinnedToHome).toBe(true);
  });

  it('saving with the box unticked leaves pinnedToHome falsy', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: new URL('http://localhost/concerns')
    });
    render(SaveViewButton);
    await fireEvent.click(screen.getByTestId('save-view-trigger'));
    const input = screen.getByTestId('save-view-name-input');
    await fireEvent.input(input, { target: { value: 'No pin' } });
    await fireEvent.click(screen.getByTestId('save-view-confirm'));
    const all = listSavedViews();
    expect(all[0]!.pinnedToHome).toBeFalsy();
  });
});

describe('T19 — /help page documents the new affordances', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/help/+page.svelte'),
    'utf8'
  );

  it('renders a Saved & pinned views section', () => {
    expect(src).toContain('common.helpPage.saved_views_heading');
    expect(src).toContain('common.helpPage.saved_views_body');
  });

  it('renders a Recent searches section', () => {
    expect(src).toContain('common.helpPage.recent_searches_heading');
    expect(src).toContain('common.helpPage.recent_searches_body');
  });
});

describe('T19 — i18n keys for the new affordances', () => {
  const catalog = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
  );

  it('headerSearch carries the recent-search strings', () => {
    expect(typeof catalog.common.headerSearch.recent_label).toBe('string');
    expect(typeof catalog.common.headerSearch.recent_aria).toBe('string');
    expect(catalog.common.headerSearch.recent_remove_aria).toContain('{query}');
  });

  it('savedViews carries the pin_on_save label', () => {
    expect(typeof catalog.common.savedViews.pin_on_save).toBe('string');
  });

  it('helpPage carries the two new sections', () => {
    expect(typeof catalog.common.helpPage.saved_views_heading).toBe('string');
    expect(typeof catalog.common.helpPage.saved_views_body).toBe('string');
    expect(typeof catalog.common.helpPage.recent_searches_heading).toBe('string');
    expect(typeof catalog.common.helpPage.recent_searches_body).toBe('string');
  });
});
