/**
 * T19 — ShortcutsHintPill (discoverability nudge for "?" shortcut)
 * + KeyboardShortcuts modal links to /help.
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ShortcutsHintPill from '../../src/lib/ui/ShortcutsHintPill.svelte';

const STORAGE_KEY = 'jhsc-shortcuts-hint-dismissed';

beforeEach(() => {
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
});

describe('T19 — ShortcutsHintPill', () => {
  it('renders by default on a fresh session', () => {
    render(ShortcutsHintPill);
    expect(screen.getByTestId('shortcuts-hint-pill')).toBeDefined();
  });

  it('hides itself when the worker clicks the × button + persists the dismissal', async () => {
    render(ShortcutsHintPill);
    await fireEvent.click(screen.getByTestId('shortcuts-hint-dismiss'));
    expect(screen.queryByTestId('shortcuts-hint-pill')).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('1');
  });

  it('stays hidden across re-mounts once dismissed (sessionStorage gates)', () => {
    sessionStorage.setItem(STORAGE_KEY, '1');
    render(ShortcutsHintPill);
    expect(screen.queryByTestId('shortcuts-hint-pill')).toBeNull();
  });

  it('auto-dismisses when the worker presses "?" (they discovered it)', async () => {
    render(ShortcutsHintPill);
    expect(screen.getByTestId('shortcuts-hint-pill')).toBeDefined();
    await fireEvent.keyDown(document, { key: '?' });
    expect(screen.queryByTestId('shortcuts-hint-pill')).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('1');
  });

  it('carries data-print="hide" so it does not appear in printed views', () => {
    render(ShortcutsHintPill);
    expect(screen.getByTestId('shortcuts-hint-pill').getAttribute('data-print')).toBe('hide');
  });
});

describe('T19 — ShortcutsHintPill is mounted on the signed-in landing page', () => {
  it('imports + mounts <ShortcutsHintPill />', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/routes/+page.svelte'),
      'utf8'
    );
    expect(src).toMatch(
      /import\s+ShortcutsHintPill\s+from\s+['"]\$lib\/ui\/ShortcutsHintPill\.svelte['"]/
    );
    expect(src).toMatch(/<ShortcutsHintPill\s*\/>/);
  });
});

describe('T19 — KeyboardShortcuts modal links to /help', () => {
  it('mounts a /help link in the modal actions row', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/lib/ui/KeyboardShortcuts.svelte'),
      'utf8'
    );
    expect(src).toMatch(/data-testid=["']keyboard-shortcuts-help-link["']/);
    expect(src).toMatch(/href=["']\/help["']/);
  });
});

describe('T19 — common.shortcutsHint.* + open_help i18n keys', () => {
  const catalog = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
  );

  it('catalog carries the hint pill strings', () => {
    expect(typeof catalog.common.shortcutsHint.text_prefix).toBe('string');
    expect(typeof catalog.common.shortcutsHint.text_suffix).toBe('string');
    expect(typeof catalog.common.shortcutsHint.dismiss_aria).toBe('string');
  });

  it('catalog carries the open_help string on the modal', () => {
    expect(typeof catalog.common.keyboardShortcuts.open_help).toBe('string');
  });
});
