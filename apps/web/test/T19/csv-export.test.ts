/**
 * T19.1 — CSV export utility + button + route wiring.
 *
 *   - `toCsv` serializes rows + a field list to a CSV string with
 *     RFC-4180-ish quoting (commas, quotes, newlines).
 *   - `csvFilename` builds a deterministic filename from a prefix
 *     and an optional date.
 *   - `triggerCsvDownload` calls the browser-side Blob + anchor
 *     plumbing; we exercise it through the button.
 *   - `CsvDownloadButton` calls its `onClick` callback and invokes
 *     the download trigger.
 *   - Each register route imports the button and wires it next to
 *     the chip rail; a per-route `CSV_FIELDS` const + `buildDownload`
 *     function are present.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toCsv, csvFilename, triggerCsvDownload } from '../../src/lib/ui/csv';
import CsvDownloadButton from '../../src/lib/ui/CsvDownloadButton.svelte';

afterEach(() => {
  cleanup();
});

describe('T19.1 — toCsv', () => {
  it('serializes a small dataset with the supplied field order', () => {
    const rows = [
      { id: 'a', n: 1, name: 'Alpha' },
      { id: 'b', n: 2, name: 'Bravo' }
    ];
    const csv = toCsv(rows, ['id', 'n', 'name']);
    expect(csv).toBe('id,n,name\r\na,1,Alpha\r\nb,2,Bravo');
  });

  it('quotes cells containing commas', () => {
    const rows = [{ id: 'a', s: 'first, second' }];
    const csv = toCsv(rows, ['id', 's']);
    expect(csv).toContain('"first, second"');
  });

  it('escapes embedded double-quotes by doubling them', () => {
    const rows = [{ id: 'a', s: 'he said "hi"' }];
    const csv = toCsv(rows, ['id', 's']);
    expect(csv).toContain('"he said ""hi"""');
  });

  it('quotes cells containing newlines', () => {
    const rows = [{ id: 'a', s: 'line1\nline2' }];
    const csv = toCsv(rows, ['id', 's']);
    expect(csv).toMatch(/"line1\nline2"/);
  });

  it('renders null and undefined as empty cells', () => {
    const rows = [{ a: null, b: undefined, c: 'x' }] as Record<string, unknown>[];
    const csv = toCsv(rows, ['a', 'b', 'c']);
    expect(csv).toBe('a,b,c\r\n,,x');
  });

  it('renders an empty dataset as just the header', () => {
    expect(toCsv([], ['a', 'b'])).toBe('a,b');
  });
});

describe('T19.1 — csvFilename', () => {
  it('formats date components with leading zeros', () => {
    // Pin a known date: Feb 3, 2026.
    const d = new Date(2026, 1, 3);
    expect(csvFilename('concerns', d)).toBe('concerns-2026-02-03.csv');
  });

  it('uses the prefix verbatim', () => {
    expect(csvFilename('s51-evidence', new Date(2026, 5, 9))).toBe('s51-evidence-2026-06-09.csv');
  });
});

describe('T19.1 — triggerCsvDownload', () => {
  it('creates an object URL, clicks a temp anchor, then revokes', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock-url');
    const revokeObjectURL = vi.fn();
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    // jsdom doesn't implement these; install mocks.
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectURL
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeObjectURL
    });

    const clicked: string[] = [];
    const origCreateEl = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = origCreateEl(tag);
      if (tag === 'a') {
        const a = el as HTMLAnchorElement;
        // Record but do NOT propagate to jsdom — its anchor-click
        // tries to navigate and dirties the test output.
        a.click = () => {
          clicked.push(a.download);
        };
      }
      return el;
    });

    try {
      triggerCsvDownload({ csv: 'a,b\r\n1,2', filename: 'concerns-2026-06-10.csv' });
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(clicked).toEqual(['concerns-2026-06-10.csv']);
      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    } finally {
      createElementSpy.mockRestore();
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: realCreate
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: realRevoke
      });
    }
  });
});

describe('T19.1 — CsvDownloadButton', () => {
  it('renders with the default button label', () => {
    render(CsvDownloadButton, { props: { onClick: vi.fn() } });
    const btn = screen.getByTestId('csv-download-btn');
    expect(btn.textContent ?? '').toMatch(/Download CSV/i);
    expect(btn.getAttribute('data-print')).toBe('hide');
  });

  it('calls onClick when clicked', async () => {
    const onClick = vi.fn(() => ({ csv: 'a,b\r\n1,2', filename: 'test.csv' }));
    // Stub URL.createObjectURL so triggerCsvDownload doesn't blow up,
    // and intercept anchor.click so jsdom doesn't try to navigate.
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: () => 'blob:mock'
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: () => {}
    });
    const origCreateEl = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = origCreateEl(tag);
      if (tag === 'a') {
        (el as HTMLAnchorElement).click = () => {};
      }
      return el;
    });
    try {
      render(CsvDownloadButton, { props: { onClick } });
      fireEvent.click(screen.getByTestId('csv-download-btn'));
      await waitFor(() => {
        expect(onClick).toHaveBeenCalledTimes(1);
      });
    } finally {
      createElementSpy.mockRestore();
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: realCreate
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: realRevoke
      });
    }
  });
});

describe('T19.1 — every register route wires the CSV download button', () => {
  // 'concerns' RETIRED from this list by ADR-0027 Phase 2a PR2: the live
  // /concerns surface no longer carries CSV export (Decision 8 — pagination/
  // filtering deferred; CSV-over-decrypted-rows is a future ADR). The
  // post-cutover /concerns contract is pinned by
  // apps/web/test/T08/phase2a-concerns-page-cutover.test.ts.
  const ROUTES = [
    'recommendations',
    'training',
    'work-refusal',
    's51-evidence',
    // 'reprisal' RETIRED — ADR-0028 Phase 2b PR1: live /reprisal cut over to
    // the E2EE feed; it no longer ships the demo CSV export pipeline.
    'minutes',
    'inspections',
    'library',
    'audit',
    'sensitive-feed'
  ] as const;

  for (const route of ROUTES) {
    it(`/${route}/+page.svelte mounts CsvDownloadButton + declares CSV_FIELDS + buildDownload`, () => {
      const src = readFileSync(
        resolve(__dirname, `../../src/routes/${route}/+page.svelte`),
        'utf8'
      );
      expect(src).toMatch(
        /import\s+CsvDownloadButton\s+from\s+['"]\$lib\/ui\/CsvDownloadButton\.svelte['"]/
      );
      // Helpers can appear in any order in the import braces.
      expect(src).toMatch(/import\s*\{[\s\S]*\btoCsv\b[\s\S]*\}\s+from\s+['"]\$lib\/ui\/csv['"]/);
      expect(src).toMatch(/import\s*\{[\s\S]*\bcsvFilename\b[\s\S]*\}\s+from\s+['"]\$lib\/ui\/csv['"]/);
      expect(src).toMatch(/CSV_FIELDS\s*=/);
      expect(src).toMatch(/function\s+buildDownload\s*\(/);
      expect(src).toMatch(/<CsvDownloadButton\s+onClick=\{buildDownload\}\s*\/>/);
    });
  }
});

describe('T19.1 — common.csvDownload.* i18n keys', () => {
  it('catalog has button + busy + helper', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../i18n/en-CA.json'), 'utf8')
    );
    expect(typeof catalog.common.csvDownload.button).toBe('string');
    expect(typeof catalog.common.csvDownload.busy).toBe('string');
    expect(typeof catalog.common.csvDownload.helper).toBe('string');
  });
});
