/**
 * Locale-aware date formatting helpers.
 *
 * The committee app uses en-CA throughout (ADR-0009 + LOCALE export
 * in $lib/i18n). Worker-side timestamps land as ISO strings; the
 * register viewers and recent-activity cards prefer a short, readable
 * shape that still parses unambiguously.
 *
 * We layer over `Intl.DateTimeFormat` with the catalog's `LOCALE`
 * tag so the same date renders as "Jun 11, 2026" for en-CA but
 * automatically swaps to "11 juin 2026" once fr-CA is selected (T19
 * pre-staged that switch).
 *
 * All helpers are pure: invalid input returns the empty string so
 * callers can render a placeholder without try/catch.
 */

import { LOCALE } from '../i18n';

/**
 * Parse a date-ish input (Date, ISO string, or number) into a Date
 * and return null when it can't be parsed.
 */
function parse(input: Date | string | number | null | undefined): Date | null {
  if (input == null) return null;
  if (input instanceof Date) return Number.isFinite(input.getTime()) ? input : null;
  const d = new Date(input);
  return Number.isFinite(d.getTime()) ? d : null;
}

const dateShortFmt = new Intl.DateTimeFormat(LOCALE, {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
});

const dateLongFmt = new Intl.DateTimeFormat(LOCALE, {
  year: 'numeric',
  month: 'long',
  day: 'numeric'
});

const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
});

/** "Jun 11, 2026" (en-CA). Empty string on invalid input. */
export function formatDateShort(input: Date | string | number | null | undefined): string {
  const d = parse(input);
  return d ? dateShortFmt.format(d) : '';
}

/** "June 11, 2026" (en-CA). Empty string on invalid input. */
export function formatDateLong(input: Date | string | number | null | undefined): string {
  const d = parse(input);
  return d ? dateLongFmt.format(d) : '';
}

/** "Jun 11, 2026, 09:42" (en-CA). Empty string on invalid input. */
export function formatDateTime(input: Date | string | number | null | undefined): string {
  const d = parse(input);
  return d ? dateTimeFmt.format(d) : '';
}

/**
 * Format a YYYY-MM month string as "MMM YYYY" (e.g. "Jun 2026").
 * Used by the /report sparkline tooltips. Returns the input verbatim
 * if it doesn't match the canonical month shape so callers can
 * render the raw string as a fallback.
 */
const monthShortFmt = new Intl.DateTimeFormat(LOCALE, {
  year: 'numeric',
  month: 'short'
});

export function formatMonthShort(month: string): string {
  if (!/^\d{4}-\d{2}$/.test(month)) return month;
  const [y, m] = month.split('-').map((n) => parseInt(n, 10));
  const d = new Date(y!, m! - 1, 1);
  return Number.isFinite(d.getTime()) ? monthShortFmt.format(d) : month;
}
