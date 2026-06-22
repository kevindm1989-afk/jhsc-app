/**
 * T19 — CSV metadata comment row + saved-views pin-to-home flag +
 * HomeDashboard PinnedViewsCard.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import PinnedViewsCard from '../../src/lib/home/PinnedViewsCard.svelte';
import {
  addSavedView,
  listPinnedSavedViews,
  setSavedViewPinned
} from '../../src/lib/saved-views/saved-views';
import { csvMetadataLine, toCsv, withMetadata } from '../../src/lib/ui/csv';

beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('T19 — csvMetadataLine', () => {
  const FIXED_DATE = new Date(Date.UTC(2026, 5, 11, 9, 42, 0));

  it('returns "" when route is empty (caller can concat unconditionally)', () => {
    expect(csvMetadataLine({ route: '', generatedAt: FIXED_DATE })).toBe('');
  });

  it('emits a # route= + generated= summary line', () => {
    const line = csvMetadataLine({ route: '/concerns', generatedAt: FIXED_DATE });
    expect(line).toContain('# route=/concerns');
    expect(line).toContain('generated=2026-06-11T09:42:00.000Z');
  });

  it('appends filters= when a non-empty filter description is supplied', () => {
    const line = csvMetadataLine({
      route: '/concerns',
      filters: 'Status: Open · Severity: High',
      generatedAt: FIXED_DATE
    });
    expect(line).toContain('filters=Status: Open · Severity: High');
  });

  it('drops the filters= clause when the description is blank', () => {
    const line = csvMetadataLine({
      route: '/concerns',
      filters: '   ',
      generatedAt: FIXED_DATE
    });
    expect(line).not.toContain('filters=');
  });

  it('the line is quoted so commas in the filter description survive', () => {
    const line = csvMetadataLine({
      route: '/concerns',
      filters: 'A, B, C',
      generatedAt: FIXED_DATE
    });
    // Quoted (starts/ends with ") since the body contains a comma.
    expect(line.startsWith('"')).toBe(true);
    expect(line.endsWith('"')).toBe(true);
  });
});

describe('T19 — withMetadata', () => {
  const FIXED_DATE = new Date(Date.UTC(2026, 5, 11, 9, 42, 0));

  it('prepends the metadata line + CRLF + the original csv', () => {
    const csv = toCsv([{ a: '1', b: '2' }], ['a', 'b']);
    const out = withMetadata({ route: '/audit', generatedAt: FIXED_DATE }, csv);
    // The metadata line starts with "# route=/audit" (the leading
    // quote only appears when the line itself contains a comma).
    expect(out).toMatch(/^["]?# route=\/audit/);
    expect(out).toContain('\r\na,b\r\n');
  });

  it('returns the csv verbatim when no route is supplied', () => {
    const csv = toCsv([{ a: '1' }], ['a']);
    expect(withMetadata({ route: '' }, csv)).toBe(csv);
  });
});

describe('T19 — register routes wire withMetadata into their CSV pipeline', () => {
  const ROUTES = [
    'training',
    'work-refusal',
    's51-evidence',
    'reprisal',
    'minutes',
    'inspections',
    'library',
    'recommendations',
    // 'concerns' RETIRED — ADR-0027 Phase 2a PR2: live /concerns has no CSV export.
    'audit',
    'sensitive-feed'
  ] as const;

  for (const route of ROUTES) {
    it(`/${route} wraps its toCsv body with withMetadata + activeFilters labels`, () => {
      const src = readFileSync(
        resolve(__dirname, `../../src/routes/${route}/+page.svelte`),
        'utf8'
      );
      expect(src).toMatch(
        /import\s*\{[^}]*\bwithMetadata\b[^}]*\}\s+from\s+['"]\$lib\/ui\/csv['"]/
      );
      expect(src).toMatch(/csv:\s*withMetadata\(/);
      expect(src).toMatch(/route:\s*['"]\/[a-z0-9-]+['"]/);
    });
  }
});

describe('T19 — saved-views pin-to-home flag', () => {
  it('setSavedViewPinned flips the flag and persists it', () => {
    const v = addSavedView({ name: 'X', route: '/c', search: '' });
    expect(v.pinnedToHome).toBeUndefined();
    const pinned = setSavedViewPinned(v.id, true);
    expect(pinned?.pinnedToHome).toBe(true);
    const unpinned = setSavedViewPinned(v.id, false);
    expect(unpinned?.pinnedToHome).toBe(false);
  });

  it('setSavedViewPinned returns null when the id is unknown', () => {
    expect(setSavedViewPinned('nope', true)).toBeNull();
  });

  it('listPinnedSavedViews returns only views with pinnedToHome === true', () => {
    const a = addSavedView({ name: 'A', route: '/c', search: '' });
    addSavedView({ name: 'B', route: '/c', search: '' });
    setSavedViewPinned(a.id, true);
    const pinned = listPinnedSavedViews();
    expect(pinned.length).toBe(1);
    expect(pinned[0]!.id).toBe(a.id);
  });
});

describe('T19 — PinnedViewsCard', () => {
  it('renders nothing when no views are pinned', () => {
    addSavedView({ name: 'A', route: '/c', search: '' });
    render(PinnedViewsCard);
    expect(screen.queryByTestId('home-pinned-views')).toBeNull();
  });

  it('renders one chip per pinned view + a manage link', () => {
    const a = addSavedView({ name: 'Open H', route: '/concerns', search: '?filter=open' });
    setSavedViewPinned(a.id, true);
    render(PinnedViewsCard);
    expect(screen.getAllByTestId('home-pinned-view-chip')).toHaveLength(1);
    expect(screen.getByTestId('home-pinned-views-manage').getAttribute('href')).toBe(
      '/saved-views'
    );
  });

  it("each chip href is route + search", () => {
    const a = addSavedView({
      name: 'Open H',
      route: '/concerns',
      search: '?filter=open&severity=high'
    });
    setSavedViewPinned(a.id, true);
    render(PinnedViewsCard);
    const chip = screen.getByTestId('home-pinned-view-chip');
    expect(chip.getAttribute('href')).toBe('/concerns?filter=open&severity=high');
  });

  it('refreshes on the window "view:saved" event so pinning shows up live', async () => {
    render(PinnedViewsCard);
    expect(screen.queryByTestId('home-pinned-views')).toBeNull();
    const a = addSavedView({ name: 'X', route: '/c', search: '' });
    setSavedViewPinned(a.id, true);
    window.dispatchEvent(new CustomEvent('view:saved'));
    await waitFor(() => {
      expect(screen.getByTestId('home-pinned-views')).toBeDefined();
    });
  });

  it('carries data-print="hide"', () => {
    const a = addSavedView({ name: 'X', route: '/c', search: '' });
    setSavedViewPinned(a.id, true);
    render(PinnedViewsCard);
    expect(screen.getByTestId('home-pinned-views').getAttribute('data-print')).toBe('hide');
  });
});

describe('T19 — /saved-views page wires the pin toggle', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/saved-views/+page.svelte'),
    'utf8'
  );

  it('imports setSavedViewPinned from the service', () => {
    expect(src).toMatch(/setSavedViewPinned/);
  });

  it('renders a pin button per row that flips the flag', () => {
    expect(src).toMatch(/data-testid=["']saved-views-pin["']/);
    expect(src).toMatch(/setSavedViewPinned\(view\.id,\s*!view\.pinnedToHome\)/);
  });

  it('dispatches a view:saved event so home cards refresh live', () => {
    expect(src).toMatch(/window\.dispatchEvent\(new CustomEvent\(['"]view:saved['"]/);
  });
});

describe('T19 — landing page mounts PinnedViewsCard', () => {
  it('imports + mounts <PinnedViewsCard />', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/routes/+page.svelte'),
      'utf8'
    );
    expect(src).toMatch(
      /import\s+PinnedViewsCard\s+from\s+['"]\$lib\/home\/PinnedViewsCard\.svelte['"]/
    );
    expect(src).toMatch(/<PinnedViewsCard\s*\/>/);
  });
});

describe('T19 — i18n keys for the new affordances', () => {
  const catalog = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
  );

  it('savedViewsPage gains pin + unpin strings', () => {
    expect(typeof catalog.common.savedViewsPage.pin).toBe('string');
    expect(typeof catalog.common.savedViewsPage.unpin).toBe('string');
  });

  it('home.pinnedViews carries the heading + manage_link', () => {
    expect(typeof catalog.home.pinnedViews.heading).toBe('string');
    expect(typeof catalog.home.pinnedViews.manage_link).toBe('string');
  });
});
