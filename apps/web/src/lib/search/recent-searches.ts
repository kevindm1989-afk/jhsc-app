/**
 * Recent-searches store — per-device localStorage history of the
 * last N queries a worker entered into the HeaderSearch input.
 *
 * The HeaderSearch dropdown surfaces these as quick-jump links so
 * the worker can re-run a recent query without retyping. Trimmed,
 * deduplicated, and capped at MAX_ENTRIES — every entry counts as a
 * worker-typed string with no committee data; the store stays
 * pseudonymous.
 *
 * Framework-agnostic — no Svelte / SvelteKit dependency — so tests
 * are trivial in node/jsdom.
 */

const STORAGE_KEY = 'jhsc-recent-searches';

/** Hard cap on stored entries. */
export const MAX_ENTRIES = 5;

/** Hard cap on per-query length (chars). */
const MAX_QUERY_LEN = 80;

function normalize(raw: string): string {
  return raw.trim().slice(0, MAX_QUERY_LEN);
}

function readAll(): string[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    // Corrupt / quota / private-mode — next write recovers.
    return [];
  }
}

function writeAll(entries: readonly string[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // ignore
  }
}

/** Recent queries, most-recent first, capped at MAX_ENTRIES. */
export function listRecentSearches(): string[] {
  return readAll().slice(0, MAX_ENTRIES);
}

/**
 * Record a query as the most-recent. Trims to MAX_QUERY_LEN, dedupes
 * (moves an existing entry to the front rather than duplicating),
 * and caps the persisted array at MAX_ENTRIES.
 *
 * Empty / whitespace-only queries are ignored.
 */
export function recordRecentSearch(raw: string): void {
  const q = normalize(raw);
  if (!q) return;
  const existing = readAll();
  const without = existing.filter((e) => e.toLowerCase() !== q.toLowerCase());
  const next = [q, ...without].slice(0, MAX_ENTRIES);
  writeAll(next);
}

/** Remove a single entry. Returns true when something was removed. */
export function deleteRecentSearch(query: string): boolean {
  const all = readAll();
  const next = all.filter((e) => e.toLowerCase() !== query.toLowerCase());
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

/** Clear the whole history. */
export function clearRecentSearches(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
