/**
 * T19 — HeaderSearch arrow-key navigation through the dropdown +
 * /search keyboard navigation (j/k + arrows + Enter) through results +
 * KeyboardShortcuts modal / /help docs of the new bindings.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import HeaderSearch from '../../src/lib/ui/HeaderSearch.svelte';
import { addSavedView, setSavedViewPinned } from '../../src/lib/saved-views/saved-views';
import { recordRecentSearch } from '../../src/lib/search/recent-searches';

beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('T19 — HeaderSearch arrow-key navigation', () => {
  async function setup() {
    const a = addSavedView({ name: 'Open H', route: '/concerns', search: '?filter=open' });
    setSavedViewPinned(a.id, true);
    recordRecentSearch('forklift');
    recordRecentSearch('eyewash');
    render(HeaderSearch);
    const input = screen.getByTestId('header-search-input');
    await fireEvent.focus(input);
    await waitFor(() => {
      expect(screen.getByTestId('header-search-recents')).toBeDefined();
    });
    return { input };
  }

  it('ArrowDown from no-selection moves to the first item (pinned view)', async () => {
    const { input } = await setup();
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('header-search-item-0');
    const pinnedRow = screen.getByTestId('header-search-pinned-row');
    expect(pinnedRow.getAttribute('data-active')).toBe('true');
  });

  it('ArrowDown walks pinned views then recent searches in order', async () => {
    const { input } = await setup();
    await fireEvent.keyDown(input, { key: 'ArrowDown' }); // pinned 0
    await fireEvent.keyDown(input, { key: 'ArrowDown' }); // recent[0] -> "eyewash" (newest)
    expect(input.getAttribute('aria-activedescendant')).toBe('header-search-item-1');
    const recentRows = screen.getAllByTestId('header-search-recent-row');
    expect(recentRows[0]!.getAttribute('data-active')).toBe('true');
  });

  it('ArrowDown past the last item wraps to the first', async () => {
    const { input } = await setup();
    // 1 pinned + 2 recents = 3 items
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'ArrowDown' }); // wraps
    expect(input.getAttribute('aria-activedescendant')).toBe('header-search-item-0');
  });

  it('ArrowUp from no-selection wraps to the last item', async () => {
    const { input } = await setup();
    await fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toBe('header-search-item-2');
  });

  it('typing into the input resets the active selection', async () => {
    const { input } = await setup();
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('header-search-item-0');
    await fireEvent.input(input, { target: { value: 'hot' } });
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('aria-expanded reflects the open / closed state', async () => {
    const { input } = await setup();
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('aria-expanded reads "false" when the dropdown is closed', () => {
    render(HeaderSearch);
    const input = screen.getByTestId('header-search-input');
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('ArrowDown while closed opens the panel + lands on the first item', async () => {
    const a = addSavedView({ name: 'Pinned', route: '/c', search: '' });
    setSavedViewPinned(a.id, true);
    render(HeaderSearch);
    const input = screen.getByTestId('header-search-input');
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(screen.getByTestId('header-search-recents')).toBeDefined();
    });
    expect(input.getAttribute('aria-activedescendant')).toBe('header-search-item-0');
  });
});

describe('T19 — /search keyboard navigation through results', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/search/+page.svelte'),
    'utf8'
  );

  it('computes a flatResults array reactive over the grouped results', () => {
    expect(src).toMatch(/\$:\s*flatResults\s*=\s*groups\.flatMap/);
  });

  it('declares an activeResultIndex that resets when the query changes', () => {
    expect(src).toMatch(/let\s+activeResultIndex/);
    expect(src).toMatch(/\$:\s*if\s*\(query\)\s*activeResultIndex\s*=\s*-1/);
  });

  it('the keydown handler maps j / ArrowDown to next + k / ArrowUp to prev', () => {
    expect(src).toMatch(/ev\.key\s*===\s*['"]j['"][\s\S]*ev\.key\s*===\s*['"]ArrowDown['"]/);
    expect(src).toMatch(/ev\.key\s*===\s*['"]k['"][\s\S]*ev\.key\s*===\s*['"]ArrowUp['"]/);
    expect(src).toMatch(/ev\.key\s*===\s*['"]Enter['"]/);
  });

  it('ignores modifier-key combos and typing-target focus', () => {
    expect(src).toMatch(/metaKey[^}]*ctrlKey[^}]*altKey/);
    expect(src).toMatch(/tag\s*===\s*['"]input['"]/);
  });

  it('mounts + unmounts the document keydown listener via onMount / onDestroy', () => {
    expect(src).toMatch(/addEventListener\(['"]keydown['"],\s*onSearchKeydown\)/);
    expect(src).toMatch(/removeEventListener\(['"]keydown['"],\s*onSearchKeydown\)/);
  });

  it('each result row stamps an is-active class + data-active attr based on activeResultIndex', () => {
    expect(src).toMatch(/class:is-active=\{activeResultIndex\s*===\s*flatIdx\}/);
    expect(src).toMatch(/data-active=\{activeResultIndex\s*===\s*flatIdx/);
  });
});

describe('T19 — KeyboardShortcuts modal + /help expose the new bindings', () => {
  it('the modal ROWS array carries arrows + enter', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/lib/ui/KeyboardShortcuts.svelte'),
      'utf8'
    );
    expect(src).toMatch(/key:\s*['"]arrows['"]/);
    expect(src).toMatch(/key:\s*['"]enter['"]/);
  });

  it('the /help page carries arrows + enter', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/routes/help/+page.svelte'),
      'utf8'
    );
    expect(src).toMatch(/key:\s*['"]arrows['"]/);
    expect(src).toMatch(/key:\s*['"]enter['"]/);
  });

  it('catalog carries the new rows + key labels', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(typeof catalog.common.keyboardShortcuts.rows.navigate_list).toBe('string');
    expect(typeof catalog.common.keyboardShortcuts.rows.activate_item).toBe('string');
    expect(catalog.common.keyboardShortcuts.key.arrows).toBe('↑↓');
    expect(catalog.common.keyboardShortcuts.key.enter).toBe('Enter');
  });
});
