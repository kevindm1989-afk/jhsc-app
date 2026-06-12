/**
 * T19 — Saved-views: duplicate action + copy-URL action + /help docs.
 *
 * `duplicateSavedView(id)` clones a saved view with a fresh id + new
 * createdAt, suffixed name, and preserves route/search/pinnedToHome.
 * The /saved-views page wires a per-row "Duplicate" button + a per-row
 * "Copy URL" button that puts the absolute view URL on the clipboard.
 * /help documents both.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  addSavedView,
  duplicateSavedView,
  listSavedViews,
  setSavedViewPinned
} from '../../src/lib/saved-views/saved-views';

const PAGE_PATH = resolve(__dirname, '../../src/routes/saved-views/+page.svelte');
const HELP_PATH = resolve(__dirname, '../../src/routes/help/+page.svelte');
const CATALOG_PATH = resolve(__dirname, '../../../../i18n/en-CA.json');

function freshStorage() {
  if (typeof localStorage !== 'undefined') localStorage.clear();
}

describe('T19 — duplicateSavedView service', () => {
  it('returns null when the id is unknown', () => {
    freshStorage();
    expect(duplicateSavedView('no-such-id')).toBeNull();
  });

  it('clones a view with a fresh id, new createdAt, and "(copy)" name suffix', () => {
    freshStorage();
    const original = addSavedView({
      name: 'Open severity:high',
      route: '/concerns',
      search: '?status=open&severity=high'
    });
    const dup = duplicateSavedView(original.id);
    expect(dup).not.toBeNull();
    expect(dup!.id).not.toBe(original.id);
    expect(dup!.name).toBe('Open severity:high (copy)');
    expect(dup!.route).toBe(original.route);
    expect(dup!.search).toBe(original.search);
    expect(typeof dup!.createdAt).toBe('string');
    // The new view is persisted alongside the original.
    const all = listSavedViews();
    expect(all).toHaveLength(2);
    const ids = all.map((v) => v.id);
    expect(ids).toContain(original.id);
    expect(ids).toContain(dup!.id);
  });

  it('preserves the pinnedToHome flag on the clone', () => {
    freshStorage();
    const original = addSavedView({ name: 'Pinned', route: '/concerns', search: '' });
    setSavedViewPinned(original.id, true);
    const dup = duplicateSavedView(original.id);
    expect(dup!.pinnedToHome).toBe(true);
  });

  it('caps the "(copy)" suffix into the 80-char name budget', () => {
    freshStorage();
    const long = 'x'.repeat(80);
    const original = addSavedView({ name: long, route: '/concerns', search: '' });
    const dup = duplicateSavedView(original.id);
    expect(dup!.name.length).toBeLessThanOrEqual(80);
    // Even with truncation, the literal "(copy)" suffix is preserved.
    expect(dup!.name.endsWith(' (copy)')).toBe(true);
  });
});

describe('T19 — /saved-views page wires duplicate + copy-url actions', () => {
  const src = readFileSync(PAGE_PATH, 'utf8');

  it('imports duplicateSavedView from the service', () => {
    expect(src).toMatch(
      /import\s*\{[\s\S]*duplicateSavedView[\s\S]*\}\s+from\s+['"]\$lib\/saved-views\/saved-views['"]/
    );
  });

  it('renders a Duplicate action button with the canonical testid', () => {
    expect(src).toMatch(/data-testid=["']saved-views-duplicate["']/);
  });

  it('renders a Copy URL action button with the canonical testid', () => {
    expect(src).toMatch(/data-testid=["']saved-views-copy-url["']/);
  });

  it('the Duplicate button is wired to a handler that calls duplicateSavedView', () => {
    // Either inlined (duplicateSavedView(v.id)) or wrapped through a
    // local handler — both patterns are valid; we just want to see
    // both literals in the source so a future refactor stays honest.
    expect(src).toMatch(/data-testid=["']saved-views-duplicate["'][\s\S]*?on:click/);
    expect(src).toMatch(/duplicateSavedView\(/);
  });

  it('the Copy URL handler writes to navigator.clipboard.writeText', () => {
    expect(src).toMatch(/navigator\.clipboard\??\.writeText/);
  });

  it('the Copy URL handler composes window.location.origin + route + search', () => {
    expect(src).toMatch(/window\.location\.origin\s*\+\s*v\.route\s*\+\s*v\.search/);
  });

  it('uses the new i18n keys for both actions', () => {
    expect(src).toMatch(/t\(['"]common\.savedViewsPage\.duplicate['"]\)/);
    expect(src).toMatch(/t\(['"]common\.savedViewsPage\.copy_url['"]\)/);
  });
});

describe('T19 — i18n + /help docs the new actions', () => {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

  it('savedViewsPage carries the new duplicate + copy_url keys', () => {
    expect(typeof catalog.common.savedViewsPage.duplicate).toBe('string');
    expect(typeof catalog.common.savedViewsPage.copy_url).toBe('string');
    expect(typeof catalog.common.savedViewsPage.copy_url_copied).toBe('string');
    expect(typeof catalog.common.savedViewsPage.copy_url_failed).toBe('string');
  });

  it('common.helpPage.saved_views_body documents duplicate + copy URL', () => {
    expect(catalog.common.helpPage.saved_views_body).toMatch(/duplicate/i);
    expect(catalog.common.helpPage.saved_views_body).toMatch(/copy/i);
  });

  it('/help page still renders the saved-views body key', () => {
    const help = readFileSync(HELP_PATH, 'utf8');
    expect(help).toContain('common.helpPage.saved_views_body');
  });
});
