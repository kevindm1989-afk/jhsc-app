/**
 * i18n loader (T19 — extended to consume both the root + scoped catalogs).
 *
 * Loads the en-CA catalog from the repo-root i18n/en-CA.json (shipped
 * earlier) AND apps/web/src/lib/i18n/onboarding.en-CA.json (T19
 * scoped catalog, per Tech-writer flag #4 / ADR-0020 Decision 11). The
 * scoped catalog is overlaid on top of the root catalog; if both supply
 * the same dotted key, the scoped catalog wins (so the new T19 surfaces
 * read their canonical wording while pre-existing surfaces continue to
 * resolve their own keys against the root catalog).
 *
 * `fr-CA` is pre-staged but not selected by default (ADR-0009 + G-T19-1).
 */
import rootCatalog from '../../../../../i18n/en-CA.json' with { type: 'json' };
import scopedCatalog from './onboarding.en-CA.json' with { type: 'json' };

type Catalog = Record<string, unknown>;

/**
 * Deep-merge two JSON-shaped catalogs. Source wins on conflict at the
 * leaf level. Only plain objects are merged; arrays and primitives are
 * replaced wholesale. `_meta` and `_*` keys are preserved untouched.
 */
function deepMerge(base: Catalog, overlay: Catalog): Catalog {
  const out: Catalog = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    const existing = out[k];
    if (
      existing &&
      v &&
      typeof existing === 'object' &&
      typeof v === 'object' &&
      !Array.isArray(existing) &&
      !Array.isArray(v)
    ) {
      out[k] = deepMerge(existing as Catalog, v as Catalog);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const C: Catalog = deepMerge(rootCatalog as Catalog, scopedCatalog as Catalog);

function resolveDot(path: string, source: Catalog): string | undefined {
  const parts = path.split('.');
  let cur: unknown = source;
  for (const p of parts) {
    // Reject prototype-chain keys before the dynamic lookup. The catalog keys
    // are developer-controlled literals, so this never fires in practice; it
    // hardens the dynamic property access against prototype-pollution-shaped
    // input (defence-in-depth).
    if (p === '__proto__' || p === 'constructor' || p === 'prototype') return undefined;
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      // Read-only traversal of the app's own static catalog; `p` is guarded
      // against __proto__/constructor/prototype above, so this dynamic index
      // cannot pollute a prototype. The semgrep "auto" rule flags the bracket
      // access syntactically regardless of the guard — justified suppression.
      cur = (cur as Record<string, unknown>)[p]; // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop
    } else {
      return undefined;
    }
  }
  return typeof cur === 'string' ? cur : undefined;
}

/**
 * Resolve a dot-keyed catalog string.
 *
 * Returns the key itself (wrapped in `[[ ]]`) when the lookup misses;
 * the verify-i18n.sh gate detects unresolved keys at build time.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const found = resolveDot(key, C);
  if (found === undefined) return `[[${key}]]`;
  if (!vars) return found;
  return found.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`
  );
}

export function hasKey(key: string): boolean {
  return resolveDot(key, C) !== undefined;
}

/** Locale tag for the loaded catalog (a11y / SEO consumers). */
export const LOCALE = 'en-CA';
