/**
 * T19 — /report YoY tiles + j/k step + global PrintGeneratedAt footer.
 *
 * The route page is a thin reactive shell over `buildMonthlyReport`,
 * so we pin the structural shape (priorMonth computation, YoY tile
 * markup, key-handler wiring, i18n keys) rather than fully rendering.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import PrintGeneratedAt from '../../src/lib/ui/PrintGeneratedAt.svelte';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const REPORT_PAGE_PATH = resolve(__dirname, '../../src/routes/report/+page.svelte');
const REPORT_SRC = readFileSync(REPORT_PAGE_PATH, 'utf8');

describe('T19 — /report year-over-year tiles', () => {
  it('computes a priorMonth (same month, one year earlier) in month mode', () => {
    expect(REPORT_SRC).toMatch(/priorMonth\s*=\s*isYearView\s*\?\s*null\s*:\s*shiftMonth\(month,\s*-12\)/);
  });

  it('computes a priorYear in year mode for the YoY indicator', () => {
    expect(REPORT_SRC).toMatch(/priorYear\s*=\s*isYearView\s*\?\s*shiftYear\(year,\s*-1\)/);
  });

  it('loads a priorReport via buildMonthlyReport(priorMonth)', () => {
    expect(REPORT_SRC).toMatch(/priorReport\s*=\s*priorMonth\s*\?\s*buildMonthlyReport\(priorMonth\)/);
  });

  it('each total tile renders a YoY indicator with delta + suffix when priorReport is present', () => {
    expect(REPORT_SRC).toMatch(/data-testid=["']report-tile-yoy["']/);
    expect(REPORT_SRC).toMatch(/data-delta=\{delta\}/);
    expect(REPORT_SRC).toContain('report.page.yoy_vs_label');
  });

  it("the YoY indicator tooltip names the prior period (month-mode or year-mode)", () => {
    expect(REPORT_SRC).toContain('report.page.yoy_tooltip');
    // The route now routes the priorLabel through a yoyFor helper so
    // year-mode and month-mode can share the YoY rendering. Pin the
    // helper consumption rather than the literal priorMonth/year.
    expect(REPORT_SRC).toMatch(/month:\s*yoy\.priorLabel/);
  });

  it('the YoY indicator carries direction classes (up/down/flat) for colour cues', () => {
    expect(REPORT_SRC).toMatch(/class:is-up=\{delta\s*>\s*0\}/);
    expect(REPORT_SRC).toMatch(/class:is-down=\{delta\s*<\s*0\}/);
    expect(REPORT_SRC).toMatch(/class:is-flat=\{delta\s*===\s*0\}/);
  });
});

describe('T19 — /report j/k keyboard step', () => {
  it('mounts onMount/onDestroy listeners on document keydown', () => {
    expect(REPORT_SRC).toMatch(/document\.addEventListener\(['"]keydown['"]/);
    expect(REPORT_SRC).toMatch(/document\.removeEventListener\(['"]keydown['"]/);
  });

  it('"j" navigates to prevHref, "k" to nextHref via goto', () => {
    expect(REPORT_SRC).toMatch(/e\.key\s*===\s*['"]j['"][^}]*goto\(prevHref/);
    expect(REPORT_SRC).toMatch(/e\.key\s*===\s*['"]k['"][^}]*goto\(nextHref/);
  });

  it('ignores the keystroke when focus is in a typing target', () => {
    expect(REPORT_SRC).toMatch(/isTypingTarget\(e\.target\)/);
  });

  it('ignores modifier-key combinations (Cmd/Ctrl/Alt + j/k)', () => {
    expect(REPORT_SRC).toMatch(/metaKey[^}]*ctrlKey[^}]*altKey/);
  });
});

describe('T19 — KeyboardShortcuts + /help expose the j/k bindings', () => {
  const modalSrc = readFileSync(
    resolve(__dirname, '../../src/lib/ui/KeyboardShortcuts.svelte'),
    'utf8'
  );
  const helpSrc = readFileSync(
    resolve(__dirname, '../../src/routes/help/+page.svelte'),
    'utf8'
  );

  it('the modal ROWS array lists j + k', () => {
    expect(modalSrc).toMatch(/key:\s*['"]j['"]/);
    expect(modalSrc).toMatch(/key:\s*['"]k['"]/);
  });

  it('the /help page lists j + k', () => {
    expect(helpSrc).toMatch(/key:\s*['"]j['"]/);
    expect(helpSrc).toMatch(/key:\s*['"]k['"]/);
  });

  it('the catalog carries report_prev + report_next + key.j + key.k', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(typeof catalog.common.keyboardShortcuts.rows.report_prev).toBe('string');
    expect(typeof catalog.common.keyboardShortcuts.rows.report_next).toBe('string');
    expect(catalog.common.keyboardShortcuts.key.j).toBe('j');
    expect(catalog.common.keyboardShortcuts.key.k).toBe('k');
  });
});

describe('T19 — PrintGeneratedAt', () => {
  it('renders a data-print="print-only" stamp', () => {
    render(PrintGeneratedAt);
    const el = screen.getByTestId('print-generated-at');
    expect(el.getAttribute('data-print')).toBe('print-only');
  });

  it('renders a YYYY-MM-DD HH:MM-shaped timestamp in the body', () => {
    render(PrintGeneratedAt);
    const el = screen.getByTestId('print-generated-at');
    // The interpolated stamp should match the local-time pattern.
    expect(el.textContent ?? '').toMatch(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/);
  });
});

describe('T19 — layout mounts PrintGeneratedAt + the catalog carries the i18n key', () => {
  it('imports + mounts <PrintGeneratedAt />', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/routes/+layout.svelte'),
      'utf8'
    );
    expect(src).toMatch(
      /import\s+PrintGeneratedAt\s+from\s+['"]\$lib\/ui\/PrintGeneratedAt\.svelte['"]/
    );
    expect(src).toMatch(/<PrintGeneratedAt\s*\/>/);
  });

  it('the catalog carries common.print.generated_at with a {stamp} placeholder', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(catalog.common.print.generated_at).toContain('{stamp}');
  });
});
