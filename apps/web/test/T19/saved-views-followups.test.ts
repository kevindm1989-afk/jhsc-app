/**
 * T19 — saved-views follow-ups: HomeDashboard SavedViewsCard,
 * SaveViewButton suggestedName prefill, and exportSavedViews +
 * importSavedViews service helpers + /saved-views page IO controls.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import SavedViewsCard from '../../src/lib/home/SavedViewsCard.svelte';
import SaveViewButton from '../../src/lib/ui/SaveViewButton.svelte';
import {
  addSavedView,
  exportSavedViews,
  importSavedViews,
  listSavedViews
} from '../../src/lib/saved-views/saved-views';

beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('T19 — exportSavedViews + importSavedViews', () => {
  it('exportSavedViews emits a discriminated envelope with version + ISO timestamp', () => {
    addSavedView({ name: 'A', route: '/concerns', search: '?filter=open' });
    const env = exportSavedViews();
    expect(env.kind).toBe('jhsc-saved-views');
    expect(env.version).toBe(1);
    expect(env.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(env.views).toHaveLength(1);
  });

  it('importSavedViews round-trips a fresh export', () => {
    const a = addSavedView({ name: 'A', route: '/c', search: '' });
    const b = addSavedView({ name: 'B', route: '/c', search: '?filter=open' });
    const env = exportSavedViews();
    localStorage.clear();
    const result = importSavedViews(env);
    expect(result.added.map((v) => v.id).sort()).toEqual([a.id, b.id].sort());
    expect(result.skipped).toBe(0);
    expect(listSavedViews()).toHaveLength(2);
  });

  it('importSavedViews skips views whose id already exists locally', () => {
    addSavedView({ name: 'A', route: '/c', search: '' });
    const env = exportSavedViews();
    // Re-import on top of itself.
    const result = importSavedViews(env);
    expect(result.added).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(listSavedViews()).toHaveLength(1);
  });

  it('importSavedViews throws on non-object input', () => {
    expect(() => importSavedViews(null)).toThrow();
    expect(() => importSavedViews(42)).toThrow();
    expect(() => importSavedViews('hi')).toThrow();
  });

  it('importSavedViews throws when kind is wrong', () => {
    expect(() => importSavedViews({ kind: 'something-else', version: 1, views: [] })).toThrow();
  });

  it('importSavedViews throws on a future/unknown version', () => {
    expect(() => importSavedViews({ kind: 'jhsc-saved-views', version: 99, views: [] })).toThrow();
  });

  it('importSavedViews throws when views is not an array', () => {
    expect(() =>
      importSavedViews({ kind: 'jhsc-saved-views', version: 1, views: 'nope' })
    ).toThrow();
  });

  it('importSavedViews silently drops non-conforming entries inside views[]', () => {
    const env = {
      kind: 'jhsc-saved-views',
      version: 1,
      exportedAt: '2026-06-11T00:00:00.000Z',
      views: [
        { not: 'a saved view' },
        {
          id: 'good',
          name: 'real one',
          route: '/concerns',
          search: '',
          createdAt: '2026-06-10T00:00:00.000Z'
        }
      ]
    };
    const result = importSavedViews(env);
    expect(result.added).toHaveLength(1);
    expect(result.added[0]!.id).toBe('good');
  });
});

describe('T19 — SaveViewButton suggestedName prefill', () => {
  it('prefills the name input with the suggested label', async () => {
    render(SaveViewButton, { props: { suggestedName: 'Open · Severity High · 7d' } });
    await fireEvent.click(screen.getByTestId('save-view-trigger'));
    const input = /** @type {HTMLInputElement} */ (
      screen.getByTestId('save-view-name-input')
    );
    expect(input.value).toBe('Open · Severity High · 7d');
  });

  it('caps the suggested name at 80 characters', async () => {
    const long = 'X'.repeat(120);
    render(SaveViewButton, { props: { suggestedName: long } });
    await fireEvent.click(screen.getByTestId('save-view-trigger'));
    const input = /** @type {HTMLInputElement} */ (
      screen.getByTestId('save-view-name-input')
    );
    expect(input.value.length).toBe(80);
  });

  it('leaves the input empty when no suggestedName is provided', async () => {
    render(SaveViewButton);
    await fireEvent.click(screen.getByTestId('save-view-trigger'));
    const input = /** @type {HTMLInputElement} */ (
      screen.getByTestId('save-view-name-input')
    );
    expect(input.value).toBe('');
  });
});

describe('T19 — SavedViewsCard (home)', () => {
  it('renders nothing when there are no saved views', () => {
    render(SavedViewsCard);
    expect(screen.queryByTestId('home-saved-views')).toBeNull();
  });

  it('renders chips for each saved view, with route + name', () => {
    addSavedView({ name: 'Open H', route: '/concerns', search: '?filter=open' });
    addSavedView({ name: 'Overdue recs', route: '/recommendations', search: '?filter=overdue' });
    render(SavedViewsCard);
    expect(screen.getAllByTestId('home-saved-view-chip')).toHaveLength(2);
    const chips = screen.getAllByTestId('home-saved-view-chip');
    expect(chips.some((c) => c.getAttribute('href') === '/concerns?filter=open')).toBe(true);
    expect(chips.some((c) => c.getAttribute('href') === '/recommendations?filter=overdue')).toBe(true);
  });

  it('shows a maximum of 6 chips even if more views exist', () => {
    for (let i = 0; i < 10; i++) {
      addSavedView({ name: `V${i}`, route: '/concerns', search: `?n=${i}` });
    }
    render(SavedViewsCard);
    expect(screen.getAllByTestId('home-saved-view-chip')).toHaveLength(6);
  });

  it('exposes a manage link to /saved-views', () => {
    addSavedView({ name: 'X', route: '/concerns', search: '' });
    render(SavedViewsCard);
    expect(screen.getByTestId('home-saved-views-manage').getAttribute('href')).toBe(
      '/saved-views'
    );
  });

  it('refreshes when a window "view:saved" event fires', async () => {
    render(SavedViewsCard);
    expect(screen.queryByTestId('home-saved-views')).toBeNull();
    addSavedView({ name: 'New', route: '/concerns', search: '' });
    window.dispatchEvent(new CustomEvent('view:saved'));
    await waitFor(() => {
      expect(screen.getByTestId('home-saved-views')).toBeDefined();
    });
  });
});

describe('T19 — landing page mounts SavedViewsCard', () => {
  it('imports + mounts <SavedViewsCard />', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/routes/+page.svelte'),
      'utf8'
    );
    expect(src).toMatch(
      /import\s+SavedViewsCard\s+from\s+['"]\$lib\/home\/SavedViewsCard\.svelte['"]/
    );
    expect(src).toMatch(/<SavedViewsCard\s*\/>/);
  });
});

describe('T19 — /saved-views export/import controls', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/saved-views/+page.svelte'),
    'utf8'
  );

  it('imports the export/import service helpers', () => {
    expect(src).toMatch(/exportSavedViews/);
    expect(src).toMatch(/importSavedViews/);
  });

  it('renders Export + Import buttons + a hidden file input', () => {
    expect(src).toMatch(/data-testid=["']saved-views-export["']/);
    expect(src).toMatch(/data-testid=["']saved-views-import["']/);
    expect(src).toMatch(/data-testid=["']saved-views-import-input["']/);
    expect(src).toMatch(/accept=["']application\/json,.json["']/);
  });

  it('the IO row carries data-print="hide"', () => {
    expect(src).toMatch(/data-testid=["']saved-views-io["'][^>]*data-print=["']hide["']/);
  });
});

describe('T19 — /saved-views i18n + home.savedViews i18n', () => {
  const catalog = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
  );

  it('savedViewsPage gains export/import strings + interpolated announce/error keys', () => {
    expect(typeof catalog.common.savedViewsPage.export).toBe('string');
    expect(typeof catalog.common.savedViewsPage.import).toBe('string');
    expect(catalog.common.savedViewsPage.import_announce).toContain('{added}');
    expect(catalog.common.savedViewsPage.import_announce).toContain('{skipped}');
    expect(typeof catalog.common.savedViewsPage.import_error).toBe('string');
  });

  it('home.savedViews carries the dashboard heading + manage link', () => {
    expect(typeof catalog.home.savedViews.heading).toBe('string');
    expect(typeof catalog.home.savedViews.manage_link).toBe('string');
  });
});

describe('T19 — register routes pass suggestedName from active filters', () => {
  const ROUTES = [
    'training',
    'work-refusal',
    's51-evidence',
    // 'reprisal' RETIRED — ADR-0028 Phase 2b PR1: live /reprisal no longer
    // mounts SaveViewButton (no demo saved-views over the E2EE feed).
    'minutes',
    'inspections',
    'library',
    'recommendations',
    // 'concerns' RETIRED — ADR-0027 Phase 2a PR2: live /concerns no longer
    // mounts SaveViewButton; saved-views over the live, decrypted register
    // is deferred (Decision 8 future scope).
    'audit',
    'sensitive-feed'
  ] as const;

  for (const route of ROUTES) {
    it(`/${route} mounts <SaveViewButton suggestedName=...activeFilters />`, () => {
      const src = readFileSync(
        resolve(__dirname, `../../src/routes/${route}/+page.svelte`),
        'utf8'
      );
      expect(src).toMatch(
        /<SaveViewButton\s+suggestedName=\{activeFilters\.map\(\(f\)\s*=>\s*f\.label\)\.join\([^)]*\)\}\s*\/>/
      );
    });
  }
});
