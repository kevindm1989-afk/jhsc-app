/**
 * PostgREST bytea hex wire helpers.
 *
 * PostgreSQL bytea columns serialise over PostgREST as `\x<hex>` strings.
 * Every Supabase{Topic}Client in this module shares the same encoding —
 * keeping the helpers in one place avoids drift between (e.g.) the
 * SupabaseT07Client and SupabaseConcernClient implementations.
 */

export function bytesToPgHex(b: Uint8Array): string {
  let s = '\\x';
  for (const byte of b) s += byte.toString(16).padStart(2, '0');
  return s;
}

export function pgHexToBytes(s: string): Uint8Array {
  const stripped = s.startsWith('\\x') ? s.slice(2) : s;
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
