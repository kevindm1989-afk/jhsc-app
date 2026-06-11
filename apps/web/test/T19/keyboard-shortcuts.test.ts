/**
 * T19 — KeyboardShortcuts overlay + /help static page.
 *
 * Covers:
 *   - "?" globally opens the modal; Esc closes it.
 *   - The modal carries dialog semantics (role + aria-modal) and a
 *     close button.
 *   - Pressing "?" inside a typing target (input/textarea) is ignored
 *     so users can type a literal `?` in form fields.
 *   - The layout mounts the component so it's available app-wide.
 *   - /help page exists, prerender + ssr=false, lists the shortcuts.
 *   - /more launcher surfaces /help.
 *   - i18n keys are present.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import KeyboardShortcuts from '../../src/lib/ui/KeyboardShortcuts.svelte';

afterEach(() => {
  cleanup();
});

describe('T19 — KeyboardShortcuts overlay', () => {
  it('is closed by default (no dialog in the DOM)', () => {
    render(KeyboardShortcuts);
    expect(screen.queryByTestId('keyboard-shortcuts-dialog')).toBeNull();
  });

  it('opens when "?" is pressed on document', async () => {
    render(KeyboardShortcuts);
    await fireEvent.keyDown(document, { key: '?' });
    expect(screen.getByTestId('keyboard-shortcuts-dialog')).toBeDefined();
  });

  it('the dialog carries role="dialog" + aria-modal="true"', async () => {
    render(KeyboardShortcuts);
    await fireEvent.keyDown(document, { key: '?' });
    const dialog = screen.getByTestId('keyboard-shortcuts-dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('Esc closes an open dialog', async () => {
    render(KeyboardShortcuts);
    await fireEvent.keyDown(document, { key: '?' });
    expect(screen.getByTestId('keyboard-shortcuts-dialog')).toBeDefined();
    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('keyboard-shortcuts-dialog')).toBeNull();
  });

  it('the close button also closes the dialog', async () => {
    render(KeyboardShortcuts);
    await fireEvent.keyDown(document, { key: '?' });
    await fireEvent.click(screen.getByTestId('keyboard-shortcuts-close'));
    expect(screen.queryByTestId('keyboard-shortcuts-dialog')).toBeNull();
  });

  it('"?" is ignored when focus is inside a text input', async () => {
    render(KeyboardShortcuts);
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    await fireEvent.keyDown(input, { key: '?' });
    expect(screen.queryByTestId('keyboard-shortcuts-dialog')).toBeNull();
    input.remove();
  });

  it('"?" is ignored when focus is inside a textarea', async () => {
    render(KeyboardShortcuts);
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    await fireEvent.keyDown(ta, { key: '?' });
    expect(screen.queryByTestId('keyboard-shortcuts-dialog')).toBeNull();
    ta.remove();
  });
});

describe('T19 — KeyboardShortcuts is mounted at the layout level', () => {
  it('imports + mounts <KeyboardShortcuts /> from the root layout', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/routes/+layout.svelte'),
      'utf8'
    );
    expect(src).toMatch(
      /import\s+KeyboardShortcuts\s+from\s+['"]\$lib\/ui\/KeyboardShortcuts\.svelte['"]/
    );
    expect(src).toMatch(/<KeyboardShortcuts\s*\/>/);
  });
});

describe('T19 — /help static page', () => {
  const PAGE_PATH = resolve(__dirname, '../../src/routes/help/+page.svelte');
  const PAGE_TS_PATH = resolve(__dirname, '../../src/routes/help/+page.ts');

  it('the +page.svelte component exists', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('the +page.ts loader exists and declares prerender + ssr=false', () => {
    expect(existsSync(PAGE_TS_PATH)).toBe(true);
    const src = readFileSync(PAGE_TS_PATH, 'utf8');
    expect(src).toMatch(/export\s+const\s+prerender\s*=\s*true/);
    expect(src).toMatch(/export\s+const\s+ssr\s*=\s*false/);
  });

  it('renders the help-page data-testid + a shortcuts list', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']help-page["']/);
    expect(src).toMatch(/data-testid=["']help-shortcuts["']/);
  });

  it('renders the four content sections (shortcuts, urls, csv, report)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    for (const heading of [
      'shortcuts_heading',
      'urls_heading',
      'csv_heading',
      'report_heading'
    ]) {
      expect(src).toContain(`common.helpPage.${heading}`);
    }
  });

  it('renders a back-to-home link', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/data-testid=["']help-back-to-home["']/);
  });

  it('carries a noindex meta', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/name=["']robots["']\s+content=["']noindex/);
  });
});

describe('T19 — /more launcher surfaces /help', () => {
  it('renders a /help row', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/routes/more/+page.svelte'),
      'utf8'
    );
    expect(src).toMatch(/href=["']\/help["']/);
    expect(src).toMatch(/data-testid=["']more-link-help["']/);
  });
});

describe('T19 — common.keyboardShortcuts.* + common.helpPage.* i18n keys', () => {
  it('catalog carries the shortcut + dialog strings', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(typeof catalog.common.keyboardShortcuts.heading).toBe('string');
    expect(typeof catalog.common.keyboardShortcuts.close_aria).toBe('string');
    expect(typeof catalog.common.keyboardShortcuts.rows.search).toBe('string');
    expect(typeof catalog.common.keyboardShortcuts.rows.shortcuts).toBe('string');
    expect(typeof catalog.common.keyboardShortcuts.rows.escape).toBe('string');
    expect(typeof catalog.common.keyboardShortcuts.key.slash).toBe('string');
    expect(typeof catalog.common.keyboardShortcuts.key.question).toBe('string');
    expect(typeof catalog.common.keyboardShortcuts.key.escape).toBe('string');
  });

  it('catalog carries the help-page strings', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(typeof catalog.common.helpPage.title).toBe('string');
    expect(typeof catalog.common.helpPage.heading).toBe('string');
    expect(typeof catalog.common.helpPage.intro).toBe('string');
    expect(typeof catalog.common.helpPage.shortcuts_heading).toBe('string');
    expect(typeof catalog.common.helpPage.urls_body).toBe('string');
    expect(typeof catalog.common.helpPage.csv_body).toBe('string');
    expect(typeof catalog.common.helpPage.report_body).toBe('string');
    expect(typeof catalog.common.helpPage.back_to_home_cta).toBe('string');
  });

  it('catalog carries the /more link label + blurb for /help', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(typeof catalog.common.morePage.link_help_label).toBe('string');
    expect(typeof catalog.common.morePage.link_help_blurb).toBe('string');
  });
});
