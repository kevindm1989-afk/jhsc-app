/**
 * Saved-views service — localStorage-backed registry of "named views"
 * a worker can bookmark across the register surfaces.
 *
 * A saved view captures the filtered URL state (route + querystring)
 * plus a worker-supplied label. Workers use this to bookmark
 * frequently-needed filtered views — e.g. "Open severity:high
 * concerns from the last 7 days" — without typing the URL each time.
 *
 * Persistence: scoped to a single device. localStorage is appropriate
 * here because:
 *   - The saved views are pseudonymous and contain no committee
 *     data (just URL fragments).
 *   - The expectation is per-device: a worker on a shared device
 *     opts in to leaving their named views behind.
 *   - The values survive panic-wipe by design (the wipe key in
 *     T07/T13 only clears auth + encrypted blobs, not UI prefs).
 *
 * The service is framework-agnostic — it has no Svelte / SvelteKit
 * dependency — so it's trivially testable in node/jsdom.
 */

const STORAGE_KEY = 'jhsc-saved-views';

export interface SavedView {
  /** Stable per-entry id (uuid-like). */
  id: string;
  /** Worker-supplied human label, e.g. "Open severity:high (7d)". */
  name: string;
  /** Route pathname, e.g. "/concerns". */
  route: string;
  /** Querystring including leading "?" (or "" when no params). */
  search: string;
  /** ISO timestamp the view was first saved. */
  createdAt: string;
  /**
   * Optional flag — when true, the HomeDashboard surfaces this view
   * as a quick-link tile on the front door. Persisted with the rest
   * of the view; legacy records without the field default to false.
   */
  pinnedToHome?: boolean;
}

function readAll(): SavedView[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedView);
  } catch {
    // Corrupt storage / quota / private-mode Safari — return empty
    // and the next write will overwrite the bad value.
    return [];
  }
}

function writeAll(views: readonly SavedView[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
  } catch {
    // Ignore — see readAll.
  }
}

function isSavedView(v: unknown): v is SavedView {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.route === 'string' &&
    typeof o.search === 'string' &&
    typeof o.createdAt === 'string'
  );
}

/** Generate a short opaque id that doesn't depend on `crypto.randomUUID`. */
function nextId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** Trim, normalize, and cap at 80 chars so long labels don't bloat storage. */
function normalizeName(name: string): string {
  return name.trim().slice(0, 80);
}

/** All saved views, newest-first. */
export function listSavedViews(): SavedView[] {
  return readAll()
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Saved views scoped to a single route, newest-first. */
export function listSavedViewsForRoute(route: string): SavedView[] {
  return listSavedViews().filter((v) => v.route === route);
}

/** Persist a new view. Returns the saved record. */
export function addSavedView(input: { name: string; route: string; search: string }): SavedView {
  const view: SavedView = {
    id: nextId(),
    name: normalizeName(input.name),
    route: input.route,
    search: input.search,
    createdAt: new Date().toISOString()
  };
  writeAll([...readAll(), view]);
  return view;
}

/** Rename a saved view. Returns the updated record, or null if not found. */
export function renameSavedView(id: string, name: string): SavedView | null {
  const all = readAll();
  const idx = all.findIndex((v) => v.id === id);
  if (idx < 0) return null;
  const next: SavedView = { ...all[idx]!, name: normalizeName(name) };
  const updated = all.slice();
  updated[idx] = next;
  writeAll(updated);
  return next;
}

/** Delete a saved view by id. Returns true when something was removed. */
export function deleteSavedView(id: string): boolean {
  const all = readAll();
  const next = all.filter((v) => v.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

/**
 * Toggle (or set) the pinned-to-home flag on a saved view. Returns
 * the updated record, or null if not found.
 */
export function setSavedViewPinned(id: string, pinned: boolean): SavedView | null {
  const all = readAll();
  const idx = all.findIndex((v) => v.id === id);
  if (idx < 0) return null;
  const next: SavedView = { ...all[idx]!, pinnedToHome: pinned };
  const updated = all.slice();
  updated[idx] = next;
  writeAll(updated);
  return next;
}

/** All saved views marked pinnedToHome, newest-first. */
export function listPinnedSavedViews(): SavedView[] {
  return listSavedViews().filter((v) => v.pinnedToHome === true);
}

/** Convenience: full href ("/route?…") for a saved view. */
export function hrefForSavedView(view: SavedView): string {
  return view.route + view.search;
}

export interface SavedViewsExport {
  /** Discriminator so importers can spot a malformed/foreign file. */
  kind: 'jhsc-saved-views';
  /** Wire format version; bump if the shape ever changes. */
  version: 1;
  /** ISO timestamp the file was produced. */
  exportedAt: string;
  views: SavedView[];
}

/** Serialize every saved view to a JSON-stable export envelope. */
export function exportSavedViews(): SavedViewsExport {
  return {
    kind: 'jhsc-saved-views',
    version: 1,
    exportedAt: new Date().toISOString(),
    views: listSavedViews()
  };
}

export interface ImportResult {
  /** Views actually merged into storage. */
  added: SavedView[];
  /** Views skipped because they collided with an existing id. */
  skipped: number;
}

/**
 * Merge a parsed export envelope into local storage. Existing views
 * with the same id win — import is additive and idempotent. A
 * malformed envelope throws so the caller can surface a friendly
 * error.
 */
export function importSavedViews(input: unknown): ImportResult {
  if (!input || typeof input !== 'object') {
    throw new Error('saved-views/import: not a JSON object');
  }
  const env = input as Record<string, unknown>;
  if (env.kind !== 'jhsc-saved-views') {
    throw new Error('saved-views/import: not a saved-views export file');
  }
  if (env.version !== 1) {
    throw new Error('saved-views/import: unsupported version');
  }
  if (!Array.isArray(env.views)) {
    throw new Error('saved-views/import: missing views array');
  }
  const incoming = env.views.filter(isSavedView);
  const existing = readAll();
  const existingIds = new Set(existing.map((v) => v.id));
  const added: SavedView[] = [];
  for (const v of incoming) {
    if (existingIds.has(v.id)) continue;
    added.push({ ...v, name: normalizeName(v.name) });
  }
  if (added.length > 0) writeAll([...existing, ...added]);
  return { added, skipped: incoming.length - added.length };
}
