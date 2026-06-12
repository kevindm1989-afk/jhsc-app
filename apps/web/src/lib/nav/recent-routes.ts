/**
 * Recent-routes store — per-device localStorage history of the
 * routes the worker has visited most recently.
 *
 * Powers the HomeDashboard RecentRoutesCard so a worker landing on
 * `/` sees one-click links to the surfaces they've been working
 * with. Tracks `pathname` only (no querystring + no fragment) so
 * different filtered views of the same register collapse to a
 * single entry — that's the right granularity for "where was I
 * working" navigation.
 *
 * Framework-agnostic. No Svelte / SvelteKit imports.
 */

const STORAGE_KEY = 'jhsc-recent-routes';

/** Hard cap on stored entries. */
export const MAX_ENTRIES = 5;

/** Routes we deliberately exclude from the history. */
const IGNORED_ROUTES = new Set([
  '/',
  '/saved-views',
  '/help',
  '/more',
  '/search',
  '/onboarding',
  '/sign-in',
  '/settings',
  '/privacy'
]);

export interface RecentRoute {
  /** Route pathname, e.g. "/concerns". */
  route: string;
  /** ISO timestamp of the most recent visit. */
  visitedAt: string;
}

function normalize(raw: string): string {
  return raw.split('?')[0]!.split('#')[0]!.trim();
}

function readAll(): RecentRoute[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RecentRoute =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as RecentRoute).route === 'string' &&
        typeof (e as RecentRoute).visitedAt === 'string'
    );
  } catch {
    return [];
  }
}

function writeAll(entries: readonly RecentRoute[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // ignore
  }
}

/** Recent routes, newest first, capped at MAX_ENTRIES. */
export function listRecentRoutes(): RecentRoute[] {
  return readAll().slice(0, MAX_ENTRIES);
}

/**
 * Record a visit to `route`. Drops the entry from the ignored list
 * (Home, /saved-views, /help, etc.) so the card surfaces work
 * surfaces only. Dedupes (moves an existing entry to the front);
 * caps at MAX_ENTRIES.
 *
 * @param route raw pathname; querystrings + fragments are stripped
 */
export function recordRouteVisit(route: string): void {
  const r = normalize(route);
  if (!r || !r.startsWith('/')) return;
  if (IGNORED_ROUTES.has(r)) return;
  const existing = readAll();
  const without = existing.filter((e) => e.route !== r);
  const next: RecentRoute[] = [{ route: r, visitedAt: new Date().toISOString() }, ...without].slice(
    0,
    MAX_ENTRIES
  );
  writeAll(next);
}

/** Clear the whole history. */
export function clearRecentRoutes(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
