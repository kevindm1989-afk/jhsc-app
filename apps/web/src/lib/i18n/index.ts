/**
 * i18n loader.
 *
 * Loads the en-CA catalog from /home/user/agent-os/i18n/en-CA.json and
 * exposes a key-resolver `t(key)`. The verify-i18n.sh gate enforces that
 * components do not contain raw English strings outside this loader.
 *
 * `fr-CA` is pre-staged but not selected by default (ADR-0009).
 */
import catalog from '../../../../../i18n/en-CA.json' with { type: 'json' };

type Catalog = Record<string, unknown>;
const C = catalog as Catalog;

function resolveDot(path: string, source: Catalog): string | undefined {
  const parts = path.split('.');
  let cur: unknown = source;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
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
