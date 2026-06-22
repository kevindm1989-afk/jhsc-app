/**
 * T19 — SaveViewButton + SavedViewsRail + /saved-views page UI.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import SaveViewButton from '../../src/lib/ui/SaveViewButton.svelte';
import SavedViewsRail from '../../src/lib/ui/SavedViewsRail.svelte';
import { addSavedView } from '../../src/lib/saved-views/saved-views';

beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('T19 — SaveViewButton', () => {
  it('renders the trigger button in idle mode by default', () => {
    render(SaveViewButton);
    expect(screen.getByTestId('save-view-trigger')).toBeDefined();
    expect(screen.queryByTestId('save-view-name-input')).toBeNull();
    expect(screen.queryByTestId('save-view-saved')).toBeNull();
  });

  it('clicking the trigger swaps to the naming input + Save button', async () => {
    render(SaveViewButton);
    await fireEvent.click(screen.getByTestId('save-view-trigger'));
    expect(screen.getByTestId('save-view-name-input')).toBeDefined();
    expect(screen.getByTestId('save-view-confirm')).toBeDefined();
    expect(screen.getByTestId('save-view-cancel')).toBeDefined();
  });

  it('refuses to save an empty name (stays in naming mode)', async () => {
    render(SaveViewButton);
    await fireEvent.click(screen.getByTestId('save-view-trigger'));
    await fireEvent.click(screen.getByTestId('save-view-confirm'));
    expect(screen.getByTestId('save-view-name-input')).toBeDefined();
    expect(screen.queryByTestId('save-view-saved')).toBeNull();
  });

  it('Cancel returns to idle without writing', async () => {
    render(SaveViewButton);
    await fireEvent.click(screen.getByTestId('save-view-trigger'));
    const input = screen.getByTestId('save-view-name-input');
    await fireEvent.input(input, { target: { value: 'My view' } });
    await fireEvent.click(screen.getByTestId('save-view-cancel'));
    expect(screen.queryByTestId('save-view-saved')).toBeNull();
    expect(screen.getByTestId('save-view-trigger')).toBeDefined();
    expect(localStorage.getItem('jhsc-saved-views')).toBeNull();
  });

  it('saving persists to localStorage with the current location pathname/search', async () => {
    // jsdom default window.location.href is "about:blank" with pathname ""; override.
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: new URL('http://localhost/concerns?filter=open&severity=high')
    });
    render(SaveViewButton);
    await fireEvent.click(screen.getByTestId('save-view-trigger'));
    const input = screen.getByTestId('save-view-name-input');
    await fireEvent.input(input, { target: { value: 'Open H' } });
    await fireEvent.click(screen.getByTestId('save-view-confirm'));
    expect(screen.getByTestId('save-view-saved')).toBeDefined();
    const raw = localStorage.getItem('jhsc-saved-views');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('Open H');
    expect(parsed[0].route).toBe('/concerns');
    expect(parsed[0].search).toBe('?filter=open&severity=high');
  });

  it('saving fires a "view:saved" CustomEvent on window', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: new URL('http://localhost/concerns')
    });
    let detail: unknown = null;
    const handler = (e: Event) => {
      detail = (e as CustomEvent).detail;
    };
    window.addEventListener('view:saved', handler);
    render(SaveViewButton);
    await fireEvent.click(screen.getByTestId('save-view-trigger'));
    const input = screen.getByTestId('save-view-name-input');
    await fireEvent.input(input, { target: { value: 'X' } });
    await fireEvent.click(screen.getByTestId('save-view-confirm'));
    expect(detail).not.toBeNull();
    expect((detail as { name: string }).name).toBe('X');
    window.removeEventListener('view:saved', handler);
  });

  it('carries data-print="hide"', () => {
    render(SaveViewButton);
    expect(screen.getByTestId('save-view').getAttribute('data-print')).toBe('hide');
  });
});

describe('T19 — SavedViewsRail', () => {
  it('renders nothing when no views exist for the route', () => {
    render(SavedViewsRail, { props: { route: '/concerns' } });
    expect(screen.queryByTestId('saved-views-rail')).toBeNull();
  });

  it('renders one chip per saved view for the matching route', () => {
    addSavedView({ name: 'A', route: '/concerns', search: '?filter=open' });
    addSavedView({ name: 'B', route: '/concerns', search: '?severity=high' });
    addSavedView({ name: 'C', route: '/training', search: '' });
    render(SavedViewsRail, { props: { route: '/concerns' } });
    expect(screen.getAllByTestId('saved-view-chip')).toHaveLength(2);
  });

  it('each chip href is route + search', () => {
    const v = addSavedView({
      name: 'Open H',
      route: '/concerns',
      search: '?filter=open&severity=high'
    });
    render(SavedViewsRail, { props: { route: '/concerns' } });
    const chip = screen.getByTestId('saved-view-chip');
    expect(chip.getAttribute('href')).toBe('/concerns?filter=open&severity=high');
    expect(chip.getAttribute('data-id')).toBe(v.id);
  });

  it('refreshes when a window "view:saved" event fires', async () => {
    render(SavedViewsRail, { props: { route: '/concerns' } });
    expect(screen.queryByTestId('saved-views-rail')).toBeNull();
    addSavedView({ name: 'New', route: '/concerns', search: '' });
    window.dispatchEvent(new CustomEvent('view:saved'));
    await waitFor(() => {
      expect(screen.getByTestId('saved-views-rail')).toBeDefined();
    });
  });

  it('exposes a /saved-views management link', () => {
    addSavedView({ name: 'X', route: '/concerns', search: '' });
    render(SavedViewsRail, { props: { route: '/concerns' } });
    expect(screen.getByTestId('saved-views-manage-link').getAttribute('href')).toBe(
      '/saved-views'
    );
  });

  it('carries data-print="hide"', () => {
    addSavedView({ name: 'X', route: '/concerns', search: '' });
    render(SavedViewsRail, { props: { route: '/concerns' } });
    expect(screen.getByTestId('saved-views-rail').getAttribute('data-print')).toBe('hide');
  });
});

describe('T19 — /saved-views page', () => {
  const PAGE_PATH = resolve(__dirname, '../../src/routes/saved-views/+page.svelte');
  const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/saved-views/+page.ts');

  it('the +page.svelte component exists', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('the +page.ts loader exists and declares prerender + ssr=false', () => {
    expect(existsSync(PAGE_TS_PATH)).toBe(true);
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+prerender\s*=\s*true/);
    expect(src).toMatch(/export\s+const\s+ssr\s*=\s*false/);
  });

  it('renders the saved-views-page testid + an empty state + back-to-home', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']saved-views-page["']/);
    expect(src).toMatch(/data-testid=["']saved-views-empty["']/);
    expect(src).toMatch(/data-testid=["']saved-views-back-to-home["']/);
  });

  it('wires rename + delete actions to the service', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/renameSavedView/);
    expect(src).toMatch(/deleteSavedView/);
    expect(src).toMatch(/data-testid=["']saved-views-rename["']/);
    expect(src).toMatch(/data-testid=["']saved-views-delete["']/);
  });

  it('carries a noindex meta', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });
});

describe('T19 — /more launcher surfaces /saved-views', () => {
  it('renders a /saved-views row in the account group', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/routes/more/+page.svelte'),
      'utf8'
    );
    expect(src).toMatch(/href=["']\/saved-views["']/);
    expect(src).toMatch(/data-testid=["']more-link-saved-views["']/);
  });
});

describe('T19 — SaveViewButton + SavedViewsRail rollout across the 11 register surfaces', () => {
  const ROUTES = [
    'training',
    'work-refusal',
    's51-evidence',
    // 'reprisal' RETIRED — ADR-0028 Phase 2b PR1: live /reprisal no longer
    // mounts SaveViewButton + SavedViewsRail.
    'minutes',
    'inspections',
    'library',
    'recommendations',
    // 'concerns' RETIRED — ADR-0027 Phase 2a PR2: live /concerns no longer
    // mounts SaveViewButton + SavedViewsRail (Decision 8 future scope).
    'audit',
    'sensitive-feed'
  ] as const;

  for (const route of ROUTES) {
    it(`/${route} imports + mounts SaveViewButton + SavedViewsRail`, () => {
      const src = readFileSync(
        resolve(__dirname, `../../src/routes/${route}/+page.svelte`),
        'utf8'
      );
      expect(src).toMatch(
        /import\s+SaveViewButton\s+from\s+['"]\$lib\/ui\/SaveViewButton\.svelte['"]/
      );
      expect(src).toMatch(
        /import\s+SavedViewsRail\s+from\s+['"]\$lib\/ui\/SavedViewsRail\.svelte['"]/
      );
      // SaveViewButton may be mounted with or without a suggestedName
      // prop — the follow-up bundle adds suggestedName=activeFilters…
      // to every route.
      expect(src).toMatch(/<SaveViewButton[\s>]/);
      expect(src).toMatch(/<SavedViewsRail\s+route=["']\/[a-z0-9-]+["']\s*\/>/);
    });
  }
});

describe('T19 — common.savedViews + common.savedViewsPage + link i18n keys', () => {
  const catalog = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
  );

  it('catalog carries the SaveViewButton + SavedViewsRail strings', () => {
    expect(typeof catalog.common.savedViews.save_button).toBe('string');
    expect(typeof catalog.common.savedViews.save_confirm).toBe('string');
    expect(typeof catalog.common.savedViews.name_placeholder).toBe('string');
    expect(typeof catalog.common.savedViews.name_aria).toBe('string');
    expect(typeof catalog.common.savedViews.cancel_aria).toBe('string');
    expect(typeof catalog.common.savedViews.saved_announce).toBe('string');
    expect(typeof catalog.common.savedViews.rail_aria).toBe('string');
    expect(typeof catalog.common.savedViews.rail_label).toBe('string');
    expect(typeof catalog.common.savedViews.manage_link).toBe('string');
  });

  it('catalog carries the /saved-views page strings', () => {
    expect(typeof catalog.common.savedViewsPage.title).toBe('string');
    expect(typeof catalog.common.savedViewsPage.heading).toBe('string');
    expect(typeof catalog.common.savedViewsPage.intro).toBe('string');
    expect(typeof catalog.common.savedViewsPage.empty).toBe('string');
    expect(typeof catalog.common.savedViewsPage.rename).toBe('string');
    expect(typeof catalog.common.savedViewsPage.delete).toBe('string');
    expect(typeof catalog.common.savedViewsPage.back_to_home_cta).toBe('string');
  });

  it('catalog carries the /more launcher link for /saved-views', () => {
    expect(typeof catalog.common.morePage.link_saved_views_label).toBe('string');
    expect(typeof catalog.common.morePage.link_saved_views_blurb).toBe('string');
  });
});
