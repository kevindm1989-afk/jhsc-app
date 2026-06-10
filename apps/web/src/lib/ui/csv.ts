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

/**
 * Build a YYYY-MM-DD filename suffix from `date` (defaults to now).
 * Mirrors the ISO date prefix worker-side dates use elsewhere.
 */
export function csvFilename(prefix: string, date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${prefix}-${yyyy}-${mm}-${dd}.csv`;
}

/**
 * Trigger a CSV download via a temporary anchor. Browser-only; the
 * function returns void.
 */
export function triggerCsvDownload(opts: { csv: string; filename: string }): void {
  const blob = new Blob([opts.csv], { type: 'text/csv;charset=utf-8' });
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
