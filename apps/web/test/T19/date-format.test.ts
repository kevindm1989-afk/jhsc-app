/**
 * T19 — date-format helpers (locale-aware Intl.DateTimeFormat wrappers).
 *
 * The catalog locale is en-CA. The helpers should accept Date / ISO
 * string / number, return "" on invalid input, and format month-only
 * strings via `formatMonthShort`.
 */

import { describe, expect, it } from 'vitest';
import {
  formatDateLong,
  formatDateShort,
  formatDateTime,
  formatMonthShort
} from '../../src/lib/ui/date-format';

describe('T19 — date-format helpers', () => {
  it('formatDateShort renders en-CA shape "Mmm d, YYYY"', () => {
    const out = formatDateShort('2026-06-11T09:42:00.000Z');
    // The output ordering / separators vary by locale; pin the parts
    // we control: month abbreviation, day, year all present.
    expect(out).toMatch(/Jun/);
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/11/);
  });

  it('formatDateLong renders the full month name', () => {
    const out = formatDateLong(new Date(2026, 5, 11));
    expect(out).toMatch(/June/);
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/11/);
  });

  it('formatDateTime renders date + hour/minute', () => {
    const out = formatDateTime('2026-06-11T09:42:00.000Z');
    expect(out).toMatch(/Jun/);
    expect(out).toMatch(/2026/);
    // Some locales render the time with a literal "a.m." / "p.m." or a
    // 24h "09:42"; pin only the numeric minutes appear.
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });

  it('accepts numeric (epoch ms) input', () => {
    const ms = Date.UTC(2026, 0, 1);
    expect(formatDateShort(ms)).toMatch(/2026/);
  });

  it('returns "" for null / undefined / NaN input (no try/catch needed at the call site)', () => {
    expect(formatDateShort(null)).toBe('');
    expect(formatDateShort(undefined)).toBe('');
    expect(formatDateShort('not-a-date')).toBe('');
    expect(formatDateShort(new Date('garbage'))).toBe('');
    expect(formatDateLong(null)).toBe('');
    expect(formatDateTime(null)).toBe('');
  });

  it('formatMonthShort renders "Mmm YYYY" for a YYYY-MM input', () => {
    const out = formatMonthShort('2026-06');
    expect(out).toMatch(/Jun/);
    expect(out).toMatch(/2026/);
  });

  it('formatMonthShort echoes the input verbatim when shape is wrong', () => {
    expect(formatMonthShort('not-a-month')).toBe('not-a-month');
    expect(formatMonthShort('2026/06')).toBe('2026/06');
    expect(formatMonthShort('')).toBe('');
  });
});
