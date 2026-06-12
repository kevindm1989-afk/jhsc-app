/**
 * T19 — Recent routes surface on /search and /more.
 *
 * /search renders a "Recently visited" chip section above the recent-
 * searches chips on its empty state. /more renders the same chip group
 * near the top of the launcher so a worker can jump back into a
 * register without scrolling the directory. /help documents both
 * surfaces.
 *
 * Per repo convention the +page.svelte files cannot be rendered in
 * vitest (they depend on `$app/navigation` and `$app/stores`), so we
 * pin the structure via source-string + i18n catalog checks the same
 * way other route-mount tests do.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SEARCH_PAGE_PATH = resolve(__dirname, '../../src/routes/search/+page.svelte');
const MORE_PAGE_PATH = resolve(__dirname, '../../src/routes/more/+page.svelte');
const CATALOG_PATH = resolve(__dirname, '../../../../i18n/en-CA.json');

describe('T19 — /search empty state surfaces recently-visited routes', () => {
  const src = readFileSync(SEARCH_PAGE_PATH, 'utf8');

  it('imports listRecentRoutes from the nav service', () => {
    expect(src).toMatch(
      /import\s*\{\s*listRecentRoutes\s*\}\s+from\s+['"]\$lib\/nav\/recent-routes['"]/
    );
  });

  it('hydrates a recentRoutes state from listRecentRoutes on mount', () => {
    expect(src).toMatch(/recentRoutes\s*=\s*listRecentRoutes\(\)/);
  });

  it('renders the routes nav with the new testid + chip testid', () => {
    expect(src).toMatch(/data-testid=["']search-recents-routes["']/);
    expect(src).toMatch(/data-testid=["']search-recents-route-chip["']/);
  });

  it('the routes nav is gated on recentRoutes.length > 0', () => {
    expect(src).toMatch(/\{#if\s+recentRoutes\.length\s*>\s*0\}/);
  });

  it('each chip links to the stored route via the href', () => {
    expect(src).toMatch(/href=\{r\.route\}/);
  });

  it('uses the new search.page.recent_routes_label key', () => {
    expect(src).toMatch(/t\(['"]search\.page\.recent_routes_label['"]\)/);
  });

  it('the routes section is inside the !query.trim() empty-state block', () => {
    expect(src).toMatch(
      /\{#if\s+!query\.trim\(\)\}[\s\S]*data-testid=["']search-recents-routes["']/
    );
  });
});

describe('T19 — /more page surfaces recently-visited routes', () => {
  const src = readFileSync(MORE_PAGE_PATH, 'utf8');

  it('imports listRecentRoutes from the nav service', () => {
    expect(src).toMatch(
      /import\s*\{[\s\S]*listRecentRoutes[\s\S]*\}\s+from\s+['"]\$lib\/nav\/recent-routes['"]/
    );
  });

  it('hydrates a recentRoutes state from listRecentRoutes on mount', () => {
    expect(src).toMatch(/recentRoutes\s*=\s*listRecentRoutes\(\)/);
  });

  it('renders the section with the more-recent-routes testid + chip testid', () => {
    expect(src).toMatch(/data-testid=["']more-recent-routes["']/);
    expect(src).toMatch(/data-testid=["']more-recent-route-chip["']/);
  });

  it('the section is gated on recentRoutes.length > 0', () => {
    expect(src).toMatch(/\{#if\s+recentRoutes\.length\s*>\s*0\}/);
  });

  it('each chip links to the stored route via the href', () => {
    expect(src).toMatch(/href=\{r\.route\}/);
  });

  it('uses the new common.morePage.recent_routes_heading key', () => {
    expect(src).toMatch(/t\(['"]common\.morePage\.recent_routes_heading['"]\)/);
  });

  it('the section renders above the first more-group section', () => {
    expect(src).toMatch(
      /data-testid=["']more-recent-routes["'][\s\S]*data-testid=["']more-group-intake["']/
    );
  });
});

describe('T19 — i18n catalog + /help docs', () => {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

  it('search.page carries the new recent_routes_label key', () => {
    expect(typeof catalog.search.page.recent_routes_label).toBe('string');
    expect(catalog.search.page.recent_routes_label.length).toBeGreaterThan(0);
  });

  it('common.morePage carries the new recent_routes_heading key', () => {
    expect(typeof catalog.common.morePage.recent_routes_heading).toBe('string');
    expect(catalog.common.morePage.recent_routes_heading.length).toBeGreaterThan(0);
  });

  it('common.helpPage.recent_visits_body documents both /search and /more', () => {
    expect(typeof catalog.common.helpPage.recent_visits_body).toBe('string');
    expect(catalog.common.helpPage.recent_visits_body).toMatch(/\/search/);
    expect(catalog.common.helpPage.recent_visits_body).toMatch(/\/more/);
  });
});
