/**
 * T19 — /search + HeaderSearch active-row scrollIntoView,
 * /saved-views search-by-name filter input.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import HeaderSearch from '../../src/lib/ui/HeaderSearch.svelte';
import { addSavedView, setSavedViewPinned } from '../../src/lib/saved-views/saved-views';

beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('T19 — HeaderSearch active row scrollIntoView', () => {
  it('mounts the rows under stable ids (header-search-item-N)', async () => {
    const a = addSavedView({ name: 'Pinned A', route: '/c', search: '' });
    setSavedViewPinned(a.id, true);
    render(HeaderSearch);
    await fireEvent.focus(screen.getByTestId('header-search-input'));
    await waitFor(() => {
      expect(screen.getByTestId('header-search-recents')).toBeDefined();
    });
    const link = screen.getByTestId('header-search-pinned-link');
    expect(link.id).toBe('header-search-item-0');
  });

  it('the source declares the reactive that scrolls the active id into view', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/lib/ui/HeaderSearch.svelte'),
      'utf8'
    );
    expect(src).toMatch(
      /\$:\s*if\s*\(typeof document\s*!==\s*['"]undefined['"]\s*&&\s*recentsOpen\s*&&\s*activeIndex\s*>=\s*0\)/
    );
    expect(src).toMatch(/getElementById\(`header-search-item-\$\{activeIndex\}`\)/);
    expect(src).toMatch(/typeof\s+el\.scrollIntoView\s*===\s*['"]function['"]/);
    expect(src).toMatch(/scrollIntoView\(\{\s*block:\s*['"]nearest['"]/);
  });
});

describe('T19 — /search active result scrollIntoView', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/search/+page.svelte'),
    'utf8'
  );

  it('stamps an id of the form search-result-N on each result <li>', () => {
    expect(src).toMatch(/id=\{\s*`search-result-\$\{flatIdx\}`\s*\}/);
  });

  it('declares the reactive that scrolls the active result into view', () => {
    expect(src).toMatch(
      /\$:\s*if\s*\(typeof document\s*!==\s*['"]undefined['"]\s*&&\s*activeResultIndex\s*>=\s*0\)/
    );
    expect(src).toMatch(/getElementById\(`search-result-\$\{activeResultIndex\}`\)/);
    expect(src).toMatch(/typeof\s+el\.scrollIntoView\s*===\s*['"]function['"]/);
    expect(src).toMatch(/scrollIntoView\(\{\s*block:\s*['"]nearest['"][^}]*behavior:\s*['"]smooth['"]/);
  });
});

describe('T19 — /saved-views name + route filter input', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/saved-views/+page.svelte'),
    'utf8'
  );

  it('declares a nameFilter binding + normalized filteredViews reactive', () => {
    expect(src).toMatch(/let\s+nameFilter\s*=\s*['"]['"]/);
    expect(src).toMatch(/\$:\s*nameFilterNorm\s*=\s*nameFilter\.trim\(\)\.toLowerCase\(\)/);
    expect(src).toMatch(/\$:\s*filteredViews\s*=/);
  });

  it('filter matches the view name OR the route (case-insensitive)', () => {
    expect(src).toMatch(/v\.name\.toLowerCase\(\)\.includes\(nameFilterNorm\)/);
    expect(src).toMatch(/v\.route\.toLowerCase\(\)\.includes\(nameFilterNorm\)/);
  });

  it('renders the filter input above the list when views exist', () => {
    expect(src).toMatch(/data-testid=["']saved-views-filter-input["']/);
    expect(src).toMatch(/bind:value=\{nameFilter\}/);
  });

  it('renders a filter-empty branch when nothing matches the typed query', () => {
    expect(src).toMatch(/data-testid=["']saved-views-filter-empty["']/);
  });

  it('iterates filteredViews (not views) in the list loop', () => {
    expect(src).toMatch(/\{#each\s+filteredViews\s+as\s+v\s+\(v\.id\)\}/);
  });
});

describe('T19 — i18n keys for the /saved-views filter input', () => {
  const catalog = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
  );

  it('savedViewsPage carries filter_label + filter_placeholder + filter_aria', () => {
    expect(typeof catalog.common.savedViewsPage.filter_label).toBe('string');
    expect(typeof catalog.common.savedViewsPage.filter_placeholder).toBe('string');
    expect(typeof catalog.common.savedViewsPage.filter_aria).toBe('string');
  });

  it('savedViewsPage.filter_empty interpolates {query}', () => {
    expect(catalog.common.savedViewsPage.filter_empty).toContain('{query}');
  });
});
