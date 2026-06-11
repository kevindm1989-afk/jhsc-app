/**
 * T19 — Saved-views service (localStorage CRUD).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  addSavedView,
  deleteSavedView,
  hrefForSavedView,
  listSavedViews,
  listSavedViewsForRoute,
  renameSavedView,
  type SavedView
} from '../../src/lib/saved-views/saved-views';

beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

describe('T19 — saved-views service', () => {
  it('listSavedViews returns [] on a fresh device', () => {
    expect(listSavedViews()).toEqual([]);
  });

  it('addSavedView persists and round-trips', () => {
    const v = addSavedView({ name: 'Open H severities', route: '/concerns', search: '?filter=open' });
    expect(v.id).toBeTypeOf('string');
    expect(v.createdAt).toBeTypeOf('string');
    expect(v.name).toBe('Open H severities');
    expect(listSavedViews()).toHaveLength(1);
    expect(listSavedViews()[0]!.id).toBe(v.id);
  });

  it('listSavedViewsForRoute scopes the list to a single route', () => {
    addSavedView({ name: 'A', route: '/concerns', search: '' });
    addSavedView({ name: 'B', route: '/concerns', search: '?filter=open' });
    addSavedView({ name: 'C', route: '/training', search: '?filter=expired' });
    const c = listSavedViewsForRoute('/concerns');
    expect(c).toHaveLength(2);
    expect(c.every((v) => v.route === '/concerns')).toBe(true);
    expect(listSavedViewsForRoute('/training')).toHaveLength(1);
  });

  it('listSavedViews is newest-first', () => {
    const a = addSavedView({ name: 'first', route: '/c', search: '' });
    // Force a distinct createdAt
    a.createdAt = '2026-01-01T00:00:00.000Z';
    localStorage.setItem('jhsc-saved-views', JSON.stringify([a]));
    const b = addSavedView({ name: 'second', route: '/c', search: '' });
    expect(listSavedViews()[0]!.id).toBe(b.id);
    expect(listSavedViews()[1]!.id).toBe(a.id);
  });

  it('addSavedView normalizes whitespace and caps at 80 chars', () => {
    const long = '  ' + 'x'.repeat(120) + '   ';
    const v = addSavedView({ name: long, route: '/c', search: '' });
    expect(v.name.length).toBe(80);
    expect(v.name.startsWith(' ')).toBe(false);
  });

  it('renameSavedView updates the record', () => {
    const v = addSavedView({ name: 'before', route: '/c', search: '' });
    const updated = renameSavedView(v.id, 'after');
    expect(updated?.name).toBe('after');
    expect(listSavedViews()[0]!.name).toBe('after');
  });

  it('renameSavedView returns null for an unknown id', () => {
    expect(renameSavedView('does-not-exist', 'x')).toBeNull();
  });

  it('deleteSavedView removes the record and returns true', () => {
    const v = addSavedView({ name: 'gone', route: '/c', search: '' });
    expect(deleteSavedView(v.id)).toBe(true);
    expect(listSavedViews()).toEqual([]);
  });

  it('deleteSavedView returns false when nothing was removed', () => {
    expect(deleteSavedView('does-not-exist')).toBe(false);
  });

  it('hrefForSavedView returns route + search verbatim', () => {
    const v: SavedView = {
      id: 'x',
      name: 'x',
      route: '/concerns',
      search: '?filter=open&severity=high',
      createdAt: '2026-06-11T00:00:00.000Z'
    };
    expect(hrefForSavedView(v)).toBe('/concerns?filter=open&severity=high');
  });

  it('tolerates corrupt JSON in storage (returns [] instead of throwing)', () => {
    localStorage.setItem('jhsc-saved-views', '{not valid json');
    expect(listSavedViews()).toEqual([]);
    // A subsequent add overwrites the bad value cleanly.
    const v = addSavedView({ name: 'after corruption', route: '/c', search: '' });
    expect(listSavedViews()).toEqual([v]);
  });

  it('ignores non-object entries in storage', () => {
    localStorage.setItem('jhsc-saved-views', JSON.stringify(['nope', 42, null, { id: 'a' }]));
    expect(listSavedViews()).toEqual([]);
  });
});
