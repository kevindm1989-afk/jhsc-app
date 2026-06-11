/**
 * Tiny CSV serializer + download helper for register exports.
 *
 * RFC 4180-ish: comma separated, CRLF newlines, double-quote a cell
 * when it contains a comma / double-quote / newline; embedded quotes
 * doubled. No BOM (Excel handles UTF-8 without one in modern versions).
 *
 * The worker co-chair uses this to grab a register snapshot for
 * committee meetings, employer communications, or government reports.
 * It is filter-aware at the caller — each route page assembles the
 * rows it wants exported, then passes them in.
 *
 * Test surface:
 *   - `toCsv` is pure: rows + fields → CSV string. Trivially testable.
 *   - `csvFilename` builds a deterministic filename from a prefix + a
 *     supplied `Date` (default `new Date()`); test seeds the date.
 *   - `triggerCsvDownload` calls into browser APIs (Blob, URL,
 *     anchor) and is exercised via the button's click handler. Tests
 *     mock the browser surface.
 */

const CSV_NEEDS_QUOTING = /[,"\r\n]/;

/** Format a single cell value. `null`/`undefined` → empty cell. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (CSV_NEEDS_QUOTING.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Serialize an array of plain rows to CSV. The header row uses the
 * `fields` array as-is; cells pull `row[field]` for each row.
 */
export function toCsv<T extends Record<string, unknown>>(
  rows: readonly T[],
  fields: readonly (keyof T & string)[]
): string {
  const header = fields.map(csvCell).join(',');
  const lines = rows.map((row) => fields.map((f) => csvCell(row[f])).join(','));
  return [header, ...lines].join('\r\n');
}

export interface CsvMetadata {
  /** Route the rows came from, e.g. "/concerns". */
  route: string;
  /** Plain-English filter description, e.g. "Status: Open · Severity: High". */
  filters?: string;
  /** Time of export. Defaults to `new Date()`. */
  generatedAt?: Date;
}

/**
 * Build a single `#`-prefixed metadata line summarizing the export's
 * provenance. Excel + Sheets + Numbers all surface this row when
 * opening the file so the recipient can see where the data came
 * from. The `#` prefix keeps it out of the header detection logic
 * most spreadsheet apps run on the first row.
 *
 * Returns "" when `route` is empty, so the caller can safely
 * concatenate the result unconditionally.
 */
export function csvMetadataLine(meta: CsvMetadata): string {
  if (!meta.route) return '';
  const stamp = (meta.generatedAt ?? new Date()).toISOString();
  const parts = [`route=${meta.route}`, `generated=${stamp}`];
  if (meta.filters && meta.filters.trim().length > 0) {
    parts.push(`filters=${meta.filters.trim()}`);
  }
  // Single cell, quoted so commas in the filter description survive.
  const summary = '# ' + parts.join('; ');
  return csvCell(summary);
}

/**
 * Concatenate a metadata comment row + a row body. The metadata is
 * always followed by a CRLF so the spreadsheet apps treat the
 * second line as the header. An empty metadata is dropped.
 */
export function withMetadata(meta: CsvMetadata, csv: string): string {
  const line = csvMetadataLine(meta);
  if (!line) return csv;
  return line + '\r\n' + csv;
}

/**
 * Build a YYYY-MM-DD filename suffix from `date` (defaults to now).
 * Mirrors the ISO date prefix worker-side dates use elsewhere.
 *
 * When the caller passes a non-empty `axes` array, each axis is
 * slug-joined into the filename so distinct filtered exports don't
 * clobber each other on disk:
 *
 *   csvFilename('concerns', date) → "concerns-2026-06-11.csv"
 *   csvFilename('concerns', date, ['open', 'high'])
 *     → "concerns-open-high-2026-06-11.csv"
 *
 * Axes are sanitized to lowercase ASCII (a-z 0-9), collapsed
 * runs of separators, leading / trailing dashes trimmed, and
 * capped at 32 chars per axis. Empty axes are dropped.
 */
export function csvFilename(
  prefix: string,
  date: Date = new Date(),
  axes: readonly string[] = []
): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const slug = axes
    .map((a) =>
      String(a)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32)
    )
    .filter(Boolean)
    .join('-');
  const middle = slug ? `${slug}-` : '';
  return `${prefix}-${middle}${yyyy}-${mm}-${dd}.csv`;
}

/**
 * UTF-8 byte-order-mark. Prepended to the blob payload so Microsoft
 * Excel reads the file as UTF-8 by default (without the BOM, Excel
 * for Windows defaults to ANSI / Windows-1252 and garbles accented
 * characters even when the HTTP/Blob charset claims utf-8). Modern
 * Google Sheets / Numbers / LibreOffice all tolerate the BOM
 * transparently — pure win for the Excel-heavy committee audience.
 */
const UTF8_BOM = '﻿';

/**
 * Trigger a CSV download via a temporary anchor. Browser-only; the
 * function returns void.
 */
export function triggerCsvDownload(opts: { csv: string; filename: string }): void {
  const blob = new Blob([UTF8_BOM, opts.csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = opts.filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
