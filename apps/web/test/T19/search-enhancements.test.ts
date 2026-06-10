/**
 * T19.1 — Search bundle A: highlightMatches + HeaderSearch +
 * "/" keyboard shortcut + /search uses the highlight helper.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { highlightMatches } from '../../src/lib/search/highlight';
import HeaderSearch from '../../src/lib/ui/HeaderSearch.svelte';

afterEach(() => {
  cleanup();
});

describe('T19.1 — highlightMatches', () => {
  it('returns empty list for empty text', () => {
    expect(highlightMatches('', 'foo')).toEqual([]);
  });

  it('returns the whole text as a non-match for an empty query', () => {
    expect(highlightMatches('hello', '')).toEqual([{ text: 'hello', match: false }]);
    expect(highlightMatches('hello', '   ')).toEqual([{ text: 'hello', match: false }]);
  });

  it('returns a single match-segment when the text equals the query', () => {
    expect(highlightMatches('forklift', 'forklift')).toEqual([
      { text: 'forklift', match: true }
    ]);
  });

  it('splits around a single match in the middle of the text', () => {
    expect(highlightMatches('replace the forklift soon', 'forklift')).toEqual([
      { text: 'replace the ', match: false },
      { text: 'forklift', match: true },
      { text: ' soon', match: false }
    ]);
  });

  it('captures multiple non-overlapping occurrences', () => {
    expect(highlightMatches('forklift then another forklift', 'forklift')).toEqual([
      { text: 'forklift', match: true },
      { text: ' then another ', match: false },
      { text: 'forklift', match: true }
    ]);
  });

  it('is case-insensitive but preserves the original casing in the output', () => {
    expect(highlightMatches('Forklift Issue', 'forklift')).toEqual([
      { text: 'Forklift', match: true },
      { text: ' Issue', match: false }
    ]);
  });

  it('returns the whole text as non-match when the query never appears', () => {
    expect(highlightMatches('clean walk', 'forklift')).toEqual([
      { text: 'clean walk', match: false }
    ]);
  });
});

describe('T19.1 — HeaderSearch component', () => {
  it('renders a search form pointing to /search with name="q"', () => {
    render(HeaderSearch, { props: {} });
    const form = screen.getByTestId('header-search');
    expect(form.getAttribute('action')).toBe('/search');
    expect(form.getAttribute('method')?.toLowerCase()).toBe('get');
    expect(form.getAttribute('role')).toBe('search');
    expect(form.getAttribute('data-print')).toBe('hide');

    const input = screen.getByTestId('header-search-input') as HTMLInputElement;
    expect(input.name).toBe('q');
    expect(input.type).toBe('search');
    expect(input.getAttribute('autocomplete')).toBe('off');
  });

  it('focuses the input when the global "/" key fires outside of an input', async () => {
    render(HeaderSearch, { props: {} });
    const input = screen.getByTestId('header-search-input');
    expect(document.activeElement).not.toBe(input);

    fireEvent.keyDown(document, { key: '/' });
    expect(document.activeElement).toBe(input);
  });

  it('does NOT hijack "/" when the active target is already an input', async () => {
    // Create a sibling input + render HeaderSearch.
    const stray = document.createElement('input');
    document.body.appendChild(stray);
    stray.focus();
    expect(document.activeElement).toBe(stray);

    render(HeaderSearch, { props: {} });
    const headerInput = screen.getByTestId('header-search-input');
    fireEvent.keyDown(stray, { key: '/' });
    // Stray input still focused, not the header search.
    expect(document.activeElement).toBe(stray);
    expect(document.activeElement).not.toBe(headerInput);

    stray.remove();
  });

  it('blurs the input when Escape is pressed while it is focused', async () => {
    render(HeaderSearch, { props: {} });
    const input = screen.getByTestId('header-search-input') as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).not.toBe(input);
  });
});

describe('T19.1 — layout mounts HeaderSearch in the signed-in branch', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/+layout.svelte'),
    'utf8'
  );

  it('imports HeaderSearch', () => {
    expect(src).toMatch(
      /import\s+HeaderSearch\s+from\s+['"]\$lib\/ui\/HeaderSearch\.svelte['"]/
    );
  });

  it('mounts HeaderSearch inside the {#if $isSignedIn} branch of the topbar actions', () => {
    // Pin that <HeaderSearch /> sits inside the topbar-actions block
    // AND inside the $isSignedIn conditional.
    expect(src).toMatch(/topbar-actions[\s\S]*?\{#if\s+\$isSignedIn\}[\s\S]*?<HeaderSearch/);
  });
});

describe('T19.1 — /search page renders the highlight helper', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/search/+page.svelte'),
    'utf8'
  );

  it('imports highlightMatches', () => {
    expect(src).toMatch(
      /import\s+\{[\s\S]*highlightMatches[\s\S]*\}\s+from\s+['"]\$lib\/search\/highlight['"]/
    );
  });

  it('uses the helper on primaryText AND secondaryText', () => {
    expect(src).toMatch(/highlightMatches\(record\.primaryText/);
    expect(src).toMatch(/highlightMatches\(record\.secondaryText/);
  });

  it('renders matched segments inside <mark> elements', () => {
    expect(src).toMatch(/<mark\s+class="search-mark"/);
  });
});

describe('T19.1 — common.headerSearch i18n keys', () => {
  it('catalog has the label + placeholder', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(typeof catalog.common.headerSearch.label).toBe('string');
    expect(typeof catalog.common.headerSearch.placeholder).toBe('string');
  });
});
