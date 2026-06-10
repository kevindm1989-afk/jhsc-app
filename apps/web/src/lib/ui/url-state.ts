/**
 * URL composition helper for register surfaces.
 *
 * The viewers + chip rails need to build hrefs that preserve the
 * other URL params already on the route (filter, sort, severity,
 * hazard, page, q, …). Hand-rolling the composition per route is
 * brittle; this helper centralises it.
 *
 * `buildHref(base, params, override)` returns `base + "?" + qs`
 * where `qs` carries every truthy entry from `params` with the
 * override applied on top. A `null` override value removes that
 * key from the result (lets a chip clear its own dimension while
 * preserving every other dimension).
 */

export function buildHref(
  base: string,
  params: Readonly<Record<string, string | null | undefined>> = {},
  override: Readonly<Record<string, string | null | undefined>> = {}
): string {
  const merged = { ...params, ...override };
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v === null || v === undefined || v === '') continue;
    search.set(k, v);
  }
  const qs = search.toString();
  return qs ? `${base}?${qs}` : base;
}
