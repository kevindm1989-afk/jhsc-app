/**
 * T19 — print page numbers (@page CSS counter), /report sparkline
 * per-bar tooltip via SVG <title>, and RecentActivityCard uses the
 * locale-aware date-format helper.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('T19 — @page bottom-right page numbers', () => {
  const html = readFileSync(resolve(__dirname, '../../src/app.html'), 'utf8');

  it('declares an @page block with @bottom-right page numbering', () => {
    expect(html).toMatch(/@page\s*\{[\s\S]*?@bottom-right\s*\{/);
  });

  it('uses CSS counter(page) + counter(pages) for the marker', () => {
    expect(html).toMatch(/content:\s*counter\(page\)/);
    expect(html).toMatch(/counter\(pages\)/);
  });
});

describe('T19 — /report sparkline per-bar SVG <title> tooltip', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/routes/report/+page.svelte'),
    'utf8'
  );

  it('imports formatMonthShort from the date-format helper', () => {
    expect(src).toMatch(
      /import\s*\{\s*formatMonthShort\s*\}\s+from\s+['"]\$lib\/ui\/date-format['"]/
    );
  });

  it('emits an SVG <title> per sparkline bar', () => {
    expect(src).toMatch(/<title[^>]*>\{t\(['"]report\.page\.sparkline_bar_tooltip['"]/);
  });

  it('passes the month + value into the tooltip i18n template', () => {
    expect(src).toMatch(/month:\s*formatMonthShort\(m\)/);
    expect(src).toMatch(/value:\s*String\(v\)/);
  });

  it('wraps each bar in a <g> with the bar testid', () => {
    expect(src).toMatch(/data-testid=["']report-tile-spark-bar["']/);
  });

  it('the catalog carries sparkline_bar_tooltip with {month} + {value} placeholders', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(catalog.report.page.sparkline_bar_tooltip).toContain('{month}');
    expect(catalog.report.page.sparkline_bar_tooltip).toContain('{value}');
  });
});

describe('T19 — RecentActivityCard uses locale-aware formatDateTime', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/lib/home/RecentActivityCard.svelte'),
    'utf8'
  );

  it('imports formatDateTime from the date-format helper', () => {
    expect(src).toMatch(
      /import\s*\{\s*formatDateTime\s*\}\s+from\s+['"]\$lib\/ui\/date-format['"]/
    );
  });

  it('the formatTimestamp wrapper falls back to the raw ISO when the helper returns ""', () => {
    expect(src).toMatch(/formatDateTime\(iso\)\s*\|\|\s*iso/);
  });
});
