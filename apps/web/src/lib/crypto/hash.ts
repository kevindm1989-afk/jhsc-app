/**
 * SHA-256 hex digest via WebCrypto.
 *
 * Lives under `src/lib/crypto/` — the only location the `no-non-libsodium-crypto`
 * gate permits `crypto.subtle.*` (ADR-0003 Invariant 4 carve-out for the crypto
 * module). `concern-core.ts` (and other plaintext-handling code that MUST run
 * browser-side per ADR-0003 Invariant 2) uses this instead of `node:crypto`,
 * which is Node-only and breaks the Vite/SvelteKit production build (G-T08-10).
 *
 * SHA-256 (not BLAKE2b) so the hex matches the server's
 * `encode(digest(ct,'sha256'),'hex')` in `concern_update` (F-16 prev_field_hashes)
 * and the prior `node:crypto.createHash('sha256')` output byte-for-byte.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const out = new Uint8Array(digest);
  let hex = '';
  for (const b of out) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * HMAC-SHA-256 via WebCrypto. Same carve-out as `sha256Hex` (lives under
 * `src/lib/crypto/`, so the `no-non-libsodium-crypto` gate's exception applies).
 * Used by the T13/T14 cores for the per-record passphrase UX-friction hash
 * (the production gate is pgcrypto-bf server-side per HG-6 / G-T13-6 /
 * G-T14-5/10; this in-browser HMAC is the in-memory mirror). Output is
 * byte-identical to the previous `node:crypto.createHmac('sha256', key)`.
 */
export async function hmacSha256(message: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const ck = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', ck, message);
  return new Uint8Array(sig);
}
