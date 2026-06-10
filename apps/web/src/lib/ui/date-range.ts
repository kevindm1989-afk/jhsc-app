/**
 * Date-range URL state helpers + canonical-range detection.
 *
 * Routes that show time-series data (audit, sensitive feed, etc.)
 * use `?from=YYYY-MM-DD&to=YYYY-MM-DD` URL state to filter rows by
 * timestamp. This module exposes:
 *
 *   - `quickRange(name, now)` — turn a quick-chip name ("today",
 *     "7days", "30days") into a `{ from, to }` window.
 *   - `detectQuickRange(from, to, now)` — given a URL pair, figure
 *     out whether it matches a canonical quick range (so the chip
 *     rail can highlight the active chip).
 *   - `withinRange(iso, from, to)` — predicate helper for filtering
 *     a row's ISO timestamp against the window.
 *
 * The window is interpreted inclusively on the date level: `from`
 * matches at 00:00:00 of that day; `to` matches at 23:59:59.999Z of
 * that day.
 */

export type QuickRangeName = 'today' | '7days' | '30days';

export interface DateRange {
  from: string;
  to: string;
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function quickRange(name: QuickRangeName, now: Date = new Date()): DateRange {
  const to = toISODate(now);
  const fromDate = new Date(now);
  if (name === 'today') {
    return { from: to, to };
  }
  if (name === '7days') {
    fromDate.setDate(fromDate.getDate() - 6);
    return { from: toISODate(fromDate), to };
  }
  // 30days
  fromDate.setDate(fromDate.getDate() - 29);
  return { from: toISODate(fromDate), to };
}

export function detectQuickRange(
  from: string | null,
  to: string | null,
  now: Date = new Date()
): QuickRangeName | null {
  if (!from || !to) return null;
  for (const name of ['today', '7days', '30days'] as QuickRangeName[]) {
    const q = quickRange(name, now);
    if (q.from === from && q.to === to) return name;
  }
  return null;
}

export function withinRange(iso: string, from: string | null, to: string | null): boolean {
  if (!from && !to) return true;
  // Treat from/to as inclusive day boundaries.
  if (from && iso < from) return false;
  if (to) {
    // Compare against end-of-day for `to`.
    const endOfTo = `${to}T23:59:59.999Z`;
    if (iso > endOfTo) return false;
  }
  return true;
}
